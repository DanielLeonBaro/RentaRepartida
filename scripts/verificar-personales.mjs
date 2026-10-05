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
const temporary = await mkdtemp(path.join(os.tmpdir(), 'renta-personal-browser-'));
const cloud = process.argv.includes('--cloud'), date = '2026-10-05';
let server, store, miniflare;
const password = 'personal-browser-private-fixture-password';
if (cloud) {
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
  const { default: worker } = await import('../cloud/worker.mjs');
  const { createState } = await import('../lib/domain.mjs');
  const { importState, loadState, updateState } = await import('../cloud/store.mjs');
  miniflare = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(); } }', compatibilityDate: date, d1Databases: { DB: 'personal-browser-test' } }));
  const db = await miniflare.getD1Database('DB');
  const sql = await readFile(new URL('../cloud/migrations/0001_storage.sql', import.meta.url), 'utf8');
  await db.batch(sql.split(';').filter(s => s.trim()).map(s => db.prepare(s)));
  await importState(db, createState(date), date);
  store = { state: await loadState(db), async update(action, revision) { this.state = await updateState(db, this.state, action, revision, date); } };
  const env = { DB: db, APP_PASSWORD: password, ASSETS: { async fetch(request) {
    const route = new URL(request.url).pathname;
    const files = { '/': ['index.html', 'text/html'], '/personal': ['personal.html', 'text/html'], '/personal.js': ['personal.js', 'text/javascript'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
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
  const ready = () => wait("document.getElementById('personal-month')?.options.length === 2 && document.getElementById('personal-income')?.textContent.includes('$')");
  const submit = async () => { await evaluate("document.getElementById('personal-editor-form').requestSubmit()"); await wait("!document.getElementById('personal-editor').open"); };
  const openExpense = async id => { await click(`[data-personal-expense="${id}"]`); await wait("document.getElementById('personal-editor').open"); };
  const openPayment = async id => { await click(`[data-personal-payment="${id}"]`); await wait("document.getElementById('personal-editor').open"); };
  const escape = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await wait("!document.getElementById('personal-editor').open");
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1120, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: origin + '/daniel' });
  if (cloud) {
    await wait("document.getElementById('password') !== null"); await fill('password', password);
    await evaluate("document.querySelector('form[action=\"/login\"]').requestSubmit()");
  }
  await ready();
  assert.equal(await evaluate('location.pathname'), '/daniel');
  assert.equal(await evaluate("document.getElementById('personal-income').textContent"), '$48,000.00');
  assert.equal(await evaluate("document.getElementById('personal-expenses-total').textContent"), '$20,700.00');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  assert.deepEqual(await evaluate("[...document.getElementById('personal-month').options].map(o => o.value)"), ['2026-10', '2026-11']);
  await click('a[href="/sofia"]'); await ready();
  assert.equal(await evaluate('location.pathname'), '/sofia');
  assert.equal(await evaluate("document.getElementById('personal-expenses-total').textContent"), '$3,293.00');
  assert.equal(await evaluate("document.querySelectorAll('#personal-unscheduled [data-personal-payment]').length"), 4);
  await openExpense('mesa'); await fill('personal-expense-amount', '1000'); await fill('personal-expense-schedule', 'monthly');
  await fill('personal-expense-day', '10'); await fill('personal-expense-scope', 'cycle'); await submit();
  assert.equal(store.state.personal.sofia.months['2026-10'].expenseOverrides.mesa.amount, 100000);
  assert.equal(await evaluate("document.getElementById('personal-expenses-total').textContent"), '$3,393.00');
  await openPayment('tarjeta:0'); await fill('personal-payment-amount', '1650'); await fill('personal-payment-date', date); await submit();
  assert.equal(store.state.personal.sofia.months['2026-10'].payments['tarjeta:0'].amount, 165000);
  assert.equal(await evaluate("document.getElementById('personal-expenses-total').textContent"), '$3,550.00');
  await openPayment('tarjeta:0'); await click('#personal-start-reopen'); await submit();
  assert.equal(store.state.personal.sofia.months['2026-10'].payments['tarjeta:0'], undefined);
  await click('#personal-add-expense'); await wait("document.getElementById('personal-editor').open");
  await fill('personal-expense-name', 'Consulta'); await fill('personal-expense-amount', '80'); await fill('personal-expense-schedule', 'weekly');
  await fill('personal-expense-weekday', '2'); await fill('personal-expense-scope', 'future'); await submit();
  await click('#personal-month-next'); await wait("document.getElementById('personal-month').value === '2026-11' && document.getElementById('personal-expenses-total').textContent === '$3,373.00'");
  assert.equal(await evaluate("document.getElementById('personal-month-next').disabled"), true);
  await click('#personal-month-prev'); await wait("document.getElementById('personal-month').value === '2026-10' && document.getElementById('personal-expenses-total').textContent === '$3,473.00'");
  await mkdir('.preview', { recursive: true });
  await writeFile('.preview/personal-sofia.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'));
  await click('a[href="/daniel"]'); await ready();
  await store.update({ type: 'close-payday', month: '2026-10', id: 'daniel:2026-10-15', paid: 400000 }, store.state.revision, date);
  const sharedClosed = structuredClone(store.state.cycles['2026-10'].paydays['daniel:2026-10-15']);
  await send('Page.reload'); await ready();
  await openPayment('carro:0'); await fill('personal-payment-amount', '5500'); await fill('personal-payment-date', date); await submit();
  assert.equal(store.state.personal.daniel.months['2026-10'].payments['carro:0'].amount, 550000);
  assert.equal(await evaluate("document.getElementById('personal-expenses-total').textContent"), '$21,200.00');
  await openExpense('carro'); await fill('personal-expense-amount', '12000'); await fill('personal-expense-scope', 'cycle'); await submit();
  assert.equal(store.state.personal.daniel.months['2026-10'].payments['carro:0'].amount, 550000);
  assert.deepEqual(store.state.cycles['2026-10'].paydays['daniel:2026-10-15'], sharedClosed);
  assert.equal(await evaluate("document.getElementById('personal-expenses-total').textContent"), '$23,200.00');
  await openExpense('gpt');
  assert.equal(await evaluate("document.getElementById('personal-editor').contains(document.activeElement)"), true);
  await escape();
  await writeFile('.preview/personal-daniel.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'));
  await send('Page.reload'); await ready();
  assert.equal(await evaluate("document.getElementById('personal-expenses-total').textContent"), '$23,200.00');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await pause(150);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  assert.equal(await evaluate("getComputedStyle(document.getElementById('personal-agenda')).display !== 'none'"), true);
  await writeFile('.preview/personal-movil.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'));
  await click('a[href="/"]'); await wait("!document.getElementById('workspace')?.hidden");
  assert.equal(await evaluate('location.pathname'), '/');
  assert.equal(await evaluate("document.getElementById('saved').textContent"), '$4,000.00');
  assert.deepEqual(errors, []);
  console.log(`Calendarios personales (${cloud ? 'Cloudflare' : 'local'}): navegación, meses, vigencia, importes reales, reapertura, aislamiento, persistencia, teclado y móvil verificados.`);
  console.log('Capturas: .preview/personal-daniel.png, .preview/personal-sofia.png y .preview/personal-movil.png. Datos temporales.');
} finally {
  socket?.close();
  if (browser.exitCode === null) { browser.kill(); await Promise.race([new Promise(resolve => browser.once('exit', resolve)), pause(3000)]); }
  await new Promise(resolve => server.close(resolve)); await miniflare?.dispose();
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
