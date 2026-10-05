import { applyAction, availableMonths, cycleView, validateState } from '../lib/domain.mjs';
import { personalView } from '../lib/personal.mjs';

const fail = (message, status) => Object.assign(new Error(message), { status });
const conflict = () => fail('Los datos cambiaron en otra pestaña o dispositivo. Actualiza los datos y revisa tu cambio antes de guardarlo.', 409);
export function snapshots(state, date) {
  return availableMonths(state, date).map(month => ({ schemaVersion: 1, revision: state.revision, initialMonth: state.initialMonth, cycle: cycleView(state, month, date), ...(state.personal ? { personal: Object.fromEntries(['sofia', 'daniel'].map(person => [person, personalView(state, person, month, date)])) } : {}) }));
}
function stateJSON(state) {
  const json = JSON.stringify(validateState(state));
  // Current and previous versions share one D1 row (maximum 2 MB).
  if (new TextEncoder().encode(json).length > 900000) throw fail('El archivo de registros alcanzó el límite de tamaño. Descarga un respaldo antes de continuar.', 413);
  return json;
}
export async function loadState(db) {
  const row = await db.prepare('SELECT json FROM app_state WHERE id = 1').first();
  if (!row) throw Object.assign(new Error('Falta importar los registros. Ejecuta la configuración de Cloudflare desde tu computadora.'), { status: 503 });
  return validateState(JSON.parse(row.json));
}
function backupStatement(db, state, date, commit) {
  return db.prepare(`INSERT INTO cycle_backups (month, revision, json, previous_json)
    SELECT json_extract(value, '$.cycle.month'), ?, value, value FROM json_each(?)
    WHERE EXISTS (SELECT 1 FROM app_state WHERE id = 1 AND commit_id = ?)
    ON CONFLICT(month) DO UPDATE SET previous_json = cycle_backups.json, json = excluded.json, revision = excluded.revision`)
    .bind(state.revision, JSON.stringify(snapshots(state, date)), commit);
}
export async function updateState(db, state, action, revision, date, receipt) {
  if (state.revision !== revision) throw conflict();
  const next = structuredClone(state);
  try { applyAction(next, action, date); next.revision++; validateState(next); }
  catch (error) { throw fail(error.message, 400); }
  const commit = crypto.randomUUID();
  const statements = [db.prepare('UPDATE app_state SET previous_json = json, json = ?, revision = ?, commit_id = ? WHERE id = 1 AND revision = ?').bind(stateJSON(next), next.revision, commit, revision), backupStatement(db, next, date, commit)];
  if (receipt) statements.push(db.prepare(`INSERT INTO receipts (month, id, type, bytes, data_url)
    SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM app_state WHERE id = 1 AND commit_id = ?)`)
    .bind(action.month, action.receipt.id, receipt.type, receipt.buffer.length, receipt.dataUrl, commit));
  // D1 batches are transactional. The commit fence also protects backups/images
  // when another device wins the revision check: no partial writes or orphans.
  const results = await db.batch(statements);
  if (results[0].meta.changes !== 1) throw conflict();
  return next;
}
export async function importState(db, state, date) {
  const json = stateJSON(state);
  if (!availableMonths(state, date).length) throw fail('El primer ciclo debe empezar este mes o antes.', 400);
  const stored = (await db.prepare('SELECT month, id, type, bytes FROM receipts').all()).results;
  for (const [month, cycle] of Object.entries(state.cycles)) {
    for (const payday of Object.values(cycle.paydays)) for (const receipt of payday.receipts || []) {
      if (!stored.some(r => r.month === month && r.id === receipt.id && r.type === receipt.type && r.bytes === receipt.bytes)) throw fail('Falta migrar un comprobante. Los registros todavía no se han importado.', 400);
    }
  }
  const commit = crypto.randomUUID();
  const results = await db.batch([db.prepare('INSERT INTO app_state (id, revision, json, previous_json, commit_id) SELECT 1, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM app_state WHERE id = 1)').bind(state.revision, json, json, commit), backupStatement(db, state, date, commit)]);
  if (results[0].meta.changes !== 1) throw fail('Ya existen registros en la nube. No se sobrescribieron.', 409);
}
