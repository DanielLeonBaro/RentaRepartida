import { createDebtManager } from '/debts.js';

const $ = id => document.getElementById(id);
const person = location.pathname.replace(/\/+$/, '').slice(1);
const names = { sofia: 'Sofía', daniel: 'Daniel' };
const name = names[person];
const currency = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
const cash = cents => currency.format(cents / 100);
const dateFormat = (iso, options) => new Intl.DateTimeFormat('es-MX', { ...options, timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
const shortDate = iso => dateFormat(iso, { day: 'numeric', month: 'short' });
const longDate = iso => dateFormat(iso, { weekday: 'long', day: 'numeric', month: 'long' });
const monthName = month => dateFormat(`${month}-01`, { month: 'long', year: 'numeric' });
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const weekdays = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
let data, modal, busy = false, requestNumber = 0, toastTimer, returnFocus;
const debts = createDebtManager({ getData: () => data, onSaved: result => { ++requestNumber; data = result; render(); }, toast });

async function api(url, options) {
  let response;
  try { response = await fetch(url, options); } catch { throw new Error('No se pudo conectar. Revisa tu conexión y vuelve a intentarlo.'); }
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || 'No se pudo completar la operación.'); error.status = response.status; throw error; }
  return result;
}
const personalUrl = month => `/api/personal?person=${person}${month ? `&month=${encodeURIComponent(month)}` : ''}`;
const householdHref = month => data.availableMonths.includes(month) ? `/?month=${month}` : '/';
const paymentCalendarDate = payment => payment.paidDate?.startsWith(`${data.personal.month}-`) ? payment.paidDate : payment.dueDate;
async function load(month) {
  const number = ++requestNumber;
  $('personal-loading').hidden = Boolean(data);
  $('personal-load-error').hidden = true;
  try {
    const result = await api(personalUrl(month));
    if (number !== requestNumber) return;
    data = result; render(); $('personal-workspace').hidden = false;
  } catch (error) {
    if (number !== requestNumber) return;
    $('personal-load-error-text').textContent = error.message;
    $('personal-load-error').hidden = false;
    if (data) $('personal-month').value = data.personal.month;
  } finally { if (number === requestNumber) $('personal-loading').hidden = true; }
}
function scheduleText(expense) {
  if (expense.schedule === 'quincenal') return 'Días 15 y 30 · dividido en dos pagos';
  if (expense.schedule === 'weekly') return `Cada ${weekdays[expense.weekday ?? 0]} · dividido entre las semanas`;
  if (expense.schedule === 'monthly') return `Día ${expense.day} de cada mes`;
  return 'Sin fecha · asigna un día al editar';
}
function render() {
  const p = data.personal, t = p.totals;
  document.title = `${name} · Renta Repartida`;
  $('personal-title').textContent = `Calendario de ${name}.`;
  document.querySelector(`[data-personal-nav="${person}"]`).setAttribute('aria-current', 'page');
  $('personal-income-dot').className = `${person}-dot`;
  const months = data.availableMonths || [p.month];
  $('personal-month').innerHTML = months.map(month => `<option value="${month}">${monthName(month)}</option>`).join('');
  $('personal-month').value = p.month;
  $('personal-month-prev').disabled = p.month === months[0];
  $('personal-month-next').disabled = p.month === months.at(-1);
  $('personal-income').textContent = cash(t.income);
  $('personal-expenses-total').textContent = cash(t.expenses);
  $('personal-expense-total').textContent = cash(p.expenses.reduce((sum, expense) => sum + expense.amount, 0));
  debts.render(p.debts);
  $('personal-household-total').textContent = cash(t.household);
  $('personal-remaining').textContent = cash(t.remaining);
  $('personal-remaining').classList.toggle('danger', t.remaining < 0);
  $('personal-income-caption').textContent = `${p.incomePaydays.length} ${p.incomePaydays.length === 1 ? 'cobro estimado' : 'cobros estimados'} · ${monthName(p.month)}`;
  $('personal-expenses-caption').textContent = `${cash(t.paid)} pagado · ${cash(t.pending)} pendiente`;
  $('personal-household-caption').textContent = `${cash(p.household.saved)} apartado · ${cash(p.household.pending)} pendiente`;
  $('personal-household-saved').textContent = cash(p.household.saved);
  $('personal-household-pending').textContent = cash(p.household.pending);
  $('personal-save-status').textContent = data.storage === 'cloud' ? 'Datos compartidos guardados' : 'Datos guardados en esta computadora';
  $('personal-logout-form').hidden = data.storage !== 'cloud';
  $('personal-warning').textContent = data.warning || '';
  $('personal-warning').hidden = !data.warning;
  const overdue = p.payments.filter(payment => payment.overdue).length;
  const alerts = [];
  if (t.remaining < 0) alerts.push(`Los gastos y aportaciones superan tus ingresos por ${cash(-t.remaining)}. Revisa tus importes y fechas.`);
  if (overdue) alerts.push(`${overdue} ${overdue === 1 ? 'pago personal está vencido' : 'pagos personales están vencidos'}. Registra lo que pagaste para actualizar tu calendario.`);
  $('personal-funding-alert').textContent = alerts.join(' ');
  $('personal-funding-alert').hidden = !alerts.length;
  $('personal-expenses').innerHTML = p.expenses.map(expense => `<div class="expense-row personal-expense-row"><span class="expense-icon" aria-hidden="true">◷</span><span class="expense-name">${escape(expense.name)}${expense.temporary ? '<small class="temporary-label">Solo este mes</small>' : ''}</span><strong>${cash(expense.amount)}</strong><button class="edit-button" data-personal-expense="${escape(expense.id)}" aria-label="Editar ${escape(expense.name)}">✎</button><span class="payment-note">${escape(scheduleText(expense))}${expense.amount !== expense.plannedAmount ? ` · presupuesto ${cash(expense.plannedAmount)}` : ''}</span></div>`).join('') || '<p class="empty-note">Agrega tu primer gasto personal.</p>';
  renderCalendar();
  const agenda = [
    ...p.incomePaydays.map(payday => ({ type: 'income', date: payday.date, row: payday })),
    ...p.household.contributions.map(contribution => ({ type: 'household', date: contribution.date, row: contribution })),
    ...p.payments.filter(payment => paymentCalendarDate(payment)).map(payment => ({ type: 'payment', date: paymentCalendarDate(payment), row: payment })),
    ...debts.agendaEvents().filter(event => event.date)
  ].sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));
  $('personal-agenda-count').textContent = `${agenda.length} movimientos`;
  $('personal-agenda').innerHTML = agenda.map(event => agendaRow(event)).join('') || '<p class="empty-note">No hay movimientos programados este mes.</p>';
  const unscheduled = [
    ...p.payments.filter(payment => !paymentCalendarDate(payment)).map(row => ({ type: 'payment', row })),
    ...debts.agendaEvents().filter(event => !event.date)
  ];
  $('personal-unscheduled-count').textContent = `${unscheduled.length} ${unscheduled.length === 1 ? 'pago' : 'pagos'}`;
  $('personal-unscheduled').innerHTML = unscheduled.map(agendaRow).join('') || '<p class="empty-note">Todos tus pagos tienen fecha.</p>';
}
function agendaRow({ type, date, row }) {
  if (type.startsWith('debt')) return debts.agendaRow({ type, date, row, debtId: row.debtId || row.id });
  const dateText = date ? ` · ${shortDate(date)}` : '';
  if (type === 'income') return `<a class="payday-row personal-agenda-income" href="${householdHref(row.cycleMonth)}"><span class="avatar ${person}">${name[0]}</span><span class="payday-detail"><strong>Tu cobro${dateText}</strong><small>Ingreso estimado · ${data.availableMonths.includes(row.cycleMonth) ? 'editar en Hogar' : 'estimación del próximo ciclo'}</small></span><span class="payday-amount">${cash(row.income)}<small>ingreso</small></span></a>`;
  if (type === 'household') return `<a class="payday-row" href="${householdHref(row.cycleMonth)}"><span class="expense-icon household-icon" aria-hidden="true">⌂</span><span class="payday-detail"><strong>Aportación al hogar${dateText}</strong><small>Vencimiento ${shortDate(`${row.cycleMonth}-15`)} · ${data.availableMonths.includes(row.cycleMonth) ? 'ver en Hogar' : 'estimación del próximo ciclo'}</small></span><span class="payday-state ${row.closed ? 'closed' : ''}">${row.closed ? '✓ Apartado' : 'Sugerido'}</span><span class="payday-amount">${cash(row.amount)}<small>${row.closed ? 'aportación real' : 'por apartar'}</small></span></a>`;
  return `<button class="payday-row expense-payment-row" data-personal-payment="${escape(row.id)}"><span class="expense-icon" aria-hidden="true">◷</span><span class="payday-detail"><strong>${escape(row.name)}${dateText}</strong><small>${row.paid ? `Pagado el ${shortDate(row.paidDate)} · presupuesto ${cash(row.plannedAmount)}` : date ? `Presupuesto ${cash(row.plannedAmount)}` : 'Puedes registrar el pago o asignar su fecha en Editar gasto'}</small></span><span class="payday-state ${row.paid ? 'closed' : row.overdue ? 'overdue' : ''}">${row.paid ? '✓ Pagado' : row.overdue ? 'Vencido' : 'Por pagar'}</span><span class="payday-amount">${cash(row.amount)}<small>${row.paid ? 'pago real' : 'estimado'}</small></span></button>`;
}
function renderCalendar() {
  const p = data.personal;
  $('personal-calendar-month').textContent = monthName(p.month);
  const first = new Date(`${p.month}-01T12:00:00Z`);
  const offset = (first.getUTCDay() + 6) % 7;
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const cells = Math.ceil((offset + last) / 7) * 7;
  first.setUTCDate(1 - offset);
  const html = [];
  for (let i = 0; i < cells; i++) {
    const date = first.toISOString().slice(0, 10), outside = date.slice(0, 7) !== p.month;
    const income = p.incomePaydays.filter(payday => payday.date === date && !outside);
    const household = p.household.contributions.filter(row => row.date === date && !outside);
    const payments = p.payments.filter(payment => paymentCalendarDate(payment) === date && !outside);
    html.push(`<div class="day ${outside ? 'outside' : ''} ${date === p.today ? 'today' : ''}"><span class="day-number">${first.getUTCDate()}</span>${income.map(payday => `<a class="event ${person} personal-income-event" href="${householdHref(payday.cycleMonth)}" aria-label="${escape(longDate(date))}, ingreso estimado ${cash(payday.income)}; ver en Hogar"><span class="event-name">Tu cobro<span>↗</span></span><span class="event-amount">${cash(payday.income)}</span><span class="event-status">Ingreso estimado</span></a>`).join('')}${household.map(row => `<a class="event household-event ${row.closed ? 'closed' : ''}" href="${householdHref(row.cycleMonth)}" aria-label="${escape(longDate(date))}, aportación al hogar ${cash(row.amount)} ${row.closed ? 'apartado' : 'sugerido'}; ver en Hogar"><span class="event-name">Al hogar<span>${row.closed ? '✓' : '⌂'}</span></span><span class="event-amount">${cash(row.amount)}</span><span class="event-status">${row.closed ? 'Ya apartado' : data.availableMonths.includes(row.cycleMonth) ? 'Por apartar' : 'Próximo ciclo'}</span></a>`).join('')}${payments.map(payment => `<button class="event expense-event ${payment.paid ? 'closed' : ''}" data-personal-payment="${escape(payment.id)}" aria-label="${escape(longDate(date))}, ${escape(payment.name)}, ${cash(payment.amount)} ${payment.paid ? `pagado el ${shortDate(payment.paidDate)}` : 'por pagar'}"><span class="event-name">${escape(payment.name)}<span>${payment.paid ? '✓' : '◷'}</span></span><span class="event-amount">${cash(payment.amount)}</span><span class="event-status ${payment.overdue ? 'overdue' : ''}">${payment.paid ? `Pagado ${shortDate(payment.paidDate)}` : payment.overdue ? 'Vencido' : 'Por pagar'}</span></button>`).join('')}</div>`);
    html[html.length - 1] = html.at(-1).replace(/<\/div>$/, `${outside ? '' : debts.calendarEvents(date)}</div>`);
    first.setUTCDate(first.getUTCDate() + 1);
  }
  $('personal-calendar').innerHTML = html.join('');
}
function moneyField(id, label, value = '') {
  return `<label class="field" for="${id}"><span>${label}</span><input id="${id}" type="number" inputmode="decimal" min="0" max="100000000" step="0.01" value="${value}" required></label>`;
}
function scopeField() {
  return '<label class="field" for="personal-expense-scope"><span>¿Cuándo aplica este cambio?</span><select id="personal-expense-scope" required><option value="">Elige una opción…</option><option value="cycle">Solo este mes</option><option value="future">Este y los siguientes</option></select><small>Los pagos registrados conservan su importe. Los ajustes puntuales de otros meses siguen vigentes.</small></label>';
}
function openModal(config) {
  returnFocus = document.activeElement;
  modal = { ...config, month: data.personal.month, revision: data.revision };
  $('personal-editor-title').textContent = config.title;
  $('personal-editor-eyebrow').textContent = config.eyebrow || monthName(modal.month);
  $('personal-editor-body').innerHTML = config.body;
  $('personal-form-error').hidden = true;
  $('personal-delete-expense').hidden = !config.expenseId || config.type === 'delete-personal-expense';
  $('personal-submit-editor').hidden = Boolean(config.readOnly);
  $('personal-submit-editor').textContent = config.submit || 'Guardar cambios';
  $('personal-editor').showModal();
  const focus = $('personal-editor-body').querySelector('input:not([readonly]),select,button');
  if (focus) focus.focus();
}
function closeModal() { if (!busy) $('personal-editor').close(); }
function editExpense(id) {
  const expense = data.personal.expenses.find(row => row.id === id);
  if (id && !expense) return;
  const schedule = expense?.schedule || 'monthly';
  openModal({ type: 'save-personal-expense', expenseId: id, title: expense ? 'Editar gasto personal' : 'Agregar gasto personal', body: `<label class="field" for="personal-expense-name"><span>Concepto</span><input id="personal-expense-name" type="text" maxlength="70" value="${escape(expense?.name || '')}" required></label>${moneyField('personal-expense-amount', 'Presupuesto mensual (MXN)', expense ? (expense.plannedAmount / 100).toFixed(2) : '')}<label class="field" for="personal-expense-schedule"><span>¿Cómo se paga?</span><select id="personal-expense-schedule"><option value="monthly" ${schedule === 'monthly' ? 'selected' : ''}>Una vez al mes</option><option value="quincenal" ${schedule === 'quincenal' ? 'selected' : ''}>Dividido entre las dos quincenas</option><option value="weekly" ${schedule === 'weekly' ? 'selected' : ''}>Dividido entre las semanas</option><option value="unscheduled" ${schedule === 'unscheduled' ? 'selected' : ''}>Sin fecha</option></select><small id="personal-schedule-help"></small></label><label id="personal-day-field" class="field" for="personal-expense-day"><span>Día de corte / pago</span><input id="personal-expense-day" type="number" min="1" max="31" step="1" value="${expense?.day || 1}"><small>Si ese día no existe, se usa el último del mes.</small></label><label id="personal-weekday-field" class="field" for="personal-expense-weekday"><span>Día de la semana</span><select id="personal-expense-weekday">${weekdays.map((day, index) => `<option value="${index}" ${index === (expense?.weekday ?? 0) ? 'selected' : ''}>${day[0].toUpperCase()}${day.slice(1)}</option>`).join('')}</select></label>${expense?.paidAmount ? `<p class="form-help">Ya registraste ${cash(expense.paidAmount)}. El resto del presupuesto se divide entre los pagos pendientes; los pagos cerrados se conservan.</p>` : ''}${scopeField()}` });
  $('personal-expense-schedule').addEventListener('change', updateScheduleFields);
  updateScheduleFields();
}
function updateScheduleFields() {
  const schedule = $('personal-expense-schedule').value;
  $('personal-day-field').hidden = schedule !== 'monthly';
  $('personal-expense-day').required = schedule === 'monthly';
  $('personal-expense-day').disabled = schedule !== 'monthly';
  $('personal-weekday-field').hidden = schedule !== 'weekly';
  $('personal-expense-weekday').disabled = schedule !== 'weekly';
  $('personal-schedule-help').textContent = { monthly: 'Se programa un pago con el presupuesto mensual.', quincenal: 'Se reparte entre los días 15 y 30; en febrero se usa el último día.', weekly: 'Se reparte entre todos los días de la semana elegidos, incluidos los cinco cuando corresponda.', unscheduled: 'Queda en Pagos sin fecha. Puedes registrar el pago cuando ocurra.' }[schedule];
}
function editPayment(id) {
  const payment = data.personal.payments.find(row => row.id === id);
  if (!payment) return;
  if (payment.paid) {
    openModal({ type: 'view-personal-payment', id, readOnly: true, title: 'Pago registrado', eyebrow: payment.name, body: `<div class="modal-info closed-info">Pagaste realmente<strong>${cash(payment.amount)}</strong>El ${shortDate(payment.paidDate)}. Este importe se conserva al cambiar el presupuesto.</div><p class="form-help">Presupuesto original de este pago: ${cash(payment.plannedAmount)}${payment.dueDate ? `<br>Fecha de corte: ${shortDate(payment.dueDate)}` : ''}</p><div class="payday-actions"><button type="button" id="personal-start-reopen" class="button secondary">Reabrir para corregir…</button></div>` });
    $('personal-start-reopen').addEventListener('click', () => {
      $('personal-editor').close();
      openModal({ type: 'reopen-personal-payment', id, title: 'Reabrir pago personal', eyebrow: payment.name, submit: 'Confirmar reapertura', body: `<div class="modal-info">El pago de <strong>${cash(payment.amount)}</strong>dejará de contar como pagado. Podrás corregir el importe y registrar de nuevo su fecha.</div><p class="form-help">Los demás pagos registrados se conservarán. Se recalculará lo que queda pendiente de este gasto.</p>` });
    });
    return;
  }
  const p = data.personal;
  openModal({ type: 'record-personal-payment', id, title: 'Registrar pago personal', eyebrow: payment.name, submit: 'Registrar y cerrar', body: `<div class="modal-info">Importe pendiente de este pago<strong>${cash(payment.amount)}</strong>${payment.dueDate ? `Fecha de corte: ${shortDate(payment.dueDate)}` : 'Este gasto todavía no tiene fecha de corte.'}</div>${moneyField('personal-payment-amount', '¿Cuánto pagaste realmente? (MXN)', (payment.amount / 100).toFixed(2))}<label class="field date-field" for="personal-payment-date"><span>Fecha en la que pagaste</span><input id="personal-payment-date" type="date" value="${p.today}" required><small>El gasto sigue contando en ${monthName(p.month)}, aunque lo pagues antes o después.</small></label><p class="form-help">Puedes registrar $0. El pago real reemplaza el estimado de esta cuota y se conserva al cambiar el presupuesto.</p>` });
}
function parseMoney(id) {
  const value = $(id).value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error('Escribe un importe positivo o $0, con hasta dos decimales.');
  const [whole, fraction = ''] = value.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount > 100_000_000_00) throw new Error('El importe es demasiado grande.');
  return amount;
}
function showFormError(message, status) {
  $('personal-form-error').replaceChildren(document.createTextNode(message));
  $('personal-form-error').hidden = false;
  if (status === 409) {
    const refresh = document.createElement('button');
    refresh.type = 'button'; refresh.className = 'text-button'; refresh.textContent = 'Actualizar sin perder lo escrito';
    refresh.addEventListener('click', async () => {
      if (busy) return;
      setBusy(true);
      try {
        const result = await api(personalUrl(modal.month));
        ++requestNumber; data = result; modal.revision = result.revision; render();
        showFormError('Datos actualizados. El formulario conserva lo escrito: revisa los importes y guarda otra vez.');
      } catch (error) { showFormError(error.message, error.status); }
      finally { setBusy(false); }
    });
    $('personal-form-error').append(document.createElement('br'), refresh);
  }
}
function setBusy(value) {
  busy = value;
  $('personal-editor-form').querySelectorAll('button, input, select').forEach(element => { element.disabled = value; });
  if (!value && modal.type === 'save-personal-expense') updateScheduleFields();
}
async function save(action) {
  if (busy) return;
  setBusy(true); $('personal-form-error').hidden = true;
  try {
    const result = await api('/api/personal/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: modal.revision, action: { ...action, person, month: modal.month } }) });
    ++requestNumber; data = result; render(); $('personal-editor').close();
    $('personal-save-status').textContent = 'Todos los cambios guardados';
    toast(action.type === 'record-personal-payment' ? 'Pago guardado. Tu calendario ya se actualizó.' : action.type === 'reopen-personal-payment' ? 'Pago reabierto. Ahora puedes corregirlo.' : 'Cambio guardado. Tu plan ya está actualizado.');
  } catch (error) { showFormError(error.message, error.status); }
  finally { setBusy(false); }
}
function toast(message) {
  clearTimeout(toastTimer); $('personal-toast').textContent = message; $('personal-toast').hidden = false;
  toastTimer = setTimeout(() => { $('personal-toast').hidden = true; }, 4500);
}
$('personal-editor-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy || modal.readOnly) return;
  try {
    let action;
    if (modal.type === 'save-personal-expense') {
      const schedule = $('personal-expense-schedule').value;
      action = { type: modal.type, id: modal.expenseId, name: $('personal-expense-name').value, amount: parseMoney('personal-expense-amount'), schedule, day: schedule === 'monthly' ? Number($('personal-expense-day').value) : null, weekday: schedule === 'weekly' ? Number($('personal-expense-weekday').value) : 0, scope: $('personal-expense-scope').value };
    } else if (modal.type === 'delete-personal-expense') action = { type: modal.type, id: modal.expenseId, scope: $('personal-expense-scope').value };
    else if (modal.type === 'record-personal-payment') action = { type: modal.type, id: modal.id, amount: parseMoney('personal-payment-amount'), paidDate: $('personal-payment-date').value };
    else if (modal.type === 'reopen-personal-payment') action = { type: modal.type, id: modal.id };
    if (action) void save(action);
  } catch (error) { showFormError(error.message); }
});
$('personal-delete-expense').addEventListener('click', () => {
  if (busy) return;
  const expense = data.personal.expenses.find(row => row.id === modal.expenseId);
  $('personal-editor').close();
  openModal({ type: 'delete-personal-expense', expenseId: expense.id, title: 'Quitar gasto personal', submit: 'Confirmar y quitar', body: `<p class="form-help">Se quitará <strong>${escape(expense.name)}</strong> de los meses que elijas. Sus pagos ya registrados se conservarán.</p>${scopeField()}` });
});
for (const id of ['personal-close-editor', 'personal-cancel-editor']) $(id).addEventListener('click', closeModal);
$('personal-editor').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('personal-editor').addEventListener('close', () => { if (returnFocus?.isConnected) returnFocus.focus(); });
document.addEventListener('click', event => {
  const expense = event.target.closest('[data-personal-expense]'), payment = event.target.closest('[data-personal-payment]');
  if (expense) editExpense(expense.dataset.personalExpense);
  if (payment) editPayment(payment.dataset.personalPayment);
});
$('personal-add-expense').addEventListener('click', () => editExpense());
$('personal-month').addEventListener('change', () => void load($('personal-month').value));
for (const [id, direction] of [['personal-month-prev', -1], ['personal-month-next', 1]]) $(id).addEventListener('click', () => {
  if (!data || $(id).disabled) return;
  const month = data.availableMonths[data.availableMonths.indexOf(data.personal.month) + direction];
  if (month) void load(month);
});
$('personal-refresh').addEventListener('click', () => void load(data.personal.month));
$('personal-retry').addEventListener('click', () => void load(data?.personal.month));
void load(new URLSearchParams(location.search).get('month') || undefined);
