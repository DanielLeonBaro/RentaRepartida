import { timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

const encoder = new TextEncoder();
const sessionDuration = 7 * 24 * 60 * 60;
const digest = async value => Buffer.from(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
const key = secret => crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
export async function passwordMatches(password, secret) {
  return timingSafeEqual(await digest(password), await digest(secret));
}
function cookieName(url) { return url.protocol === 'https:' ? '__Host-renta_session' : 'renta_session'; }
export async function sessionCookie(secret, url, now = Date.now()) {
  const expires = Math.floor(now / 1000) + sessionDuration;
  const signature = Buffer.from(await crypto.subtle.sign('HMAC', await key(secret), encoder.encode(`${url.origin}:${expires}`))).toString('base64url');
  return `${cookieName(url)}=${expires}.${signature}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionDuration}${url.protocol === 'https:' ? '; Secure' : ''}`;
}
export function clearCookie(url) { return `${cookieName(url)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${url.protocol === 'https:' ? '; Secure' : ''}`; }
export async function hasSession(request, secret, now = Date.now()) {
  const url = new URL(request.url);
  const cookie = request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName(url)}=`))?.split('=')[1];
  if (!cookie) return false;
  const match = /^(\d+)\.([A-Za-z0-9_-]{43})$/.exec(cookie);
  if (!match || +match[1] <= now / 1000 || +match[1] > now / 1000 + sessionDuration + 60) return false;
  return crypto.subtle.verify('HMAC', await key(secret), Buffer.from(match[2], 'base64url'), encoder.encode(`${url.origin}:${match[1]}`));
}
export function loginPage(error = '', target = '/') {
  const destination = ['/', '/sofia', '/daniel'].includes(target) ? target : '/';
  return `<!doctype html><html lang="es-MX"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Entrar · Renta Repartida</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/style.css"></head><body class="login-page"><main class="login-card panel"><a class="brand" href="/"><img src="/favicon.svg" width="38" height="38" alt=""><span>rentarepartida</span></a><h1>Su plan compartido.</h1><p>Ingresa la clave de acceso para consultar sus gastos y aportaciones.</p><form action="/login" method="post"><input type="hidden" name="next" value="${destination}"><label class="field" for="password"><span>Clave de acceso</span><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256" autofocus></label>${error ? `<p class="notice error" role="alert">${error}</p>` : ''}<button class="button primary" type="submit">Entrar a nuestro calendario</button></form><p class="form-help">Una clave para Sofía y Daniel. Sus datos y comprobantes son privados.</p></main></body></html>`;
}
