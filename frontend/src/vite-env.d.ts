/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "true" → compute summaries in the browser from public/data/snapshot.json (GitHub Pages demo). */
  readonly VITE_STATIC_SNAPSHOT?: string;
}
