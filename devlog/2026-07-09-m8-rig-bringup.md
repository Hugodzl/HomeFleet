# Devlog 010 — M8: the rig comes up, and it teaches us the thing loopback couldn't

**2026-07-09**

M8 is the milestone no amount of single-machine testing could stand in for: two
real computers, two different serving stacks, paired over the LAN, one delegating
real work to the other's local model. Everything the milestone needed already
existed and was green on one machine (M9's autonomous half). M8 was about finding
out whether it's *useful* — and, as it turned out, catching the class of bug that
only appears when the checkout actually lands on a second, differently-configured
Windows box.

## The rig

- **Laptop** (i7-6700HQ, GTX 1060 6GB): Ollama on CUDA serving **Qwen3.5-4B**
  Q4_K_M, fully on GPU. NVIDIA driver 581.42 (≥570, so no silent CPU fallback).
- **Tower** (Ryzen 5600X, RX 6700 XT 12GB, 32GB): llama.cpp `llama-server` on
  **Vulkan** serving **Qwen3.6-35B-A3B** Q4 with `--n-cpu-moe` MoE offload.
- Two serving stacks on purpose — raw `llama-server` and Ollama — so both
  integration paths get dogfooded. To HomeFleet each is just an
  OpenAI-compatible endpoint.
- Each machine: `homefleet setup`, the elevated `New-NetFirewallRule` commands
  (HFP TCP 56370 + discovery UDP 56371, Private/LocalSubnet), `pnpm build`, then
  `homefleetd` started as a detached process. Distinct `node.name` per machine
  (`laptop` / `tower`).

## Two agents, one LAN mailbox

M8 was run by **two Claude Code sessions at once** — one per machine — with a
human (Hugo) doing only the physical installs and the elevated commands. To let
the two sessions coordinate without a human relaying values between them, we
stood up a tiny **zero-dependency HTTP "mailbox"** on the laptop
(`192.168.68.76:56380`): `POST /msg`, `GET /msg?since=&from=`, and a long-poll
`GET /wait` so a background watcher on each side wakes its session the instant the
peer posts. OneDrive wasn't shared across the machines and SMB across two
possibly-different-account boxes is fiddly, so a small LAN service was the least
friction — and it dogfoods the "just a service on the LAN" ethos.

It paid off immediately: the tower posted its pairing code to the mailbox, the
laptop's watcher woke, the laptop ran `pair connect`, and mutual trust was
established — no human copy-pasting a short-lived code between two keyboards.
Discovery even filled in the reverse-direction reachability with no static-node
fallback needed.

## The good news: it's useful

The headline delegation — **recon by repoId, laptop → tower** — worked, and the
answer was genuinely good. From an MCP client (the SDK Streamable-HTTP client,
exactly what a coding agent uses) pointed at the laptop's local daemon, a
`delegate_task` named repo `homefleet` and the tower's device ID. The daemon
git-bundled the repo to the tower (~6 s cold), and the tower's local
Qwen3.6-35B-A3B explored the working tree and returned an accurate architecture
summary — all three packages and their responsibilities, and the correct
delegated-job path (MCP front → daemon resolves the paired device → git-bundle
sync → mTLS to the worker's HFP service → job manager → executor → results back).
No hallucinated packages.

- End-to-end (delegate → terminal, MCP polling): **~105 s**
- Executor wall (from `JobResult.stats`): 98.5 s over **12 read-only tool calls**
- Tokens: 10,101 prompt / 987 completion (aggregate over the 12 tool round-trips)
- `llama-server`'s own rates on the tower: prompt eval **~182 tok/s**, generation
  **~22 tok/s** — squarely in the design doc's 20–30 tok/s estimate for
  Qwen3.6-35B-A3B Q4 with `--n-cpu-moe`. (The ~10 tok/s aggregate above is a
  floor: it includes 12 tool round-trips + prompt processing, not just gen.)
- A **cancel** mid-run transitioned the job to `canceled` cleanly; a second
  delegation to the already-synced tower showed the **incremental** bundle path
  (129 ms vs the 6 s cold sync).

That is the M8 acceptance question — *can a coding agent on one machine put
another machine's local model to work, over the LAN, with no cloud?* — answered
yes.

## The bug the rig existed to catch

The *reverse* direction — a **command** job, tower → laptop (`git rev-parse
HEAD`) — is where the rig earned its keep. The delegation itself worked on the
first try: `delegate_task` → git-bundle sync → dispatch reached the laptop's
command executor, HEAD `b541d74` synced correctly. Then the laptop's git
**checkout** failed: `git exited 128, "Filename too long"`. Windows MAX_PATH
(260).

Getting to the real cause took three wrong turns, which is the interesting part:

1. **"Enable `core.longpaths`."** Set `git config --global core.longpaths true`
   on the laptop. No effect.
2. **"It's the OS registry key."** The tower had checked out fine; comparing the
   two machines showed the tower had `HKLM\...\FileSystem\LongPathsEnabled=1` and
   the laptop didn't. Set it, restarted, retried. *Still* failed.
3. **Read the source.** Both prior theories were wrong for the same reason:
   `packages/daemon/src/workspace/git.ts` deliberately points
   `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` at a **nonexistent path** — a real
   security property (received content can't be influenced by ambient git
   config) — so *no* user/global/system setting reaches the worker git. And
   `workerConfig()`, which supplies the `-c` flags the worker git *does* honor,
   set `core.hooksPath` / `protocol.ext.allow=never` /
   `fetch.recurseSubmodules=false` but **not** `core.longpaths`. Git does its own
   >260 check and refuses `worktree add` without it — the OS registry key alone
   doesn't satisfy git's internal check. The tower had only ever succeeded
   because its checkout-base path happened to stay under 260; the laptop's was
   longer.

The fix is one line — add `core.longpaths=true` to `workerConfig()` (win32 is
where it matters; harmless on POSIX). But it was worth doing under TDD, and the
test itself taught a second lesson: the first version of the regression test made
the *checkout directory itself* exceed 260 and hit a **different** git limit —
`fatal: '$GIT_DIR' too big` — which `core.longpaths` does *not* fix. That's a
real but separate constraint (the worktree's own gitdir path), and not the case
real repos hit. The corrected test uses a moderate checkout dir and a deep
*file* inside the repo, reproducing the actual "Filename too long" mode:
red without the flag, green with it. Full gate green afterward (biome, tsc, 589
tests).

The lesson isn't "we forgot a flag." It's that the daemon's *correct* config
isolation created a place where the operator's environment silently can't help,
and only a second machine with a longer base path — plus reading the source
rather than trusting either plausible environmental theory — surfaced it. Exactly
the seam between "unit test passes" and "two-machine demo works" that M9's devlog
predicted the expensive bugs would live in.

## Honest state

- Recon delegation (laptop → tower, real 35B model): **works**, useful output,
  timings above.
- Cancel + incremental sync: **works**.
- Command delegation (tower → laptop): the pipeline was always proven; the
  worker checkout is fixed by the `core.longpaths` change and **confirmed
  end-to-end** — after rebuild + restart, `git rev-parse HEAD` ran on the laptop
  in the synced worktree and returned exactly the synced `b541d74` (exit 0,
  worker wall 76 ms), round-tripping tower → laptop → tower.
- The tower's own checkout only stays green by path-length luck; it should adopt
  the same build (git pull once this is pushed). The durable follow-up (keep the
  worker cache path short so it never approaches 260, independent of git's
  long-path mode) is tracked separately.

## Next

M8's question is answered. The remaining v0.1 work is the public release polish
(M9's release half) and folding the long-path fix's sibling (short worker cache
path) in as hardening. The rig stays — it's now the place real-model behavior and
Windows-specific reality get checked before they surprise a user.
