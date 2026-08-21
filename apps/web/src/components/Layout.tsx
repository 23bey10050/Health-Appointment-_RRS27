import { NavLink, Outlet } from 'react-router';

import { logoutCurrentUser } from '../features/auth/actions.js';
import { useAuth } from '../features/auth/useAuth.js';
import { Button } from './Button.js';

const NAV_LINK_CLASS = ({ isActive }: { isActive: boolean }) =>
  `rounded-md px-3 py-2 text-sm font-medium ${isActive ? 'bg-brand-100 text-brand-800' : 'text-slate-600 hover:bg-slate-100'}`;

export function Layout() {
  const { session } = useAuth();

  return (
    <div className="min-h-screen bg-slate-50">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:shadow"
      >
        Skip to main content
      </a>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
          <span className="text-lg font-semibold text-slate-900">Health Appointment Clinic</span>
          {session && (
            <nav aria-label="Main" className="flex items-center gap-1">
              {session.user.role === 'patient' && (
                <>
                  <NavLink to="/appointments" className={NAV_LINK_CLASS}>
                    My appointments
                  </NavLink>
                  <NavLink to="/search" className={NAV_LINK_CLASS}>
                    Find a doctor
                  </NavLink>
                </>
              )}
              {session.user.role === 'doctor' && (
                <>
                  <NavLink to="/doctor/schedule" className={NAV_LINK_CLASS}>
                    Schedule
                  </NavLink>
                  <NavLink to="/doctor/leaves" className={NAV_LINK_CLASS}>
                    Days off
                  </NavLink>
                </>
              )}
              <span className="mx-2 text-sm text-slate-500">{session.user.fullName}</span>
              <Button variant="secondary" onClick={() => void logoutCurrentUser()}>
                Log out
              </Button>
            </nav>
          )}
        </div>
      </header>
      <main id="main-content" className="mx-auto max-w-4xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
