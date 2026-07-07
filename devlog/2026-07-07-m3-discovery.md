# Devlog 004 — M3: LAN discovery, where identities are free

**2026-07-07**

Milestone M3 is done: daemons now find each other. mDNS advertise/browse via `bonjour-service`, a LocalSend-style UDP multicast fallback, static config entries, a deduplicating aggregator, and a persisted known-nodes registry — plus a Discovery section in the RFC. 230 tests green, all still on one machine: the mDNS layer runs against an injectable fake backend, and the UDP tests use real sockets over loopback with an injectable unicast send target, so nothing depends on actual multicast delivery.

## The stance that shaped everything: announcements are hints

Discovery packets are the first untrusted bytes HomeFleet accepts, so the design rule was set before the first schema: an announcement can *suggest* "there's a node named X at this address" but can never establish anything. Identity comes only from the mTLS fingerprint pin at connect time; a forged announcement at worst causes a connection attempt that fails the pin. That stance cascaded into concrete decisions: datagrams are size-capped *before* parsing, schema-validated after, and dropped silently on any failure; the reply-storm guard is structural (a `kind: announce | response` tag in the wire format — responses are never answered) rather than heuristic; and the candidate's host comes from the UDP packet's source address, not from the payload — payloads don't get to claim an address.

## What the review loop caught this time

The quality review's two Important findings were both consequences of the same blind spot: **on an unauthenticated channel, identities are free.** A device ID is just 64 hex chars in a datagram, so a LAN attacker can mint thousands — and every fresh one was adding a never-evicted map entry *and* a permanently persisted registry entry, each sighting queueing a full-file rewrite. Free disk-and-memory DoS. The fix is boring and effective: a 512-entry cap with oldest-`lastSeenAt` eviction shared by both layers, plus write coalescing (re-sightings that only move `lastSeenAt` by under a minute don't touch the disk). The other Important was a classic async lifecycle race: `stop()` during a pending socket bind found nothing to stop, then `start()` resumed and claimed the socket — an orphaned announcer with a 60-second timer, unreachable forever. The test that pins the fix is satisfying: race a real bind, then prove the port rebinds *without* `reuseAddr`.

## mDNS collisions without a conflict API

`bonjour-service` gives no programmatic name-conflict signal (probe conflicts get `console.log`ged and the service silently stops), so collision handling lives in our layer, detected from browse results. Two rules keep it sane: the tie-break is deterministic — the lexicographically larger device ID renames, so exactly one side of a colliding pair moves and rename storms can't happen — and a rename requires a browse result whose TXT *decodes to a different device ID*. That second clause came out of review: without it, a garbage-TXT squatter on our instance name (or our own echo coming back mangled) would force pointless renames. Yielding to something that's either broken or hostile buys nothing.

## Small war stories

- A new clamp on registry-loaded timestamps (defense against wall-clock rollback) immediately flagged a test fixture whose "previously seen node" was dated a year in the *future* relative to the test clock. The guard found its first bug before ever shipping — in our own tests.
- mDNS instance names have a 63-byte label limit and node names are UTF-8; truncation has to backtrack over continuation bytes or a multi-byte character gets split. Tested at the exact boundary.
- Tooling hazard worth remembering: `\uXXXX` escapes in editor tool calls got converted to raw control bytes in source twice. Caught by byte-level inspection; the re-review ran a repo-wide scan for raw control characters (clean) before approving.

## Takeaway

M2's lesson was that the dangerous failures are silent; M3's is that *unauthenticated channels invert your assumptions* — anything a peer can say, an attacker can say cheaply and in volume. Caps, eviction, and structural (not behavioral) storm guards have to be in the design, because "who would bother?" is not a threat model.

Next (M4): executors — the allowlisted command executor and the minimal agent tool-loop against a mock OpenAI-compatible endpoint, with budgets.
