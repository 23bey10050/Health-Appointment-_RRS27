import { Link } from "react-router-dom";
import { EmergencyQueuePanel } from "@/components/emergency/EmergencyQueuePanel";
import { PortalShell } from "@/components/layout/PortalShell";
import { useAuth } from "@/lib/auth";
import { Calendar, UserMinus, Settings } from "lucide-react";

export default function DoctorDashboard() {
  const { user } = useAuth();

  return (
    <PortalShell>
      <div className="animate-slide-up">
        <h1 className="text-3xl font-bold text-slate-800 tracking-tight">
          Welcome, Dr. {user?.full_name}
        </h1>
        <p className="mt-2 text-slate-500 font-medium">
          Manage your schedule and respond to urgent requests.
        </p>

        <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4">
          <Link to="/doctor/schedule" className="glass-card p-6 flex flex-col items-center justify-center text-center gap-3 group">
            <div className="p-4 rounded-full bg-brand-100 text-brand-600 group-hover:bg-brand-600 group-hover:text-white transition-colors duration-300">
              <Calendar className="w-8 h-8" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-800">View Schedule</h2>
              <p className="text-sm text-slate-500 mt-1">Manage today's appointments</p>
            </div>
          </Link>
          
          <Link to="/doctor/leave" className="glass-card p-6 flex flex-col items-center justify-center text-center gap-3 group">
            <div className="p-4 rounded-full bg-orange-100 text-orange-600 group-hover:bg-orange-600 group-hover:text-white transition-colors duration-300">
              <UserMinus className="w-8 h-8" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-800">Request Leave</h2>
              <p className="text-sm text-slate-500 mt-1">Submit time-off requests</p>
            </div>
          </Link>

          <Link to="/settings" className="glass-card p-6 flex flex-col items-center justify-center text-center gap-3 group">
            <div className="p-4 rounded-full bg-slate-100 text-slate-600 group-hover:bg-slate-800 group-hover:text-white transition-colors duration-300">
              <Settings className="w-8 h-8" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-800">Settings</h2>
              <p className="text-sm text-slate-500 mt-1">Update your profile</p>
            </div>
          </Link>
        </div>

        <div className="mt-8">
          <div className="glass-card p-6 border-l-4 border-l-emergency-600">
            <h2 className="text-xl font-bold text-slate-800 mb-4 flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-emergency-600 animate-ping"></div>
              Emergency Queue
            </h2>
            <EmergencyQueuePanel />
          </div>
        </div>
      </div>
    </PortalShell>
  );
}
