import http from 'node:http';
import { readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from './lib/store.mjs';
import { availableMonths, cycleView, PEOPLE, today, upcomingMonth, validMonth } from './lib/domain.mjs';
import { personalView } from './lib/personal.mjs';

import { decodeReceipt } from './lib/receipts.mjs';
export { decodeReceipt } from './lib/receipts.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
export async function createApp({ directory = path.join(root, 'data'), date } = {}) {
  const store = await new Store(directory, date).load();
  const payload = month => ({ revision: store.state.revision, warning: store.warning, availableMonths: availableMonths(store.state, date), cycle: cycleView(store.state, month, date) });
  const personalPayload = (person, month) => ({ revision: store.state.revision, warning: store.warning, storage: 'local', availableMonths: availableMonths(store.state, date), personal: personalView(store.state, person, month, date) });
  const personalActions = ['save-personal-expense', 'delete-personal-expense', 'record-personal-payment', 'reopen-personal-payment'];
  const publicFiles = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/personal.js': ['personal.js', 'text/javascript; charset=utf-8'], '/sofia': ['personal.html', 'text/html; charset=utf-8'], '/sofia/': ['personal.html', 'text/html; charset=utf-8'], '/daniel': ['personal.html', 'text/html; charset=utf-8'], '/daniel/': ['personal.html', 'text/html; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body)); };
    try {
      const authority = `127.0.0.1:${server.address().port}`;
      if (request.headers.host !== authority && request.headers.host !== `localhost:${server.address().port}`) return json(403, { error: 'Acceso local únicamente.' });
      const url = new URL(request.url, `http://${authority}`);
      if (request.method === 'GET' && url.pathname === '/api/health') return json(200, { app: 'renta-repartida', version: 1 });
      if (request.method === 'GET' && url.pathname === '/api/cycle') {
        const months = availableMonths(store.state, date);
        const month = url.searchParams.get('month') || months.find(m => m >= upcomingMonth(date)) || months.at(-1);
        validMonth(month);
        if (!months.includes(month)) return json(400, { error: 'Ese vencimiento aún no está disponible. Se agregará mes con mes.' });
        await store.ensureSnapshots(date);
        return json(200, payload(month));
      }
      if (request.method === 'GET' && url.pathname === '/api/personal') {
        const person = url.searchParams.get('person');
        if (!Object.hasOwn(PEOPLE, person)) return json(400, { error: 'Elige el calendario de Sofía o Daniel.' });
        const months = availableMonths(store.state, date);
        const month = validMonth(url.searchParams.get('month') || (date || today()).slice(0, 7));
        if (!months.includes(month)) return json(400, { error: 'Ese mes aún no está disponible. Se agregará mes con mes.' });
        await store.ensureSnapshots(date);
        return json(200, personalPayload(person, month));
      }
      if (request.method === 'GET' && url.pathname === '/api/backup') {
        const month = validMonth(url.searchParams.get('month'));
        if (!availableMonths(store.state, date).includes(month)) return json(400, { error: 'Ese vencimiento no está disponible.' });
        await store.ensureSnapshots(date);
        const content = await readFile(path.join(directory, 'ciclos', `${month}.json`));
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="renta-${month}.json"` }); response.end(content); return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/comprobantes/')) {
        const match = /^\/comprobantes\/(\d{4}-\d{2})\/([a-f0-9-]{36}\.(png|jpg|webp))$/.exec(url.pathname);
        const receipt = match && Object.values(store.state.cycles[match[1]]?.paydays || {}).flatMap(p => p.receipts || []).find(r => r.id === match[2]);
        if (!receipt) return json(404, { error: 'No se encontró ese comprobante.' });
        const image = await readFile(path.join(directory, 'comprobantes', match[1], match[2]));
        response.writeHead(200, { 'Content-Type': receipt.type, 'Content-Disposition': "inline; filename*=UTF-8''" + encodeURIComponent(receipt.name) }); response.end(image); return;
      }
      if (request.method === 'POST' && ['/api/action', '/api/receipt', '/api/personal/action'].includes(url.pathname)) {
        if (request.headers.origin && ![`http://${authority}`, `http://localhost:${server.address().port}`].includes(request.headers.origin)) return json(403, { error: 'La solicitud debe venir de esta página.' });
        if (!request.headers['content-type']?.startsWith('application/json')) return json(415, { error: 'Formato de solicitud inválido.' });
        let body = '';
        const chunks = []; let bytes = 0;
        for await (const chunk of request) { bytes += chunk.length; if (bytes > (url.pathname === '/api/receipt' ? 15 * 1024 * 1024 : 20000)) return json(413, { error: 'La solicitud es demasiado grande.' }); chunks.push(chunk); }
        body = Buffer.concat(chunks).toString('utf8');
        let input;
        try { input = JSON.parse(body); } catch { return json(400, { error: 'La solicitud no tiene un formato válido.' }); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) return json(400, { error: 'La solicitud no tiene un formato válido.' });
        if (url.pathname === '/api/personal/action') {
          if (!personalActions.includes(input.action?.type) || !Object.hasOwn(PEOPLE, input.action?.person)) return json(400, { error: 'La operación personal no es válida.' });
          await store.update(input.action, input.revision, date);
          return json(200, personalPayload(input.action.person, input.action.month));
        }
        if (personalActions.includes(input.action?.type)) return json(400, { error: 'Guarda este cambio desde su calendario personal.' });
        if (url.pathname === '/api/receipt') {
          const month = validMonth(input.month);
          if (!availableMonths(store.state, date).includes(month)) return json(400, { error: 'Ese vencimiento no está disponible.' });
          if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 180) return json(400, { error: 'El nombre del comprobante no es válido.' });
          const { buffer, type, extension } = decodeReceipt(input.dataUrl);
          const id = `${crypto.randomUUID()}.${extension}`;
          const folder = path.join(directory, 'comprobantes', month);
          const file = path.join(folder, id);
          await mkdir(folder, { recursive: true });
          await writeFile(file, buffer, { flag: 'wx', flush: true });
          try {
            await store.update({ type: 'attach-receipt', month, id: input.paydayId, receipt: { id, name: path.win32.basename(input.name), type, bytes: buffer.length, uploadedAt: new Date().toISOString() } }, input.revision, date);
          } catch (error) { await unlink(file); throw error; }
          return json(200, payload(month));
        }
        if (input.action?.type === 'attach-receipt') return json(400, { error: 'Sube el comprobante mediante el formulario de imágenes.' });
        await store.update(input.action, input.revision, date);
        return json(200, payload(input.action.month));
      }
      if (request.method === 'GET' && publicFiles[url.pathname]) {
        const [file, type] = publicFiles[url.pathname];
        const content = await readFile(path.join(root, 'public', file));
        response.writeHead(200, { 'Content-Type': type }); response.end(content); return;
      }
      json(404, { error: 'No se encontró esta página.' });
    } catch (error) {
      const status = error.status || (error.message?.includes('mes válido') ? 400 : 500);
      if (status === 500) console.error(error);
      json(status, { error: status === 500 ? 'No se pudo guardar o leer la información. Tus datos anteriores se conservaron. Revisa la carpeta data e inténtalo de nuevo.' : error.message });
    }
  });
  return { server, store };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { server } = await createApp();
    const port = Number(process.env.RENTA_PORT || 3210);
    server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `El puerto ${port} ya está en uso. Si la aplicación está abierta, visita http://127.0.0.1:${port}.` : error); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`Renta Repartida está lista en http://127.0.0.1:${port}`));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
