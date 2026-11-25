// PL8: the v3 -> v4 database upgrade (setup experiments) on a database in the PL7 layout (test/fixtures/db-v3-pl7.sql),
// then setup experiments end to end (src/experiments.js) on synthetic laps (test/lapfixtures.js) with chosen lap
// times, setups, game versions and conditions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isolate, ROOT } from './helpers.js';

const { ACEVO_DATA } = isolate('experiments-db');
const tableInfo = (d) => Object.fromEntries(d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
  .map((t) => [t.name, d.prepare(`PRAGMA table_info(${t.name})`).all().map((c) => `${c.name}:${c.type}`).join(',')]));
let before;
{
  const old = new DatabaseSync(path.join(ACEVO_DATA, 'telemetry.db'));
  old.exec(fs.readFileSync(path.join(ROOT, 'test/fixtures/db-v3-pl7.sql'), 'utf8'));
  old.exec("INSERT INTO goals (track, layout, car, kind, target, extra, origin, created_at) VALUES ('trk', 'gp', 'car', 'drill', 0, '{}', 'me', 1)");
  old.exec("INSERT INTO drill_events (goal_id, at, kind, data) VALUES (1, 2, 'stopped', NULL)");
  old.exec("INSERT INTO session_notes (session_id, text, updated_at) VALUES (1, 'kept', 1)");
  before = tableInfo(old);
  old.close();
}

const db = await import('../src/db.js');

test('v3 -> v4: one copy first, data kept, schema version 4, only the two experiment tables added', () => {
  const copies = fs.readdirSync(ACEVO_DATA).filter((f) => f.startsWith('telemetry.backup-'));
  assert.equal(copies.length, 1);
  assert.match(copies[0], /^telemetry\.backup-v3-\d+\.db$/);
  const c = new DatabaseSync(path.join(ACEVO_DATA, copies[0]), { readOnly: true });
  assert.equal(c.prepare('PRAGMA user_version').get().user_version, 3, 'the copy is the old file');
  assert.equal(c.prepare('SELECT COUNT(*) AS n FROM drill_events').get().n, 1);
  c.close();
  assert.equal(db.SCHEMA_VERSION, 4);
  assert.equal(db.counts().schema, 4);
  assert.equal(db.listDrills().length, 1);
  assert.equal(db.drillEvents().get(1).length, 1, 'drill events kept');
  const after = tableInfo(db.raw);
  for (const [t, cols] of Object.entries(before)) assert.equal(after[t], cols, `table ${t} unchanged (an older Paddock still reads it)`);
  assert.deepEqual(Object.keys(after).filter((t) => !(t in before)).sort(), ['experiment_entries', 'setup_experiments']);
  assert.equal(db.blocked, null);
});

test('v4 tables: an experiment and its journal are stored, read back and deleted together; orphan entries pruned at start', () => {
  const id = db.addExperiment({ combo: { track: 'trk', layout: 'gp', car: 'car' }, title: 'Wing', variants: { A: { label: 'Base' }, B: { label: 'More wing' } }, stints: [] });
  db.addExperimentEntry(id, 'journal', { text: 'one click more rear wing' });
  const e = db.getExperiment(id);
  assert.equal(e.status, 'planned');
  assert.equal(e.title, 'Wing');
  assert.deepEqual(e.combo, { track: 'trk', layout: 'gp', car: 'car' });
  e.status = 'running'; e.stints.push({ id: 1, variant: 'A', startAt: 5, endAt: null });
  db.saveExperiment(e);
  assert.equal(db.getExperiment(id).stints.length, 1);
  assert.equal(db.getExperiment(id).status, 'running');
  assert.equal(db.listExperiments({ track: 'trk', layout: 'gp', car: 'car' }).length, 1);
  assert.equal(db.listExperiments({ track: 'trk', layout: 'gp', car: 'other' }).length, 0);
  assert.equal(db.experimentEntries(id).length, 1);
  db.deleteExperiment(id);
  assert.equal(db.getExperiment(id), null);
  assert.equal(db.experimentEntries(id).length, 0);
});
