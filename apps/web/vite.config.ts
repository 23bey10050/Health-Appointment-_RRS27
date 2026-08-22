import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Port 5173 is Vite's own default, named here anyway because the API's CORS allowlist
// (see .env.local's CORS_ORIGINS) is written against this exact port - changing one without the
// other quietly breaks every request in dev with a CORS error that has nothing to do with the code.
export default defineConfig(({ mode }) => {
  // `api-client.ts` falls back to http://localhost:4000 when VITE_API_URL is unset, which is
  // exactly right for local dev and exactly wrong for a deployed build - a hosted page calling
  // localhost reaches the visitor's own machine, where nothing is listening. That failure is
  // invisible at build time and shows up much later as a generic "please try again" in someone
  // else's browser, so a production build refuses to finish without it rather than shipping a
  // bundle that was never going to work.
  const env = loadEnv(mode, '../../', 'VITE_');
  if (mode === 'production' && !env['VITE_API_URL']) {
    throw new Error(
      'VITE_API_URL is not set, so this build would ship pointing at http://localhost:4000.\n' +
        'Set it to the deployed API origin (for example https://your-api.onrender.com) as a ' +
        'BUILD variable - Vite inlines it at build time, so a runtime variable never reaches ' +
        'the browser code.',
    );
  }

  return {
    plugins: [react(), tailwindcss()],
    // Reads the same .env / .env.local the API reads, from the repo root, instead of expecting a
    // second copy just for this workspace - one file, matching rule 5's "one committed template"
    // shape. This is safe specifically because Vite only ever exposes variables prefixed VITE_ to
    // the browser bundle; every real secret in that same file (JWT_ACCESS_SECRET, DATABASE_URL)
    // never crosses into client code no matter how the two are laid out side by side.
    envDir: '../../',
    server: {
      port: 5173,
    },
    build: {
      // A patient's browser downloading this app is the one place in the whole project where "did
      // it load fast" is judged by a human watching a spinner, not a server-side p95 budget - source
      // maps stay off in the production build so a slow connection is not also shipping a second,
      // unused copy of the bundle's own debugging information.
      sourcemap: false,
    },
  };
});
