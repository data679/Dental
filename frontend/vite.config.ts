import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// VITE_BASE_PATH lets the GitHub Pages build serve from /<repo>/ (see .github/workflows/pages.yml).
export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? "/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4000",
    },
  },
});
