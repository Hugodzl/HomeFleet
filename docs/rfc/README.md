# HomeFleet Protocol (HFP) — RFC drafts

The versioned protocol specification lives here.

- [`hfp-v0.md`](./hfp-v0.md) — HFP v0 (protocol version 0.1.0): LAN discovery, node identity & capabilities exchange (`hello`), pairing, job delegation, event streaming, results, and cancellation. The normative message shapes are the zod schemas in [`packages/protocol`](../../packages/protocol).

The protocol is designed so future job types (e.g. model-pool orchestration) extend it without redesign — see "Future Extensions" in the spec.
