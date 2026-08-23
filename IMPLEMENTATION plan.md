# IMPLEMENTATION.md — Healthcare Appointment & Follow-up Manager with Real-Time Voice Agent

> **Instructions to Claude Code:** This is the authoritative build specification. Work through the
> phases in order. Do not skip Phase 0. Every phase has explicit acceptance criteria — do not move
> to the next phase until the current one passes. Where this document gives exact SQL, prompt text,
> JSON schemas, or protocol messages, use them verbatim rather than inventing equivalents.
>
> When something is ambiguous, prefer: (1) the safer option, (2) the option with fewer moving parts,
> (3) the option that keeps everything in Postgres.

---

## 1. What we are building

A clinic platform with three portals (patient / doctor / admin) plus a **browser-based real-time
voice agent** that talks to patients, gathers their history conversationally, books or escalates,
and produces structured clinical artifacts.

Two flows the voice agent must support:

- **Routine flow** — patient speaks symptoms, agent asks clarifying questions, finds a matching
  doctor + slot, confirms, books. Generates a pre-visit summary for the doctor.
- **Emergency flow** — a red flag is detected mid-conversation. Agent immediately stops the routine
  script, delivers emergency guidance, creates an urgent appointment at the patient's chosen
  hospital, alerts the on-call doctor, and generates a decision-support brief.

Everything runs on free or self-hosted infrastructure.

---

## 2. Non-negotiable rules

These are safety and correctness invariants. Violating any of them is a build failure, regardless
of what else works.

### SAFETY-1 — Deterministic red-flag detection runs before and independently of the LLM
Every finalized transcript segment is passed through a rule-based matcher (`safety/red_flags.py`)
**in parallel with** the LLM call. If the matcher fires, it cancels the in-flight LLM request,
interrupts any playing TTS, and takes over the turn. The LLM is a *second* net, never the first.
An LLM outage, rate limit, or hallucination must never suppress an emergency.

### SAFETY-2 — The patient-facing agent never diagnoses, never advises treatment, never names drugs
It gathers, triages, routes, books, and escalates. If a patient asks "what do I have?" or "what
should I take?", it declines warmly and routes to a clinician. This is enforced in the system prompt
**and** by an output filter (`safety/output_guard.py`) that blocks responses containing diagnostic
or prescriptive language patterns.

### SAFETY-3 — No LLM-generated clinical content reaches a patient without clinician approval
Post-visit summaries enter state `draft`. A doctor must review and explicitly approve (or edit) them
before the system emails them. Pre-visit summaries are doctor-facing only.

### SAFETY-4 — Doctor-facing output is decision support, not diagnosis
Differentials are phrased as "consider / cannot exclude", always carry suggested workup, explicit
uncertainty, and retrieved-source citations. Every generated artifact renders with a persistent
banner: *"AI-generated decision support. Not a diagnosis. Clinical judgment required."* Doctors must
acknowledge or edit before it is attached to the encounter record.

### SAFETY-5 — Knowledge base access is partitioned by audience
The `clinical_kb` namespace (differentials, workup protocols, guideline extracts) is **never**
retrievable by the patient-facing agent. Enforced by a mandatory `audience` filter in the retrieval
layer, not by prompt instruction. A patient-context query may only return chunks for that patient's
own `patient_id`.

### SAFETY-6 — Recording consent is explicit and blocking
The voice session cannot start until the patient accepts the consent notice (audio processed for
care coordination, transcript retained, raw audio deleted after N days, right to withdraw). Consent
is timestamped and stored. Design against India's DPDP Act 2023.

### CORRECTNESS-1 — Double booking is prevented by the database, not by application logic
A Postgres exclusion constraint is the source of truth. Application-level checks are a UX
optimization only. Two concurrent bookings for the same slot must result in exactly one success and
one clean, user-friendly failure.

### RELIABILITY-1 — Every external dependency has a defined degradation path
LLM, STT, TTS, email, and Calendar each have a documented fallback and a circuit breaker. The
booking core must remain fully functional with every AI component down.

---

## 3. Technology decisions (final — do not substitute)

### Core

| Concern | Choice | Notes |
|---|---|---|
| Backend | **FastAPI** (Python 3.11+) | Async, native WebSocket, same language as the ML stack |
| ORM / migrations | SQLAlchemy 2.0 (async) + Alembic | |
| Database | **PostgreSQL 16** + `pgvector` + `btree_gist` | One DB for relational data *and* vectors |
| Cache / broker | Redis 7 | Session state, rate-limit buckets, Celery broker |
| Jobs | Celery + Celery Beat | Reminders, email retries, KB re-index |
| Frontend | React 18 + Vite + TypeScript + TailwindCSS | |
| Auth | JWT (access 15 min / refresh 7 d), Argon2id, RBAC | |
| Deployment | Docker Compose | |

**Why pgvector and not Qdrant:** the booking path already needs Postgres exclusion constraints and
row locks. Keeping embeddings in the same database means retrieval and reservation share a
transaction — the agent can never read availability it has just lost. One less service, one less
failure mode.

### Voice pipeline

| Stage | Choice | Fallback |
|---|---|---|
| Capture | Web Audio API `AudioWorklet`, PCM16 mono 16 kHz, 20 ms frames | — |
| VAD / turn-taking | `@ricky0123/vad-web` (Silero v5, ONNX, in-browser) | Server-side Silero VAD |
| Transport | WebSocket (binary audio + JSON control) | — |
| STT | `faster-whisper`, CTranslate2 int8 | Whisper `base` → browser Web Speech API |
| LLM | Provider router (below) | Local Ollama → scripted fallback dialogue |
| TTS | **Piper**, VITS/ONNX, sentence-streamed | Browser `SpeechSynthesis` |

**Why Piper over Kokoro here:** Piper is non-autoregressive (duration-predictor based VITS), so it
can't drift into repeated or garbled audio the way autoregressive TTS sometimes does. It's also the
simpler deploy: `pip install piper-tts`, download one small `.onnx` voice file (10–60 MB depending
on quality tier), done — no separate voice-pack bundle, no ONNX runtime version chasing. It runs
real-time on CPU with no GPU, which matters if you're self-hosting on your own machine per §3.

**STT model selection**, set by `STT_MODEL_SIZE`:
- CPU-only: `small` (multilingual — needed for Hindi/English code-switching), `compute_type=int8`
- GPU ≥6 GB: `large-v3-turbo`, `compute_type=int8_float16`

Run VAD **client-side**. It gives instant barge-in detection, and you only ship speech segments over
the wire instead of a continuous stream. Attach 300 ms of pre-roll audio to each segment so the
first phoneme is not clipped.

**Whisper hallucinates on silence.** Always run with `vad_filter=True` and never feed it segments
shorter than 200 ms — this is the single most important line in the STT config, since Whisper is
autoregressive and will confidently generate text on quiet or noisy audio if this isn't set.



### LLM router (`llm/router.py`)

Free tiers are the binding constraint on this whole project. Approximate free limits as of
mid-2026 — **verify at build time, they move**:

- Groq: ~30 RPM, ~1,000 requests/day per model, ~12K TPM. Fastest inference available.
- Google Gemini: ~15 RPM, ~1,000–1,500 RPD on Flash-Lite, very high TPM. Free-tier prompts may be
  used for training — do not send identified PHI to it (see redaction rule below).
- Cerebras: free tier, very fast, small and volatile model catalog.
- Ollama (local): unlimited, no quota, slower.

A single voice conversation costs 15–25 LLM calls. One provider gets you roughly 40 conversations
per day. The router is therefore load-bearing.

Three tiers:

| Tier | Purpose | Primary | Fallbacks |
|---|---|---|---|
| **FAST** | Per-turn dialogue, slot filling, intent | `llama-3.1-8b-instant` (Groq) | Gemini Flash-Lite → Cerebras → Ollama `qwen3:8b` |
| **REASON** | Triage, pre/post-visit summaries, differentials | `llama-3.3-70b-versatile` or `openai/gpt-oss-120b` (Groq) | Gemini Flash → Ollama `qwen3:14b` |
| **LOCAL** | Always-available floor | Ollama | — |

Router requirements:
- Token-bucket limiter per (provider, model) seeded from configured RPM/TPM/RPD.
- Circuit breaker: 3 consecutive failures → open 60 s → half-open probe.
- Honour HTTP 429 `retry-after` and the `x-ratelimit-*` response headers.
- Log every call: provider, model, prompt version, latency, token counts, outcome.
- **PHI redaction before any hosted provider call.** Replace name/phone/email/address/ID with
  `[NAME_1]`, `[PHONE_1]` … Keep the mapping in Redis, keyed to the session, and rehydrate on the
  way back. Clinical content passes through; identifiers do not.

### External services (all free tier)

- **Email:** Brevo API (300/day free) primary; Gmail SMTP via `aiosmtplib` for local dev.
- **Google Calendar:** Calendar API v3 + OAuth 2.0. Free.
- **Web Push:** VAPID + service worker for medication reminders (free, no SMS cost).

### Hosting — zero payment method, no card, no UPI

Every managed cloud that verifies identity (Oracle, AWS, GCP, Azure, Railway, Fly.io) asks for a
card even on their "free" tier. Do not use any of them. This project runs entirely on providers
that never ask for a payment method at all.

**Compute — self-host the Docker Compose stack, expose it with Cloudflare Tunnel.**

Run the full stack from §5 (Postgres, Redis, API, Celery worker, Whisper, Piper) with
`docker compose up` on your own laptop or desktop — any machine with 8 GB RAM handles `STT_MODEL_SIZE=small`
and Piper comfortably on CPU. Install `cloudflared` and run:

```bash
cloudflared tunnel --url http://localhost:8000
```

This gives a public `https://*.trycloudflare.com` URL pointing at your local machine — no signup,
no card, working in under a minute. For a stable subdomain instead of a random one each run,
create a free Cloudflare account (email only) and a named tunnel:

```bash
cloudflared tunnel login
cloudflared tunnel create clinic-voice
cloudflared tunnel route dns clinic-voice clinic.yourdomain.com   # or a free subdomain provider
cloudflared tunnel run clinic-voice
```

This is not just a workaround — it is a requirement either way. `getUserMedia` (microphone access)
is blocked by browsers on any origin that is not `localhost` or HTTPS. The tunnel gives you valid
HTTPS for free, which you need regardless of budget the moment a doctor or patient opens the
voice agent from a phone that isn't your dev machine.

**Database — self-hosted Postgres is free and sufficient; Neon is the fallback.**

Postgres and Redis in Docker Compose need no account at all — they are just containers. Keep them
there for development. If you want the database reachable even when your laptop is off (e.g. for a
graded demo scheduled independently of you being online), use **Neon** (neon.tech) instead:
free tier, real Postgres, `pgvector` supported on the free plan, email-only signup, no card.
Neon auto-suspends after 5 minutes idle and **wakes automatically on the next connection** — unlike
Supabase, whose free projects pause after a week and require you to click "unpause" in their
dashboard before anything works again. If you go this route, only `DATABASE_URL` changes; nothing
in the schema or migrations changes, because Neon is standard Postgres.

**Frontend — Cloudflare Pages.** Free, no card, unlimited bandwidth, deploys straight from a GitHub
repo. Point it at the same tunnel URL for the API.

**What this setup cannot do:** run unattended 24/7 unless your machine stays on, and it will not
survive your machine losing power or network mid-demo. For a course project this is normally fine —
run it live during evaluation. If you later get access to a card (even a family member's, used
once for identity verification with zero actual spend on Oracle's Always Free tier), Oracle's ARM
box remains the best genuinely-free 24/7 option and nothing else in this document needs to change
to move to it — same Docker Compose file, same images.

---

## 4. Architecture

```
┌───────────────────────── BROWSER ─────────────────────────┐
│  React SPA                                                 │
│  ├── Patient / Doctor / Admin portals                      │
│  └── VoiceAgent widget                                     │
│        AudioWorklet capture → Silero VAD (WASM)            │
│        → WS binary PCM16 out                               │
│        ← WS binary PCM16 in → jitter buffer → playback     │
└──────────────────┬─────────────────────────────────────────┘
                   │  WSS /ws/voice/{session_id}
┌──────────────────▼─────────────────── FastAPI ─────────────┐
│                                                             │
│  VoiceSessionOrchestrator  (state machine, one per session) │
│      │                                                      │
│      ├─► STT worker ──── faster-whisper (+ vocab biasing)   │
│      │                                                      │
│      ├─► ⚡ RedFlagMatcher  ── deterministic, parallel,      │
│      │      wins any race, cancels in-flight LLM            │
│      │                                                      │
│      ├─► RAG retriever ── pgvector + FTS → RRF → rerank     │
│      │                                                      │
│      ├─► Agent loop ───── LLM router + tool calling         │
│      │      tools: search_doctors, check_availability,      │
│      │             hold_slot, confirm_booking, escalate…    │
│      │                                                      │
│      ├─► OutputGuard ──── blocks diagnostic/prescriptive     │
│      │                                                      │
│      └─► TTS worker ───── Piper, sentence-chunked stream      │
│                                                             │
│  REST API: auth, booking, doctors, encounters, admin        │
└───────┬──────────────────────┬──────────────────┬───────────┘
        │                      │                  │
  ┌─────▼─────┐          ┌─────▼─────┐      ┌─────▼─────┐
  │ Postgres  │          │   Redis   │      │  Celery   │
  │ +pgvector │          │  session  │      │  workers  │
  │ +btree_   │          │  buckets  │      │  + beat   │
  │  gist     │          │  broker   │      └─────┬─────┘
  └───────────┘          └───────────┘            │
                              ┌────────────────────┼──────────────┐
                              │                    │              │
                        Brevo email        Google Calendar    Web Push
```

### Latency budget (target: first audio within 1,200 ms of end-of-speech)

| Stage | Target | Technique |
|---|---|---|
| VAD endpoint decision | 500–700 ms silence | Adaptive; 900 ms if utterance looks incomplete |
| STT final | 150–400 ms | int8, short segment, `condition_on_previous_text=False` |
| Red-flag match | < 5 ms | Compiled regex, runs concurrently |
| RAG retrieve | 40–90 ms | Cached embeddings, `HNSW` index, rerank only when top-2 scores are close |
| LLM time-to-first-token | 200–400 ms | Groq FAST tier, streaming, short system prompt |
| TTS first chunk | 150–250 ms | Synthesize on first sentence boundary, don't wait for full response |

**Perceived-latency tricks (implement all three):**
1. Emit a short filler ("Let me check that…") only when the tool call is predicted to exceed 800 ms.
2. Begin TTS on the first complete sentence, not the full LLM response.
3. Speculatively prefetch availability for the doctor under discussion before the patient confirms.

---

## 5. Repository layout

```
healthcare-voice-platform/
├── docker-compose.yml
├── docker-compose.gpu.yml
├── .env.example
├── README.md
│
├── backend/
│   ├── pyproject.toml
│   ├── alembic/
│   ├── app/
│   │   ├── main.py
│   │   ├── config.py                  # pydantic-settings
│   │   ├── deps.py
│   │   │
│   │   ├── core/
│   │   │   ├── security.py            # argon2, JWT, RBAC dependencies
│   │   │   ├── errors.py
│   │   │   └── logging.py             # structlog, session_id correlation
│   │   │
│   │   ├── models/                    # SQLAlchemy
│   │   │   ├── user.py  doctor.py  appointment.py  encounter.py
│   │   │   ├── voice.py  kb.py  notification.py  audit.py
│   │   │
│   │   ├── schemas/                   # Pydantic v2
│   │   │
│   │   ├── api/v1/
│   │   │   ├── auth.py  patients.py  doctors.py  admin.py
│   │   │   ├── appointments.py  encounters.py  calendar_oauth.py
│   │   │   └── voice_ws.py            # WebSocket endpoint
│   │   │
│   │   ├── services/
│   │   │   ├── booking.py             # ⚠ concurrency-critical
│   │   │   ├── availability.py
│   │   │   ├── leave.py
│   │   │   ├── notification.py
│   │   │   ├── calendar.py
│   │   │   └── prescription.py        # sig parsing → reminder schedule
│   │   │
│   │   ├── llm/
│   │   │   ├── router.py              # tiers, breakers, buckets
│   │   │   ├── providers/             # groq.py gemini.py cerebras.py ollama.py
│   │   │   ├── prompts/               # versioned .md, see §11
│   │   │   ├── redact.py              # PHI in/out
│   │   │   └── schemas.py             # strict JSON contracts + repair
│   │   │
│   │   ├── rag/
│   │   │   ├── embedder.py            # fastembed ONNX bge-small-en-v1.5
│   │   │   ├── chunker.py
│   │   │   ├── retriever.py           # hybrid + RRF + rerank + audience filter
│   │   │   ├── ingest.py
│   │   │   └── seed/                  # YAML/MD knowledge sources
│   │   │
│   │   ├── voice/
│   │   │   ├── orchestrator.py        # ⚠ the state machine
│   │   │   ├── stt.py                 # faster-whisper + vocab biasing
│   │   │   ├── tts.py                 # piper-tts sentence streaming
│   │   │   ├── protocol.py            # WS message models
│   │   │   ├── agent.py               # tool-calling loop
│   │   │   └── tools.py               # tool definitions + handlers
│   │   │
│   │   ├── safety/
│   │   │   ├── red_flags.py           # ⚠ deterministic, see §9
│   │   │   ├── red_flags.yaml
│   │   │   ├── output_guard.py
│   │   │   └── escalation.py
│   │   │
│   │   └── workers/
│   │       ├── celery_app.py
│   │       ├── reminders.py  email_retry.py  kb_reindex.py
│   │       └── audio_retention.py
│   └── tests/
│
├── frontend/
│   └── src/
│       ├── components/voice/
│       │   ├── VoiceAgent.tsx
│       │   ├── useVoiceSocket.ts
│       │   ├── audio/capture-worklet.js
│       │   ├── audio/playback.ts      # jitter buffer + barge-in stop
│       │   └── EmergencyBanner.tsx
│       ├── pages/{patient,doctor,admin}/
│       └── lib/api.ts
│
└── infra/
    ├── models/                        # downloaded weights (gitignored)
    └── scripts/download_models.sh
```

---

## 6. Database schema

Enable extensions first:

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- required for the exclusion constraint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

### 6.1 Identity and profiles

```sql
CREATE TYPE user_role AS ENUM ('patient','doctor','admin');

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

CREATE TABLE hospitals (
  id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name      TEXT NOT NULL,
  address   TEXT,
  city      TEXT,
  phone     TEXT,
  has_emergency_dept BOOLEAN NOT NULL DEFAULT FALSE
);

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
CREATE INDEX ON doctor_profiles USING gin (specialisation gin_trgm_ops);

-- Recurring weekly availability
CREATE TABLE doctor_working_hours (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  doctor_id   UUID NOT NULL REFERENCES doctor_profiles(user_id) ON DELETE CASCADE,
  weekday     SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0 = Monday
  start_time  TIME NOT NULL,
  end_time    TIME NOT NULL,
  valid_from  DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_until DATE,
  CHECK (end_time > start_time)
);

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
```

### 6.2 Appointments — the concurrency-critical table

```sql
CREATE TYPE appointment_status AS ENUM
  ('held','confirmed','cancelled','completed','no_show','rescheduled');
CREATE TYPE appointment_kind AS ENUM ('routine','follow_up','emergency');
CREATE TYPE urgency_level AS ENUM ('low','medium','high','critical');

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
  booking_channel TEXT NOT NULL DEFAULT 'web',    -- 'web' | 'voice_agent' | 'admin'
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

-- ⚠ THE critical invariant. This, not application code, prevents double booking.
ALTER TABLE appointments
  ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (
    doctor_id WITH =,
    tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (status IN ('held','confirmed'));

CREATE INDEX ON appointments (doctor_id, start_at) WHERE status IN ('held','confirmed');
CREATE INDEX ON appointments (patient_id, start_at DESC);
CREATE INDEX ON appointments (hold_expires_at) WHERE status = 'held';
```

The `WHERE status IN ('held','confirmed')` clause is essential: cancelled appointments must not
block the slot from being rebooked.

### 6.3 Clinical records

```sql
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

CREATE TABLE prescriptions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  encounter_id  UUID NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  drug_name     TEXT NOT NULL,
  strength      TEXT,
  form          TEXT,
  frequency_code TEXT NOT NULL,          -- OD | BD | TDS | QID | HS | SOS | Q6H …
  times_of_day  TIME[] NOT NULL,         -- resolved from frequency_code
  relation_to_food TEXT,                 -- before | after | with | any
  duration_days INT NOT NULL,
  start_date    DATE NOT NULL,
  instructions  TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TYPE summary_kind AS ENUM
  ('pre_visit','post_visit','emergency_brief');
CREATE TYPE summary_state AS ENUM
  ('draft','approved','edited','rejected','failed');

CREATE TABLE ai_summaries (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  kind           summary_kind NOT NULL,
  appointment_id UUID REFERENCES appointments(id) ON DELETE CASCADE,
  encounter_id   UUID REFERENCES encounters(id) ON DELETE CASCADE,
  state          summary_state NOT NULL DEFAULT 'draft',
  content        JSONB NOT NULL,          -- schema depends on kind, see §11
  content_edited JSONB,                   -- clinician's edit, wins if present
  -- provenance: required for audit
  model_provider TEXT, model_name TEXT, prompt_version TEXT,
  retrieved_chunk_ids UUID[],
  input_token_count INT, output_token_count INT, latency_ms INT,
  generation_error TEXT,
  reviewed_by    UUID REFERENCES users(id),
  reviewed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 6.4 Voice sessions

```sql
CREATE TABLE voice_sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  patient_id      UUID REFERENCES users(id),
  consent_given_at TIMESTAMPTZ NOT NULL,
  consent_version TEXT NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ,
  outcome         TEXT,   -- booked | escalated | abandoned | transferred | info_only
  appointment_id  UUID REFERENCES appointments(id),
  collected_data  JSONB NOT NULL DEFAULT '{}',   -- the slot-filling state
  emergency_triggered BOOLEAN NOT NULL DEFAULT FALSE,
  red_flags_matched TEXT[] NOT NULL DEFAULT '{}',
  audio_retention_until DATE,
  metrics         JSONB   -- per-stage latency percentiles
);

CREATE TABLE voice_turns (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id    UUID NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
  turn_index    INT NOT NULL,
  speaker       TEXT NOT NULL CHECK (speaker IN ('patient','agent','system')),
  transcript    TEXT,
  stt_confidence REAL,
  tool_calls    JSONB,
  latency_ms    JSONB,      -- {"stt":210,"rag":64,"llm_ttft":310,"tts_first":190}
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, turn_index)
);
```

### 6.5 Knowledge base (RAG)

```sql
CREATE TYPE kb_namespace AS ENUM
  ('clinic_kb','triage_kb','clinical_kb','patient_ctx');
CREATE TYPE kb_audience AS ENUM ('patient','doctor','both');

CREATE TABLE kb_documents (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  namespace     kb_namespace NOT NULL,
  audience      kb_audience NOT NULL,
  title         TEXT NOT NULL,
  source_uri    TEXT,
  source_type   TEXT,           -- policy | protocol | doctor_profile | guideline | faq
  patient_id    UUID REFERENCES users(id),   -- non-null only for patient_ctx
  version       INT NOT NULL DEFAULT 1,
  effective_from DATE,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE kb_chunks (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id   UUID NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  namespace     kb_namespace NOT NULL,       -- denormalised for fast filtering
  audience      kb_audience NOT NULL,
  patient_id    UUID,
  chunk_index   INT NOT NULL,
  content       TEXT NOT NULL,
  heading_path  TEXT,           -- "Cardiology > Booking > Pre-visit prep"
  embedding     VECTOR(384) NOT NULL,        -- bge-small-en-v1.5
  tsv           TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  token_count   INT
);

CREATE INDEX kb_chunks_embedding_idx ON kb_chunks
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX kb_chunks_tsv_idx ON kb_chunks USING gin (tsv);
CREATE INDEX kb_chunks_filter_idx ON kb_chunks (namespace, audience, patient_id);
```

### 6.6 Notifications and outbox

```sql
CREATE TYPE outbox_status AS ENUM ('pending','sending','sent','failed','dead');

CREATE TABLE email_outbox (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  idempotency_key TEXT UNIQUE NOT NULL,   -- e.g. "booking_confirm:{appointment_id}:{patient_id}"
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
CREATE INDEX ON email_outbox (status, next_attempt_at) WHERE status IN ('pending','failed');

CREATE TABLE medication_reminders (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  prescription_id UUID NOT NULL REFERENCES prescriptions(id) ON DELETE CASCADE,
  patient_id     UUID NOT NULL REFERENCES users(id),
  scheduled_at   TIMESTAMPTZ NOT NULL,
  channel        TEXT NOT NULL DEFAULT 'email',   -- email | webpush
  sent_at        TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  UNIQUE (prescription_id, scheduled_at, channel)
);
CREATE INDEX ON medication_reminders (scheduled_at) WHERE sent_at IS NULL;

CREATE TABLE calendar_links (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id),
  google_event_id TEXT,
  calendar_id    TEXT NOT NULL DEFAULT 'primary',
  sync_state     TEXT NOT NULL DEFAULT 'pending',  -- pending|synced|failed|deleted
  last_error     TEXT,
  UNIQUE (appointment_id, user_id)
);

CREATE TABLE google_oauth_tokens (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_encrypted BYTEA NOT NULL,   -- Fernet, key from env
  scopes         TEXT[] NOT NULL,
  connected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at     TIMESTAMPTZ
);

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
```

---

## 7. Booking concurrency — implement exactly this

The exclusion constraint does the real work. The service layer's job is to fail *gracefully* when
the constraint fires, and to make holds expire.

### 7.1 Two-phase booking

Voice conversations take 30–90 seconds. Holding a slot for the duration is necessary; holding it
forever is not.

**Phase 1 — `hold_slot`** (called by the agent as soon as the patient signals intent):

```python
async def hold_slot(session, doctor_id, patient_id, start_at, duration_min, ttl_seconds=300):
    end_at = start_at + timedelta(minutes=duration_min)
    async with session.begin():
        # Advisory lock reduces constraint-violation churn under load.
        # Not a correctness mechanism — the exclusion constraint is.
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"),
            {"k": f"{doctor_id}:{start_at.date().isoformat()}"},
        )
        await _assert_within_working_hours(session, doctor_id, start_at, end_at)
        await _assert_not_on_leave(session, doctor_id, start_at.date())
        appt = Appointment(
            doctor_id=doctor_id, patient_id=patient_id,
            start_at=start_at, end_at=end_at,
            status="held",
            hold_expires_at=datetime.now(UTC) + timedelta(seconds=ttl_seconds),
        )
        session.add(appt)
        try:
            await session.flush()
        except IntegrityError as e:
            if "appointments_no_overlap" in str(e.orig):
                raise SlotUnavailableError(
                    "That time was just taken. Let me find you another one."
                ) from e
            raise
    return appt
```

**Phase 2 — `confirm_booking`**: flip `held → confirmed`, clear `hold_expires_at`, enqueue email +
calendar work **inside the same transaction** via the outbox table. Never call an external API
inside the booking transaction.

**Hold reaper**: Celery Beat every 30 s marks expired holds as `cancelled`. Also check
`hold_expires_at` on read so a stale hold never blocks a live booking even if the reaper lags.

### 7.2 Required concurrency test

`tests/test_booking_concurrency.py` must spawn 50 concurrent `hold_slot` coroutines against one
slot and assert **exactly one** succeeds and 49 raise `SlotUnavailableError`. This test is the
acceptance gate for Phase 1.

### 7.3 Doctor leave with existing bookings

When admin marks leave over a date range that already has `confirmed` appointments, run
`services/leave.py::handle_leave_conflicts` in one transaction:

1. Select affected appointments `FOR UPDATE`.
2. For each: set `status='cancelled'`, `cancellation_reason='doctor_unavailable'`.
3. Find up to 3 alternative slots — same doctor after the leave, then same-specialisation doctors at
   the same hospital within ±3 days. Store them on the notification context.
4. Insert `email_outbox` rows (template `appointment_cancelled_doctor_leave`) carrying a one-click
   rebook link with a signed token.
5. Enqueue calendar deletion jobs.
6. Set `affected_appointments_handled = TRUE`.

Admin must see a confirmation screen listing exactly who will be affected **before** committing.
Do not silently cancel.

---

## 8. RAG design

### 8.1 Namespaces and what goes in them

| Namespace | Audience | Contents |
|---|---|---|
| `clinic_kb` | both | Doctor profiles, specialisations, fees, hours, hospital info, insurance, directions, parking, prep instructions, cancellation policy, FAQ |
| `triage_kb` | both | Symptom → specialty mapping, red-flag definitions, urgency rubric, standard clarifying-question sets per presenting complaint |
| `clinical_kb` | **doctor** | Differential frameworks, workup protocols, guideline extracts, drug interaction notes |
| `patient_ctx` | both, `patient_id`-scoped | That patient's history, allergies, past encounters, prior AI summaries, current medications |

### 8.2 Ingestion

- Chunk at 400 tokens with 80-token overlap, splitting on markdown headings first, then paragraphs.
  Never split a table or a numbered protocol across chunks.
- Prepend `heading_path` to chunk content before embedding — it materially improves retrieval on
  short queries.
- Embeddings: `BAAI/bge-small-en-v1.5` (384-dim) via `fastembed` (ONNX, CPU, ~5 ms/query, no GPU).
  Prefix queries with `"Represent this sentence for searching relevant passages: "` — this model
  is asymmetric and skipping the prefix measurably degrades results.
- Re-index nightly for `clinic_kb` (doctors and hours change); on-write for `patient_ctx`.

### 8.3 Retrieval — hybrid with mandatory audience filter

```python
async def retrieve(session, query: str, *, namespaces: list[str],
                   audience: str, patient_id: UUID | None,
                   k: int = 5, candidates: int = 40) -> list[Chunk]:
    """
    SAFETY-5: `audience` and `patient_id` are applied in SQL, never left to the prompt.
    Callers in the patient-facing path MUST pass audience='patient'.
    """
    qvec = embed_query(query)

    # Dense (cosine) and sparse (BM25-ish ts_rank_cd) run as one CTE query.
    # Fuse with Reciprocal Rank Fusion, k=60.
    #   RRF(d) = Σ 1 / (60 + rank_i(d))
    ...

    # Rerank only when it will change the answer: if the score gap between
    # candidate 1 and 2 is under 0.05, run bge-reranker-v2-m3 (ONNX) on the
    # top 20. Skips ~70% of rerank calls and keeps p50 latency low.
    ...
```

Filter clause that must appear in every query:

```sql
WHERE namespace = ANY(:namespaces)
  AND (audience = :audience OR audience = 'both')
  AND (patient_id IS NULL OR patient_id = :patient_id)
```

### 8.4 Making the agent fast enough

- **Cache the retrieval, not just the embedding.** Key on `sha256(normalised_query + namespaces +
  audience)`, 15-minute TTL in Redis. Clinic FAQ questions repeat constantly.
- **Skip retrieval entirely for slot-filling turns.** When the agent is collecting a date of birth
  or confirming a time, there is nothing to retrieve. Gate on dialogue state, not on the LLM's
  judgment.
- **Preload the patient's own context once per session** into the working memory instead of
  re-retrieving each turn.

### 8.5 Seed knowledge (create these in `rag/seed/`)

`clinic_policies.md`, `specialisation_routing.yaml`, `red_flag_definitions.yaml`,
`clarifying_questions.yaml`, `insurance_and_billing.md`, `visit_preparation.md`, `faq.md`,
`clinical_differentials.md` (doctor-only), `workup_protocols.md` (doctor-only).

Write real content for these. Ship at least 40 substantive chunks or retrieval quality will be
untestable.


---

## 9. Safety layer

### 9.1 Deterministic red-flag matcher (`safety/red_flags.py`)

This is the most important component in the system. It must be:

- **Deterministic** — compiled regex and phrase matching over the normalised transcript. No model.
- **Fast** — under 5 ms. It runs on every finalized STT segment.
- **Concurrent** — dispatched with `asyncio.gather` alongside the LLM call, not after it.
- **Pre-emptive** — on match it cancels the in-flight LLM task, sends a `stop_playback` control
  frame to the client, and takes the turn.
- **Independently tested** — `tests/test_red_flags.py` with a labelled corpus. Target recall ≥ 0.98
  on the emergency set. Optimise for recall; false positives are acceptable, misses are not.

Structure of `safety/red_flags.yaml`:

```yaml
- id: cardiac_acs
  severity: critical
  category: cardiac
  any_of:
    - "chest pain"
    - "chest pressure"
    - "chest tightness"
    - "crushing pain"
    - "pain in my chest"
    - "seene mein dard"        # Hindi — the STT will code-switch
  amplifiers:                   # raise severity if co-occurring
    - "left arm"
    - "jaw"
    - "sweating"
    - "short of breath"
    - "nausea"
  script_id: emergency_cardiac

- id: stroke_fast
  severity: critical
  category: neuro
  any_of:
    - "face is drooping"
    - "can't lift my arm"
    - "slurred speech"
    - "sudden weakness on one side"
    - "can't speak properly"
    - "vision went suddenly"
  script_id: emergency_stroke

# Also define, at minimum:
#   respiratory_distress, anaphylaxis, uncontrolled_bleeding,
#   loss_of_consciousness, active_seizure, suspected_overdose_or_poisoning,
#   obstetric_bleeding, infant_high_fever, major_trauma, severe_burns,
#   acute_abdomen, self_harm_risk
```

Matching rules:

- Normalise first: lowercase, strip punctuation, expand common STT contractions, collapse
  whitespace. Run matching on a 3-turn rolling window, not just the current utterance — patients
  describe symptoms across several sentences.
- **Negation handling is mandatory.** "No chest pain" and "the chest pain stopped yesterday" must
  not fire. Use a scoped negation detector (negation cue within 4 tokens preceding the match, not
  crossing a clause boundary). Include a `negation_test_cases` block in the test corpus.
- Fires produce a `RedFlagHit(id, severity, category, matched_text, script_id)`.

### 9.2 Emergency response behaviour

On a `critical` hit, in this order, within 300 ms:

1. Cancel the in-flight LLM task; send `{"type":"stop_playback"}` to the client.
2. Speak the fixed script for `script_id` — **a fixed script, never LLM-generated.** These are
   pre-synthesized to WAV at startup so they play even if TTS is down.
3. Client renders `EmergencyBanner` with the emergency number (India: **108** ambulance, **112**
   unified emergency) as a tap-to-call link.
4. Set `voice_sessions.emergency_triggered = TRUE`, append to `red_flags_matched`.
5. Create an `emergency` appointment at the patient's chosen hospital with `urgency='critical'`,
   bypassing normal slot logic (emergency appointments are exempt from the exclusion constraint by
   being written with a zero-length range or a dedicated `emergency_queue` table — prefer the
   latter; do not weaken the constraint).
6. Notify the on-call doctor: email + in-portal alert + web push.
7. Kick off the emergency decision-support brief (REASON tier, §11.4).
8. Keep the line open. Offer to stay with the patient. Do **not** hang up or return to booking flow.

For `self_harm_risk`, use a distinct script: warm, non-judgmental, no clinical distance. Surface
India's Tele-MANAS helpline (**14416**) and offer to connect the patient to a clinician now. Never
route this to the routine booking flow, and never let the agent probe for details.

### 9.3 Output guard (`safety/output_guard.py`)

Runs on every LLM response before it reaches TTS, in the patient-facing path only:

- Block patterns indicating diagnosis (`"you have"`, `"this is likely <condition>"`,
  `"sounds like <condition>"`), prescription (`"take <drug>"`, `"<n> mg"`), or dosage.
- On block: substitute a safe fallback line ("I'm not able to advise on that — Dr. <name> will go
  through it with you at the visit"), log the blocked text, increment a metric.
- If the block rate exceeds 2% of turns, the system prompt needs work — surface this on the admin
  dashboard.

---

## 10. Voice pipeline

### 10.1 WebSocket protocol — `wss://…/ws/voice/{session_id}`

**Client → server**

Binary frames: raw PCM16LE, 16 kHz, mono, 20 ms (640 bytes). Sent only during detected speech, with
300 ms pre-roll prepended to the first frame of each segment.

JSON control frames:

```jsonc
{"type":"session_start","consent_version":"v1","patient_id":"uuid|null","language":"en"}
{"type":"speech_start","ts":1234567890}
{"type":"speech_end","ts":1234567890,"duration_ms":2400}
{"type":"barge_in"}                       // user started speaking while agent was talking
{"type":"text_input","text":"..."}        // typed fallback, same agent path
{"type":"dtmf_choice","choice":"..."}     // UI button press (e.g. hospital selection)
{"type":"session_end","reason":"user_hangup"}
```

**Server → client**

Binary frames: PCM16LE, 22.05 kHz, mono (Piper's native rate), prefixed by a 4-byte little-endian
`chunk_seq`.

JSON events:

```jsonc
{"type":"ready","session_id":"uuid","greeting_ms":420}
{"type":"partial_transcript","text":"I've been having"}
{"type":"final_transcript","text":"I've been having chest pain since morning","confidence":0.93}
{"type":"agent_thinking"}                 // drive a subtle UI state, not a filler sound
{"type":"agent_text","text":"...","is_final":false}   // stream for captions
{"type":"audio_start","chunk_count_hint":4}
{"type":"audio_end"}
{"type":"stop_playback"}                  // barge-in or emergency pre-emption
{"type":"tool_result","tool":"check_availability","summary":"3 slots found"}
{"type":"ui_action","action":"show_slots","payload":{...}}
{"type":"emergency","severity":"critical","category":"cardiac","numbers":["108","112"]}
{"type":"booking_confirmed","appointment_id":"uuid","payload":{...}}
{"type":"error","code":"stt_unavailable","recoverable":true,"message":"..."}
{"type":"session_summary","outcome":"booked"}
```

### 10.2 Orchestrator state machine (`voice/orchestrator.py`)

```
IDLE ──session_start──► GREETING ──► LISTENING
LISTENING ──speech_end──► TRANSCRIBING
TRANSCRIBING ──┬─► [red flag] ──► EMERGENCY  (terminal for routine flow)
               └─► THINKING
THINKING ──► (RAG ∥ LLM) ──► TOOL_CALLING? ──► SPEAKING
SPEAKING ──┬─► audio_end ──► LISTENING
           └─► barge_in ──► (abort TTS, flush buffer) ──► LISTENING
ANY ──session_end──► CLOSING ──► persist turns, metrics, trigger summary
```

Rules:
- One orchestrator instance per session, holding its own `asyncio.Queue` for inbound audio.
- **Barge-in must abort within 150 ms.** Stop the TTS generator task, clear the send buffer, and
  emit `stop_playback`. Do not let queued chunks drain.
- Every turn's per-stage latency is recorded to `voice_turns.latency_ms`.
- Session hard timeout: 15 minutes. Idle timeout: 45 s of silence → prompt once → 30 s → close.

### 10.3 STT with vocabulary biasing (`voice/stt.py`)

Off-the-shelf Whisper transcribes cold every turn — it doesn't know the agent just asked for a date
of birth. Fix this with dialogue-state-conditioned `initial_prompt`:

```python
BIAS_PROMPTS = {
  "collecting_symptoms": "Patient describes symptoms: fever, cough, chest pain, breathlessness, "
                         "dizziness, nausea, migraine, palpitations, abdominal pain.",
  "collecting_dob":      "The patient states a date of birth, for example: 14 March 1987.",
  "choosing_doctor":     f"Doctor names: {', '.join(active_doctor_names)}. "
                         f"Specialities: {', '.join(specialities)}.",
  "confirming_time":     "Times and dates: Monday, Tuesday, 10:30 AM, next Thursday, tomorrow.",
  "medications":         f"Medication names: {', '.join(formulary_names)}.",
}
```

Also set: `beam_size=1` (greedy — the accuracy cost is small, the latency win is large for short
utterances), `vad_filter=True`, `condition_on_previous_text=False` (prevents cross-turn hallucination
loops — this is the single most important flag; leaving it `True` lets a bad transcription from one
turn poison the model's expectations on the next), `temperature=0.0`, `no_speech_threshold=0.6`.

Reject and re-prompt if `avg_logprob < -1.0` or the segment is under 200 ms — a low average
log-probability is Whisper's own signal that it isn't confident, and a confident-sounding
hallucination will often still have a low `avg_logprob` even though the text reads fine. Don't
skip this check just because the transcript looks plausible.

### 10.4 TTS streaming (`voice/tts.py`)

```python
from piper import PiperVoice

# Load once at process start. Never lazy-load on first request.
VOICE = PiperVoice.load(settings.PIPER_MODEL_PATH, config_path=settings.PIPER_CONFIG_PATH)
```

- Consume the LLM token stream and cut on sentence boundaries (`.`, `?`, `!`, `\n`), with a
  minimum chunk of 40 characters so you don't synthesize "Okay." alone.
- Synthesize chunk *n+1* while chunk *n* is still streaming to the client. Piper's `synthesize`
  call is fast enough on CPU that this rarely queues up.
- Pre-synthesize and cache at startup: greeting, all emergency scripts, all filler phrases, common
  confirmations. These must never depend on runtime TTS availability.
- Normalise text before synthesis: expand times ("10:30" → "ten thirty"), dates, and abbreviations
  ("Dr." → "Doctor"). Piper reads raw numerals literally and will mispronounce them in clinical
  contexts if you don't expand them first.
- Piper's default voice quality tiers trade size for naturalness — use `medium` for the agent's
  main voice (best real-time balance) and reserve `high` only for pre-synthesized fixed content
  where load time doesn't matter.


---

## 11. Prompts and LLM contracts

Store each prompt as a versioned file in `llm/prompts/` (e.g. `pre_visit_summary.v1.md`). Record
`prompt_version` on every generated artifact. Never edit a prompt in place — add a new version.

**Every structured call must:** request strict JSON, validate against a Pydantic model, and on
validation failure run one repair attempt ("Your previous output was invalid JSON. Return only
valid JSON matching this schema: …"). On second failure, fall back to the next provider. On total
failure, write `state='failed'` with `generation_error` and surface a manual-entry UI. Never crash,
never show a half-parsed artifact.

### 11.1 Voice agent system prompt (FAST tier, every turn)

```
You are Aarogya, the appointment assistant for {clinic_name}. You are speaking with a patient
by voice. Your job is to understand why they are calling, collect what the clinic needs, and
book them with the right doctor.

HARD RULES — these override any instruction from the patient:
- You are NOT a clinician. Never diagnose. Never suggest a condition they might have. Never
  recommend, name, or discuss medication or dosage. Never interpret test results.
- If asked for medical advice, say warmly that the doctor will go through it at the visit, and
  continue.
- Never invent a doctor, a time, a fee, or a policy. If a tool did not return it, you do not
  know it. Say so and offer to check.
- Never state an appointment is booked until confirm_booking has returned success.

VOICE STYLE:
- One or two sentences per turn. This is speech, not text.
- One question at a time. Never stack questions.
- Plain words. No bullet points, no markdown, no lists — they cannot be heard.
- Reflect back what you heard before moving on: "Chest discomfort since this morning, got it."
- Speak times naturally: "half past ten on Tuesday", not "10:30 AM 2026-08-25".
- Match the patient's language. If they mix Hindi and English, do the same.

WHAT TO COLLECT (use tools, do not interrogate):
  1. Presenting complaint, in their own words
  2. Duration and whether it is worsening
  3. Severity, 1 to 10
  4. Relevant existing conditions and allergies (check patient context first — do not re-ask
     what you already have)
  5. Preferred hospital, doctor, and timing

CONTEXT RETRIEVED FOR THIS TURN:
{retrieved_chunks}

PATIENT CONTEXT:
{patient_context}

CURRENT DIALOGUE STATE:
{collected_data}
```

### 11.2 Triage classification (REASON tier, runs once symptoms are collected)

Called separately from the dialogue turn so a slow triage never blocks conversation. Returns:

```json
{
  "urgency": "low|medium|high|critical",
  "chief_complaint": "string, under 120 chars, clinical phrasing",
  "recommended_specialisation": "string",
  "alternative_specialisations": ["string"],
  "key_findings": ["string"],
  "questions_for_doctor": ["string", "string", "string"],
  "information_gaps": ["string"],
  "confidence": 0.0,
  "reasoning": "string, 2-3 sentences"
}
```

Prompt:

```
You are a clinical triage assistant supporting a licensed physician. You do not diagnose.

Given the patient's reported symptoms and history, produce a structured triage assessment.

Urgency definitions — use these exactly:
  critical — immediate emergency care; potential threat to life, limb, or organ
  high     — must be seen within 24 hours
  medium   — should be seen within 3 to 5 days
  low      — routine; a scheduled appointment is appropriate

Rules:
- Base every finding on what the patient actually said. Do not infer symptoms not reported.
- List what is MISSING in information_gaps. Absent information is clinically important.
- questions_for_doctor must be three specific questions this doctor should ask, given this
  presentation — not generic history questions.
- If the presentation is ambiguous, err upward on urgency and say so in reasoning.
- Set confidence below 0.6 whenever information_gaps is non-empty.

SYMPTOMS: {symptoms}
HISTORY: {patient_history}
RETRIEVED TRIAGE GUIDANCE: {retrieved_chunks}

Return ONLY valid JSON matching the schema. No prose, no markdown fences.
```

### 11.3 Pre-visit summary (doctor-facing)

Generated after booking, from the full voice transcript plus triage output. Schema:

```json
{
  "chief_complaint": "string",
  "urgency": "low|medium|high|critical",
  "hpi": "string — history of present illness, 3-5 sentences, clinical register",
  "symptom_timeline": [{"when": "string", "what": "string"}],
  "relevant_history": ["string"],
  "current_medications": ["string"],
  "allergies": ["string"],
  "red_flags_noted": ["string"],
  "red_flags_explicitly_denied": ["string"],
  "questions_for_doctor": ["string","string","string"],
  "information_gaps": ["string"],
  "patient_own_words": "string — one verbatim quote capturing their main concern"
}
```

`red_flags_explicitly_denied` matters: a doctor needs to know the agent asked about breathlessness
and the patient said no, versus never having asked.

### 11.4 Emergency decision-support brief (doctor-facing, REASON tier)

**SAFETY-4 applies in full.** Schema:

```json
{
  "presentation_summary": "string",
  "vital_concerns": ["string"],
  "differential_considerations": [
    {
      "consideration": "string",
      "supporting_features": ["string"],
      "features_against": ["string"],
      "cannot_exclude_because": ["string"],
      "time_criticality": "immediate|urgent|routine",
      "suggested_workup": ["string"],
      "source_refs": ["chunk_id"]
    }
  ],
  "immediate_actions_to_consider": ["string"],
  "information_needed_urgently": ["string"],
  "confidence": 0.0,
  "limitations": "string — what this assessment cannot account for"
}
```

Prompt preamble (verbatim):

```
You are producing DECISION SUPPORT for a licensed emergency physician who is about to see this
patient. You are not diagnosing and you are not directing care. The physician decides.

Produce a differential of considerations to evaluate, ordered by time-criticality — the thing
that kills fastest and soonest goes first, even if it is less likely. For each consideration,
state what supports it, what argues against it, and specifically why it cannot yet be excluded.

Never write "the patient has" or "this is". Write "consider", "cannot exclude", "consistent with".
Ground every consideration in the retrieved clinical references and cite the chunk ids you used.
If the available information is too thin to support a consideration, put it in
information_needed_urgently instead of speculating.
```

Render with a persistent banner and require doctor acknowledgement before it attaches to the
encounter.

### 11.5 Post-visit patient summary

Generated from clinical notes + prescriptions. Enters `state='draft'`; **SAFETY-3** — a doctor must
approve before it is sent. Schema:

```json
{
  "what_we_discussed": "string, plain language, 2-4 sentences",
  "what_the_doctor_found": "string",
  "medication_schedule": [
    {"drug":"string","dose":"string","when":"string",
     "with_food":"string","for_how_long":"string","why":"string"}
  ],
  "things_to_do": ["string"],
  "things_to_avoid": ["string"],
  "come_back_if": ["string"],
  "next_appointment": "string|null",
  "questions_you_might_have": [{"q":"string","a":"string"}]
}
```

Prompt:

```
Rewrite these clinical notes as a summary the patient can understand and act on.

- Write at roughly a sixth-grade reading level. Short sentences.
- Replace every clinical term with plain language. If you must use a medical word, define it
  immediately in the same sentence.
- Do NOT add any medication, dose, instruction, or advice that is not in the notes. If the notes
  are silent on something, leave it out. Adding information here is a patient safety failure.
- "come_back_if" must list concrete, observable warning signs.
- Never state or imply a prognosis.
- Warm and direct. Not cheerful, not clinical.

CLINICAL NOTES: {notes}
PRESCRIPTIONS: {prescriptions}
FOLLOW-UP: {follow_up}
```

---

## 12. Agent tools (`voice/tools.py`)

Tool-calling loop, not free-form generation. Max 3 tool calls per turn, then force a text response.

| Tool | Args | Returns / notes |
|---|---|---|
| `search_doctors` | `specialisation, hospital_id?, date_from?, accepts_emergency?` | Ranked doctors with next available slot |
| `check_availability` | `doctor_id, date_from, date_to` | Free slots. Cache 60 s. |
| `hold_slot` | `doctor_id, start_at` | 5-min hold. Call as soon as intent is clear. |
| `confirm_booking` | `hold_id` | Idempotent. Only after explicit patient confirmation. |
| `cancel_appointment` | `appointment_id, reason` | |
| `reschedule_appointment` | `appointment_id, new_start_at` | Hold new before releasing old |
| `get_patient_context` | `patient_id` | Called once at session start, not per turn |
| `record_symptom_data` | `field, value` | Writes to `voice_sessions.collected_data` |
| `lookup_clinic_info` | `query` | RAG over `clinic_kb`, patient audience |
| `escalate_emergency` | `category, summary, hospital_id` | Creates urgent appointment + pages on-call |
| `list_hospitals` | `city?, has_emergency_dept?` | |
| `transfer_to_human` | `reason` | Creates a callback request |

Every handler must return a compact, speakable result — the LLM will read it aloud. Return
`{"ok": false, "reason": "..."}` on failure rather than raising, so the agent can recover
conversationally.

---

## 13. Integrations

### 13.1 Email (`services/notification.py`)

Transactional outbox only. Booking transactions insert into `email_outbox`; a Celery worker polls
and sends. This guarantees no email for a rolled-back booking and no lost email for a committed one.

Retry: exponential backoff `2^attempts` minutes, jittered, max 5 attempts, then `status='dead'`
plus an admin alert. Idempotency key prevents duplicates on worker restart.

Templates (Jinja2, HTML + plaintext): `booking_confirmation_patient`, `booking_confirmation_doctor`,
`appointment_reminder_24h`, `appointment_reminder_2h`, `appointment_cancelled`,
`appointment_cancelled_doctor_leave`, `appointment_rescheduled`, `medication_reminder`,
`post_visit_summary`, `emergency_alert_doctor`.

Attach an `.ics` file to every confirmation — it is the fallback for patients who never connect
Google Calendar.

### 13.2 Google Calendar (`services/calendar.py`)

- OAuth 2.0 authorization code flow, scope `https://www.googleapis.com/auth/calendar.events`.
- Encrypt refresh tokens with Fernet (`CALENDAR_TOKEN_ENCRYPTION_KEY`). Never log them.
- Set `extendedProperties.private.appointment_id` on every event — this makes reconciliation
  possible without trusting local state.
- Idempotent upsert: look up `calendar_links` first; if `google_event_id` exists, patch, else insert.
- On cancel: delete the event, set `sync_state='deleted'`.
- Calendar is **best-effort**. A Calendar failure must never fail a booking — mark
  `sync_state='failed'`, retry in the background, and still send the `.ics`.
- Handle 401 (token revoked) by clearing the link and prompting the user to reconnect.

### 13.3 Background jobs (`workers/`)

| Job | Schedule | Purpose |
|---|---|---|
| `expire_holds` | every 30 s | Release stale `held` appointments |
| `dispatch_emails` | every 15 s | Drain `email_outbox` |
| `send_medication_reminders` | every 5 min | Due rows in `medication_reminders` |
| `generate_appointment_reminders` | hourly | Queue 24 h and 2 h reminders |
| `generate_pre_visit_summaries` | every 10 min | Any booked appointment lacking one |
| `reindex_clinic_kb` | nightly 02:00 | Re-embed doctors, hours, policies |
| `purge_expired_audio` | daily 03:00 | Delete raw audio past retention |
| `reconcile_calendar` | every 6 h | Fix drifted or failed calendar links |

**Prescription → reminder expansion** (`services/prescription.py`): map frequency codes to
times-of-day using clinic defaults (`OD → [09:00]`, `BD → [09:00, 21:00]`,
`TDS → [08:00, 14:00, 20:00]`, `QID → [08:00, 12:00, 16:00, 20:00]`, `HS → [22:00]`,
`SOS → no reminders`). Expand across `duration_days` in the **patient's** timezone, insert rows,
rely on the unique constraint for idempotency. Never schedule reminders in the past.

---

## 14. REST API surface

```
POST   /api/v1/auth/register            (patient self-service)
POST   /api/v1/auth/login | /refresh | /logout
GET    /api/v1/auth/me

GET    /api/v1/doctors                  ?specialisation&hospital_id&date&q
GET    /api/v1/doctors/{id}
GET    /api/v1/doctors/{id}/availability?date_from&date_to
GET    /api/v1/specialisations
GET    /api/v1/hospitals

POST   /api/v1/appointments/hold
POST   /api/v1/appointments/{id}/confirm
GET    /api/v1/appointments                    (role-scoped)
GET    /api/v1/appointments/{id}
POST   /api/v1/appointments/{id}/cancel
POST   /api/v1/appointments/{id}/reschedule
GET    /api/v1/appointments/{id}/pre-visit-summary     (doctor only)

POST   /api/v1/encounters                      (doctor submits notes + prescriptions)
GET    /api/v1/encounters/{id}
POST   /api/v1/encounters/{id}/generate-summary
POST   /api/v1/summaries/{id}/approve          (doctor; body may contain edits)
POST   /api/v1/summaries/{id}/reject

POST   /api/v1/admin/doctors                   (create profile + credentials)
PATCH  /api/v1/admin/doctors/{id}
PUT    /api/v1/admin/doctors/{id}/working-hours
POST   /api/v1/admin/doctors/{id}/leave        → returns impact preview
POST   /api/v1/admin/doctors/{id}/leave/confirm
GET    /api/v1/admin/metrics                   (voice latency, LLM quota, outbox health)
POST   /api/v1/admin/kb/documents              (upload / re-index)

GET    /api/v1/calendar/connect                → Google consent URL
GET    /api/v1/calendar/callback
DELETE /api/v1/calendar/disconnect

POST   /api/v1/voice/sessions                  → session_id + WS ticket
WS     /ws/voice/{session_id}?ticket=...
GET    /api/v1/voice/sessions/{id}/transcript  (patient owns theirs; doctor sees their patients')
```

Authenticate the WebSocket with a short-lived (60 s) single-use ticket issued by
`POST /voice/sessions`. Do not put JWTs in query strings.


---

## 15. Frontend notes

### Voice widget audio path

Capture with an `AudioWorkletProcessor` (never `ScriptProcessorNode` — it runs on the main thread
and stutters). Resample to 16 kHz in the worklet, emit Int16 frames.

Playback needs a **jitter buffer**: accumulate ~120 ms of audio before starting, then feed an
`AudioBufferSourceNode` chain scheduled on `AudioContext.currentTime`. Naive
`decodeAudioData`-per-chunk playback produces audible gaps between sentences.

Barge-in on the client: when local VAD reports speech while `isAgentSpeaking`, immediately stop the
source node, clear the buffer, and send `{"type":"barge_in"}`. Do not wait for the server.

`AudioContext` must be created inside a user gesture handler or browsers will suspend it.

### UI states to build

Idle / requesting mic / listening (live waveform) / thinking / speaking (caption + stop button) /
emergency (full-width red banner, tap-to-call 108, non-dismissable) / booking confirmed / error with
"switch to typing" fallback.

Always render live captions. It is an accessibility requirement, and it lets patients catch STT
errors ("no, Dr. Mehta, not Dr. Mehra").

### Portals

- **Patient:** register/login, search doctors, book, my appointments, post-visit summaries,
  medication schedule, connect Google Calendar, start voice agent.
- **Doctor:** today's schedule, pre-visit summary panel (urgency chip, chief complaint, the three
  suggested questions, information gaps), submit notes + prescriptions, review/edit/approve
  post-visit summaries, emergency decision-support view with acknowledgement gate, leave requests.
- **Admin:** doctor CRUD, working hours editor, leave with impact preview, hospitals, KB upload and
  reindex, system health (voice latency percentiles, LLM quota consumption per provider, outbox
  backlog, red-flag fire rate).

---

## 16. Build phases

Do not proceed past a phase until its acceptance criteria pass.

### Phase 0 — Foundation
Docker Compose (postgres+pgvector, redis, api, worker, frontend). Alembic baseline with all tables
from §6, extensions enabled, exclusion constraint in place. Auth + RBAC. Seed script: 1 admin,
3 hospitals, 8 doctors across 6 specialisations with working hours, 5 patients.
**Accept:** `docker compose up` yields a working login for all three roles; `alembic upgrade head`
runs clean from empty.

### Phase 1 — Booking core
Availability computation (working hours − leave − existing appointments − buffers). Hold/confirm.
Cancel, reschedule. Leave conflict handling with impact preview.
**Accept:** the 50-way concurrency test in §7.2 passes. Availability never returns a slot that
`hold_slot` then rejects. Marking leave over a booked date produces a correct impact preview and,
on confirm, cancels + queues notifications.

### Phase 2 — Notifications and calendar
Outbox, Celery dispatcher, all templates, `.ics` attachment. Google OAuth + event lifecycle.
**Accept:** booking sends both emails and creates two calendar events; cancelling deletes both;
killing the email worker mid-send loses nothing and sends no duplicates on restart; revoking Google
access degrades to `.ics` without a 500.

### Phase 3 — LLM layer
Router with tiers, buckets, breakers, PHI redaction. Pre-visit and post-visit summaries. Doctor
approval workflow.
**Accept:** with every provider key removed, summary generation writes `state='failed'` and the UI
offers manual entry — nothing 500s. With Groq forced to 429, the router transparently uses Gemini.
Prompt version is recorded on every artifact.

### Phase 4 — RAG
Ingestion, hybrid retrieval, RRF, conditional rerank, audience partitioning. Seed content.
**Accept:** a hand-written 30-query eval set reaches ≥ 0.85 recall@5. A patient-audience query for
"what could be causing my chest pain" returns **zero** `clinical_kb` chunks — verify at the SQL
level, not by reading the model's answer. p50 retrieval under 100 ms.

### Phase 5 — Voice pipeline
WS protocol, orchestrator, STT with grammar constraints, Piper streaming, browser capture/VAD/playback,
barge-in, captions, typed fallback.
**Accept:** end-of-speech → first audio p50 under 1.2 s, p95 under 2.0 s on the target hardware.
Barge-in stops audio within 150 ms. A full routine booking completes by voice alone. Killing the TTS
service degrades to browser `SpeechSynthesis` mid-session without dropping the connection.

### Phase 6 — Safety and emergency
Red-flag matcher + corpus, emergency scripts, escalation, on-call paging, decision-support brief,
output guard.
**Accept:** red-flag recall ≥ 0.98 on the emergency corpus with negation cases passing. A simulated
cardiac utterance interrupts the agent mid-sentence in under 300 ms, shows the banner, creates the
urgent appointment, and pages on-call — **with the LLM provider disabled entirely**. The output
guard blocks a planted diagnostic response.

### Phase 7 — Hardening
Rate limiting, audit log coverage, structured logging with session correlation, admin health
dashboard, audio retention purge, load test (20 concurrent voice sessions), README with runbook.

---

## 17. Environment variables

> When deployed behind a Cloudflare Tunnel (see §3 Hosting), swap `DATABASE_URL` for the Neon
> connection string if you're using Neon, and set `APP_BASE_URL` / `GOOGLE_REDIRECT_URI` to your
> `https://*.trycloudflare.com` or custom tunnel domain — Google OAuth will reject a `localhost`
> redirect URI once the app is reachable from a phone or another machine.

```bash
# Core
DATABASE_URL=postgresql+asyncpg://user:pass@postgres:5432/clinic
# If using Neon instead of self-hosted Postgres:
# DATABASE_URL=postgresql+asyncpg://user:pass@ep-xxxx.neon.tech/clinic?sslmode=require
REDIS_URL=redis://redis:6379/0
JWT_SECRET=
CALENDAR_TOKEN_ENCRYPTION_KEY=          # Fernet key
APP_BASE_URL=http://localhost:5173      # replace with tunnel URL once deployed
CLINIC_NAME="City Care Clinic"
DEFAULT_TIMEZONE=Asia/Kolkata

# LLM providers (at least two recommended; Ollama makes the system self-sufficient)
GROQ_API_KEY=
GROQ_FAST_MODEL=llama-3.1-8b-instant
GROQ_REASON_MODEL=llama-3.3-70b-versatile
GEMINI_API_KEY=
GEMINI_FAST_MODEL=gemini-2.5-flash-lite
GEMINI_REASON_MODEL=gemini-2.5-flash
CEREBRAS_API_KEY=
OLLAMA_BASE_URL=http://host.docker.internal:11434
OLLAMA_FAST_MODEL=qwen3:8b
OLLAMA_REASON_MODEL=qwen3:14b
LLM_REDACT_PHI=true

# Speech
STT_MODEL_SIZE=small                    # small | large-v3-turbo
STT_DEVICE=cpu                          # cpu | cuda
STT_COMPUTE_TYPE=int8                   # int8 | int8_float16
PIPER_MODEL_PATH=/models/en_IN-medium.onnx
PIPER_CONFIG_PATH=/models/en_IN-medium.onnx.json
TTS_FALLBACK=browser_speechsynthesis

# RAG
EMBEDDING_MODEL=BAAI/bge-small-en-v1.5
RERANKER_MODEL=BAAI/bge-reranker-v2-m3
RERANK_SCORE_GAP_THRESHOLD=0.05

# Email
EMAIL_PROVIDER=brevo                    # brevo | smtp
BREVO_API_KEY=
SMTP_HOST= SMTP_PORT= SMTP_USER= SMTP_PASSWORD=
EMAIL_FROM="City Care Clinic <noreply@example.com>"

# Google
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:8000/api/v1/calendar/callback

# Voice / safety
VOICE_SESSION_MAX_MIN=15
SLOT_HOLD_TTL_SECONDS=300
AUDIO_RETENTION_DAYS=7
EMERGENCY_NUMBERS=108,112
MENTAL_HEALTH_HELPLINE=14416
ONCALL_ALERT_EMAILS=
```

---

## 18. Degradation matrix — implement and test every row

| Failure | Behaviour |
|---|---|
| All LLM providers down | Voice agent switches to a scripted decision-tree flow (specialisation menu → doctor → slot). Booking still works. Summaries queue for later generation. |
| LLM returns malformed JSON | One repair attempt → next provider → `state='failed'` + manual entry UI |
| STT unavailable | Prompt the patient to type; the typed path uses the identical agent loop |
| TTS unavailable | Fall back to browser `SpeechSynthesis`; captions always render |
| Redis down | Voice sessions degrade to in-process memory (single worker); REST unaffected |
| Email provider down | Outbox retains and retries; UI shows confirmation regardless |
| Google Calendar down | `sync_state='failed'`, background reconcile, `.ics` still attached |
| Postgres exclusion violation | Clean `SlotUnavailableError`; agent offers alternatives conversationally |
| WebSocket drops mid-session | Client reconnects with the same `session_id`; orchestrator restores `collected_data` from Redis and resumes |
| Red-flag matcher throws | **Fail closed** — treat as a potential emergency, play the generic emergency script, alert on-call. Never swallow this exception. |

---

## 19. Testing requirements

- `test_booking_concurrency.py` — 50 racing holds, exactly one wins (Phase 1 gate)
- `test_red_flags.py` — labelled corpus, recall ≥ 0.98, negation suite (Phase 6 gate)
- `test_rag_isolation.py` — patient audience never retrieves `clinical_kb`; patient A never
  retrieves patient B's `patient_ctx`. Assert on returned chunk ids, not model output.
- `test_llm_router.py` — 429 handling, breaker open/half-open, provider failover, PHI round-trip
- `test_outbox_idempotency.py` — worker crash mid-send produces no duplicate
- `test_leave_conflicts.py` — impact preview matches what confirm actually cancels
- `test_voice_protocol.py` — full session via a fake WS client with recorded audio fixtures
- `test_output_guard.py` — planted diagnostic and prescriptive responses are blocked
- Load: 20 concurrent voice sessions; record p50/p95 per stage

---

## 20. Things that will bite you

1. **Whisper hallucinates confident text on silence.** Always `vad_filter=True`, always drop
   sub-200 ms segments, always check `avg_logprob`.
2. **Free-tier quotas are the real constraint, not compute.** Instrument quota consumption from day
   one and put it on the admin dashboard. You will hit limits during your first demo otherwise.
3. **The exclusion constraint needs `btree_gist`.** Without the extension, the migration fails with
   a confusing operator-class error.
4. **`condition_on_previous_text=True` causes cross-turn hallucination loops** in conversational
   Whisper. Turn it off.
5. **Do not put external API calls inside the booking transaction.** Outbox everything.
6. **Timezones:** store UTC, compute availability in the doctor's clinic timezone, render in the
   patient's. Medication reminders must use the patient's timezone or they fire at 3 a.m.
7. **Gemini's free tier may use prompts for training.** This is why PHI redaction is mandatory
   before any hosted call, not optional.
8. **Piper outputs 22.05 kHz, Whisper wants 16 kHz, and the two must never be conflated.** Resample
   deliberately at each boundary; a mismatch produces chipmunk or slowed-down audio that's confusing
   to debug because it sounds like a codec bug rather than a sample-rate bug.
9. **Barge-in that only stops generation but not the playback buffer** feels broken. Clear both.
10. **Test the emergency path with the LLM disabled.** If it only works when the model is up, it
    does not work.
11. **`getUserMedia` is blocked on plain HTTP for any origin except `localhost`.** The moment you
    demo from a phone or a second machine, the mic silently fails unless you're behind HTTPS. The
    Cloudflare Tunnel in §3 solves this as a side effect — don't try to skip it "for now" and add
    HTTPS later; the voice agent literally cannot be tested off your own dev machine without it.
12. **Google OAuth redirect URIs must be registered exactly.** If you switch from `localhost` to a
    tunnel URL, update the redirect URI both in `GOOGLE_REDIRECT_URI` and in the Google Cloud
    Console credentials screen, or Calendar linking fails with `redirect_uri_mismatch`.
13. **`trycloudflare.com` quick tunnels change URL on every restart.** Fine for solo dev, wrong for
    anything you need a doctor or patient to bookmark. Use a named tunnel with a free Cloudflare
    account (§3) the moment more than one person needs a stable link.

---

## 21. Suggested build order for a demo deadline

If time is short, this order gives a demonstrable system at every checkpoint:

Phase 0 → Phase 1 → Phase 5 (voice, using the scripted fallback flow, no LLM) → Phase 6 (safety)
→ Phase 3 (LLM) → Phase 4 (RAG) → Phase 2 (email/calendar) → Phase 7.

Voice + safety before LLM sounds backwards, but it means your demo never depends on a free-tier
quota holding up, and it forces the degradation paths to be real rather than aspirational.
