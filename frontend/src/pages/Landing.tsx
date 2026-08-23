import { Link } from "react-router-dom";
import {
  AlarmSmoke,
  ArrowRight,
  CalendarCheck,
  ClipboardList,
  Database,
  Mic,
  Phone,
  ShieldCheck,
  Stethoscope,
  UserCog,
  UserRound,
} from "lucide-react";
import { PublicShell } from "@/components/layout/PublicShell";
import { ARTICLES, FAQS, FEATURES, STEPS } from "@/content/site";

const FEATURE_ICONS = [Mic, AlarmSmoke, Database, ClipboardList, CalendarCheck, ShieldCheck];

const PORTALS = [
  {
    to: "/login/patient",
    icon: UserRound,
    name: "Patient",
    tagline: "Book, reschedule and review your visits",
    points: ["Book by voice or text", "See visit summaries", "Manage your medication schedule"],
    accent: "text-brand-600 bg-brand-50 group-hover:bg-brand-600",
    cta: "Sign in as a patient",
  },
  {
    to: "/login/doctor",
    icon: Stethoscope,
    name: "Doctor",
    tagline: "Your schedule, prepared before each visit",
    points: ["Pre-visit summaries", "Record notes and prescriptions", "Emergency queue with acknowledgement"],
    accent: "text-emerald-600 bg-emerald-50 group-hover:bg-emerald-600",
    cta: "Sign in as a doctor",
  },
  {
    to: "/login/admin",
    icon: UserCog,
    name: "Administrator",
    tagline: "Run the clinic and watch the platform",
    points: ["Doctors, hospitals and working hours", "Leave with impact preview", "System health and knowledge base"],
    accent: "text-indigo-600 bg-indigo-50 group-hover:bg-indigo-600",
    cta: "Sign in as an administrator",
  },
];

export default function Landing() {
  return (
    <PublicShell>
      {/* Hero */}
      <section className="mx-auto max-w-6xl px-4 pb-16 pt-16 sm:pt-24">
        <div className="animate-slide-up max-w-3xl">
          <span className="inline-flex items-center gap-2 rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-brand-700">
            <Mic className="h-3.5 w-3.5" />
            Voice-led appointment booking
          </span>
          <h1 className="mt-6 text-4xl font-bold leading-tight tracking-tight text-slate-900 sm:text-5xl">
            Describe how you feel.
            <br />
            We will find the right doctor and book the time.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-slate-600">
            City Care Clinic replaces the appointment form with a conversation. Tell the assistant
            what is wrong in your own words &mdash; it asks a few short questions, matches you to the
            right specialisation, and confirms a real slot. If what you describe sounds like an
            emergency, it stops booking and gets you help instead.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              to="/register"
              className="inline-flex items-center gap-2 rounded-full bg-brand-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-brand-500/25 transition-all hover:bg-brand-700 hover:scale-[1.02]"
            >
              Create a patient account
              <ArrowRight className="h-4 w-4" />
            </Link>
            <a
              href="#portals"
              className="inline-flex items-center gap-2 rounded-full border border-slate-300 bg-white/70 px-6 py-3 text-sm font-semibold text-slate-700 transition-colors hover:bg-white"
            >
              Sign in to a portal
            </a>
          </div>
        </div>
      </section>

      {/* Emergency notice -- deliberately high on the page, not buried in the footer. */}
      <section className="mx-auto max-w-6xl px-4 pb-16">
        <div className="flex flex-col gap-4 rounded-2xl border-2 border-emergency-600/30 bg-red-50/80 p-6 backdrop-blur-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="rounded-xl bg-emergency-600 p-3 text-white">
              <Phone className="h-6 w-6" />
            </div>
            <div>
              <p className="text-lg font-bold text-slate-900">Facing an emergency right now?</p>
              <p className="mt-1 text-sm leading-relaxed text-slate-700">
                Do not wait for an assistant. Call an ambulance directly &mdash; this platform alerts
                the on-call clinician, but it is not an emergency service.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 gap-3">
            <a href="tel:108" className="rounded-xl bg-emergency-600 px-5 py-3 text-center font-bold text-white shadow-sm hover:bg-emergency-700">
              Call 108
            </a>
            <a href="tel:112" className="rounded-xl border-2 border-emergency-600 px-5 py-3 text-center font-bold text-emergency-700 hover:bg-white">
              Call 112
            </a>
          </div>
        </div>
      </section>

      {/* Portals */}
      <section id="portals" className="mx-auto max-w-6xl scroll-mt-20 px-4 pb-20">
        <h2 className="text-2xl font-bold tracking-tight text-slate-900">Choose your portal</h2>
        <p className="mt-2 text-slate-600">Three separate experiences, one platform.</p>

        <div className="mt-8 grid gap-6 md:grid-cols-3">
          {PORTALS.map((portal) => {
            const Icon = portal.icon;
            return (
              <Link key={portal.to} to={portal.to} className="glass-card group flex flex-col p-7">
                <div className={`w-fit rounded-2xl p-4 transition-colors duration-300 group-hover:text-white ${portal.accent}`}>
                  <Icon className="h-7 w-7" />
                </div>
                <h3 className="mt-5 text-xl font-bold text-slate-900">{portal.name}</h3>
                <p className="mt-1 text-sm text-slate-600">{portal.tagline}</p>
                <ul className="mt-5 flex-1 space-y-2">
                  {portal.points.map((point) => (
                    <li key={point} className="flex items-start gap-2 text-sm text-slate-600">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />
                      {point}
                    </li>
                  ))}
                </ul>
                <span className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-brand-700">
                  {portal.cta}
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                </span>
              </Link>
            );
          })}
        </div>
      </section>

      {/* How it works */}
      <section className="border-y border-white/50 bg-white/50 backdrop-blur-sm">
        <div className="mx-auto max-w-6xl px-4 py-16">
          <h2 className="text-2xl font-bold tracking-tight text-slate-900">How booking works</h2>
          <div className="mt-10 grid gap-8 md:grid-cols-3">
            {STEPS.map((step, i) => (
              <div key={step.title} className="relative">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-600 text-sm font-bold text-white">
                  {i + 1}
                </div>
                <h3 className="mt-4 text-lg font-semibold text-slate-900">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto max-w-6xl px-4 py-20">
        <h2 className="text-2xl font-bold tracking-tight text-slate-900">Built for clinics that cannot afford mistakes</h2>
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature, i) => {
            const Icon = FEATURE_ICONS[i % FEATURE_ICONS.length];
            return (
              <div key={feature.title} className="glass-card p-6">
                <Icon className="h-6 w-6 text-brand-600" />
                <h3 className="mt-4 font-semibold text-slate-900">{feature.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{feature.body}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* FAQ preview */}
      <section className="border-y border-white/50 bg-white/50 backdrop-blur-sm">
        <div className="mx-auto max-w-4xl px-4 py-16">
          <div className="flex items-end justify-between gap-4">
            <h2 className="text-2xl font-bold tracking-tight text-slate-900">Common questions</h2>
            <Link to="/faq" className="shrink-0 text-sm font-semibold text-brand-700 hover:underline">
              See all
            </Link>
          </div>
          <div className="mt-8 space-y-3">
            {FAQS.slice(0, 4).map((faq) => (
              <details key={faq.question} className="glass-card group p-5">
                <summary className="cursor-pointer list-none font-semibold text-slate-900 outline-none">
                  {faq.question}
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-slate-600">{faq.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Insights preview */}
      <section className="mx-auto max-w-6xl px-4 py-20">
        <div className="flex items-end justify-between gap-4">
          <h2 className="text-2xl font-bold tracking-tight text-slate-900">Insights</h2>
          <Link to="/blog" className="shrink-0 text-sm font-semibold text-brand-700 hover:underline">
            All articles
          </Link>
        </div>
        <div className="mt-8 grid gap-6 md:grid-cols-3">
          {ARTICLES.map((article) => (
            <Link key={article.slug} to={`/blog/${article.slug}`} className="glass-card group flex flex-col p-6">
              <span className="w-fit rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
                {article.tag}
              </span>
              <h3 className="mt-4 font-semibold leading-snug text-slate-900 group-hover:text-brand-700">
                {article.title}
              </h3>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-slate-600">{article.excerpt}</p>
              <p className="mt-4 text-xs text-slate-500">
                {article.author} &middot; {article.readingMinutes} min read
              </p>
            </Link>
          ))}
        </div>
      </section>
    </PublicShell>
  );
}
