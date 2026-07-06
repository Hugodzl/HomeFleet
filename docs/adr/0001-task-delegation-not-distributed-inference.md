# ADR-0001: Distribute tasks between agents, not tensors between GPUs

- **Status:** accepted
- **Date:** 2026-07-06

## Context

The founding goal is to let home users with multiple computers get more out of local AI agents. Two fundamentally different architectures can claim "use Computer B to help": **distributed inference** (pool GPU/RAM across machines to run one bigger model — layer/tensor parallelism) and **agent-level delegation** (each machine runs its own model; an agent on machine A farms out whole subtasks to machine B).

Market research (2026-07-04) found distributed inference crowded and technically brutal for a solo builder: exo (45k+ stars), GPUStack, LocalAI federated mode, and llama.cpp RPC already own it, and home-LAN bandwidth makes it a memory-pooling win rather than a speed win. Agent-level coordination across home machines, by contrast, had **no** occupant of the specific niche: a thin, MCP-native coordinator with LAN discovery and local-model executors. Existing neighbors (Fusion, AgentsMesh, ai-maestro) are heavyweight platforms that replace the user's workflow.

## Decision

HomeFleet distributes **tasks**, not tensors. The unit of distribution is a whole job (recon analysis, command run — later, code changes) executed on one node with one locally-served model. We never split a model across machines.

## Consequences

- Sidesteps LAN-bandwidth constraints entirely; works fine on Wi-Fi.
- Weak machines stay useful via role-typed capabilities (execution node vs inference node).
- The value ceiling is bounded by single-node model quality — delegation adds throughput and parallelism, not smarts. Bigger-model pooling remains future work ("Product A") as an orchestration layer over existing tech (llama.cpp RPC), reusing this project's fabric (discovery, pairing, transport, job dispatch), not reinventing inference.
