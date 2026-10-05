const $ = id => document.getElementById(id);
const currency = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2 });
const cash = cents => currency.format(cents / 100);
const names = { sofia: 'Sofía', daniel: 'Daniel' };
const dateFormat = (iso, options) => new Intl.DateTimeFormat('es-MX', { ...options, timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
const shortDate = iso => dateFormat(iso, { day: 'numeric', month: 'short' });
const longDate = iso => dateFormat(iso, { weekday: 'long', day: 'numeric', month: 'long' });
const monthName = month => dateFormat(`${month}-01`, { month: 'long', year: 'numeric' });
const shiftMonth = (month, offset) => { const [y, m] = month.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + offset, 1)).toISOString().slice(0, 7); };
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const percentage = value => new Intl.NumberFormat('es-MX', { style: 'percent', maximumFractionDigits: 2 }).format(value);
let data, calendarMonth, modal, busy = false, requestNumber = 0, toastTimer;
const icons = { renta: '⌂', despensa: '▤', luz: 'ϟ', agua: '◉', internet: '⌁', ahorro: '↗' };

async function api(url, options) {
  let response;
  try { response = await fetch(url, options); } catch { throw new Error('No se pudo conectar. Revisa tu conexión y vuelve a intentarlo.'); }
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || 'No se pudo completar la operación.'); error.status = response.status; throw error; }
  return result;
}
async function load(month, { retainCalendar = false } = {}) {
  const number = ++requestNumber;
  $('loading').hidden = Boolean(data);
  $('load-error').hidden = true;
  try {
    const result = await api(`/api/cycle${month ? `?month=${encodeURIComponent(month)}` : ''}`);
    if (number !== requestNumber) return;
    data = result;
    if (!retainCalendar || ![result.cycle.month, shiftMonth(result.cycle.month, -1)].includes(calendarMonth)) calendarMonth = result.cycle.month;
    render();
    $('workspace').hidden = false;
  } catch (error) {
    if (number !== requestNumber) return;
    $('load-error-text').textContent = error.message;
    $('load-error').hidden = false;
    if (data) $('cycle-month').value = data.cycle.month;
  } finally { if (number === requestNumber) $('loading').hidden = true; }
}
function render() {
  const cycle = data.cycle, t = cycle.totals;
  $('save-status').textContent = data.storage === 'cloud' ? 'Datos compartidos guardados' : 'Datos guardados en esta computadora';
  $('logout-form').hidden = data.storage !== 'cloud';
  $('download-backup').href = `/api/backup?month=${cycle.month}`;
  const months = data.availableMonths || [cycle.month];
  $('cycle-month').innerHTML = months.map(month => `<option value="${month}">${monthName(month)}</option>`).join('');
  $('cycle-month').value = cycle.month;
  $('cycle-prev').disabled = cycle.month === months[0];
  $('cycle-next').disabled = cycle.month === months.at(-1);
  $('total').textContent = cash(t.total);
  $('saved').textContent = cash(t.saved);
  $('pending').textContent = cash(t.pending);
  $('expense-total').textContent = cash(t.total);
  $('cycle-range').textContent = `${shortDate(cycle.start)} — ${shortDate(cycle.deadline)}`;
  $('saved-caption').textContent = `${percentage(t.total ? t.saved / t.total : 0)} de su meta · ${cycle.paydays.filter(p => p.closed).length} cobros cerrados`;
  $('progress').style.width = `${t.total ? Math.min(100, t.saved / t.total * 100) : 0}%`;
  $('pending-caption').textContent = t.pending ? `Entre ${cycle.paydays.filter(p => !p.closed).length} cobros pendientes` : 'Su meta está cubierta ✓';
  $('deadline').textContent = dateFormat(cycle.deadline, { day: 'numeric', month: 'long' });
  const daysLeft = Math.round((Date.parse(`${cycle.deadline}T12:00:00Z`) - Date.parse(`${cycle.today}T12:00:00Z`)) / 86400000);
  $('deadline-caption').textContent = daysLeft > 0 ? `Faltan ${daysLeft} días para llegar juntos` : daysLeft === 0 ? 'Hoy es su fecha límite' : `El vencimiento pasó hace ${-daysLeft} días`;
  $('warning').hidden = !data.warning;
  $('warning').textContent = data.warning || '';
  const overdue = cycle.paydays.filter(p => p.overdue).length;
  const alerts = [];
  if (t.shortage) alerts.push(`El dinero disponible no alcanza: faltan ${cash(t.shortage)} incluso apartando todo lo pendiente.`);
  if (t.surplus) alerts.push(`Ya apartaron ${cash(t.surplus)} de más. Las aportaciones pendientes quedan en $0; el sobrante permanece en este ciclo.`);
  if (overdue) alerts.push(`${overdue} ${overdue === 1 ? 'cobro pasado sigue pendiente' : 'cobros pasados siguen pendientes'}. Registren lo apartado o ciérrenlos en $0 para actualizar el reparto.`);
  $('funding-alert').hidden = !alerts.length;
  $('funding-alert').textContent = alerts.join(' ');
  $('expenses').innerHTML = cycle.expenses.map(e => `<div class="expense-row"><span class="expense-icon" aria-hidden="true">${icons[e.id] || '·'}</span><span class="expense-name">${escape(e.name)}${e.temporary ? '<small class="temporary-label">Solo este ciclo</small>' : ''}</span><strong>${cash(e.amount)}</strong><button class="edit-button" data-expense="${escape(e.id)}" aria-label="Editar ${escape(e.name)}">✎</button><button class="payment-button" data-expense-payment="${escape(e.id)}" aria-label="${e.payment ? 'Corregir pago de' : 'Registrar pago de'} ${escape(e.name)}">${e.payment ? '✓' : 'Pagar'}</button><span class="payment-note">${e.payment ? `Pagado el ${shortDate(e.payment.paidDate)} · presupuesto ${cash(e.plannedAmount)}` : e.dueDate ? `Fecha de pago: ${shortDate(e.dueDate)}` : 'Sin fecha de pago'}</span></div>`).join('') || '<p class="empty-note">Sin gastos en este ciclo. Agrega el primero.</p>';
  $('person-summaries').innerHTML = Object.entries(names).map(([person, name]) => {
    const rows = cycle.paydays.filter(p => p.person === person);
    const paid = rows.reduce((sum, p) => sum + (p.closed ? p.paid : 0), 0);
    const pending = rows.reduce((sum, p) => sum + (p.closed ? 0 : p.suggested), 0);
    return `<div class="person-summary"><span class="avatar ${person}">${name[0]}</span><div class="person-info">${name}<small>${cash(paid)} ya apartado</small></div><div class="person-money">${cash(pending)}<small>por apartar</small></div></div>`;
  }).join('');
  $('split-explanation').textContent = t.capacity && t.pending ? `Cada cobro pendiente aparta aproximadamente el ${percentage(t.percent)} de su dinero disponible.` : t.pending ? 'No hay dinero disponible en los cobros pendientes. Ajusten su disponibilidad para cubrir el faltante.' : 'Ya cubrieron los gastos de este ciclo. Las aportaciones pendientes están en $0.';
  $('payday-count').textContent = `${cycle.paydays.length} cobros · 2 personas`;
  $('payday-list').innerHTML = cycle.paydays.map(p => `<button class="payday-row" data-payday="${escape(p.id)}" aria-label="${escape(longDate(p.date))}, ${names[p.person]}, ${p.closed ? 'aportación cerrada' : 'aportación sugerida'} ${cash(p.closed ? p.paid : p.suggested)}"><span class="avatar ${p.person}">${names[p.person][0]}</span><span class="payday-detail"><strong>${names[p.person]} · ${shortDate(p.date)}</strong><small>Cobro ${cash(p.income)} · disponible ${cash(p.available)}</small>${p.receipts?.length ? `<small>▧ ${p.receipts.length} ${p.receipts.length === 1 ? 'comprobante' : 'comprobantes'}</small>` : ''}</span><span class="payday-state ${p.closed ? 'closed' : p.overdue ? 'overdue' : ''}">${p.closed ? '✓ Cerrado' : p.overdue ? 'Vencido' : 'Pendiente'}</span><span class="payday-amount">${cash(p.closed ? p.paid : p.suggested)}<small>${p.closed ? 'apartado' : 'por apartar'}</small></span></button>`).join('');
  $('expense-payments').innerHTML = [...cycle.expenses].sort((a, b) => (a.payment?.paidDate || a.dueDate || '9999').localeCompare(b.payment?.paidDate || b.dueDate || '9999')).map(e => {
    const date = e.payment?.paidDate || e.dueDate;
    return `<button class="payday-row expense-payment-row" data-expense-payment="${escape(e.id)}"><span class="expense-icon" aria-hidden="true">${icons[e.id] || '·'}</span><span class="payday-detail"><strong>${escape(e.name)}${date ? ` · ${shortDate(date)}` : ''}</strong><small>${date ? `Presupuesto ${cash(e.plannedAmount)}` : 'Asigna su fecha en Editar gasto'}</small></span><span class="payday-state ${e.payment ? 'closed' : date && date < cycle.today ? 'overdue' : ''}">${e.payment ? '✓ Pagado' : date && date < cycle.today ? 'Vencido' : 'Por pagar'}</span><span class="payday-amount">${cash(e.amount)}<small>${e.payment ? 'pago real' : 'estimado'}</small></span></button>`;
  }).join('') || '<p class="empty-note">Agrega un gasto para programar su pago.</p>';
  renderCalendar();
}
function renderCalendar() {
  const cycle = data.cycle;
  $('calendar-month').textContent = monthName(calendarMonth);
  $('calendar-prev').disabled = calendarMonth === shiftMonth(cycle.month, -1);
  $('calendar-next').disabled = calendarMonth === cycle.month;
  const first = new Date(`${calendarMonth}-01T12:00:00Z`);
  const offset = (first.getUTCDay() + 6) % 7;
  const end = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const cells = Math.ceil((offset + end) / 7) * 7;
  first.setUTCDate(1 - offset);
  const html = [];
  for (let i = 0; i < cells; i++) {
    const date = first.toISOString().slice(0, 10);
    const outside = date.slice(0, 7) !== calendarMonth;
    const active = date >= cycle.start && date <= cycle.deadline;
    const rows = cycle.paydays.filter(p => p.date === date && !outside);
    const payments = cycle.expenses.filter(e => (e.payment?.paidDate || e.dueDate) === date && !outside);
    html.push(`<div class="day ${outside ? 'outside' : !active ? 'off-cycle' : ''} ${date === cycle.today ? 'today' : ''} ${date === cycle.deadline && !outside ? 'deadline' : ''}"><span class="day-number">${first.getUTCDate()}</span>${date === cycle.deadline && !outside ? '<span class="deadline-tag">DÍA DE RENTA</span>' : ''}${rows.map(p => `<button class="event ${p.person} ${p.closed ? 'closed' : ''}" data-payday="${escape(p.id)}" aria-label="${escape(longDate(date))}: ${names[p.person]}, ${cash(p.closed ? p.paid : p.suggested)} ${p.closed ? 'apartado' : 'por apartar'}"><span class="event-name">${names[p.person]}<span>${p.closed ? '✓' : '↗'}</span></span><span class="event-income">Cobro ${cash(p.income)}</span><span class="event-amount">${cash(p.closed ? p.paid : p.suggested)}</span><span class="event-status ${p.overdue ? 'overdue' : ''}">${p.closed ? 'Cerrado · apartado' : p.overdue ? 'Vencido · por apartar' : 'Por apartar'}</span></button>`).join('')}${payments.map(e => `<button class="event expense-event" data-expense-payment="${escape(e.id)}" aria-label="${escape(e.name)}, ${shortDate(date)}, ${cash(e.amount)} ${e.payment ? 'pagado' : 'por pagar'}"><span class="event-name">${escape(e.name)}<span>${e.payment ? '✓' : '◷'}</span></span><span class="event-amount">${cash(e.amount)}</span><span class="event-status">${e.payment ? 'Pagado' : 'Por pagar'}</span></button>`).join('')}</div>`);
    first.setUTCDate(first.getUTCDate() + 1);
  }
  $('calendar').innerHTML = html.join('');
}
function field(id, name, value, { help = '', readonly = false, text = false, min = '0' } = {}) {
  return `<label class="field" for="${id}"><span>${name}</span><input id="${id}" name="${id}" ${text ? 'type="text" maxlength="70"' : `type="number" inputmode="decimal" min="${min}" max="100000000" step="0.01"`} value="${escape(value)}" ${readonly ? 'readonly' : ''} required>${help ? `<small>${help}</small>` : ''}</label>`;
}
function scopeField() { return '<label class="field" for="expense-scope"><span>¿Cuándo aplica este cambio?</span><select id="expense-scope" required><option value="">Elige una opción…</option><option value="cycle">Solo este ciclo</option><option value="future">Este y los siguientes</option></select><small>Los cobros cerrados nunca cambian. Los ajustes puntuales de otros ciclos conservan su vigencia.</small></label>'; }
function openModal(config) {
  modal = { ...config, month: data.cycle.month, revision: data.revision };
  $('editor-title').textContent = config.title;
  $('editor-eyebrow').textContent = config.eyebrow;
  $('editor-body').innerHTML = config.body;
  $('form-error').hidden = true;
  $('delete-expense').hidden = !config.expenseId;
  $('submit-editor').hidden = config.readOnly || false;
  $('submit-editor').textContent = config.submit || 'Guardar cambios';
  $('cancel-editor').textContent = config.readOnly ? 'Listo' : 'Cancelar';
  $('editor').showModal();
}
function editPayday(id) {
  const p = data.cycle.paydays.find(p => p.id === id);
  if (!p) return;
  const eyebrow = `${names[p.person]} · ${longDate(p.date)}`;
  if (p.closed) {
    openModal({ id, title: 'Aportación cerrada', eyebrow, readOnly: true, body: `<div class="modal-info closed-info">Ya quedó apartado<strong>${cash(p.paid)}</strong>Este cobro se conserva aunque cambien los gastos.</div><p class="form-help">Ingreso: ${cash(p.income)}<br>Dinero disponible: ${cash(p.available)}<br>Sugerencia al cerrar: ${cash(p.suggestedAtClose)}<br>Registrado: ${escape(new Intl.DateTimeFormat('es-MX', { timeZone: 'America/Hermosillo', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(p.closedAt)))}</p><div class="payday-actions"><button type="button" id="start-reopen" class="button secondary">Reabrir para corregir…</button></div>${receiptSection(p)}` });
    bindReceiptUpload(id);
    $('start-reopen').addEventListener('click', () => {
      $('editor').close();
      openModal({ type: 'reopen-payday', id, title: 'Reabrir aportación', eyebrow, submit: 'Confirmar reapertura', body: `<div class="modal-info">La aportación de <strong>${cash(p.paid)}</strong>dejará de contar como apartada hasta que la corrijas y vuelvas a cerrarla. Los comprobantes se conservarán.</div><p class="form-help">Los otros cobros pendientes se recalcularán. Las demás aportaciones cerradas seguirán iguales.</p>` });
    });
    return;
  }
  openModal({ type: 'update-payday', id, title: 'Ajustar este cobro', eyebrow, body: `${p.previousPaid != null ? `<div class="reopened-note">Aportación reabierta. Antes registraste ${cash(p.previousPaid)}; ese importe no cuenta hasta que vuelvas a cerrar.</div>` : ''}<div class="modal-info">Aportación sugerida ahora<strong>${cash(p.suggested)}</strong>Se recalculará al cambiar el dinero disponible.</div>${field('payday-income', 'Ingreso estimado (MXN)', (p.income / 100).toFixed(2), { readonly: p.person === 'daniel', min: p.person === 'sofia' ? '1000' : '0', help: p.person === 'sofia' ? 'Incluye sueldo base y comisiones de este domingo.' : 'Tu ingreso fijo es de $24,000 por quincena.' })}${field('payday-available', 'Disponible para aportar (MXN)', (p.available / 100).toFixed(2), { help: 'Puede ser menor que tu ingreso, incluso $0. Este importe define tu parte del reparto.' })}<div class="payday-actions"><button type="button" id="start-close" class="button secondary">Registrar y cerrar…</button></div>${receiptSection(p)}` });
  bindReceiptUpload(id);
  $('payday-income').addEventListener('input', () => { $('payday-available').max = $('payday-income').value || '0'; });
  $('start-close').addEventListener('click', () => {
    if (busy) return;
    const dirty = Number($('payday-income').value) !== p.income / 100 || Number($('payday-available').value) !== p.available / 100;
    if (dirty) { showFormError('Guarda primero los cambios del cobro, o cancela y vuelve a abrirlo para registrar la aportación.'); return; }
    $('editor').close();
    const current = data.cycle.paydays.find(row => row.id === id);
    openModal({ type: 'close-payday', id, title: 'Registrar y cerrar', eyebrow, submit: 'Confirmar y cerrar', body: `${field('payday-paid', '¿Cuánto apartaste realmente? (MXN)', ((current.previousPaid ?? current.suggested) / 100).toFixed(2), { help: 'Puedes registrar $0 si no pudiste aportar. También puedes apartar más que la sugerencia.' })}<div class="modal-info">Al confirmar, este cobro quedará fijo. Si hay una equivocación podrás reabrirlo. El faltante se repartirá entre los otros cobros pendientes.</div>${receiptSection(current)}` });
    bindReceiptUpload(id);
  });
}
function receiptCards(p) {
  return (p.receipts || []).map(r => `<a class="receipt-card" href="/comprobantes/${data.cycle.month}/${r.id}" target="_blank" rel="noopener"><img src="/comprobantes/${data.cycle.month}/${r.id}" alt="Comprobante: ${escape(r.name)}"><span>${escape(r.name)}</span></a>`).join('') || '<p class="form-help">Todavía no hay comprobantes.</p>';
}
function receiptSection(p) {
  return `<section class="receipt-section"><h3>Comprobantes de esta aportación</h3><div id="receipt-list" class="receipt-list">${receiptCards(p)}</div><p class="form-help">Imagen de la captura o comprobante</p><div class="receipt-upload"><div class="file-picker"><input id="receipt-file" type="file" accept="image/png,image/jpeg,image/webp" class="visually-hidden"><label for="receipt-file" class="button secondary">Elegir imagen</label><span id="receipt-file-name" class="form-help">Sin imagen seleccionada</span></div><button type="button" id="upload-receipt" class="button secondary">Guardar imagen</button></div><p class="form-help">PNG, JPG o WebP · hasta 10 MB. ${data.storage === 'cloud' ? 'Se comprime a WebP de hasta 500 KB para guardar y compartir. Revisa que los datos del comprobante sigan legibles.' : 'Se guarda en esta computadora.'}</p></section>`;
}
async function receiptDataUrl(file) {
  let blob = file;
  if (data.storage === 'cloud') {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.82));
    if (!blob) throw new Error('No se pudo comprimir la imagen. Intenta con otra captura.');
    if (blob.size > 500000) throw new Error('La imagen comprimida supera 500 KB. Recorta la captura y vuelve a elegirla.');
  }
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('No se pudo leer la imagen.')); reader.readAsDataURL(blob); });
}
function bindReceiptUpload(id) {
  $('receipt-file').addEventListener('change', () => { $('receipt-file-name').textContent = $('receipt-file').files[0]?.name || 'Sin imagen seleccionada'; });
  $('upload-receipt').addEventListener('click', async () => {
    if (busy) return;
    const file = $('receipt-file').files[0];
    if (!file) return showFormError('Elige una imagen de comprobante para guardar.');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || !file.size || file.size > 10 * 1024 * 1024) return showFormError('Elige una imagen PNG, JPG o WebP de hasta 10 MB.');
    setBusy(true); $('form-error').hidden = true;
    try {
      const dataUrl = await receiptDataUrl(file);
      const result = await api('/api/receipt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ month: modal.month, paydayId: id, revision: modal.revision, name: file.name, dataUrl }) });
      ++requestNumber; data = result; modal.revision = result.revision; render();
      $('receipt-list').innerHTML = receiptCards(result.cycle.paydays.find(p => p.id === id));
      $('receipt-file').value = '';
      $('receipt-file-name').textContent = 'Sin imagen seleccionada';
      toast(data.storage === 'cloud' ? 'Comprobante guardado y compartido.' : 'Comprobante guardado en esta computadora.');
    } catch (error) { showFormError(error.message); }
    finally { setBusy(false); }
  });
}
function dateField(id, title, value, help = '', required = false) {
  return `<label class="field date-field" for="${id}"><span>${title}</span><input id="${id}" type="date" value="${escape(value || '')}" ${required ? 'required' : ''}>${help ? `<small>${help}</small>` : ''}</label>`;
}
function editExpense(id) {
  const expense = data.cycle.expenses.find(e => e.id === id);
  if (id && !expense) return;
  openModal({ type: 'save-expense', expenseId: id, title: expense ? 'Editar gasto' : 'Agregar gasto', eyebrow: `Ciclo del ${shortDate(data.cycle.deadline)}`, body: `${field('expense-name', 'Concepto', expense?.name || '', { text: true })}${field('expense-amount', 'Presupuesto (MXN)', expense ? (expense.plannedAmount / 100).toFixed(2) : '')}${dateField('expense-due-date', 'Fecha de corte / pago', expense?.dueDate, 'Opcional. Si el cambio es permanente, el día se repetirá cada mes; si no existe ese día, se usa el último del mes.')}${expense?.payment ? `<p class="form-help">Este ciclo usa el pago real de ${cash(expense.payment.amount)}. Para corregirlo, abre Registrar pago en la lista de gastos.</p>` : ''}${scopeField()}` });
}
function editExpensePayment(id) {
  const expense = data.cycle.expenses.find(e => e.id === id);
  if (!expense) return;
  openModal({ type: 'record-expense-payment', id, title: expense.payment ? 'Corregir pago real' : 'Registrar pago real', eyebrow: expense.name, submit: 'Guardar pago real', body: `<div class="modal-info">Presupuesto del ciclo<strong>${cash(expense.plannedAmount)}</strong>${expense.dueDate ? `Fecha de pago: ${shortDate(expense.dueDate)}` : 'Puedes asignar su fecha de corte en Editar gasto.'}</div>${field('expense-paid-amount', '¿Cuánto pagaste realmente? (MXN)', ((expense.payment?.amount ?? expense.plannedAmount) / 100).toFixed(2))}${dateField('expense-paid-date', 'Fecha en la que pagaste', expense.payment?.paidDate || data.cycle.today, '', true)}<p class="form-help">El pago real reemplazará el presupuesto únicamente en este ciclo y recalculará sus aportaciones pendientes.</p>${expense.payment ? '<button type="button" id="clear-expense-payment" class="text-button danger">Quitar registro de pago…</button>' : ''}` });
  if (expense.payment) $('clear-expense-payment').addEventListener('click', () => {
    $('editor').close();
    openModal({ type: 'clear-expense-payment', id, title: 'Quitar registro de pago', eyebrow: expense.name, submit: 'Confirmar y quitar registro', body: `<div class="modal-info">El gasto volverá a usar el presupuesto de <strong>${cash(expense.plannedAmount)}</strong>y aparecerá como pendiente de pago. Las aportaciones cerradas se conservarán.</div>` });
  });
}
function parseMoney(id) {
  const value = $(id).value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error('Escribe un importe positivo o $0, con hasta dos decimales.');
  const [whole, fraction = ''] = value.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount > 100_000_000_00) throw new Error('El importe es demasiado grande.');
  return amount;
}
function showFormError(message) {
  $('form-error').replaceChildren(document.createTextNode(message));
  $('form-error').hidden = false;
  if (message.includes('otra pestaña')) {
    const refresh = document.createElement('button');
    refresh.type = 'button'; refresh.className = 'text-button'; refresh.textContent = 'Actualizar sin perder lo escrito';
    refresh.addEventListener('click', async () => {
      try {
        const result = await api(`/api/cycle?month=${encodeURIComponent(modal.month)}`);
        data = result; modal.revision = result.revision; render();
        showFormError('Datos actualizados. Tu formulario conserva lo escrito: revisa los importes y guarda otra vez.');
      } catch (error) { showFormError(error.message); }
    });
    $('form-error').append(document.createElement('br'), refresh);
  }
}
function setBusy(value) {
  busy = value;
  $('editor-form').querySelectorAll('button, input, select').forEach(el => { el.disabled = value; });
}
async function save(action) {
  if (busy) return;
  setBusy(true); $('form-error').hidden = true;
  try {
    const result = await api('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: modal.revision, action: { ...action, month: modal.month } }) });
    ++requestNumber;
    data = result; render(); $('editor').close();
    $('save-status').textContent = 'Todos los cambios guardados';
    toast(action.type === 'close-payday' ? 'Aportación cerrada. El resto del ciclo ya se actualizó.' : 'Cambio guardado. Su plan ya está actualizado.');
  } catch (error) { showFormError(error.message); }
  finally { setBusy(false); }
}
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500); }
$('editor-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy || modal.readOnly) return;
  try {
    let action;
    if (modal.type === 'delete-expense') action = { type: modal.type, id: modal.expenseId, scope: $('expense-scope').value };
    else if (modal.type === 'save-expense') action = { type: modal.type, id: modal.expenseId, name: $('expense-name').value, amount: parseMoney('expense-amount'), dueDate: $('expense-due-date').value || null, scope: $('expense-scope').value };
    else if (modal.type === 'update-payday') action = { type: modal.type, id: modal.id, income: parseMoney('payday-income'), available: parseMoney('payday-available') };
    else if (modal.type === 'record-expense-payment') action = { type: modal.type, id: modal.id, amount: parseMoney('expense-paid-amount'), paidDate: $('expense-paid-date').value };
    else if (['reopen-payday', 'clear-expense-payment'].includes(modal.type)) action = { type: modal.type, id: modal.id };
    else action = { type: modal.type, id: modal.id, paid: parseMoney('payday-paid') };
    void save(action);
  } catch (error) { showFormError(error.message); }
});
$('delete-expense').addEventListener('click', () => {
  if (busy) return;
  const scope = $('expense-scope').value;
  if (!scope) { showFormError('Elige primero si quieres quitarlo solo de este ciclo o también de los siguientes.'); $('expense-scope').focus(); return; }
  if (modal.type !== 'delete-expense') {
    modal.type = 'delete-expense';
    $('submit-editor').textContent = 'Confirmar que se quite';
    $('delete-expense').hidden = true;
    const note = document.createElement('p'); note.className = 'danger-confirm'; note.textContent = 'Se quitará este gasto con la vigencia seleccionada. Las aportaciones cerradas se conservan.';
    $('editor-body').append(note);
    $('expense-name').readOnly = true; $('expense-amount').readOnly = true;
    return;
  }
});
for (const id of ['close-editor', 'cancel-editor']) $(id).addEventListener('click', () => { if (!busy) $('editor').close(); });
$('editor').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
document.addEventListener('click', event => {
  const payday = event.target.closest('[data-payday]');
  const expense = event.target.closest('[data-expense]');
  const payment = event.target.closest('[data-expense-payment]');
  if (payday) editPayday(payday.dataset.payday);
  if (expense) editExpense(expense.dataset.expense);
  if (payment) editExpensePayment(payment.dataset.expensePayment);
});
$('add-expense').addEventListener('click', () => editExpense());
$('cycle-month').addEventListener('change', () => { if ($('cycle-month').value && $('cycle-month').validity.valid) void load($('cycle-month').value); });
$('cycle-prev').addEventListener('click', () => { if (data && ! $('cycle-prev').disabled) void load(shiftMonth(data.cycle.month, -1)); });
$('cycle-next').addEventListener('click', () => { if (data && ! $('cycle-next').disabled) void load(shiftMonth(data.cycle.month, 1)); });
$('calendar-prev').addEventListener('click', () => { calendarMonth = shiftMonth(calendarMonth, -1); renderCalendar(); });
$('calendar-next').addEventListener('click', () => { calendarMonth = shiftMonth(calendarMonth, 1); renderCalendar(); });
$('refresh').addEventListener('click', () => void load(data.cycle.month, { retainCalendar: true }));
$('retry').addEventListener('click', () => void load(data?.cycle.month, { retainCalendar: true }));
void load(new URLSearchParams(location.search).get('month') || undefined);
