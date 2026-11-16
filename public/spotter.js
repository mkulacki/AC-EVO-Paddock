// Audio brake spotter, the playing side: the server sends a "spotter" event at the right moment
// ("three", "two", "one", "brake", "lift") and this page plays it, as a voice clip or a beep.
// Only one Paddock page plays (a Web Lock), so two open tabs don't talk over each other.
// In the desktop app the main window keeps running in the tray and plays without a click; in a browser
// the page needs one click first (browsers block sound until then).

const CLIPS = ['three', 'two', 'one', 'brake', 'lift'];
const BEEPS = { three: [880, 0.09], two: [880, 0.09], one: [880, 0.09], brake: [1320, 0.35], lift: [660, 0.3],
  // brake points: point marked, pedal lap started, pedal lap saved, nothing marked (not on track)
  mark: [1760, 0.08], recstart: [990, 0.25], recsaved: [1320, 0.5], nomark: [220, 0.3] };

let ctx = null, gain = null, player = false;
const voices = {}; // voice -> { word: AudioBuffer }, loaded on first use

function audio() {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    gain = ctx.createGain(); gain.connect(ctx.destination);
  }
  return ctx;
}

export function loadVoice(voice) {
  if (voice === 'beep' || voices[voice]) return;
  const ac = audio(), set = voices[voice] = {};
  CLIPS.forEach(async (n) => {
    try { set[n] = await ac.decodeAudioData(await (await fetch(`/audio/spotter/${voice}/${n}.wav`)).arrayBuffer()); }
    catch { /* missing clip: that word falls back to a beep */ }
  });
}

function beep(say, at) {
  const [hz, len] = BEEPS[say] || BEEPS.brake;
  const o = ctx.createOscillator(), env = ctx.createGain();
  o.type = 'sine'; o.frequency.value = hz;
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(1, at + 0.005);
  env.gain.setValueAtTime(1, at + len - 0.02);
  env.gain.linearRampToValueAtTime(0, at + len);
  o.connect(env); env.connect(gain);
  o.start(at); o.stop(at + len + 0.01);
}

export function play({ say, sound, volume }) {
  const ac = audio();
  if (ac.state === 'suspended') ac.resume().catch(() => {});
  gain.gain.value = Math.max(0, Math.min(1, (volume ?? 80) / 100));
  const at = ac.currentTime;
  loadVoice(sound);
  const buf = voices[sound]?.[say];
  if (!buf) return beep(say, at);
  const s = ac.createBufferSource();
  s.buffer = buf; s.connect(gain); s.start(at);
}

/** 'ready', 'blocked' (needs a click on the page), 'elsewhere' (another Paddock tab plays) or 'off' */
export function spotterAudioState() {
  if (!player) return 'elsewhere';
  if (!ctx) return 'off';
  return ctx.state === 'running' ? 'ready' : 'blocked';
}

export function initSpotter(events) {
  const start = () => {
    player = true;
    // load the chosen voice up front, so the first cue on track is not a beep
    fetch('/api/settings').then((r) => r.json()).then((s) => loadVoice(s.spotter?.sound)).catch(() => {});
    events.addEventListener('spotter', (e) => { try { play(JSON.parse(e.data)); } catch { /* ignore */ } });
    // browsers keep sound off until the page is clicked once
    const unlock = () => { if (ctx?.state === 'suspended') ctx.resume().catch(() => {}); };
    document.addEventListener('pointerdown', unlock); document.addEventListener('keydown', unlock);
  };
  if (navigator.locks) navigator.locks.request('paddock-spotter', () => { start(); return new Promise(() => {}); });
  else start();
}
