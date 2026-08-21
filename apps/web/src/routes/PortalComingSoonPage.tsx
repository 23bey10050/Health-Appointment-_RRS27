import { useAuth } from '../features/auth/useAuth.js';

/** A doctor or admin account can already sign in - the accounts and the API behind them exist -
 *  but this phase only builds the patient portal. An honest "not built yet" is what stands here
 *  instead of a screen that quietly 403s the first thing it tries to load. */
export function Component() {
  const { session } = useAuth();

  return (
    <div className="mx-auto max-w-md text-center">
      <h1 className="mb-2 text-2xl font-semibold text-slate-900">
        {session?.user.role === 'doctor' ? 'Doctor' : 'Admin'} portal coming soon
      </h1>
      <p className="text-slate-600">
        Your account is signed in and ready. This part of the app has not been built yet.
      </p>
    </div>
  );
}
