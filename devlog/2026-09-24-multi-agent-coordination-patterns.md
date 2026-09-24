# Devlog 018 — what a multi-agent product teaches a thin delegation layer

**2026-09-24**

SpaceXAI shipped Grok Bot in beta in August 2026: persistent agents that
coordinate with each other and work across the apps a team already uses. It
touches the same question HomeFleet does — how agents hand work to other
agents — so it was worth a look for patterns. Six ideas came out of it and
are now in the [backlog](../docs/backlog.md#coordination-ideas).

## What's actually public

Very little about the mechanism. Every write-up (InfoQ, VentureBeat, The
Next Web, a Substack teardown) describes user-facing behaviour and none
describes a protocol, message format or architecture. What can be said:

- **Persistent agents, one cloud VM each.** They keep working when the
  user's laptop is closed, and they drive apps through the UI (computer use)
  rather than APIs.
- **Shared threads are how they talk.** Bots message each other and share
  context in threads; several can sit in one group conversation and
  "assign ownership, transfer work and coordinate among themselves."
- **A hierarchy with a coordinator.** A "Chief of Staff" bot sits above
  specialists and routes each job only to the relevant ones, so the user
  stops being the switchboard. Specialists can also talk directly, but the
  product explicitly avoids wiring every agent to every other.
- **Asking for approval.** Agents learn when to interrupt for a decision and
  when to carry on.
- **Memory and routines.** Long-term memory of past work and preferences;
  workflows taught by demonstration and saved as reusable routines/skills.

## Where HomeFleet stands against that

HomeFleet is hub-and-spoke with one-shot jobs. The agent in front is the
only coordinator; workers don't talk to each other, can't ask anything
mid-job, and remember nothing between jobs. Most of that is on purpose —
the thin-layer, MCP-native design and the Syncthing-style trust model
([ADR 0004](../docs/adr/0004-syncthing-style-trust-model.md)) — and it
should stay that way.

So three things are deliberately **not** borrowed:

- **Cloud VMs.** The whole point is that jobs never leave the house.
- **UI-driven computer use.** Workers act on repos and allowlisted commands;
  that scope is what makes delegation safe to run unattended.
- **Worker-to-worker meshes.** Letting workers delegate to each other would
  turn a pairing graph into a trust graph. Even Grok Bot keeps its topology
  deliberately small.

## What does transfer

The gap Grok Bot throws into relief is what an unattended local model does
when it's stuck, or when a task spans more than one step. Today a weak model
either guesses or fails quietly, and every multi-step flow round-trips
through the front agent's context — which spends exactly the cloud tokens
HomeFleet exists to save. The six backlog entries, most relevant first:

1. **Mid-job clarification requests** — the approval pattern. A `question`
   event on the existing SSE stream plus an answer endpoint; `seq` and
   `Last-Event-ID` replay already cover reconnects.
2. **Job chaining** — the shared-thread pattern, without the mesh. One job's
   output feeds the next on another node, bypassing the front agent. A first
   slice of the roadmap's multi-node fan-out.
3. **Automatic node routing** — the coordinator's selective routing, done by
   the daemon over the [model catalog](2026-07-21-model-catalog.md).
4. **Saved task templates** — routines, as named delegations exposed over
   MCP.
5. **Node roles** — specialists, as a prompt + model + executor bundle in the
   capability advertisement.
6. **Per-repo worker memory** — recon summaries cached by commit. Last,
   because staleness is the real risk.

The first two are the ones worth brainstorming next: both address that gap
directly, and neither weakens the trust model.

Sources: [InfoQ](https://www.infoq.com/news/2026/08/grok-bot-agent/),
[VentureBeat](https://venturebeat.com/orchestration/spacexais-grok-bot-turns-agents-into-persistent-digital-coworkers-that-can-operate-your-apps-for-120-per-month),
[The Next Web](https://thenextweb.com/news/spacexai-grok-bot-ai-agents-cursor),
[MLearning.ai](https://mlearning.substack.com/p/grok-bot-inside-spacexais-agent-playbook).
