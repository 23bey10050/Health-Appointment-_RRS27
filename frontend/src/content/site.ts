/** Marketing copy, FAQs and articles.
 *
 * Single source so the landing page preview and the dedicated /faq and /blog
 * pages can never drift apart.
 */

export interface Faq {
  question: string;
  answer: string;
  category: "Booking" | "Voice assistant" | "Emergencies" | "Privacy" | "Doctors";
}

export const FAQS: Faq[] = [
  {
    category: "Voice assistant",
    question: "How does booking by voice actually work?",
    answer:
      "You describe your problem in your own words, the way you would to a receptionist. The assistant asks a few short follow-up questions about your symptoms, then finds a doctor whose specialisation matches and offers you available times. When you agree to a slot it books it immediately and it appears in your appointments straight away.",
  },
  {
    category: "Voice assistant",
    question: "Do I have to use my voice?",
    answer:
      "No. There is a text box in the same window, and typing goes through exactly the same process as speaking, with the same safety checks. Voice input needs Chrome or Edge; if you are on Firefox or Safari the assistant will tell you and you can type instead.",
  },
  {
    category: "Voice assistant",
    question: "Can the assistant diagnose me or prescribe medication?",
    answer:
      "No, and it is built so it cannot. The assistant gathers your history and books the right appointment. It will not name a condition or suggest a medicine, and any summary it drafts for your doctor is reviewed and approved by that doctor before you ever see it.",
  },
  {
    category: "Emergencies",
    question: "What happens if I describe something serious?",
    answer:
      "Emergency detection runs before the assistant composes any reply, and it does not depend on the AI being available. If you describe something like crushing chest pain spreading to your arm, emergency numbers appear on screen immediately, the on-call doctor is paged, and the assistant asks whether you need an ambulance and takes a callback number.",
  },
  {
    category: "Emergencies",
    question: "Should I use this instead of calling an ambulance?",
    answer:
      "No. If you believe you are facing a life-threatening emergency, call 108 or 112 first. This platform alerts the on-call clinician and prepares your case for them, but it is not a substitute for emergency services.",
  },
  {
    category: "Emergencies",
    question: "How is an emergency booking different from a normal one?",
    answer:
      "An emergency bypasses the normal appointment calendar entirely. Instead of taking a scheduled slot it creates an urgent case at the nearest hospital with an emergency department, pages the on-call doctor, and records whether an ambulance was requested so the responding team knows before they call you back.",
  },
  {
    category: "Booking",
    question: "Can two patients end up with the same appointment slot?",
    answer:
      "No. Double booking is prevented by the database itself with an exclusion constraint, not by application code that could be bypassed under load. If two people request the same slot at the same moment, exactly one succeeds and the other is immediately offered alternatives.",
  },
  {
    category: "Booking",
    question: "What if my doctor goes on leave after I have booked?",
    answer:
      "You are notified automatically and offered alternative slots, including with other doctors in the same specialisation. Clinic staff can see exactly which appointments a leave request would affect before they confirm it, so nobody is cancelled by surprise.",
  },
  {
    category: "Booking",
    question: "Can I cancel or reschedule?",
    answer:
      "Yes, from My Appointments in the patient portal, or by asking the assistant. Cancelling frees the slot for other patients immediately.",
  },
  {
    category: "Privacy",
    question: "Who can see what I tell the assistant?",
    answer:
      "Your transcript is part of your clinical record and is visible to the doctor treating you and to clinic administrators. Every access is written to an audit log. Speech is transcribed by your browser's built-in speech service, which means audio is processed by your browser provider; you can type instead if you would rather it did not.",
  },
  {
    category: "Privacy",
    question: "Is my information sent to AI companies?",
    answer:
      "Identifying details such as your name, phone number and email are replaced with placeholders before anything is sent to a language model, and restored afterwards. The model sees your symptoms, not your identity.",
  },
  {
    category: "Doctors",
    question: "What do doctors see before a visit?",
    answer:
      "A pre-visit summary: the chief complaint, a history of the current problem, relevant medications and allergies, three suggested questions, and an explicit list of information still missing. It is decision support, never a diagnosis, and the doctor can edit or reject it.",
  },
  {
    category: "Doctors",
    question: "How do doctors get told about an emergency?",
    answer:
      "The on-call doctor is paged by email and the case appears at the top of their portal with an acknowledgement gate, so it is clear whether a human has actually seen it. If an ambulance was requested that is shown prominently along with the patient's callback number.",
  },
];

export interface Article {
  slug: string;
  title: string;
  excerpt: string;
  author: string;
  role: string;
  date: string;
  readingMinutes: number;
  tag: string;
  /** Plain paragraphs and "## " headings. Rendered by BlogPost. */
  body: string[];
}

export const ARTICLES: Article[] = [
  {
    slug: "why-we-built-triage-that-does-not-depend-on-ai",
    title: "Why our emergency detection does not depend on AI",
    excerpt:
      "The most important safety decision we made was to keep the emergency check entirely separate from the language model, and to run it first.",
    author: "Dr. Anjali Mehta",
    role: "General Medicine, City Care Clinic",
    date: "2026-08-12",
    readingMinutes: 4,
    tag: "Safety",
    body: [
      "There is an obvious way to build a medical voice assistant: send everything the patient says to a language model and let it decide what matters. It demonstrates well. We deliberately did not do it.",
      "## The problem with asking a model first",
      "A language model can be slow, rate-limited, or simply unavailable. It can also be confidently wrong. None of those are acceptable when a patient has just said the words that should stop the conversation and put an emergency number on the screen.",
      "So the ordering is fixed: every utterance is checked against a deterministic list of red-flag phrases before any model is consulted. That check runs in under five milliseconds and works identically whether every AI provider we use is up or all of them are down.",
      "## Optimising for the right kind of mistake",
      "Any detector makes two kinds of mistake. It can raise an alarm that turns out to be nothing, or it can stay silent when it should have spoken. These are not equally bad, so we do not treat them as equally bad. The phrase list is deliberately broad.",
      "But breadth has its own cost. An assistant that shows an emergency banner every time somebody mentions their chest teaches people to ignore emergency banners, and alarm fatigue is a patient safety problem in its own right.",
      "## Severity, not keywords",
      "So the matcher does not stop at the phrase. It reads the context around it. Chest pain described as sudden, crushing, spreading to the arm, or accompanied by sweating is treated as critical and escalates on the first sentence, before another question is asked.",
      "Chest pain described as mild, once a day, and going on for months is treated as urgent rather than critical. The assistant does not raise a banner; it asks focused questions about how acute it is. If an answer reveals acuity, it escalates immediately.",
      "That distinction is why an assistant can ask a follow-up question without being reckless, and raise an alarm without crying wolf.",
    ],
  },
  {
    slug: "what-actually-happens-when-you-book-by-voice",
    title: "What actually happens when you book an appointment by voice",
    excerpt:
      "A walkthrough of the steps between describing your symptoms and a confirmed slot, including the parts most patients never see.",
    author: "Priya Raghavan",
    role: "Clinic Operations",
    date: "2026-08-05",
    readingMinutes: 5,
    tag: "Product",
    body: [
      "Most people expect a voice booking system to be a phone menu with better manners. This one works differently, and the difference is mostly in what happens after you stop talking.",
      "## You describe the problem, not the appointment type",
      "You do not need to know whether you want Cardiology or General Medicine. You say your chest feels tight when you climb stairs, and the routing happens behind the scenes based on your symptoms and the specialisations the clinic actually staffs.",
      "## A few short questions, then booking",
      "The assistant asks about the main symptom, when it started and how it has changed, and anything that makes it better or worse. It asks one thing at a time, because a list of five questions at once is how you get one answer and four silences.",
      "It stops asking once it has enough for the doctor to prepare, and moves on to finding you a slot. That limit is enforced by the system rather than left to the assistant's judgement, so the conversation always progresses.",
      "## The slot is real the moment you agree",
      "When you say yes to a time, the appointment is confirmed in that single step. Nothing is left pending, and there is no window in which you believe you have an appointment but the clinic does not.",
      "Underneath, the database refuses to let two appointments overlap for the same doctor. If somebody else takes the slot in the same second, you are told immediately and offered the next options rather than discovering the clash on the day.",
      "## What your doctor sees",
      "Before your visit, your doctor gets a short summary drawn from the conversation: your chief complaint, how the problem has developed, your known allergies and medications, and a list of what is still unknown. They can edit it or throw it away. Nothing drafted about you reaches you without a clinician approving it first.",
    ],
  },
  {
    slug: "designing-for-the-patient-who-is-frightened",
    title: "Designing for the patient who is frightened",
    excerpt:
      "Interface decisions change when you assume the person using it is scared, in pain, or holding a phone in one hand.",
    author: "Karan Malhotra",
    role: "Product Design",
    date: "2026-07-28",
    readingMinutes: 3,
    tag: "Design",
    body: [
      "Most healthcare software is designed as though the user is calm, seated, and reading carefully. Sometimes they are. Often they are not.",
      "## Emergency information does not wait its turn",
      "When the system detects something critical, the emergency numbers are not placed in a notification that can be dismissed or scrolled past. They take the full width of the screen, they are tappable to dial, and they stay there. The assistant keeps talking, but nothing it says can hide them.",
      "## Every reply is written down",
      "Spoken replies disappear. If you looked away, or your phone rang, or the browser could not speak, the words are gone. So the assistant keeps a written transcript of the whole conversation on screen, and it persists after the assistant stops speaking.",
      "This is an accessibility requirement, but it is also a plain usability one. It lets you catch a mistake in what was heard, which matters when the difference is between two doctors with similar names.",
      "## Typing is not a fallback",
      "The text box sits in the interface at all times, not hidden behind a link labelled something like 'having trouble?'. People type because they are in a waiting room, because English is their second language and they want to be sure, or because they simply prefer it. None of those are failures that need a fallback.",
    ],
  },
];

export const FEATURES = [
  {
    title: "Book by talking",
    body: "Describe the problem in your own words. The assistant asks a few short questions, matches you to the right specialisation, and confirms a real slot.",
  },
  {
    title: "Emergency detection that always runs",
    body: "Red-flag phrases are checked before any AI is involved, so escalation works even when every model provider is unavailable.",
  },
  {
    title: "No double bookings, ever",
    body: "Slot conflicts are prevented by a database constraint rather than application logic, so two patients cannot hold the same time.",
  },
  {
    title: "Prepared doctors",
    body: "Clinicians get a pre-visit summary with the chief complaint, history, suggested questions and explicit information gaps.",
  },
  {
    title: "Leave without chaos",
    body: "Staff see exactly which appointments a leave request affects before confirming, and affected patients are offered alternatives automatically.",
  },
  {
    title: "Auditable by design",
    body: "Logins, record access and clinical approvals are written to an audit log, and identifying details are masked before any AI call.",
  },
];

export const STEPS = [
  {
    title: "Describe the problem",
    body: "Speak or type. No forms, no dropdown of specialisations you would have to guess at.",
  },
  {
    title: "Answer a few questions",
    body: "Short, one at a time, about onset and severity. Enough for the doctor to prepare, not an interrogation.",
  },
  {
    title: "Confirm your slot",
    body: "Pick a time that works. It is booked the moment you agree and appears in your appointments immediately.",
  },
];
