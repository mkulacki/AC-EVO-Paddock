// Generates the brake spotter's voice clips (public/audio/spotter/*.wav) with Gemini text-to-speech.
// Only needed to (re)make the clips; they are shipped with the app. Uses GEMINI_API_KEY, else the key in
// data/settings.json. Only the words and the style direction below are sent.
// The shipped voices were made with:
//   node src/tools/make-spotter-clips.js --voice Orus --radio
//   node src/tools/make-spotter-clips.js --voice Algenib --radio
// Options: --voice <Gemini voice>, --model <tts model>, --radio, --out <dir> (default public/audio/spotter/<voice>),
//   --keep-raw <dir> saves the raw takes, --from <dir> re-processes them without new requests.
//   --radio adds a team-radio sound: telephone band, light crunch, a little static.
// A new voice also needs adding to SPOTTER_VOICES (src/settings.js) and the Sound list in public/app.js.
// The free Gemini allowance for speech is small: expect a few minutes per voice.
import fs from 'node:fs';
import path from 'node:path';

const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const MODEL = arg('model', 'gemini-2.5-flash-preview-tts');
const VOICE = arg('voice', 'Orus');
const RADIO = process.argv.includes('--radio');
const OUT = path.resolve(arg('out', `public/audio/spotter/${VOICE.toLowerCase()}`));
const WORDS = { three: 'Three.', two: 'Two.', one: 'One.', brake: 'Brake.', lift: 'Lift.' };
// tense but controlled: a focused engineer under pressure, never cheerful or excited
const MOOD = 'Low, steady, serious voice. Tense and under pressure, but completely calm and controlled. ' +
  'No smile, no excitement, no cheerfulness, no rising pitch. Clipped, with falling intonation.';
const STYLE = {
  three: `You are a focused race engineer on team radio, counting the driver down to the braking point on a tense qualifying lap. ${MOOD} Say only this one word:`,
  brake: `You are a focused race engineer on team radio. This is the braking point on a tense qualifying lap. Give this one command firmly and tersely. ${MOOD} Say only:`,
};
const styleFor = (n) => (n === 'brake' || n === 'lift' ? STYLE.brake : STYLE.three);

function apiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const dir = process.env.ACEVO_DATA || 'data';
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).geminiApiKey || ''; } catch { return ''; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tts(text, style, key) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${style} ${text}` }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } } },
      }),
    });
    if (res.status === 429 || res.status >= 500) { // rate limit or busy: wait and try again
      if (attempt >= 6) throw new Error(`Gemini ${res.status} after retries`);
      const body = await res.text();
      const wait = Number(/"retryDelay":\s*"(\d+)/.exec(body)?.[1] || 20);
      await sleep((wait + 2) * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json();
    const part = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (!part) throw new Error('no audio in the answer');
    const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType)?.[1] || 24000);
    const pcm = Buffer.from(part.inlineData.data, 'base64');
    const s = new Float32Array(pcm.length >> 1);
    for (let i = 0; i < s.length; i++) s[i] = pcm.readInt16LE(i * 2) / 32768;
    return { s, rate };
  }
}

// cut silence at both ends (10 ms kept before the word, so it starts the moment it is played)
function trim(s, rate) {
  const thr = 0.02;
  let a = 0, b = s.length - 1;
  while (a < s.length && Math.abs(s[a]) < thr) a++;
  while (b > a && Math.abs(s[b]) < thr) b--;
  return s.slice(Math.max(0, a - Math.round(rate * 0.01)), Math.min(s.length, b + Math.round(rate * 0.06)));
}

// simple biquad (RBJ cookbook)
function biquad(s, rate, type, f0, q = 0.707) {
  const w = 2 * Math.PI * f0 / rate, al = Math.sin(w) / (2 * q), c = Math.cos(w);
  let b0, b1, b2;
  if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; } else { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
  const a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
  const out = new Float32Array(s.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < s.length; i++) {
    const x = s[i], y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    out[i] = y; x2 = x1; x1 = x; y2 = y1; y1 = y;
  }
  return out;
}

// team radio: 350 Hz - 3.2 kHz band, soft clipping for crunch, a little hiss under the voice
function radio(s, rate) {
  let o = biquad(biquad(s, rate, 'hp', 350), rate, 'hp', 350);
  o = biquad(biquad(o, rate, 'lp', 3200), rate, 'lp', 3200);
  let peak = 1e-6;
  for (const v of o) peak = Math.max(peak, Math.abs(v));
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < o.length; i++) o[i] = Math.tanh((o[i] / peak) * 2.2) / Math.tanh(2.2) + rnd() * 0.015;
  return biquad(o, rate, 'lp', 3600);
}

function finish(s, rate) {
  let peak = 1e-6;
  for (const v of s) peak = Math.max(peak, Math.abs(v));
  const g = 0.89 / peak, fade = Math.round(rate * 0.005), out = Buffer.alloc(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const env = Math.min(1, i / fade, (s.length - 1 - i) / fade);
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s[i] * g * env)) * 32767), i * 2);
  }
  return out;
}

function wav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const key = apiKey();
if (!key) { console.error('No Gemini API key: set GEMINI_API_KEY or save one in Settings.'); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
// --from dir: reuse raw takes saved by an earlier run (to try the radio effect without new requests)
const FROM = arg('from', null);
for (const name of Object.keys(WORDS)) {
  let s, rate;
  const raw = path.join(FROM || OUT, `${name}.raw.json`);
  if (FROM && fs.existsSync(raw)) ({ s, rate } = (({ s, rate }) => ({ s: Float32Array.from(s), rate }))(JSON.parse(fs.readFileSync(raw, 'utf8'))));
  else {
    ({ s, rate } = await tts(WORDS[name], styleFor(name), key));
    if (arg('keep-raw', null)) fs.writeFileSync(path.join(arg('keep-raw'), `${name}.raw.json`), JSON.stringify({ s: Array.from(s), rate }));
  }
  let clip = trim(s, rate);
  if (RADIO) clip = radio(clip, rate);
  fs.writeFileSync(path.join(OUT, `${name}.wav`), wav(finish(clip, rate), rate));
  console.log(`${name}.wav  ${(clip.length / rate).toFixed(2)} s`);
}
console.log(`voice ${VOICE}, ${FROM ? `re-processed from ${FROM}` : `model ${MODEL}`}${RADIO ? ', team radio' : ''} -> ${OUT}`);
