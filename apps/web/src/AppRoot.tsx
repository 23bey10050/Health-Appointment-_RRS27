import { useEffect, useState } from 'react';
import { RouterProvider } from 'react-router';

import { restoreSession } from './lib/api-client.js';
import { router } from './router.js';

/**
 * Tries to turn whatever refresh token survived from the last visit back into a live session
 * before anything else renders - without this, every page reload would look logged-out for a
 * moment even for someone who never actually logged out, since the access token itself is
 * deliberately never persisted (see lib/session.ts).
 */
export function AppRoot() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void restoreSession().finally(() => setReady(true));
  }, []);

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <span
          aria-hidden="true"
          className="h-8 w-8 animate-spin rounded-full border-4 border-brand-600 border-t-transparent"
        />
        <span className="sr-only">Loading</span>
      </div>
    );
  }

  return <RouterProvider router={router} />;
}
