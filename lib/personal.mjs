import { PEOPLE, availableMonths, cycleView, money, shiftMonth, today, validDate, validMonth } from './domain.mjs';
import { debtsView } from './debts.mjs';

const ACTIONS = ['save-personal-expense', 'delete-personal-expense', 'record-personal-payment', 'reopen-personal-payment'];
const SCHEDULES = ['monthly', 'quincenal', 'weekly', 'unscheduled'];

function personName(person) {
  if (!Object.hasOwn(PEOPLE, person)) throw new Error('Elige a Sofía o Daniel.');
  return PEOPLE[person];
}
function expenseName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 70) throw new Error('Escribe un nombre de gasto de hasta 70 caracteres.');
  return value.trim();
}
function checkSchedule(value) {
  if (!SCHEDULES.includes(value.schedule)) throw new Error('Elige cuándo se paga este gasto.');
  if (!Number.isInteger(value.day) || value.day < 1 || value.day > 31) throw new Error('El día del mes debe estar entre 1 y 31.');
  if (!Number.isInteger(value.weekday) || value.weekday < 0 || value.weekday > 6) throw new Error('Elige un día de la semana válido.');
}
function defaults(person) {
  const rows = person === 'daniel' ? [
    ['telefonos', 'Teléfonos', 220000, 'monthly', 1],
    ['internet-sp', 'Internet SP', 200000, 'monthly', 15],
    ['carro', 'Carro', 1000000, 'quincenal'],
    ['gasolina', 'Gasolina', 300000, 'quincenal'],
    ['dnd', 'D&D', 100000, 'weekly'],
    ['gpt', 'GPT', 50000, 'monthly', 1],
    ['ocio', 'Ocio', 200000, 'quincenal']
  ] : [
    ['tarjeta', 'Tarjeta', 149300, 'unscheduled'],
    ['mesa', 'Mesa', 90000, 'unscheduled'],
    ['insumos', 'Insumos de trabajo', 40000, 'unscheduled'],
    ['ahorro', 'Ahorro', 50000, 'unscheduled']
  ];
  return { expenses: rows.map(([id, name, amount, schedule, day = 1]) => ({ id, versions: [{ from: '1901-01', name, amount, active: true, schedule, day, weekday: 0 }] })), months: {} };
}
function personalData(state, person) { return state.personal?.[person] || defaults(person); }
function endOfMonth(month) {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number, 0)).getUTCDate();
}
function monthlyDate(month, day) { return `${month}-${String(Math.min(day, endOfMonth(month))).padStart(2, '0')}`; }
function paymentDates(month, expense) {
  if (expense.schedule === 'unscheduled') return [null];
  if (expense.schedule === 'monthly') return [monthlyDate(month, expense.day)];
  if (expense.schedule === 'quincenal') return [monthlyDate(month, 15), monthlyDate(month, 30)];
  const dates = [];
  for (let day = 1; day <= endOfMonth(month); day++) {
    const date = monthlyDate(month, day);
    if (new Date(`${date}T12:00:00Z`).getUTCDay() === expense.weekday) dates.push(date);
  }
  return dates;
}
function split(total, count) {
  if (!count) return [];
  const amount = Math.floor(total / count), remainder = total % count;
  return Array.from({ length: count }, (_, index) => amount + (index < remainder ? 1 : 0));
}
function sum(rows, field) {
  const value = rows.reduce((total, row) => total + row[field], 0);
  if (!Number.isSafeInteger(value)) throw new Error('El total excede el límite permitido.');
  return value;
}

export function personalView(state, person, month, date = today()) {
  const name = personName(person);
  validMonth(month);
  validDate(date);
  const data = personalData(state, person), savedMonth = data.months[month] || {};
  const recorded = savedMonth.payments || {}, reopened = savedMonth.reopenedPayments || {}, overrides = savedMonth.expenseOverrides || {};
  const payments = [
    ...Object.entries(recorded).map(([id, payment]) => ({ id, ...payment, paid: true, overdue: false })),
    ...Object.entries(reopened).map(([id, payment]) => ({ id, ...payment, paid: false, overdue: Boolean(payment.dueDate && payment.dueDate < date) }))
  ];
  const expenses = [];
  for (const expense of data.expenses) {
    const version = expense.versions.filter(v => v.from <= month).sort((a, b) => a.from.localeCompare(b.from)).at(-1);
    const effective = overrides[expense.id] || version;
    if (!effective?.active) continue;
    const closed = payments.filter(payment => payment.expenseId === expense.id && payment.paid);
    const retained = payments.filter(payment => payment.expenseId === expense.id && !payment.paid);
    const pendingSlots = paymentDates(month, effective).map((dueDate, slot) => ({ id: `${expense.id}:${slot}`, dueDate })).filter(slot => !Object.hasOwn(recorded, slot.id) && !Object.hasOwn(reopened, slot.id));
    const amounts = split(Math.max(0, effective.amount - sum(closed, 'plannedAmount') - sum(retained, 'plannedAmount')), pendingSlots.length);
    const open = pendingSlots.map((slot, index) => ({ ...slot, expenseId: expense.id, name: effective.name, plannedAmount: amounts[index], amount: amounts[index], paidDate: null, paidAt: null, paid: false, overdue: Boolean(slot.dueDate && slot.dueDate < date) }));
    payments.push(...open);
    const paidAmount = sum(closed, 'amount'), pendingAmount = sum(open, 'amount') + sum(retained, 'amount');
    expenses.push({ id: expense.id, name: effective.name, plannedAmount: effective.amount, amount: paidAmount + pendingAmount, schedule: effective.schedule, day: effective.day, weekday: effective.weekday, temporary: Boolean(overrides[expense.id]), paidAmount, pendingAmount });
  }
  payments.sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || a.id.localeCompare(b.id));
  const cycles = [month, shiftMonth(month, 1)].map(cycleMonth => ({ cycleMonth, view: cycleView(state, cycleMonth, date) }));
  const paydays = cycles.flatMap(({ cycleMonth, view }) => view.paydays.filter(p => p.person === person && p.date.slice(0, 7) === month).map(p => ({ ...p, cycleMonth }))).sort((a, b) => a.date.localeCompare(b.date));
  const incomePaydays = paydays.map(p => ({ id: p.id, date: p.date, income: p.income, cycleMonth: p.cycleMonth }));
  const contributions = paydays.map(p => ({ id: p.id, date: p.date, amount: p.closed ? p.paid : p.suggested, closed: p.closed, cycleMonth: p.cycleMonth }));
  const household = { total: sum(contributions, 'amount'), saved: sum(contributions.filter(p => p.closed), 'amount'), pending: sum(contributions.filter(p => !p.closed), 'amount'), contributions };
  const debts = debtsView(state, person, month, date);
  const totals = { income: sum(incomePaydays, 'income'), expenses: sum(payments, 'amount') + debts.totals.budget, paid: sum(payments.filter(p => p.paid), 'amount') + debts.totals.paid, pending: sum(payments.filter(p => !p.paid), 'amount') + debts.totals.pending, debts: debts.totals.budget, household: household.total };
  totals.remaining = totals.income - totals.expenses - totals.household;
  return { person, name, month, start: `${month}-01`, end: monthlyDate(month, 31), today: date, incomePaydays, expenses, payments, household, debts, totals };
}

export function applyPersonalAction(state, action, date = today()) {
  if (!action || !ACTIONS.includes(action.type)) throw new Error('La operación personal no existe.');
  personName(action.person);
  const month = validMonth(action.month);
  if (!availableMonths(state, date).includes(month)) throw new Error('Ese mes aún no está disponible.');
  // Older shared data remains unchanged until the first personal edit is saved.
  state.personal ||= { daniel: defaults('daniel'), sofia: defaults('sofia') };
  state.personal[action.person] ||= defaults(action.person);
  const data = state.personal[action.person];
  data.months[month] ||= { expenseOverrides: {}, payments: {} };
  const savedMonth = data.months[month];
  if (action.type === 'record-personal-payment' || action.type === 'reopen-personal-payment') {
    const currentView = personalView(state, action.person, month, date);
    const payment = currentView.payments.find(p => p.id === action.id);
    if (!payment) throw new Error('No se encontró ese pago personal.');
    if (action.type === 'reopen-personal-payment') {
      if (!payment.paid) throw new Error('Este pago ya está pendiente.');
      delete savedMonth.payments[action.id];
      const expense = currentView.expenses.find(e => e.id === payment.expenseId);
      const generated = expense && paymentDates(month, expense).some((_, slot) => `${expense.id}:${slot}` === payment.id);
      if (!generated) {
        savedMonth.reopenedPayments ||= {};
        savedMonth.reopenedPayments[action.id] = { expenseId: payment.expenseId, name: payment.name, plannedAmount: payment.plannedAmount, dueDate: payment.dueDate, amount: payment.plannedAmount, paidDate: null, paidAt: null };
      }
    } else {
      if (payment.paid) throw new Error('Este pago está cerrado. Reábrelo para corregirlo.');
      savedMonth.payments[action.id] = { expenseId: payment.expenseId, name: payment.name, plannedAmount: payment.plannedAmount, dueDate: payment.dueDate, amount: money(action.amount, 'El pago real'), paidDate: validDate(action.paidDate), paidAt: new Date().toISOString() };
      if (savedMonth.reopenedPayments) delete savedMonth.reopenedPayments[action.id];
    }
  } else {
    if (!['cycle', 'future'].includes(action.scope)) throw new Error('Elige si el cambio aplica solo a este mes o también a los siguientes.');
    let expense = data.expenses.find(e => e.id === action.id);
    if (!expense && (action.type === 'delete-personal-expense' || action.id)) throw new Error('No se encontró ese gasto personal.');
    if (!expense) { expense = { id: `personal-${crypto.randomUUID()}`, versions: [] }; data.expenses.push(expense); }
    const current = personalView(state, action.person, month, date).expenses.find(e => e.id === expense.id);
    if (action.type === 'delete-personal-expense' && !current) throw new Error('Ese gasto ya no está activo.');
    const version = action.type === 'delete-personal-expense' ? { name: current.name, amount: current.plannedAmount, active: false, schedule: current.schedule, day: current.day, weekday: current.weekday } : { name: expenseName(action.name), amount: money(action.amount, 'El gasto'), active: true, schedule: action.schedule, day: action.day ?? current?.day ?? 1, weekday: action.weekday ?? current?.weekday ?? 0 };
    checkSchedule(version);
    if (action.scope === 'cycle') savedMonth.expenseOverrides[expense.id] = version;
    else {
      expense.versions = expense.versions.filter(v => v.from !== month);
      expense.versions.push({ ...version, from: month });
      expense.versions.sort((a, b) => a.from.localeCompare(b.from));
      delete savedMonth.expenseOverrides[expense.id];
    }
  }
  personalView(state, action.person, month, date);
  return state;
}

export function validatePersonal(state) {
  if (state.personal === undefined) return state;
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(state.personal) || Object.keys(state.personal).some(person => !Object.hasOwn(PEOPLE, person))) throw new Error('Los calendarios personales tienen un formato inválido.');
  const checkExpense = value => {
    if (!object(value)) throw new Error('Gasto personal inválido.');
    expenseName(value.name); money(value.amount); checkSchedule(value);
    if (typeof value.active !== 'boolean') throw new Error('Gasto personal inválido.');
  };
  for (const [person, data] of Object.entries(state.personal)) {
    if (!object(data) || !Array.isArray(data.expenses) || !object(data.months)) throw new Error('Calendario personal inválido.');
    const ids = new Set();
    for (const expense of data.expenses) {
      if (!object(expense) || typeof expense.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,80}$/i.test(expense.id) || ids.has(expense.id) || !Array.isArray(expense.versions)) throw new Error('Gasto personal inválido.');
      ids.add(expense.id);
      const starts = new Set();
      for (const version of expense.versions) {
        checkExpense(version); validMonth(version.from);
        if (starts.has(version.from)) throw new Error('Vigencias personales duplicadas.');
        starts.add(version.from);
      }
    }
    for (const [month, savedMonth] of Object.entries(data.months)) {
      validMonth(month);
      if (!object(savedMonth) || !object(savedMonth.expenseOverrides) || !object(savedMonth.payments) || (savedMonth.reopenedPayments !== undefined && !object(savedMonth.reopenedPayments))) throw new Error('Mes personal inválido.');
      for (const [id, value] of Object.entries(savedMonth.expenseOverrides)) { if (!ids.has(id)) throw new Error('Gasto personal desconocido.'); checkExpense(value); }
      const checkPayment = (id, payment, paid) => {
        if (!object(payment) || !ids.has(payment.expenseId) || !id.startsWith(`${payment.expenseId}:`) || !/^(0|[1-9]|[12][0-9]|30)$/.test(id.slice(payment.expenseId.length + 1))) throw new Error('Pago personal inválido.');
        expenseName(payment.name); money(payment.plannedAmount); money(payment.amount);
        if (payment.dueDate !== null) { validDate(payment.dueDate); if (!payment.dueDate.startsWith(`${month}-`)) throw new Error('El pago personal corresponde a otro mes.'); }
        if (paid) {
          validDate(payment.paidDate);
          if (typeof payment.paidAt !== 'string' || !Number.isFinite(Date.parse(payment.paidAt))) throw new Error('Registro de pago personal inválido.');
        } else if (payment.paidDate !== null || payment.paidAt !== null || payment.amount !== payment.plannedAmount || Object.hasOwn(savedMonth.payments, id)) throw new Error('Pago personal reabierto inválido.');
      };
      for (const [id, payment] of Object.entries(savedMonth.payments)) checkPayment(id, payment, true);
      for (const [id, payment] of Object.entries(savedMonth.reopenedPayments || {})) checkPayment(id, payment, false);
      personalView(state, person, month);
    }
  }
  return state;
}
