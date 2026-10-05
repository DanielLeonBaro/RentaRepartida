import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createApp, decodeReceipt } from '../server.mjs';
import { Store } from '../lib/store.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'renta-test-'));
  const app = await createApp({ directory, date: '2026-10-05' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const action = (action, revision) => fetch(`${origin}/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ action: { month: '2026-10', ...action }, revision }) });
  return { ...app, directory, origin, action };
}
test('serves the Spanish application locally and guards mutation requests', async t => {
  const f = await fixture(t);
  const page = await fetch(f.origin);
  assert.equal(page.status, 200); assert.match(await page.text(), /lang="es-MX"/);
  const result = await (await fetch(`${f.origin}/api/cycle`)).json();
  assert.equal(result.cycle.month, '2026-10'); assert.equal(result.cycle.totals.total, 1780000);
  const health = await (await fetch(`${f.origin}/api/health`)).json(); assert.equal(health.app, 'renta-repartida');
  const alien = await fetch(`${f.origin}/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' }, body: '{}' }); assert.equal(alien.status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const request = http.get(`${f.origin}/api/cycle`, { headers: { Host: 'evil.test' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  }); assert.equal(hostStatus, 403);
  const traversal = await fetch(`${f.origin}/data/estado.json`); assert.equal(traversal.status, 404);
  const invalid = await fetch(`${f.origin}/api/cycle?month=2026-99`); assert.equal(invalid.status, 400);
  const snapshot = await fetch(`${f.origin}/api/backup?month=2026-10`);
  assert.equal(snapshot.status, 200); assert.match(snapshot.headers.get('Content-Disposition'), /renta-2026-10.json/);
  assert.equal((await snapshot.json()).cycle.totals.total, 1780000);
  assert.equal((await fetch(`${f.origin}/api/backup?month=2026-09`)).status, 400);
  const malformed = await fetch(`${f.origin}/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }); assert.equal(malformed.status, 400);
});
test('saving writes exact JSON, keeps a prior backup and survives reopening', async t => {
  const f = await fixture(t);
  const response = await f.action({ type: 'close-payday', id: 'sofia:2026-09-20', paid: 12345 }, 0);
  assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.revision, 1);
  const disk = JSON.parse(await readFile(path.join(f.directory, 'estado.json'), 'utf8'));
  const backup = JSON.parse(await readFile(path.join(f.directory, 'estado.respaldo.json'), 'utf8'));
  assert.equal(disk.revision, 1); assert.equal(backup.revision, 0);
  const reopened = await new Store(f.directory).load();
  assert.equal(reopened.state.cycles['2026-10'].paydays['sofia:2026-09-20'].paid, 12345);
  assert.ok(!(await readdir(f.directory)).some(name => name.endsWith('.tmp')));
});
test('simultaneous saves serialize: only one succeeds and a stale tab cannot overwrite', async t => {
  const f = await fixture(t);
  const operation = { type: 'save-expense', id: 'luz', name: 'Luz', amount: 120000, scope: 'cycle' };
  const responses = await Promise.all([f.action(operation, 0), f.action({ ...operation, amount: 150000 }, 0)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal(f.store.state.revision, 1);
  const stale = await f.action(operation, 0); assert.equal(stale.status, 409); assert.match((await stale.json()).error, /otra pestaña/);
});
test('validation and closed-payday failures leave disk and revision unchanged', async t => {
  const f = await fixture(t);
  let response = await f.action({ type: 'close-payday', id: 'daniel:2026-09-30', paid: 0 }, 0); assert.equal(response.status, 200);
  const before = await readFile(path.join(f.directory, 'estado.json'), 'utf8');
  response = await f.action({ type: 'update-payday', id: 'daniel:2026-09-30', income: 2400000, available: 0 }, 1); assert.equal(response.status, 400);
  response = await f.action({ type: 'save-expense', name: '', amount: 1000, scope: 'cycle' }, 1); assert.equal(response.status, 400);
  assert.equal(await readFile(path.join(f.directory, 'estado.json'), 'utf8'), before); assert.equal(f.store.state.revision, 1);
});
test('a write failure preserves committed state and allows a later retry', async t => {
  const f = await fixture(t);
  const original = f.store.atomicWrite.bind(f.store);
  f.store.atomicWrite = async (file, value) => { if (file === f.store.file) throw new Error('simulated write failure'); return original(file, value); };
  const action = { type: 'close-payday', id: 'sofia:2026-09-20', paid: 10000 };
  await assert.rejects(f.store.update({ ...action, month: '2026-10' }, 0, '2026-10-05'), /No se pudo guardar/);
  assert.equal(f.store.state.revision, 0);
  assert.equal(JSON.parse(await readFile(f.store.file, 'utf8')).revision, 0);
  f.store.atomicWrite = original;
  assert.equal((await f.action(action, 0)).status, 200);
});
test('corrupt main file loads backup visibly; two corrupt files are preserved', async t => {
  const f = await fixture(t);
  await f.action({ type: 'close-payday', id: 'sofia:2026-09-20', paid: 10000 }, 0);
  await f.action({ type: 'save-expense', id: 'luz', name: 'Luz', amount: 140000, scope: 'cycle' }, 1);
  await writeFile(f.store.file, 'invalid JSON');
  const recovered = await new Store(f.directory).load();
  assert.equal(recovered.state.revision, 1); assert.match(recovered.warning, /respaldo/);
  assert.equal(await readFile(f.store.file, 'utf8'), 'invalid JSON');
  await recovered.update({ type: 'save-expense', month: '2026-10', id: 'luz', name: 'Luz', amount: 150000, scope: 'cycle' }, 1, '2026-10-05');
  assert.equal(recovered.warning, '');
  await writeFile(f.store.file, 'broken main'); await writeFile(f.store.backup, 'broken backup');
  await assert.rejects(new Store(f.directory).load(), /archivos se conservaron/);
  assert.equal(await readFile(f.store.file, 'utf8'), 'broken main'); assert.equal(await readFile(f.store.backup, 'utf8'), 'broken backup');
});

test('per-cycle snapshots and prior copies preserve records and expand with the calendar', async t => {
  const f = await fixture(t);
  const files = await readdir(path.join(f.directory, 'ciclos'));
  assert.deepEqual(files.sort(), ['2026-10.json', '2026-10.respaldo.json', '2026-11.json', '2026-11.respaldo.json']);
  let response = await f.action({ type: 'close-payday', id: 'sofia:2026-09-20', paid: 12345 }, 0); assert.equal(response.status, 200);
  const snapshot = JSON.parse(await readFile(path.join(f.directory, 'ciclos', '2026-10.json'), 'utf8'));
  const previous = JSON.parse(await readFile(path.join(f.directory, 'ciclos', '2026-10.respaldo.json'), 'utf8'));
  assert.equal(snapshot.cycle.totals.saved, 12345); assert.equal(previous.cycle.totals.saved, 0);
  assert.equal((await fetch(`${f.origin}/api/cycle?month=2026-09`)).status, 400);
  assert.equal((await fetch(`${f.origin}/api/cycle?month=2026-12`)).status, 400);
  await f.store.ensureSnapshots('2026-11-01');
  const december = JSON.parse(await readFile(path.join(f.directory, 'ciclos', '2026-12.json'), 'utf8'));
  assert.equal(december.cycle.month, '2026-12');
  assert.equal(f.store.state.revision, 1);
});
test('per-cycle backup failures are visible without losing a successfully committed change', async t => {
  const f = await fixture(t), original = f.store.atomicWrite.bind(f.store);
  f.store.atomicWrite = async (file, value) => { if (path.dirname(file) === path.join(f.directory, 'ciclos')) throw new Error('simulated snapshot failure'); return original(file, value); };
  const response = await f.action({ type: 'close-payday', id: 'sofia:2026-09-20', paid: 10000 }, 0);
  assert.equal(response.status, 200); assert.match((await response.json()).warning, /respaldo por ciclo/);
  assert.equal(JSON.parse(await readFile(f.store.file, 'utf8')).revision, 1);
  f.store.atomicWrite = original; await f.store.ensureSnapshots('2026-10-05');
  assert.equal(f.store.warning, '');
});
const imageData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a87sAAAAASUVORK5CYII=';
test('image receipts survive upload, reopening, corrections and server restart', async t => {
  const f = await fixture(t);
  await f.action({ type: 'close-payday', id: 'sofia:2026-09-20', paid: 50000 }, 0);
  const upload = revision => fetch(`${f.origin}/api/receipt`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.origin }, body: JSON.stringify({ month: '2026-10', paydayId: 'sofia:2026-09-20', revision, name: 'captura.png', dataUrl: imageData }) });
  const response = await upload(1); assert.equal(response.status, 200);
  const result = await response.json(), p = result.cycle.paydays.find(p => p.id === 'sofia:2026-09-20');
  assert.equal(p.paid, 50000); assert.equal(p.receipts.length, 1);
  const receipt = p.receipts[0];
  const url = `${f.origin}/comprobantes/2026-10/${receipt.id}`;
  const image = await fetch(url); assert.equal(image.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), decodeReceipt(imageData).buffer);
  const stale = await upload(1); assert.equal(stale.status, 409);
  assert.equal((await readdir(path.join(f.directory, 'comprobantes', '2026-10'))).length, 1);
  await f.action({ type: 'reopen-payday', id: p.id }, 2);
  await f.action({ type: 'update-payday', id: p.id, income: 100000, available: 75000 }, 3);
  await f.action({ type: 'close-payday', id: p.id, paid: 25000 }, 4);
  const reopened = await new Store(f.directory).load();
  assert.equal(reopened.state.cycles['2026-10'].paydays[p.id].receipts[0].id, receipt.id);
  assert.equal(reopened.state.cycles['2026-10'].paydays[p.id].paid, 25000);
  assert.equal((await fetch(url)).status, 200);
  assert.throws(() => decodeReceipt('data:image/svg+xml;base64,PHN2Zz4='), /imagen/);
  assert.throws(() => decodeReceipt(imageData.replace('image/png', 'image/jpeg')), /archivo/);
  const fake = await f.action({ type: 'attach-receipt', id: p.id, receipt }, 5); assert.equal(fake.status, 400);
});
