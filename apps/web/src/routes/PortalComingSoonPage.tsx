/** An admin account can already sign in - the account and the API behind it exist - but the admin
 *  portal itself is a later phase. An honest "not built yet" is what stands here instead of a
 *  screen that quietly 403s the first thing it tries to load. */
export function Component() {
  return (
    <div className="mx-auto max-w-md text-center">
      <h1 className="mb-2 text-2xl font-semibold text-slate-900">Admin portal coming soon</h1>
      <p className="text-slate-600">
        Your account is signed in and ready. This part of the app has not been built yet.
      </p>
    </div>
  );
}
