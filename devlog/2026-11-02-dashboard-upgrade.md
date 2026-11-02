# Devlog 024: upgrading the fleet from the dashboard

**2026-11-02**

Fleet upgrade Phase 4 shipped as v0.6.0 and was proven on the rig. The
laptop's dashboard pushed v0.6.1 to the tower and then to the laptop itself.
The whole run took one button, one confirm, and about 40 s. The page reloaded
itself onto the new version, and so did a second tab nobody touched.

Plan: [2026-10-23-fleet-upgrade-phase-4.md](../docs/plans/2026-10-23-fleet-upgrade-phase-4.md).
Releases: [v0.6.0](../docs/releases/v0.6.0.md), [v0.6.1](../docs/releases/v0.6.1.md).

## What Phase 4 added

Until v0.6.0 the dashboard was read-only. Making it able to install code
raised a question the read-only page never had to answer: what stops another
page in the same browser from pressing the button?

The existing guards already cover most of it. The control port only listens
on loopback. The Host allow-list defeats DNS rebinding. The required
`x-homefleet-control` header forces a CORS preflight that a cross-origin page
can't pass. Phase 4 adds a **per-boot control token** on top, for the two
routes that start installs:

- Every boot, the daemon generates 32 random bytes and writes them as hex to
  `<dataDir>/control-token`, mode 0600 on POSIX.
- The dashboard page receives the token in a `<meta>` tag. Only `GET /`
  carries it, and the page is `no-store`, `no-referrer`, and not frameable.
- The CLI reads the file before each request.
- `POST /control/upgrade` and `POST /control/upgrade/prepare` require it in
  `x-homefleet-control-token`. The check is constant time and runs before the
  body is read. Everything else is unchanged.

The dashboard flow is verify-then-confirm. **Upgrade all**, a per-node
button, or **Upgrade this node** opens a dialog that first calls
`/control/upgrade/prepare`. That downloads and verifies the release without
starting anything, so the dialog can say "signature verified" and list what
each node will do before anything happens. Confirm starts the rollout and
polls its progress. When this node restarts, the token changes under the
open page, so the page reloads itself once (throttled through
`sessionStorage`).

The "⬆ 0.6.1 available" badge comes from a release lookup the daemon caches
for 6 h (15 min after a failure). Only the dashboard's own status poll
(`?dashboard=1`) refreshes it, so the CLI and scripts never make the daemon
call GitHub.

## Getting there

Nine tasks were run subagent-driven: sonnet implementers, opus reviewers, and
a final whole-branch review on fable. Two reviews earned their keep.

- **The dashboard UI (Task 7) needed two fix rounds.**
  - The first review found three real problems:
    - The upgrade badge only appeared when a peer's version *differed* from
      ours. In the normal case, every node equally behind, it never showed.
    - The "Restarting…" banner stuck around when this node's own step was
      refused, and would later mask a real outage.
    - The test pinning the page's POSTs to the two routes could be slipped
      past with a non-literal path.
  - The fix for the banner introduced a subtler bug, found by the re-review.
    The daemon answers `GET /control/upgrades` with the *saved* record of the
    last rollout, so on any node that had ever run one (every rig node), a
    self-only upgrade saw an old finished record and stopped watching. The
    page now ignores a record older than the confirm click.
- **The final review found one race and four doc errors.**
  - The race: two first-time prepares of the same version could delete each
    other's half-written cache, including one a starting rollout was already
    serving to peers. `prepareRelease` is now single-flight per version.
  - The doc errors included two about security. The release notes quoted the
    wrong error for an older CLI, and claimed mode 0600 on Windows, where
    Node ignores it and the per-user data folder's ACL is what protects the
    file.

## The rig proof

**0.5.5 → 0.6.0, from the CLI.** `homefleet fleet upgrade --to 0.6.0` on the
laptop: tower first, laptop last, "Rollout complete: 2 upgraded." Then the
token path was checked from the new 0.6.0 CLI. Re-requesting 0.6.0 got past
the token guard and was refused as "not newer", which is the right answer;
a token mismatch would have said "the daemon's control token didn't match".

That ran from a Claude desktop shell, the MSIX-packaged context from
[devlog 023](2026-10-23-first-fleet-push.md), while the daemon runs from
Task Scheduler. The shell's `%LOCALAPPDATA%` is virtualized. But the
package's copy of the data folder has no `control-token`, so the read
apparently fell through to the real file. Keep that in mind if a token
mismatch ever shows up from a Claude shell. The CLI's error message now
points at exactly this: two programs reading different data folders.

**0.6.0 → 0.6.1, from the dashboard.** v0.6.1 was a deliberately small
release, two dashboard headings from the final review's backlog. With both
nodes on 0.6.0:

1. The laptop's dashboard showed "0.6.0 ⬆ 0.6.1 available" on the tower row
   and on this node.
2. **Upgrade all** opened the dialog: "v0.6.1 — signature verified", "tower:
   will upgrade", "This node: will upgrade last".
3. After Confirm, the progress table showed the tower `pushing`, then
   `succeeded`; this node went `restarting`, and the "Restarting…" banner
   appeared.
4. The page reloaded itself onto 0.6.1, and the section now read "Last
   rollout", one of the two v0.6.1 changes.
5. **Negative check:** a second dashboard tab, open since before the upgrade
   and never touched, also came back on 0.6.1 by itself.

Afterwards the laptop daemon served the saved rollout
`{target: "0.6.1", state: "done", peers: [tower 0.6.0 → succeeded], self:
succeeded}`. `homefleet status` reported `lastUpgrade: 0.6.0 → 0.6.1
succeeded`, and `homefleet nodes` showed the tower on 0.6.1.

Fleet upgrade is now complete: signed releases, self-upgrade with rollback,
a daemon-run fleet rollout, and a dashboard that triggers it, all proven on
hardware.

## Notes for next time

- The tower's model showed `unreachable` after the proof. The cause is
  llama-server not running, which comes back after a tower reboot, not the
  upgrade. Since v0.5.5 a late llama-server turns `ok` within a minute.
- Use the dashboard in a normal browser. In the Claude browser pane the page
  stops polling while the pane is hidden.
- The dashboard's first status poll after a daemon start has no badge yet;
  the release lookup resolves in the background and the badge appears on a
  later poll.
- The open follow-ups are in the backlog under "Dashboard upgrade UI:
  follow-ups from the v0.6.0 final review". They include splitting `app.js`
  (527 lines), and preparing the exact version the badge shows.
