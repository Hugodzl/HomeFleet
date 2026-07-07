# Devlog 003 — M2: identity & transport, and the TLS callback that silently never runs

**2026-07-06**

Milestone M2 is done: `packages/daemon` now has device identity (self-signed cert via `@peculiar/x509`, device ID = the cert's SHA-256 fingerprint), an mTLS node server and client with fingerprint pinning on both sides, and the pairing-code flow. 152 tests green, all over loopback — the multi-daemon-on-one-machine constraint held.

## The trap: `checkServerIdentity` with self-signed certs is a no-op

The documented way to custom-verify a server certificate in Node is the `checkServerIdentity` callback. It is exactly wrong for a Syncthing-style trust model: Node only invokes the callback *after chain verification succeeds*, and a self-signed peer cert never passes chain verification. Setting `rejectUnauthorized: false` doesn't make verification pass — it skips the verification path entirely, callback included. The result is the worst failure shape there is: the handshake succeeds, the pin silently never runs, and every request goes out to an unverified peer. Nothing fails loudly, ever.

The fix is to stop asking the TLS layer for a favor it won't do: open the socket manually with `tls.connect`, await `secureConnect`, pull `getPeerCertificate()`, compute the fingerprint, compare against the expected device ID, and destroy the socket on mismatch — then hand the *already-verified* socket to the HTTP request. An integration test proves the property that matters: on mismatch the connection dies before a single HTTP byte is written. That connect-and-pin core is factored into one method (`connectPinned`) with an explicit ownership contract, because M5's SSE streaming must reuse it rather than reinvent it.

## Fail-closed file loading, or: `catch` blocks that eat EPERM

Two review findings shared one shape — error handling around file reads that treated *every* error as "file not there yet":

- **Trust store:** a transient EPERM at load would have produced a live, empty, *writable* store; the next `add()` persists the empty list and every previously paired device is gone. Permanently.
- **Identity:** a transient stat failure would have looked like "no identity yet" → silent regeneration → private key destroyed, device ID changed, every peer's pin of this machine now stale.

Both now swallow ENOENT only and rethrow everything else, with fault-injection tests (a directory where the file should be; an injected EPERM). In security-adjacent persistence, "fail open" and "data loss" are the same bug.

## Small things that were hard

- **Testing raw TLS garbage** (the port-scan survival test) had two non-obvious requirements: the garbage string must be long enough that its would-be TLS record length exceeds the maximum — so OpenSSL errors immediately instead of waiting for a full record — and the client socket needs `resume()` so the server's TLS alert gets consumed and `'close'` can actually fire.
- **Concurrent pairing is deterministic by construction:** the pairing code is consumed synchronously before the handler's first `await`, so two simultaneous correct-code requests can never both win. The test asserts exactly one acceptance.

## Review loop

The quality review returned 16 findings. Unlike M1's crop (type hygiene, future-proofing), several were genuine attack-surface items: unknown-path responses leaked route existence to unpaired peers (404 where 401 was owed), the pairing-code comparison wasn't constant-time (`crypto.timingSafeEqual` now, over fixed-width buffers), response buffering was unbounded (now capped by the same shared constant the server uses), and a failed `listen()` wedged the server instance. All 16 fixed in one pass; a fresh re-reviewer confirmed each fix at file:line against the diff and the suite. Two implementer trade-offs were reviewed and accepted: `MissingServerCertificateError` has no direct test (Node clients can't negotiate certificate-less suites by default — it's a pure fail-closed guard), and the client timeout is inactivity-based, with a total deadline deferred to M5 where streaming makes it meaningful.

## Takeaway

The dangerous failures in this milestone were all *silent*: a pinning callback that never fires, a catch block that eats EPERM, a timing leak. None would surface in a happy-path demo — which is why the tests that matter here are the negative-path ones: garbage on the port, mismatched fingerprints, injected filesystem faults, two peers racing for one code.

Next (M3): LAN discovery — mDNS advertise/browse, LocalSend-style UDP multicast fallback, manual entry, and a persisted known-nodes registry.
