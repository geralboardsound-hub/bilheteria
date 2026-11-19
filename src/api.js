/* API da bilheteira: público (vendas e reserva) e equipa (autenticada). */

import qrcode from 'qrcode-generator';
import { id, newToken, sha256hex, slugify, num, json, capacityOf, occupancy, expireOrders, orderWithItems, orderIsRunning, rateLimit } from './db.js';
import { hashPassword, verifyPassword, createSession, currentUser, destroySession, sessionCookie, clearCookie, sameOrigin, clientIp, parseCookies, SESSION_COOKIE } from './auth.js';

async function inviteKey(order) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(order.token_hash),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function inviteSignature(order, scope) {
  const signature = await crypto.subtle.sign('HMAC', await inviteKey(order), new TextEncoder().encode(scope));
  return Array.from(new Uint8Array(signature), b => b.toString(16).padStart(2, '0')).join('');
}

async function validInviteSignature(order, scope, signature) {
  const bytes = Uint8Array.from(signature.match(/../g), b => parseInt(b, 16));
  return crypto.subtle.verify('HMAC', await inviteKey(order), bytes, new TextEncoder().encode(scope));
}

const INVITE_SCOPE = 'boardsound:convites:v1';
const invitePath = async order => `/convites/${order.id}/${await inviteSignature(order, INVITE_SCOPE)}`;

const INVITE_HELD_MESSAGE = 'Convites suspensos temporariamente. Contacta a organização para esclarecer a situação.';
const APP_VERSION = '1.4.5';
let inviteReviewReady = false;

async function ensureInviteReview(env) {
  if (inviteReviewReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS invite_review (
      id INTEGER PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id),
      held INTEGER NOT NULL CHECK (held IN (0,1)), reason TEXT NOT NULL,
      actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, ts INTEGER NOT NULL
    )`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_invite_review_order ON invite_review(order_id,id DESC)')
  ]);
  inviteReviewReady = true;
}

async function inviteOnHold(env, orderId) {
  await ensureInviteReview(env);
  const row = await env.DB.prepare('SELECT held FROM invite_review WHERE order_id = ?1 ORDER BY id DESC LIMIT 1').bind(orderId).first();
  return row?.held === 1;
}

async function setInviteHold(request, env, orderId, user, held) {
  const order = await env.DB.prepare('SELECT status FROM orders WHERE id = ?1').bind(orderId).first();
  if (!order) return json({ error: 'not_found', message: 'Reserva não encontrada.' }, 404);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 3 || reason.length > 240) return json({ error: 'reason', message: 'Indica um motivo entre 3 e 240 caracteres.' }, 400);
  await ensureInviteReview(env);
  const result = await env.DB.prepare(`INSERT INTO invite_review (order_id, held, reason, actor_id, actor_name, ts)
    SELECT id, ?2, ?3, ?4, ?5, ?6 FROM orders WHERE id = ?1 AND status = 'confirmed'
      AND COALESCE((SELECT held FROM invite_review WHERE order_id = ?1 ORDER BY id DESC LIMIT 1), 0) != ?2`)
    .bind(orderId, held ? 1 : 0, reason, user.id, user.name, Date.now()).run();
  if (!result.meta?.changes) return json({ error: 'state', message: 'A operação já foi aplicada ou a compra não está confirmada.' }, 409);
  return json({ ok: true, inviteHeld: held });
}

function locateInvite(items, index) {
  if (!Number.isSafeInteger(index) || index < 1) return null;
  for (const item of items) {
    if (index <= item.qty) return item;
    index -= item.qty;
  }
  return null;
}

async function publicInvites(env, request, match) {
  const [, orderId, signature, qrIndex] = match;
  const order = await teamOrder(env, orderId);
  const notFound = () => json({ error: 'not_found', message: 'Convites não disponíveis.' }, 404);
  if (!order?.token_hash || order.status !== 'confirmed') return notFound();
  if (!await validInviteSignature(order, INVITE_SCOPE, signature)) return notFound();
  if (await inviteOnHold(env, orderId)) return json({ error: 'invite_held', message: INVITE_HELD_MESSAGE }, 423);
  if (qrIndex) {
    if (!locateInvite(order.items, Number(qrIndex))) return notFound();
    const qr = qrcode(0, 'M');
    const scanSignature = await inviteSignature(order, `${INVITE_SCOPE}:scan:${qrIndex}`);
    qr.addData(new URL(`/equipa/convites/${order.id}/${qrIndex}/${scanSignature}`, request.url).href);
    qr.make();
    return new Response(qr.createSvgTag({ cellSize: 5, margin: 20, scalable: true }), {
      headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
    });
  }
  const event = await env.DB.prepare('SELECT name, slug, event_date AS date, event_time AS time, venue FROM events WHERE id = ?1').bind(order.event_id).first();
  if (!event) return notFound();
  return json({ event, orderId, groups: order.items.map(({ name, qty }) => ({ name, qty })) });
}

const MAX_FLYER = 1_500_000;
const MAX_PROOF = 2.5 * 1024 * 1024;
const ALLOWED_IMAGES = ['image/jpeg', 'image/png', 'image/webp'];

/* ------------------------------------------------------------------ */
/* leitura auxiliar                                                    */
/* ------------------------------------------------------------------ */
async function lotsFor(env, eventId) {
  const rows = await env.DB.prepare(
    `SELECT id, name, price, qty, position FROM lots WHERE event_id = ?1 ORDER BY position, id`
  ).bind(eventId).all();
  return rows.results || [];
}

async function soldPerLot(env, eventId, now = Date.now()) {
  const rows = await env.DB.prepare(
    `SELECT oi.lot_id AS lot_id, COALESCE(SUM(oi.qty),0) AS n
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.event_id = ?1 AND o.status IN ('pending','review','confirmed')
       AND (o.status = 'confirmed' OR o.deadline > ?2)
     GROUP BY oi.lot_id`
  ).bind(eventId, now).all();
  const map = {};
  for (const r of rows.results || []) map[r.lot_id] = num(r.n);
  return map;
}

function publicEvent(ev, lots, sold, occ) {
  return {
    slug: ev.slug,
    name: ev.name,
    date: ev.event_date || '',
    time: ev.event_time || '',
    venue: ev.venue || '',
    city: ev.city || '',
    description: ev.description || '',
    flyer: ev.flyer_asset ? `/api/public/assets/${ev.flyer_asset}` : '/cartaz-padrao.jpg',
    accent: ev.accent || '#FFC400',
    cover: ev.cover || 'poster',
    headline: ev.headline || '',
    note: ev.note || '',
    support: ev.support_whatsapp || '',
    showCountdown: !!ev.show_countdown,
    showDesc: !!ev.show_desc,
    showNote: !!ev.show_note,
    capacity: occ.limit,
    free: occ.free,
    lots: lots.map(l => ({ id: l.id, name: l.name, price: num(l.price), qty: num(l.qty), available: Math.max(0, num(l.qty) - (sold[l.id] || 0)) }))
  };
}

function clientView(order, ev, occ) {
  return {
    id: order.id,
    status: order.status,
    createdAt: order.created_at,
    deadline: order.deadline,
    confirmedAt: order.confirmed_at || null,
    total: order.total,
    ticketLink: order.status === 'confirmed' ? (order.ticket_link || '') : '',
    hasProof: !!order.proof_asset,
    items: order.items.map(i => ({ name: i.name, qty: i.qty, price: i.price })),
    payment: {
      bank: order.payment_bank, holder: order.payment_holder, iban: order.payment_iban,
      account: order.payment_account, whatsapp: order.payment_whatsapp
    },
    event: ev ? {
      name: ev.name, date: ev.event_date, time: ev.event_time,
      venue: ev.venue, city: ev.city,
      flyer: ev.flyer_asset ? `/api/public/assets/${ev.flyer_asset}` : '/cartaz-padrao.jpg',
      support: ev.support_whatsapp || ''
    } : null,
    free: occ.free
  };
}

function orderSummary(order) {
  return {
    id: order.id,
    eventId: order.event_id,
    eventName: order.event_name,
    buyer: { name: order.buyer_name, phone: order.buyer_phone, aux: order.buyer_aux || '' },
    total: order.total,
    status: order.status,
    createdAt: order.created_at,
    deadline: order.deadline,
    hasProof: !!order.proof_asset,
    proofName: order.proof_name || '',
    operator: order.operator || '',
    bankRef: order.bank_ref || '',
    ticketLink: order.ticket_link || '',
    items: order.items || []
  };
}

async function teamOrder(env, orderId) {
  const row = await env.DB.prepare(
    `SELECT o.*, e.name AS event_name FROM orders o JOIN events e ON e.id = o.event_id WHERE o.id = ?1`
  ).bind(orderId).first();
  return row ? orderWithItems(env, row) : null;
}

function cleanPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits;
}

/* ------------------------------------------------------------------ */
/* rotas públicas                                                      */
/* ------------------------------------------------------------------ */
async function getPublicEvent(env, slug) {
  const ev = await env.DB.prepare(`SELECT * FROM events WHERE slug = ?1 AND status = 'published'`).bind(slug).first();
  if (!ev) return json({ error: 'not_found', message: 'Este evento não está disponível.' }, 404);
  const [lots, sold, occ] = await Promise.all([lotsFor(env, ev.id), soldPerLot(env, ev.id), occupancy(env, ev.id)]);
  return json({ event: publicEvent(ev, lots, sold, occ) });
}

async function createReservation(request, env) {
  const ip = clientIp(request);
  const limit = await rateLimit(env, `reserve:${ip}`, 12, 10 * 60 * 1000);
  if (!limit.allowed) return json({ error: 'rate_limited', message: 'Demasiados pedidos. Aguarda alguns minutos.' }, 429);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }

  const slug = String(body.slug || '');
  const name = String(body.name || '').trim().slice(0, 80);
  const prefix = cleanPhone(body.prefix || '244');
  const national = cleanPhone(body.phone || '');
  const aux = String(body.aux || '').trim().slice(0, 24);
  const items = Array.isArray(body.items) ? body.items.slice(0, 6) : [];

  if (name.length < 2) return json({ error: 'name', message: 'Indica o teu nome.' }, 400);
  if (national.length < 7 || (prefix + national).length > 15) {
    return json({ error: 'phone', message: 'Indica um número de WhatsApp válido, sem indicativo.' }, 400);
  }
  if (!items.length) return json({ error: 'items', message: 'Escolhe pelo menos um ingresso.' }, 400);

  const ev = await env.DB.prepare(`SELECT * FROM events WHERE slug = ?1 AND status = 'published'`).bind(slug).first();
  if (!ev) return json({ error: 'not_found' }, 404);

  const [lots, sold] = await Promise.all([lotsFor(env, ev.id), soldPerLot(env, ev.id)]);
  const chosen = [];
  for (const raw of items) {
    const lot = lots.find(l => l.id === raw.id);
    const qty = Math.floor(num(raw.qty));
    if (!lot || qty < 1) continue;
    if (qty > lot.qty - (sold[lot.id] || 0)) {
      return json({ error: 'sold_out', message: `Já não há lugares suficientes em ${lot.name}.` }, 409);
    }
    chosen.push({ lot, qty });
  }
  if (!chosen.length) return json({ error: 'items', message: 'Escolhe pelo menos um ingresso válido.' }, 400);

  const totalQty = chosen.reduce((s, c) => s + c.qty, 0);
  const total = chosen.reduce((s, c) => s + c.qty * num(c.lot.price), 0);
  const now = Date.now();
  const hours = Number(env.RESERVATION_HOURS || 12);
  const deadline = now + hours * 3600 * 1000;
  const orderId = id('BS');
  const token = newToken(24);
  const tokenHash = await sha256hex(token);

  /* Guarda atómica: capacidade total do recinto (comerciais + VIP) e cada lote,
     avaliadas dentro do próprio INSERT — duas reservas simultâneas não podem
     consumir o mesmo último lugar. */
  const params = [];
  const push = v => { params.push(v); return `?${params.length}`; };

  const P = {
    id: push(orderId), event: push(ev.id), token: push(tokenHash), name: push(name),
    phone: push(`+${prefix}${national}`), aux: push(aux), total: push(total),
    status: push('pending'), created: push(now), deadline: push(deadline),
    bank: push(ev.bank_name || ''), holder: push(ev.bank_holder || ''),
    iban: push(ev.bank_iban || ''), account: push(ev.bank_account || ''),
    whatsapp: push(ev.proof_whatsapp || ev.support_whatsapp || '')
  };

  /* parâmetros reutilizados nas subconsultas da guarda */
  const evParam = `?${params.indexOf(ev.id) + 1}`;
  const nowParam = `?${params.indexOf(now) + 1}`;

  const capacityExpr = `(
      (SELECT CASE WHEN venue_capacity > 0 THEN venue_capacity
                   ELSE (SELECT COALESCE(SUM(qty),0) FROM lots WHERE event_id = ${evParam}) END
       FROM events WHERE id = ${evParam})
    - (SELECT COALESCE(SUM(oi.qty),0) FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.event_id = ${evParam} AND o.status IN ('pending','review','confirmed')
         AND (o.status = 'confirmed' OR o.deadline > ${nowParam}))
    - (SELECT COUNT(*) FROM credentials WHERE event_id = ${evParam})
  )`;

  const clauses = [`${capacityExpr} >= ${push(totalQty)}`];
  for (const c of chosen) {
    const lotP = push(c.lot.id);
    const soldP = push(c.lot.id);
    const qtyP = push(c.qty);
    clauses.push(`((SELECT qty FROM lots WHERE id = ${lotP})
      - (SELECT COALESCE(SUM(oi.qty),0) FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE oi.lot_id = ${soldP} AND o.status IN ('pending','review','confirmed')
           AND (o.status = 'confirmed' OR o.deadline > ${nowParam}))) >= ${qtyP}`);
  }
  const guard = clauses.join(' AND ');

  const insertOrder = env.DB.prepare(
    `INSERT INTO orders (id, event_id, token_hash, buyer_name, buyer_phone, buyer_aux, total, status,
                         created_at, deadline, payment_bank, payment_holder, payment_iban,
                         payment_account, payment_whatsapp)
     SELECT ${P.id}, ${P.event}, ${P.token}, ${P.name}, ${P.phone}, ${P.aux}, ${P.total}, ${P.status},
            ${P.created}, ${P.deadline}, ${P.bank}, ${P.holder}, ${P.iban}, ${P.account}, ${P.whatsapp}
     WHERE ${guard}`
  ).bind(...params);

  /* A inserção do pedido corre sozinha: a guarda de capacidade devolve 0 linhas
     quando não há lugar, e só depois de a confirmar é que gravamos itens e histórico
     (o batch inteiro falharia com FOREIGN KEY se o pedido não tivesse entrado). */
  const ins = await insertOrder.run();
  if (!(ins?.meta?.changes ?? 0)) {
    return json({ error: 'sold_out', message: 'Os lugares esgotaram enquanto reservavas. Escolhe outra quantidade.' }, 409);
  }

  const statements = [];
  for (const c of chosen) {
    statements.push(env.DB.prepare(
      `INSERT INTO order_items (order_id, lot_id, name, price, qty) VALUES (?1, ?2, ?3, ?4, ?5)`
    ).bind(orderId, c.lot.id, c.lot.name, num(c.lot.price), c.qty));
  }
  statements.push(env.DB.prepare(
    `INSERT INTO order_log (order_id, ts, text) VALUES (?1, ?2, ?3)`
  ).bind(orderId, now, `Reserva criada com ${totalQty} ingresso(s). Prazo de ${hours} horas iniciado.`));
  statements.push(env.DB.prepare(
    `INSERT INTO order_log (order_id, ts, text) VALUES (?1, ?2, ?3)`
  ).bind(orderId, now, `Instruções de pagamento preparadas para ${ev.proof_whatsapp || ev.support_whatsapp || 'o WhatsApp da organização'}.`));

  try {
    await env.DB.batch(statements);
  } catch (err) {
    await env.DB.prepare(`DELETE FROM orders WHERE id = ?1`).bind(orderId).run();
    throw err;
  }

  const order = await env.DB.prepare(`SELECT * FROM orders WHERE id = ?1`).bind(orderId).first();
  const full = await orderWithItems(env, order);
  const occ = await occupancy(env, ev.id);
  return json({ token, url: `/r/${token}`, order: clientView(full, ev, occ) }, 201);
}

async function getClientReservation(env, token) {
  const hash = await sha256hex(token);
  const order = await env.DB.prepare(`SELECT * FROM orders WHERE token_hash = ?1`).bind(hash).first();
  if (!order) return json({ error: 'not_found', message: 'Este link não corresponde a nenhuma reserva.' }, 404);

  if (orderIsRunning(order, Date.now()) === false && ['pending', 'review'].includes(order.status) && order.deadline <= Date.now()) {
    await expireOrders(env);
  }
  const fresh = await env.DB.prepare(`SELECT * FROM orders WHERE id = ?1`).bind(order.id).first();
  const ev = await env.DB.prepare(`SELECT * FROM events WHERE id = ?1`).bind(fresh.event_id).first();
  const full = await orderWithItems(env, fresh);
  const occ = await occupancy(env, fresh.event_id);
  const view = clientView(full, ev, occ);
  if (fresh.status === 'confirmed') {
    view.inviteHeld = await inviteOnHold(env, fresh.id);
    view.ticketLink = view.inviteHeld ? '' : await invitePath(fresh);
  }
  return json({ order: view });
}

/* ------------------------------------------------------------------ */
/* equipa                                                              */
/* ------------------------------------------------------------------ */
async function login(request, env) {
  const ip = clientIp(request);
  const limit = await rateLimit(env, `login:${ip}`, 8, 15 * 60 * 1000);
  if (!limit.allowed) return json({ error: 'rate_limited', message: 'Demasiadas tentativas. Tenta mais tarde.' }, 429);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) return json({ error: 'credentials', message: 'Indica o email e a palavra-passe.' }, 400);

  const user = await env.DB.prepare(`SELECT * FROM users WHERE email = ?1 AND active = 1`).bind(email).first();
  if (!user || !(await verifyPassword(password, user))) {
    return json({ error: 'credentials', message: 'Email ou palavra-passe incorretos.' }, 401);
  }
  const session = await createSession(env, user.id, request);
  return json(
    { user: { id: user.id, email: user.email, name: user.name, role: user.role } },
    200,
    { 'set-cookie': sessionCookie(session.token, request, session.maxAge) }
  );
}

async function createTeammate(request, env, user) {
  if (user.role !== 'admin') return json({ error: 'forbidden', message: 'Só administradores criam contas.' }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const email = String(body.email || '').trim().toLowerCase();
  const name = String(body.name || '').trim().slice(0, 60);
  const password = String(body.password || '');
  const role = body.role === 'admin' ? 'admin' : 'operator';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'email', message: 'Email inválido.' }, 400);
  if (password.length < 10) return json({ error: 'password', message: 'A palavra-passe precisa de pelo menos 10 caracteres.' }, 400);
  const exists = await env.DB.prepare(`SELECT id FROM users WHERE email = ?1`).bind(email).first();
  if (exists) return json({ error: 'exists', message: 'Já existe uma conta com este email.' }, 409);
  const cred = await hashPassword(password);
  await env.DB.prepare(
    `INSERT INTO users (id, email, name, role, salt, hash, iterations, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  ).bind(id('u'), email, name, role, cred.salt, cred.hash, cred.iterations, Date.now()).run();
  return json({ ok: true }, 201);
}


async function changePassword(request, env, user) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const currentPassword = String(body.currentPassword || '');
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < 10) {
    return json({ error: 'password', message: 'A nova palavra-passe precisa de pelo menos 10 caracteres.' }, 400);
  }
  const row = await env.DB.prepare(
    `SELECT salt, hash, iterations FROM users WHERE id = ?1 AND active = 1`
  ).bind(user.id).first();
  if (!row) return json({ error: 'not_found', message: 'Conta não encontrada.' }, 404);

  if (!(await verifyPassword(currentPassword, row))) {
    return json({ error: 'wrong_password', message: 'A palavra-passe atual não confere.' }, 403);
  }
  const cred = await hashPassword(newPassword);
  await env.DB.prepare(
    `UPDATE users SET salt = ?1, hash = ?2, iterations = ?3 WHERE id = ?4`
  ).bind(cred.salt, cred.hash, cred.iterations, user.id).run();

  /* as outras sessões caem; esta mantém-se */
  const token = parseCookies(request)['bs_session'] || '';
  await env.DB.prepare(
    `DELETE FROM sessions WHERE user_id = ?1 AND token_hash != ?2`
  ).bind(user.id, await sha256hex(token)).run();

  return json({ ok: true });
}

/* ---------- eventos (equipa) ---------- */
async function listEvents(env) {
  const rows = await env.DB.prepare(
    `SELECT e.*, (SELECT COUNT(*) FROM orders o WHERE o.event_id = e.id) AS order_count
     FROM events e ORDER BY COALESCE(e.published_at, e.created_at) DESC`
  ).all();
  const out = [];
  for (const ev of rows.results || []) {
    const occ = await occupancy(env, ev.id);
    out.push({
      id: ev.id, slug: ev.slug, name: ev.name, date: ev.event_date, time: ev.event_time,
      venue: ev.venue, city: ev.city, status: ev.status, publishedAt: ev.published_at,
      flyer: ev.flyer_asset ? `/api/team/assets/${ev.flyer_asset}` : '/cartaz-padrao.jpg',
      occupancy: occ, orders: num(ev.order_count),
      revenue: num((await env.DB.prepare(
        `SELECT COALESCE(SUM(total),0) AS s FROM orders WHERE event_id = ?1 AND status = 'confirmed'`
      ).bind(ev.id).first())?.s)
    });
  }
  return json({ events: out });
}

async function eventDetail(env, eventId) {
  const ev = await env.DB.prepare(`SELECT * FROM events WHERE id = ?1`).bind(eventId).first();
  if (!ev) return json({ error: 'not_found' }, 404);
  const [lots, occ, credentials, orders] = await Promise.all([
    lotsFor(env, ev.id),
    occupancy(env, ev.id),
    env.DB.prepare(`SELECT * FROM credentials WHERE event_id = ?1 ORDER BY created_at DESC`).bind(ev.id).all(),
    env.DB.prepare(
      `SELECT o.*, e.name AS event_name FROM orders o JOIN events e ON e.id = o.event_id
       WHERE o.event_id = ?1 ORDER BY o.created_at DESC LIMIT 200`
    ).bind(ev.id).all()
  ]);
  const sold = await soldPerLot(env, ev.id);
  const revenue = num((await env.DB.prepare(
    `SELECT COALESCE(SUM(total),0) AS s FROM orders WHERE event_id = ?1 AND status = 'confirmed'`
  ).bind(ev.id).first())?.s);
  const orderRows = [];
  for (const o of orders.results || []) {
    orderRows.push({ ...o, items: (await env.DB.prepare(`SELECT lot_id, name, price, qty FROM order_items WHERE order_id = ?1`).bind(o.id).all()).results || [] });
  }
  return json({
    event: {
      id: ev.id, slug: ev.slug, name: ev.name, date: ev.event_date, time: ev.event_time,
      venue: ev.venue, city: ev.city, description: ev.description, status: ev.status,
      flyer: ev.flyer_asset ? `/api/team/assets/${ev.flyer_asset}` : '/cartaz-padrao.jpg',
      accent: ev.accent, cover: ev.cover, headline: ev.headline, note: ev.note,
      support: ev.support_whatsapp, bankName: ev.bank_name, bankHolder: ev.bank_holder,
      bankIban: ev.bank_iban, bankAccount: ev.bank_account, proofWhatsapp: ev.proof_whatsapp,
      showCountdown: !!ev.show_countdown, showDesc: !!ev.show_desc, showNote: !!ev.show_note,
      venueCapacity: num(ev.venue_capacity), publishedAt: ev.published_at
    },
    lots: lots.map(l => ({ id: l.id, name: l.name, price: num(l.price), qty: num(l.qty), sold: sold[l.id] || 0 })),
    occupancy: occ, credentials: credentials.results || [], orders: orderRows, revenue
  });
}

function readEventPayload(body) {
  const clean = v => String(v ?? '').trim();
  const lots = Array.isArray(body.lots) ? body.lots.slice(0, 8) : [];
  return {
    name: clean(body.name).slice(0, 70),
    date: clean(body.date).slice(0, 10),
    time: clean(body.time).slice(0, 5) || '20:00',
    venue: clean(body.venue).slice(0, 90),
    city: clean(body.city).slice(0, 60),
    description: clean(body.description).slice(0, 240),
    accent: /^#[0-9A-Fa-f]{6}$/.test(body.accent || '') ? body.accent : '#FFC400',
    cover: ['poster', 'band', 'type'].includes(body.cover) ? body.cover : 'poster',
    headline: clean(body.headline).slice(0, 70),
    note: clean(body.note).slice(0, 120),
    support: clean(body.support).slice(0, 24),
    bankName: clean(body.bankName).slice(0, 40),
    bankHolder: clean(body.bankHolder).slice(0, 80),
    bankIban: clean(body.bankIban).slice(0, 40),
    bankAccount: clean(body.bankAccount).slice(0, 40),
    proofWhatsapp: clean(body.proofWhatsapp).slice(0, 24),
    showCountdown: body.showCountdown ? 1 : 0,
    showDesc: body.showDesc ? 1 : 0,
    showNote: body.showNote ? 1 : 0,
    flyerAsset: body.flyerAsset ? String(body.flyerAsset).slice(0, 40) : null,
    lots: lots.map((l, index) => ({
      id: String(l.id || id('lot')).slice(0, 40),
      name: clean(l.name).slice(0, 40),
      price: num(l.price),
      qty: num(l.qty),
      position: index
    })).filter(l => l.name)
  };
}

function validateEventPayload(p) {
  const errors = {};
  if (!p.name) errors.name = 'Indica o nome do evento.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date)) errors.date = 'Indica a data.';
  if (!p.venue) errors.venue = 'Indica o local.';
  if (!p.lots.length || !p.lots.every(l => l.price > 0 && l.qty > 0)) errors.lots = 'Cada lote precisa de preço e lugares.';
  if (!p.bankHolder) errors.bankHolder = 'Indica o titular da conta.';
  if (!p.bankIban) errors.bankIban = 'Indica o IBAN.';
  if (cleanPhone(p.proofWhatsapp).length < 9) errors.proofWhatsapp = 'Indica o WhatsApp que recebe comprovativos.';
  if (p.flyerAsset) { /* validado na publicação */ }
  return errors;
}

async function saveEvent(request, env, eventId) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const p = readEventPayload(body);
  const errors = validateEventPayload(p);
  const existing = eventId
    ? await env.DB.prepare(`SELECT * FROM events WHERE id = ?1`).bind(eventId).first()
    : null;

  if (p.flyerAsset) {
    const asset = await env.DB.prepare(`SELECT id FROM assets WHERE id = ?1`).bind(p.flyerAsset).first();
    if (!asset) errors.flyer = 'O cartaz não foi encontrado. Carrega de novo.';
  }
  if (Object.keys(errors).length) return json({ error: 'validation', errors }, 400);

  const now = Date.now();
  if (existing) {
    await env.DB.prepare(
      `UPDATE events SET name=?2, event_date=?3, event_time=?4, venue=?5, city=?6, description=?7,
        accent=?8, cover=?9, headline=?10, note=?11, support_whatsapp=?12, bank_name=?13,
        bank_holder=?14, bank_iban=?15, bank_account=?16, proof_whatsapp=?17,
        show_countdown=?18, show_desc=?19, show_note=?20, flyer_asset=COALESCE(?21, flyer_asset),
        updated_at=?22
       WHERE id=?1`
    ).bind(existing.id, p.name, p.date, p.time, p.venue, p.city, p.description, p.accent, p.cover,
      p.headline, p.note, p.support, p.bankName, p.bankHolder, p.bankIban, p.bankAccount,
      p.proofWhatsapp, p.showCountdown, p.showDesc, p.showNote, p.flyerAsset, now).run();

    const keep = p.lots.map(l => l.id);
    const current = await lotsFor(env, existing.id);
    const removed = current.filter(l => !keep.includes(l.id));
    const usedIds = new Set((await env.DB.prepare(
      `SELECT DISTINCT lot_id FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.event_id = ?1 AND o.status IN ('pending','review','confirmed')`
    ).bind(existing.id).all()).results.map(r => r.lot_id));

    for (const lot of removed) {
      if (usedIds.has(lot.id)) {
        return json({ error: 'lot_in_use', message: 'Não é possível remover um lote com reservas ativas.' }, 409);
      }
      await env.DB.prepare(`DELETE FROM lots WHERE id = ?1`).bind(lot.id).run();
    }
    for (const lot of p.lots) {
      if (current.some(l => l.id === lot.id)) {
        await env.DB.prepare(`UPDATE lots SET name=?2, price=?3, qty=?4, position=?5 WHERE id=?1`)
          .bind(lot.id, lot.name, lot.price, lot.qty, lot.position).run();
      } else {
        await env.DB.prepare(`INSERT INTO lots (id, event_id, name, price, qty, position) VALUES (?1,?2,?3,?4,?5,?6)`)
          .bind(lot.id, existing.id, lot.name, lot.price, lot.qty, lot.position).run();
      }
    }
    const detail = JSON.parse(await (await eventDetail(env, existing.id)).text());
    return json(detail);
  }

  const newId = id('ev');
  let base = slugify(p.name), slug = base, suffix = 2;
  while (await env.DB.prepare(`SELECT id FROM events WHERE slug = ?1`).bind(slug).first()) slug = `${base}-${suffix++}`;

  const statements = [env.DB.prepare(
    `INSERT INTO events (id, slug, name, event_date, event_time, venue, city, description, flyer_asset,
       accent, cover, headline, note, support_whatsapp, bank_name, bank_holder, bank_iban, bank_account,
       proof_whatsapp, show_countdown, show_desc, show_note, status, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,'draft',?23,?23)`
  ).bind(newId, slug, p.name, p.date, p.time, p.venue, p.city, p.description, p.flyerAsset,
    p.accent, p.cover, p.headline, p.note, p.support, p.bankName, p.bankHolder, p.bankIban,
    p.bankAccount, p.proofWhatsapp, p.showCountdown, p.showDesc, p.showNote, now)];
  for (const lot of p.lots) {
    statements.push(env.DB.prepare(
      `INSERT INTO lots (id, event_id, name, price, qty, position) VALUES (?1,?2,?3,?4,?5,?6)`
    ).bind(lot.id, newId, lot.name, lot.price, lot.qty, lot.position));
  }
  await env.DB.batch(statements);
  const detail = JSON.parse(await (await eventDetail(env, newId)).text());
  return json(detail, 201);
}

async function publishEvent(env, eventId) {
  const ev = await env.DB.prepare(`SELECT * FROM events WHERE id = ?1`).bind(eventId).first();
  if (!ev) return json({ error: 'not_found' }, 404);
  const lots = await lotsFor(env, ev.id);
  if (!lots.length) return json({ error: 'lots', message: 'Adiciona pelo menos um lote com preço e quantidade antes de publicar.' }, 400);
  await env.DB.prepare(
    `UPDATE events SET status='published', published_at=COALESCE(published_at, ?2), updated_at=?2 WHERE id=?1`
  ).bind(ev.id, Date.now()).run();
  return json({ ok: true, slug: ev.slug, url: `/e/${ev.slug}` });
}

async function setCapacity(request, env, eventId) {
  const ev = await env.DB.prepare(`SELECT id FROM events WHERE id = ?1`).bind(eventId).first();
  if (!ev) return json({ error: 'not_found' }, 404);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const value = Math.floor(num(body.venueCapacity));
  if (!Number.isSafeInteger(value) || value < 1) return json({ error: 'capacity', message: 'Indica uma capacidade inteira superior a zero.' }, 400);
  const occ = await occupancy(env, eventId);
  if (value < occ.total) return json({ error: 'capacity_below', message: 'A capacidade não pode ser inferior à ocupação atual.', occupancy: occ }, 409);
  await env.DB.prepare(`UPDATE events SET venue_capacity = ?2, updated_at = ?3 WHERE id = ?1`)
    .bind(eventId, value, Date.now()).run();
  return json({ ok: true, occupancy: await occupancy(env, eventId) });
}

/* ---------- reservas (equipa) ---------- */
async function listOrders(env, url) {
  const status = url.searchParams.get('status') || '';
  const eventId = url.searchParams.get('eventId') || '';
  const where = [];
  const params = [];
  if (['pending', 'review', 'confirmed', 'expired'].includes(status)) { params.push(status); where.push(`o.status = ?${params.length}`); }
  if (eventId) { params.push(eventId); where.push(`o.event_id = ?${params.length}`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = await env.DB.prepare(
    `SELECT o.*, e.name AS event_name FROM orders o JOIN events e ON e.id = o.event_id
     ${clause} ORDER BY o.created_at DESC LIMIT 300`
  ).bind(...params).all();
  const out = [];
  for (const o of rows.results || []) {
    out.push(orderSummary({ ...o, items: (await env.DB.prepare(`SELECT name, price, qty FROM order_items WHERE order_id = ?1`).bind(o.id).all()).results || [] }));
  }
  return json({ orders: out });
}

async function orderDetailForTeam(env, orderId) {
  const order = await teamOrder(env, orderId);
  if (!order) return json({ error: 'not_found' }, 404);
  const ev = await env.DB.prepare(`SELECT * FROM events WHERE id = ?1`).bind(order.event_id).first();
  const occ = await occupancy(env, order.event_id);
  if (order.status === 'confirmed') await ensureInviteReview(env);
  const history = order.status === 'confirmed' ? (await env.DB.prepare(`SELECT held, reason, actor_name, ts FROM invite_review
    WHERE order_id = ?1 ORDER BY id DESC`).bind(orderId).all()).results : [];
  const inviteHeld = history[0]?.held === 1;
  return json({
    order: { ...orderSummary(order), inviteHeld, ticketLink: order.status === 'confirmed' && !inviteHeld ? await invitePath(order) : '' },
    payment: {
      bank: order.payment_bank || '', holder: order.payment_holder || '',
      iban: order.payment_iban || '', account: order.payment_account || '',
      whatsapp: order.payment_whatsapp || ''
    },
    log: [...order.log, ...history.map(h => ({ ts: h.ts, text: `Convites ${h.held ? 'suspensos' : 'reativados'} por ${h.actor_name}: ${h.reason}` }))].sort((a,b) => a.ts - b.ts),
    proofName: order.proof_name, occupancy: occ,
    event: { name: ev?.name, slug: ev?.slug }
  });
}

async function uploadAsset(request, env, kind, uploadedBy) {
  const type = (request.headers.get('content-type') || '').split(';')[0].trim();
  if (!ALLOWED_IMAGES.includes(type)) return json({ error: 'type', message: 'Envia uma imagem JPG, PNG ou WEBP.' }, 415);
  const buffer = await request.arrayBuffer();
  const max = kind === 'proof' ? MAX_PROOF : MAX_FLYER;
  if (!buffer.byteLength) return json({ error: 'empty', message: 'O ficheiro está vazio.' }, 400);
  if (buffer.byteLength > max) {
    return json({ error: 'size', message: `Imagem com ${Math.round(buffer.byteLength / 1024)} KB — o limite é ${Math.round(max / 1024)} KB. Escolhe uma imagem mais leve.` }, 413);
  }
  const assetId = id('as');
  await env.DB.prepare(
    `INSERT INTO assets (id, mime, bytes, blob, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`
  ).bind(assetId, type, buffer.byteLength, buffer, Date.now()).run();
  return json({ assetId, bytes: buffer.byteLength, uploadedBy, stored: true }, 201);
}

async function attachProof(request, env, orderId, user) {
  const order = await env.DB.prepare(`SELECT * FROM orders WHERE id = ?1`).bind(orderId).first();
  if (!order) return json({ error: 'not_found' }, 404);
  if (!orderIsRunning(order)) return json({ error: 'closed', message: 'A reserva já não está ativa.' }, 409);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const assetId = String(body.assetId || '');
  const asset = await env.DB.prepare(`SELECT id, mime, bytes FROM assets WHERE id = ?1`).bind(assetId).first();
  if (!asset) return json({ error: 'asset', message: 'O ficheiro não foi encontrado.' }, 400);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE orders SET proof_asset = ?2, proof_name = ?3, proof_uploaded_at = ?4, status = 'review'
       WHERE id = ?1 AND status IN ('pending','review')`
    ).bind(orderId, assetId, String(body.filename || 'comprovativo').slice(0, 90), Date.now()),
    env.DB.prepare(`INSERT INTO order_log (order_id, ts, text) VALUES (?1, ?2, ?3)`)
      .bind(orderId, Date.now(), `Comprovativo anexado por ${user.name}. O prazo mantém-se.`)
  ]);
  return json({ ok: true });
}

async function confirmOrder(request, env, orderId, user) {
  const order = await env.DB.prepare(`SELECT * FROM orders WHERE id = ?1`).bind(orderId).first();
  if (!order) return json({ error: 'not_found' }, 404);
  if (order.status === 'confirmed') return json({ error: 'already', message: 'Esta compra já foi confirmada.' }, 409);
  if (!orderIsRunning(order)) return json({ error: 'expired', message: 'O prazo terminou. Não é possível confirmar.' }, 409);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const operator = String(body.operator || '').trim().slice(0, 60);
  const bankRef = String(body.bankRef || '').trim().slice(0, 60);
  const amount = num(body.amount);
  if (!operator || !bankRef) return json({ error: 'fields', message: 'Indica quem conferiu e a referência do movimento.' }, 400);
  if (amount !== order.total) {
    return json({ error: 'amount', message: `O montante recebido não corresponde ao total de ${order.total} Kz.`, expected: order.total }, 409);
  }

  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE orders SET status='confirmed', operator=?2, bank_ref=?3, confirmed_at=?4,
        ticket_link = COALESCE(NULLIF(?5,''), ticket_link)
       WHERE id=?1 AND status IN ('pending','review') AND deadline > ?4`
    ).bind(orderId, operator, bankRef, now, String(body.ticketLink || '').trim().slice(0, 500)),
    env.DB.prepare(`INSERT INTO order_log (order_id, ts, text) VALUES (?1, ?2, ?3)`)
      .bind(orderId, now, `Pagamento confirmado por ${operator} · movimento ${bankRef} · montante ${order.total} Kz.`)
  ]);
  if (!(results[0]?.meta?.changes ?? 0)) return json({ error: 'expired', message: 'O prazo terminou antes da confirmação.' }, 409);
  return json({ ok: true });
}

async function setTicketLink(request, env, orderId) {
  const order = await env.DB.prepare(`SELECT * FROM orders WHERE id = ?1`).bind(orderId).first();
  if (!order) return json({ error: 'not_found' }, 404);
  if (order.status !== 'confirmed') return json({ error: 'state', message: 'Só reservas confirmadas podem ter link de ingresso.' }, 409);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const link = String(body.ticketLink || '').trim().slice(0, 500);
  if (link && !/^https?:\/\//i.test(link)) return json({ error: 'url', message: 'Indica um link http ou https.' }, 400);
  await env.DB.batch([
    env.DB.prepare(`UPDATE orders SET ticket_link = ?2 WHERE id = ?1`).bind(orderId, link),
    env.DB.prepare(`INSERT INTO order_log (order_id, ts, text) VALUES (?1, ?2, ?3)`)
      .bind(orderId, Date.now(), link ? 'Link do ingresso atualizado.' : 'Link do ingresso removido.')
  ]);
  return json({ ok: true });
}

async function forceExpire(env, orderId) {
  const order = await env.DB.prepare(`SELECT * FROM orders WHERE id = ?1`).bind(orderId).first();
  if (!order) return json({ error: 'not_found' }, 404);
  if (!['pending', 'review'].includes(order.status)) return json({ error: 'state' }, 409);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE orders SET status='expired' WHERE id = ?1`).bind(orderId),
    env.DB.prepare(`INSERT INTO order_log (order_id, ts, text) VALUES (?1, ?2, ?3)`)
      .bind(orderId, now, 'Reserva cancelada manualmente pela equipa. Lugares libertados.')
  ]);
  return json({ ok: true });
}

/* ---------- credenciamento VIP ---------- */
async function createCredential(request, env, user) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
  const eventId = String(body.eventId || '');
  const name = String(body.name || '').trim().slice(0, 80);
  const invitedBy = String(body.invitedBy || '').trim().slice(0, 80);
  const origin = body.origin === 'artist' ? 'artist' : 'production';
  const prefix = cleanPhone(body.prefix || '244');
  const national = cleanPhone(body.phone || '');
  const phone = national ? `+${prefix}${national}` : '';
  const ticketLink = String(body.ticketLink || '').trim().slice(0, 500);
  const notes = String(body.notes || '').trim().slice(0, 300);

  if (!eventId) return json({ error: 'event', message: 'Evento inválido.' }, 400);
  if (name.length < 2) return json({ error: 'name', message: 'Indica o nome do convidado.' }, 400);
  if (!invitedBy) return json({ error: 'invitedBy', message: 'Indica quem convidou.' }, 400);
  if (national && (national.length < 7 || (prefix + national).length > 15)) {
    return json({ error: 'phone', message: 'Confirma o número sem indicativo.' }, 400);
  }
  if (ticketLink && !/^https?:\/\//i.test(ticketLink)) return json({ error: 'url', message: 'Link inválido.' }, 400);

  const ev = await env.DB.prepare(`SELECT id FROM events WHERE id = ?1`).bind(eventId).first();
  if (!ev) return json({ error: 'not_found' }, 404);

  await expireOrders(env);
  const occ = await occupancy(env, eventId);
  if (occ.free < 1) return json({ error: 'full', message: 'Lotação esgotada. Não é possível credenciar mais convidados.', occupancy: occ }, 409);

  const credentialId = id('VIP');
  await env.DB.prepare(
    `INSERT INTO credentials (id, event_id, name, origin, invited_by, operator, phone, ticket_link, notes, created_at, created_by)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`
  ).bind(credentialId, eventId, name, origin, invitedBy, user.name, phone, ticketLink, notes, Date.now(), user.id).run();
  return json({ ok: true, id: credentialId, occupancy: await occupancy(env, eventId) }, 201);
}

/* ------------------------------------------------------------------ */
/* encaminhador                                                        */
/* ------------------------------------------------------------------ */
export async function api(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/api';
  const method = request.method.toUpperCase();

  if (!sameOrigin(request) && method !== 'GET') {
    return json({ error: 'csrf' }, 403);
  }

  if (path === '/api/diag/asset' && method === 'GET') {
    const marca = 'diag-' + Math.random().toString(36).slice(2, 10);
    const tamanho = 300 * 1024;
    const bytes = new Uint8Array(tamanho);
    for (let i = 0; i < tamanho; i++) bytes[i] = 255;
    try {
      await env.DB.prepare(`INSERT INTO assets (id, mime, bytes, blob, created_at) VALUES (?1, 'image/jpeg', ?2, ?3, ?4)`)
        .bind(marca, tamanho, bytes, Date.now()).run();
      const lido = await env.DB.prepare(`SELECT bytes, length(blob) AS n FROM assets WHERE id = ?1`).bind(marca).first();
      await env.DB.prepare(`DELETE FROM assets WHERE id = ?1`).bind(marca).run();
      return json({ ok: true, escrito: tamanho, registado: num(lido?.bytes), bytesGravados: num(lido?.n), limite: '2 MB por linha (D1)' });
    } catch (err) {
      return json({ ok: false, error: String((err && err.message) || err), tamanhoTestado: tamanho }, 500);
    }
  }

  if (path === '/api/diag/auth' && method === 'GET') {
    try {
      const t0 = Date.now();
      const cred = await hashPassword('teste-de-diagnostico');
      const confere = await verifyPassword('teste-de-diagnostico', cred);
      return json({ ok: confere, scheme: 'pbkdf2-sha256', iterations: cred.iterations, ms: Date.now() - t0 });
    } catch (err) {
      return json({ ok: false, error: String((err && err.message) || err) }, 500);
    }
  }

  if (path === '/api/diag' && method === 'GET') {
    try {
      const u = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first();
      const a = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1`).first();
      const e = await env.DB.prepare(`SELECT COUNT(*) AS n FROM events`).first();
      return json({ ok: true, version: APP_VERSION, users: num(u?.n), admins: num(a?.n), events: num(e?.n) });
    } catch (err) {
      return json({ ok: false, version: APP_VERSION, error: String((err && err.message) || err) }, 500);
    }
  }

  /* ---- público ---- */
  if (path === '/api/public/events' || path.startsWith('/api/public/events/')) {
    const slug = path.split('/')[4];
    if (method === 'GET' && slug) return getPublicEvent(env, slug);
    return json({ error: 'not_found' }, 404);
  }

  const publicAsset = path.match(/^\/api\/public\/assets\/([\w-]+)$/);
  if (publicAsset && method === 'GET') {
    const asset = await env.DB.prepare(`SELECT mime, blob FROM assets WHERE id = ?1`).bind(publicAsset[1]).first();
    if (!asset) return new Response('Não encontrado', { status: 404 });
    return new Response(asset.blob, {
      headers: { 'content-type': asset.mime, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' }
    });
  }

  if (path === '/api/public/reservations' && method === 'POST') return createReservation(request, env);

  const clientRes = path.match(/^\/api\/public\/reservations\/([\w-]+)$/);
  if (clientRes && method === 'GET') return getClientReservation(env, clientRes[1]);

  const invite = path.match(/^\/api\/public\/convites\/([\w-]+)\/([a-f0-9]{64})(?:\/qr\/([1-9][0-9]{0,8}))?$/);
  if (invite && method === 'GET') return publicInvites(env, request, invite);

  /* ---- autenticação ---- */
  if (path === '/api/auth/login' && method === 'POST') return login(request, env);
  if (path === '/api/setup') {
    return json({ error: 'gone', message: 'A instalação já está feita. Entra em /entrar com a conta da equipa.' }, 410);
  }

  const user = await currentUser(env, request);

  if (path === '/api/auth/me' && method === 'GET') {
    if (!user) return json({ user: null }, 200);
    return json({ user });
  }
  if (path === '/api/auth/logout' && method === 'POST') {
    await destroySession(env, request);
    return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
  }

  if (!user) return json({ error: 'unauthenticated', message: 'Sessão expirada. Entra novamente.' }, 401);

  /* ---- equipa ---- */
  const scan = path.match(/^\/api\/team\/convites\/([\w-]+)\/([1-9][0-9]{0,8})\/([a-f0-9]{64})$/);
  if (scan && method === 'GET') {
    const order = await teamOrder(env, scan[1]);
    const item = order?.status === 'confirmed' && locateInvite(order.items, Number(scan[2]));
    if (!item || !order.token_hash || !await validInviteSignature(order, `${INVITE_SCOPE}:scan:${scan[2]}`, scan[3])) return json({ error: 'not_found', message: 'Convite não encontrado ou compra não confirmada.' }, 404);
    if (await inviteOnHold(env, order.id)) return json({ error: 'invite_held', message: 'Convite suspenso. Não autorizes a entrada até a organização o reativar.' }, 423);
    return json({ reference: `${order.id}-${scan[2]}`, event: order.event_name, lot: item.name });
  }
  if (path === '/api/team/overview' && method === 'GET') {
    const events = await env.DB.prepare(`SELECT COUNT(*) AS n FROM events`).first();
    const sold = await env.DB.prepare(
      `SELECT COALESCE(SUM(oi.qty),0) AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.status IN ('pending','review','confirmed') AND (o.status='confirmed' OR o.deadline > ?1)`
    ).bind(Date.now()).first();
    const active = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM orders WHERE status IN ('pending','review') AND deadline > ?1`
    ).bind(Date.now()).first();
    const revenue = await env.DB.prepare(`SELECT COALESCE(SUM(total),0) AS s FROM orders WHERE status='confirmed'`).first();
    return json({ events: num(events?.n), sold: num(sold?.n), active: num(active?.n), revenue: num(revenue?.s) });
  }

  if (path === '/api/team/events' && method === 'GET') return listEvents(env);
  if (path === '/api/team/events' && method === 'POST') return saveEvent(request, env, null);

  const eventMatch = path.match(/^\/api\/team\/events\/([\w-]+)(\/[a-z-]+)?$/);
  if (eventMatch) {
    const eventId = eventMatch[1];
    const action = eventMatch[2] || '';
    if (method === 'GET' && !action) return eventDetail(env, eventId);
    if (method === 'POST' && !action) return saveEvent(request, env, eventId);
    if (method === 'POST' && action === '/publish') return publishEvent(env, eventId);
    if (method === 'POST' && action === '/capacity') return setCapacity(request, env, eventId);
  }

  if (path === '/api/team/assets' && method === 'POST') {
    const kind = url.searchParams.get('kind') === 'proof' ? 'proof' : 'flyer';
    return uploadAsset(request, env, kind, user.name);
  }

  const teamAsset = path.match(/^\/api\/team\/assets\/([\w-]+)$/);
  if (teamAsset && method === 'GET') {
    const asset = await env.DB.prepare(`SELECT mime, blob FROM assets WHERE id = ?1`).bind(teamAsset[1]).first();
    if (!asset) return new Response('Não encontrado', { status: 404 });
    return new Response(asset.blob, {
      headers: { 'content-type': asset.mime, 'cache-control': 'private, max-age=0', 'x-content-type-options': 'nosniff' }
    });
  }

  if (path === '/api/team/orders' && method === 'GET') return listOrders(env, url);

  const orderMatch = path.match(/^\/api\/team\/orders\/([\w-]+)(\/[a-z-]+)?$/);
  if (orderMatch) {
    const orderId = orderMatch[1];
    const action = orderMatch[2] || '';
    if (method === 'GET' && !action) return orderDetailForTeam(env, orderId);
    if (method === 'GET' && action === '/proof') {
      const row = await env.DB.prepare(`SELECT proof_asset FROM orders WHERE id = ?1`).bind(orderId).first();
      if (!row?.proof_asset) return new Response('Sem comprovativo', { status: 404 });
      const asset = await env.DB.prepare(`SELECT mime, blob FROM assets WHERE id = ?1`).bind(row.proof_asset).first();
      if (!asset) return new Response('Não encontrado', { status: 404 });
      return new Response(asset.blob, {
        headers: { 'content-type': asset.mime, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }
      });
    }
    if (method === 'POST' && action === '/proof') return attachProof(request, env, orderId, user);
    if (method === 'POST' && action === '/confirm') return confirmOrder(request, env, orderId, user);
    if (method === 'POST' && action === '/hold-invites') return setInviteHold(request, env, orderId, user, true);
    if (method === 'POST' && action === '/release-invites') return setInviteHold(request, env, orderId, user, false);
    if (method === 'POST' && action === '/ticket-link') return setTicketLink(request, env, orderId);
    if (method === 'POST' && action === '/expire') return forceExpire(env, orderId);
  }

  if (path === '/api/team/credentials' && method === 'POST') return createCredential(request, env, user);

  if (path === '/api/team/users' && method === 'POST') return createTeammate(request, env, user);
  if (path === '/api/team/password' && method === 'POST') return changePassword(request, env, user);

  return json({ error: 'not_found' }, 404);
}
