import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createState, cycleView, MAX_MONEY, validateState } from '../lib/domain.mjs';
import { debtsView } from '../lib/debts.mjs';
import { personalView } from '../lib/personal.mjs';

const initial = () => createState('2026-10-05');
const act = (state, fields, date = '2026-10-05') => applyAction(state, { owner: 'daniel', month: '2026-10', ...fields }, date);
const view = (state, owner = 'daniel', month = '2026-10', date = '2026-10-05') => debtsView(state, owner, month, date);
const save = (state, fields = {}) => act(state, { type: 'save-debt', id: 'hey-banco', name: 'Hey banco', balance: 7000000, monthlyPayment: 0, dueDay: 13, ...fields });
const pay = (state, fields = {}) => act(state, { type: 'record-debt-payment', id: 'hey-banco', amount: 100000, paidDate: '2026-10-13', ...fields });
const debt = (state, id = 'hey-banco', owner = 'daniel', month = '2026-10') => view(state, owner, month).debts.find(row => row.id === id);

test('legacy state exposes debts without writing them or charging the balances as expenses', () => {
  const state = initial(), before = structuredClone(state);
  const daniel = view(state);
  assert.deepEqual(state, before);
  assert.equal(daniel.debts.length, 5); assert.equal(daniel.totals.balance, 13200000);
  assert.deepEqual(daniel.debts.map(row => [row.name, row.balance, row.dueDay]).sort(), [
    ['BBVA', 2000000, 12], ['CITI Banamex', 1000000, null], ['Hey banco', 7000000, 13], ['MercadoPago', 2400000, 1], ['NU', 800000, 17]
  ]);
  assert.ok(daniel.debts.every(row => row.monthlyPayment === 0 && !row.overdue));
  assert.deepEqual(view(state, 'sofia').debts, []); assert.deepEqual(view(state, 'hogar').debts, []);
  assert.equal(daniel.totals.budget, 0); assert.equal(cycleView(state, '2026-10').totals.total, 1780000);
  assert.equal(personalView(state, 'daniel', '2026-10').totals.expenses, 2070000);
  assert.equal(validateState(state), state);
});

test('multiple partial abonos reduce the balance and enter only their own month budget', () => {
  const state = initial();
  pay(state, { amount: 12345 }); pay(state, { amount: 45678 });
  assert.equal(debt(state).balance, 7000000 - 12345 - 45678);
  assert.equal(debt(state).totalPaid, 58023); assert.equal(debt(state).monthPaid, 58023);
  assert.equal(view(state).totals.budget, 58023); assert.equal(view(state).totals.pending, 0);
  assert.equal(view(state, 'daniel', '2026-11').totals.paid, 0);
  const personal = personalView(state, 'daniel', '2026-10');
  assert.equal(personal.totals.debts, 58023); assert.equal(personal.totals.expenses, 2070000 + 58023);
  assert.equal(personal.totals.paid, 58023); assert.equal(personal.totals.remaining, personal.totals.income - personal.totals.expenses - personal.household.total);
  assert.equal(cycleView(state, '2026-10').totals.total, 1780000);
  assert.equal(personalView(state, 'sofia', '2026-10').totals.expenses, 329300);
  validateState(state);
});

test('planned monthly abonos are capped at the remaining balance and never record a payment', () => {
  const state = initial(); save(state, { balance: 120000, monthlyPayment: 100000 });
  assert.equal(debt(state).monthPending, 100000); assert.equal(debt(state).monthBudget, 100000);
  assert.equal(debt(state).payments.length, 0); assert.equal(debt(state).balance, 120000);
  assert.equal(view(state, 'daniel', '2026-11').totals.pending, 0);
  pay(state, { amount: 90000 });
  assert.equal(debt(state).balance, 30000); assert.equal(debt(state).monthPending, 10000); assert.equal(debt(state).monthBudget, 100000);
  save(state, { month: '2026-11', balance: 30000, monthlyPayment: 100000 });
  assert.equal(view(state, 'daniel', '2026-11').totals.pending, 30000);
  pay(state, { amount: 30000 });
  assert.equal(debt(state).balance, 0); assert.equal(debt(state).monthPending, 0); assert.equal(debt(state).monthBudget, 120000);
  assert.equal(view(state, 'daniel', '2026-11').totals.pending, 0);
  assert.equal(validateState(state), state);
});

test('an optional monthly target changes only the selected month and future months default to zero', () => {
  const state = initial(); save(state, { monthlyPayment: 100000 });
  assert.equal(debt(state).monthlyPayment, 100000);
  assert.equal(view(state, 'daniel', '2026-11').debts.find(row => row.id === 'hey-banco').monthlyPayment, 0);
  save(state, { month: '2026-11', monthlyPayment: 0 });
  assert.equal(debt(state).monthlyPayment, 100000); assert.equal(debt(state).monthPending, 100000);
  assert.equal(view(state, 'daniel', '2026-11').totals.pending, 0);
  assert.deepEqual(state.debts.find(row => row.id === 'hey-banco').monthlyPlans, { '2026-10': 100000, '2026-11': 0 });
  validateState(state);
});

test('payments assigned to a future month do not erase a past month plan', () => {
  const state = initial(); save(state, { balance: 100000, monthlyPayment: 100000 });
  pay(state, { month: '2026-11', amount: 100000, paidDate: '2026-10-31' });
  assert.equal(debt(state).balance, 0);
  assert.equal(view(state).totals.pending, 100000); assert.equal(view(state).totals.paid, 0);
  assert.equal(view(state, 'daniel', '2026-11').totals.paid, 100000);
});

test('correcting and cancelling an abono restores the exact balance, with no duplicated ledger entries', () => {
  const state = initial(); save(state, { balance: 20000 }); pay(state, { amount: 12000 });
  const paymentId = debt(state).payments[0].id;
  pay(state, { paymentId, amount: 18000, paidDate: '2026-10-14' });
  assert.equal(debt(state).balance, 2000); assert.equal(debt(state).payments.length, 1);
  assert.equal(debt(state).payments[0].id, paymentId); assert.equal(debt(state).payments[0].paidDate, '2026-10-14');
  assert.throws(() => pay(state, { paymentId, amount: 20001 }), /superar el saldo/);
  act(state, { type: 'delete-debt-payment', id: 'hey-banco', paymentId });
  assert.equal(debt(state).balance, 20000); assert.equal(debt(state).payments.length, 0); assert.equal(view(state).totals.paid, 0);
  validateState(state);
});

test('editing the current balance keeps historical abonos instead of deducting them twice', () => {
  const state = initial(); pay(state, { amount: 12345 });
  save(state, { name: 'Hey actualizado', balance: 5000000 });
  assert.equal(debt(state).balance, 5000000); assert.equal(debt(state).totalPaid, 12345);
  assert.equal(state.debts.find(row => row.id === 'hey-banco').openingBalance, 5012345);
  assert.equal(debt(state).payments[0].name, 'Hey banco'); assert.equal(debt(state).name, 'Hey actualizado');
  validateState(state);
});

test('archive keeps paid expenses and allows corrections, but blocks new abonos', () => {
  const state = initial(); save(state, { balance: 50000, monthlyPayment: 20000 }); pay(state, { amount: 10000 });
  const paymentId = debt(state).payments[0].id;
  act(state, { type: 'delete-debt', id: 'hey-banco' });
  assert.equal(debt(state).active, false); assert.equal(debt(state).balance, 40000);
  assert.equal(debt(state).monthPending, 0); assert.equal(view(state).totals.budget, 10000);
  assert.throws(() => pay(state, { amount: 1 }), /activa/);
  pay(state, { paymentId, amount: 15000 });
  assert.equal(debt(state).balance, 35000); assert.equal(view(state).totals.paid, 15000);
  act(state, { type: 'delete-debt-payment', id: 'hey-banco', paymentId });
  assert.equal(debt(state).balance, 50000); assert.equal(view(state).totals.budget, 0);
  save(state, { balance: 50000, monthlyPayment: 20000 });
  assert.equal(debt(state).active, true); assert.equal(debt(state).monthPending, 20000);
  validateState(state);
});

test('owner transfer retains historical owner/name and does not duplicate the monthly target', () => {
  const state = initial(); save(state, { balance: 100000, monthlyPayment: 20000 }); pay(state, { amount: 5000 });
  const paymentId = debt(state).payments[0].id;
  save(state, { owner: 'sofia', name: 'Tarjeta compartida', balance: 95000, monthlyPayment: 20000 });
  assert.equal(view(state).totals.paid, 5000); assert.equal(debt(state).owned, false);
  assert.equal(view(state).totals.pending, 0); assert.equal(view(state, 'sofia').totals.pending, 15000);
  assert.equal(debt(state, 'hey-banco', 'sofia').payments.length, 1);
  assert.equal(debt(state, 'hey-banco', 'sofia').payments[0].owner, 'daniel');
  assert.equal(debt(state, 'hey-banco', 'daniel', '2026-11').payments[0].month, '2026-10');
  assert.equal(view(state, 'daniel', '2026-11').totals.paid, 0);
  pay(state, { paymentId, amount: 6000 });
  assert.equal(debt(state).payments[0].owner, 'daniel'); assert.equal(debt(state).payments[0].name, 'Hey banco');
  assert.equal(view(state, 'sofia').totals.pending, 14000);
  assert.throws(() => pay(state, { amount: 1 }), /esta persona/);
  validateState(state);
});

test('household debts adjust contribution targets while closed aportaciones remain intact', () => {
  const state = initial(), month = '2026-10';
  act(state, { type: 'close-payday', id: 'sofia:2026-10-04', paid: 100000 });
  const before = structuredClone(state.cycles[month].paydays['sofia:2026-10-04']);
  act(state, { type: 'save-debt', owner: 'hogar', name: 'Refrigerador', balance: 1200000, monthlyPayment: 100000, dueDay: 15 });
  const id = view(state, 'hogar').debts[0].id;
  assert.equal(cycleView(state, month).totals.total, 1880000);
  act(state, { type: 'record-debt-payment', owner: 'hogar', id, amount: 150000, paidDate: '2026-10-15' });
  const cycle = cycleView(state, month);
  assert.equal(cycle.totals.total, 1930000); assert.equal(cycle.debts.totals.paid, 150000);
  assert.deepEqual(state.cycles[month].paydays['sofia:2026-10-04'], before);
  assert.equal(cycle.totals.saved, 100000);
  assert.equal(cycle.paydays.filter(row => !row.closed).reduce((sum, row) => sum + row.suggested, 0), cycle.totals.pending);
  validateState(state);
});

test('oversized household monthly plans show shortage without changing debt balances', () => {
  const state = initial(); act(state, { type: 'save-debt', owner: 'hogar', name: 'Compra', balance: 10000000, monthlyPayment: 10000000, dueDay: 1 });
  const cycle = cycleView(state, '2026-10');
  assert.equal(cycle.totals.total, 11780000); assert.equal(cycle.totals.shortage, 11780000 - cycle.totals.capacity);
  assert.equal(cycle.debts.totals.balance, 10000000); assert.equal(cycle.debts.payments.length, 0);
});

test('due dates clamp February/year transitions and only planned pending payments are overdue', () => {
  const state = createState('2027-01-02');
  const change = fields => act(state, { month: '2027-01', type: 'save-debt', id: 'hey-banco', name: 'Hey banco', balance: 7000000, dueDay: 31, monthlyPayment: 10000, ...fields }, '2027-01-02');
  change({});
  change({ month: '2027-02' });
  assert.equal(view(state, 'daniel', '2027-02', '2027-02-27').debts.find(row => row.id === 'hey-banco').dueDate, '2027-02-28');
  assert.equal(view(state, 'daniel', '2027-02', '2027-03-01').debts.find(row => row.id === 'hey-banco').overdue, true);
  assert.equal(view(state, 'daniel', '2028-02', '2028-02-29').debts.find(row => row.id === 'hey-banco').dueDate, '2028-02-29');
  assert.equal(view(state, 'daniel', '2027-12', '2027-12-31').debts.find(row => row.id === 'hey-banco').dueDate, '2027-12-31');
  change({ dueDay: null });
  assert.equal(view(state, 'daniel', '2027-01', '2027-02-01').debts.find(row => row.id === 'hey-banco').overdue, false);
  change({ monthlyPayment: 0 });
  assert.equal(view(state, 'daniel', '2027-01', '2027-02-01').debts.find(row => row.id === 'hey-banco').monthPending, 0);
});

test('new debts only start planning from their selected month, including no-date debts', () => {
  const state = initial(); act(state, { type: 'save-debt', owner: 'sofia', month: '2026-11', name: 'Tarjeta', balance: 50000, monthlyPayment: 10000, dueDay: null });
  const id = view(state, 'sofia', '2026-11').debts[0].id;
  assert.equal(view(state, 'sofia').totals.budget, 0); assert.equal(view(state, 'sofia').totals.balance, 50000);
  assert.equal(view(state, 'sofia', '2026-11').totals.pending, 10000);
  assert.throws(() => pay(state, { owner: 'sofia', id, amount: 1 }), /aún no estaba/);
});

test('actions reject malformed, negative, zero, fractional, unavailable and over-balance amounts', () => {
  const invalidSaves = [
    { owner: '__proto__' }, { name: '' }, { balance: -1 }, { balance: 1.5 }, { balance: MAX_MONEY + 1 },
    { dueDay: 0 }, { dueDay: 32 }, { dueDay: '13' }, { monthlyPayment: -1 }, { monthlyPayment: 1.1 },
    { month: '2026-09' }, { month: '2026-12' }, { id: 'missing' }, { id: 0 }, { id: null }
  ];
  for (const fields of invalidSaves) assert.throws(() => save(initial(), fields));
  for (const fields of [{ amount: 0 }, { amount: -1 }, { amount: 1.5 }, { amount: 7000001 }, { paidDate: '2026-02-30' }, { paymentId: 'missing' }, { paymentId: 0 }]) assert.throws(() => pay(initial(), fields));
  const state = initial(); pay(state);
  const paymentId = debt(state).payments[0].id;
  assert.throws(() => pay(state, { owner: 'sofia', paymentId }), /otra persona/);
  assert.throws(() => pay(state, { month: '2026-11', paymentId }), /otra persona o mes/);
  assert.throws(() => act(state, { type: 'delete-debt-payment', id: 'hey-banco' }), /Elige el abono/);
});

test('state validation rejects damaged debt/ledger data and preserves schema compatibility', () => {
  const state = initial(); pay(state);
  const invalidChanges = [
    draft => { draft.debts = {}; }, draft => { draft.debts.push(structuredClone(draft.debts[0])); },
    draft => { draft.debts[0].owner = 'alguien'; }, draft => { draft.debts[0].active = 'sí'; },
    draft => { draft.debts[0].dueDay = 40; }, draft => { draft.debts[0].openingBalance = 1; },
    draft => { draft.debts[0].monthlyPlans = []; }, draft => { draft.debts[0].monthlyPlans['2026-10'] = -1; },
    draft => { draft.debts[0].payments[0].amount = 0; }, draft => { draft.debts[0].payments[0].month = '2026-09'; },
    draft => { draft.debts[0].payments.push(structuredClone(draft.debts[0].payments[0])); },
    draft => { draft.debts[0].payments[0].paidDate = '2026-02-31'; }
  ];
  for (const change of invalidChanges) { const copy = structuredClone(state); change(copy); assert.throws(() => validateState(copy)); }
  assert.equal(state.schemaVersion, 1); assert.equal(validateState(state), state);
});
