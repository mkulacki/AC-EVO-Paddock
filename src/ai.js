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

// ---------------------------------------------------------------- setup engineer
// Proposes changes to a setup file (the values the game's setup screen shows, within the car's limits). Nothing is
// saved: the driver reviews the proposal and saves it as a new setup.
const SETUP_SYSTEM = `You are an experienced race engineer for Assetto Corsa EVO, helping a sim racer set up their car.
You get: the car and track, the driver's description of the handling, the current setup (every value the driver can
change, with its range, step and unit as the game's setup screen shows them, plus the game's own help text for it),
and, when available, telemetry from the driver's laps with this car on this track (lap times and a corner-by-corner
comparison of the best lap with the ideal lap spliced from the driver's best corners). The laps are not linked to a
setup: they may have been driven on other setups, so use them to judge the track (slow/fast corners, where time is
lost) and the driving, not as proof of what this setup does.
Rules:
- Propose a small number of focused changes (usually 2-6) that address the driver's problem; do not change everything at once.
- Only use names from the setup list, values inside min..max and on the step grid. Do not change fuel, tyre compound or telemetry laps.
- Keep left/right symmetric unless there is a reason not to.
- Explain each change in one or two sentences (what it does to the car's balance and why it helps here).
- If the problem is more about driving than setup, say so in the summary and keep the changes minimal.
Answer with JSON only:
{"summary": "markdown: diagnosis and what to expect", "changes": [{"name": "...", "value": number, "reason": "..."}],
 "test_plan": "markdown: what to try on track and what to report back", "name": "a short name for the new setup (max 30 chars)"}`;

const NO_AI = new Set(['fuel', 'telemetry_laps_to_record']);
const shown = (v, x) => Math.round(x * v.scale * 1e6) / 1e6;

export async function setupEngineer({ setup, problem, telemetry }) {
  const s = settings.get();
  const { tipFor, snap, CORNER_LABEL } = await import('./carsetup.js');
  const usable = setup.values.filter((v) => !v.locked && !v.list && !NO_AI.has(v.name));
  if (!usable.length) throw new Error('This setup has no values Paddock can change');
  const values = usable.map((v) => ({
    name: v.name, setting: v.label + (v.corner ? ` (${CORNER_LABEL[v.corner]})` : ''), value: shown(v, v.value),
    min: shown(v, v.min), max: shown(v, v.max), step: shown(v, v.step), unit: v.unit || undefined, help: tipFor(v) || undefined,
  }));
  const locked = setup.values.filter((v) => v.locked && !v.list).map((v) => v.label + (v.corner ? ` ${v.corner}` : ''));
  const input = {
    car: setup.carName, track: setup.track.name, setup_name: setup.name, setup_notes: setup.notes || undefined,
    driver_says: String(problem || '').slice(0, 2000) || '(nothing: suggest a solid baseline for this track)',
    setup: values, cannot_change_here: locked.length ? locked : undefined,
    telemetry: telemetry || 'no laps recorded with this car on this track yet',
  };
  const json = await call(`models/${encodeURIComponent(s.geminiModel)}:generateContent`, {
    systemInstruction: { parts: [{ text: SETUP_SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: `Respond in ${s.language || 'English'} (JSON keys stay in English).\n\n${JSON.stringify(input)}` }] }],
    generationConfig: { temperature: 0.3, responseMimeType: 'application/json' },
  });
  const cand = json.candidates?.[0];
  const text = cand?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) throw new Error(`Empty answer from Gemini (${cand?.finishReason || json.promptFeedback?.blockReason || 'unknown'})`);
  let out;
  try { out = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { throw new Error('Gemini did not answer in the expected format; try again'); }
  // keep only real, changeable values; snap them to the car's limits (the model sees shown units, files store raw)
  const changes = [];
  const skipped = [];
  for (const c of Array.isArray(out.changes) ? out.changes : []) {
    const v = usable.find((x) => x.name === c?.name);
    const want = Number(c?.value);
    if (!v || !Number.isFinite(want)) { skipped.push(String(c?.name ?? '?')); continue; }
    const to = snap(v, want / v.scale);
    if (Math.abs(to - v.value) < 1e-9 || changes.some((x) => x.name === v.name)) continue;
    changes.push({ name: v.name, from: v.value, to, reason: String(c.reason || '').slice(0, 600) });
  }
  return {
    model: s.geminiModel, summary: String(out.summary || ''), testPlan: String(out.test_plan || ''),
    name: String(out.name || '').slice(0, 40), changes, skipped, usedLaps: telemetry ? telemetry.laps : 0,
  };
}
