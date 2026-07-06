# ADR-0005: Workspaces sync via git bundles over HFP

- **Status:** accepted
- **Date:** 2026-07-06

## Context

A worker executing a recon task or test run needs the repository content. Options: require a shared remote (forces cloud/network setup, breaks offline), network file shares (fragile cross-machine, permission-heavy on Windows), ad-hoc tarballs (loses history, no incrementality), or **git bundles** — git's native pack-based container that transfers over any byte channel and supports incremental ranges.

## Decision

Repo content travels over the HomeFleet Protocol as **git bundles**: a full bundle on first delegation for a repo, incremental bundles (`old-tip..new-tip`) afterwards. The worker maintains a per-repo cached workspace it unbundles/fetches into, keyed by repo identity. Workers only accept repos on their local **allowlist**.

Uncommitted changes are out of scope for v0.1 (documented limitation: delegation operates on committed state). If needed post-MVP, dirty-state can ride along as a patch applied to a detached checkout.

## Consequences

- No shared remotes, no cloud, works fully offline on the LAN.
- Incremental transfers keep repeat delegations cheap; first transfer costs full repo size.
- Git becomes a hard dependency on worker machines (acceptable: the target user is a developer).
- Committed-state-only is a real UX limitation to document clearly and revisit.
