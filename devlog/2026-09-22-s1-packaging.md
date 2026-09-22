# Devlog 017 — S1: a real install

**2026-09-22**

S1 is built. A `v*` tag now runs the CI gate, packs `homefleet-<version>.tgz`,
installs that exact file globally on fresh Ubuntu and Windows runners, and
only then attaches it to a GitHub Release. Installing HomeFleet is one line —
`npm i -g <tarball URL>` — with Node ≥ 20 as the only prerequisite, and the
three bins land on PATH. From-source instructions moved under Development in
the README; [releasing.md](../docs/reference/releasing.md) is the checklist
for cutting one. No release has been tagged yet: v0.3.0 (A2 + S1) is the
proposed first, and it waits on Hugo.

Plan: [2026-09-22-s1-packaging.md](../docs/plans/2026-09-22-s1-packaging.md).
Spec: [S1 design](../docs/specs/2026-07-12-s1-packaging-design.md).

## The bug the spec's smoke would have blessed

Every bin gated `main()` on `fileURLToPath(import.meta.url) ===
process.argv[1]`. That holds for `node dist/bin/homefleet.js` and for the
Windows `.cmd` shims, which is all anyone had ever run. It does not hold for a
Linux global install: npm links `<prefix>/bin/homefleet` to the package's
`dist/bin/homefleet.js`, and Node hands an ESM entry its *real* path as
`import.meta.url` while leaving `argv[1]` as the link. The compare is false,
`main()` never runs, and the process exits **0** having printed nothing.

The spec's smoke asked only for exit 0. It would have passed a release in
which no bin did anything on Linux. The guard is now `isInvokedDirectly`,
which realpaths both sides, and the smoke asserts the exact `--version`
line instead of the exit code. The symlink unit test skips on this dev box
(Windows without Developer Mode refuses to create symlinks — `EPERM`), so the
proof is the Ubuntu leg of the release workflow's dry run: green, printing
the right version through a real npm symlink.

## Other spec deviations

- **`"type": "module"` kept in the manifest.** The spec's keep-list omitted
  it; without it Node loads the ESM bins as CommonJS and dies on `import`.
  `buildPublishManifest` refuses a package without it.
- **`engines` added to `@homefleet/daemon`**, so "keep `engines`" is literal
  rather than something the pack script invents.
- **Bin paths normalized** (`./dist/bin/x.js` → `dist/bin/x.js`), which is
  what npm would otherwise do while printing a warning.
- **`workflow_dispatch`** on the release workflow: everything but the Release
  itself. Without it the first test of the pipeline would have been a public
  tag. It was used today, green on the first run.
- **The tag guard is `pnpm pack:release --tag`**, run before the build, rather
  than a separate script.

## What review caught

The code review of the pack script found one real problem: its integration
test rebuilt `packages/daemon/dist/bin` in the shared checkout during
`pnpm test`. tsup's `clean: true` makes that a race against a second session
on the same clone, and — worse — that `dist/bin/homefleetd.js` is the file
`homefleet setup`'s Task Scheduler entry launches, so a test run would have
silently swapped the binary under a running daemon. `packRelease` now takes a
`distDir` and builds there with `tsup --out-dir`; the test builds into its
own temp dir, and the checkout's bins keep their mtimes through a full
`pnpm test`. The same pass moved staging into a fresh `mkdtemp` dir (the old
`<out>/staging` was an `rm -rf` on a user-chosen path) and clears stale
`homefleet-*.tgz` before packing, so the workflow's `release/*.tgz` globs
can't pick up an old version.

Left as known, loud-failing edges rather than fixed: a `%` in the output path
breaks `cmd` quoting on Windows, and `pnpm pack:release -- --tag v…` (npm-style
`--`) is rejected by `parseArgs`. Both fail with an error, never silently.

## Cost

The pack test really builds and really runs `npm pack`, adding a few seconds
to every `pnpm test`. That's the spec's real-I/O tier doing its job; the
tarball's exact file list is asserted, so a stray file in a future release
fails CI instead of shipping.
