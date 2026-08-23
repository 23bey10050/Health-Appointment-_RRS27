import { Link } from "react-router-dom";
import { HealthDashboard } from "@/components/admin/HealthDashboard";
import { EmergencyQueuePanel } from "@/components/emergency/EmergencyQueuePanel";
import { PortalShell } from "@/components/layout/PortalShell";
import { useAuth } from "@/lib/auth";
import { Users, Building2, BookOpen, Settings, ActivitySquare } from "lucide-react";

export default function AdminDashboard() {
  const { user } = useAuth();

  return (
    <PortalShell>
      <div className="animate-slide-up space-y-8">
        <div>
          <h1 className="text-3xl font-bold text-slate-800 tracking-tight">
            System Administration
          </h1>
          <p className="mt-2 text-slate-500 font-medium">
            Welcome back, {user?.full_name}. Manage platform resources and monitor system health.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Link to="/admin/doctors" className="glass-card p-6 flex flex-col gap-3 group">
            <div className="flex items-center justify-between">
              <div className="p-3 rounded-xl bg-brand-100 text-brand-600 group-hover:bg-brand-600 group-hover:text-white transition-colors">
                <Users className="w-6 h-6" />
              </div>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-800">Doctors</h2>
              <p className="text-sm text-slate-500 mt-1">Manage personnel</p>
            </div>
          </Link>

          <Link to="/admin/hospitals" className="glass-card p-6 flex flex-col gap-3 group">
            <div className="flex items-center justify-between">
              <div className="p-3 rounded-xl bg-indigo-100 text-indigo-600 group-hover:bg-indigo-600 group-hover:text-white transition-colors">
                <Building2 className="w-6 h-6" />
              </div>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-800">Hospitals</h2>
              <p className="text-sm text-slate-500 mt-1">Manage facilities</p>
            </div>
          </Link>

          <Link to="/admin/kb" className="glass-card p-6 flex flex-col gap-3 group">
            <div className="flex items-center justify-between">
              <div className="p-3 rounded-xl bg-emerald-100 text-emerald-600 group-hover:bg-emerald-600 group-hover:text-white transition-colors">
                <BookOpen className="w-6 h-6" />
              </div>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-800">Knowledge Base</h2>
              <p className="text-sm text-slate-500 mt-1">AI training data</p>
            </div>
          </Link>

          <Link to="/settings" className="glass-card p-6 flex flex-col gap-3 group">
            <div className="flex items-center justify-between">
              <div className="p-3 rounded-xl bg-slate-100 text-slate-600 group-hover:bg-slate-800 group-hover:text-white transition-colors">
                <Settings className="w-6 h-6" />
              </div>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-800">Settings</h2>
              <p className="text-sm text-slate-500 mt-1">Platform config</p>
            </div>
          </Link>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <div className="glass-card p-6">
              <h2 className="text-xl font-bold text-slate-800 mb-6 flex items-center gap-2">
                <ActivitySquare className="w-5 h-5 text-brand-600" />
                System Health Monitor
              </h2>
              <HealthDashboard />
            </div>
          </div>
          
          <div className="lg:col-span-1">
            <div className="glass-card p-6 h-full border-t-4 border-t-emergency-600">
              <h2 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-emergency-600 animate-ping"></div>
                Live Emergencies
              </h2>
              <EmergencyQueuePanel />
            </div>
          </div>
        </div>
      </div>
    </PortalShell>
  );
}
