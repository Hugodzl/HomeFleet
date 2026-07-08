# Devlog 009 — M9: the daemon assembles, and the product runs

**2026-07-08**

Milestone M9's autonomous half is done. Through M8 the pieces all existed and were tested — identity, transport, discovery, executors, dispatch, the MCP front, workspace sync — but nothing composed them into a thing you could *start*. M9 built that: one `Daemon` class wires every module into a running `homefleetd` process, a `homefleet` CLI drives it, `tsup` packages both into bins that run under bare `node`, and the docs tell an operator how to use them. The single-machine test suite went from 414 to **586** tests, all green; `pnpm build` produces three runnable bins; and the end-to-end path a coding agent actually cares about — *delegate a repo by name, it transfers to another machine and runs there, the answer comes back through MCP* — is proven by an integration test driving two real daemons over real mTLS and the real MCP SDK client.

What's left in M9 is the part that needs hands on hardware: M8's two-machine rig bring-up (llama-server on the tower, Ollama on the laptop, the elevated firewall command, a real pairing, a benchmark) and the eventual public publish. Both are human-gated and waiting.

## What M9 delivered

- **Two deferred M7 fixes, landed first as contract changes.** In-flight checkouts are now *pinned*: the workspace resolver hands back a `{ dir, release }` handle, the job manager releases it when the job goes terminal, and LRU eviction skips anything pinned — so a running job can no longer have its checkout `worktree remove --force`d out from under it. And `WorkspaceStore.stop()` threads an `AbortController` through every worker-side git call, so a daemon shutdown mid-fetch cancels git instead of waiting out the 120s timeout (and dodges the Windows `rm` EBUSY teardown race).
- **Config grew from two sections to ten** — node name, HFP/MCP/control binds, executors, advertised models, job limits, and a delegating-side `repos` map — and became *strict*: unknown keys are rejected, not silently dropped, so a typo can't quietly re-enable a channel the operator disabled.
- **A real NodeInfo profile** replaced M6's empty stub — roles derived from configured executors, live job load, real hardware facts — validated eagerly so a bad profile fails at assembly, not on the first `hello`.
- **The `Daemon` assembly** with a start order chosen so its reverse is the correct teardown, and a single teardown stack that doubles as the partial-start-failure unwind (a daemon that fails to come up leaks no sockets). MCP front → discovery → node server → jobs → workspace store, torn down in that order.
- **Sync-on-delegate**: `delegate_task` now transfers the named repo (git bundle over HFP, full or incremental) to the worker *before* dispatching, so the agent just names a `repoId` and the daemon does the rest. This is the piece the M8 recon-against-a-repo demo was missing.
- **A loopback control API + the `homefleet` CLI** (`setup` / `pair` / `nodes` / `status`). Pairing is live server state — the responder's `PairingManager` and the running daemon's in-memory trust store — so the CLI can't just edit files; it drives a small 127.0.0.1 control channel instead.
- **A build step** (`tsup`) bundling only our own workspace source into each bin and keeping third-party deps external, so the bins run under bare `node` with no `tsx`.

## The theme: adversarial review earned its cost

M9 was executed as subagent-driven development, and for the back half — under a directive to optimize for correctness over speed — each unit ran as a small orchestrated workflow: one implementer, then a fan-out of *independent review lenses* (spec, security, robustness, tests, Windows-accuracy), then an adversarial verify pass that defaulted every finding to "not real" until confirmed against the code, then a fix pass. It kept finding things a single reviewer plausibly wouldn't:

- **The firewall generator shipped two critical bugs.** The Windows-accuracy lens — reviewing the *generated command strings* as if pasting them into an elevated PowerShell — caught that a task name flowing into the autostart command was evaluated as a PowerShell subexpression (`$(...)` injection), and that the `/TR` value fragmented into garbage the moment a path contained a space. The default Node path is `C:\Program Files\nodejs\node.exe`. That second bug would have fired on essentially every real machine. The fix was verified live against a real PowerShell and a native child process, not just asserted.
- **The control API's browser defense is honest about its limits.** The security lens confirmed the custom-header CSRF guard stops a web page but not a co-resident same-user process — then reasoned that such a process already holds the daemon's private key, so it grants no new capability, and the right move was to *document* the boundary (with the per-boot-token hardening path) rather than pretend a network defense solves a local-trust question.
- **The cross-cutting bug only the final whole-milestone review could see.** No per-unit review could catch it because it lived in the seam between units: CLI-driven pairing added the peer to the trust store but never seeded the known-nodes registry, so a freshly-paired node showed `reachable: false` until live mDNS/UDP happened to find it — and if discovery is flaky (a known Windows condition), it stays unreachable with no CLI fix. The reviewer found it by standing up two real daemons and driving the actual control-API HTTP surface, which nothing in the suite did. The fix seeds the registry on outbound pairing, and the regression test that now guards it deliberately runs with discovery *disabled* — so it fails without the fix, by construction.

The lesson isn't "more reviewers." It's that different *lenses* and an *adversarial* posture (refute by default; drive the real surface, not the plumbing) surface a different class of defect than "does this look right," and that the gap between what a unit test proves and what a two-machine demo needs is exactly where the expensive bugs hide.

## Honest state

586 tests pass on a clean run; the bins build and start under bare `node` (the stdio shim answered a real MCP `initialize`; `homefleetd` came up and minted an identity). But everything is still single-machine and mock-model: the agent executor's real path — a local model doing recon — is only exercised against a scripted mock endpoint. Whether Qwen3.6-35B on the tower actually returns a useful summary in a reasonable time is an M8 question, unanswered.

Deferred, written down, not folklore:

- **mDNS same-hostname collision.** Two daemons that default to the same hostname can hit a probe race where the loser's `bonjour-service` publication dies with a bare `console.log` the daemon never sees, and the browse-time tie-break doesn't cover it. Mitigated by the UDP channel and the known-nodes registry, so the fleet still works — but the fix (disambiguate the default name with a short deviceId suffix) matters for exactly the tower+laptop setup M8 uses. Immediate workaround: set `node.name` per machine.
- **Version drift**: `DAEMON_VERSION` says 0.1.0 while every `package.json` says 0.0.0. Reconcile when versioning is formalized.
- **Bin invocation**: `pnpm install` doesn't put `homefleet` on `PATH` (nothing depends on the daemon package), so the documented invocation is `node packages/daemon/dist/bin/*.js`. A global link mutates the nearest `package.json` up the tree and was deliberately not recommended.
- **Discovery test flakiness**: `known-nodes`/`udp` tests occasionally time out under sustained parallel load (pass in isolation and on rerun). Environmental, not a product regression, but it dents the "autonomy-critical test suite" promise — worth fake-timers or a discovery-test concurrency cap.

## Next

M8 is not code — it's the rig. Two machines, two serving stacks, the elevated firewall command run for real, a genuine pairing, and a recon job delegated from a Claude Code session on one box to a local model on the other, with a benchmark to show for it. Everything that milestone needs now exists and runs on one machine. What it will teach us is whether the thing is *useful*, which no amount of loopback testing can.
