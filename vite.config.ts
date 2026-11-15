import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// SITE_SUBFOLDER=longshadow builds for https://<user>.github.io/longshadow/.
// Without it the app is built for the domain root (Vercel, local dev).
const sub = process.env.SITE_SUBFOLDER;

export default defineConfig({
  base: sub ? `/${sub}/` : "/",
  plugins: [react()],
  build: { target: "es2022", chunkSizeWarningLimit: 1500 },
  worker: { format: "es" },
});
