/* Utilidades de dados: identificadores, tokens, ocupação e expiração. */

export const RESERVATION_HOURS = 12;

export function id(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const body = [...bytes].map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 8).toUpperCase();
  return `${prefix}-${body}`;
}

export function base64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function newToken(len = 24) {
  return base64url(crypto.getRandomValues(new Uint8Array(len)));
}

export async function sha256hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function slugify(text) {
  return String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, 48) || 'evento';
}

export function num(value) {
  const n = Number(String(value ?? '').replace(/[^\d-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extra
    }
  });
}

/* ---------- lotação ---------- */
export async function capacityOf(env, eventId) {
  const row = await env.DB.prepare(
    `SELECT e.venue_capacity AS cap,
            (SELECT COALESCE(SUM(qty),0) FROM lots WHERE event_id = e.id) AS lot_total
     FROM events e WHERE e.id = ?1`
  ).bind(eventId).first();
  if (!row) return { limit: 0, lotTotal: 0, explicit: false };
  const explicit = num(row.cap) > 0;
  return { limit: explicit ? num(row.cap) : num(row.lot_total), lotTotal: num(row.lot_total), explicit };
}

export async function occupancy(env, eventId, now = Date.now()) {
  const capped = await capacityOf(env, eventId);
  const sold = await env.DB.prepare(
    `SELECT COALESCE(SUM(oi.qty),0) AS n
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.event_id = ?1
       AND o.status IN ('pending','review','confirmed')
       AND (o.status = 'confirmed' OR o.deadline > ?2)`
  ).bind(eventId, now).first();
  const vip = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM credentials WHERE event_id = ?1`
  ).bind(eventId).first();
  const commercial = num(sold?.n);
  const guests = num(vip?.n);
  return {
    commercial,
    vip: guests,
    total: commercial + guests,
    limit: capped.limit,
    free: Math.max(0, capped.limit - commercial - guests),
    explicit: capped.explicit
  };
}

/* ---------- expiração de reservas ---------- */
export async function expireOrders(env, now = Date.now()) {
  const stale = await env.DB.prepare(
    `SELECT id FROM orders WHERE status IN ('pending','review') AND deadline <= ?1`
  ).bind(now).all();
  const rows = stale.results || [];
  if (!rows.length) return 0;
  const statements = [];
  for (const row of rows) {
    statements.push(env.DB.prepare(
      `UPDATE orders SET status = 'expired', message_status = 'prepared'
       WHERE id = ?1 AND status IN ('pending','review')`
    ).bind(row.id));
    statements.push(env.DB.prepare(
      `INSERT INTO order_log (order_id, ts, text) VALUES (?1, ?2, ?3)`
    ).bind(row.id, now, 'Prazo de 12 horas terminado. Reserva cancelada e lugares libertados.'));
  }
  await env.DB.batch(statements);
  return rows.length;
}

/* ---------- leitura de pedidos ---------- */
export async function orderWithItems(env, order) {
  if (!order) return null;
  const items = await env.DB.prepare(
    `SELECT lot_id, name, price, qty FROM order_items WHERE order_id = ?1 ORDER BY id`
  ).bind(order.id).all();
  const log = await env.DB.prepare(
    `SELECT ts, text FROM order_log WHERE order_id = ?1 ORDER BY id`
  ).bind(order.id).all();
  return { ...order, items: items.results || [], log: log.results || [] };
}

export function orderIsRunning(order, now = Date.now()) {
  return ['pending', 'review'].includes(order.status) && order.deadline > now;
}

/* ---------- limite de tentativas ---------- */
export async function rateLimit(env, key, limit, windowMs) {
  const now = Date.now();
  const row = await env.DB.prepare(`SELECT window_start, count FROM rate_limits WHERE key = ?1`).bind(key).first();
  if (!row || now - row.window_start > windowMs) {
    await env.DB.prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET window_start = ?2, count = 1`
    ).bind(key, now).run();
    return { allowed: true, remaining: limit - 1 };
  }
  if (row.count >= limit) return { allowed: false, remaining: 0 };
  await env.DB.prepare(`UPDATE rate_limits SET count = count + 1 WHERE key = ?1`).bind(key).run();
  return { allowed: true, remaining: limit - row.count - 1 };
}
