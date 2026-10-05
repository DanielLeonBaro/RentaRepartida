import { availableMonths, money, today, validDate, validMonth } from './domain.mjs';

export const DEBT_ACTIONS = ['save-debt', 'delete-debt', 'record-debt-payment', 'delete-debt-payment'];
const OWNERS = ['daniel', 'sofia', 'hogar'];
const ID = /^[a-z0-9][a-z0-9-]{0,80}$/i;

function owner(value) {
  if (!OWNERS.includes(value)) throw new Error('Elige una deuda de Daniel, Sofía o el hogar.');
  return value;
}
function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 70) throw new Error('Escribe un nombre de deuda de hasta 70 caracteres.');
  return value.trim();
}
function dueDay(value) {
  if (value !== null && (!Number.isInteger(value) || value < 1 || value > 31)) throw new Error('El día de pago debe estar entre 1 y 31, o quedar sin fecha.');
  return value;
}
function sum(rows) {
  const total = rows.reduce((value, row) => value + row.amount, 0);
  if (!Number.isSafeInteger(total)) throw new Error('El total de abonos excede el límite permitido.');
  return total;
}
function defaults(state) {
  return [
    ['hey-banco', 'Hey banco', 7000000, 13],
    ['citi-banamex', 'CITI Banamex', 1000000, null],
    ['nu', 'NU', 800000, 17],
    ['bbva', 'BBVA', 2000000, 12],
    ['mercadopago', 'MercadoPago', 2400000, 1]
  ].map(([id, name, openingBalance, dueDay]) => ({ id, owner: 'daniel', name, openingBalance, monthlyPlans: {}, dueDay, startMonth: state.initialMonth, active: true, payments: [] }));
}
function dateFor(month, day) {
  if (day === null) return null;
  const [year, number] = month.split('-').map(Number);
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return `${month}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

export function debtsView(state, requestedOwner, month, date = today()) {
  owner(requestedOwner); validMonth(month); validDate(date);
  const debts = [], payments = [];
  let balance = 0, pending = 0;
  for (const debt of state.debts ?? defaults(state)) {
    const history = debt.payments.filter(payment => payment.owner === requestedOwner);
    const monthPayments = history.filter(payment => payment.month === month);
    const owned = debt.owner === requestedOwner;
    if (!owned && !history.length) continue;
    const totalPaid = sum(debt.payments), currentBalance = debt.openingBalance - totalPaid;
    const monthPaid = sum(monthPayments);
    const monthlyPayment = debt.monthlyPlans[month] ?? 0;
    // An abono assigned to a later budget month does not reduce an earlier month's plan.
    const balanceAtMonth = debt.openingBalance - sum(debt.payments.filter(payment => payment.month <= month));
    const allMonthPaid = sum(debt.payments.filter(payment => payment.month === month));
    const monthPending = owned && debt.active && debt.startMonth <= month ? Math.min(balanceAtMonth, Math.max(0, monthlyPayment - allMonthPaid)) : 0;
    const dueDate = debt.startMonth <= month ? dateFor(month, debt.dueDay) : null;
    debts.push({ id: debt.id, owner: debt.owner, name: debt.name, active: debt.active, owned, balance: currentBalance, totalPaid, monthlyPayment, dueDay: debt.dueDay, dueDate, monthPaid, monthPending, monthBudget: monthPaid + monthPending, overdue: Boolean(monthPending && dueDate && dueDate < date), startMonth: debt.startMonth, payments: debt.payments.map(payment => ({ ...payment, debtId: debt.id })) });
    payments.push(...monthPayments.map(payment => ({ ...payment, debtId: debt.id })));
    if (owned && debt.active) balance += currentBalance;
    pending += monthPending;
  }
  debts.sort((a, b) => Number(b.active && b.owned) - Number(a.active && a.owned) || a.name.localeCompare(b.name, 'es'));
  payments.sort((a, b) => a.paidDate.localeCompare(b.paidDate) || a.id.localeCompare(b.id));
  const paid = sum(payments);
  for (const value of [balance, pending, paid + pending]) if (!Number.isSafeInteger(value)) throw new Error('El total de deudas excede el límite permitido.');
  return { owner: requestedOwner, month, today: date, debts, payments, totals: { balance, paid, pending, budget: paid + pending } };
}

export function applyDebtAction(state, action, date = today()) {
  if (!action || typeof action !== 'object' || Array.isArray(action) || !DEBT_ACTIONS.includes(action.type)) throw new Error('La operación de deuda no existe.');
  owner(action.owner);
  const month = validMonth(action.month);
  if (!availableMonths(state, date).includes(month)) throw new Error('Ese mes aún no está disponible.');
  for (const value of [action.id, action.paymentId]) if (value !== undefined && (typeof value !== 'string' || !ID.test(value))) throw new Error('La deuda o el abono no tiene un identificador válido.');
  const debts = state.debts ?? defaults(state);
  const debt = debts.find(item => item.id === action.id);
  if (action.id && !debt) throw new Error('No se encontró esa deuda.');
  if (action.type === 'save-debt') {
    const paid = debt ? sum(debt.payments) : 0;
    const fields = { owner: action.owner, name: name(action.name), openingBalance: money(money(action.balance, 'El saldo actual') + paid, 'El saldo inicial y los abonos'), monthlyPlans: { ...debt?.monthlyPlans, [month]: money(action.monthlyPayment ?? debt?.monthlyPlans[month] ?? 0, 'El abono planeado del mes') }, dueDay: dueDay(action.dueDay), active: true };
    if (debt) Object.assign(debt, fields);
    else debts.push({ id: `deuda-${crypto.randomUUID()}`, ...fields, startMonth: month, payments: [] });
  } else {
    if (!debt) throw new Error('No se encontró esa deuda.');
    if (action.type === 'delete-debt') {
      if (action.owner !== debt.owner) throw new Error('La deuda pertenece a otra persona.');
      if (!debt.active) throw new Error('Esta deuda ya está eliminada.');
      debt.active = false;
    } else {
      const previous = debt.payments.find(payment => payment.id === action.paymentId);
      if (action.paymentId && !previous) throw new Error('No se encontró ese abono.');
      if (previous && (previous.owner !== action.owner || previous.month !== month)) throw new Error('El abono corresponde a otra persona o mes.');
      if (action.type === 'delete-debt-payment') {
        if (!previous) throw new Error('Elige el abono que quieres anular.');
        debt.payments = debt.payments.filter(payment => payment.id !== previous.id);
      } else {
        if (!previous && (action.owner !== debt.owner || !debt.active)) throw new Error('Solo puedes abonar a una deuda activa de esta persona.');
        if (month < debt.startMonth) throw new Error('La deuda aún no estaba registrada en ese mes.');
        const amount = money(action.amount, 'El abono');
        if (!amount) throw new Error('El abono debe ser mayor que $0.');
        const remaining = debt.openingBalance - sum(debt.payments) + (previous?.amount || 0);
        if (amount > remaining) throw new Error('El abono no puede superar el saldo pendiente.');
        const payment = { id: previous?.id || `abono-${crypto.randomUUID()}`, amount, paidDate: validDate(action.paidDate), month: previous?.month || month, owner: previous?.owner || debt.owner, name: previous?.name || debt.name, paidAt: new Date().toISOString() };
        if (previous) debt.payments[debt.payments.indexOf(previous)] = payment;
        else debt.payments.push(payment);
      }
    }
  }
  state.debts = debts;
  validateDebts(state);
  return state;
}

export function validateDebts(state) {
  if (state.debts === undefined) return state;
  if (!Array.isArray(state.debts)) throw new Error('Las deudas tienen un formato inválido.');
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const ids = new Set(), paymentIds = new Set();
  for (const debt of state.debts) {
    if (!object(debt) || typeof debt.id !== 'string' || !ID.test(debt.id) || ids.has(debt.id) || typeof debt.active !== 'boolean' || !Array.isArray(debt.payments)) throw new Error('La deuda tiene un formato inválido.');
    ids.add(debt.id); owner(debt.owner); name(debt.name); money(debt.openingBalance); dueDay(debt.dueDay); validMonth(debt.startMonth);
    if (!object(debt.monthlyPlans)) throw new Error('Los abonos planeados tienen un formato inválido.');
    for (const [month, amount] of Object.entries(debt.monthlyPlans)) { validMonth(month); money(amount, 'El abono planeado del mes'); }
    for (const payment of debt.payments) {
      if (!object(payment) || typeof payment.id !== 'string' || !ID.test(payment.id) || paymentIds.has(payment.id) || typeof payment.paidAt !== 'string' || !Number.isFinite(Date.parse(payment.paidAt))) throw new Error('El abono tiene un formato inválido.');
      paymentIds.add(payment.id); owner(payment.owner); name(payment.name); validMonth(payment.month); validDate(payment.paidDate);
      if (!money(payment.amount, 'El abono') || payment.month < debt.startMonth) throw new Error('El abono tiene un formato inválido.');
    }
    if (sum(debt.payments) > debt.openingBalance) throw new Error('Los abonos superan el saldo inicial de la deuda.');
  }
  return state;
}
