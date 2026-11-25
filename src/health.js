// Integration health (PL4.3): one place that says whether Paddock and AC EVO are talking, and what to do when not.
// Built only from what Paddock already knows (the recorder, the game's files, the HUD install, the telemetry checks,
// the leaderboard's and the update check's last results, the PL3 timing numbers). It makes no network request and
// reads nothing new from the game: a value Paddock does not know is shown as "not known", never guessed.
//
// Each check: {id, label, state, summary, details: [text], steps: [text], href, hrefLabel}
//   state: 'ok' | 'warn' (needs a look) | 'bad' (not working) | 'off' (not running / switched off: nothing wrong)
//          | 'unknown' (Paddock cannot tell)

const ago = (ms) => (ms == null ? 'never' : ms < 1500 ? 'just now' : ms < 90e3 ? `${Math.round(ms / 1000)} s ago` : ms < 5400e3 ? `${Math.round(ms / 60e3)} min ago` : `${Math.round(ms / 3600e3)} h ago`);
const IN_SESSION = ['live', 'pause', 'replay'];
/** An error message without folder paths (they can hold the Windows user name): only the file name is kept. */
// Node's fs errors quote the path ('C:\Users\Jan Kowalski\...'), which may hold spaces: a quoted path is replaced as a
// whole first, then any unquoted one (up to a space).
const lastPart = (p) => p.split(/[\\/]/).filter(Boolean).pop() || '';
export const noPaths = (s) => (s == null ? s : String(s)
  .replace(/(['"`])([^'"`]*[\\/][^'"`]*)\1/g, (_, q, p) => `${q}${lastPart(p)}${q}`)
  .replace(/(?:[A-Za-z]:)?(?:[\\/]+[^\\/\s'"`]+)+[\\/]?/g, lastPart)
  .slice(0, 300));

/**
 * inputs: {now, mock, game: {running, version, hudVersion, liveAgeMs}, telemetry: {source, status, connected, lastFrameAt,
 *   packetAgeMs, stale, savedLaps, lastLap}, perf (src/perf.js summary), hud (hudinstall.status), loader (loaderinstall.status),
 *   channels (channels.list()), checkContext, board (leaderboard.health()), updates (updates.status()), aceFound,
 *   bridge (GameBridge.stats(), PL9), assistOff (the PL9 kill switch)}
 */
export function build(x) {
  const now = x.now ?? Date.now();
  const t = x.telemetry || {}, g = x.game || {};
  const inSession = IN_SESSION.includes(t.status) && now - (t.lastFrameAt || 0) < 5000;
  const checks = [];
  const add = (c) => checks.push({ details: [], steps: [], href: null, hrefLabel: null, ...c });

  // 1. game connection: is AC EVO running, and does Paddock get its shared memory
  if (x.mock) {
    add({ id: 'game', label: 'Game connection', state: 'off', summary: `Test run with mock telemetry (${t.source || 'mock'}): AC EVO is not read.` });
  } else if (!x.aceFound) {
    add({ id: 'game', label: 'Game connection', state: 'bad', summary: "AC EVO's user folder was not found.",
      details: ['Without it Paddock cannot read the game version, install the HUD or find setups.'],
      steps: ['Start AC EVO once, so it creates its folder under Documents or Saved Games.', 'Or set the folder in Settings → Game files folder.'], href: '#/settings', hrefLabel: 'Settings' });
  } else if (!g.running && !t.connected) {
    add({ id: 'game', label: 'Game connection', state: 'off', summary: "AC EVO isn't running.", details: [g.version ? `Last seen version: ${g.version} (from the game's log).` : 'Game version not known yet.'],
      steps: ['Start AC EVO from the Game page or from Steam: Paddock connects by itself.'] });
  } else if (!t.connected || t.status === 'waiting for game' || t.status === 'game not running') {
    add({ id: 'game', label: 'Game connection', state: g.running ? 'warn' : 'unknown',
      summary: g.running ? 'AC EVO is running, but Paddock gets no telemetry from it.' : 'Paddock cannot tell whether AC EVO is running.',
      details: [`Telemetry: ${t.status || 'not known'}.`, g.version ? `Game version: ${g.version}.` : 'Game version not known.'],
      steps: ['Paddock and AC EVO must run on the same PC.', 'Wait until the game has finished loading (its main menu), then look again.',
        'If it stays like this, copy Settings → Diagnostics into a bug report.'], href: '#/settings', hrefLabel: 'Settings → Diagnostics' });
  } else {
    add({ id: 'game', label: 'Game connection', state: 'ok', summary: `Connected${g.version ? ` to AC EVO ${g.version}` : ''}${inSession ? ', on track' : ', in the menus'}.`,
      details: [g.version ? '' : "Game version not known (the game's log was not found): telemetry checks cannot count until it is."].filter(Boolean) });
  }

  // 2. telemetry freshness: do the readings keep changing while on track
  const p = x.perf || {};
  const timing = p.tickInterval?.n ? [`Since Paddock started: ${p.lateTicks ?? 0} late reads (about ${p.missedFramesEstimate ?? 0} frames missed), ${p.stalls ?? 0} stalls of 250 ms or more${p.eventLoopDelay ? `, event loop delay p99 ${p.eventLoopDelay.p99} ms` : ''}.`] : [];
  if (!inSession) {
    add({ id: 'freshness', label: 'Telemetry freshness', state: 'off', summary: 'No session: nothing to read right now.', details: timing });
  } else if (t.stale || (t.packetAgeMs != null && t.packetAgeMs > 3000)) {
    add({ id: 'freshness', label: 'Telemetry freshness', state: 'bad', summary: `The readings stopped changing ${ago(t.packetAgeMs)}.`, details: timing,
      steps: ['A paused game or a loading screen stops them: drive on and they come back.', 'If the game froze or closed, the lap in progress is not saved.'] });
  } else if (t.packetAgeMs != null && t.packetAgeMs > 1000) {
    add({ id: 'freshness', label: 'Telemetry freshness', state: 'warn', summary: `Last new reading ${ago(t.packetAgeMs)}.`, details: timing, steps: ['Short gaps happen when the game is busy; long ones are shown in red.'] });
  } else {
    add({ id: 'freshness', label: 'Telemetry freshness', state: 'ok', summary: 'Readings are arriving (60 per second).', details: timing });
  }

  // 3. recording: laps saved, failures
  const saveErr = p.errors?.lapSave || 0;
  const last = t.lastLap ? `Last lap saved: ${(t.lastLap.lapTimeMs / 1000).toFixed(3)} s${t.lastLap.valid ? '' : ' (invalid)'}.` : 'No lap saved since Paddock started.';
  if (x.dbBlocked) {
    // a laps database from a newer Paddock (src/db.js blocked): left untouched, recording off (D-PL5-19)
    add({ id: 'recording', label: 'Recording', state: 'bad', summary: 'Recording is off: your data was made by a newer Paddock. Install that newer version to record.', details: [x.dbBlocked.message],
      steps: ['Install the newer Paddock that made this data (Settings → Updates).', 'Or, with Paddock closed, move data\\telemetry.db somewhere else to start a new one (your laps stay in the moved file).'], href: '#/settings', hrefLabel: 'Settings → Updates' });
  } else if (saveErr) {
    add({ id: 'recording', label: 'Recording', state: 'bad', summary: `${saveErr} lap${saveErr === 1 ? '' : 's'} could not be saved since Paddock started.`, details: [last],
      steps: ["Check that the disk with Paddock's data folder has free space.", 'Copy Settings → Diagnostics into a bug report: it lists the error count.'], href: '#/settings', hrefLabel: 'Settings → Diagnostics' });
  } else {
    add({ id: 'recording', label: 'Recording', state: inSession && t.status === 'live' ? 'ok' : 'off',
      summary: inSession && t.status === 'live' ? 'Recording this session: every completed lap is saved.' : t.status === 'pause' ? 'Paused: recording goes on when you drive.' : t.status === 'replay' ? 'Replays are not recorded.' : 'Not on track: laps are recorded when you drive.',
      details: [`${t.savedLaps || 0} lap${t.savedLaps === 1 ? '' : 's'} saved since Paddock started.`, last] });
  }

  // 4. HUD and App Loader compatibility
  const hud = x.hud ? { ...x.hud, error: noPaths(x.hud.error), autoError: noPaths(x.hud.autoError) } : x.hud, loader = x.loader || hud?.loaderInfo;
  if (!hud || hud.error) add({ id: 'hud', label: 'Paddock HUD', state: 'unknown', summary: `The HUD install could not be read${hud?.error ? `: ${hud.error}` : ''}.`, href: '#/mods', hrefLabel: 'Mods' });
  else {
    const steps = [], details = [];
    let state = 'ok', summary;
    if (hud.state === 'no-game') { state = 'off'; summary = 'AC EVO has not been started on this PC yet, so the HUD is not installed.'; }
    else if (hud.state === 'missing') { state = 'warn'; summary = hud.removed ? 'The HUD is switched off (Mods tab or setup guide): Paddock does not install it by itself.' : 'The HUD is not installed yet.'; steps.push(hud.removed ? 'Turn it on in Settings → In-game HUD, or in the Mods tab.' : 'Close AC EVO: Paddock installs the HUD while the game is closed.'); if (hud.autoError) details.push(`Last install attempt: ${hud.autoError}`); }
    else if (hud.state === 'outdated') { state = 'warn'; summary = `A HUD update (${hud.installed} → ${hud.bundled}) is waiting.`; steps.push('Close AC EVO: Paddock updates the HUD while the game is closed.'); }
    else if (hud.state === 'newer') { state = 'warn'; summary = `The installed HUD (${hud.installed}) is newer than this Paddock's (${hud.bundled}).`; steps.push('Update Paddock (Settings → Updates), or reinstall the HUD from the Mods tab.'); }
    else summary = `HUD ${hud.installed} installed, the version this Paddock ships.`;
    if (loader?.gameMatch === false) { state = 'bad'; details.push(`The ACE UI App Loader Paddock ships is built for AC EVO ${loader.builtFor}; the game is ${loader.game}.`); steps.push('Update Paddock when a version for this AC EVO is out (Settings → Updates). Paddock does not install a loader built for another game version.'); }
    else if (loader && loader.state && loader.state !== 'current' && hud.state !== 'no-game') { if (state === 'ok') state = 'warn'; details.push(`ACE UI App Loader: ${loader.state}.`); }
    // the HUD writes nothing back: its data feed is the live files Paddock writes for it (only while the game runs)
    if (g.running && hud.state === 'current') details.push(g.liveAgeMs != null && g.liveAgeMs < 2000 ? 'Data feed to the HUD: updating.' : 'Data feed to the HUD: not updating.');
    // PL9: the kill switch, and how the live-file writer has fared since Paddock started (src/gamebridge.js stats)
    if (x.assistOff) { if (state === 'ok') state = 'warn'; details.push('HUD and cues are switched off (kill switch).'); steps.push('Turn them on again: the switch in the header bar, Ctrl+K → "HUD and cues", or Alt+Q.'); }
    const b = x.bridge;
    if (b && b.windows) {
      const issues = [];
      if (b.slowWrites) issues.push(`${b.slowWrites} slow write${b.slowWrites === 1 ? '' : 's'} (longest ${Math.round(b.maxWriteMs)} ms; writing paused for a second after each)`);
      if (b.lateWrites) issues.push(`${b.lateWrites} write${b.lateWrites === 1 ? '' : 's'} that ended inside the HUD's read window`);
      if (b.errors) issues.push(`${b.errors} failed write${b.errors === 1 ? '' : 's'}${b.lastError ? ` (last: ${noPaths(String(b.lastError))})` : ''}`);
      if (b.missedWindows) issues.push(`${b.missedWindows} window${b.missedWindows === 1 ? '' : 's'} skipped while Paddock was held up (longest gap ${Math.round(b.maxGapMs)} ms)`);
      if (issues.length) details.push(`Data feed since Paddock started: ${issues.join('; ')}. The HUD labels data that is too old.`);
      if ((b.lateWrites || b.slowWrites > 10) && state === 'ok') state = 'warn';
    }
    add({ id: 'hud', label: 'Paddock HUD', state, summary, details, steps, href: '#/mods', hrefLabel: 'Mods' });
  }

  // 5. telemetry checks against the game (PL4.1): missing, unverified, unsupported
  const ch = x.channels || [];
  const ask = ch.filter((c) => c.confirmable);
  const again = ask.filter((c) => c.needsRecheck), wrong = ch.filter((c) => c.state === 'unsupported'), open = ask.filter((c) => c.status === 'unverified' && !c.needsRecheck);
  const fixed = ch.filter((c) => !c.confirmable && c.status !== 'verified');
  const verified = ask.filter((c) => c.status === 'verified').length;
  add({ id: 'channels', label: 'Telemetry checks', state: wrong.length || again.length ? 'warn' : open.length ? 'warn' : 'ok',
    summary: `${verified} of ${ask.length} reading groups checked against the game${x.checkContext?.game ? ` (AC EVO ${x.checkContext.game})` : ''}.`,
    details: [
      wrong.length ? `Marked as not matching, left out of all analysis: ${wrong.map((c) => c.label).join('; ')}.` : '',
      again.length ? `Checked on another game version or with an older reader, so not counted: ${again.map((c) => c.label).join('; ')}.` : '',
      open.length ? `Not checked yet (shown as unconfirmed): ${open.map((c) => c.label).join('; ')}.` : '',
      fixed.length ? `Cannot be checked against the game (always labelled unconfirmed): ${fixed.map((c) => c.label).join('; ')}.` : '',
    ].filter(Boolean),
    steps: wrong.length || again.length || open.length ? ['Open Setups → Setup recognition while you drive or stand in the pit box, compare each group with the game and say whether it matches.'] : [],
    href: '#/setups', hrefLabel: 'Setups → Setup recognition' });

  // 6. online services: only what Paddock already knows from its own last requests
  const b = x.board ? { ...x.board, lastError: noPaths(x.board.lastError) } : x.board, u = x.updates ? { ...x.updates, error: noPaths(x.updates.error) } : x.updates;
  if (b) {
    const details = [];
    if (u) details.push(!u.enabled ? 'Update check: off.' : u.error ? `Update check: failed ${ago(u.checkedAt ? now - u.checkedAt : null)} (${u.error}).` : u.checkedAt ? `Update check: done ${ago(now - u.checkedAt)}${u.latest ? `, ${u.latest.version} is out` : ', up to date'}.` : 'Update check: not done yet.');
    details.push('Shown from Paddock\'s own last requests: nothing is sent to check it.');
    let state, summary; const steps = [];
    if (!b.share) { state = 'off'; summary = 'Leaderboards: not sharing your laps (off unless you turn it on).'; }
    else if (!b.secure) { state = 'bad'; summary = 'Leaderboards: the server address is not https, so nothing is sent.'; steps.push('Fix the address in the Leaderboards tab.'); }
    else if (!b.signedIn) { state = 'warn'; summary = `Leaderboards: sharing is on, but you are not signed in${b.host ? ` to ${b.host}` : ''}.`; steps.push('Sign in with Steam in the Leaderboards tab.'); }
    else if (b.lastError) { state = 'warn'; summary = `Leaderboards: the last send failed (${b.lastError}).`; steps.push('Paddock tries again after your next lap. Check your internet connection if it keeps failing.'); }
    else { state = 'ok'; summary = `Leaderboards: signed in${b.host ? ` to ${b.host}` : ''}; ${b.lastSync ? `last send ${ago(now - b.lastSync)}` : 'nothing sent since Paddock started'}${b.auto ? '' : ' (sending only with Send now)'}.`; }
    add({ id: 'online', label: 'Online services', state, summary, details, steps, href: '#/leaderboard', hrefLabel: 'Leaderboards' });
  }

  const order = { bad: 0, warn: 1, unknown: 2, ok: 3, off: 4 };
  const worst = checks.reduce((w, c) => (order[c.state] < order[w] ? c.state : w), 'off');
  return { at: now, worst: worst === 'off' ? 'ok' : worst, checks };
}
