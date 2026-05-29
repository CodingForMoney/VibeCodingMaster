import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: ".",
  build: {
    outDir: "dist-frontend"
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4173",
      "/ws": {
        target: "ws://localhost:4173",
        ws: true
      }
    }
  }
});
