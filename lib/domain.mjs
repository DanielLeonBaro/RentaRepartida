export const PEOPLE = { sofia: 'Sofía', daniel: 'Daniel' };
export const MAX_MONEY = 100_000_000_00;
export function today(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Hermosillo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function validMonth(value) {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || +value.slice(0, 4) < 1901 || +value.slice(0, 4) > 9998) throw new Error('Elige un mes válido.');
  return value;
}
export function shiftMonth(month, delta) {
  validMonth(month);
  const [year, number] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, number - 1 + delta, 1));
  return date.toISOString().slice(0, 7);
}
export function upcomingMonth(date = today()) { return +date.slice(8) > 15 ? shiftMonth(date.slice(0, 7), 1) : date.slice(0, 7); }
export function availableMonths(state, date = today()) {
  const last = shiftMonth(date.slice(0, 7), 1);
  const months = [];
  for (let month = state.initialMonth; month <= last; month = shiftMonth(month, 1)) months.push(month);
  return months;
}
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Elige una fecha válida.');
  validMonth(value.slice(0, 7));
  const parsed = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('Elige una fecha válida.');
  return value;
}
function recurringDate(month, day) {
  if (!day) return null;
  const [year, number] = month.split('-').map(Number);
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return `${month}-${String(Math.min(day, last)).padStart(2, '0')}`;
}
export function validateReceipt(receipt) {
  if (!receipt || !/^[a-f0-9-]{36}\.(png|jpg|webp)$/.test(receipt.id) || typeof receipt.name !== 'string' || !receipt.name.trim() || receipt.name.length > 180 || !['image/png', 'image/jpeg', 'image/webp'].includes(receipt.type) || !Number.isSafeInteger(receipt.bytes) || receipt.bytes <= 0 || receipt.bytes > 10 * 1024 * 1024 || !Number.isFinite(Date.parse(receipt.uploadedAt))) throw new Error('El comprobante no es válido.');
  return receipt;
}
export function money(value, label = 'El importe') {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MONEY) throw new Error(`${label} debe ser un importe válido, mayor o igual a $0.`);
  return value;
}
function label(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 70) throw new Error('Escribe un nombre de gasto de hasta 70 caracteres.');
  return value.trim();
}
export function createState(date = today()) {
  const initialMonth = date.slice(0, 7);
  const base = [['renta', 'Renta', 1100000], ['despensa', 'Despensa', 450000], ['luz', 'Luz', 100000], ['agua', 'Agua', 50000], ['internet', 'Internet', 50000], ['ahorro', 'Ahorro', 30000]];
  return { schemaVersion: 1, revision: 0, initialMonth, settings: { timezone: 'America/Hermosillo', deadlineDay: 15 }, expenses: base.map(([id, name, amount]) => ({ id, versions: [{ from: '1901-01', name, amount, active: true }] })), cycles: {} };
}
export function paydays(state, month) {
  validMonth(month);
  const start = `${shiftMonth(month, -1)}-16`;
  const end = `${month}-15`;
  const rows = [];
  for (let date = new Date(`${start}T12:00:00Z`); date.toISOString().slice(0, 10) <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    const day = date.getUTCDate();
    const iso = date.toISOString().slice(0, 10);
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    const persons = [];
    if (date.getUTCDay() === 0) persons.push('sofia');
    if (day === 15 || day === Math.min(30, last)) persons.push('daniel');
    for (const person of persons) {
      const id = `${person}:${iso}`;
      let income = person === 'daniel' ? 2400000 : 100000;
      if (person === 'sofia' && iso.slice(0, 7) === state.initialMonth) income = [250000, 222500, 100000, 100000, 100000][Math.floor((day - 1) / 7)];
      const saved = state.cycles[month]?.paydays?.[id];
      rows.push({ id, person, date: iso, income, available: income, closed: false, paid: 0, receipts: [], ...saved });
    }
  }
  return rows;
}
export function expensesFor(state, month) {
  const overrides = state.cycles[month]?.expenseOverrides || {};
  return state.expenses.flatMap(expense => {
    const version = expense.versions.filter(v => v.from <= month).sort((a, b) => a.from.localeCompare(b.from)).at(-1);
    const override = overrides[expense.id];
    const effective = override || version;
    if (!effective?.active) return [];
    const payment = state.cycles[month]?.expensePayments?.[expense.id];
    const dueDay = Object.hasOwn(effective, 'dueDay') ? effective.dueDay : expense.id === 'renta' ? 15 : null;
    const dueDate = Object.hasOwn(effective, 'dueDate') ? effective.dueDate : recurringDate(month, dueDay);
    return [{ id: expense.id, name: effective.name, amount: payment ? payment.amount : effective.amount, plannedAmount: effective.amount, temporary: Boolean(override), dueDate, payment: payment || null }];
  });
}
export function allocate(total, weights) {
  if (!Number.isSafeInteger(total) || total < 0 || weights.some(w => !Number.isSafeInteger(w) || w < 0)) throw new Error('Importes fuera de rango.');
  const capacity = weights.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(capacity)) throw new Error('Importes fuera de rango.');
  const target = Math.min(total, capacity);
  if (!capacity || !target) return weights.map(() => 0);
  const parts = weights.map((weight, index) => {
    const numerator = BigInt(target) * BigInt(weight);
    return { index, amount: Number(numerator / BigInt(capacity)), remainder: numerator % BigInt(capacity) };
  });
  const remaining = target - parts.reduce((sum, p) => sum + p.amount, 0);
  const ordered = [...parts].sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (let i = 0; i < remaining; i++) ordered[i].amount++;
  return parts.map(p => p.amount);
}
export function cycleView(state, month, date = today()) {
  validMonth(month);
  const expenses = expensesFor(state, month);
  const rows = paydays(state, month);
  const total = expenses.reduce((sum, e) => sum + e.amount, 0);
  const saved = rows.reduce((sum, p) => sum + (p.closed ? p.paid : 0), 0);
  const pending = Math.max(0, total - saved);
  const open = rows.filter(p => !p.closed);
  const capacity = open.reduce((sum, p) => sum + p.available, 0);
  for (const value of [total, saved, capacity]) if (!Number.isSafeInteger(value)) throw new Error('El total excede el límite permitido.');
  const allocated = allocate(pending, open.map(p => p.available));
  const suggestions = new Map(open.map((p, i) => [p.id, allocated[i]]));
  return { month, start: `${shiftMonth(month, -1)}-16`, deadline: `${month}-15`, today: date, expenses,
    paydays: rows.map(p => ({ ...p, suggested: p.closed ? p.suggestedAtClose : suggestions.get(p.id), overdue: !p.closed && p.date < date })),
    totals: { total, saved, pending, capacity, shortage: Math.max(0, pending - capacity), surplus: Math.max(0, saved - total), percent: capacity ? Math.min(pending, capacity) / capacity : 0 } };
}
export function applyAction(state, action, date = today()) {
  if (!action || typeof action !== 'object') throw new Error('La operación no es válida.');
  const month = validMonth(action.month);
  if (!availableMonths(state, date).includes(month)) throw new Error('Ese vencimiento aún no está disponible. Se muestran desde el primer mes de renta hasta el próximo mes.');
  if (!state.cycles[month]) state.cycles[month] = { paydays: {}, expenseOverrides: {} };
  const cycle = state.cycles[month];
  if (['update-payday', 'close-payday', 'reopen-payday', 'attach-receipt'].includes(action.type)) {
    const payday = paydays(state, month).find(p => p.id === action.id);
    if (!payday) throw new Error('No se encontró ese cobro.');
    if (action.type === 'attach-receipt') {
      const receipt = validateReceipt(action.receipt);
      const record = cycle.paydays[payday.id] || { income: payday.income, available: payday.available, closed: false, paid: 0 };
      record.receipts = [...(record.receipts || []), receipt];
      cycle.paydays[payday.id] = record;
    } else if (action.type === 'reopen-payday') {
      if (!payday.closed) throw new Error('Esta aportación ya está abierta.');
      const record = { ...cycle.paydays[payday.id], closed: false, paid: 0, previousPaid: payday.paid };
      delete record.closedAt; delete record.suggestedAtClose;
      cycle.paydays[payday.id] = record;
    } else if (payday.closed) throw new Error('Esta aportación está cerrada. Reábrela primero para corregirla.');
    else if (action.type === 'update-payday') {
      const income = money(action.income, 'El ingreso');
      const available = money(action.available, 'El dinero disponible');
      if (payday.person === 'sofia' && income < 100000) throw new Error('El ingreso estimado de Sofía debe ser de al menos $1,000. Puedes reducir su dinero disponible hasta $0.');
      if (payday.person === 'daniel' && income !== 2400000) throw new Error('El ingreso de Daniel es fijo: $24,000. Cambia el dinero disponible para este cobro.');
      if (available > income) throw new Error('El dinero disponible no puede superar el ingreso estimado.');
      cycle.paydays[payday.id] = { ...cycle.paydays[payday.id], income, available, closed: false, paid: 0 };
    } else {
      const suggested = cycleView(state, month, date).paydays.find(p => p.id === payday.id).suggested;
      cycle.paydays[payday.id] = { income: payday.income, available: payday.available, closed: true, paid: money(action.paid, 'La aportación'), receipts: payday.receipts, suggestedAtClose: suggested, closedAt: new Date().toISOString() };
    }
  } else if (action.type === 'record-expense-payment' || action.type === 'clear-expense-payment') {
    if (!expensesFor(state, month).some(e => e.id === action.id)) throw new Error('No se encontró ese gasto activo.');
    cycle.expensePayments ||= {};
    if (action.type === 'clear-expense-payment') delete cycle.expensePayments[action.id];
    else cycle.expensePayments[action.id] = { amount: money(action.amount, 'El pago real'), paidDate: validDate(action.paidDate) };
  } else if (action.type === 'save-expense' || action.type === 'delete-expense') {
    if (!['cycle', 'future'].includes(action.scope)) throw new Error('Elige si el cambio aplica solo a este ciclo o también a los siguientes.');
    let expense = state.expenses.find(e => e.id === action.id);
    if (!expense && (action.type === 'delete-expense' || action.id)) throw new Error('No se encontró ese gasto.');
    if (!expense) {
      expense = { id: `gasto-${crypto.randomUUID()}`, versions: [] };
      state.expenses.push(expense);
    }
    const current = expensesFor(state, month).find(e => e.id === expense.id);
    if (action.type === 'delete-expense' && !current) throw new Error('Ese gasto ya no está activo.');
    const version = action.type === 'delete-expense' ? { name: current.name, amount: current.plannedAmount, active: false } : { name: label(action.name), amount: money(action.amount, 'El gasto'), active: true };
    if (action.type === 'save-expense') {
      const dueDate = Object.hasOwn(action, 'dueDate') ? action.dueDate : current?.dueDate || null;
      if (dueDate !== null) validDate(dueDate);
      if (action.scope === 'cycle') version.dueDate = dueDate;
      else version.dueDay = dueDate ? Number(dueDate.slice(8)) : null;
    }
    if (action.scope === 'cycle') cycle.expenseOverrides[expense.id] = version;
    else {
      expense.versions = expense.versions.filter(v => v.from !== month);
      expense.versions.push({ ...version, from: month });
      expense.versions.sort((a, b) => a.from.localeCompare(b.from));
      delete cycle.expenseOverrides[expense.id];
    }
  } else throw new Error('La operación no existe.');
  cycleView(state, month, date);
  return state;
}
export function validateState(state) {
  if (!state || state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.expenses) || !state.cycles || typeof state.cycles !== 'object' || Array.isArray(state.cycles)) throw new Error('El archivo de datos tiene un formato inválido.');
  validMonth(state.initialMonth);
  if (state.settings?.timezone !== 'America/Hermosillo' || state.settings?.deadlineDay !== 15) throw new Error('La configuración del archivo no es válida.');
  const ids = new Set();
  const checkExpense = v => {
    label(v.name); money(v.amount); if (typeof v.active !== 'boolean') throw new Error('Gasto inválido.');
    if (v.dueDate != null) validDate(v.dueDate);
    if (v.dueDay != null && (!Number.isInteger(v.dueDay) || v.dueDay < 1 || v.dueDay > 31)) throw new Error('Día de pago inválido.');
  };
  for (const expense of state.expenses) {
    if (typeof expense.id !== 'string' || ids.has(expense.id) || !Array.isArray(expense.versions)) throw new Error('Gasto inválido.');
    ids.add(expense.id);
    const starts = new Set();
    for (const v of expense.versions) { validMonth(v.from); checkExpense(v); if (starts.has(v.from)) throw new Error('Vigencias duplicadas.'); starts.add(v.from); }
  }
  for (const [month, cycle] of Object.entries(state.cycles)) {
    validMonth(month);
    if (!cycle.paydays || !cycle.expenseOverrides || Array.isArray(cycle.paydays) || Array.isArray(cycle.expenseOverrides)) throw new Error('Ciclo inválido.');
    for (const [id, v] of Object.entries(cycle.expenseOverrides)) { if (!ids.has(id)) throw new Error('Gasto desconocido.'); checkExpense(v); }
    if (cycle.expensePayments && (typeof cycle.expensePayments !== 'object' || Array.isArray(cycle.expensePayments))) throw new Error('Pagos de gastos inválidos.');
    for (const [id, payment] of Object.entries(cycle.expensePayments || {})) {
      if (!ids.has(id)) throw new Error('Gasto desconocido.'); money(payment.amount); validDate(payment.paidDate);
    }
    const generated = new Set(paydays({ ...state, cycles: {} }, month).map(p => p.id));
    for (const [id, p] of Object.entries(cycle.paydays)) {
      if (!generated.has(id) || typeof p.closed !== 'boolean') throw new Error('Cobro inválido.');
      money(p.income); money(p.available); money(p.paid);
      if (p.previousPaid != null) money(p.previousPaid);
      if (p.receipts != null) { if (!Array.isArray(p.receipts)) throw new Error('Comprobantes inválidos.'); p.receipts.forEach(validateReceipt); }
      if (p.available > p.income || (id.startsWith('daniel:') ? p.income !== 2400000 : p.income < 100000)) throw new Error('Ingreso inválido.');
      if (p.closed) { money(p.suggestedAtClose); if (typeof p.closedAt !== 'string' || !Number.isFinite(Date.parse(p.closedAt))) throw new Error('Cierre inválido.'); }
      else if (p.paid !== 0) throw new Error('Aportación sin cierre.');
    }
    cycleView(state, month);
  }
  return state;
}
