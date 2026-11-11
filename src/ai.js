// Gemini-based driving coach. Sends a compact per-corner summary (not raw telemetry).
import * as settings from './settings.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';

async function call(pathAndQuery, body) {
  const key = settings.get().geminiApiKey;
  if (!key) throw new Error('No Gemini API key set. Open Settings and paste a key from https://aistudio.google.com/apikey');
  const res = await fetch(`${API}/${pathAndQuery}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error?.message || `Gemini HTTP ${res.status}`);
  return json;
}

export async function listModels() {
  const json = await call('models?pageSize=200');
  return (json.models || [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => ({ id: m.name.replace('models/', ''), name: m.displayName }));
}

const idxAt = (d, dist) => { let lo = 0, hi = d.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (d[m] < dist) lo = m + 1; else hi = m; } return lo; };
const fmt = (ms) => (ms == null ? '-' : `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(3).padStart(6, '0')}`);

// Build the compact text summary the model gets.
export function buildSummary(cmp, lap) {
  const ref = cmp.ref, d = ref.trace.d;
  const rows = cmp.corners.map((c, i) => {
    const a = idxAt(d, c.start), x = idxAt(d, c.apex), b = idxAt(d, c.end);
    const m = lap.corners[i], r = ref.corners[i];
    return {
      corner: c.name, from_m: c.start, apex_m: c.apex, to_m: c.end,
      time_lost_s: +(lap.delta[b] - lap.delta[a]).toFixed(3),
      lost_entry_s: +(lap.delta[x] - lap.delta[a]).toFixed(3), lost_exit_s: +(lap.delta[b] - lap.delta[x]).toFixed(3),
      you: m, reference: r,
    };
  });
  return {
    track: `${cmp.combo.track} ${cmp.combo.layout}`.trim(), car: cmp.combo.car,
    lap_time: fmt(lap.meta.lap_time_ms), reference: `${ref.label} ${fmt(ref.lapTimeMs)}`,
    total_gap_s: +((lap.meta.lap_time_ms - ref.lapTimeMs) / 1000).toFixed(3), lap_valid: !!lap.meta.valid,
    lap_stats: { you: lap.stats, reference: ref.stats },
    units: 'distances in metres from start/finish line, speeds km/h, brake/throttle 0-1 (maxBrakePct in %), times ms unless _s; positive time_lost = slower than reference',
    corners: rows,
  };
}

const SYSTEM = `You are an experienced professional sim-racing driver coach analysing telemetry from Assetto Corsa EVO.
You get a per-corner comparison between the driver's lap and a reference lap (their own best lap, or an "ideal lap" spliced from their best corner segments).
Metric meanings: entrySpeed = top speed before the corner; brakePoint = distance where braking starts (larger = later braking);
liftPoint = where they lifted if no braking; maxBrakePct = peak brake pressure; brakeRelease = where braking ends (trail braking);
minSpeed/apexAt = minimum speed and its location; throttlePickup = first throttle after braking; fullThrottle = full throttle point;
exitSpeed = speed 150 m after apex; coastM = metres with neither throttle nor brake; lost_entry_s/lost_exit_s split time loss before/after the apex.
entryWide/apexWide/exitWide = driver's racing line relative to the reference line at turn-in / apex / exit, in metres:
positive = wider (towards the outside of the corner), negative = tighter (towards the inside). Reference values are 0 by definition.
Use them to comment on the racing line (e.g. not using full track width on entry, apex too early/wide, running wide on exit).
Rules:
- Base every statement on the numbers; quote the concrete differences (metres, km/h, seconds).
- Prioritise by time lost. Start with a short overview, then "Top 3 priorities", then brief notes for other corners that lost > 0.05 s.
- Diagnose the cause (early braking, over-slowing, late/hesitant throttle, coasting, poor exit, too much steering) and give a concrete, actionable fix
  (e.g. "brake ~10 m later, at ~610 m", "carry 3 km/h more min speed", "get to full throttle 20 m earlier").
- Mention where the driver is faster than the reference too, briefly.
- Be concise, use Markdown headings and bullet points. No generic tips unrelated to the data.`;

export async function coach(cmp, lap, question, previousAnswer) {
  const s = settings.get();
  const summary = buildSummary(cmp, lap);
  const prompt = `Respond in ${s.language || 'English'}.\n\nTelemetry comparison (JSON):\n${JSON.stringify(summary)}`;
  const contents = [{ role: 'user', parts: [{ text: prompt }] }];
  if (question) {
    if (previousAnswer) contents.push({ role: 'model', parts: [{ text: previousAnswer }] });
    contents.push({ role: 'user', parts: [{ text: `Follow-up question from the driver (answer briefly, based on the data): ${question}` }] });
  }
  const json = await call(`models/${encodeURIComponent(s.geminiModel)}:generateContent`, {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents,
    generationConfig: { temperature: 0.4 },
  });
  const cand = json.candidates?.[0];
  const text = cand?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) throw new Error(`Empty answer from Gemini (${cand?.finishReason || json.promptFeedback?.blockReason || 'unknown'})`);
  return { text, model: s.geminiModel };
}
