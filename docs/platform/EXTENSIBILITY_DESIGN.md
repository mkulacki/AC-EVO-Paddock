# Extensibility: design only (PL11)

**Status: not implemented. Needs approval** before any of it is built. Nothing in this document exists in the code.
Each part starts from the security model, because each one opens Paddock's data or code path to something new.
What PL11 did build (backups, recovery, report files, demo) is in `docs/platform/DATA_OWNERSHIP.md`.

## 0. The security model today (the baseline every part must keep)

- **One local server**, bound to `127.0.0.1` only (`src/server.js` `server.listen(port, '127.0.0.1')`), no
  authentication. It is safe because only this PC can connect and browsers are kept out:
  `foreignRequest` refuses unknown `Host` names (DNS rebinding), foreign or opaque `Origin`s, cross-site writes, and
  cross-site or same-site reads of private data (`PRIVATE_GET`). The in-game HUD reads open-CORS routes that carry live
  numbers only.
- **One inventory of secrets** (`src/sensitive.js`): the Gemini key and server passwords (secret), the leaderboard
  token and Steam identity (sign-in). Backups, diagnostics, exports and the page view all go through it.
- **Data stays local** unless the driver switches on a service (AI, leaderboard sharing, update check), each
  separately.
- **Unsigned build**, check-and-notify updates only (decision D2): nothing is downloaded or installed by Paddock.

Rules for everything below: off by default; no secret ever leaves through it; no path or file access; every new
surface has its own switch, its own tests (including the refusal cases) and an entry in `docs/DECISIONS.md`.

## 1. Read-only local API

**Purpose:** let the driver's own tools (a spreadsheet, a stream overlay, a script) read laps and live data.

- **Scope:** a versioned prefix `/api/v1/` with GET only: sessions, lap metadata, one lap's channels (decoded, bounded
  by the existing lap limits), session reports, the live snapshot the HUD already gets. Separate from the page's own
  routes so those can keep changing.
- **No credentials:** never the Gemini key, the leaderboard token, server passwords, the Steam ID; the driver name only
  when the driver ticks it (as in the report file). Responses are built from an allow-list of fields, not by removing
  fields from internal objects, so a new internal field cannot leak.
- **No filesystem access:** no route takes or returns a path; lap and session ids only; no setup files, mods, logs or
  backups through the API.
- **Localhost only:** the same `127.0.0.1` listener. Browsers stay out the way they do now, plus a required custom
  request header (`X-Paddock-Api: 1`): a web page cannot send it cross-origin without a CORS preflight, which the server
  never grants. Off by default (a Settings switch); the switch shows the URL and an example.
- **Limits:** a few requests per second per route; lap bodies capped; no route that scans the whole history at once
  (PL3: paginate sessions and laps).
- **LAN (phones, a second PC) is a different product:** anyone on the same network (a shared flat, a café, a LAN
  event) could read the driver's laps. It would need: an explicit opt-in with a warning; a listener on the chosen
  interface only; a random pairing token (≥128 bits, shown once, revocable; every request carries it); rate limits and
  a short access log in Settings; switching itself off after some hours; the Windows firewall prompt explained; and TLS
  or a clear statement that traffic is readable on the network. Threat model to write first: passive sniffing, a
  malicious device on the LAN, token theft from a screenshot, and replay. Not before the localhost API has been used.

## 2. Plugin boundaries

| Option | Trust | Verdict |
| --- | --- | --- |
| (a) In-process plugins (Node modules loaded by the server or Electron) | Full: the plugin can read the key, the database and every file the user can | **No.** There is no safe boundary inside one Node process. |
| (b) Out-of-process tools on the read-only API (section 1) | Only what the API hands out | **First step.** Needs nothing new besides the API. |
| (c) Page plugins in a sandboxed `iframe` (`sandbox="allow-scripts"`, no same-origin, a strict CSP), talking to Paddock by `postMessage` with a manifest of permissions (which data, live or history) | What the manifest grants, checked by Paddock's page | Possible later, after (b). Needs a manifest format, a permission prompt, a way to remove a plugin, and a rule on where plugins come from (local files only; no store). |

Never: plugins that write to the game folder, run on the 60 Hz telemetry loop, or receive secrets. The in-game HUD
stays Paddock's own (`trainerhud`); third-party in-game apps already have the ACE UI App Loader.

## 3. Cross-device sync

**Purpose:** the same laps on two PCs (a sim rig and a laptop). Semantics first; transport second.

- **Identity:** local integer ids collide between PCs. Each lap, session, note, goal and drill would need a global id
  (a random UUID added by a schema v5 migration, with the usual pre-migration copy). Laps also get a content hash
  (channels + metadata) to find the same lap imported twice.
- **What syncs:** laps (immutable after saving), sessions, reports (rebuilt locally, not synced), notes, tags,
  bookmarks, goals, drills, experiments. **Never:** settings secrets, the sign-in, race.json passwords, caches, the
  Mods manifest (it describes one PC's game folder).
- **Conflicts:** laps cannot conflict (append-only, deduplicated by hash). Small records (a note, a goal) are
  last-writer-wins per field by a hybrid logical clock, with the losing value kept in a short history the driver can
  bring back. Two devices editing the same note at once keep both texts (a visible conflict, not a silent loss).
- **Deletion:** a delete is a tombstone (id, time, device) that syncs like a record; the data is removed when the
  tombstone arrives. Tombstones are kept 180 days; a device offline longer than that does a full compare instead of
  replaying (so a deleted lap does not come back). A lap deleted by mistake can be brought back from a backup.
- **Recovery:** sync never runs without a recent verified backup (section 1 of DATA_OWNERSHIP.md) on each device;
  the first sync is a union (nothing is deleted on either side); a sync that would delete more than a threshold (say
  20 laps) asks first.
- **Transport options:** (a) a folder the driver chooses (OneDrive, Dropbox, a USB stick), with per-device
  append-only change logs, never the SQLite file itself (a synced live database gets corrupted); no server, no cost.
  (b) a Paddock server: accounts, storage cost, privacy review, a new backend. Recommended: (a).

## 4. Signed release pipeline and recoverable updates

- **Signing:** an Authenticode code-signing certificate (OV, or a cloud signing service such as Azure Trusted Signing
  or SignPath's free open-source plan). The key lives in the signing service or a hardware token, used by a CI job on
  tags only; **never in the repo, never on the build PC's disk, never in the Claude session**. Costs and the identity
  check are the owner's decision.
- **Release integrity:** CI builds the zip from a clean checkout (`npm ci`, `npm run verify`), signs the exe, writes
  `SHA256SUMS` and a detached signature of it (minisign or Sigstore; the public key in the README and the app). The
  release notes keep the SHA-256 as today.
- **Recoverable updates** (would replace check-and-notify only with the owner's approval, decision D2): download into
  `updates\<version>` next to the app; check the signature and hash; keep the current version's folder; switch only at
  the next start; if the new version fails its own start check (server answers, database opens), start the previous
  one again and say why. `data\` is never touched by the updater. A database already upgraded by the new version is
  protected by the newer-database guard (PL5: the old version leaves it alone, recording off) and by the
  pre-migration copy `telemetry.backup-v<old>-<time>.db`, which a rollback restores on request.
- **Never:** silent updates, updates from anywhere but the project's GitHub releases, an update while a session is
  being recorded.

## 5. Comparison animation export (cheap option only)

- The lap replay draws on a `<canvas>` (`public/replay.js`). Chromium (the desktop app and Edge) can record a canvas
  with `canvas.captureStream()` and `MediaRecorder` into a WebM file, in the page, with no dependency and no server
  work. A "Record" button would replay two laps side by side at 1× and save the WebM. Cost: about a day; risk: low.
- GIF or MP4 would need an encoder (a dependency or ffmpeg): not cheap, not proposed.
- Privacy: the video shows only what the replay shows (no names unless the driver typed them into a label).
- Not built in PL11 (OD-PL-82): it is outside data ownership and the cheap path still needs a design of the
  side-by-side layout.
