import { Buffer } from 'node:buffer';

export function decodeReceipt(dataUrl, maxBytes = 10 * 1024 * 1024) {
  const match = typeof dataUrl === 'string' && /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4 !== 0) throw Object.assign(new Error('Sube una imagen PNG, JPG o WebP válida.'), { status: 400 });
  const buffer = Buffer.from(match[2], 'base64');
  const signature = buffer.subarray(0, 12);
  const type = signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
    : signature[0] === 255 && signature[1] === 216 && signature[2] === 255 ? 'image/jpeg'
      : signature.subarray(0, 4).toString() === 'RIFF' && signature.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;
  if (type !== match[1] || buffer.toString('base64') !== match[2]) throw Object.assign(new Error('El archivo no coincide con una imagen válida.'), { status: 400 });
  if (buffer.length > maxBytes) throw Object.assign(new Error(maxBytes === 500000 ? 'El comprobante comprimido debe pesar como máximo 500 KB.' : 'El comprobante debe pesar como máximo 10 MB.'), { status: 413 });
  return { buffer, type, extension: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[type] };
}
