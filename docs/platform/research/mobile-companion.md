# Mobile companion: feasibility

Status: research only, nothing implemented. Nothing here was checked on a phone or a LAN.

## Available interfaces
- **Local web server bound to 127.0.0.1 only, no authentication:** `docs/platform/EXTENSIBILITY_DESIGN.md` section 0 (`src/server.js`, `server.listen(port, '127.0.0.1')`). VERIFIED. A phone on the network cannot reach it, by design.
- **Read-only local API and LAN design:** `EXTENSIBILITY_DESIGN.md` section 1, design only. LAN access is described as a different product needing a pairing token, rate limits, an access log, auto-off, TLS or an explicit statement, and a threat model written first. Not built.
- **Browser protections:** `foreignRequest` Host and Origin checks and `PRIVATE_GET` (same document, section 0). They refuse non-local Host names, so a LAN page needs deliberate changes.
- **Cross-device sync design:** `EXTENSIBILITY_DESIGN.md` section 3, design only.
- **Live numbers the HUD reads:** open-CORS routes (section 0). VERIFIED.
- **Push notifications, accounts, a hosted relay:** none. The leaderboard Worker is the only backend (`leaderboard/`).

## Restrictions
- Anything beyond localhost exposes laps, setups and live data to the local network. No secret may leave (inventory in `src/sensitive.js`).
- A relay through Cloudflare would be a new hosted service: cost and privacy approval and data-protection duties.
- A PWA needs HTTPS for many features, which on a LAN means certificate handling; a native app is a separate project.

## Failure modes
- A token leaked through a screenshot, or a hostile device on the same Wi-Fi.
- Firewall prompts and IPv4/IPv6 differences (Windows PowerShell already trips over `localhost`, per CLAUDE.md step 6).
- A phone that sleeps or leaves the network: stale pages must say so, as the HUD does.
- Extra load on the 60 Hz loop if live data is streamed; reuse the existing snapshot cadence.

## Proof-of-concept scope
Step 0: build the localhost read-only API (design section 1) and use it from the PC. Step 1, only if wanted: a read-only reports view on the LAN behind the pairing token, with auto-off and a Settings access log, no live telemetry, no writes. A live pit-wall view last. Write the threat model before any code.

## Maintenance cost
Medium to high: security review, firewall and certificate support questions, and a second UI surface to keep working.

## Verdict
**Feasible but security-heavy, and not before the localhost API.** A read-only LAN report viewer is realistic; live telemetry on a phone and a hosted relay need explicit approval and a threat model first.
