import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  server: {
    port: 5183,
  },
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 1100,
  },
});
