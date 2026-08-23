import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { HelpCircle } from "lucide-react";
import { PublicShell } from "@/components/layout/PublicShell";
import { FAQS, type Faq } from "@/content/site";

const CATEGORIES: Array<Faq["category"] | "All"> = [
  "All",
  "Voice assistant",
  "Booking",
  "Emergencies",
  "Privacy",
  "Doctors",
];

export default function FAQ() {
  const [active, setActive] = useState<(typeof CATEGORIES)[number]>("All");

  const visible = useMemo(
    () => (active === "All" ? FAQS : FAQS.filter((f) => f.category === active)),
    [active]
  );

  return (
    <PublicShell>
      <div className="mx-auto max-w-4xl px-4 py-16">
        <div className="animate-slide-up">
          <div className="flex items-center gap-3">
            <HelpCircle className="h-7 w-7 text-brand-600" />
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">Frequently asked questions</h1>
          </div>
          <p className="mt-3 text-slate-600">
            How booking works, what happens in an emergency, and what we do with what you tell us.
          </p>
        </div>

        <div className="mt-8 flex flex-wrap gap-2">
          {CATEGORIES.map((category) => (
            <button
              key={category}
              onClick={() => setActive(category)}
              className={`rounded-full px-4 py-2 text-sm font-medium transition-colors ${
                active === category
                  ? "bg-brand-600 text-white shadow-sm"
                  : "border border-slate-300 bg-white/70 text-slate-700 hover:bg-white"
              }`}
            >
              {category}
            </button>
          ))}
        </div>

        <div className="mt-8 space-y-3">
          {visible.map((faq) => (
            <details key={faq.question} className="glass-card p-5">
              <summary className="cursor-pointer list-none font-semibold text-slate-900 outline-none">
                {faq.question}
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-slate-600">{faq.answer}</p>
            </details>
          ))}
        </div>

        <div className="glass-card mt-12 p-6">
          <p className="font-semibold text-slate-900">Still need help?</p>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            Start a session with the assistant and ask it directly &mdash; it can answer questions
            about clinic policy, fees and preparation, and hand you to clinic staff if it cannot.
          </p>
          <Link
            to="/login/patient"
            className="mt-4 inline-block rounded-full bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
          >
            Sign in to ask
          </Link>
        </div>
      </div>
    </PublicShell>
  );
}
