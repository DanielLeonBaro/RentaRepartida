import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createState, cycleView, validateState } from '../lib/domain.mjs';
import { personalView } from '../lib/personal.mjs';

const initial = () => createState('2026-10-05');
const act = (state, action, date = '2026-10-05') => applyAction(state, { person: 'daniel', month: '2026-10', ...action }, date);
const view = (state, person = 'daniel', month = '2026-10', date = '2026-10-05') => personalView(state, person, month, date);
const save = (state, fields) => act(state, { type: 'save-personal-expense', id: 'carro', name: 'Carro', amount: 1000000, schedule: 'quincenal', scope: 'cycle', ...fields });

test('personal defaults are virtual, use full salaries and do not duplicate rent', () => {
  const state = initial(), before = structuredClone(state), daniel = view(state), sofia = view(state, 'sofia');
  assert.deepEqual(state, before);
  assert.equal(daniel.name, 'Daniel'); assert.equal(sofia.name, 'Sofía');
  assert.equal(daniel.start, '2026-10-01'); assert.equal(daniel.end, '2026-10-31');
  assert.deepEqual(daniel.incomePaydays.map(p => [p.date, p.income, p.cycleMonth]), [['2026-10-15', 2400000, '2026-10'], ['2026-10-30', 2400000, '2026-11']]);
  assert.equal(daniel.totals.income, 4800000); assert.equal(daniel.totals.expenses, 2070000);
  assert.equal(sofia.totals.income, 672500); assert.equal(sofia.totals.expenses, 329300);
  assert.ok(!daniel.expenses.some(e => e.name === 'Renta'));
  assert.ok(!sofia.expenses.some(e => e.name === 'Renta'));
  assert.equal(daniel.totals.remaining, daniel.totals.income - daniel.totals.expenses - daniel.household.total);
  assert.equal(daniel.totals.paid, 0); assert.equal(sofia.totals.paid, 0);
  assert.ok(sofia.payments.every(p => p.dueDate === null && !p.overdue && p.paidDate === null && p.paidAt === null));
  assert.equal(validateState(state), state);
});

test('linked household amounts follow both cycles, zero closures and reopening exactly', () => {
  const state = initial();
  let daniel = view(state);
  assert.equal(daniel.household.total, cycleView(state, '2026-10').paydays.find(p => p.id === 'daniel:2026-10-15').suggested + cycleView(state, '2026-11').paydays.find(p => p.id === 'daniel:2026-10-30').suggested);
  act(state, { type: 'close-payday', id: 'daniel:2026-10-15', paid: 0 });
  act(state, { type: 'close-payday', month: '2026-11', id: 'daniel:2026-10-30', paid: 555555 });
  daniel = view(state);
  assert.equal(daniel.household.saved, 555555); assert.equal(daniel.household.pending, 0);
  assert.deepEqual(daniel.household.contributions.map(p => [p.amount, p.closed]), [[0, true], [555555, true]]);
  act(state, { type: 'reopen-payday', id: 'daniel:2026-10-15' });
  daniel = view(state);
  assert.equal(daniel.household.saved, 555555);
  assert.ok(daniel.household.pending > 0);
});

test('personal edits isolate people, shared expenses, temporary months and future versions', () => {
  const state = initial(), shared = structuredClone(state.expenses), sofiaBefore = view(state, 'sofia');
  save(state, { amount: 1200000 });
  assert.equal(view(state).expenses.find(e => e.id === 'carro').plannedAmount, 1200000);
  assert.equal(view(state, 'daniel', '2026-11').expenses.find(e => e.id === 'carro').plannedAmount, 1000000);
  assert.deepEqual(view(state, 'sofia'), sofiaBefore);
  assert.deepEqual(state.expenses, shared);
  save(state, { amount: 1100000, scope: 'future' });
  assert.equal(view(state, 'daniel', '2026-09').expenses.find(e => e.id === 'carro').plannedAmount, 1000000);
  assert.equal(view(state, 'daniel', '2026-11').expenses.find(e => e.id === 'carro').plannedAmount, 1100000);
  save(state, { amount: 900000, month: '2026-11', scope: 'cycle' });
  save(state, { amount: 1300000, scope: 'future' });
  assert.equal(view(state, 'daniel', '2026-11').expenses.find(e => e.id === 'carro').plannedAmount, 900000);
  assert.equal(view(state, 'daniel', '2026-12').expenses.find(e => e.id === 'carro').plannedAmount, 1300000);
  assert.doesNotThrow(() => validateState(state));
});

test('weekly amounts split exact cents across all five Sundays and quincenas clamp February', () => {
  const state = initial();
  act(state, { type: 'save-personal-expense', id: 'dnd', name: 'D&D', amount: 100003, schedule: 'weekly', weekday: 0, scope: 'cycle', month: '2026-11' });
  const payments = view(state, 'daniel', '2026-11').payments.filter(p => p.expenseId === 'dnd');
  assert.deepEqual(payments.map(p => p.dueDate), ['2026-11-01', '2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29']);
  assert.deepEqual(payments.map(p => p.amount), [20001, 20001, 20001, 20000, 20000]);
  for (const [month, last] of [['2027-02', '28'], ['2028-02', '29']]) {
    const february = view(state, 'daniel', month);
    assert.equal(february.end, `${month}-${last}`);
    assert.deepEqual(february.payments.filter(p => p.expenseId === 'carro').map(p => p.dueDate), [`${month}-15`, `${month}-${last}`]);
    assert.deepEqual(february.incomePaydays.map(p => p.date), [`${month}-15`, `${month}-${last}`]);
  }
  assert.deepEqual(view(state, 'daniel', '2026-12').incomePaydays.map(p => p.cycleMonth), ['2026-12', '2027-01']);
});

test('day 31 recurs on the last actual day and weekly scheduling allows other weekdays', () => {
  const state = initial();
  act(state, { type: 'save-personal-expense', id: 'gpt', name: 'GPT', amount: 50000, schedule: 'monthly', day: 31, scope: 'future' });
  assert.equal(view(state, 'daniel', '2027-02').payments.find(p => p.expenseId === 'gpt').dueDate, '2027-02-28');
  act(state, { type: 'save-personal-expense', id: 'dnd', name: 'D&D', amount: 100001, schedule: 'weekly', weekday: 1, scope: 'cycle' });
  const rows = view(state).payments.filter(p => p.expenseId === 'dnd');
  assert.deepEqual(rows.map(p => p.dueDate), ['2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']);
  assert.equal(rows.reduce((sum, p) => sum + p.amount, 0), 100001);
});

test('a real payment changes only this month total and redistributes remaining planned cents', () => {
  const state = initial();
  act(state, { type: 'record-personal-payment', id: 'dnd:0', amount: 30000, paidDate: '2026-10-04' });
  const closed = structuredClone(state.personal.daniel.months['2026-10'].payments['dnd:0']);
  let expense = view(state).expenses.find(e => e.id === 'dnd');
  assert.deepEqual([expense.plannedAmount, expense.amount, expense.paidAmount, expense.pendingAmount], [100000, 105000, 30000, 75000]);
  act(state, { type: 'save-personal-expense', id: 'dnd', name: 'D&D actualizado', amount: 140000, schedule: 'weekly', scope: 'cycle' });
  const rows = view(state).payments.filter(p => p.expenseId === 'dnd');
  assert.deepEqual(rows.filter(p => !p.paid).map(p => p.amount), [38334, 38333, 38333]);
  assert.deepEqual(state.personal.daniel.months['2026-10'].payments['dnd:0'], closed);
  assert.equal(rows[0].name, 'D&D'); assert.equal(rows[0].dueDate, '2026-10-04');
  expense = view(state).expenses.find(e => e.id === 'dnd');
  assert.equal(expense.amount, 145000); assert.equal(expense.pendingAmount, 115000);
  assert.equal(view(state, 'daniel', '2026-11').expenses.find(e => e.id === 'dnd').amount, 100000);
  assert.equal(view(state).totals.paid, 30000);
  assert.doesNotThrow(() => validateState(state));
});

test('zero payments close and stay fixed, reopening restores pending and paid totals', () => {
  const state = initial();
  act(state, { type: 'record-personal-payment', id: 'carro:0', amount: 0, paidDate: '2026-10-05' });
  let rows = view(state).payments.filter(p => p.expenseId === 'carro');
  assert.equal(rows[0].paid, true); assert.equal(rows[0].amount, 0); assert.equal(rows[1].amount, 500000);
  assert.equal(view(state).expenses.find(e => e.id === 'carro').amount, 500000);
  assert.throws(() => act(state, { type: 'record-personal-payment', id: 'carro:0', amount: 2, paidDate: '2026-10-05' }), /cerrado/);
  act(state, { type: 'reopen-personal-payment', id: 'carro:0' });
  rows = view(state).payments.filter(p => p.expenseId === 'carro');
  assert.ok(rows.every(p => !p.paid)); assert.equal(view(state).expenses.find(e => e.id === 'carro').amount, 1000000);
  assert.throws(() => act(state, { type: 'reopen-personal-payment', id: 'carro:0' }), /pendiente/);
});

test('calendar changes preserve recorded installment identity, date and name', () => {
  const state = initial();
  act(state, { type: 'record-personal-payment', id: 'dnd:3', amount: 35000, paidDate: '2026-10-25' });
  const snapshot = structuredClone(state.personal.daniel.months['2026-10'].payments['dnd:3']);
  act(state, { type: 'save-personal-expense', id: 'dnd', name: 'Juego', amount: 100000, schedule: 'monthly', day: 20, scope: 'cycle' });
  const rows = view(state).payments.filter(p => p.expenseId === 'dnd');
  assert.equal(rows.length, 2);
  assert.equal(rows.find(p => p.id === 'dnd:0').amount, 75000);
  assert.equal(rows.find(p => p.id === 'dnd:0').dueDate, '2026-10-20');
  assert.equal(rows.find(p => p.id === 'dnd:3').dueDate, '2026-10-25');
  assert.equal(rows.find(p => p.id === 'dnd:3').name, 'D&D');
  assert.deepEqual(state.personal.daniel.months['2026-10'].payments['dnd:3'], snapshot);
  assert.equal(new Set(rows.map(p => p.id)).size, rows.length);
});

test('lowering a budget past closed planned portions keeps history with zero pending amounts', () => {
  const state = initial();
  act(state, { type: 'record-personal-payment', id: 'carro:0', amount: 550000, paidDate: '2026-10-15' });
  save(state, { amount: 100000 });
  const expense = view(state).expenses.find(e => e.id === 'carro');
  assert.equal(expense.paidAmount, 550000); assert.equal(expense.pendingAmount, 0); assert.equal(expense.amount, 550000);
  assert.equal(view(state).payments.find(p => p.id === 'carro:1').amount, 0);
});

test('deleting expenses removes pending quotas but keeps paid amounts in the month ledger', () => {
  const state = initial();
  act(state, { type: 'record-personal-payment', id: 'carro:0', amount: 550000, paidDate: '2026-10-15' });
  act(state, { type: 'delete-personal-expense', id: 'carro', scope: 'cycle' });
  const current = view(state);
  assert.ok(!current.expenses.some(e => e.id === 'carro'));
  assert.deepEqual(current.payments.filter(p => p.expenseId === 'carro').map(p => [p.id, p.amount, p.paid]), [['carro:0', 550000, true]]);
  assert.equal(current.totals.paid, 550000); assert.equal(current.totals.expenses, 1620000);
  assert.ok(view(state, 'daniel', '2026-11').expenses.some(e => e.id === 'carro'));
  assert.doesNotThrow(() => validateState(state));
});

test('a payment for a removed expense can reopen and be corrected without restoring other quotas', () => {
  const state = initial();
  act(state, { type: 'record-personal-payment', id: 'carro:0', amount: 550000, paidDate: '2026-10-15' });
  act(state, { type: 'delete-personal-expense', id: 'carro', scope: 'cycle' });
  act(state, { type: 'reopen-personal-payment', id: 'carro:0' });
  let current = view(state), rows = current.payments.filter(p => p.expenseId === 'carro');
  assert.ok(!current.expenses.some(e => e.id === 'carro'));
  assert.deepEqual(rows.map(p => [p.id, p.name, p.amount, p.dueDate, p.paid]), [['carro:0', 'Carro', 500000, '2026-10-15', false]]);
  assert.equal(current.totals.paid, 0); assert.equal(current.totals.expenses, 1570000);
  assert.equal(rows[0].paidDate, null); assert.equal(rows[0].paidAt, null);
  assert.doesNotThrow(() => validateState(JSON.parse(JSON.stringify(state))));
  act(state, { type: 'record-personal-payment', id: 'carro:0', amount: 525000, paidDate: '2026-10-16' });
  current = view(state); rows = current.payments.filter(p => p.expenseId === 'carro');
  assert.deepEqual(rows.map(p => [p.id, p.amount, p.paid]), [['carro:0', 525000, true]]);
  assert.equal(current.totals.paid, 525000); assert.equal(current.totals.expenses, 1595000);
  assert.deepEqual(state.personal.daniel.months['2026-10'].reopenedPayments, {});
  assert.doesNotThrow(() => validateState(state));
});

test('a removed weekly slot stays editable after reopening and reserves its share without duplicating', () => {
  const state = initial(), month = '2026-11';
  act(state, { type: 'record-personal-payment', month, id: 'dnd:4', amount: 25000, paidDate: '2026-11-29' });
  act(state, { type: 'save-personal-expense', month, id: 'dnd', name: 'Juego', amount: 100000, schedule: 'monthly', day: 20, scope: 'cycle' });
  act(state, { type: 'reopen-personal-payment', month, id: 'dnd:4' });
  let current = view(state, 'daniel', month), rows = current.payments.filter(p => p.expenseId === 'dnd');
  assert.deepEqual(rows.map(p => [p.id, p.amount, p.paid]), [['dnd:0', 80000, false], ['dnd:4', 20000, false]]);
  assert.equal(rows[1].name, 'D&D'); assert.equal(rows[1].dueDate, '2026-11-29');
  assert.equal(current.expenses.find(e => e.id === 'dnd').amount, 100000);
  assert.doesNotThrow(() => validateState(JSON.parse(JSON.stringify(state))));
  act(state, { type: 'save-personal-expense', month, id: 'dnd', name: 'Juego', amount: 100000, schedule: 'weekly', scope: 'cycle' });
  rows = view(state, 'daniel', month).payments.filter(p => p.expenseId === 'dnd');
  assert.equal(rows.length, 5); assert.equal(new Set(rows.map(p => p.id)).size, 5);
  assert.ok(rows.every(p => p.amount === 20000));
  act(state, { type: 'save-personal-expense', month, id: 'dnd', name: 'Juego', amount: 100000, schedule: 'monthly', day: 20, scope: 'cycle' });
  const corrupt = structuredClone(state);
  corrupt.personal.daniel.months[month].reopenedPayments['dnd:4'].amount++;
  assert.throws(() => validateState(corrupt), /reabierto inválido/);
  act(state, { type: 'record-personal-payment', month, id: 'dnd:4', amount: 22000, paidDate: '2026-11-30' });
  current = view(state, 'daniel', month); rows = current.payments.filter(p => p.expenseId === 'dnd');
  assert.deepEqual(rows.map(p => [p.id, p.amount, p.paid]), [['dnd:0', 80000, false], ['dnd:4', 22000, true]]);
  assert.equal(current.expenses.find(e => e.id === 'dnd').amount, 102000);
  assert.deepEqual(state.personal.daniel.months[month].reopenedPayments, {});
  assert.doesNotThrow(() => validateState(state));
});

test('adding a temporary or future expense keeps its intended month validity', () => {
  const state = initial();
  act(state, { type: 'save-personal-expense', name: 'Dentista', amount: 350001, schedule: 'monthly', day: 9, scope: 'cycle' });
  assert.ok(view(state).expenses.some(e => e.name === 'Dentista'));
  assert.ok(!view(state, 'daniel', '2026-11').expenses.some(e => e.name === 'Dentista'));
  act(state, { type: 'save-personal-expense', person: 'sofia', name: 'Curso', amount: 100000, schedule: 'unscheduled', scope: 'future' });
  assert.ok(view(state, 'sofia', '2026-11').expenses.some(e => e.name === 'Curso'));
  assert.ok(!view(state).expenses.some(e => e.name === 'Curso'));
  assert.doesNotThrow(() => validateState(state));
});

test('unrecorded past payments stay overdue and never close just because time advances', () => {
  const state = initial(), current = view(state, 'daniel', '2026-10', '2026-11-30');
  assert.ok(current.payments.every(p => p.overdue && !p.paid));
  assert.equal(state.personal, undefined);
  act(state, { type: 'record-personal-payment', person: 'sofia', id: 'tarjeta:0', amount: 149300, paidDate: '2026-10-05' });
  const card = view(state, 'sofia').payments.find(p => p.id === 'tarjeta:0');
  assert.equal(card.dueDate, null); assert.equal(card.paid, true);
});

test('shared variable payday income edits are reflected in the individual monthly income', () => {
  const state = initial();
  const before = view(state, 'sofia').totals.income;
  act(state, { type: 'update-payday', id: 'sofia:2026-10-04', income: 350000, available: 100000 });
  act(state, { type: 'update-payday', month: '2026-11', id: 'sofia:2026-10-25', income: 200000, available: 0 });
  const sofia = view(state, 'sofia');
  assert.equal(sofia.totals.income, before + 200000);
  assert.equal(sofia.incomePaydays.find(p => p.id === 'sofia:2026-10-25').income, 200000);
  assert.equal(sofia.household.contributions.find(p => p.id === 'sofia:2026-10-25').amount, 0);
  assert.equal(view(state).totals.income, 4800000);
});

test('invalid personal input, month windows and corrupted persisted payments are rejected', () => {
  assert.throws(() => view(initial(), 'other'), /Sofía o Daniel/);
  assert.throws(() => view(initial(), 'daniel', '2026-13'), /mes válido/);
  assert.throws(() => save(initial(), { month: '2026-12' }), /disponible/);
  assert.throws(() => save(initial(), { month: '2026-09' }), /disponible/);
  assert.throws(() => save(initial(), { amount: 0.2 }), /importe/);
  assert.throws(() => save(initial(), { amount: -1 }), /importe/);
  assert.throws(() => save(initial(), { scope: undefined }), /Elige/);
  assert.throws(() => save(initial(), { schedule: 'any' }), /cuándo/);
  assert.throws(() => save(initial(), { day: 32 }), /1 y 31/);
  assert.throws(() => save(initial(), { weekday: 7 }), /semana/);
  assert.throws(() => act(initial(), { type: 'record-personal-payment', id: 'carro:0', amount: 0, paidDate: '2026-02-30' }), /fecha válida/);
  const state = initial();
  act(state, { type: 'record-personal-payment', id: 'carro:0', amount: 0, paidDate: '2026-10-05' });
  const corrupt = structuredClone(state);
  corrupt.personal.daniel.months['2026-10'].payments['carro:0'].dueDate = '2026-11-15';
  assert.throws(() => validateState(corrupt), /otro mes/);
  const unknown = structuredClone(state); unknown.personal.extra = unknown.personal.sofia;
  assert.throws(() => validateState(unknown), /formato inválido/);
  assert.doesNotThrow(() => validateState(JSON.parse(JSON.stringify(state))));
});
