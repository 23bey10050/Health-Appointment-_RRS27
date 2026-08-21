import { createBrowserRouter } from 'react-router';

import { Layout } from './components/Layout.js';
import { RequireAuth, RequireRole, RoleHome } from './features/auth/guards.js';

/**
 * Every page below `Layout` is loaded through `lazy`, React Router's own route-level code
 * splitting - each one becomes its own chunk, fetched only once a visitor actually navigates
 * there, so signing in never downloads the doctor-search screen's code before it is needed. The
 * pieces that decide *whether* a route is reachable at all - the layout, the two guards, the tiny
 * role-redirect - stay in the main bundle instead, since every visitor needs them immediately.
 */
export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: 'login', lazy: () => import('./routes/LoginPage.js') },
      { path: 'register', lazy: () => import('./routes/RegisterPage.js') },
      {
        element: <RequireAuth />,
        children: [
          { index: true, element: <RoleHome /> },
          { path: 'portal-coming-soon', lazy: () => import('./routes/PortalComingSoonPage.js') },
          {
            element: <RequireRole roles={['patient']} />,
            children: [
              { path: 'appointments', lazy: () => import('./routes/patient/AppointmentsPage.js') },
              {
                path: 'appointments/:id',
                lazy: () => import('./routes/patient/AppointmentDetailPage.js'),
              },
              { path: 'search', lazy: () => import('./routes/patient/DoctorSearchPage.js') },
              {
                path: 'doctors/:doctorId',
                lazy: () => import('./routes/patient/DoctorAvailabilityPage.js'),
              },
              { path: 'hold/:holdId', lazy: () => import('./routes/patient/ConfirmHoldPage.js') },
            ],
          },
        ],
      },
      { path: '*', lazy: () => import('./routes/NotFoundPage.js') },
    ],
  },
]);
