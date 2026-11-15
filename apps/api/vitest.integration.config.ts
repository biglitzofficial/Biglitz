import { defineConfig } from "vitest/config";

// Integration tests run against the Firestore emulator (started by `firebase emulators:exec`).
export default defineConfig({
  test: {
    include: ["test/**/*.int.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    globals: false,
  },
});
