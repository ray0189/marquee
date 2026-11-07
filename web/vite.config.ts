import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

process.env.VITE_APP_NAME ||= "Marquee"; // also fills %VITE_APP_NAME% in index.html

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": { target: process.env.API_URL ?? "http://localhost:8100", changeOrigin: false } } },
  build: { sourcemap: false, chunkSizeWarningLimit: 900 },
});
