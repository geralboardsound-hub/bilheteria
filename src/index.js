/* Entrada do Worker: API, ficheiros estáticos e tarefa agendada. */

import { api } from './api.js';
import { expireOrders } from './db.js';
import { ensureSchema } from './schema.js';

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'content-security-policy': [
    "default-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "script-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join('; ')
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    await ensureSchema(env);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await api(request, env);
      } catch (error) {
        console.error('api_error', error && error.stack ? error.stack : String(error));
        const detalhe = String((error && error.message) || error || '').slice(0, 240);
        return new Response(JSON.stringify({ error: 'server', message: 'Não foi possível concluir o pedido.', detail: detalhe }), {
          status: 500,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
        });
      }
    }

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
    if (url.pathname.startsWith('/r/') || url.pathname.startsWith('/e/')) {
      headers.set('cache-control', 'no-store');
      headers.set('referrer-policy', 'no-referrer');
    }
    return new Response(response.body, { status: response.status, headers });
  },

  async scheduled(event, env, ctx) {
    await ensureSchema(env);
    ctx.waitUntil(expireOrders(env).then(count => {
      if (count) console.log(`reservas_expiradas=${count}`);
    }));
  }
};
