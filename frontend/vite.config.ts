import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: true,
    port: 5173,
    // Docker Desktop on Windows doesn't propagate native fs-change events through
    // the bind mount reliably, so chokidar's default watcher misses host-side edits.
    watch: {
      usePolling: true,
      interval: 300,
    },
  },
});
