import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Works at the GitHub Pages project URL and the bundled local app root.
  base: "./",
  plugins: [react()],
});
