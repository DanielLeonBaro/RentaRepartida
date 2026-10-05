const $ = id => document.getElementById(id);
const names = { hogar: 'Hogar', sofia: 'Sofía', daniel: 'Daniel' };
const currency = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
const cash = cents => currency.format(cents / 100);
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const dateText = iso => new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
const monthText = month => new Intl.DateTimeFormat('es-MX', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T12:00:00Z`));

export function createDebtManager({ getData, onSaved, toast }) {
  let view, modal, busy = false, returnFocus;
  const dialog = document.createElement('dialog');
  dialog.id = 'debt-editor';
  dialog.setAttribute('aria-labelledby', 'debt-title');
  dialog.innerHTML = '<form id="debt-form"><div class="modal-header"><div><div id="debt-eyebrow" class="eyebrow"></div><h2 id="debt-title"></h2></div><button type="button" id="debt-close" class="icon-button" aria-label="Cerrar ventana">×</button></div><div id="debt-body"></div><div id="debt-error" class="notice error" role="alert" hidden></div><div class="modal-actions"><button type="button" id="debt-delete" class="text-button danger" hidden>Eliminar deuda</button><button type="button" id="debt-delete-payment" class="text-button danger" hidden>Anular abono</button><button type="button" id="debt-cancel" class="button secondary">Cancelar</button><button type="submit" id="debt-submit" class="button primary">Guardar cambios</button></div></form>';
  document.body.append(dialog);
  const current = () => getData().cycle || getData().personal;
  const findDebt = id => view.debts.find(debt => debt.id === id);
  const moneyField = (id, label, amount, help = '', min = '0') => `<label class="field" for="${id}"><span>${label}</span><input id="${id}" type="number" inputmode="decimal" min="${min}" max="100000000" step="0.01" value="${(amount / 100).toFixed(2)}" required>${help ? `<small>${help}</small>` : ''}</label>`;

  function render(nextView) {
    view = nextView || { owner: getData().cycle ? 'hogar' : getData().personal.person, month: current().month, today: current().today, debts: [], payments: [], totals: { balance: 0, paid: 0, pending: 0, budget: 0 } };
    const active = view.debts.filter(debt => debt.active && debt.owned !== false);
    const archived = view.debts.filter(debt => !debt.active || debt.owned === false);
    $('debts-panel').innerHTML = `<div class="panel-heading"><div><div class="eyebrow">A TU RITMO, ABONO A ABONO</div><h2>Deudas ${view.owner === 'hogar' ? 'del hogar' : `de ${names[view.owner]}`}</h2></div><button id="debt-add" class="add-button" aria-label="Agregar deuda">+</button></div><div class="debt-summary"><div><span>Saldo actual</span><strong id="debt-total-balance">${cash(view.totals.balance)}</strong></div><div><span>Abonado este mes</span><strong id="debt-total-paid">${cash(view.totals.paid)}</strong></div></div><div id="debt-list" class="debt-list">${active.map(debtRow).join('') || '<p class="empty-note">Sin deudas activas. Puedes agregar una cuando la necesites.</p>'}</div><div class="expense-total"><span>Abonos pendientes del mes</span><strong id="debt-total-pending">${cash(view.totals.pending)}</strong></div><div class="expense-total debt-budget-total"><span>En el presupuesto del mes</span><strong id="debt-total-budget">${cash(view.totals.budget)}</strong></div><p class="panel-note">Solo los abonos realizados y previstos para ${escape(monthText(view.month))} cuentan en el presupuesto. El saldo completo no se carga como gasto mensual; la previsión empieza en $0.</p>${archived.length ? `<details class="debt-archive"><summary>Deudas archivadas o reasignadas (${archived.length})</summary><div>${archived.map(debtRow).join('')}</div></details>` : ''}`;
  }
  function debtRow(debt) {
    const foreign = debt.owned === false;
    return `<article class="debt-row ${!debt.active || foreign ? 'debt-inactive' : ''}"><div class="debt-row-heading"><span class="expense-icon debt-icon" aria-hidden="true">↘</span><div class="debt-info"><strong>${escape(debt.name)}</strong><small>${foreign ? `Ahora pertenece a ${names[debt.owner]}` : !debt.active ? 'Archivada' : debt.startMonth > view.month ? `Disponible desde ${escape(monthText(debt.startMonth))}` : debt.balance === 0 ? '✓ Liquidada' : debt.dueDay ? `Pago el día ${debt.dueDay} de cada mes` : 'Sin fecha de pago'}</small></div><strong class="debt-balance">${cash(debt.balance)}</strong>${!foreign ? `<button type="button" class="edit-button" data-debt-edit="${escape(debt.id)}" aria-label="Editar deuda ${escape(debt.name)}">✎</button>` : ''}</div><div class="debt-meta"><span>Previsto: ${cash(debt.monthlyPayment)}</span><span>Abonado: ${cash(debt.monthPaid)}</span>${debt.monthPending ? `<span class="${debt.overdue ? 'overdue' : ''}">Pendiente: ${cash(debt.monthPending)}${debt.overdue ? ' · vencido' : ''}</span>` : ''}</div><div class="debt-actions">${debt.active && !foreign && debt.startMonth <= view.month && debt.balance > 0 ? `<button type="button" class="button secondary" data-debt-pay="${escape(debt.id)}">Registrar abono</button>` : ''}<button type="button" class="text-button" data-debt-history="${escape(debt.id)}">Historial (${debt.payments.length})</button></div></article>`;
  }
  function open(config) {
    if (!dialog.open) returnFocus = document.activeElement;
    modal = { ...config, month: view.month, viewOwner: view.owner, revision: getData().revision };
    $('debt-title').textContent = config.title;
    $('debt-eyebrow').textContent = config.eyebrow || `${names[view.owner]} · ${monthText(view.month)}`;
    $('debt-body').innerHTML = config.body;
    $('debt-error').hidden = true;
    $('debt-delete').hidden = config.type !== 'save-debt' || !config.debt?.active;
    $('debt-delete-payment').hidden = config.type !== 'record-debt-payment' || !config.payment;
    $('debt-submit').hidden = Boolean(config.readOnly);
    $('debt-submit').textContent = config.submit || 'Guardar cambios';
    $('debt-cancel').textContent = config.readOnly ? 'Listo' : 'Cancelar';
    if (!dialog.open) dialog.showModal();
    const focus = $('debt-body').querySelector('input,select,button');
    if (focus) focus.focus();
  }
  function editDebt(id) {
    const debt = id ? findDebt(id) : null;
    if (id && (!debt || debt.owned === false)) return;
    const owner = debt?.owner || view.owner;
    open({ type: 'save-debt', debt, title: debt ? 'Editar deuda' : 'Agregar deuda', body: `<label class="field" for="debt-name"><span>Nombre de la deuda</span><input id="debt-name" type="text" maxlength="70" value="${escape(debt?.name || '')}" placeholder="Por ejemplo, tarjeta" required></label><label class="field" for="debt-owner"><span>¿De quién es?</span><select id="debt-owner">${Object.entries(names).map(([value, label]) => `<option value="${value}" ${value === owner ? 'selected' : ''}>${label}</option>`).join('')}</select><small>Los abonos ya registrados conservan la persona o el hogar que los pagó.</small></label>${moneyField('debt-balance', 'Saldo pendiente actual (MXN)', debt?.balance || 0, 'Puedes ajustar el saldo por intereses, cargos o una corrección. El historial de abonos se conserva.')}<label class="field" for="debt-due-day"><span>Día de pago de cada mes</span><input id="debt-due-day" type="number" min="1" max="31" step="1" value="${debt?.dueDay || ''}" placeholder="Sin fecha"><small>Déjalo vacío si no hay fecha. Si el día no existe en un mes, se usa su último día.</small></label>${moneyField('debt-monthly-payment', `Abono previsto para ${escape(monthText(view.month))} (MXN)`, debt?.monthlyPayment || 0, 'Opcional: deja $0 si no sabes cuánto aportarás. Solo aplica al mes seleccionado; los demás meses empiezan en $0. Puedes registrar abonos distintos cuando puedas.')}${debt && !debt.active ? '<p class="form-help">Al guardar, esta deuda volverá a estar activa con el saldo que indiques.</p>' : ''}` });
  }
  function editPayment(id, paymentId) {
    const debt = findDebt(id), payment = debt?.payments.find(row => row.id === paymentId);
    if (!debt || (paymentId && !payment) || (!payment && (!debt.active || debt.owned === false || debt.startMonth > view.month || !debt.balance))) return;
    const amount = payment?.amount ?? Math.min(debt.monthPending, debt.balance);
    open({ type: 'record-debt-payment', debt, payment, title: payment ? 'Corregir abono' : 'Registrar abono', eyebrow: debt.name, submit: payment ? 'Guardar corrección' : 'Registrar abono', body: `<div class="modal-info">Saldo pendiente actual<strong>${cash(debt.balance)}</strong>${payment ? `Este abono ya descuenta ${cash(payment.amount)} del saldo. Al corregirlo se ajustará la diferencia.` : 'Cada abono reduce el saldo; puedes pagar una parte cuando puedas.'}</div>${moneyField('debt-amount', 'Importe abonado (MXN)', amount, `Máximo ${cash(debt.balance + (payment?.amount || 0))}.`, '0.01')}<label class="field date-field" for="debt-paid-date"><span>Fecha del abono</span><input id="debt-paid-date" type="date" value="${payment?.paidDate || view.today}" required><small>${payment ? `Este abono conserva su presupuesto de ${escape(monthText(payment.month))}.` : `El abono contará en el presupuesto de ${escape(monthText(view.month))}.`}</small></label>` });
    $('debt-amount').max = ((debt.balance + (payment?.amount || 0)) / 100).toFixed(2);
  }
  function history(id) {
    const debt = findDebt(id);
    if (!debt) return;
    open({ readOnly: true, debt, title: 'Historial de abonos', eyebrow: debt.name, body: `<div class="modal-info">Saldo pendiente actual<strong>${cash(debt.balance)}</strong>Total abonado: ${cash(debt.totalPaid)}</div><div class="debt-history">${[...debt.payments].sort((a, b) => b.paidDate.localeCompare(a.paidDate) || b.paidAt.localeCompare(a.paidAt)).map(payment => `<button type="button" class="payday-row" data-debt-payment="${escape(payment.id)}" data-debt-id="${escape(debt.id)}"><span class="expense-icon debt-icon" aria-hidden="true">✓</span><span class="payday-detail"><strong>${dateText(payment.paidDate)}</strong><small>${names[payment.owner]} · ${escape(payment.name)}<br>Presupuesto de ${escape(monthText(payment.month))} · corregir o anular</small></span><span class="payday-amount">${cash(payment.amount)}<small>abono registrado</small></span></button>`).join('') || '<p class="empty-note">Aún no hay abonos registrados.</p>'}</div>` });
  }
  function plannedEvent(debt) {
    return { type: 'debt', date: debt.dueDate, row: debt, debtId: debt.id };
  }
  function paidEvent(payment) {
    const debt = findDebt(payment.debtId);
    const date = payment.paidDate.startsWith(`${view.month}-`) ? payment.paidDate : debt?.dueDate;
    return { type: 'debt-payment', date, row: payment, debtId: payment.debtId };
  }
  function agendaEvents() {
    return [...view.debts.filter(debt => debt.active && debt.owned !== false && debt.startMonth <= view.month && debt.balance > 0).map(plannedEvent), ...view.payments.map(paidEvent)];
  }
  function agendaRow(event) {
    const paid = event.type === 'debt-payment', row = event.row;
    const attrs = paid ? `data-debt-payment="${escape(row.id)}" data-debt-id="${escape(event.debtId)}"` : `data-debt-pay="${escape(row.id)}"`;
    return `<button type="button" class="payday-row debt-agenda-row" ${attrs}><span class="expense-icon debt-icon" aria-hidden="true">${paid ? '✓' : '↘'}</span><span class="payday-detail"><strong>${escape(row.name)}${event.date ? ` · ${dateText(event.date)}` : ''}</strong><small>${paid ? `Abono del ${dateText(row.paidDate)} · ${names[row.owner]}` : `Saldo ${cash(row.balance)} · ${row.dueDate ? 'fecha de pago' : 'sin fecha de pago'}`}</small></span><span class="payday-state ${paid ? 'closed' : row.overdue ? 'overdue' : ''}">${paid ? '✓ Abonado' : row.overdue ? 'Vencido' : row.monthPending ? 'Previsto' : 'Abono libre'}</span><span class="payday-amount">${paid ? cash(row.amount) : row.monthPending ? cash(row.monthPending) : 'A tu ritmo'}<small>${paid ? 'abono real' : 'por abonar'}</small></span></button>`;
  }
  function calendarEvents(date) {
    return agendaEvents().filter(event => event.date === date).map(event => {
      const paid = event.type === 'debt-payment', row = event.row;
      const attrs = paid ? `data-debt-payment="${escape(row.id)}" data-debt-id="${escape(event.debtId)}"` : `data-debt-pay="${escape(row.id)}"`;
      return `<button type="button" class="event debt-event ${paid ? 'closed' : ''}" ${attrs} aria-label="${escape(row.name)}, ${dateText(date)}, ${paid ? `abono ${cash(row.amount)}` : row.monthPending ? `por abonar ${cash(row.monthPending)}` : 'abono libre'}"><span class="event-name">${escape(row.name)}<span>${paid ? '✓' : '↘'}</span></span><span class="event-amount">${paid ? cash(row.amount) : row.monthPending ? cash(row.monthPending) : 'Abono libre'}</span><span class="event-status ${row.overdue ? 'overdue' : ''}">${paid ? `Abonado ${dateText(row.paidDate)}` : row.overdue ? 'Vencido' : 'Deuda · saldo pendiente'}</span></button>`;
    }).join('');
  }
  async function request(url, options) {
    let response;
    try { response = await fetch(url, options); } catch { throw new Error('No se pudo conectar. Tu formulario sigue aquí para volver a intentar.'); }
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.error || 'No se pudo guardar el cambio.'); error.status = response.status; throw error; }
    return result;
  }
  function setBusy(value) {
    busy = value;
    $('debt-form').querySelectorAll('input,select,button').forEach(element => { element.disabled = value; });
  }
  function errorMessage(message, status) {
    $('debt-error').replaceChildren(document.createTextNode(message));
    $('debt-error').hidden = false;
    if (status !== 409) return;
    const refresh = document.createElement('button');
    refresh.type = 'button'; refresh.className = 'text-button'; refresh.textContent = 'Actualizar sin perder lo escrito';
    refresh.addEventListener('click', async () => {
      if (busy) return;
      setBusy(true);
      try {
        const url = modal.viewOwner === 'hogar' ? `/api/cycle?month=${modal.month}` : `/api/personal?person=${modal.viewOwner}&month=${modal.month}`;
        const result = await request(url); modal.revision = result.revision; onSaved(result);
        errorMessage('Datos actualizados. Conservamos lo que escribiste: revisa el saldo y vuelve a guardar.');
      } catch (error) { errorMessage(error.message, error.status); }
      finally { setBusy(false); }
    });
    $('debt-error').append(document.createElement('br'), refresh);
  }
  function parseMoney(id) {
    const value = $(id).value.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error('Escribe un importe de $0 o más, con hasta dos decimales.');
    const [whole, fraction = ''] = value.split('.');
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(cents) || cents > 100_000_000_00) throw new Error('El importe es demasiado grande.');
    return cents;
  }
  async function save(action) {
    setBusy(true); $('debt-error').hidden = true;
    try {
      const paymentContext = modal.payment ? { owner: modal.payment.owner, month: modal.payment.month } : {};
      const result = await request('/api/debts/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: modal.revision, viewOwner: modal.viewOwner, viewMonth: modal.month, action: { owner: modal.debt?.owner || modal.viewOwner, month: modal.month, ...action, ...paymentContext } }) });
      onSaved(result); dialog.close();
      toast(action.type === 'record-debt-payment' ? 'Abono guardado. El saldo y tu presupuesto se actualizaron.' : action.type === 'delete-debt-payment' ? 'Abono anulado. El importe volvió al saldo pendiente.' : 'Deuda guardada. Tu plan se actualizó.');
    } catch (error) { errorMessage(error.message, error.status); }
    finally { setBusy(false); }
  }
  $('debt-form').addEventListener('submit', event => {
    event.preventDefault();
    if (busy || modal.readOnly) return;
    try {
      let action = { type: modal.type, id: modal.debt?.id };
      if (modal.type === 'save-debt') action = { ...action, owner: $('debt-owner').value, name: $('debt-name').value, balance: parseMoney('debt-balance'), dueDay: $('debt-due-day').value ? Number($('debt-due-day').value) : null, monthlyPayment: parseMoney('debt-monthly-payment') };
      if (modal.type === 'record-debt-payment') action = { ...action, paymentId: modal.payment?.id, amount: parseMoney('debt-amount'), paidDate: $('debt-paid-date').value };
      if (modal.type === 'delete-debt-payment') action.paymentId = modal.payment.id;
      void save(action);
    } catch (error) { errorMessage(error.message); }
  });
  $('debt-delete').addEventListener('click', () => {
    if (busy) return;
    const debt = modal.debt;
    open({ type: 'delete-debt', debt, title: 'Eliminar deuda', eyebrow: debt.name, submit: 'Confirmar y eliminar', body: `<p class="form-help">Se archivará <strong>${escape(debt.name)}</strong> y dejará de generar abonos previstos. Se conservarán su saldo y todos los abonos del historial.</p><p class="form-help">Las aportaciones ya cerradas y los demás abonos se conservarán. Podrás encontrar esta deuda en «Deudas archivadas o reasignadas».</p>` });
  });
  $('debt-delete-payment').addEventListener('click', () => {
    if (busy) return;
    const { debt, payment } = modal;
    open({ type: 'delete-debt-payment', debt, payment, title: 'Anular abono', eyebrow: debt.name, submit: 'Confirmar anulación', body: `<div class="modal-info">El abono de <strong>${cash(payment.amount)}</strong>del ${dateText(payment.paidDate)} dejará de contar como pagado y volverá al saldo de esta deuda.</div><p class="form-help">Los demás abonos se conservarán.</p>` });
  });
  for (const id of ['debt-close', 'debt-cancel']) $(id).addEventListener('click', () => { if (!busy) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { if (returnFocus?.isConnected) returnFocus.focus(); else $('debt-add')?.focus(); });
  document.addEventListener('click', event => {
    if (busy || !view) return;
    const add = event.target.closest('#debt-add'), edit = event.target.closest('[data-debt-edit]'), pay = event.target.closest('[data-debt-pay]'), payment = event.target.closest('[data-debt-payment]'), past = event.target.closest('[data-debt-history]');
    if (add) editDebt();
    if (edit) editDebt(edit.dataset.debtEdit);
    if (pay) editPayment(pay.dataset.debtPay);
    if (payment) editPayment(payment.dataset.debtId, payment.dataset.debtPayment);
    if (past) history(past.dataset.debtHistory);
  });
  return { render, calendarEvents, agendaEvents, agendaRow };
}
