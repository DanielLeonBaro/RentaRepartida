import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createApp } from '../server.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const candidates = [process.env.RENTA_BROWSER, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
let executable;
for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
if (!executable) throw new Error('No se encontró Chrome o Edge. Define RENTA_BROWSER con la ruta del navegador.');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'renta-debt-browser-'));
const cloud = process.argv.includes('--cloud'), date = '2026-10-05';
let server, store, miniflare;
const password = 'debt-browser-private-fixture-password';
if (cloud) {
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
  const { default: worker } = await import('../cloud/worker.mjs');
  const { createState } = await import('../lib/domain.mjs');
  const { importState, loadState, updateState } = await import('../cloud/store.mjs');
  miniflare = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(); } }', compatibilityDate: date, d1Databases: { DB: 'debt-browser-test' } }));
  const db = await miniflare.getD1Database('DB');
  const sql = await readFile(new URL('../cloud/migrations/0001_storage.sql', import.meta.url), 'utf8');
  await db.batch(sql.split(';').filter(s => s.trim()).map(s => db.prepare(s)));
  await importState(db, createState(date), date);
  store = { state: await loadState(db), async update(action, revision) { this.state = await updateState(db, this.state, action, revision, date); } };
  const env = { DB: db, APP_PASSWORD: password, ASSETS: { async fetch(request) {
    const route = new URL(request.url).pathname;
    const files = { '/': ['index.html', 'text/html'], '/personal': ['personal.html', 'text/html'], '/personal.js': ['personal.js', 'text/javascript'], '/debts.js': ['debts.js', 'text/javascript'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
    const file = files[route];
    return file ? new Response(await readFile(new URL('../public/' + file[0], import.meta.url)), { headers: { 'Content-Type': file[1] + ';charset=utf-8' } }) : new Response('', { status: 404 });
  } } };
  server = http.createServer(async (req, res) => {
    try {
      const parts = []; for await (const chunk of req) parts.push(chunk);
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, ...(['GET', 'HEAD'].includes(req.method) ? {} : { body: Buffer.concat(parts) }) });
      const response = await worker.fetch(request, env);
      store.state = await loadState(db);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
} else ({ server, store } = await createApp({ directory: path.join(temporary, 'data'), date }));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`, profile = path.join(temporary, 'profile');
const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let browserLog = '', socket, sequence = 0;
const pending = new Map(), errors = [];
browser.stderr.on('data', chunk => { browserLog = (browserLog + chunk).slice(-2500); });
browser.on('error', error => errors.push(error.message));
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch {}
    if (browser.exitCode !== null || errors.length) throw new Error(`No pudo iniciar el navegador (${browser.exitCode}): ${errors.join(', ')} ${browserLog}`);
    await pause(100);
  }
  if (!port) throw new Error('El navegador no abrió su puerto de pruebas.');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const callback = pending.get(message.id); if (!callback) return;
      pending.delete(message.id); message.error ? callback.reject(new Error(message.error.message)) : callback.resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Tiempo agotado: ${method}. ${browserLog}`)); }, 10000);
    pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = async expression => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await pause(50); }
    throw new Error(`No se cumplió: ${expression}`);
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const fill = (id, value) => evaluate(`(() => { const field = document.getElementById(${JSON.stringify(id)}); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const text = id => evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const ready = () => wait("document.getElementById('personal-month')?.options.length === 2 && document.getElementById('debt-total-balance')?.textContent.includes('$')");
  const open = async selector => { await click(selector); await wait("document.getElementById('debt-editor').open"); };
  const edit = id => open(`[data-debt-edit="${id}"]`);
  const pay = id => open(`[data-debt-pay="${id}"]`);
  const submit = async () => { await evaluate("document.getElementById('debt-form').requestSubmit()"); await wait("!document.getElementById('debt-editor').open"); };
  const expenseText = () => text('personal-expenses-total');
  const selectMonth = async month => {
    await fill('personal-month', month);
    await wait(`document.getElementById('personal-month').value === ${JSON.stringify(month)} && document.querySelector('#debt-add') !== null`);
    await wait(`document.querySelector('#personal-calendar-month')?.textContent.toLowerCase().includes(${JSON.stringify(month.endsWith('-11') ? 'noviembre' : 'octubre')})`);
  };
  const paymentId = (debtId, month) => store.state.debts.find(d => d.id === debtId).payments.find(p => p.month === month).id;
  const debtByName = name => store.state.debts.find(debt => debt.name === name);
  const navigate = async owner => { await click(`a[href="${owner === 'hogar' ? '/' : '/' + owner}"]`); owner === 'hogar' ? await wait("!document.getElementById('workspace')?.hidden && document.getElementById('debt-total-balance') !== null") : await ready(); };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1120, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: origin + '/daniel' });
  if (cloud) {
    await wait("document.getElementById('password') !== null"); await fill('password', password);
    await evaluate("document.querySelector('form[action=\"/login\"]').requestSubmit()");
  }
  await ready();
  assert.equal(await text('debt-total-balance'), '$132,000.00');
  assert.equal(await text('debt-total-paid'), '$0.00');
  assert.equal(await expenseText(), '$20,700.00');
  assert.equal(await evaluate("document.querySelectorAll('#debt-list .debt-row').length"), 5);
  assert.equal(await evaluate("document.querySelectorAll('#personal-unscheduled [data-debt-pay=\"citi-banamex\"]').length"), 1);
  await edit('hey-banco');
  assert.equal(await evaluate("document.getElementById('debt-editor').contains(document.activeElement)"), true);
  await fill('debt-monthly-payment', '1200'); await submit();
  assert.equal(await expenseText(), '$21,900.00');
  assert.equal(await text('debt-total-pending'), '$1,200.00');
  await pay('hey-banco'); await fill('debt-amount', '350.25'); await fill('debt-paid-date', date); await submit();
  assert.equal(debtByName('Hey banco').payments[0].amount, 35025);
  assert.equal(await text('debt-total-balance'), '$131,649.75');
  assert.equal(await text('debt-total-pending'), '$849.75');
  assert.equal(await expenseText(), '$21,900.00');
  await edit('hey-banco'); await fill('debt-monthly-payment', '0'); await submit();
  assert.equal(await expenseText(), '$21,050.25');
  await selectMonth('2026-11');
  await wait("document.getElementById('personal-expenses-total').textContent === '$20,700.00'");
  await edit('hey-banco'); assert.equal(await evaluate("document.getElementById('debt-monthly-payment').value"), '0.00');
  await fill('debt-monthly-payment', '100'); await submit();
  assert.equal(await expenseText(), '$20,800.00');
  await pay('hey-banco'); await fill('debt-amount', '100'); await fill('debt-paid-date', '2026-10-30'); await submit();
  assert.equal(await text('debt-total-paid'), '$100.00');
  const octoberPayment = paymentId('hey-banco', '2026-10'), novemberPayment = paymentId('hey-banco', '2026-11');
  await open('[data-debt-history="hey-banco"]'); await click(`[data-debt-payment="${octoberPayment}"]`);
  await fill('debt-amount', '300'); await fill('debt-paid-date', '2026-10-04'); await submit();
  assert.equal(store.state.debts.find(d => d.id === 'hey-banco').payments.find(p => p.id === octoberPayment).month, '2026-10');
  assert.equal(await evaluate("document.getElementById('personal-month').value"), '2026-11');
  assert.equal(await expenseText(), '$20,800.00');
  await selectMonth('2026-10'); await wait("document.getElementById('personal-expenses-total').textContent === '$21,000.00'");
  await open('[data-debt-history="hey-banco"]'); await click(`[data-debt-payment="${novemberPayment}"]`);
  await click('#debt-delete-payment'); await submit();
  assert.equal(await evaluate("document.getElementById('personal-month').value"), '2026-10');
  assert.equal(await text('debt-total-balance'), '$131,700.00');
  assert.equal(await expenseText(), '$21,000.00');
  await open('#debt-add'); await fill('debt-name', 'Tarjeta emergencia'); await fill('debt-owner', 'sofia');
  await fill('debt-balance', '500'); await fill('debt-due-day', '31'); await submit();
  const added = debtByName('Tarjeta emergencia'); assert.ok(added);
  assert.equal(await evaluate("document.querySelectorAll('#debt-list .debt-row').length"), 5);
  await navigate('sofia');
  assert.equal(await text('debt-total-balance'), '$500.00'); assert.equal(await expenseText(), '$3,293.00');
  await pay(added.id); await fill('debt-amount', '125'); await fill('debt-paid-date', date); await submit();
  assert.equal(await text('debt-total-balance'), '$375.00'); assert.equal(await expenseText(), '$3,418.00');
  await edit(added.id); await fill('debt-owner', 'hogar'); await submit();
  assert.equal(await text('debt-total-balance'), '$0.00'); assert.equal(await expenseText(), '$3,418.00');
  await mkdir('.preview', { recursive: true });
  await writeFile('.preview/deudas-sofia.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'));
  await store.update({ type: 'close-payday', month: '2026-10', id: 'daniel:2026-10-15', paid: 400000 }, store.state.revision, date);
  const sharedClosed = structuredClone(store.state.cycles['2026-10'].paydays['daniel:2026-10-15']);
  await navigate('hogar');
  assert.equal(await text('debt-total-balance'), '$375.00'); assert.equal(await text('total'), '$17,800.00');
  await open(`[data-debt-history="${added.id}"]`);
  const transferredPayment = paymentId(added.id, '2026-10');
  await click(`[data-debt-payment="${transferredPayment}"]`);
  await fill('debt-amount', '100'); await submit();
  assert.equal(debtByName('Tarjeta emergencia').payments[0].owner, 'sofia');
  assert.equal(debtByName('Tarjeta emergencia').payments[0].amount, 10000);
  assert.equal(await text('debt-total-paid'), '$0.00');
  assert.equal(await text('debt-total-balance'), '$400.00');
  await edit(added.id); await fill('debt-monthly-payment', '175'); await submit();
  assert.equal(await text('debt-total-pending'), '$75.00'); assert.equal(await text('total'), '$17,875.00');
  assert.deepEqual(store.state.cycles['2026-10'].paydays['daniel:2026-10-15'], sharedClosed);
  await edit(added.id); await click('#debt-delete'); await submit();
  assert.equal(await text('debt-total-balance'), '$0.00'); assert.equal(await text('total'), '$17,800.00');
  assert.equal(debtByName('Tarjeta emergencia').active, false);
  assert.equal(debtByName('Tarjeta emergencia').payments.length, 1);
  await navigate('sofia'); await selectMonth('2026-11');
  await wait("document.getElementById('personal-expenses-total').textContent === '$3,293.00'");
  await click('details.debt-archive summary');
  await open(`[data-debt-history="${added.id}"]`);
  assert.equal(await evaluate(`document.querySelectorAll('#debt-body [data-debt-payment="${transferredPayment}"]').length`), 1);
  await click('#debt-cancel');
  await navigate('daniel'); await edit('nu');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await wait("!document.getElementById('debt-editor').open");
  await edit('nu'); await fill('debt-monthly-payment', '100');
  await store.update({ type: 'record-debt-payment', owner: 'daniel', month: '2026-10', id: 'bbva', amount: 1, paidDate: date }, store.state.revision, date);
  await evaluate("document.getElementById('debt-form').requestSubmit()");
  await wait("!document.getElementById('debt-error').hidden && document.querySelector('#debt-error button') !== null");
  assert.equal(await evaluate("document.getElementById('debt-editor').open"), true);
  assert.equal(await evaluate("document.getElementById('debt-monthly-payment').value"), '100');
  await click('#debt-error button');
  await wait("document.getElementById('debt-error').textContent.includes('Datos actualizados')");
  assert.equal(await evaluate("document.getElementById('debt-monthly-payment').value"), '100');
  await submit();
  assert.equal(store.state.debts.find(debt => debt.id === 'bbva').payments[0].amount, 1);
  assert.equal(await expenseText(), '$21,100.01');
  await writeFile('.preview/deudas-daniel.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'));
  await send('Page.reload'); await ready();
  assert.equal(await text('debt-total-balance'), '$131,699.99');
  assert.equal(await expenseText(), '$21,100.01');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await pause(150);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  assert.equal(await evaluate("getComputedStyle(document.getElementById('personal-agenda')).display !== 'none'"), true);
  await edit('bbva');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await click('#debt-cancel');
  await writeFile('.preview/deudas-movil.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'));
  const panel = await evaluate("(() => { const rect = document.getElementById('debts-panel').getBoundingClientRect(); return { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height, scale: 1 }; })()");
  await writeFile('.preview/deudas-panel-movil.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: panel })).data, 'base64'));
  assert.deepEqual(errors, []);
  console.log(`Deudas (${cloud ? 'Cloudflare' : 'local'}): saldos, abonos parciales, planes por mes, correcciones, anulación, tres dueños, archivo, aportaciones cerradas, conflictos sin perder el formulario, recarga, teclado y móvil verificados.`);
  console.log('Capturas: .preview/deudas-daniel.png, .preview/deudas-sofia.png y .preview/deudas-movil.png. Datos temporales.');
} finally {
  socket?.close();
  if (browser.exitCode === null) { browser.kill(); await Promise.race([new Promise(resolve => browser.once('exit', resolve)), pause(3000)]); }
  await new Promise(resolve => server.close(resolve)); await miniflare?.dispose();
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
