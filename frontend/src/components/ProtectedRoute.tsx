import { Navigate } from "react-router-dom";
import { useAuth } from "@/lib/auth";
import type { UserRole } from "@/lib/types";

export function ProtectedRoute({
  roles,
  children,
}: {
  roles: UserRole[];
  children: React.ReactNode;
}) {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="flex h-screen items-center justify-center text-slate-500">Loading…</div>;
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  if (!roles.includes(user.role)) {
    return <Navigate to={`/${user.role}`} replace />;
  }
  return <>{children}</>;
}
