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

/** The one place that decides where a freshly signed-in user actually lands - patients get the
 *  portal this phase builds, everyone else gets an honest "not built yet" rather than a page that
 *  quietly 403s the first thing it tries to load. */
export function RoleHome() {
  const { session } = useAuth();

  if (session?.user.role === 'patient') {
    return <Navigate to="/appointments" replace />;
  }
  return <Navigate to="/portal-coming-soon" replace />;
}
