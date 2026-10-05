import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../server.mjs';
import http from 'node:http';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const candidates = [process.env.RENTA_BROWSER, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
let executable;
for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
if (!executable) throw new Error('No se encontró Chrome o Edge. Define RENTA_BROWSER con la ruta del navegador.');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'renta-browser-'));
const cloud = process.argv.includes('--cloud');
let server, store, miniflare;
const testPassword = 'browser-test-private-fixture-password';
if (cloud) {
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
  const { default: worker } = await import('../cloud/worker.mjs');
  const { createState } = await import('../lib/domain.mjs');
  const { loadState, importState, updateState } = await import('../cloud/store.mjs');
  miniflare = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(); } }', compatibilityDate: '2026-10-05', d1Databases: { DB: 'browser-test' } }));
  const db = await miniflare.getD1Database('DB');
  const sql = await readFile(new URL('../cloud/migrations/0001_storage.sql', import.meta.url), 'utf8');
  await db.batch(sql.split(';').filter(s => s.trim()).map(s => db.prepare(s)));
  await importState(db, createState('2026-10-05'), '2026-10-05');
  store = { state: await loadState(db), async update(action, revision, date) { this.state = await updateState(db, this.state, action, revision, date); } };
  const env = { DB: db, APP_PASSWORD: testPassword, ASSETS: { async fetch(request) {
    const route = new URL(request.url).pathname;
    const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/debts.js': ['debts.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
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
} else ({ server, store } = await createApp({ directory: path.join(temporary, 'data'), date: '2026-10-05' }));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = path.join(temporary, 'profile');
const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let browserLog = '';
browser.stderr.on('data', chunk => { browserLog = (browserLog + chunk).slice(-2500); });
let socket, sequence = 0;
const pending = new Map(), errors = [];
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
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Tiempo agotado: ${method}. ${browserLog}`)); }, 10000);
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
  const fill = (id, value) => evaluate(`document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)}`);
  const submit = async () => {
    await evaluate("document.getElementById('editor-form').requestSubmit()");
    await wait("!document.getElementById('editor').open");
  };
  const openPayday = async id => { await click(`[data-payday="${id}"]`); await wait("document.getElementById('editor').open"); };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1120, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: origin });
  if (cloud) {
    await wait("document.getElementById('password') !== null");
    await fill('password', testPassword);
    await evaluate("document.querySelector('form[action=\"/login\"]').requestSubmit()");
  }
  await wait("!document.getElementById('workspace').hidden");
  assert.equal(await evaluate("document.getElementById('total').textContent"), '$17,800.00');
  assert.equal(await evaluate("document.querySelectorAll('.payday-row[data-payday]').length"), 6);
  assert.deepEqual(await evaluate("[...document.getElementById('cycle-month').options].map(o => o.value)"), ['2026-10', '2026-11']);
  assert.equal(await evaluate("document.getElementById('cycle-prev').disabled"), true);
  assert.equal(await evaluate("document.querySelectorAll('.event[data-payday]').length"), 3);
  assert.match(await evaluate("document.getElementById('cycle-month').selectedOptions[0].textContent"), /octubre de 2026/);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await mkdir('.preview', { recursive: true });
  await writeFile('.preview/escritorio.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'));
  await click('#calendar-prev'); assert.equal(await evaluate("document.querySelectorAll('.event[data-payday]').length"), 3);
  await openPayday('sofia:2026-10-04');
  await fill('payday-income', '3300'); await fill('payday-available', '1500'); await submit();
  assert.equal(store.state.cycles['2026-10'].paydays['sofia:2026-10-04'].available, 150000);
  await openPayday('sofia:2026-09-20'); await click('#start-close'); await fill('payday-paid', '0'); await submit();
  assert.equal(store.state.cycles['2026-10'].paydays['sofia:2026-09-20'].closed, true);
  const closed = structuredClone(store.state.cycles['2026-10'].paydays['sofia:2026-09-20']);
  await click('[data-expense="luz"]'); await fill('expense-amount', '1500'); await fill('expense-scope', 'cycle'); await submit();
  assert.equal(await evaluate("document.getElementById('total').textContent"), '$18,300.00');
  assert.deepEqual(store.state.cycles['2026-10'].paydays['sofia:2026-09-20'], closed);
  await click('[data-expense="despensa"]'); await fill('expense-amount', '5000'); await fill('expense-scope', 'future'); await submit();
  await click('#add-expense'); await fill('expense-name', 'Gas'); await fill('expense-amount', '100'); await fill('expense-scope', 'cycle'); await submit();
  assert.equal(await evaluate("document.getElementById('total').textContent"), '$18,900.00');
  await evaluate("[...document.querySelectorAll('[data-expense]')].find(el => el.getAttribute('aria-label') === 'Editar Gas').click()");
  await fill('expense-scope', 'cycle'); await click('#delete-expense'); await submit();
  assert.equal(await evaluate("document.getElementById('total').textContent"), '$18,800.00');
  await openPayday('sofia:2026-09-20'); assert.equal(await evaluate("document.getElementById('editor-title').textContent"), 'Aportación cerrada');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await wait("!document.getElementById('editor').open");
  await click('#cycle-next'); await wait("document.getElementById('total').textContent === '$18,300.00'");
  assert.equal(await evaluate("document.querySelectorAll('.payday-row[data-payday]').length"), 7);
  assert.equal(await evaluate("document.getElementById('cycle-next').disabled"), true);
  await click('#cycle-prev'); await wait("document.getElementById('total').textContent === '$18,800.00'");
  // A stale editor must keep user input and require explicit reload before retrying.
  await click('[data-expense="luz"]'); await fill('expense-amount', '1600'); await fill('expense-scope', 'cycle');
  await store.update({ type: 'save-expense', month: '2026-10', id: 'agua', name: 'Agua', amount: 55000, scope: 'cycle' }, store.state.revision, '2026-10-05');
  await evaluate("document.getElementById('editor-form').requestSubmit()");
  await wait("document.getElementById('form-error').textContent.includes('otra pestaña')");
  assert.equal(await evaluate("document.getElementById('expense-amount').value"), '1600');
  await click('#form-error button'); await wait("document.getElementById('form-error').textContent.includes('Datos actualizados')"); await submit();
  assert.equal(await evaluate("document.getElementById('total').textContent"), '$18,950.00');
  // An image can be attached to a closed contribution, retained through correction, and served locally.
  const imagePath = path.join(temporary, 'captura.png');
  await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a87sAAAAASUVORK5CYII=', 'base64'));
  if (cloud) {
    const image = await evaluate("(() => { const c = document.createElement('canvas'); c.width = 1800; c.height = 900; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#111'; g.font = '80px sans-serif'; g.fillText('Comprobante de prueba $50.00', 100, 250); return c.toDataURL('image/png').split(',')[1]; })()");
    await writeFile(imagePath, Buffer.from(image, 'base64'));
  }
  await openPayday('sofia:2026-09-20');
  const document = await send('DOM.getDocument');
  const node = await send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#receipt-file' });
  await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [imagePath] });
  await click('#upload-receipt');
  await wait(`document.querySelectorAll('.receipt-card').length === 1 && document.querySelector('.receipt-card img').naturalWidth === ${cloud ? 1600 : 1}`);
  if (cloud) {
    const receipt = store.state.cycles['2026-10'].paydays['sofia:2026-09-20'].receipts[0];
    assert.equal(receipt.type, 'image/webp'); assert.ok(receipt.bytes < 500000);
    assert.equal(await evaluate("document.getElementById('logout-form').hidden"), false);
  }
  await writeFile('.preview/comprobante.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  await click('#start-reopen'); await submit();
  assert.equal(store.state.cycles['2026-10'].paydays['sofia:2026-09-20'].closed, false);
  await openPayday('sofia:2026-09-20'); await click('#start-close'); await fill('payday-paid', '50'); await submit();
  assert.equal(store.state.cycles['2026-10'].paydays['sofia:2026-09-20'].receipts.length, 1);
  await click('[data-expense="luz"]'); await fill('expense-due-date', '2026-10-10'); await fill('expense-scope', 'cycle'); await submit();
  await click('#calendar-next');
  assert.equal(await evaluate("document.querySelectorAll('.event[data-expense-payment=\"luz\"]').length"), 1);
  await click('[data-expense-payment="luz"]'); await fill('expense-paid-amount', '1500'); await fill('expense-paid-date', '2026-10-05'); await submit();
  await click('[data-expense-payment="agua"]'); await fill('expense-paid-amount', '200'); await fill('expense-paid-date', '2026-10-05'); await submit();
  assert.equal(await evaluate("document.getElementById('total').textContent"), '$18,500.00');
  assert.equal(await evaluate("document.getElementById('saved').textContent"), '$50.00');
  assert.equal(store.state.cycles['2026-10'].expensePayments.luz.amount, 150000);
  await openPayday('sofia:2026-09-27'); await click('#start-close'); await fill('payday-paid', '500'); await submit();
  assert.equal(await evaluate("document.getElementById('saved').textContent"), '$550.00');
  assert.equal(await evaluate("document.getElementById('progress').getBoundingClientRect().width > 0"), true);
  await writeFile('.preview/escritorio.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'));
  // Reload demonstrates that the browser derives the same persisted results.
  await send('Page.reload'); await wait("!document.getElementById('workspace').hidden");
  assert.equal(await evaluate("document.getElementById('total').textContent"), '$18,500.00');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await pause(150);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.payday-list')).display !== 'none'"), true);
  await writeFile('.preview/movil.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'));
  assert.deepEqual(errors, []);
  if (cloud) { await click('#logout-form button'); await wait("document.getElementById('password') !== null"); }
  console.log('Navegador: escritorio, móvil, edición, cierres, reapertura, comprobantes, fechas de pago, importes reales, vigencia, persistencia, conflictos y teclado verificados.');
  console.log('Capturas: .preview/escritorio.png y .preview/movil.png. Los datos de prueba son temporales.');
} finally {
  socket?.close();
  if (browser.exitCode === null) {
    browser.kill();
    await Promise.race([new Promise(resolve => browser.once('exit', resolve)), pause(3000)]);
  }
  await new Promise(resolve => server.close(resolve));
  await miniflare?.dispose();
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
