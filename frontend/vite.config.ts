/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server on 5173 (the origin the API allows via CORS). In production the
// built assets are served same-origin by the API image.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // Node, not jsdom: what is tested here is the SSE frame parser, the paging
  // header fallback, and the pager arithmetic. None of it touches the DOM, and
  // a browser environment would be machinery in front of that.
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test-setup.ts"],
  },
});
