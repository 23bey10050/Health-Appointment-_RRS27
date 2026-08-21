import { Link } from 'react-router';

export function Component() {
  return (
    <div className="mx-auto max-w-md text-center">
      <h1 className="mb-2 text-2xl font-semibold text-slate-900">Page not found</h1>
      <p className="mb-4 text-slate-600">There is nothing here.</p>
      <Link to="/" className="font-medium text-brand-700 hover:underline">
        Back to safety
      </Link>
    </div>
  );
}
