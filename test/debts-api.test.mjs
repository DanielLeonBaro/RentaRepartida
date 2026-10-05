import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createApp } from '../server.mjs';
import { Store } from '../lib/store.mjs';
import { createState, today } from '../lib/domain.mjs';
import worker from '../cloud/worker.mjs';
import { sessionCookie } from '../cloud/auth.mjs';
import { importState, loadState } from '../cloud/store.mjs';

const fixtureDate = '2026-10-05';
const view = payload => payload.personal || payload.cycle;
const debtView = payload => view(payload).debts;
const findDebt = (payload, name) => debtView(payload).debts.find(debt => debt.name === name);

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'renta-debts-api-'));
  const app = await createApp({ directory, date: fixtureDate });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const get = async (owner = 'daniel', month = '2026-10') => {
    const route = owner === 'hogar' ? `/api/cycle?month=${month}` : `/api/personal?person=${owner}&month=${month}`;
    const response = await fetch(origin + route);
    assert.equal(response.status, 200);
    return response.json();
  };
  const save = (action, options = {}) => fetch(origin + (options.route || '/api/debts/action'), {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: options.revision ?? app.store.state.revision, viewOwner: options.viewOwner || action.owner || 'daniel', ...(options.viewMonth ? { viewMonth: options.viewMonth } : {}), action: { owner: 'daniel', month: '2026-10', ...action } })
  });
  const create = async (name, options = {}) => {
    const response = await save({ type: 'save-debt', name, balance: 100000, monthlyPayment: 0, dueDay: null, ...options });
    assert.equal(response.status, 200);
    const payload = await response.json();
    return { payload, debt: findDebt(payload, name) };
  };
  return { ...app, directory, origin, get, save, create };
}

test('debt defaults are read-only, personal and do not charge full balances to monthly budgets', async t => {
  const f = await fixture(t), before = await readFile(f.store.file, 'utf8');
  const daniel = await f.get(), sofia = await f.get('sofia'), household = await f.get('hogar');
  assert.equal((await fetch(f.origin + '/debts.js')).status, 200);
  assert.equal(debtView(daniel).owner, 'daniel');
  assert.equal(debtView(daniel).debts.length, 5);
  for (const [name, balance, day] of [['Hey banco', 7000000, 13], ['CITI Banamex', 1000000, null], ['NU', 800000, 17], ['BBVA', 2000000, 12], ['MercadoPago', 2400000, 1]]) {
    const debt = findDebt(daniel, name);
    assert.ok(debt, name); assert.equal(debt.balance, balance); assert.equal(debt.dueDay, day);
    assert.equal(debt.monthlyPayment, 0); assert.equal(debt.monthPaid, 0); assert.equal(debt.monthPending, 0);
    assert.equal(debt.dueDate, day ? `2026-10-${String(day).padStart(2, '0')}` : null);
    assert.deepEqual(debt.payments, []);
  }
  assert.equal(debtView(daniel).totals.balance, 13200000);
  assert.equal(debtView(daniel).totals.budget, 0);
  assert.equal(daniel.personal.totals.expenses, 2070000);
  assert.equal(sofia.personal.totals.expenses, 329300);
  assert.equal(household.cycle.totals.total, 1780000);
  assert.deepEqual(debtView(sofia).debts, []); assert.deepEqual(debtView(household).debts, []);
  assert.equal(await readFile(f.store.file, 'utf8'), before);
  assert.equal(f.store.state.debts, undefined);
});

test('partial payments reduce a balance and change only their selected monthly budget', async t => {
  const f = await fixture(t), initial = await f.get(), id = findDebt(initial, 'Hey banco').id;
  let response = await f.save({ type: 'record-debt-payment', id, amount: 12345, paidDate: fixtureDate });
  assert.equal(response.status, 200);
  let payload = await response.json(), debt = findDebt(payload, 'Hey banco');
  assert.equal(debt.balance, 7000000 - 12345); assert.equal(debt.totalPaid, 12345);
  assert.equal(debt.monthPaid, 12345); assert.equal(debt.monthPending, 0); assert.equal(debt.monthBudget, 12345);
  assert.equal(payload.personal.totals.expenses, initial.personal.totals.expenses + 12345);
  assert.equal(payload.personal.totals.paid, 12345);
  assert.equal(payload.personal.totals.remaining, initial.personal.totals.remaining - 12345);
  assert.equal((await f.get('daniel', '2026-11')).personal.totals.expenses, initial.personal.totals.expenses);
  response = await f.save({ type: 'record-debt-payment', id, month: '2026-11', amount: 50000, paidDate: '2026-10-30' });
  assert.equal(response.status, 200);
  payload = await response.json(); debt = findDebt(payload, 'Hey banco');
  assert.equal(debt.balance, 7000000 - 62345); assert.equal(debt.monthPaid, 50000);
  assert.equal(debt.payments.length, 2);
  assert.deepEqual(debt.payments.map(p => [p.month, p.paidDate, p.amount]), [['2026-10', fixtureDate, 12345], ['2026-11', '2026-10-30', 50000]]);
  const october = await f.get();
  assert.equal(findDebt(october, 'Hey banco').monthPaid, 12345);
  assert.equal(october.personal.totals.expenses, initial.personal.totals.expenses + 12345);
  assert.equal((await f.get('sofia')).personal.totals.expenses, 329300);
  assert.equal((await f.get('hogar')).cycle.totals.total, 1780000);
});

test('payment corrections and cancellation restore cents exactly without deleting other installments', async t => {
  const f = await fixture(t), { debt } = await f.create('Prueba exacta', { balance: 100003 });
  let response = await f.save({ type: 'record-debt-payment', id: debt.id, amount: 40001, paidDate: fixtureDate });
  assert.equal(response.status, 200);
  let payload = await response.json(), first = findDebt(payload, debt.name).payments[0];
  response = await f.save({ type: 'record-debt-payment', id: debt.id, amount: 20002, paidDate: '2026-10-06' });
  assert.equal(response.status, 200);
  const second = findDebt(await response.json(), debt.name).payments.find(p => p.id !== first.id);
  response = await f.save({ type: 'record-debt-payment', id: debt.id, paymentId: first.id, amount: 30001, paidDate: '2026-10-04' }, { viewMonth: '2026-11' });
  assert.equal(response.status, 200);
  payload = await response.json();
  assert.equal(payload.personal.month, '2026-11');
  let updated = findDebt(payload, debt.name);
  assert.equal(updated.balance, 50000); assert.equal(updated.payments.length, 2);
  assert.equal(updated.payments.find(p => p.id === first.id).paidDate, '2026-10-04');
  assert.equal(updated.payments.find(p => p.id === second.id).amount, 20002);
  response = await f.save({ type: 'delete-debt-payment', id: debt.id, paymentId: first.id });
  assert.equal(response.status, 200);
  updated = findDebt(await response.json(), debt.name);
  assert.equal(updated.balance, 80001); assert.equal(updated.monthPaid, 20002);
  assert.deepEqual(updated.payments.map(p => p.id), [second.id]);
  assert.equal((await f.save({ type: 'delete-debt-payment', id: debt.id, paymentId: first.id })).status, 400);
});

test('monthly plans add only available balance, paid installments remain real and zero plans stay optional', async t => {
  const f = await fixture(t), original = await f.get();
  const { debt } = await f.create('Cuota variable', { balance: 100000, monthlyPayment: 40000, dueDay: 10 });
  let current = await f.get(), selected = findDebt(current, debt.name);
  assert.equal(selected.monthPending, 40000); assert.equal(selected.monthBudget, 40000);
  assert.equal(current.personal.totals.expenses, original.personal.totals.expenses + 40000);
  assert.equal(current.personal.totals.paid, 0);
  assert.equal((await f.save({ type: 'record-debt-payment', id: debt.id, amount: 55000, paidDate: fixtureDate })).status, 200);
  current = await f.get(); selected = findDebt(current, debt.name);
  assert.equal(selected.balance, 45000); assert.equal(selected.monthPending, 0); assert.equal(selected.monthBudget, 55000);
  assert.equal(current.personal.totals.expenses, original.personal.totals.expenses + 55000);
  assert.equal((await f.save({ type: 'save-debt', id: debt.id, name: debt.name, balance: 45000, monthlyPayment: 0, dueDay: null })).status, 200);
  assert.equal(findDebt(await f.get(), debt.name).monthBudget, 55000);
  assert.equal(findDebt(await f.get('daniel', '2026-11'), debt.name).monthBudget, 0);
  assert.equal((await f.save({ type: 'save-debt', month: '2026-11', id: debt.id, name: debt.name, balance: 45000, monthlyPayment: 90000, dueDay: 31 })).status, 200);
  const november = await f.get('daniel', '2026-11');
  assert.equal(findDebt(november, debt.name).monthPending, 45000);
  assert.equal(findDebt(november, debt.name).dueDate, '2026-11-30');
  assert.equal(findDebt(await f.get(), debt.name).monthlyPayment, 0);
  assert.equal(findDebt(await f.get(), debt.name).monthBudget, 55000);
  assert.equal((await f.save({ type: 'save-debt', month: '2026-11', id: debt.id, name: debt.name, balance: 45000, monthlyPayment: 0, dueDay: 31 })).status, 200);
  assert.equal(findDebt(await f.get(), debt.name).monthBudget, 55000);
  assert.equal(findDebt(await f.get('daniel', '2026-11'), debt.name).monthBudget, 0);
});

test('moving or deleting a debt keeps historical payments charged to the person who paid', async t => {
  const f = await fixture(t), { debt } = await f.create('Deuda compartida', { owner: 'sofia', balance: 80000 });
  let response = await f.save({ type: 'record-debt-payment', owner: 'sofia', id: debt.id, amount: 10000, paidDate: fixtureDate });
  assert.equal(response.status, 200);
  const payment = findDebt(await response.json(), debt.name).payments[0];
  response = await f.save({ type: 'save-debt', owner: 'hogar', id: debt.id, name: debt.name, balance: 70000, monthlyPayment: 30000, dueDay: 14 }, { viewOwner: 'sofia' });
  assert.equal(response.status, 200);
  assert.equal(view(await response.json()).person, 'sofia');
  const household = await f.get('hogar'), sofia = await f.get('sofia');
  assert.equal(findDebt(household, debt.name).balance, 70000);
  assert.equal(findDebt(household, debt.name).payments.find(p => p.id === payment.id).owner, 'sofia');
  assert.equal(findDebt(household, debt.name).totalPaid, 10000);
  assert.equal(debtView(household).totals.paid, 0);
  assert.equal(debtView(household).totals.pending, 20000);
  assert.equal(debtView(sofia).payments.find(p => p.id === payment.id).amount, 10000);
  assert.equal(sofia.personal.totals.expenses, 339300);
  const nextMonth = await f.get('sofia', '2026-11');
  assert.equal(findDebt(nextMonth, debt.name).payments.find(p => p.id === payment.id).month, '2026-10');
  assert.equal(findDebt(nextMonth, debt.name).monthPaid, 0);
  assert.equal(debtView(nextMonth).totals.paid, 0);
  assert.equal(nextMonth.personal.totals.expenses, 329300);
  response = await f.save({ type: 'delete-debt', owner: 'hogar', id: debt.id });
  assert.equal(response.status, 200);
  const deleted = await response.json();
  assert.equal(debtView(deleted).debts.some(d => d.id === debt.id && d.active), false);
  assert.equal(debtView(deleted).totals.pending, 0);
  assert.equal(debtView(await f.get('sofia')).payments.find(p => p.id === payment.id).amount, 10000);
  const reopened = await new Store(f.directory, fixtureDate).load();
  assert.deepEqual(reopened.state.debts, f.store.state.debts);
  const snapshot = JSON.parse(await readFile(path.join(f.directory, 'ciclos', '2026-10.json'), 'utf8'));
  assert.equal(snapshot.personal.sofia.debts.payments.find(p => p.id === payment.id).amount, 10000);
  assert.equal(snapshot.cycle.debts.totals.pending, 0);
  assert.equal(snapshot.revision, f.store.state.revision);
});

test('household debt budgets recompute pending contributions and preserve already closed paydays', async t => {
  const f = await fixture(t), before = await f.get('hogar');
  const payday = before.cycle.paydays.find(p => p.person === 'daniel');
  assert.equal((await f.save({ type: 'close-payday', month: '2026-10', id: payday.id, paid: 250000 }, { route: '/api/action' })).status, 200);
  const closed = structuredClone(f.store.state.cycles['2026-10'].paydays[payday.id]);
  const { debt } = await f.create('Refrigerador', { owner: 'hogar', balance: 300000, monthlyPayment: 50000, dueDay: 17 });
  let household = await f.get('hogar');
  assert.equal(household.cycle.totals.total, 1830000); assert.equal(household.cycle.totals.saved, 250000);
  assert.equal(household.cycle.paydays.filter(p => !p.closed).reduce((sum, p) => sum + p.suggested, 0), 1580000);
  assert.equal((await f.save({ type: 'record-debt-payment', owner: 'hogar', id: debt.id, amount: 80000, paidDate: '2026-10-17' })).status, 200);
  household = await f.get('hogar');
  assert.equal(household.cycle.totals.total, 1860000); assert.equal(household.cycle.totals.saved, 250000);
  assert.equal(household.cycle.paydays.filter(p => !p.closed).reduce((sum, p) => sum + p.suggested, 0), 1610000);
  assert.deepEqual(f.store.state.cycles['2026-10'].paydays[payday.id], closed);
  assert.equal((await f.save({ type: 'delete-debt', owner: 'hogar', id: debt.id })).status, 200);
  assert.equal((await f.get('hogar')).cycle.totals.total, 1860000);
});

test('debt routes reject invalid money, dates, owners and stale revisions without writing partial changes', async t => {
  const f = await fixture(t), initial = await f.get(), id = findDebt(initial, 'NU').id;
  const before = await readFile(f.store.file, 'utf8');
  for (const action of [
    { type: 'save-debt', owner: '__proto__', name: 'Otra', balance: 1, monthlyPayment: 0, dueDay: null },
    { type: 'save-debt', name: '', balance: 1, monthlyPayment: 0, dueDay: null },
    { type: 'save-debt', name: 'Otra', balance: -1, monthlyPayment: 0, dueDay: null },
    { type: 'save-debt', name: 'Otra', balance: 1.5, monthlyPayment: 0, dueDay: null },
    { type: 'save-debt', name: 'Otra', balance: 1, monthlyPayment: -1, dueDay: null },
    { type: 'save-debt', name: 'Otra', balance: 1, monthlyPayment: 0, dueDay: 32 },
    { type: 'record-debt-payment', id, amount: 800001, paidDate: fixtureDate },
    { type: 'record-debt-payment', id, amount: -1, paidDate: fixtureDate },
    { type: 'record-debt-payment', id, amount: 1, paidDate: '2026-02-30' },
    { type: 'record-debt-payment', id, amount: 1, paidDate: fixtureDate, paymentId: 'missing' },
    { type: 'delete-debt-payment', id, paymentId: 'missing' },
    { type: 'save-debt', month: '2026-12', name: 'Futura', balance: 1, monthlyPayment: 0, dueDay: null },
    { type: 'close-payday', id: 'daniel:2026-10-15', paid: 1 }
  ]) assert.equal((await f.save(action)).status, 400, JSON.stringify(action));
  assert.equal((await f.save({ type: 'delete-debt', id }, { viewOwner: 'otra' })).status, 400);
  assert.equal((await f.save({ type: 'delete-debt', id }, { viewMonth: '2026-12' })).status, 400);
  assert.equal(await readFile(f.store.file, 'utf8'), before);
  assert.equal((await f.save({ type: 'save-debt', name: 'Prohibida', balance: 1, monthlyPayment: 0, dueDay: null }, { route: '/api/action' })).status, 400);
  assert.equal((await f.save({ type: 'save-debt', name: 'Prohibida', balance: 1, monthlyPayment: 0, dueDay: null }, { route: '/api/personal/action' })).status, 400);
  const responses = await Promise.all([
    f.save({ type: 'record-debt-payment', id, amount: 10000, paidDate: fixtureDate }, { revision: 0 }),
    f.save({ type: 'record-debt-payment', id, amount: 20000, paidDate: fixtureDate }, { revision: 0 })
  ]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal(f.store.state.revision, 1);
  const foreignOrigin = await fetch(f.origin + '/api/debts/action', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(foreignOrigin.status, 403);
});

test('Cloudflare debt actions retain signed sessions, D1 persistence, cycle backups and atomic revision conflicts', async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(); } }', compatibilityDate: fixtureDate, d1Databases: { DB: 'debt-cloud-test' } }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  const sql = await readFile(new URL('../cloud/migrations/0001_storage.sql', import.meta.url), 'utf8');
  await db.batch(sql.split(';').filter(s => s.trim()).map(s => db.prepare(s)));
  const date = today(), state = createState(date), month = state.initialMonth;
  await importState(db, state, date);
  const origin = 'https://renta.example', password = 'debt-cloud-test-fixture-password';
  const cookie = (await sessionCookie(password, new URL(origin))).split(';')[0];
  const env = { DB: db, APP_PASSWORD: password, ASSETS: { fetch: async () => new Response('export const protectedDebtScript = true;') } };
  const call = (route, body, anonymous = false) => worker.fetch(new Request(origin + route, {
    method: body ? 'POST' : 'GET', headers: { ...(anonymous ? {} : { Cookie: cookie }), ...(body ? { Origin: origin, 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {})
  }), env);
  assert.equal((await call('/api/debts/action', { revision: 0, viewOwner: 'daniel', action: { type: 'delete-debt', owner: 'daniel', month, id: 'missing' } }, true)).status, 401);
  assert.equal((await call('/debts.js', null, true)).status, 303);
  assert.equal((await call('/debts.js')).status, 200);
  const before = await loadState(db), initial = await (await call(`/api/personal?person=daniel&month=${month}`)).json();
  const id = findDebt(initial, 'BBVA').id;
  const payment = amount => ({ revision: 0, viewOwner: 'daniel', action: { type: 'record-debt-payment', owner: 'daniel', month, id, amount, paidDate: date } });
  const responses = await Promise.all([call('/api/debts/action', payment(10000)), call('/api/debts/action', payment(20000))]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const stored = await loadState(db);
  assert.equal(stored.revision, 1); assert.deepEqual(stored.cycles, before.cycles);
  const payload = await (await call(`/api/personal?person=daniel&month=${month}`)).json();
  const paid = findDebt(payload, 'BBVA').monthPaid;
  assert.ok([10000, 20000].includes(paid));
  assert.equal(findDebt(payload, 'BBVA').balance, 2000000 - paid);
  assert.equal(payload.personal.totals.expenses, 2070000 + paid);
  assert.equal(payload.storage, 'cloud'); assert.equal(payload.revision, 1);
  const downloaded = await (await call(`/api/backup?month=${month}`)).json();
  assert.equal(downloaded.revision, 1);
  assert.equal(findDebt({ personal: downloaded.personal.daniel }, 'BBVA').monthPaid, paid);
  const backup = await db.prepare('SELECT json, previous_json FROM cycle_backups WHERE month = ?').bind(month).first();
  assert.equal(JSON.parse(backup.previous_json).revision, 0);
  const response = await call('/api/debts/action', { revision: 1, viewOwner: 'daniel', action: { type: 'delete-debt-payment', owner: 'daniel', month, id, paymentId: findDebt(payload, 'BBVA').payments[0].id } });
  assert.equal(response.status, 200);
  const corrected = await response.json();
  assert.equal(findDebt(corrected, 'BBVA').balance, 2000000);
  assert.equal(corrected.personal.totals.expenses, 2070000);
  assert.equal((await loadState(db)).revision, 2);
});
