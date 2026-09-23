import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Backend: the FastAPI anime-api (uv run anime-api) — set BACKEND_ORIGIN to
// point elsewhere (e.g. the legacy Node backend on :8787).
const BACKEND = process.env.BACKEND_ORIGIN ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        // keep the HLS engine out of the main bundle
        manualChunks: { hls: ["hls.js"] },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true },
      "/stream": { target: BACKEND, changeOrigin: true },
      "/img": { target: BACKEND, changeOrigin: true },
    },
  },
});
