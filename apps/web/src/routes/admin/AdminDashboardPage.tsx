import { Link } from 'react-router';

const SECTIONS = [
  {
    to: '/admin/doctors',
    title: 'Doctors',
    description: 'Create accounts, edit profiles, manage shifts and days off.',
  },
  {
    to: '/admin/notifications',
    title: 'Notification health',
    description: 'Queue, failure and dead-letter counts, with one-click retry.',
  },
  {
    to: '/admin/audit-log',
    title: 'Audit log',
    description: 'Every recorded action across the clinic, filterable by who and what.',
  },
] as const;

export function Component() {
  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold text-slate-900">Admin</h1>
      <ul className="grid gap-4 sm:grid-cols-2">
        {SECTIONS.map((section) => (
          <li key={section.to}>
            <Link
              to={section.to}
              className="block rounded-md border border-slate-200 bg-white p-4 hover:border-brand-300 hover:shadow-sm"
            >
              <p className="font-medium text-slate-900">{section.title}</p>
              <p className="mt-1 text-sm text-slate-600">{section.description}</p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
