import { defineConfig } from "tsup";

// WHY: the daemon's three bins are consumed as bare-`node`-runnable CLI
// executables (M9 Unit 10), but every `@homefleet/*` workspace package
// publishes its `exports` at `./src/index.ts` (TS source, no build step) so
// that vitest + `tsc --noEmit` keep exercising SOURCE unchanged. Bare `node`
// cannot resolve `.ts` sources or the `.js`-suffixed-but-TS-backed import
// specifiers those sources use, so the bins need a real build.
//
// We bundle ONLY first-party `@homefleet/*` code into each bin (via
// `noExternal`) and leave every third-party dependency + all node builtins
// external, resolved from `node_modules` at run time (this repo is run
// installed, not vendored, so `node_modules` is always present next to the
// bin). Keeping third-party deps external is a deliberate risk reduction:
// packages like `reflect-metadata` and `@peculiar/x509` rely on decorator
// metadata / module-scoped side effects and native bindings that are risky to
// re-bundle with esbuild, so we let Node's own resolver load them unmodified
// and only ask esbuild to flatten our own `.ts` graph (which has none of
// those hazards) into a single ESM file per bin.
export default defineConfig({
  entry: {
    homefleetd: "src/bin/homefleetd.ts",
    homefleet: "src/bin/homefleet.ts",
    "homefleet-mcp-stdio": "src/bin/homefleet-mcp-stdio.ts",
  },
  format: "esm",
  platform: "node",
  target: "node20",
  outDir: "dist/bin",
  clean: true,
  sourcemap: true,
  splitting: false,
  // Bundle first-party workspace sources (no built `exports` to load from
  // node_modules); everything else — third-party deps and node builtins —
  // stays external and is resolved from node_modules at run time.
  noExternal: [/^@homefleet\//],
});
