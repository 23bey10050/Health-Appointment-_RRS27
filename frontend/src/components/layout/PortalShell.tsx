import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import { LogOut, User, Activity } from "lucide-react";

const ROLE_LABEL: Record<string, string> = {
  patient: "Patient Portal",
  doctor: "Doctor Portal",
  admin: "Admin Portal",
};

export function PortalShell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 sm:p-8">
      <div className="w-full max-w-6xl h-[90vh] glass-panel flex flex-col overflow-hidden animate-slide-up relative z-10">
        {/* macOS-style Window Header */}
        <header className="flex items-center justify-between px-4 py-3 border-b border-white/20 bg-white/40 backdrop-blur-md">
          <div className="flex items-center gap-4">
            <div className="flex gap-2">
              <div className="w-3 h-3 rounded-full bg-red-400 border border-red-500/50"></div>
              <div className="w-3 h-3 rounded-full bg-yellow-400 border border-yellow-500/50"></div>
              <div className="w-3 h-3 rounded-full bg-green-400 border border-green-500/50"></div>
            </div>
            <div className="flex items-center gap-2 px-2">
              <Activity className="w-5 h-5 text-brand-600" />
              <span className="font-semibold text-slate-800 tracking-tight">City Care Clinic</span>
              <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-brand-100 text-brand-700">
                {user ? ROLE_LABEL[user.role] : ""}
              </span>
            </div>
          </div>
          
          {user && (
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
                <User className="w-4 h-4" />
                <span>{user.full_name}</span>
              </div>
              <button
                onClick={handleLogout}
                className="flex items-center gap-2 rounded-lg bg-white/50 border border-white/60 px-3 py-1.5 text-sm text-slate-700 hover:bg-white/80 transition-colors shadow-sm"
              >
                <LogOut className="w-4 h-4" />
                <span className="hidden sm:inline">Sign out</span>
              </button>
            </div>
          )}
        </header>

        {/* Main Content Area */}
        <main className="flex-1 overflow-y-auto p-6 sm:p-10">
          <div className="max-w-5xl mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
