import { defineConfig } from "vitest/config";

// @parserelay/core is a contract package: the tests are mostly type-level
// (`*.test-d.ts`, checked via `expectTypeOf`) plus a few runtime tests for the
// `isEnvelope` guard. `typecheck.enabled` makes `vitest run` also run tsc over
// the `*.test-d.ts` files.
export default defineConfig({
  test: {
    typecheck: {
      enabled: true,
      tsconfig: "./tsconfig.json",
      include: ["src/**/*.test-d.ts"],
    },
    include: ["src/**/*.test.ts"],
  },
});
