import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { root, wrangler } from './cloud-cli.mjs';
import { migrate } from './migrar-cloudflare.mjs';

try {
  const local = process.argv.includes('--local');
  const file = path.join(root, 'wrangler.jsonc');
  const config = JSON.parse(await readFile(file, 'utf8'));
  await mkdir(path.join(root, '.deploy'), { recursive: true });
  const accessFile = path.join(root, '.deploy', 'acceso.json');
  let access;
  try { access = JSON.parse(await readFile(accessFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; access = { password: randomBytes(24).toString('base64url') }; }
  await writeFile(accessFile, JSON.stringify(access, null, 2), { mode: 0o600 });
  await writeFile(path.join(root, '.dev.vars'), `APP_PASSWORD="${access.password}"\n`, { mode: 0o600 });
  if (!local && config.d1_databases[0].database_id === '00000000-0000-0000-0000-000000000000') {
    const output = await wrangler(['d1', 'create', config.d1_databases[0].database_name, '--location', 'wnam', '--update-config=false'], { capture: true });
    const match = /["']?database_id["']?\s*[:=]\s*["']([a-f0-9-]{36})["']/.exec(output);
    if (!match) throw new Error('No se pudo identificar la base creada. Copia su database_id en wrangler.jsonc y vuelve a ejecutar la configuración.');
    config.d1_databases[0].database_id = match[1];
    await writeFile(file, JSON.stringify(config, null, 2) + '\n');
  }
  await wrangler(['d1', 'migrations', 'apply', 'DB', local ? '--local' : '--remote']);
  if (local) { console.log('Configuración local lista. Ejecuta npm run cloud:dev y después node scripts/migrar-cloudflare.mjs --local.'); }
  else {
    await wrangler(['secret', 'put', 'APP_PASSWORD'], { input: access.password + '\n' });
    const output = await wrangler(['deploy'], { capture: true });
    console.log(output);
    access.url = output.match(/https:\/\/[\w.-]+\.workers\.dev\b/)?.[0] || access.url;
    if (!access.url) throw new Error('El Worker se publicó; agrega su URL en .deploy/acceso.json para importar los datos.');
    await writeFile(accessFile, JSON.stringify(access, null, 2), { mode: 0o600 });
    try { await migrate(access); }
    catch (error) { if (!error.message.includes('Ya existen registros')) throw error; console.log('La aplicación ya tiene registros. No se sobrescribieron.'); }
    console.log(`Abre ${access.url}. La clave privada está en .deploy/acceso.json; no está en GitHub.`);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
