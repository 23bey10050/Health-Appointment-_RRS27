# City Care Clinic — Presentation Brief

**Instructions for the slide generator:** Build a 6-slide deck from the content
below. One slide per `## Slide N` heading. Use the speaker notes as the notes
field. Style: clean, professional, healthcare/enterprise. Blue primary
(#2563EB), red only for emergency content (#DC2626). Use icons, not emoji.
Do not add slides beyond these six.

---

## Slide 1 — Title

**Title:** City Care Clinic
**Subtitle:** Voice-led appointment booking with built-in emergency triage

**Supporting line:** A patient describes how they feel in plain words. The
system asks a few questions, routes them to the right specialisation, and books
a real appointment — or, if the symptoms are serious, stops booking and
escalates instead.

**Stat strip (4 items):**
- 3 portals — Patient, Doctor, Administrator
- 14 emergency categories detected without AI
- 157 automated tests
- Runs entirely on free-tier infrastructure

**Speaker notes:** This is a full-stack clinic platform, not a chatbot demo.
The distinctive part is that safety-critical triage does not depend on the AI
model being available — it runs first, and deterministically.

---

## Slide 2 — The Problem

**Title:** Booking an appointment asks patients the wrong questions

**Three problem cards:**

1. **Patients must self-diagnose to book**
   Booking forms ask for a specialisation. A patient with chest tightness on
   the stairs does not know whether that is Cardiology or General Medicine.

2. **Urgency is discovered too late**
   A form treats "mild cough for a week" and "crushing chest pain right now"
   identically — both become a slot next Tuesday.

3. **Doctors walk in unprepared**
   The reason-for-visit box says "not feeling well". History-taking starts from
   zero, inside a 20-minute appointment.

**Speaker notes:** These are not UI problems, they are triage problems. The
booking step is the first point where urgency could be caught, and traditional
forms throw that information away.

---

## Slide 3 — How It Works

**Title:** From "my chest feels tight" to a confirmed appointment

**Flow diagram — 5 steps left to right:**

1. **Speak or type** — Browser speech recognition; typing works identically
2. **Safety check** — Deterministic red-flag match, under 5 ms, before any AI
3. **Three-tier triage** — Critical / Urgent / Routine decides what happens next
4. **Short intake** — Up to 3 focused questions, one at a time
5. **Confirmed booking** — Slot reserved atomically and visible immediately

**Branch callout (red, from step 3):**
**Critical → Emergency path.** Emergency numbers on screen instantly, on-call
doctor paged by email, ambulance need recorded, urgent case created at the
nearest hospital with an emergency department. The conversation stays open.

**Speaker notes:** Step 2 is the important one. The red-flag matcher is a phrase
list with negation handling, not a model call, so it works even when every AI
provider is rate-limited or down.

---

## Slide 4 — Three Portals

**Title:** One platform, three separate experiences

**Three columns:**

**Patient**
- Book by voice or by typing
- View, cancel and reschedule appointments
- Read visit summaries after a doctor approves them
- Medication schedule and reminders
- Connect Google Calendar

**Doctor**
- Today's schedule and upcoming appointments
- Pre-visit summary: chief complaint, history, three suggested questions,
  information gaps
- Record clinical notes and prescriptions
- Review, edit or reject AI-drafted patient summaries
- Emergency queue with an acknowledgement gate
- Request leave with an impact preview

**Administrator**
- Doctor accounts and working-hours editor
- Hospital management
- Leave approval showing exactly which appointments are affected
- Knowledge base upload and re-indexing
- System health: voice latency, LLM quota per provider, email backlog,
  red-flag fire rate

**Speaker notes:** Each portal has its own sign-in entrance from the landing
page. Role is enforced server-side on every request, not just hidden in the UI.

---

## Slide 5 — Safety and Engineering

**Title:** The decisions that matter are not left to the model

**Six points, two columns:**

**Emergency detection runs first**
Phrase matching with negation handling, before any AI call. "The chest pain
stopped yesterday" does not trigger; "crushing chest pain radiating to my arm"
does, on the first sentence.

**Three severity tiers, not keywords**
"Chest pain once a day for months" is urgent, not critical — it gets questions,
not an alarm. Constant false alarms teach people to ignore real ones.

**The database prevents double booking**
A Postgres exclusion constraint, not application logic. Verified by a test that
races 50 concurrent requests for one slot: exactly one wins.

**The AI never diagnoses**
An output guard blocks diagnostic and prescriptive language. No AI-written
clinical content reaches a patient without a doctor approving it.

**Identity is masked before AI calls**
Names, phone numbers and emails are replaced with placeholders and restored
afterwards. The model sees symptoms, not people.

**Graceful degradation everywhere**
Four AI providers with automatic failover and circuit breakers. If all fail,
emergency handling and booking still work.

**Speaker notes:** Anything a responder acts on — ambulance requested, callback
number, emergency escalation — is captured deterministically in code, because
it cannot depend on a model choosing to call a tool.

---

## Slide 6 — Architecture and Getting Started

**Title:** Built to run anywhere, including free tiers

**Left — Technology stack:**
- **Frontend:** React 18, TypeScript, Tailwind CSS, Vite
- **Backend:** FastAPI, Python 3.11, async SQLAlchemy
- **Database:** PostgreSQL with pgvector
- **Voice:** Browser Web Speech API (recognition and synthesis)
- **AI:** Groq, Gemini, Cerebras and Ollama behind one router
- **Search:** Hybrid semantic + keyword retrieval over 115 knowledge chunks

**Right — Run it in four steps:**
1. `cp .env.example .env` and add one AI provider key
2. `docker compose up -d`
3. `bash deploy/setup-database.sh '<database-url>'`
4. Open `http://localhost:5173`

**Demo logins** (password `DevPass123!`):
- Patient: `aditya.sharma@example.com`
- Doctor: `anjali.mehta@citycare.example`
- Admin: `admin@citycare.example`

**Deployment note:** Deploys to Render and Neon on free tiers. Scheduled jobs
run through GitHub Actions because free tiers do not offer background workers.

**Speaker notes:** Moving speech into the browser removed about 1 GB of model
weights from the server image, which is what makes free-tier hosting viable.
Full instructions are in deploy/README.md.
