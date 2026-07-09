# Devlog 011 — v0.1.0: release polish, and the seam bug the rig caught in minutes

**2026-07-09**

Same day as the rig bring-up (devlog 010), second session: the release half of
M9. The plan was tame — shorten the worker cache paths, reconcile the version
drift, give the docs a final pass, tag v0.1.0. It mostly went that way, except
for one bug with a satisfying shape: a *documented* behavior that no test could
see missing and the rig exposed on its first restart.

## What landed (10 commits + tag)

- **Short worker cache paths** (`37ca419`, `0eb7049`) — the M8 follow-up. A
  checkout now lives at `<repoKey>\co\<commitKey>` (both 16-hex truncations)
  instead of `<64-hex sha256>\checkouts\<40-hex commit>`: 37 chars of suffix
  past the cache root instead of 116, so real repos stay well clear of Windows
  MAX_PATH regardless of git's long-path mode (`core.longpaths` from d1e2b16
  stays as the first line of defense). Truncated names mean the dir no longer
  encodes the full commit, so `resolve()` now *verifies* an existing checkout's
  HEAD before reusing it — and because a paired peer could birthday-grind two
  of its own commits to a shared 64-bit prefix, a mismatch on a **pinned**
  checkout refuses rather than yanking a running job's directory. Legacy
  pre-0.1 cache dirs are warned about once at startup, never read, never
  deleted. The review pass also characterized and fixed a **pre-existing**
  eviction/reuse race (an eviction queued behind the repo lock could remove a
  checkout that a faster-queued resolve had just re-pinned; the locked removal
  now re-checks and backs off).
- **Versions became real** (`d3596f6`, `2c3b8e4`) — all three packages say
  0.1.0, a drift-guard test pins `DAEMON_VERSION` to the daemon's
  `package.json` (bump one without the other and the suite fails), and the
  MCP-advertised server version is now an alias of `DAEMON_VERSION` rather
  than a second literal that happened to match.
- **Docs release pass** (`5d5ce0d`, `e4e48be`, `29ce8b0`) — the README's
  status block now tells the two-machine story with the real numbers, the
  quickstart gained prerequisites and lost a wrong `cd` (cloning from GitHub
  lands in `HomeFleet`, not this repo's historical dir name), the demo's step
  order no longer tells you to start the daemon before writing its config, and
  the intro claim was scoped so the first HN comment can't be "your example
  agent is a cloud model." Three review rounds: a reader's-eye pass found the
  reordering and framing issues a code-accuracy pass could not.
- **`--version`** (`b50de4a`, `5bae3a0`) — flagged by the final whole-tree
  review: the one place a user of a *tagged release* looks for a version
  printed usage text instead. Both operator bins answer now.
- **The seam fix** (`60a916e`) — see below.

Suite: 589 → **601 tests**, every unit through the full loop (fresh
implementer → spec-compliance review → code-quality review, independent gate
re-runs at each stage).

## The seam bug: a warning the daemon couldn't print

The short-path work added an operator-facing startup warning for legacy cache
dirs, and the docs pass documented it: "the daemon logs a one-line warning at
startup." Both units were reviewed; both reviews verified their half — the
store emits the message, the doc quotes the code verbatim. 601 tests green.

Then the laptop's daemon restarted on the new build, with a genuine legacy
cache dir sitting right there — and stderr showed only the startup line.

The cause sat in the seam: `daemon.ts` builds the `WorkspaceStore` without its
`logger`, so every store diagnostic defaults to a no-op. That wasn't even an
oversight — it was a *documented v0 decision* from M9 ("informational strings
rather than errors; routing them to onError would be a category mismatch"),
made when the diagnostics were eviction/gc notes nobody needed to see. Two
units later, one change made the channel operator-facing and another
documented it, and no per-unit review had reason to re-open the assembly's
old decision. The whole-tree final review missed it too — it verified the
init-path *behavior* in the store, not the logger's wiring in the assembly.

The fix is the boring right thing: `DaemonOptions.onDiagnostic` (default
no-op, doc-commented as the informational sibling of `onError`), wired to the
store's logger, written to stderr by the bin. TDD red first — the failing test
reproduced the live symptom exactly (`expected [] to have a length of 1`) —
and the live confirmation came minutes later: both machines now print
`homefleetd: legacy workspace cache layout at ... — safe to delete` on
startup, before the started line.

Devlog 009 predicted the expensive bugs live "in the seam between what a unit
test proves and what a two-machine demo needs." This one adds a refinement:
they also live in *decisions that were correct when made* and silently
invalidated by later units. The docs pass promising the warning is what turned
a dropped log line into a falsifiable claim — documentation as a bug detector.

## Rig verification (real hardware, both directions)

The two-machine rig re-armed hands-off: the laptop session updated its side,
posted a kickoff into the LAN mailbox, and Hugo's only action was pasting a
three-line prompt into a tower session. The tower pulled `b541d74 → 60a916e`,
rebuilt, restarted — and confirmed the legacy warning fired there too (it had
been silently dropped on its previous build, consistent with the seam fix).

- **tower → laptop** (`git rev-parse HEAD`, the direction that hit MAX_PATH in
  M8): exit 0, stdout `60a916e…` matching the pushed HEAD, worker wall
  **67 ms**, ~1.5 s client round-trip — through the laptop's new short-path
  layout.
- **laptop → tower**: exit 0, HEAD matches, worker wall **29 ms**, ~2 s end to
  end including the cold bundle sync into the tower's fresh new-layout cache.
- Both machines now show the two generations side by side on disk — the new
  `<16-hex>\co\<16-hex>` checkout next to the untouched, warned-about legacy
  dir. The new repo dir name is literally the old one truncated: same repoId,
  same hash, 48 fewer characters.

## v0.1.0

With both directions green, `v0.1.0` is tagged on `60a916e` (well — on the
devlog commit above it) with a GitHub Release on Hugodzl/HomeFleet. Not on
npm: v0.1 installs from source, and says so. What v0.1 *is*: pair once, and
any MCP-capable agent on one machine can put another machine's local models
and executors to work over the LAN, with the whole path — discovery, mTLS,
git-bundle sync, dispatch, streaming, cancel — tested end to end on one
machine and proven on two.

## Next

Post-v0.1 backlog stays honest and written down: the registerExistingCheckouts
populated-dir filter, per-iteration stop-check in eviction, the mDNS
same-hostname probe race (mitigated, still worth fixing at the source), and
the roadmap's next real step — code-writing delegation. The rig stays up; it
has now caught two bugs in one day that no amount of single-machine testing
would have found, which is the strongest argument it could make for itself.
