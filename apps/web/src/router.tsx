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
          {
            element: <RequireRole roles={['doctor']} />,
            children: [
              { path: 'doctor/schedule', lazy: () => import('./routes/doctor/SchedulePage.js') },
              {
                path: 'doctor/appointments/:id',
                lazy: () => import('./routes/doctor/AppointmentVisitPage.js'),
              },
              { path: 'doctor/leaves', lazy: () => import('./routes/doctor/LeavesPage.js') },
            ],
          },
          {
            element: <RequireRole roles={['admin']} />,
            children: [
              { path: 'admin', lazy: () => import('./routes/admin/AdminDashboardPage.js') },
              { path: 'admin/doctors', lazy: () => import('./routes/admin/AdminDoctorsPage.js') },
              {
                path: 'admin/doctors/:id',
                lazy: () => import('./routes/admin/AdminDoctorDetailPage.js'),
              },
              {
                path: 'admin/notifications',
                lazy: () => import('./routes/admin/AdminNotificationsPage.js'),
              },
              {
                path: 'admin/audit-log',
                lazy: () => import('./routes/admin/AdminAuditLogPage.js'),
              },
            ],
          },
        ],
      },
      { path: '*', lazy: () => import('./routes/NotFoundPage.js') },
    ],
  },
]);
