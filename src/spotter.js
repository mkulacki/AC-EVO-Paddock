// Audio brake spotter: counts down to the next brake (or lift) point of the HUD's reference lap,
// "three, two, one, brake", and the open Paddock page plays it (voice clips or beeps).
// Timing is in seconds from the current speed, because metres go by too fast at racing speed.
// Called from the 60 Hz telemetry loop with LiveHud.nextBrake().
//
// PL9: `blocked()` names a reason to say nothing (the kill switch, telemetry that stopped updating); then no cue is
// said and the corner being counted down is forgotten, so nothing old is said once it clears. `cooldownMs` (setting,
// default 0 = as before) is the least time between two spoken cues: a cue that would come sooner is dropped. Both can
// only take cues away; nothing here says more than the countdown did before PL9.

const BASE_LEAD_S = 0.1;   // audio output and network latency: start the sound this much early
const ROOM_S = 0.6;        // a number is only said if there is this much time left before the next one
const BIG_STOP_KMH = 40;   // "big stops only": the reference lap slows by at least this much
const MIN_SPEED_MS = 15;   // ~55 km/h: no cues in slow traffic or the pit lane

export function createSpotter({ config, emit, blocked = () => null, now = Date.now }) {
  let key = null;    // `${lap}:${corner index}` of the corner being counted down to
  let said = 99;     // lowest step said for it (3, 2, 1, 0 = brake)
  let lastAt = -Infinity; // when the last cue was said (for the cooldown)
  const stats = { said: 0, cooledDown: 0, blocked: 0 };

  const say = (c, cue) => {
    const t = now();
    if (c.cooldownMs > 0 && t - lastAt < c.cooldownMs) { stats.cooledDown++; return; }
    lastAt = t; stats.said++;
    emit(cue);
  };

  function tick(nb) {
    const c = config();
    if (!c.on || !nb || nb.speedMs < MIN_SPEED_MS) return;
    if (blocked()) { stats.blocked++; key = null; said = 99; return; }
    if (c.corners === 'big' && (nb.kind !== 'brake' || nb.dropKmh < BIG_STOP_KMH)) return;
    const k = `${nb.lap}:${nb.k}`;
    if (k !== key) { key = k; said = 99; }
    const x = nb.inM / nb.speedMs - BASE_LEAD_S - (c.offsetMs || 0) / 1000; // seconds until the sound must start
    if (x <= 0.02) {
      if (said > 0) { said = 0; say(c, { say: nb.kind, corner: nb.corner }); }
      return;
    }
    if (c.countdown !== 'full') return;
    const step = Math.ceil(x); // 3 when 2 < x <= 3, ...
    if (step <= 3 && step < said) {
      said = step;
      if (x > step - 1 + ROOM_S) say(c, { say: ['', 'one', 'two', 'three'][step], corner: nb.corner });
    }
  }

  // "Test" button: the whole countdown one second apart, through the same path as on track (the kill switch and the
  // cooldown do not apply: the driver asked for it)
  function test() {
    const c = config();
    const seq = c.countdown === 'full' ? ['three', 'two', 'one', 'brake'] : ['brake'];
    seq.forEach((say, i) => setTimeout(() => emit({ say, corner: 'Test', test: true }), i * 1000));
  }

  return { tick, test, stats: () => ({ ...stats }) };
}
