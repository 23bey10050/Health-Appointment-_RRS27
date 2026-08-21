import type { UserRole } from '@health/contracts';
import { Navigate, Outlet, useLocation } from 'react-router';

import { useAuth } from './useAuth.js';

/** Wraps every route that needs a signed-in visitor. Remembers where they were headed, in
 *  location state, so LoginPage can send them back there instead of always landing on the same
 *  default page after signing in. */
export function RequireAuth() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return <Outlet />;
}

/** Sits inside `RequireAuth`, so it only ever has to decide "wrong role", never "no role at
 *  all" - a signed-out visitor is already sent to login before this runs. */
export function RequireRole({ roles }: { roles: readonly UserRole[] }) {
  const { session } = useAuth();

  if (!session || !roles.includes(session.user.role)) {
    return <Navigate to="/" replace />;
  }
  return <Outlet />;
}

/** The one place that decides where a freshly signed-in user actually lands - each of the three
 *  roles has its own portal now. The final fallback is only reachable if `session` is somehow
 *  null on the one render this runs (it sits inside `RequireAuth`, so that should never actually
 *  happen) - sending it back to login is the honest thing to do with a state that should not
 *  exist, rather than pretending a role with no portal is still a possibility. */
export function RoleHome() {
  const { session } = useAuth();

  if (session?.user.role === 'patient') {
    return <Navigate to="/appointments" replace />;
  }
  if (session?.user.role === 'doctor') {
    return <Navigate to="/doctor/schedule" replace />;
  }
  if (session?.user.role === 'admin') {
    return <Navigate to="/admin" replace />;
  }
  return <Navigate to="/login" replace />;
}
