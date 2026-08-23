import { Link } from "react-router-dom";
import { PortalShell } from "@/components/layout/PortalShell";
import { VoiceAgent } from "@/components/voice/VoiceAgent";
import { useAuth } from "@/lib/auth";
import { CalendarPlus, CalendarDays } from "lucide-react";

export default function PatientDashboard() {
  const { user } = useAuth();

  return (
    <PortalShell>
      <div className="animate-slide-up">
        <h1 className="text-3xl font-bold text-slate-800 tracking-tight">
          Welcome, {user?.full_name}
        </h1>
        <p className="mt-2 text-slate-500 font-medium">
          Manage your healthcare or talk to the intelligent voice assistant below.
        </p>

        <div className="mt-8 grid grid-cols-1 md:grid-cols-2 gap-4">
          <Link
            to="/patient/book"
            className="glass-card p-6 flex items-center gap-4 group"
          >
            <div className="p-3 rounded-full bg-brand-100 text-brand-600 group-hover:bg-brand-600 group-hover:text-white transition-colors duration-300">
              <CalendarPlus className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-800">Book an appointment</h2>
              <p className="text-sm text-slate-500">Find a doctor and schedule a visit</p>
            </div>
          </Link>

          <Link
            to="/patient/appointments"
            className="glass-card p-6 flex items-center gap-4 group"
          >
            <div className="p-3 rounded-full bg-slate-100 text-slate-600 group-hover:bg-slate-800 group-hover:text-white transition-colors duration-300">
              <CalendarDays className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-800">My appointments</h2>
              <p className="text-sm text-slate-500">View and manage your schedule</p>
            </div>
          </Link>
        </div>

        {user && (
          <div className="mt-8">
            <VoiceAgent patientId={user.id} />
          </div>
        )}
      </div>
    </PortalShell>
  );
}
