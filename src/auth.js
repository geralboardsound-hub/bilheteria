/* Autenticação da equipa: PBKDF2-SHA256 (WebCrypto) + sessão em cookie HttpOnly.

   Atenção ao limite do Cloudflare: o runtime de produção recusa PBKDF2 acima de
   100 000 iterações ("iteration counts above 100000 are not supported") e o plano
   gratuito tem orçamento de CPU por pedido. O custo fica em ITERATIONS, abaixo do
   tecto e dentro do orçamento. Registos antigos com custo superior são convertidos
   automaticamente no arranque (ver schema.js). */

import { base64url, sha256hex } from './db.js';

export const ITERATIONS = 20000;
export const MAX_ITERATIONS = 20000;
export const SESSION_COOKIE = 'bs_session';

const toHex = (buffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

const fromHex = (hex) => Uint8Array.from(hex.match(/.{2}/g).map((h) => parseInt(h, 16)));

export async function hashPassword(password, saltHex = null) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    key,
    256
  );
  return { salt: toHex(salt), hash: toHex(bits), iterations: ITERATIONS };
}

export async function verifyPassword(password, user) {
  /* Registos com custo acima do permitido pelo Cloudflare não podem ser verificados
     (o runtime recusa o cálculo). Ficam pendentes de conversão no arranque. */
  if (Number(user.iterations) > MAX_ITERATIONS) return false;
  const candidate = await hashPassword(password, user.salt);
  if (candidate.hash.length !== String(user.hash).length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.hash.length; i++) {
    diff |= candidate.hash.charCodeAt(i) ^ user.hash.charCodeAt(i);
  }
  return diff === 0;
}

export function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

export function sessionCookie(token, request, maxAgeSeconds) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function clearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export async function createSession(env, userId, request) {
  const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  const hours = Number(env.SESSION_HOURS || 12);
  const expires = now + hours * 3600 * 1000;
  await env.DB.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)`
  ).bind(await sha256hex(token), userId, now, expires).run();
  return { token, expires, maxAge: hours * 3600 };
}

export async function currentUser(env, request) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return null;
  const hash = await sha256hex(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role, s.expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND u.active = 1`
  ).bind(hash, Date.now()).first();
  if (!row) return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

export async function destroySession(env, request) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return;
  await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?1`).bind(await sha256hex(token)).run();
}

/* Só aceita pedidos do próprio site (evita CSRF com o cookie de sessão). */
export function sameOrigin(request) {
  if (request.method === 'GET' || request.method === 'HEAD') return true;
  const origin = request.headers.get('Origin');
  const site = request.headers.get('Sec-Fetch-Site');
  if (!origin) return site === 'same-origin' || site === 'none' || site === null;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'local';
}
