import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The client is a plain SPA. In dev, Vite proxies the API + socket to the
// Fastify server on :8787; in prod Fastify serves web/dist itself, so it is
// one origin and one Railway service.
// API_PORT lets the dev API sit on another port when :8787 is taken (the e2e suites then take BASE).
const api = `http://127.0.0.1:${process.env.API_PORT ?? "8787"}`;

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": api,
      "/auth": api,
      "/webhooks": api,
      "/health": api,
      "/socket.io": { target: api, ws: true },
    },
  },
});
