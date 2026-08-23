import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Activity, ArrowLeft, Stethoscope, UserCog, UserRound } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import type { UserRole } from "@/lib/types";

const ROLE_UI: Record<UserRole, { label: string; icon: typeof UserRound; blurb: string; accent: string }> = {
  patient: {
    label: "Patient",
    icon: UserRound,
    blurb: "Book appointments, talk to the assistant, and review your visit summaries.",
    accent: "text-brand-600 bg-brand-50",
  },
  doctor: {
    label: "Doctor",
    icon: Stethoscope,
    blurb: "Today's schedule, pre-visit summaries, and the emergency queue.",
    accent: "text-emerald-600 bg-emerald-50",
  },
  admin: {
    label: "Administrator",
    icon: UserCog,
    blurb: "Doctors, hospitals, leave, the knowledge base and system health.",
    accent: "text-indigo-600 bg-indigo-50",
  },
};

function isRole(value: string | undefined): value is UserRole {
  return value === "patient" || value === "doctor" || value === "admin";
}

export default function Login() {
  const { role: roleParam } = useParams<{ role?: string }>();
  // /login/:role only changes the framing. The redirect after sign-in always
  // follows the account's real role, so entering by the "wrong" door still lands
  // you in the right portal rather than showing a confusing permission error.
  const role: UserRole | null = isRole(roleParam) ? roleParam : null;
  const ui = role ? ROLE_UI[role] : null;
  const Icon = ui?.icon ?? Activity;

  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const user = await login(email, password);
      navigate(`/${user.role}`, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-12">
      <Link to="/" className="mb-8 inline-flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-slate-900">
        <ArrowLeft className="h-4 w-4" />
        Back to City Care Clinic
      </Link>

      <div className="glass-panel w-full max-w-md p-8 animate-slide-up">
        <div className={`w-fit rounded-2xl p-3 ${ui?.accent ?? "text-brand-600 bg-brand-50"}`}>
          <Icon className="h-7 w-7" />
        </div>

        <h1 className="mt-5 text-2xl font-bold tracking-tight text-slate-900">
          {ui ? `${ui.label} sign in` : "Sign in"}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          {ui?.blurb ?? "Access your City Care Clinic portal."}
        </p>

        <form onSubmit={handleSubmit} className="mt-7 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white/80 px-3 py-2.5 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 bg-white/80 px-3 py-2.5 text-sm outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20"
            />
          </div>

          {error && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-emergency-700">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-full bg-brand-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-brand-500/25 transition-all hover:bg-brand-700 disabled:opacity-60"
          >
            {submitting ? "Signing in..." : "Sign in"}
          </button>
        </form>

        {role !== "patient" && (
          <p className="mt-6 text-center text-xs text-slate-500">
            Doctor and administrator accounts are created by clinic staff.
          </p>
        )}

        {role === "patient" && (
          <p className="mt-6 text-center text-sm text-slate-600">
            New patient?{" "}
            <Link to="/register" className="font-semibold text-brand-700 hover:underline">
              Create an account
            </Link>
          </p>
        )}
      </div>

      <div className="mt-6 flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm text-slate-500">
        {(Object.keys(ROLE_UI) as UserRole[])
          .filter((r) => r !== role)
          .map((r) => (
            <Link key={r} to={`/login/${r}`} className="hover:text-brand-700">
              {ROLE_UI[r].label} sign in
            </Link>
          ))}
      </div>
    </div>
  );
}
