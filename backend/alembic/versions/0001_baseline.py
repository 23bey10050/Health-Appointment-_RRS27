"""baseline schema -- IMPLEMENTATION.md section 6, verbatim except one addition noted below

Revision ID: 0001
Revises:
Create Date: 2026-08-23

"""

from typing import Sequence, Union

from alembic import op

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # -------------------------------------------------------------------
    # Extensions
    # -------------------------------------------------------------------
    op.execute('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";')
    op.execute("CREATE EXTENSION IF NOT EXISTS vector;")
    op.execute("CREATE EXTENSION IF NOT EXISTS btree_gist;")  # required for the exclusion constraint
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm;")
    # Not listed in IMPLEMENTATION.md's extension block, but users.email is typed CITEXT
    # there (section 6.1) -- that type does not exist without this extension. Added to make
    # the spec's own DDL executable; nothing else about the citext column is changed.
    op.execute("CREATE EXTENSION IF NOT EXISTS citext;")

    # -------------------------------------------------------------------
    # Enum types
    # -------------------------------------------------------------------
    op.execute("CREATE TYPE user_role AS ENUM ('patient','doctor','admin');")
    op.execute(
        "CREATE TYPE appointment_status AS ENUM "
        "('held','confirmed','cancelled','completed','no_show','rescheduled');"
    )
    op.execute("CREATE TYPE appointment_kind AS ENUM ('routine','follow_up','emergency');")
    op.execute("CREATE TYPE urgency_level AS ENUM ('low','medium','high','critical');")
    op.execute("CREATE TYPE summary_kind AS ENUM ('pre_visit','post_visit','emergency_brief');")
    op.execute(
        "CREATE TYPE summary_state AS ENUM ('draft','approved','edited','rejected','failed');"
    )
    op.execute(
        "CREATE TYPE kb_namespace AS ENUM ('clinic_kb','triage_kb','clinical_kb','patient_ctx');"
    )
    op.execute("CREATE TYPE kb_audience AS ENUM ('patient','doctor','both');")
    op.execute("CREATE TYPE outbox_status AS ENUM ('pending','sending','sent','failed','dead');")

    # -------------------------------------------------------------------
    # 6.1 Identity and profiles
    # -------------------------------------------------------------------
    op.execute(
        """
        CREATE TABLE users (
          id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          email           CITEXT UNIQUE NOT NULL,
          phone           TEXT,
          password_hash   TEXT NOT NULL,
          role            user_role NOT NULL,
          full_name       TEXT NOT NULL,
          is_active       BOOLEAN NOT NULL DEFAULT TRUE,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        """
    )

    op.execute(
        """
        CREATE TABLE patient_profiles (
          user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          date_of_birth      DATE,
          sex                TEXT,
          blood_group        TEXT,
          allergies          JSONB NOT NULL DEFAULT '[]',
          chronic_conditions JSONB NOT NULL DEFAULT '[]',
          current_medications JSONB NOT NULL DEFAULT '[]',
          emergency_contact  JSONB,
          preferred_language TEXT NOT NULL DEFAULT 'en'
        );
        """
    )

    op.execute(
        """
        CREATE TABLE hospitals (
          id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          name      TEXT NOT NULL,
          address   TEXT,
          city      TEXT,
          phone     TEXT,
          has_emergency_dept BOOLEAN NOT NULL DEFAULT FALSE
        );
        """
    )

    op.execute(
        """
        CREATE TABLE doctor_profiles (
          user_id            UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          hospital_id        UUID REFERENCES hospitals(id),
          specialisation     TEXT NOT NULL,
          sub_specialisations TEXT[] NOT NULL DEFAULT '{}',
          qualifications     TEXT,
          registration_no    TEXT,
          years_experience   INT,
          bio                TEXT,
          consultation_fee   NUMERIC(10,2),
          slot_duration_min  INT NOT NULL DEFAULT 20,
          buffer_min         INT NOT NULL DEFAULT 0,
          max_daily_appointments INT,
          accepts_emergency  BOOLEAN NOT NULL DEFAULT FALSE,
          is_accepting       BOOLEAN NOT NULL DEFAULT TRUE
        );
        """
    )
    op.execute("CREATE INDEX ON doctor_profiles USING gin (specialisation gin_trgm_ops);")

    op.execute(
        """
        CREATE TABLE doctor_working_hours (
          id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          doctor_id   UUID NOT NULL REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
          weekday     SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
          start_time  TIME NOT NULL,
          end_time    TIME NOT NULL,
          valid_from  DATE NOT NULL DEFAULT CURRENT_DATE,
          valid_until DATE,
          CHECK (end_time > start_time)
        );
        """
    )

    op.execute(
        """
        CREATE TABLE doctor_leave (
          id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          doctor_id   UUID NOT NULL REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
          start_date  DATE NOT NULL,
          end_date    DATE NOT NULL,
          reason      TEXT,
          created_by  UUID REFERENCES users(id),
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          affected_appointments_handled BOOLEAN NOT NULL DEFAULT FALSE,
          CHECK (end_date >= start_date)
        );
        """
    )

    # -------------------------------------------------------------------
    # 6.2 Appointments -- the concurrency-critical table
    # -------------------------------------------------------------------
    op.execute(
        """
        CREATE TABLE appointments (
          id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          doctor_id      UUID NOT NULL REFERENCES doctor_profiles(user_id),
          patient_id     UUID NOT NULL REFERENCES users(id),
          hospital_id    UUID REFERENCES hospitals(id),
          start_at       TIMESTAMPTZ NOT NULL,
          end_at         TIMESTAMPTZ NOT NULL,
          status         appointment_status NOT NULL DEFAULT 'held',
          kind           appointment_kind NOT NULL DEFAULT 'routine',
          urgency        urgency_level,
          booking_channel TEXT NOT NULL DEFAULT 'web',
          voice_session_id UUID,
          reason_text    TEXT,
          hold_expires_at TIMESTAMPTZ,
          cancelled_at   TIMESTAMPTZ,
          cancelled_by   UUID REFERENCES users(id),
          cancellation_reason TEXT,
          rescheduled_from UUID REFERENCES appointments(id),
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          CHECK (end_at > start_at)
        );
        """
    )

    op.execute(
        """
        ALTER TABLE appointments
          ADD CONSTRAINT appointments_no_overlap
          EXCLUDE USING gist (
            doctor_id WITH =,
            tstzrange(start_at, end_at, '[)') WITH &&
          ) WHERE (status IN ('held','confirmed'));
        """
    )

    op.execute(
        "CREATE INDEX ON appointments (doctor_id, start_at) WHERE status IN ('held','confirmed');"
    )
    op.execute("CREATE INDEX ON appointments (patient_id, start_at DESC);")
    op.execute("CREATE INDEX ON appointments (hold_expires_at) WHERE status = 'held';")

    # -------------------------------------------------------------------
    # 6.3 Clinical records
    # -------------------------------------------------------------------
    op.execute(
        """
        CREATE TABLE encounters (
          id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          appointment_id  UUID UNIQUE NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
          clinical_notes  TEXT,
          diagnosis       TEXT,
          vitals          JSONB,
          follow_up_after_days INT,
          submitted_at    TIMESTAMPTZ,
          submitted_by    UUID REFERENCES users(id)
        );
        """
    )

    op.execute(
        """
        CREATE TABLE prescriptions (
          id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          encounter_id  UUID NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
          drug_name     TEXT NOT NULL,
          strength      TEXT,
          form          TEXT,
          frequency_code TEXT NOT NULL,
          times_of_day  TIME[] NOT NULL,
          relation_to_food TEXT,
          duration_days INT NOT NULL,
          start_date    DATE NOT NULL,
          instructions  TEXT,
          is_active     BOOLEAN NOT NULL DEFAULT TRUE
        );
        """
    )

    op.execute(
        """
        CREATE TABLE ai_summaries (
          id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          kind           summary_kind NOT NULL,
          appointment_id UUID REFERENCES appointments(id) ON DELETE CASCADE,
          encounter_id   UUID REFERENCES encounters(id) ON DELETE CASCADE,
          state          summary_state NOT NULL DEFAULT 'draft',
          content        JSONB NOT NULL,
          content_edited JSONB,
          model_provider TEXT, model_name TEXT, prompt_version TEXT,
          retrieved_chunk_ids UUID[],
          input_token_count INT, output_token_count INT, latency_ms INT,
          generation_error TEXT,
          reviewed_by    UUID REFERENCES users(id),
          reviewed_at    TIMESTAMPTZ,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        """
    )

    # -------------------------------------------------------------------
    # 6.4 Voice sessions
    # -------------------------------------------------------------------
    op.execute(
        """
        CREATE TABLE voice_sessions (
          id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          patient_id      UUID REFERENCES users(id),
          consent_given_at TIMESTAMPTZ NOT NULL,
          consent_version TEXT NOT NULL,
          started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          ended_at        TIMESTAMPTZ,
          outcome         TEXT,
          appointment_id  UUID REFERENCES appointments(id),
          collected_data  JSONB NOT NULL DEFAULT '{}',
          emergency_triggered BOOLEAN NOT NULL DEFAULT FALSE,
          red_flags_matched TEXT[] NOT NULL DEFAULT '{}',
          audio_retention_until DATE,
          metrics         JSONB
        );
        """
    )

    op.execute(
        """
        CREATE TABLE voice_turns (
          id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          session_id    UUID NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
          turn_index    INT NOT NULL,
          speaker       TEXT NOT NULL CHECK (speaker IN ('patient','agent','system')),
          transcript    TEXT,
          stt_confidence REAL,
          tool_calls    JSONB,
          latency_ms    JSONB,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (session_id, turn_index)
        );
        """
    )

    # -------------------------------------------------------------------
    # 6.5 Knowledge base (RAG)
    # -------------------------------------------------------------------
    op.execute(
        """
        CREATE TABLE kb_documents (
          id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          namespace     kb_namespace NOT NULL,
          audience      kb_audience NOT NULL,
          title         TEXT NOT NULL,
          source_uri    TEXT,
          source_type   TEXT,
          patient_id    UUID REFERENCES users(id),
          version       INT NOT NULL DEFAULT 1,
          effective_from DATE,
          is_active     BOOLEAN NOT NULL DEFAULT TRUE,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        """
    )

    op.execute(
        """
        CREATE TABLE kb_chunks (
          id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          document_id   UUID NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
          namespace     kb_namespace NOT NULL,
          audience      kb_audience NOT NULL,
          patient_id    UUID,
          chunk_index   INT NOT NULL,
          content       TEXT NOT NULL,
          heading_path  TEXT,
          embedding     VECTOR(384) NOT NULL,
          tsv           TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
          token_count   INT
        );
        """
    )
    op.execute(
        "CREATE INDEX kb_chunks_embedding_idx ON kb_chunks "
        "USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);"
    )
    op.execute("CREATE INDEX kb_chunks_tsv_idx ON kb_chunks USING gin (tsv);")
    op.execute("CREATE INDEX kb_chunks_filter_idx ON kb_chunks (namespace, audience, patient_id);")

    # -------------------------------------------------------------------
    # 6.6 Notifications and outbox
    # -------------------------------------------------------------------
    op.execute(
        """
        CREATE TABLE email_outbox (
          id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          idempotency_key TEXT UNIQUE NOT NULL,
          to_email       TEXT NOT NULL,
          template       TEXT NOT NULL,
          context        JSONB NOT NULL,
          status         outbox_status NOT NULL DEFAULT 'pending',
          attempts       INT NOT NULL DEFAULT 0,
          max_attempts   INT NOT NULL DEFAULT 5,
          next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_error     TEXT,
          provider_message_id TEXT,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        """
    )
    op.execute(
        "CREATE INDEX ON email_outbox (status, next_attempt_at) WHERE status IN ('pending','failed');"
    )

    op.execute(
        """
        CREATE TABLE medication_reminders (
          id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          prescription_id UUID NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
          patient_id     UUID NOT NULL REFERENCES users(id),
          scheduled_at   TIMESTAMPTZ NOT NULL,
          channel        TEXT NOT NULL DEFAULT 'email',
          sent_at        TIMESTAMPTZ,
          acknowledged_at TIMESTAMPTZ,
          UNIQUE (prescription_id, scheduled_at, channel)
        );
        """
    )
    op.execute("CREATE INDEX ON medication_reminders (scheduled_at) WHERE sent_at IS NULL;")

    op.execute(
        """
        CREATE TABLE calendar_links (
          id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
          user_id        UUID NOT NULL REFERENCES users(id),
          google_event_id TEXT,
          calendar_id    TEXT NOT NULL DEFAULT 'primary',
          sync_state     TEXT NOT NULL DEFAULT 'pending',
          last_error     TEXT,
          UNIQUE (appointment_id, user_id)
        );
        """
    )

    op.execute(
        """
        CREATE TABLE google_oauth_tokens (
          user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          refresh_token_encrypted BYTEA NOT NULL,
          scopes         TEXT[] NOT NULL,
          connected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          revoked_at     TIMESTAMPTZ
        );
        """
    )

    op.execute(
        """
        CREATE TABLE audit_log (
          id          BIGSERIAL PRIMARY KEY,
          actor_id    UUID REFERENCES users(id),
          actor_role  user_role,
          action      TEXT NOT NULL,
          entity_type TEXT, entity_id UUID,
          metadata    JSONB,
          ip_address  INET,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        """
    )


def downgrade() -> None:
    # Reverse dependency order. Extensions are intentionally left in place -- dropping
    # them is riskier than it's worth and nothing else in a dev/test DB depends on that.
    for table in (
        "audit_log",
        "google_oauth_tokens",
        "calendar_links",
        "medication_reminders",
        "email_outbox",
        "kb_chunks",
        "kb_documents",
        "voice_turns",
        "voice_sessions",
        "ai_summaries",
        "prescriptions",
        "encounters",
        "appointments",
        "doctor_leave",
        "doctor_working_hours",
        "doctor_profiles",
        "hospitals",
        "patient_profiles",
        "users",
    ):
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE;")

    for enum_type in (
        "outbox_status",
        "kb_audience",
        "kb_namespace",
        "summary_state",
        "summary_kind",
        "urgency_level",
        "appointment_kind",
        "appointment_status",
        "user_role",
    ):
        op.execute(f"DROP TYPE IF EXISTS {enum_type};")
