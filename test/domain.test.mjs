import test from 'node:test';
import assert from 'node:assert/strict';
import { allocate, applyAction, availableMonths, createState, cycleView, expensesFor, paydays, today, upcomingMonth, validateState } from '../lib/domain.mjs';

const initial = () => createState('2026-10-05');
const act = (state, action) => applyAction(state, { month: '2026-10', ...action }, action.month > '2026-11' ? `${action.month}-01` : '2026-10-05');

test('Hermosillo and the next deadline use calendar dates, not host timezone', () => {
  assert.equal(today(new Date('2026-10-06T02:00:00Z')), '2026-10-05');
  assert.equal(upcomingMonth('2026-10-15'), '2026-10');
  assert.equal(upcomingMonth('2026-10-16'), '2026-11');
  assert.equal(upcomingMonth('2026-12-31'), '2027-01');
});
test('initial cycle follows user amounts, chronological Sundays and cross-month paydays', () => {
  const cycle = cycleView(initial(), '2026-10', '2026-10-05');
  assert.equal(cycle.start, '2026-09-16'); assert.equal(cycle.deadline, '2026-10-15');
  assert.equal(cycle.totals.total, 1780000); assert.equal(cycle.totals.capacity, 5472500);
  assert.deepEqual(cycle.paydays.filter(p => p.person === 'sofia').map(p => [p.date, p.income]), [['2026-09-20', 100000], ['2026-09-27', 100000], ['2026-10-04', 250000], ['2026-10-11', 222500]]);
  assert.deepEqual(cycle.paydays.filter(p => p.person === 'daniel').map(p => p.date), ['2026-09-30', '2026-10-15']);
  assert.equal(cycle.paydays.reduce((sum, p) => sum + p.suggested, 0), 1780000);
  assert.equal(cycle.paydays.filter(p => p.closed).length, 0);
  assert.equal(cycle.paydays.filter(p => p.overdue).length, 4);
});
test('five Sundays are all included and future estimates reset to the base', () => {
  const rows = paydays(initial(), '2026-11');
  assert.deepEqual(rows.filter(p => p.person === 'sofia').map(p => p.date), ['2026-10-18', '2026-10-25', '2026-11-01', '2026-11-08', '2026-11-15']);
  assert.ok(rows.filter(p => p.person === 'sofia').every(p => p.income === 100000));
});
test('February uses the 28th or 29th, December uses the 30th and a shared 15th has two cobros', () => {
  const state = initial();
  assert.deepEqual(paydays(state, '2027-03').filter(p => p.person === 'daniel').map(p => p.date), ['2027-02-28', '2027-03-15']);
  assert.deepEqual(paydays(state, '2028-03').filter(p => p.person === 'daniel').map(p => p.date), ['2028-02-29', '2028-03-15']);
  assert.deepEqual(paydays(state, '2027-01').filter(p => p.person === 'daniel').map(p => p.date), ['2026-12-30', '2027-01-15']);
  assert.equal(paydays(state, '2026-11').filter(p => p.date === '2026-11-15').length, 2);
});
test('largest remainder allocation is exact, stable and safe with large multiplication', () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [1, 1, 1]);
  assert.deepEqual(allocate(100, [100, 100, 100]), [34, 33, 33]);
  assert.deepEqual(allocate(1, [0, 100, 100]), [0, 1, 0]);
  assert.deepEqual(allocate(0, [100, 100]), [0, 0]);
  assert.deepEqual(allocate(100, [0, 0]), [0, 0]);
  assert.deepEqual(allocate(10000000000, [10000000000, 10000000000]), [5000000000, 5000000000]);
  for (let i = 0; i < 500; i++) {
    const weights = [i * 41, 7500 - i * 7, i % 3 ? i * 120 : 0, 11000];
    const total = i * 93;
    const result = allocate(total, weights);
    assert.equal(result.reduce((a, b) => a + b, 0), Math.min(total, weights.reduce((a, b) => a + b, 0)));
    assert.ok(result.every((v, index) => Number.isSafeInteger(v) && v >= 0 && v <= weights[index]));
  }
});
test('closing keeps the recorded amount and the original suggestion despite later expense changes', () => {
  const state = initial(), id = 'sofia:2026-09-20';
  const suggestion = cycleView(state, '2026-10').paydays.find(p => p.id === id).suggested;
  act(state, { type: 'close-payday', id, paid: 25000 });
  const snapshot = structuredClone(state.cycles['2026-10'].paydays[id]);
  act(state, { type: 'save-expense', id: 'luz', name: 'Luz', amount: 200000, scope: 'cycle' });
  const cycle = cycleView(state, '2026-10');
  assert.deepEqual(state.cycles['2026-10'].paydays[id], snapshot);
  assert.equal(cycle.paydays.find(p => p.id === id).suggested, suggestion);
  assert.equal(cycle.totals.saved, 25000);
  assert.equal(cycle.paydays.filter(p => !p.closed).reduce((sum, p) => sum + p.suggested, 0), 1855000);
  assert.throws(() => act(state, { type: 'update-payday', id, income: 100000, available: 0 }), /cerrada/);
  assert.throws(() => act(state, { type: 'close-payday', id, paid: 0 }), /cerrada/);
});
test('closing with zero redistributes, and time alone does not close paydays', () => {
  const state = initial(), id = 'daniel:2026-09-30';
  assert.equal(cycleView(state, '2026-10', '2027-01-01').paydays.filter(p => p.closed).length, 0);
  act(state, { type: 'close-payday', id, paid: 0 });
  const cycle = cycleView(state, '2026-10');
  assert.equal(cycle.totals.saved, 0);
  assert.equal(cycle.totals.capacity, 3072500);
  assert.equal(cycle.paydays.filter(p => !p.closed).reduce((sum, p) => sum + p.suggested, 0), 1780000);
});
test('less availability changes weights, zero capacity shows shortage, overpayment shows surplus', () => {
  const state = initial();
  for (const p of paydays(state, '2026-10')) act(state, { type: 'update-payday', id: p.id, income: p.income, available: 0 });
  let cycle = cycleView(state, '2026-10');
  assert.equal(cycle.totals.shortage, 1780000); assert.ok(cycle.paydays.every(p => p.suggested === 0));
  act(state, { type: 'update-payday', id: 'daniel:2026-10-15', income: 2400000, available: 50000 });
  cycle = cycleView(state, '2026-10');
  assert.equal(cycle.totals.shortage, 1730000); assert.equal(cycle.paydays.at(-1).suggested, 50000);
  act(state, { type: 'close-payday', id: 'daniel:2026-10-15', paid: 2000000 });
  cycle = cycleView(state, '2026-10');
  assert.equal(cycle.totals.surplus, 220000); assert.equal(cycle.totals.pending, 0); assert.ok(cycle.paydays.filter(p => !p.closed).every(p => p.suggested === 0));
  assert.equal(cycleView(state, '2026-11').totals.saved, 0);
});
test('temporary and permanent edits honor their effective cycle and preserve later overrides and closures', () => {
  const state = initial();
  act(state, { type: 'save-expense', id: 'luz', name: 'Luz', amount: 300000, scope: 'cycle', month: '2026-11' });
  act(state, { type: 'close-payday', id: 'sofia:2026-11-01', paid: 12345, month: '2026-11' });
  const closed = structuredClone(state.cycles['2026-11'].paydays);
  act(state, { type: 'save-expense', id: 'luz', name: 'Electricidad', amount: 150000, scope: 'future' });
  assert.equal(expensesFor(state, '2026-09').find(e => e.id === 'luz').amount, 100000);
  assert.equal(expensesFor(state, '2026-10').find(e => e.id === 'luz').amount, 150000);
  assert.equal(expensesFor(state, '2026-11').find(e => e.id === 'luz').amount, 300000);
  assert.equal(expensesFor(state, '2026-12').find(e => e.id === 'luz').name, 'Electricidad');
  assert.deepEqual(state.cycles['2026-11'].paydays, closed);
  act(state, { type: 'save-expense', id: 'luz', name: 'Luz', amount: 90000, scope: 'future', month: '2027-01' });
  assert.equal(expensesFor(state, '2026-12').find(e => e.id === 'luz').amount, 150000);
  assert.equal(expensesFor(state, '2027-01').find(e => e.id === 'luz').amount, 90000);
});
test('add and remove expenses temporarily or permanently without changing earlier cycles', () => {
  const state = initial();
  act(state, { type: 'save-expense', name: 'Gas', amount: 10000, scope: 'cycle' });
  assert.equal(expensesFor(state, '2026-10').length, 7);
  assert.equal(expensesFor(state, '2026-11').length, 6);
  act(state, { type: 'delete-expense', id: 'internet', scope: 'cycle' });
  assert.ok(!expensesFor(state, '2026-10').some(e => e.id === 'internet'));
  assert.ok(expensesFor(state, '2026-11').some(e => e.id === 'internet'));
  act(state, { type: 'delete-expense', id: 'agua', scope: 'future' });
  assert.ok(expensesFor(state, '2026-09').some(e => e.id === 'agua'));
  assert.ok(!expensesFor(state, '2026-11').some(e => e.id === 'agua'));
  assert.doesNotThrow(() => validateState(state));
});
test('invalid input, fractional cents and missing scope are rejected', () => {
  assert.throws(() => act(initial(), { type: 'save-expense', id: 'luz', name: 'Luz', amount: -1, scope: 'cycle' }), /importe/);
  assert.throws(() => act(initial(), { type: 'save-expense', id: 'luz', name: 'Luz', amount: 1.2, scope: 'cycle' }), /importe/);
  assert.throws(() => act(initial(), { type: 'save-expense', id: 'luz', name: 'Luz', amount: 0 }), /Elige/);
  assert.throws(() => act(initial(), { type: 'update-payday', id: 'sofia:2026-09-20', income: 99900, available: 0 }), /al menos/);
  assert.throws(() => act(initial(), { type: 'update-payday', id: 'daniel:2026-10-15', income: 2400000, available: 2400001 }), /superar/);
  assert.throws(() => act(initial(), { type: 'update-payday', id: 'daniel:2026-10-15', income: 2300000, available: 0 }), /fijo/);
  assert.throws(() => cycleView(initial(), '../data'), /mes válido/);
  assert.throws(() => validateState({ ...initial(), schemaVersion: 999 }), /formato/);
});
test('available deadlines start at the first rental month and expand one calendar month at a time', () => {
  const state = initial();
  assert.deepEqual(availableMonths(state, '2026-10-05'), ['2026-10', '2026-11']);
  assert.deepEqual(availableMonths(state, '2026-10-30'), ['2026-10', '2026-11']);
  assert.deepEqual(availableMonths(state, '2026-11-01'), ['2026-10', '2026-11', '2026-12']);
  assert.deepEqual(availableMonths(state, '2026-12-01'), ['2026-10', '2026-11', '2026-12', '2027-01']);
  assert.throws(() => act(state, { type: 'close-payday', month: '2026-09', id: 'sofia:2026-09-06', paid: 0 }), /disponible/);
  assert.throws(() => applyAction(state, { type: 'close-payday', month: '2026-12', id: 'sofia:2026-12-06', paid: 0 }, '2026-10-05'), /disponible/);
});
test('reopening removes the old contribution, remembers it and recalculates without changing other closed paydays', () => {
  const state = initial();
  act(state, { type: 'close-payday', id: 'sofia:2026-09-20', paid: 50000 });
  act(state, { type: 'close-payday', id: 'daniel:2026-09-30', paid: 400000 });
  const daniel = structuredClone(state.cycles['2026-10'].paydays['daniel:2026-09-30']);
  act(state, { type: 'reopen-payday', id: 'sofia:2026-09-20' });
  let cycle = cycleView(state, '2026-10');
  assert.equal(cycle.totals.saved, 400000);
  assert.equal(cycle.paydays.find(p => p.id === 'sofia:2026-09-20').previousPaid, 50000);
  assert.deepEqual(state.cycles['2026-10'].paydays['daniel:2026-09-30'], daniel);
  act(state, { type: 'close-payday', id: 'sofia:2026-09-20', paid: 25000 });
  cycle = cycleView(state, '2026-10'); assert.equal(cycle.totals.saved, 425000);
  assert.equal(cycle.paydays.find(p => p.id === 'sofia:2026-09-20').previousPaid, undefined);
  assert.throws(() => act(state, { type: 'reopen-payday', id: 'sofia:2026-09-27' }), /ya está abierta/);
});
test('payment dates recur with month-end clamping and temporary dates do not change the future', () => {
  const state = initial();
  assert.equal(expensesFor(state, '2026-10').find(e => e.id === 'renta').dueDate, '2026-10-15');
  act(state, { type: 'save-expense', id: 'luz', name: 'Luz', amount: 100000, dueDate: '2026-10-31', scope: 'future' });
  assert.equal(expensesFor(state, '2027-02').find(e => e.id === 'luz').dueDate, '2027-02-28');
  assert.equal(expensesFor(state, '2028-02').find(e => e.id === 'luz').dueDate, '2028-02-29');
  act(state, { type: 'save-expense', id: 'luz', name: 'Luz', amount: 100000, dueDate: '2026-10-07', scope: 'cycle' });
  assert.equal(expensesFor(state, '2026-10').find(e => e.id === 'luz').dueDate, '2026-10-07');
  assert.equal(expensesFor(state, '2026-11').find(e => e.id === 'luz').dueDate, '2026-11-30');
  act(state, { type: 'save-expense', id: 'renta', name: 'Renta', amount: 1100000, dueDate: null, scope: 'future' });
  assert.equal(expensesFor(state, '2026-11').find(e => e.id === 'renta').dueDate, null);
  assert.throws(() => act(state, { type: 'save-expense', id: 'luz', name: 'Luz', amount: 100000, dueDate: '2026-02-30', scope: 'cycle' }), /fecha válida/);
});
test('real expense payments replace only this cycle budget and preserve closed contributions', () => {
  const state = initial();
  act(state, { type: 'close-payday', id: 'sofia:2026-09-20', paid: 25000 });
  const closed = structuredClone(state.cycles['2026-10'].paydays['sofia:2026-09-20']);
  act(state, { type: 'record-expense-payment', id: 'luz', amount: 150000, paidDate: '2026-10-05' });
  act(state, { type: 'record-expense-payment', id: 'agua', amount: 20000, paidDate: '2026-10-04' });
  let cycle = cycleView(state, '2026-10');
  assert.equal(cycle.totals.total, 1800000); assert.equal(cycle.totals.pending, 1775000);
  assert.equal(cycle.expenses.find(e => e.id === 'luz').plannedAmount, 100000);
  assert.equal(cycle.expenses.find(e => e.id === 'luz').payment.amount, 150000);
  assert.equal(cycleView(state, '2026-11').totals.total, 1780000);
  assert.deepEqual(state.cycles['2026-10'].paydays['sofia:2026-09-20'], closed);
  act(state, { type: 'record-expense-payment', id: 'luz', amount: 140000, paidDate: '2026-10-05' });
  assert.equal(cycleView(state, '2026-10').totals.total, 1790000);
  act(state, { type: 'clear-expense-payment', id: 'luz' });
  assert.equal(cycleView(state, '2026-10').totals.total, 1750000);
  assert.doesNotThrow(() => validateState(state));
});
