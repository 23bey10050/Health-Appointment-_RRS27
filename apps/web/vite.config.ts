import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Port 5173 is Vite's own default, named here anyway because the API's CORS allowlist
// (see .env.local's CORS_ORIGINS) is written against this exact port - changing one without the
// other quietly breaks every request in dev with a CORS error that has nothing to do with the code.
export default defineConfig({
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
});
