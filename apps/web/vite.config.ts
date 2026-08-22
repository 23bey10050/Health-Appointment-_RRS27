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
  const apiUrl = env['VITE_API_URL'];

  // Checking for a *missing* value would never fire here: `.env.local` is committed on purpose
  // (rule 5, so a fresh clone runs with no setup) and it always supplies the localhost default.
  // A hosting platform's own build variable does override that file - verified directly - so the
  // only failure left to catch is the one that actually happens: the platform variable never
  // reaching the build at all, leaving the committed localhost value to be baked in and shipped.
  // A production bundle pointing at localhost is never correct, so that is what is rejected.
  const pointsAtLocalhost = !apiUrl || apiUrl.includes('localhost');
  // Only a hosted build is fatal. `npm run check` builds production locally as a smoke test and
  // must keep passing on a fresh clone with no setup at all, which is the whole point of shipping
  // `.env.local` - but that same local-first default is worthless in a bundle real visitors load.
  // Cloudflare Workers Builds sets CI=true automatically (as do Render, GitHub Actions and every
  // other hosted builder), so it is the honest signal for "this artifact is going somewhere".
  const isHostedBuild = Boolean(process.env['CI']);

  if (mode === 'production' && pointsAtLocalhost) {
    const detail =
      `VITE_API_URL is ${apiUrl ? `"${apiUrl}"` : 'not set'}, so this build points at the local ` +
      "development API. A hosted page calling localhost reaches the visitor's own machine, where " +
      'nothing is listening.\n' +
      'Set VITE_API_URL to the deployed API origin (for example https://your-api.onrender.com) ' +
      'as a BUILD variable, not a runtime one - Vite inlines the value at build time, so a ' +
      'runtime variable never reaches already-compiled browser code.';

    if (isHostedBuild) {
      throw new Error(detail);
    }
    console.warn(`\n[web] Local production build. ${detail}\n`);
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
