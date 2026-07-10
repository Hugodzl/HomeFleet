# Devlog 012 — backlog burn-down: fixing at the source what v0.1 shipped mitigated

**2026-07-10**

First session after the release. The choice on the table was announce v0.1,
start code-writing delegation, or clear the backlog first — Hugo picked the
burn-down, on the theory that the other two go better standing on a clean
base. Four units, nine commits, 601 → 620 tests.

## What landed

- **WorkspaceStore, two recorded items plus one the review demanded**
  (`e394923`, `473850d`). The startup scan now skips checkout dirs without a
  `.git` gitlink — a mid-creation crash leftover no longer counts against
  `maxCachedCheckouts` and can no longer push a *real* checkout out of the
  LRU. And `evictToCapacity` re-checks `stopped` at every loop iteration, not
  just at entry. The quality review then asked the sharper question: an
  eviction already queued behind the repo lock when `stop()` lands still ran
  its `rm`. Now the locked callback itself backs off — post-stop, the pass
  performs zero disk mutation at *op* granularity, and the abandoned dir is
  byte-for-byte the state a restart re-registers.
- **The mDNS probe race, fixed at the source** (`6117554`, `6fcf049`).
  bonjour-service loses a probe-time name conflict silently — no event, no
  rename, publication dead. v0.1 mitigated the trigger (deviceId-suffixed
  default names, `7ce17d1`); the race itself remained for anyone configuring
  the same `node.name` twice. The fix leans on a fact the code already
  depended on: a live publication is echoed back to its own browser. So:
  every publication arms a deadline; only our own echo *under the current
  name* confirms it; unconfirmed means silently killed, and recovery is the
  existing bounded rename machinery. The interesting case is winning the
  tie-break — the peer renames, we don't, and our dead publication would have
  stayed dead forever; the watchdog is the only path that notices. Hardening
  followed its own review: one `timers` option so a mismatched
  schedule/cancel injection can't typecheck, and an identity-guarded callback
  that made the state guard redundant (the reviewer reproduced the mutation
  checks before believing that).
- **Rename diagnostics, wired end to end** (`4d6dfe2`, `0774b12`). Devlog 011
  taught that diagnostics die in assembly seams, so this unit was specified
  seam-first: `MdnsDiscovery.onDiagnostic` → aggregator → daemon →
  `homefleetd` stderr, with a test pinning each hop — including a new
  `daemon.assembly.test.ts` that wrap-and-records the real aggregator during
  a real `daemon.start()` and round-trips a message through the captured
  sink. Emissions are bounded (a hostile peer can force at most nine rename
  lines plus one exhaustion notice per process), and the exhaustion line is
  the one that matters operationally: it is how an operator learns their
  interface eats multicast. `configuration.md` now documents all three
  messages next to the `bindAddress` knob that fixes the usual cause.
- **Cosmetics** (`f454131`): the machine-specific fixture path and a
  redundant test teardown line. Plus one non-code item: the locked leftover
  worktree dir from the release session deleted cleanly.

## Review as a generator, not a gate

The loop this session kept producing work the plan didn't contain: Unit A's
op-granularity back-off, Unit B's two hardening rounds, and Unit D *in its
entirety* — the diagnostics unit exists because Unit B's quality reviewer
asked "who sees these renames?" and the honest answer was nobody. The final
cross-unit review then walked the whole chain in production wiring and
confirmed it live under default config. That's the 011 seam lesson applied
forward: this time the seam was checked before anything shipped, by
construction rather than by rig accident.

## Sharing the checkout

A second Claude session worked the same clone throughout — banner, docs
backlog, executor changes — interleaving five commits with this session's
nine, including a push of this session's first units mid-flight. Nothing
collided: disjoint files, and every implementer here ran `git status` first
and staged its own paths explicitly, never `-A`. Worth keeping as the
standing rule for shared checkouts; a five-hour session limit also cut one
reviewer off mid-verification, and resuming it from its transcript picked up
exactly where it stopped.

## Still written down, still honest

- The bin's stderr hop is the one diagnostics link pinned by no test (LOW;
  it predates this work and is three lines).
- `aggregator.test.ts` "candidate map is capped" can time out its cleanup
  hook under heavy machine load (seen once while the concurrent session ran;
  passes in isolation) — same family as the M9 discovery-flake note, dents
  the autonomy promise, worth a look before the suite gates anything public.
- Unpopulated stray checkout dirs are now never reclaimed (deliberate:
  deleting operator data is not the scan's call); revisit only if strays
  accrete in practice.
- The RFC now says probe-death renames are legal and bounded; peers see a
  re-announce with no collision on the wire.

Next: the deferred decision — announce v0.1 and gather feedback, or start
code-writing delegation. The base is as clean as it has ever been.
