import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export function wrangler(args, { capture = false, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)), ...args], { cwd: root, windowsHide: true, stdio: [input === undefined ? 'inherit' : 'pipe', capture ? 'pipe' : 'inherit', 'inherit'] });
    let output = '';
    if (capture) child.stdout.on('data', chunk => { output += chunk; });
    if (input !== undefined) child.stdin.end(input);
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(output) : reject(new Error(`Cloudflare no completó el comando ${args[0]} (código ${code}).`)));
  });
}
