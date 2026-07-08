# Devlog 008 — M7: workspace sync, and proving the exploit doesn't fire

**2026-07-07**

Milestone M7 is done: `delegate_task`'s `WorkspaceRef` is no longer a promise. A delegator now transfers a real repository to a paired worker as a git bundle over HFP — full bundle first, incremental `have..head` after — the worker verifies and materializes it into a per-repo cache, and a delegated job runs *in that checkout* and reads the content. 414 tests green, all on real git repos over real loopback mTLS; the M8 acceptance path (delegate a recon/command job against an actual repo on another machine) now has everything it needs but the machines.

This is the milestone that ingests attacker-influenceable data and runs `git` on it, so it was designed and reviewed as a security surface first and a feature second.

## Three ways a repo transfer could hurt you, and the structural answers

**Path traversal via repo identity.** The worker caches each repo in a directory keyed by the repo's identity — and that identity comes from the delegating peer. A `repoId` of `../../etc` cannot be allowed to escape the cache. The answer isn't sanitizing the string; it's never letting the string *be* a path: the cache directory is `SHA-256(repoId)`, so traversal is structurally impossible, not filtered. A test throws `../../x`, `C:\Windows\x`, and friends at it and asserts nothing ever appears outside the cache root.

**Checking out a commit the bundle didn't deliver.** A bundle claiming to deliver commit X could carry commit Y. The worker fetches the bundle's objects into a scratch ref, then refuses to advance the repo's tip unless the *delivered* commit equals the *claimed* `headCommit` and is actually present. A bundle that lies gets `COMMIT_NOT_DELIVERED` and the tip never moves. Because git objects are content-addressed and only the bundle's `HEAD` refspec is fetched, there's no substitution to be had.

**Code execution from received content — the one that matters most.** Bundles carry arbitrary committed content: `.gitmodules`, `.gitattributes`, anything. Git has many features that turn data into execution — hooks, clean/smudge filters, `textconv`, `fsmonitor`, `ext::` transport URLs, submodule recursion. Every one of them is *config*-defined, and a bundle carries objects and refs but never config. So the defense is to harden the config surface: every worker-side git call runs with `core.hooksPath` pointed at an empty directory, `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` pointed at nothing, `GIT_TERMINAL_PROMPT=0`, and (added in review) `protocol.ext.allow=never` and `fetch.recurseSubmodules=false`. A received tree can *name* a filter or a submodule, but the name resolves to nothing that's defined.

The reviewer didn't take that reasoning on faith. They built a superproject with a real gitlink submodule whose `.gitmodules` URL was `ext::sh -c "touch /tmp/pwned"`, bundled it, and ran the exact worker fetch-and-checkout flow under the daemon's env hardening. The `ext::` URL did not execute, the submodule was not cloned, no hook ran. That's the difference between believing a boundary holds and watching the attack bounce off it.

## The discipline that keeps recurring: no unbounded peer-driven state

M3 capped the known-nodes registry; M5 capped the job queue and retention; M6 capped the MCP request body. M7's version was subtler and review caught it: the code *claimed* to bound disk use, but the LRU cap only bounded the number of materialized checkouts — the bare object store grew forever, because `git fetch` imports a bundle's objects to disk *before* the delivered-commit check can reject it. A paired peer could accrete objects without limit via repeated (even rejected) uploads. Two fixes closed it: a `git bundle list-heads` pre-filter that rejects a header-mismatched bundle before importing anything, and a periodic `git gc --prune=now` (gated on a fetch counter, run under the per-repo lock) that reclaims unreachable objects without touching in-use checkouts. And the comments that overstated the guarantee were corrected — a false "cannot fill the disk" comment is worse than none, because it stops the next reader from looking.

## What was deliberately deferred

Two review findings were pushed to M9's daemon assembly rather than forced into M7. A running job's checkout can still be LRU-evicted out from under it — the correct fix is a reference count with a release handle the job manager calls on completion, which requires a consumer contract that only exists once M9 wires the real daemon; its impact on trusted two-machine dogfooding is negligible (it takes dozens of concurrent distinct-commit jobs to trigger). And the store has no `stop()` to cancel in-flight git on shutdown — also an assembly-time concern. Both are written down with their exact fixes, not left as folklore.

## Takeaway

The build-order paid its clearest dividend here: because every prior milestone had drilled "untrusted input must be bounded and must not execute," M7 arrived already shaped that way, and review was able to spend its effort *verifying* the hard guarantee (running the submodule exploit) rather than discovering a missing one. The remaining find — unbounded object accretion — was exactly the failure mode this project has learned to look for, hiding behind a comment that said it couldn't happen.

That completes the product spine: identity, transport, discovery, execution, dispatch, the MCP front door, and now real repository transfer. Everything a coding agent needs to delegate work to another machine and get an answer back exists and is tested on one machine.

Next (M8) is not more code — it's the rig. Install `llama-server` on the tower and Ollama on the laptop, run the elevated firewall-setup command, pair the two machines for real, and delegate a recon job from a Claude Code session on one box to a local model on the other. That milestone needs hands on two physical machines and a benchmark devlog; it's where the single-machine test suite meets the real LAN.
