import { availableMonths, cycleView, PEOPLE, today, upcomingMonth, validMonth } from '../lib/domain.mjs';
import { personalView } from '../lib/personal.mjs';
import { DEBT_ACTIONS } from '../lib/debts.mjs';
import { decodeReceipt } from '../lib/receipts.mjs';
import { importState, loadState, snapshots, updateState } from './store.mjs';
import { Buffer } from 'node:buffer';
import { clearCookie, hasSession, loginPage, passwordMatches, sessionCookie } from './auth.mjs';

const securityHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'Referrer-Policy': 'same-origin' };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const redirect = (target, headers = {}) => new Response(null, { status: 303, headers: { Location: target, ...headers } });
const loginTarget = value => ['/', '/sofia', '/daniel'].includes(value) ? value : '/';
const personalActions = ['save-personal-expense', 'delete-personal-expense', 'record-personal-payment', 'reopen-personal-payment'];
async function readBody(request, limit) {
  if (!request.body) return '';
  const reader = request.body.getReader(), chunks = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw Object.assign(new Error('La solicitud es demasiado grande.'), { status: 413 }); }
    chunks.push(value);
  }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(result);
}
async function readJSON(request, limit) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw Object.assign(new Error('Formato de solicitud inválido.'), { status: 415 });
  try {
    const input = JSON.parse(await readBody(request, limit));
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    return input;
  } catch (error) { if (error.status) throw error; throw Object.assign(new Error('La solicitud no tiene un formato válido.'), { status: 400 }); }
}
async function handle(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/api/health' && request.method === 'GET') return json(200, { app: 'renta-repartida', version: 2, storage: 'cloud' });
  if (['/style.css', '/favicon.svg'].includes(url.pathname) && request.method === 'GET') return env.ASSETS.fetch(request);
  if (!env.APP_PASSWORD || env.APP_PASSWORD.length < 20) return json(503, { error: 'Falta configurar una clave de acceso segura para esta aplicación.' });
  if (request.method === 'POST' && request.headers.get('Origin') !== url.origin) return json(403, { error: 'La solicitud debe venir de esta página.' });
  if (url.pathname === '/login') {
    if (request.method === 'GET') return new Response(loginPage('', loginTarget(url.searchParams.get('next'))), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    if (request.method !== 'POST') return json(405, { error: 'Método no permitido.' });
    const form = new URLSearchParams(await readBody(request, 4096));
    const password = form.get('password') || '';
    const target = loginTarget(form.get('next'));
    if (password.length > 256 || !await passwordMatches(password, env.APP_PASSWORD)) return new Response(loginPage('La clave no es correcta. Revisa e inténtalo de nuevo.', target), { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    return redirect(target, { 'Set-Cookie': await sessionCookie(env.APP_PASSWORD, url) });
  }
  if (!await hasSession(request, env.APP_PASSWORD)) {
    const target = loginTarget(url.pathname.replace(/\/$/, ''));
    return url.pathname.startsWith('/api/') || url.pathname.startsWith('/comprobantes/') ? json(401, { error: 'Tu sesión terminó. Vuelve a entrar para continuar.' }) : redirect(target === '/' ? '/login' : `/login?next=${encodeURIComponent(target)}`);
  }
  if (url.pathname === '/logout' && request.method === 'POST') return redirect('/login', { 'Set-Cookie': clearCookie(url) });
  if (request.method === 'GET' && ['/', '/app.js', '/personal.js', '/debts.js'].includes(url.pathname)) return env.ASSETS.fetch(request);
  if (request.method === 'GET' && ['/sofia', '/daniel', '/sofia/', '/daniel/'].includes(url.pathname)) {
    const asset = new URL(request.url); asset.pathname = '/personal';
    return env.ASSETS.fetch(new Request(asset, request));
  }
  if (['/api/import', '/api/import/receipt'].includes(url.pathname) && request.method === 'POST') {
    if (await env.DB.prepare('SELECT id FROM app_state WHERE id = 1').first()) return json(409, { error: 'Ya existen registros en la nube. No se sobrescribieron.' });
    const input = await readJSON(request, 1250000);
    if (url.pathname === '/api/import') {
      try { await importState(env.DB, input.state, today()); }
      catch (error) { if (!error.status) error.status = 400; throw error; }
    } else {
      const month = validMonth(input.month), image = decodeReceipt(input.dataUrl, 500000);
      if (typeof input.id !== 'string' || !new RegExp(`^[a-f0-9-]{36}\\.${image.extension}$`).test(input.id)) return json(400, { error: 'Identificador de comprobante inválido.' });
      const result = await env.DB.prepare(`INSERT INTO receipts (month, id, type, bytes, data_url)
        SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM app_state WHERE id = 1)
        ON CONFLICT(month, id) DO UPDATE SET data_url = excluded.data_url, bytes = excluded.bytes, type = excluded.type`)
        .bind(month, input.id, image.type, image.buffer.length, input.dataUrl).run();
      if (!result.meta.changes) return json(409, { error: 'La importación ya terminó en otro dispositivo.' });
    }
    return json(200, { ok: true });
  }
  const state = await loadState(env.DB);
  const date = today();
  const months = availableMonths(state, date);
  const payload = current => ({ revision: current.revision, warning: '', storage: 'cloud', availableMonths: availableMonths(current, date), cycle: cycleView(current, month, date) });
  const personalPayload = (current, person, month) => ({ revision: current.revision, warning: '', storage: 'cloud', availableMonths: availableMonths(current, date), personal: personalView(current, person, month, date) });
  let month;
  if (url.pathname === '/api/cycle' && request.method === 'GET') {
    month = validMonth(url.searchParams.get('month') || months.find(m => m >= upcomingMonth(date)) || months.at(-1));
    if (!months.includes(month)) return json(400, { error: 'Ese vencimiento aún no está disponible. Se agregará mes con mes.' });
    return json(200, payload(state));
  }
  if (url.pathname === '/api/personal' && request.method === 'GET') {
    const person = url.searchParams.get('person');
    if (!Object.hasOwn(PEOPLE, person)) return json(400, { error: 'Elige el calendario de Sofía o Daniel.' });
    month = validMonth(url.searchParams.get('month') || date.slice(0, 7));
    if (!months.includes(month)) return json(400, { error: 'Ese mes aún no está disponible. Se agregará mes con mes.' });
    return json(200, personalPayload(state, person, month));
  }
  if (url.pathname === '/api/backup' && request.method === 'GET') {
    month = validMonth(url.searchParams.get('month'));
    if (!months.includes(month)) return json(400, { error: 'Ese vencimiento no está disponible.' });
    const previous = url.searchParams.get('previous') === '1';
    const stored = previous && await env.DB.prepare('SELECT previous_json FROM cycle_backups WHERE month = ?').bind(month).first();
    if (previous && !stored) return json(404, { error: 'Aún no hay un respaldo anterior de este ciclo.' });
    const backup = previous ? JSON.parse(stored.previous_json) : snapshots(state, date).find(s => s.cycle.month === month);
    return new Response(JSON.stringify(backup, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="renta-${month}.json"` } });
  }
  if (url.pathname.startsWith('/comprobantes/') && request.method === 'GET') {
    const match = /^\/comprobantes\/(\d{4}-\d{2})\/([a-f0-9-]{36}\.(png|jpg|webp))$/.exec(url.pathname);
    const receipt = match && Object.values(state.cycles[match[1]]?.paydays || {}).flatMap(p => p.receipts || []).find(r => r.id === match[2]);
    if (!receipt) return json(404, { error: 'No se encontró ese comprobante.' });
    const image = await env.DB.prepare('SELECT data_url FROM receipts WHERE month = ? AND id = ?').bind(match[1], receipt.id).first();
    if (!image) return json(404, { error: 'No se encontró la imagen. Revisa que se hayan migrado los comprobantes.' });
    return new Response(Buffer.from(image.data_url.split(',')[1], 'base64'), { headers: { 'Content-Type': receipt.type, 'Content-Disposition': "inline; filename*=UTF-8''" + encodeURIComponent(receipt.name) } });
  }
  if (['/api/action', '/api/receipt', '/api/personal/action', '/api/debts/action'].includes(url.pathname) && request.method === 'POST') {
    const input = await readJSON(request, url.pathname === '/api/receipt' ? 700000 : 20000);
    if (url.pathname === '/api/debts/action') {
      if (!DEBT_ACTIONS.includes(input.action?.type) || !(input.viewOwner === 'hogar' || Object.hasOwn(PEOPLE, input.viewOwner))) return json(400, { error: 'La operación de deuda no es válida.' });
      month = validMonth(input.viewMonth ?? input.action.month);
      if (!months.includes(month)) return json(400, { error: 'Ese mes aún no está disponible.' });
      const saved = await updateState(env.DB, state, input.action, input.revision, date);
      return json(200, input.viewOwner === 'hogar' ? payload(saved) : personalPayload(saved, input.viewOwner, month));
    }
    if (DEBT_ACTIONS.includes(input.action?.type)) return json(400, { error: 'Guarda este cambio desde la sección de deudas.' });
    if (url.pathname === '/api/personal/action') {
      if (!personalActions.includes(input.action?.type) || !Object.hasOwn(PEOPLE, input.action?.person)) return json(400, { error: 'La operación personal no es válida.' });
      const saved = await updateState(env.DB, state, input.action, input.revision, date);
      return json(200, personalPayload(saved, input.action.person, input.action.month));
    }
    if (personalActions.includes(input.action?.type)) return json(400, { error: 'Guarda este cambio desde su calendario personal.' });
    let action = input.action, receipt;
    if (url.pathname === '/api/receipt') {
      month = validMonth(input.month);
      if (!months.includes(month)) return json(400, { error: 'Ese vencimiento no está disponible.' });
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 180) return json(400, { error: 'El nombre del comprobante no es válido.' });
      receipt = { ...decodeReceipt(input.dataUrl, 500000), dataUrl: input.dataUrl };
      const image = receipt, id = `${crypto.randomUUID()}.${image.extension}`;
      action = { type: 'attach-receipt', month, id: input.paydayId, receipt: { id, name: input.name.split(/[\\/]/).at(-1), type: image.type, bytes: image.buffer.length, uploadedAt: new Date().toISOString() } };
    } else if (action?.type === 'attach-receipt') return json(400, { error: 'Sube el comprobante mediante el formulario de imágenes.' });
    const saved = await updateState(env.DB, state, action, input.revision, date, receipt);
    month = action.month;
    return json(200, payload(saved));
  }
  return json(404, { error: 'No se encontró esta página.' });
}
export default {
  async fetch(request, env) {
    let response;
    try { response = await handle(request, env); }
    catch (error) {
      const status = error.status || (error.message?.includes('mes válido') ? 400 : 500);
      if (status === 500) console.error(JSON.stringify({ event: 'request_failed', error: error.message }));
      response = json(status, { error: status === 500 ? 'No se pudo guardar o leer la información. Conserva lo escrito e inténtalo de nuevo.' : error.message });
    }
    const result = new Response(response.body, response);
    for (const [name, value] of Object.entries(securityHeaders)) result.headers.set(name, value);
    return result;
  }
};
