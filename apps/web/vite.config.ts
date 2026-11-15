import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Local dev: the API runs on :8080 (apps/api).
    proxy: { "/api": "http://localhost:8080" },
  },
});
