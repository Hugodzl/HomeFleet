# S1 Packaging — Design

- **Date:** 2026-07-12
- **Status:** approved by Hugo 2026-07-12 (brainstorm, this session). First
  step of the sequencing in
  [2026-07-12-backlog-structuring.md](2026-07-12-backlog-structuring.md);
  closes the "npm packaging (v0.1 installs from source only)" debt item.

## Context and goal

v0.1 installs from source only: clone, `pnpm install`, `pnpm build`, run bins
with bare `node`. S1 makes installing HomeFleet a single `npm i -g` of a
release artifact. It is deliberately the *smallest respectable install* — the
guided first-run, single binary, and platform installers are B1's scope.

**Locked decisions (Hugo, 2026-07-12):**

| Decision | Choice |
| --- | --- |
| Audience bar | "Mostly me, for now" — dev-tolerant; Node ≥20 as prerequisite is acceptable |
| Channel | GitHub Releases tarball; public npm registry reconsidered once the project is tested enough |
| Release flow | GitHub Actions on `v*` tag |
| Packaging approach | Publish-manifest rewrite of `@homefleet/daemon` (approach A) — rides the existing tsup design (first-party code already bundled into the bins, third-party deps deliberately external) |

Rejected alternatives: a dedicated release package (duplicate metadata to
keep in sync forever) and a fully-vendored tarball (re-bundling
`reflect-metadata` / `@peculiar/x509` contradicts the documented risk call in
`packages/daemon/tsup.config.ts`; that risk belongs to B1's single-binary
work, with time to test).

## 1. Deliverable

Each `v*` tag produces `homefleet-<version>.tgz` attached to a GitHub
Release.

- Install: `npm i -g <release tarball URL>`; Node ≥20 is the one documented
  prerequisite.
- Puts all three bins on PATH: `homefleetd`, `homefleet`,
  `homefleet-mcp-stdio` (npm generates Windows `.cmd` shims).
- Package name inside the tarball: `homefleet` (verified free on the npm
  registry 2026-07-12, as are `homefleetd` and the `@homefleet` scope) — the
  later "publish for real" step is `npm publish` of the same artifact, not a
  rework.
- Update story: install the newer tarball over the old one.

## 2. Pack script (`scripts/pack-release.ts`)

Run via `tsx`. A thin CLI over a pure, unit-testable core:

- **`buildPublishManifest(daemonPkg)`** — pure function. Rename to
  `homefleet`; keep `version`, `bin`, `engines`, `license`, `description`,
  and third-party `dependencies`; **drop** `workspace:*` deps (already
  bundled into the bins by tsup `noExternal`) and the `./src/index.ts`
  `exports` (packaged consumers get bins, not a library); add
  `files: ["dist/bin"]` and `repository`.
- The script builds the daemon (`pnpm --filter @homefleet/daemon build`),
  stages `dist/bin` + LICENSE + the generated manifest into a clean staging
  dir, runs `npm pack` there, and prints the tarball path.
- **Fail-loud checks:** dist bins must exist before staging; the emitted
  manifest must contain zero `@homefleet/*` dependencies (asserted, not
  assumed).

## 3. Release workflow (`.github/workflows/release.yml`)

Trigger: `push` on tags `v*`.

1. Existing gate: lint, typecheck, tests.
2. Guard: the tag version must equal `@homefleet/daemon`'s `version`, or the
   workflow fails before packing — no mislabeled artifacts.
3. Pack via the script above.
4. Smoke the real artifact (section 4).
5. Create the GitHub Release with the tarball attached (`--generate-notes`).

## 4. CI smoke of the real artifact

After packing, `npm i -g ./homefleet-<version>.tgz` on **both**
`ubuntu-latest` and `windows-latest`, then run a `homefleet` invocation that
must exit 0 without a running daemon (e.g. `--help` or `--version`). This
exercises exactly what a user does — shim generation,
third-party dep resolution from the registry, ESM loading — not a simulation
of it. Windows is the fleet's OS and where shim behavior differs; it is not
optional.

## 5. Docs

- README gains a real Install section: prerequisite, install command, then
  `homefleet setup`. From-source instructions move under Development.
- The backlog's npm-packaging debt item is closed out when this ships.

## 6. Testing

- **Unit:** `buildPublishManifest` — workspace deps dropped, third-party
  deps kept, `bin`/`files`/`engines`/name correct, exports removed.
- **Real-I/O integration** (existing tier, 30s vitest timeouts): run the
  pack script against the actual package; assert the tarball's file listing
  (staged manifest + `dist/bin` contents, nothing else).
- **CI smoke:** the global-install check above, where a registry is
  available.

## Out of scope

npm registry publish (revisit once tested enough — the artifact is already
publish-shaped), single binary and platform installers (B1), auto-update,
daemon version advertising in capability ads (S3).
