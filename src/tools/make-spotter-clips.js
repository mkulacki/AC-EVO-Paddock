// Generates the brake spotter's voice clips (public/audio/spotter/*.wav) with Gemini text-to-speech.
// Only needed to (re)make the clips; they are shipped with the app. Uses GEMINI_API_KEY, else the key in
// data/settings.json. Only the words below are sent.
//   node src/tools/make-spotter-clips.js [voiceName]      (default voice: Charon)
import fs from 'node:fs';
import path from 'node:path';

const MODEL = process.env.TTS_MODEL || 'gemini-2.5-flash-preview-tts';
const VOICE = process.argv[2] || 'Charon';
const OUT = path.resolve('public/audio/spotter');
const WORDS = { three: 'Three.', two: 'Two.', one: 'One.', brake: 'Brake!', lift: 'Lift!' };
const STYLE = 'Say this as one short word, crisp and clear, like a calm race engineer on team radio, no pause before it:';

function apiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const dir = process.env.ACEVO_DATA || 'data';
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).geminiApiKey || ''; } catch { return ''; }
}

async function tts(text, key) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${STYLE} ${text}` }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } } },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const part = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part) throw new Error('no audio in the answer');
  const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType)?.[1] || 24000);
  return { pcm: Buffer.from(part.inlineData.data, 'base64'), rate };
}

// cut silence at both ends (keeps 10 ms before the word, so it starts the moment it is played) and normalise
function tidy(pcm, rate) {
  const n = pcm.length >> 1, s = new Int16Array(n);
  for (let i = 0; i < n; i++) s[i] = pcm.readInt16LE(i * 2);
  const thr = 600;
  let a = 0, b = n - 1;
  while (a < n && Math.abs(s[a]) < thr) a++;
  while (b > a && Math.abs(s[b]) < thr) b--;
  a = Math.max(0, a - Math.round(rate * 0.01)); b = Math.min(n - 1, b + Math.round(rate * 0.06));
  let peak = 1;
  for (let i = a; i <= b; i++) peak = Math.max(peak, Math.abs(s[i]));
  const g = (32767 * 0.89) / peak, len = b - a + 1, fade = Math.round(rate * 0.005);
  const out = Buffer.alloc(len * 2);
  for (let i = 0; i < len; i++) {
    const env = Math.min(1, i / fade, (len - 1 - i) / fade);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s[a + i] * g * env))), i * 2);
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
for (const [name, text] of Object.entries(WORDS)) {
  const { pcm, rate } = await tts(text, key);
  const clip = tidy(pcm, rate);
  fs.writeFileSync(path.join(OUT, `${name}.wav`), wav(clip, rate));
  console.log(`${name}.wav  ${(clip.length / 2 / rate).toFixed(2)} s`);
}
console.log(`voice ${VOICE}, model ${MODEL} -> ${OUT}`);
