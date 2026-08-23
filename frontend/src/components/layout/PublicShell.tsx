import { useState, type ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { Activity, Menu, X } from "lucide-react";

const NAV = [
  { to: "/", label: "Home", end: true },
  { to: "/faq", label: "FAQ", end: false },
  { to: "/blog", label: "Insights", end: false },
];

/** Chrome for the signed-out marketing pages. PortalShell stays the signed-in
 * chrome -- the two are deliberately separate so the public site never renders
 * a Sign out button or a portal-role badge. */
export function PublicShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-40 border-b border-white/50 bg-white/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link to="/" className="flex items-center gap-2">
            <Activity className="h-6 w-6 text-brand-600" strokeWidth={2.5} />
            <span className="text-lg font-bold tracking-tight text-slate-900">City Care Clinic</span>
          </Link>

          <nav className="hidden items-center gap-1 md:flex">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    isActive ? "text-brand-700 bg-brand-50" : "text-slate-600 hover:text-slate-900 hover:bg-white/60"
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
            <Link
              to="/login/patient"
              className="ml-2 rounded-full bg-brand-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-700"
            >
              Sign in
            </Link>
          </nav>

          <button
            onClick={() => setOpen((v) => !v)}
            className="rounded-lg p-2 text-slate-600 hover:bg-white/60 md:hidden"
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
          >
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>

        {open && (
          <nav className="border-t border-white/50 bg-white/80 px-4 py-3 md:hidden">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                onClick={() => setOpen(false)}
                className="block rounded-lg px-3 py-2 text-sm font-medium text-slate-700 hover:bg-white"
              >
                {item.label}
              </NavLink>
            ))}
            <Link
              to="/login/patient"
              onClick={() => setOpen(false)}
              className="mt-2 block rounded-lg bg-brand-600 px-3 py-2 text-center text-sm font-semibold text-white"
            >
              Sign in
            </Link>
          </nav>
        )}
      </header>

      {/* Scrim over the global background photo. The signed-in portals put all
          their content inside glass cards, so the photo never sits behind raw
          text there. Marketing copy does sit directly on it, and long paragraphs
          over a busy image are simply hard to read -- this keeps the photo as
          texture while making body text legible. */}
      <main className="flex-1 bg-gradient-to-b from-white/90 via-white/80 to-white/90">{children}</main>

      <footer className="border-t border-white/50 bg-white/60 backdrop-blur-xl">
        <div className="mx-auto max-w-6xl px-4 py-10">
          <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <div className="flex items-center gap-2">
                <Activity className="h-5 w-5 text-brand-600" strokeWidth={2.5} />
                <span className="font-bold text-slate-900">City Care Clinic</span>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-slate-600">
                Voice-led appointment booking with clinician-reviewed summaries and emergency
                escalation that runs independently of AI availability.
              </p>
            </div>

            <div>
              <p className="text-sm font-semibold text-slate-900">Platform</p>
              <ul className="mt-3 space-y-2 text-sm text-slate-600">
                <li><Link to="/faq" className="hover:text-brand-700">Frequently asked questions</Link></li>
                <li><Link to="/blog" className="hover:text-brand-700">Insights</Link></li>
                <li><Link to="/register" className="hover:text-brand-700">Create a patient account</Link></li>
              </ul>
            </div>

            <div>
              <p className="text-sm font-semibold text-slate-900">Portals</p>
              <ul className="mt-3 space-y-2 text-sm text-slate-600">
                <li><Link to="/login/patient" className="hover:text-brand-700">Patient sign in</Link></li>
                <li><Link to="/login/doctor" className="hover:text-brand-700">Doctor sign in</Link></li>
                <li><Link to="/login/admin" className="hover:text-brand-700">Administrator sign in</Link></li>
              </ul>
            </div>

            <div>
              <p className="text-sm font-semibold text-emergency-700">In an emergency</p>
              <p className="mt-3 text-sm leading-relaxed text-slate-600">
                Do not use this platform to summon urgent help. Call an ambulance directly.
              </p>
              <p className="mt-2 text-sm font-semibold text-slate-900">Ambulance 108 &middot; Emergency 112</p>
              <p className="mt-1 text-sm text-slate-600">Tele-MANAS 14416</p>
            </div>
          </div>

          <div className="mt-8 border-t border-slate-200 pt-6 text-xs text-slate-500">
            <p>
              This platform supports clinical care; it does not replace it. The assistant does not
              diagnose conditions or recommend medication, and any summary it drafts is reviewed by a
              clinician before it reaches a patient.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
