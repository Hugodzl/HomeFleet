# ADR-0004: Syncthing-style trust — device ID = cert fingerprint, mTLS, pairing codes

- **Status:** accepted
- **Date:** 2026-07-06

## Context

Daemons accept jobs that read repos and execute commands — the LAN API must not be open. Comparable consumer products span a spectrum: Ollama ships zero auth (14k+ exposed instances on Shodan), LM Studio uses an optional bearer token, LocalSend uses self-signed HTTPS + optional PIN, and Syncthing uses per-device certs where the **device ID is the certificate fingerprint**, with mutual TLS and fingerprint pinning against an explicit paired-device list — no CA, no accounts, consumer-proven for over a decade.

A self-managed CA adds complexity with no benefit at 2–10 devices.

## Decision

Each daemon generates a keypair + self-signed certificate on first run. The device ID is the certificate's SHA-256 fingerprint. All daemon-to-daemon traffic is HTTPS with `requestCert: true` and `rejectUnauthorized: false`, followed by a **manual fingerprint check against the paired-device list**. Pairing exchanges short human-readable codes to confirm fingerprints out-of-band. Unpaired peers are rejected per-request at the HTTP layer: the peer certificate's fingerprint is re-checked against the paired-device list on every request. This is stronger than a connection-time check — unpairing a device takes effect immediately, even for connections that were already open.

Certificate tooling: **@peculiar/x509** (WebCrypto-based, actively maintained). Explicitly not node-forge — unmaintained since 2022 with an unfixed ASN.1 signature-verification bypass.

## Consequences

- No CA, no cloud account, no secrets to sync; the private key never leaves its machine.
- Pairing UX is one short code per machine pair — the Syncthing pattern users already understand.
- Worker-side authorization still applies on top (repo allowlist, command allowlist); transport identity is necessary, not sufficient.
- The MCP front is separate: localhost-only, never exposed on the LAN.
