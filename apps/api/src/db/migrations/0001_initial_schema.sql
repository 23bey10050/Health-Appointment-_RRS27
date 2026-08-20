-- Initial schema for the clinic platform.
--
-- The idea running through this whole file: rules that must never be broken live in the database,
-- not in application code. Application code can be bypassed by a second server, a background job,
-- or a bug. A constraint cannot.

CREATE EXTENSION IF NOT EXISTS citext;
-- btree_gist is what lets a GiST exclusion constraint mix a plain equality check (same doctor)
-- with an overlap check (same time). Without it the appointments constraint below cannot be built.
CREATE EXTENSION IF NOT EXISTS btree_gist;


-- Postgres ships range types for timestamps and numbers but not for a plain clock time, and the
-- weekly working-hours table needs one to stop a doctor being given two overlapping shifts.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'timerange') THEN
        CREATE TYPE timerange AS RANGE (subtype = time);
    END IF;
END $$;


CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================================
-- People and sessions
-- ============================================================================

CREATE TYPE user_role AS ENUM ('patient', 'doctor', 'admin');

CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- citext means "Ravi@clinic.com" and "ravi@clinic.com" are the same account. Storing plain
    -- text here would let someone register a second account that only differs by capital letters.
    email         CITEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          user_role NOT NULL,
    full_name     TEXT NOT NULL CHECK (length(btrim(full_name)) > 0),
    phone         TEXT,
    -- An IANA zone name such as Asia/Kolkata. Medicine reminders are worked out in the patient's
    -- own zone, so this is clinical data, not a display preference.
    timezone      TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- One row per issued refresh token.
--
-- Tokens are grouped into a "family": every rotation records the new token against the same
-- family_id. If a token that was already used comes back, we know it was stolen, and revoking the
-- whole family logs out the thief and the real user together. Only hashes are stored, so a copy of
-- this table is not a set of working credentials.
CREATE TABLE refresh_tokens (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    family_id     UUID NOT NULL,
    token_hash    TEXT NOT NULL UNIQUE,
    expires_at    TIMESTAMPTZ NOT NULL,
    used_at       TIMESTAMPTZ,
    revoked_at    TIMESTAMPTZ,
    revoke_reason TEXT,
    user_agent    TEXT,
    ip_address    INET,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_refresh_tokens_family ON refresh_tokens (family_id);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens (user_id);
-- Supports the nightly sweep that deletes tokens nobody can use any more.
CREATE INDEX idx_refresh_tokens_expiry ON refresh_tokens (expires_at) WHERE revoked_at IS NULL;


-- ============================================================================
-- Doctors
-- ============================================================================

CREATE TABLE doctor_profiles (
    user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    specialization     TEXT NOT NULL CHECK (length(btrim(specialization)) > 0),
    bio                TEXT,
    -- How long one consultation runs. The availability grid is built from this, so changing it
    -- changes tomorrow's slots but never moves an appointment that is already booked.
    slot_duration_mins INT NOT NULL DEFAULT 20 CHECK (slot_duration_mins BETWEEN 5 AND 240),
    consultation_fee   NUMERIC(10, 2) CHECK (consultation_fee IS NULL OR consultation_fee >= 0),
    created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER doctor_profiles_set_updated_at
    BEFORE UPDATE ON doctor_profiles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Patients search by specialty, so this is the index behind the doctor list.
CREATE INDEX idx_doctor_specialization ON doctor_profiles (lower(specialization));


-- A doctor's normal week. Sunday is 0, matching JavaScript's getDay().
CREATE TABLE doctor_working_hours (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doctor_id   UUID NOT NULL REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    start_time  TIME NOT NULL,
    end_time    TIME NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_time > start_time),

    -- Two shifts on the same day for the same doctor may not overlap. Catching this here means the
    -- slot builder can trust its input and never produce a duplicated slot.
    EXCLUDE USING gist (
        doctor_id WITH =,
        day_of_week WITH =,
        timerange(start_time, end_time, '[)') WITH &&
    )
);

CREATE INDEX idx_working_hours_doctor ON doctor_working_hours (doctor_id, day_of_week);


CREATE TABLE doctor_leaves (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doctor_id  UUID NOT NULL REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    leave_date DATE NOT NULL,
    reason     TEXT,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (doctor_id, leave_date)
);

CREATE INDEX idx_leaves_date ON doctor_leaves (leave_date);


-- ============================================================================
-- Appointments
-- ============================================================================

CREATE TYPE appointment_status AS ENUM ('confirmed', 'completed', 'cancelled', 'no_show');
CREATE TYPE urgency_level AS ENUM ('low', 'medium', 'high');
CREATE TYPE summary_status AS ENUM ('not_requested', 'pending', 'ready', 'unavailable');

CREATE TABLE appointments (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    doctor_id  UUID NOT NULL REFERENCES doctor_profiles(user_id) ON DELETE RESTRICT,
    -- Stored as a range rather than a start plus a length, because a range is what the overlap
    -- operator below understands. '[start, end)' means the end instant belongs to the next slot,
    -- so a 10:00-10:20 and a 10:20-10:40 appointment sit next to each other without colliding.
    slot       TSTZRANGE NOT NULL,
    status     appointment_status NOT NULL DEFAULT 'confirmed',

    symptoms_text          TEXT,
    symptoms_submitted_at  TIMESTAMPTZ,

    ai_urgency             urgency_level,
    ai_chief_complaint     TEXT,
    ai_suggested_questions JSONB,
    ai_previsit_status     summary_status NOT NULL DEFAULT 'not_requested',
    ai_previsit_provider   TEXT,

    doctor_notes           TEXT,
    prescription           JSONB,
    notes_submitted_at     TIMESTAMPTZ,

    ai_postvisit_summary   TEXT,
    ai_postvisit_steps     JSONB,
    ai_postvisit_status    summary_status NOT NULL DEFAULT 'not_requested',
    ai_postvisit_provider  TEXT,

    google_event_id_patient TEXT,
    google_event_id_doctor  TEXT,

    cancelled_at            TIMESTAMPTZ,
    cancelled_by            UUID REFERENCES users(id) ON DELETE SET NULL,
    cancellation_reason     TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (NOT isempty(slot)),
    CHECK (lower(slot) IS NOT NULL AND upper(slot) IS NOT NULL),

    -- ================================================================
    -- THE DOUBLE-BOOKING GUARANTEE
    -- ================================================================
    -- One doctor cannot have two live appointments whose times overlap. Postgres checks this while
    -- inserting, inside the same lock that protects the index, so two requests arriving in the same
    -- millisecond cannot both win: one commits and the other is rejected with SQLSTATE 23P01.
    --
    -- This is stronger than checking availability in application code first, because that check and
    -- the insert that follows are two separate steps and another request fits between them.
    -- Cancelled appointments are excluded, which is what frees a slot the moment one is cancelled.
    EXCLUDE USING gist (
        doctor_id WITH =,
        slot WITH &&
    ) WHERE (status <> 'cancelled')
);

CREATE TRIGGER appointments_set_updated_at
    BEFORE UPDATE ON appointments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Drives the availability grid: "which slots does this doctor already have taken in this window".
CREATE INDEX idx_appointments_doctor_slot ON appointments USING gist (doctor_id, slot);
-- Drives the patient's own list, newest first.
CREATE INDEX idx_appointments_patient ON appointments (patient_id, created_at DESC);
-- Drives the doctor's day view and the reminder sweep.
CREATE INDEX idx_appointments_upcoming ON appointments (lower(slot)) WHERE status = 'confirmed';


-- ============================================================================
-- Slot holds
-- ============================================================================

-- A short reservation held while the patient fills in the symptom form.
--
-- Note there is no "WHERE expires_at > now()" on the constraint below, tempting as that reads.
-- Postgres will not accept it: a partial index predicate has to give the same answer forever, and
-- now() changes by definition. Expired holds are therefore removed rather than ignored - the hold
-- endpoint clears stale rows for that doctor inside the same transaction, and a sweep job clears
-- the rest. Deleting is cheap; a wrong constraint is not.
CREATE TABLE slot_holds (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doctor_id  UUID NOT NULL REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
    patient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slot       TSTZRANGE NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (NOT isempty(slot)),
    EXCLUDE USING gist (doctor_id WITH =, slot WITH &&)
);

CREATE INDEX idx_slot_holds_expiry ON slot_holds (expires_at);
CREATE INDEX idx_slot_holds_doctor_slot ON slot_holds USING gist (doctor_id, slot);


-- ============================================================================
-- Notification outbox
-- ============================================================================

CREATE TYPE notification_channel AS ENUM ('email', 'calendar');
CREATE TYPE notification_type AS ENUM (
    'booking_confirmation',
    'reminder_24h',
    'reminder_1h',
    'cancellation',
    'reschedule',
    'leave_conflict',
    'medication_reminder',
    'postvisit_summary'
);
CREATE TYPE notification_status AS ENUM ('queued', 'sent', 'failed', 'dead_letter');

-- Every message we owe the outside world is a row here, written in the same transaction as the
-- thing that caused it. A booking and its confirmation email either both exist or neither does, so
-- a crash one instant after the booking commits still sends the email later.
CREATE TABLE notification_outbox (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    appointment_id  UUID REFERENCES appointments(id) ON DELETE CASCADE,
    recipient_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel         notification_channel NOT NULL,
    type            notification_type NOT NULL,
    payload         JSONB NOT NULL,
    status          notification_status NOT NULL DEFAULT 'queued',
    attempts        SMALLINT NOT NULL DEFAULT 0,
    max_attempts    SMALLINT NOT NULL DEFAULT 5,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error      TEXT,
    -- Stops the same message being queued twice. The 24-hour reminder sweep can run every five
    -- minutes and insert with ON CONFLICT DO NOTHING, so a restart mid-sweep costs nothing.
    dedupe_key      TEXT UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at         TIMESTAMPTZ
);

-- The worker's only query: what is due right now. Keeping it a partial index means the index stays
-- small even after a hundred thousand delivered messages sit in the table.
CREATE INDEX idx_outbox_due ON notification_outbox (next_attempt_at, created_at)
    WHERE status IN ('queued', 'failed');
CREATE INDEX idx_outbox_dead_letter ON notification_outbox (created_at DESC)
    WHERE status = 'dead_letter';
CREATE INDEX idx_outbox_appointment ON notification_outbox (appointment_id);


-- ============================================================================
-- Medication reminders
-- ============================================================================

CREATE TABLE medication_reminders (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    patient_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    drug_name      TEXT NOT NULL,
    dosage         TEXT,
    instructions   TEXT,
    -- Already converted to an absolute instant. The conversion happens once, when the prescription
    -- is written, using the patient's own timezone, so a daylight-saving change later cannot shift
    -- a reminder to three in the morning.
    scheduled_at   TIMESTAMPTZ NOT NULL,
    queued_at      TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Re-running the prescription parser must not create a second set of reminders.
    UNIQUE (appointment_id, drug_name, scheduled_at)
);

CREATE INDEX idx_medication_reminders_due ON medication_reminders (scheduled_at)
    WHERE queued_at IS NULL;
CREATE INDEX idx_medication_reminders_patient ON medication_reminders (patient_id, scheduled_at);


-- ============================================================================
-- Google Calendar tokens
-- ============================================================================

-- Both values arrive encrypted from the application layer. Storing a refresh token in plain text
-- would mean anyone with a copy of a backup could read a user's calendar indefinitely.
CREATE TABLE google_oauth_tokens (
    user_id                 UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    access_token_encrypted  TEXT NOT NULL,
    refresh_token_encrypted TEXT NOT NULL,
    expires_at              TIMESTAMPTZ NOT NULL,
    scope                   TEXT,
    connected_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER google_oauth_tokens_set_updated_at
    BEFORE UPDATE ON google_oauth_tokens
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ============================================================================
-- Audit log
-- ============================================================================

-- Append only. Answers "who changed this appointment, and when" months later, and it is where
-- every AI call records which provider answered and how long it took.
CREATE TABLE audit_log (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    action      TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id   UUID,
    metadata    JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX idx_audit_actor ON audit_log (actor_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_log (action, created_at DESC);
