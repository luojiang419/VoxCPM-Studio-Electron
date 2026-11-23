import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    rollupOptions: { input: { main: "index.html", apiPreview: "api-preview.html" } },
    emptyOutDir: true,
  },
});
