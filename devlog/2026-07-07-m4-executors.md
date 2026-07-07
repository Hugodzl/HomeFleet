# Devlog 005 — M4: executors, and two ways untrusted input bites on Windows

**2026-07-07**

Milestone M4 is done: `packages/executors` now holds the two execution engines a worker runs — a command executor (allowlisted, sandboxed spawn) and the agent executor (ADR-0003's minimal tool-calling loop against any OpenAI-compatible endpoint), sharing one safe-spawn core and a scripted mock endpoint for tests. 326 tests green, the only fake being the mock LLM; every process, file, symlink, and HTTP exchange in the tests is real.

The build order paid for itself: the contract, spawn core, command executor, OpenAI client + mock, and sandboxed tools each landed as their own reviewed commit before the agent loop tied them together. Two of those commits happened across a network outage that killed the implementer mid-run twice — recoverable precisely because the tree was clean and the gate was green at each commit boundary.

## The cmd.exe argument-injection trap

The headline finding, caught by review and confirmed by actually running it. On Windows, Node refuses to spawn a `.cmd`/`.bat` file without a shell (EINVAL since CVE-2024-27980), so a batch target has to be wrapped as `cmd.exe /d /s /c <target> <args...>`. That wrap quietly re-introduces a shell for the arguments — and `cmd.exe` runs its own metacharacter pass. A space-free argument like `&whoami` is *not* quoted by Node's argv builder, reaches `cmd.exe` bare, and the `&` starts a sibling command. A reviewer proved it live: `cmd.exe /d /s /c greet.cmd &whoami` printed a username. This is not exotic — M8's headline demo is "run `pnpm test` over there", and `pnpm` on Windows *is* `pnpm.cmd`, so the injectable-args path is the default path, and the arguments come from an untrusted place (the model's `run_command`, or a delegating peer's command job).

The first instinct — caret-escaping (`^&`) — is a trap, and we're glad we tested it instead of shipping it: a caret-escaped `&whoami` *still ran* once the batch re-expanded `%1`. Caret-escaping is exactly the "best-effort escaper that silently passes dangerous input" the BatBadBut advisory (CVE-2024-24576) warns against. The fix is the one CPython's `subprocess` and Rust's std adopted: double-quote each argument (inside quotes, `cmd` treats `& | < > ( ) ^` as literal), pass the whole post-`/c` command as one pre-quoted token with `windowsVerbatimArguments` so Node's quoter stays out of it, and — critically — **fail closed** on the characters quotes can't contain (`%` env-expansion, `!` delayed-expansion, CR, LF). An argument with one of those is rejected with `INVALID_REQUEST`, never spawned. The allowlist gates the command *name*; the quoting gates the *arguments* the allowlisted target receives. The end-to-end test now fires `&whoami`, `a|b`, `foo^bar`, and a sentinel-writing injection at a real batch file and proves none of them execute a second command.

## A ReDoS the budget can't stop

The second reviewer — an independent pass — caught what the first missed: `grep` compiled the model's pattern with `new RegExp()` and ran it synchronously across every line of every file. A catastrophic-backtracking pattern (`(a+)+$` against a long non-matching line) blocks the single-threaded event loop *indefinitely*, and the loop's `maxWallMs` budget cannot save it — the budget is checked between iterations and armed on the fetch, and a blocked event loop can't fire its own `setTimeout` anyway. So a pattern chosen by the model, or injected via repo content (prompt injection is in scope), takes down cancellation, the wall budget, and any concurrent jobs on that worker. The fix runs the walk-and-match inside a `node:worker_threads` worker (built from an inline string with `eval:true` — no new dependency, no TS/ESM transform to fight); the main thread arms a hard timeout and `terminate()`s the worker if it overruns, returning a tool-error to the model. Plus a per-file byte cap and a total-scanned-bytes cap, so one multi-GB file can't OOM the worker either.

That a second, fresh reviewer found a worker-killing DoS the first review didn't is the whole argument for adversarial review in one data point.

## Two smaller guarantees

- **A fired timeout must always end the job.** `killTree` uses `taskkill /t /f` on Windows, but if taskkill exits nonzero against a protected child that never closes, `safeSpawn` would await a `close` that never comes — an unbounded hang wedging a job slot. A post-kill watchdog force-settles after a grace period with `exitCode: null`, so the timeout's promise ("this job will end") holds even when the kill fails.
- **Everything model- or child-controlled is byte-bounded so results can always ship.** The recon summary was the one gap — the model's final content became `JobResult.summary` uncapped, and a multi-MB summary is a result the 1 MiB transport can't deliver, lost exactly when something went wrong. It's now capped like the stream capture, `read_file`, and event summaries already were.

## Takeaway

M3's lesson was that unauthenticated channels make identities free; M4's is that *the shell you didn't think you invoked is still a shell*. The dangerous surface here wasn't the LLM or the network — it was `cmd.exe`, reached through a Windows compatibility shim, parsing arguments an attacker controls. The safe-spawn core treats the allowlist as the boundary for *names* and quoting-or-refusal as the boundary for *arguments*, because on Windows those are two different problems.

Next (M5): dispatch end-to-end — delegate a job, stream its events, collect the result, cancel mid-flight, across N local daemons. The executors plug into the job manager here, and the SSE stream must extend the authenticated route layer, not bypass it.
