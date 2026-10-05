import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createApp } from '../server.mjs';
import { Store } from '../lib/store.mjs';
import { personalView } from '../lib/personal.mjs';
import { createState, cycleView, today } from '../lib/domain.mjs';
import worker from '../cloud/worker.mjs';
import { sessionCookie } from '../cloud/auth.mjs';
import { importState, loadState } from '../cloud/store.mjs';

const fixtureDate = '2026-10-05';
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'renta-personal-api-'));
  const app = await createApp({ directory, date: fixtureDate });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const get = async (person = 'daniel', month = '2026-10') => {
    const response = await fetch(`${origin}/api/personal?person=${encodeURIComponent(person)}&month=${month}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const save = (action, revision = app.store.state.revision, route = '/api/personal/action') => fetch(origin + route, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision, action: { person: 'daniel', month: '2026-10', ...action } })
  });
  const expense = (id, amount, options = {}) => save({ type: 'save-personal-expense', id, name: 'Carro', amount, schedule: 'quincenal', scope: 'cycle', ...options });
  return { ...app, directory, origin, get, save, expense };
}

test('personal pages show separate defaults without modifying legacy shared records', async t => {
  const f = await fixture(t), before = await readFile(f.store.file, 'utf8');
  for (const person of ['daniel', 'sofia']) {
    const page = await fetch(`${f.origin}/${person}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /lang="es-MX"/); assert.match(html, /personal\.js/);
  }
  assert.equal((await fetch(`${f.origin}/personal.js`)).status, 200);
  const daniel = await f.get(), sofia = await f.get('sofia');
  assert.deepEqual(daniel.availableMonths, ['2026-10', '2026-11']);
  assert.equal(daniel.personal.person, 'daniel'); assert.equal(sofia.personal.name, 'Sofía');
  assert.equal(daniel.personal.totals.income, 4800000);
  assert.equal(daniel.personal.totals.expenses, 2070000);
  assert.equal(sofia.personal.totals.expenses, 329300);
  assert.equal(daniel.personal.expenses.some(e => /renta/i.test(e.name)), false);
  assert.equal(sofia.personal.expenses.some(e => /renta/i.test(e.name)), false);
  assert.equal(sofia.personal.payments.length, 4);
  assert.equal(sofia.personal.payments.every(p => p.dueDate === null && !p.paid && !p.overdue), true);
  assert.equal(daniel.personal.payments.filter(p => p.expenseId === 'dnd').length, 4);
  assert.equal(daniel.personal.payments.find(p => p.expenseId === 'telefonos').overdue, true);
  for (const view of [daniel.personal, sofia.personal]) {
    assert.equal(view.totals.remaining, view.totals.income - view.totals.expenses - view.totals.household);
    assert.equal(view.totals.household, view.household.contributions.reduce((sum, p) => sum + p.amount, 0));
    assert.equal(view.household.contributions.every(p => p.date.startsWith('2026-10-')), true);
  }
  assert.equal(await readFile(f.store.file, 'utf8'), before);
  assert.equal(f.store.state.personal, undefined);
});

test('personal edits are isolated by person, respect effective months and survive restart', async t => {
  const f = await fixture(t);
  const shared = structuredClone({ cycles: f.store.state.cycles, expenses: f.store.state.expenses });
  let response = await f.expense('carro', 1200000); assert.equal(response.status, 200);
  assert.equal((await response.json()).personal.expenses.find(e => e.id === 'carro').plannedAmount, 1200000);
  assert.equal((await f.get('daniel', '2026-11')).personal.expenses.find(e => e.id === 'carro').plannedAmount, 1000000);
  response = await f.expense('gasolina', 350000, { name: 'Gasolina', scope: 'future' }); assert.equal(response.status, 200);
  assert.equal((await f.get('daniel', '2026-11')).personal.expenses.find(e => e.id === 'gasolina').plannedAmount, 350000);
  response = await f.save({ type: 'save-personal-expense', person: 'sofia', id: 'mesa', name: 'Mesa', amount: 100000, schedule: 'monthly', day: 10, scope: 'cycle' });
  assert.equal(response.status, 200);
  const sofia = (await response.json()).personal;
  assert.equal(sofia.payments.find(p => p.expenseId === 'mesa').dueDate, '2026-10-10');
  assert.equal((await f.get('sofia', '2026-11')).personal.payments.find(p => p.expenseId === 'mesa').dueDate, null);
  assert.equal((await f.get()).personal.expenses.some(e => e.id === 'mesa'), false);
  assert.deepEqual({ cycles: f.store.state.cycles, expenses: f.store.state.expenses }, shared);
  const reopened = await new Store(f.directory).load();
  assert.equal(personalView(reopened.state, 'daniel', '2026-10', fixtureDate).expenses.find(e => e.id === 'carro').plannedAmount, 1200000);
  assert.equal(personalView(reopened.state, 'sofia', '2026-10', fixtureDate).payments.find(p => p.expenseId === 'mesa').dueDate, '2026-10-10');
});

test('real personal payments change the balance while closed amounts survive budget changes', async t => {
  const f = await fixture(t), initial = (await f.get()).personal;
  let response = await f.save({ type: 'record-personal-payment', id: 'carro:0', amount: 600000, paidDate: fixtureDate });
  assert.equal(response.status, 200);
  const paid = (await response.json()).personal;
  assert.equal(paid.totals.paid, 600000); assert.equal(paid.totals.expenses, initial.totals.expenses + 100000);
  assert.equal(paid.totals.remaining, initial.totals.remaining - 100000);
  const closed = structuredClone(f.store.state.personal.daniel.months['2026-10'].payments['carro:0']);
  response = await f.save({ type: 'record-personal-payment', id: 'carro:0', amount: 100000, paidDate: fixtureDate });
  assert.equal(response.status, 400);
  assert.equal((await f.expense('carro', 1200000)).status, 200);
  const revised = (await f.get()).personal;
  assert.equal(revised.payments.find(p => p.id === 'carro:0').amount, 600000);
  assert.equal(revised.payments.find(p => p.id === 'carro:1').amount, 700000);
  assert.deepEqual(f.store.state.personal.daniel.months['2026-10'].payments['carro:0'], closed);
  assert.equal((await f.save({ type: 'reopen-personal-payment', id: 'carro:0' })).status, 200);
  const reopened = (await f.get()).personal;
  assert.equal(reopened.totals.paid, 0); assert.equal(reopened.payments.find(p => p.id === 'carro:0').amount, 600000);
  response = await f.save({ type: 'record-personal-payment', id: 'carro:0', amount: 0, paidDate: fixtureDate });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).personal.payments.find(p => p.id === 'carro:0').paid, true);
});

test('additions and deletions retain real payments and apply only to the selected scope', async t => {
  const f = await fixture(t);
  let response = await f.save({ type: 'save-personal-expense', name: 'Consulta', amount: 80000, schedule: 'monthly', day: 8, scope: 'cycle' });
  assert.equal(response.status, 200);
  let view = (await response.json()).personal;
  const added = view.expenses.find(e => e.name === 'Consulta'); assert.ok(added);
  assert.equal((await f.get('daniel', '2026-11')).personal.expenses.some(e => e.id === added.id), false);
  assert.equal((await f.save({ type: 'record-personal-payment', id: `${added.id}:0`, amount: 65000, paidDate: fixtureDate })).status, 200);
  response = await f.save({ type: 'delete-personal-expense', id: added.id, scope: 'cycle' }); assert.equal(response.status, 200);
  view = (await response.json()).personal;
  assert.equal(view.expenses.some(e => e.id === added.id), false);
  assert.equal(view.payments.find(p => p.id === `${added.id}:0`).amount, 65000);
  assert.equal((await f.save({ type: 'delete-personal-expense', id: 'ocio', scope: 'future' })).status, 200);
  assert.equal((await f.get('daniel', '2026-11')).personal.expenses.some(e => e.id === 'ocio'), false);
});

test('household contributions are derived from both funding cycles and cannot be edited as personal expenses', async t => {
  const f = await fixture(t);
  const first = (await f.get()).personal;
  assert.deepEqual(first.household.contributions.map(p => p.date), ['2026-10-15', '2026-10-30']);
  assert.equal((await f.save({ type: 'close-payday', id: 'daniel:2026-10-15', paid: 400000 }, 0, '/api/action')).status, 200);
  const closed = structuredClone(f.store.state.cycles['2026-10'].paydays['daniel:2026-10-15']);
  let personal = (await f.get()).personal;
  assert.equal(personal.household.contributions.find(p => p.date === '2026-10-15').amount, 400000);
  assert.equal(personal.household.saved, 400000);
  assert.equal((await f.expense('carro', 1100000)).status, 200);
  assert.deepEqual(f.store.state.cycles['2026-10'].paydays['daniel:2026-10-15'], closed);
  assert.equal((await f.save({ type: 'save-expense', id: 'luz', name: 'Luz', amount: 200000, scope: 'cycle', month: '2026-11' }, f.store.state.revision, '/api/action')).status, 200);
  personal = (await f.get()).personal;
  assert.equal(personal.household.contributions.find(p => p.date === '2026-10-15').amount, 400000);
  assert.ok(personal.household.contributions.find(p => p.date === '2026-10-30').amount > first.household.contributions.find(p => p.date === '2026-10-30').amount);
  assert.equal((await f.save({ type: 'save-personal-expense', id: 'renta', name: 'Renta', amount: 1700000, schedule: 'monthly', day: 15, scope: 'cycle' })).status, 400);
});

test('personal changes validate input and share revision conflicts with the household', async t => {
  const f = await fixture(t);
  for (const query of ['person=otra&month=2026-10', 'person=__proto__&month=2026-10', 'person=sofia&month=2026-09', 'person=daniel&month=2026-12', 'person=daniel&month=2026-99']) {
    assert.equal((await fetch(`${f.origin}/api/personal?${query}`)).status, 400);
  }
  const before = await readFile(f.store.file, 'utf8');
  for (const action of [
    { type: 'save-personal-expense', id: 'carro', name: '', amount: 1, schedule: 'monthly', scope: 'cycle' },
    { type: 'save-personal-expense', id: 'carro', name: 'Carro', amount: -1, schedule: 'monthly', scope: 'cycle' },
    { type: 'save-personal-expense', id: 'carro', name: 'Carro', amount: 1, schedule: 'daily', scope: 'cycle' },
    { type: 'save-personal-expense', id: 'carro', name: 'Carro', amount: 1, schedule: 'monthly', day: 0, scope: 'cycle' },
    { type: 'save-personal-expense', id: 'carro', name: 'Carro', amount: 1, schedule: 'monthly', scope: 'other' },
    { type: 'record-personal-payment', id: 'carro:0', amount: 1, paidDate: '2026-02-30' },
    { type: 'close-payday', id: 'daniel:2026-10-15', paid: 1 }
  ]) assert.equal((await f.save(action)).status, 400);
  assert.equal(await readFile(f.store.file, 'utf8'), before);
  const responses = await Promise.all([
    f.expense('carro', 1100000),
    f.save({ type: 'save-personal-expense', person: 'sofia', id: 'mesa', name: 'Mesa', amount: 95000, schedule: 'unscheduled', scope: 'cycle' }, 0)
  ]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal(f.store.state.revision, 1);
  assert.equal((await f.save({ type: 'save-expense', id: 'luz', name: 'Luz', amount: 125000, scope: 'cycle' }, 0, '/api/action')).status, 409);
  const alien = await fetch(`${f.origin}/api/personal/action`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(alien.status, 403);
});

test('cloud personal routes retain authentication, redirect destination, D1 persistence and concurrency', async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(); } }', compatibilityDate: '2026-10-05', d1Databases: { DB: 'personal-cloud-test' } }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const sql = await readFile(new URL('../cloud/migrations/0001_storage.sql', import.meta.url), 'utf8');
  await db.batch(sql.split(';').filter(s => s.trim()).map(s => db.prepare(s)));
  const date = today(), state = createState(date), month = state.initialMonth;
  await importState(db, state, date);
  const origin = 'https://renta.example', password = 'personal-cloud-test-password-fixture';
  const cookie = (await sessionCookie(password, new URL(origin))).split(';')[0];
  const assetRoutes = [];
  const env = { DB: db, APP_PASSWORD: password, ASSETS: { fetch: async request => { assetRoutes.push(new URL(request.url).pathname); return new Response('<html lang="es-MX">Calendario personal</html>'); } } };
  const call = (route, body, anonymous = false) => worker.fetch(new Request(origin + route, {
    method: body ? 'POST' : 'GET', headers: { ...(anonymous ? {} : { Cookie: cookie }), ...(body ? { Origin: origin, 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {})
  }), env);
  for (const person of ['daniel', 'sofia']) {
    const response = await call(`/${person}`, null, true);
    assert.equal(response.status, 303);
    assert.equal(new URL(response.headers.get('Location'), origin).pathname, '/login');
    assert.equal(new URL(response.headers.get('Location'), origin).searchParams.get('next'), `/${person}`);
    assert.equal((await call(`/${person}`)).status, 200);
  }
  assert.ok(assetRoutes.includes('/personal'));
  assert.equal((await call('/personal.js')).status, 200);
  assert.equal((await call(`/api/personal?person=daniel&month=${month}`, null, true)).status, 401);
  const operation = amount => ({ revision: 0, action: { type: 'save-personal-expense', person: 'sofia', month, id: 'mesa', name: 'Mesa', amount, schedule: 'monthly', day: 20, scope: 'cycle' } });
  const responses = await Promise.all([call('/api/personal/action', operation(100000)), call('/api/personal/action', operation(110000))]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const stored = await loadState(db);
  assert.equal(stored.revision, 1);
  assert.ok([100000, 110000].includes(personalView(stored, 'sofia', month, date).expenses.find(e => e.id === 'mesa').plannedAmount));
  assert.equal(personalView(stored, 'daniel', month, date).totals.expenses, 2070000);
  assert.deepEqual(stored.cycles, state.cycles);
  const result = await (await call(`/api/personal?person=sofia&month=${month}`)).json();
  assert.equal(result.storage, 'cloud'); assert.equal(result.revision, 1);
  const login = next => worker.fetch(new Request(origin + '/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password, next }) }), env);
  assert.equal((await login('/sofia')).headers.get('Location'), '/sofia');
  assert.equal((await login('https://evil.example/')).headers.get('Location'), '/');
  const backup = await (await call(`/api/backup?month=${month}`)).json();
  assert.ok(backup.personal);
  assert.equal(cycleView(stored, month, date).totals.saved, 0);
});
