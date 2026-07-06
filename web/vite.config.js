import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Base must match the repo name for a GitHub Pages *project* site
// (served at https://<username>.github.io/kwent/). If you ever rename
// the repo, update this to match.
export default defineConfig({
  plugins: [react()],
  base: "/kwent/",
});
