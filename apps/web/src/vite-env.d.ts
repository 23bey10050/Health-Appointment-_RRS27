/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where the API lives. Optional on purpose - api-client.ts falls back to the local dev
   *  address when it is not set, the same "missing config degrades, never crashes" rule every
   *  other optional setting in this project already follows. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
