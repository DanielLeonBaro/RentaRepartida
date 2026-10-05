import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createState, validateState } from '../lib/domain.mjs';
import { decodeReceipt } from '../lib/receipts.mjs';
import { root } from './cloud-cli.mjs';

export async function migrate({ url, password, directory = path.join(root, 'data') }) {
  const origin = new URL(url).origin;
  if (!origin.startsWith('https://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) throw new Error('La migración requiere HTTPS o una dirección local.');
  let state;
  try { state = validateState(JSON.parse(await readFile(path.join(directory, 'estado.json'), 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; state = createState(); }
  const images = [];
  for (const [month, cycle] of Object.entries(state.cycles)) {
    for (const payday of Object.values(cycle.paydays)) for (const receipt of payday.receipts || []) {
      const bytes = await readFile(path.join(directory, 'comprobantes', month, receipt.id));
      const dataUrl = `data:${receipt.type};base64,${bytes.toString('base64')}`;
      try { decodeReceipt(dataUrl, 500000); }
      catch { throw new Error(`El comprobante ${receipt.name} no se puede migrar: debe ser una imagen válida de hasta 500 KB. La copia local permanece intacta.`); }
      if (receipt.bytes !== bytes.length) throw new Error('Un comprobante local no coincide con su registro. No se importó ningún dato.');
      images.push({ month, id: receipt.id, dataUrl });
    }
  }
  let login;
  for (let attempt = 0; attempt < 8; attempt++) {
    login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }) });
    if (![404, 502, 503, 504].includes(login.status)) break;
    await new Promise(resolve => setTimeout(resolve, 750));
  }
  if (login.status !== 303) throw new Error('No se pudo entrar a la versión de Cloudflare. Revisa la clave y la dirección de la aplicación.');
  const cookie = login.headers.getSetCookie()[0]?.split(';')[0];
  async function upload(route, value) {
    const response = await fetch(`${origin}${route}`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    if (!response.ok) { const result = await response.json(); throw new Error(result.error || 'La migración no se completó.'); }
  }
  // Stage images before importing records; a failed upload leaves the cloud
  // uninitialized. Repeating is safe until the final, atomic state import.
  for (const image of images) await upload('/api/import/receipt', image);
  await upload('/api/import', { state });
  const check = await fetch(`${origin}/api/cycle?month=${state.initialMonth}`, { headers: { Cookie: cookie } });
  if (!check.ok || (await check.json()).revision !== state.revision) throw new Error('La importación terminó, pero no se pudo verificar. Conserva tu copia local.');
  console.log(`Registros migrados: revisión ${state.revision}, ${images.length} comprobantes. La carpeta data/ permanece intacta.`);
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const local = process.argv.includes('--local');
    const access = JSON.parse(await readFile(path.join(root, '.deploy', 'acceso.json'), 'utf8'));
    await migrate({ url: local ? 'http://127.0.0.1:8787' : access.url, password: access.password });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
