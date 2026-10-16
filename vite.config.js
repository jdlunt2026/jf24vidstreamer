import { defineConfig } from "vite";

// `npm run build` writes the client to dist/, which the server serves.
// `npm run dev:client` serves it with hot reload and forwards API/media
// requests to the server on :8080 (`npm run dev`).
export default defineConfig({
  root: "client",
  base: "./",
  build: { outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 1000 },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8080",
      "/media": "http://localhost:8080",
      "/img": "http://localhost:8080",
    },
  },
});
