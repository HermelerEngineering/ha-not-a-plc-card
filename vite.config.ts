import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Build a single self-contained bundle Home Assistant can load as a Lovelace
// resource. Lit is bundled in so the card has no external runtime dependency.
export default defineConfig({
  build: {
    lib: {
      entry: fileURLToPath(new URL("src/index.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "not-a-plc-card.js",
    },
    rollupOptions: {
      output: {
        entryFileNames: "not-a-plc-card.js",
      },
    },
    target: "es2021",
    sourcemap: true,
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
