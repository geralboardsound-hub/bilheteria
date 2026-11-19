/* Boardsound · bilheteira digital
   Interface ligada à API. Sem dados no navegador: tudo vem do servidor. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nfmt = new Intl.NumberFormat('pt-PT', { maximumFractionDigits: 0 });
const money = n => nfmt.format(Math.round(Number(n) || 0)) + ' Kz';
const num = v => Number(String(v ?? '').replace(/[^\d]/g, '')) || 0;
const MONTHS = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'];
const DURATION = 12 * 3600 * 1000;

let session = null;
let toastTimer;
const ui = { events: [], overview: null, orderFilter: 'all' };
const cart = new Map();

/* ---------- base ---------- */
function toast(message) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 4200);
}

class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}

async function api(path, options = {}) {
  const init = { method: options.method || 'GET', credentials: 'same-origin', headers: {} };
  if (options.body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  if (options.raw) {
    init.body = options.raw.body;
    init.headers['content-type'] = options.raw.type;
  }
  const response = await fetch(path, init);
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json().catch(() => ({})) : {};
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/auth')) {
      session = null;
      location.href = '/entrar?next=' + encodeURIComponent(location.pathname + location.search);
      throw new ApiError('Sessão expirada.', 401, data);
    }
    throw new ApiError(data.message || 'Não foi possível concluir o pedido.', response.status, data);
  }
  return data;
}

function money0(n) { return money(n); }
function evDate(ev) {
  if (!ev || !ev.date) return null;
  const d = new Date(`${ev.date}T${ev.time || '20:00'}:00+01:00`);
  return isNaN(d) ? null : d;
}
function dayNum(d) { return String(d.getDate()).padStart(2, '0'); }
function monthShort(d) { return MONTHS[d.getMonth()]; }
function fullDate(d) {
  return new Intl.DateTimeFormat('pt-PT', { timeZone: 'Africa/Luanda', weekday: 'long', day: '2-digit', month: 'long' }).format(d);
}
function fullDateTime(ts) {
  return new Intl.DateTimeFormat('pt-PT', {
    timeZone: 'Africa/Luanda', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(new Date(ts));
}
function hms(ms) {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map(v => String(v).padStart(2, '0'));
}
function waLink(number, text) {
  const digits = String(number || '').replace(/\D/g, '');
  return digits.length >= 9 ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}` : '';
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Link copiado.'); }
  catch { toast('Não foi possível copiar. Seleciona o texto manualmente.'); }
}

/* ---------- mensagens de WhatsApp ---------- */
function waMessage(order) {
  const ev = order.event || {};
  const p = order.payment || {};
  const eventName = order.eventName || ev.name || 'o evento';
  const when = ev.date ? `Data: ${ev.date}${ev.time ? ' · ' + ev.time : ''}\nLocal: ${ev.venue || ''}${ev.city ? ', ' + ev.city : ''}\n\n` : '';
  if (order.status === 'expired') {
    return `Olá, ${order.buyer.name}. A reserva ${order.id} para ${eventName} foi cancelada porque o prazo de 12 horas terminou sem confirmação da compra.\n\nOs lugares foram libertados. Uma nova reserva fica sujeita à disponibilidade.\n\nSe já pagaste, não pagues novamente. Responde a esta mensagem com o comprovativo e o número da reserva para verificarmos a situação.\n\nBoardsound`;
  }
  if (order.status === 'confirmed') {
    return `Olá, ${order.buyer.name}! O pagamento da reserva ${order.id} foi confirmado.\n\nEvento: ${eventName}\nIngressos: ${(order.items || []).map(i => `${i.qty}× ${i.name}`).join(', ')}\nTotal pago: ${money(order.total)}\n\n${order.ticketLink ? 'Acede aos teus ingressos:\n' + order.ticketLink : 'A equipa enviará os teus ingressos nesta conversa.'}\n\nObrigado por escolheres a Boardsound.`;
  }
  return `Olá, ${order.buyer.name}. A tua reserva ${order.id} para ${eventName} está registada.\n\n${when}Ingressos: ${(order.items || []).map(i => `${i.qty}× ${i.name} (${money(i.price)} cada)`).join(', ')}\nTotal: ${money(order.total)}\n\nPagamento por transferência:\nBanco: ${p.bank || '—'}\nTitular: ${p.holder || '—'}\nIBAN: ${p.iban || '—'}${p.account ? '\nConta: ' + p.account : ''}\nValor: ${money(order.total)}\nReferência: ${order.id}\n\nDepois de pagares, envia o comprovativo por WhatsApp para ${p.whatsapp || 'a organização'}.\n\nTens 12 horas. O prazo termina em ${fullDateTime(order.deadline)} (hora de Angola). O envio do comprovativo não prolonga o prazo.`;
}

function vipMessage(credential, eventName) {
  return `Olá, ${credential.name}! O teu credenciamento VIP para ${eventName} está registado.\n\nCódigo: ${credential.id}\nConvite: ${credential.origin === 'artist' ? 'Artista' : 'Produção'}\nVálido exclusivamente para este evento. Não tem prazo de pagamento nem cancelamento automático por 12 horas.\n\n${credential.ticket_link ? 'Credencial: ' + credential.ticket_link : 'A equipa enviará a credencial nesta conversa.'}\n\nBoardsound`;
}

/* ---------- autenticação ---------- */
function motivo(err) {
  const d = err?.data?.detail || err?.data?.error || '';
  const campos = err?.data?.errors ? Object.values(err.data.errors).join(' ') : '';
  return [err?.message || 'Falhou', campos, d].filter(Boolean).join(' — ').slice(0, 220);
}

function detalhe(err) {
  const d = err?.data?.detail || err?.data?.error || '';
  return d ? ` — ${String(d).slice(0, 160)}` : '';
}

function loginView(error) {
  document.body.className = 'team';
  $('#app').innerHTML = `<div class="authwrap"><form class="authcard" id="loginForm">
    <div class="wordmark" style="color:#0C0F13">BOARD<b style="color:#2F55FF">SOUND</b></div>
    <h1>Entrar na consola</h1>
    <p class="sub">Área reservada à equipa da bilheteira.</p>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    <label for="email">Email</label>
    <input class="in" id="email" name="email" type="email" autocomplete="username" required placeholder="nome@boardsound.ao">
    <div style="height:14px"></div>
    <label for="password">Palavra-passe</label>
    <input class="in" id="password" name="password" type="password" autocomplete="current-password" required placeholder="A tua palavra-passe">
    <button class="btn btn-p" type="submit">Entrar</button>
    <p class="foot" id="diagLine"></p>
    <p class="foot">Acesso reservado à equipa. Esqueceu a palavra-passe? Usa <b>REPOR-ADMIN</b> no computador onde a aplicação foi instalada.</p>
  </form></div>`;
  $('#loginForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button');
    button.disabled = true;
    button.innerHTML = '<span class="spin"></span> A entrar…';
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: { email: form.email.value.trim(), password: form.password.value }
      });
      session = data.user;
      const next = new URLSearchParams(location.search).get('next');
      location.href = next && next.startsWith('/') ? next : '/equipa/eventos';
    } catch (err) {
      const extra = err?.data?.detail ? ` [${err.data.detail}]` : '';
      loginView(err.message + detalhe(err));
    }
  });
  api('/api/diag').then(d => {
    const el = document.getElementById('diagLine');
    if (el) el.textContent = `Servidor ${d.version} · ${d.users} conta(s) · ${d.events} evento(s)`;
  }).catch(() => {});
  $('#email')?.focus();
}

/* ---------- consola ---------- */
function consoleShell(active, content, opts = {}) {
  const published = ui.events.find(e => e.status === 'published');
  const tabs = [
    ['/equipa/eventos', '01', 'Eventos', 'eventos'],
    ['/equipa/novo', '02', 'Criar evento', 'novo'],
    ['/equipa/reservas', '03', 'Reservas', 'reservas']
  ];
  return `<div class="vu">${Array.from({ length: 34 }, () => '<i></i>').join('')}</div>
  <header class="th">
    <a class="wordmark" href="/equipa/eventos">BOARD<b>SOUND</b></a>
    <span class="sep"></span><span class="where">Consola da equipa</span><span class="grow"></span>
    ${published ? `<a class="thlink" href="/e/${published.slug}" target="_blank" rel="noopener">Abrir página de vendas ↗</a>` : ''}
    <a class="thlink" href="/equipa/conta">Conta</a>
    <span class="thlink" title="Sessão iniciada">${esc(session?.name || '')}${session?.role === 'admin' ? ' · admin' : ''}</span>
    <button class="thbtn" data-action="logout">Sair</button>
  </header>
  <div class="twrap">
    <nav class="tnav">${tabs.map(t => `<a href="${t[0]}" class="${active === t[3] ? 'on' : ''}"><span class="n">${t[1]}</span>${t[2]}</a>`).join('')}
      ${opts.back ? `<span class="navspacer"></span><a class="pub" href="${opts.back.href}">${esc(opts.back.label)}</a>` : ''}
    </nav>
    ${content}
  </div>`;
}

function statusPill(status) {
  if (status === 'confirmed') return '<span class="pill ok">Confirmada</span>';
  if (status === 'review') return '<span class="pill wait">Em análise</span>';
  if (status === 'expired') return '<span class="pill late">Cancelada</span>';
  return '<span class="pill blue">Aguarda pagamento</span>';
}

async function loadEvents() {
  const [events, overview] = await Promise.all([api('/api/team/events'), api('/api/team/overview')]);
  ui.events = events.events;
  ui.overview = overview;
}

async function eventsView() {
  await loadEvents();
  const evs = ui.events;
  const o = ui.overview || { sold: 0, active: 0, revenue: 0, events: 0 };
  const seats = evs.reduce((s, e) => s + (e.occupancy?.limit || 0), 0);
  const body = evs.length ? `<div class="evlist">${evs.map(ev => {
    const d = evDate(ev);
    const pub = ev.status === 'published';
    return `<article class="evrow" data-nav="/equipa/evento/${ev.id}" tabindex="0" role="link" aria-label="Gerir ${esc(ev.name)}" style="cursor:pointer">
      <img class="thumb" src="${ev.flyer || '/placeholder'}" alt="Cartaz de ${esc(ev.name)}">
      <div>
        <div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap">
          <span class="nm">${esc(ev.name)}</span>
          <span class="pill ${pub ? 'ok' : 'wait'}">${pub ? 'Publicado' : 'Rascunho'}</span>
          ${pub ? `<span class="pill blue">${ev.occupancy.commercial}/${ev.occupancy.limit} lugares</span>` : ''}
          ${ev.occupancy.vip ? `<span class="pill">${ev.occupancy.vip} VIP</span>` : ''}
        </div>
        <div class="mt">${d ? `${dayNum(d)} ${monthShort(d)} · ${esc(ev.time || '')}` : 'Data por definir'} · ${esc(ev.venue || 'Local por definir')}</div>
        <div class="mt" style="margin-top:3px">/e/${esc(ev.slug)}</div>
      </div>
      <div class="acts">
        <a class="btn btn-p btn-sm" href="/equipa/evento/${ev.id}">Gerir evento</a>
        ${pub ? `<a class="btn btn-g btn-sm" href="/e/${ev.slug}" target="_blank" rel="noopener">Ver página</a>` : ''}
        <button class="btn btn-g btn-sm" data-action="copy" data-text="${esc(location.origin + '/e/' + ev.slug)}">Copiar link</button>
        <a class="btn btn-g btn-sm" href="/equipa/editar/${ev.id}">Editar</a>
      </div>
    </article>`;
  }).join('')}</div>` : `<div class="empty"><h3>Nenhum evento criado.</h3>
      <p>Cria o primeiro evento, carrega o cartaz e publica a página de vendas para obter o link a partilhar.</p>
      <a class="btn btn-p" href="/equipa/novo">Criar evento</a></div>`;

  $('#app').innerHTML = consoleShell('eventos', `
    <div class="thead"><div><div class="eyebrow">Bilheteira Boardsound</div>
      <h1 class="t">Eventos e páginas de venda</h1>
      <p class="tlead">Cada evento publicado gera uma página própria. Partilha o link de vendas; a consola fica sempre separada.</p></div>
      <a class="btn btn-p" href="/equipa/novo">+ Criar evento</a></div>
    <div class="kpis">
      <div class="kpi"><span class="k">Eventos</span><span class="v">${o.events}</span></div>
      <div class="kpi"><span class="k">Lugares vendidos</span><span class="v">${o.sold}<small>de ${seats}</small></span></div>
      <div class="kpi"><span class="k">Reservas ativas</span><span class="v">${o.active}</span></div>
      <div class="kpi"><span class="k">Receita confirmada</span><span class="v" style="font-size:21px">${money(o.revenue)}</span></div>
    </div>
    ${body}
    <div class="note" style="margin-top:22px">Os dados vivem na base de dados do servidor: o mesmo link abre em qualquer dispositivo. Três acessos distintos: consola (equipa), página de vendas (pública) e link do cliente (uma reserva).</div>`);
}

/* ---------- editor de evento ---------- */
let draft = null;
let draftTab = 'evento';

function blankDraft() {
  return {
    id: null, name: '', date: '', time: '20:00', venue: '', city: 'Luanda', description: '',
    accent: '#FFC400', cover: 'poster', headline: 'Garante o teu lugar', note: 'Portas abrem às 19h00',
    support: '', bankName: 'BNI', bankHolder: '', bankIban: '', bankAccount: '', proofWhatsapp: '',
    showCountdown: true, showDesc: true, showNote: true,
    flyerAsset: null, flyer: '/cartaz-padrao.jpg', lots: [{ id: 'lot-' + Math.random().toString(36).slice(2, 8), name: 'Regular', price: '5000', qty: '150' }]
  };
}

function previewEvent(d) {
  const lots = d.lots.filter(l => String(l.name || '').trim()).map(l => ({
    id: l.id, name: l.name, price: num(l.price), qty: num(l.qty), available: num(l.qty)
  }));
  const limit = lots.reduce((s, l) => s + l.qty, 0);
  return {
    name: d.name, date: d.date, time: d.time, venue: d.venue, city: d.city, description: d.description,
    flyer: d.flyer, accent: d.accent, cover: d.cover, headline: d.headline, note: d.note, support: d.support,
    showCountdown: d.showCountdown, showDesc: d.showDesc, showNote: d.showNote,
    lots, capacity: limit, free: limit
  };
}

const PUBLIC_DEFAULT_POSTER = '/cartaz-padrao.jpg';

function coverHTML(ev, preview) {
  // A página pública usa o cartaz estático enquanto o envio de imagens é testado.
  if (!preview) return `<img src="${PUBLIC_DEFAULT_POSTER}" alt="Cartaz de ${esc(ev.name)}">`;
  if (!ev.flyer) {
    return `<div class="type-cover"><div class="tk">Boardsound · Bilheteira</div>
      <div class="big">${esc(ev.name || 'Nome do evento')}</div>
      <div class="bt">${ev.date ? esc(ev.city || '') : 'Data por anunciar'}</div></div>`;
  }
  return `<img src="${ev.flyer}" alt="Cartaz de ${esc(ev.name)}">`;
}

function pubHTML(ev, preview) {
  const d = evDate(ev);
  const lots = (ev.lots || []).map(l => {
    const left = preview ? l.qty : (l.available ?? l.qty);
    const q = cart.get(l.id) || 0;
    return `<div class="lot ${left === 0 ? 'soldout' : ''}">
      <div><div class="nm">${esc(l.name)}</div><div class="av">${left === 0 ? 'Esgotado' : left + ' lugares disponíveis'}</div></div>
      <div class="pr">${nfmt.format(l.price)} <small>Kz</small></div>
      <div class="qty">
        <button type="button" data-action="step" data-lot="${l.id}" data-delta="-1" aria-label="Retirar um ${esc(l.name)}" ${preview ? 'disabled' : ''}>−</button>
        <span class="v" data-qty="${l.id}">${q}</span>
        <button type="button" data-action="step" data-lot="${l.id}" data-delta="1" aria-label="Adicionar um ${esc(l.name)}" ${preview ? 'disabled' : ''}>+</button>
      </div></div>`;
  }).join('');

  const total = preview ? 0 : (ev.lots || []).reduce((s, l) => s + l.price * (cart.get(l.id) || 0), 0);
  const count = preview ? 0 : Array.from(cart.values()).reduce((a, b) => a + b, 0);

  return `<div class="pub" style="--accent:${ev.accent}">
    <div class="pub-top"><span class="brand"><i class="dot"></i>Boardsound</span><span>Bilheteira digital</span></div>
    <div class="pub-shell">
      <div class="pub-media">${coverHTML(ev, preview)}${d ? `<div class="datebox"><span class="d">${dayNum(d)}</span><span class="m">${monthShort(d)}<br>${esc(ev.time || '')}</span></div>` : ''}</div>
      <div class="pub-body">
        <div class="kicker"><span>${d ? esc(ev.city || 'Luanda') : 'Data por anunciar'}</span><span>·</span><span>Ingressos digitais</span></div>
        <h1 class="event-title">${esc(ev.name || 'Nome do evento')}</h1>
        ${ev.headline ? `<p class="headline">${esc(ev.headline)}</p>` : ''}
        <div class="meta">
          <div class="r"><b>Data</b><span>${d ? fullDate(d) : 'Por anunciar'}</span></div>
          <div class="r"><b>Hora</b><span>${esc(ev.time || '—')}${ev.note ? ' · ' + esc(ev.note) : ''}</span></div>
          <div class="r"><b>Local</b><span>${esc(ev.venue || 'Por anunciar')}${ev.city ? ', ' + esc(ev.city) : ''}</span></div>
        </div>
        ${ev.showCountdown && d ? `<div class="countdown"><span>A decorrer em</span><span class="cells"><span class="cell">${Math.max(0, Math.ceil((d - Date.now()) / 86400000))}d</span></span></div>` : ''}
        ${ev.showDesc && ev.description ? `<p class="desc">${esc(ev.description)}</p>` : ''}
        <div class="lots"><div class="lot-h">Ingressos</div>${lots || '<p class="desc">Lotes por anunciar.</p>'}</div>
        <div class="stub">
          <div class="note-line"><b>Reserva de 12 h.</b><span>Guardamos os teus lugares durante 12 horas. O pagamento é por transferência e o comprovativo é conferido pela equipa.</span></div>
          <div class="note-line"><b>Ingresso digital.</b><span>Recebes o ingresso com código QR depois da confirmação do pagamento.</span></div>
        </div>
        <div class="pub-foot"><span>Boardsound · Luanda</span><span>${ev.showNote && ev.support ? 'Apoio ' + esc(ev.support) : 'Bilheteira oficial'}</span></div>
      </div>
    </div>
    <div class="pub-bar ${preview ? 'static' : ''}">
      <div class="sum"><small>${count ? count + ' ingresso' + (count > 1 ? 's' : '') : 'Seleciona os ingressos'}</small><b data-carttotal>${money(total)}</b></div>
      <button class="cta" data-action="${preview ? 'noop' : 'open-sheet'}" ${(!count || preview) ? 'disabled' : ''}>Reservar</button>
    </div>
  </div>`;
}

/* Telefones do evento: indicativo em campo próprio, número nacional à parte.
   Guarda-se sempre no formato internacional (+244923000000). */
const DDI = [['244','Angola (+244)'],['351','Portugal (+351)'],['55','Brasil (+55)'],['258','Moçambique (+258)'],['239','São Tomé (+239)'],['238','Cabo Verde (+238)'],['1','EUA/Canadá (+1)'],['44','Reino Unido (+44)'],['33','França (+33)'],['34','Espanha (+34)'],['27','África do Sul (+27)'],['86','China (+86)']];

function splitPhone(value) {
  const raw = String(value || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (!raw) return { prefix: '244', national: '' };
  if (raw.startsWith('+') || digits.length > 9) {
    const hit = ['244','351','55','258','239','238','1','44','33','34','27','86'].find(p => digits.startsWith(p) && digits.length - p.length >= 6);
    if (hit) return { prefix: hit, national: digits.slice(hit.length) };
  }
  return { prefix: '244', national: digits.slice(-9) };
}

function phoneField(key, label, value) {
  const { prefix, national } = splitPhone(value);
  const lista = DDI.map(([code, texto]) => `<option value="${code}"${code === prefix ? ' selected' : ''}>${texto}</option>`).join('');
  return field(key, label, `<div class="event-phone-fields">
    <select class="in" id="${key}Prefix" aria-label="Indicativo do país" style="color:#14120E;background:#fff">${lista}</select>
    <input class="in" id="${key}" data-ev="${key}" type="tel" inputmode="numeric" value="${esc(national)}" placeholder="9XX XXX XXX" aria-label="Número sem indicativo" style="color:#14120E;background:#fff">
  </div>`, 'Escolhe o indicativo e escreve o número sem indicativo (ex.: 923 456 789).');
}

function field(key, label, inner, hint) {
  return `<div class="fld" data-fld="${key}"><label for="${key}">${label}</label>${inner}${hint ? `<div class="hint">${hint}</div>` : ''}<div class="err"></div></div>`;
}

function editorView() {
  const d = draft;
  const published = !!(d.id && ui.events.find(e => e.id === d.id && e.status === 'published'));

  const flyerBlock = `<div class="upload" id="dropzone">
    <img class="prev" src="${d.flyer || '/cartaz-padrao.jpg'}" alt="Cartaz do evento">
    <div><strong>${d.flyerAsset ? 'Cartaz do evento' : 'Cartaz padrão (usado em todos os eventos)'}</strong>
      <p>Imagem vertical (JPG ou PNG). É apresentada no topo da página de vendas. Redimensionamos automaticamente.</p>
      <div class="row"><label class="btn btn-g btn-sm" style="cursor:pointer">Trocar imagem<input id="flyerInput" type="file" accept="image/png,image/jpeg,image/webp" class="sr"></label>
      ${d.flyerAsset ? `<button type="button" class="linkish" data-action="drop-flyer">Voltar ao padrão</button>` : ''}</div>
    </div></div>`;

  const lots = `<div class="lotshead"><span>Lote</span><span>Preço (Kz)</span><span>Lugares</span><span></span></div>
    <div class="lots">${d.lots.map(l => `<div class="lotrow" data-lot="${l.id}">
      <input class="in" data-lot-field="name" value="${esc(l.name)}" placeholder="Regular" aria-label="Nome do lote">
      <input class="in" data-lot-field="price" value="${esc(l.price)}" inputmode="numeric" placeholder="5000" aria-label="Preço">
      <input class="in" data-lot-field="qty" value="${esc(l.qty)}" inputmode="numeric" placeholder="150" aria-label="Lugares">
      <button type="button" class="x" data-action="del-lot" data-lot="${l.id}" aria-label="Remover lote">×</button>
    </div>`).join('')}</div>
    <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;margin-top:10px;flex-wrap:wrap">
      <button type="button" class="linkish" data-action="add-lot">+ Adicionar lote</button>
      <span class="capacity">Capacidade total: ${d.lots.reduce((s, l) => s + num(l.qty), 0)} lugares</span></div>`;

  const accents = [['#FFC400', 'AMARELO'], ['#FF3B2F', 'VERMELHO'], ['#17B26A', 'VERDE'], ['#2F55FF', 'AZUL'], ['#FF6FB1', 'ROSA']];
  const covers = [['poster', 'Cartaz inteiro', 'Imagem domina o topo'], ['band', 'Cartaz + faixa', 'Imagem recortada, cor por baixo'], ['type', 'Só tipografia', 'Sem imagem, título grande']];

  const tabEvento = `<h2><span class="mono">A</span> Evento</h2><p class="tsub">Informação que aparece na página de vendas e nos ingressos.</p>
    <div style="margin-bottom:16px">${field('flyer', 'Cartaz', flyerBlock)}</div>
    <div class="fgrp">
      ${field('name', 'Nome do evento', `<input class="in" id="name" data-ev="name" value="${esc(d.name)}" placeholder="Ex.: Noite Boardsound · Ao Vivo" maxlength="70">`)}
      <div></div>
      ${field('date', 'Data', `<input class="in" id="date" type="date" data-ev="date" value="${esc(d.date)}">`)}
      ${field('time', 'Hora de abertura', `<input class="in" id="time" type="time" data-ev="time" value="${esc(d.time)}">`)}
      ${field('venue', 'Local / recinto', `<input class="in" id="venue" data-ev="venue" value="${esc(d.venue)}" placeholder="Ex.: Espaço Bahia, Luanda">`)}
      ${field('city', 'Cidade', `<input class="in" id="city" data-ev="city" value="${esc(d.city)}" placeholder="Luanda">`)}
      <div class="wide">${field('description', 'Descrição', `<textarea class="in" id="description" data-ev="description" maxlength="240" placeholder="Duas linhas sobre o evento, lineup ou o que esperar.">${esc(d.description)}</textarea>`, `<span class="count" data-count="description">${(d.description || '').length}/240</span>`)}</div>
    </div>
    <div style="margin-top:20px"><div class="lbl">Lotes e preços</div>${lots}</div>`;

  const tabPagina = `<h2><span class="mono">B</span> Página de vendas</h2><p class="tsub">Personaliza o que o cliente vê ao abrir o link do evento.</p>
    <div class="fld swrap"><span class="lbl">Cor de destaque</span><div class="sw">${accents.map(a => `<button type="button" class="${d.accent === a[0] ? 'on' : ''}" style="background:${a[0]}" data-action="accent" data-accent="${a[0]}" aria-label="${a[1]}"><span>${a[1]}</span></button>`).join('')}</div></div>
    <div class="fld"><span class="lbl">Estilo de capa</span><div class="cover-opts">${covers.map(c => `<button type="button" class="cover-opt ${d.cover === c[0] ? 'on' : ''}" data-action="cover" data-cover="${c[0]}">
      <div class="mini">${c[0] === 'poster' ? `<i style="width:100%;height:100%;background:${d.accent}"></i>` : c[0] === 'band' ? `<i style="width:100%;height:55%;align-self:flex-end;background:${d.accent}"></i>` : `<i style="width:60%;height:26%;background:${d.accent}"></i>`}</div>
      <div><b>${c[1]}</b><span>${c[2]}</span></div></button>`).join('')}</div></div>
    <div class="fgrp" style="margin-top:18px">
      <div class="wide">${field('headline', 'Frase de abertura', `<input class="in" id="headline" data-ev="headline" value="${esc(d.headline)}" maxlength="70" placeholder="Garante o teu lugar">`)}</div>
      <div class="wide">${field('note', 'Nota ao cliente', `<input class="in" id="note" data-ev="note" value="${esc(d.note)}" maxlength="120" placeholder="Portas abrem às 19h00">`)}</div>
      <div class="wide">${phoneField('support', 'WhatsApp de apoio ao cliente', d.support)}</div>
    </div>
    <div style="margin-top:8px">
      <div class="switch"><div><p>Contagem decrescente</p><small>Mostra quanto falta para o evento.</small></div><button type="button" class="tg ${d.showCountdown ? 'on' : ''}" data-action="toggle" data-key="showCountdown" aria-label="Contagem decrescente"></button></div>
      <div class="switch"><div><p>Descrição do evento</p><small>Texto curto abaixo do título.</small></div><button type="button" class="tg ${d.showDesc ? 'on' : ''}" data-action="toggle" data-key="showDesc" aria-label="Descrição"></button></div>
      <div class="switch"><div><p>Nota e contactos no rodapé</p><small>Nota ao cliente e WhatsApp de apoio.</small></div><button type="button" class="tg ${d.showNote ? 'on' : ''}" data-action="toggle" data-key="showNote" aria-label="Nota e contactos"></button></div>
    </div>`;

  const tabPagamento = `<h2><span class="mono">C</span> Pagamento</h2><p class="tsub">Dados que o cliente vê na página da reserva. O comprovativo é enviado para o WhatsApp indicado.</p>
    <div class="fgrp">
      ${field('bankName', 'Banco', `<input class="in" id="bankName" data-ev="bankName" value="${esc(d.bankName)}" placeholder="BNI">`)}
      ${field('bankAccount', 'Número de conta · opcional', `<input class="in" id="bankAccount" data-ev="bankAccount" value="${esc(d.bankAccount)}" placeholder="Conta à ordem">`)}
      <div class="wide">${field('bankHolder', 'Titular da conta', `<input class="in" id="bankHolder" data-ev="bankHolder" value="${esc(d.bankHolder)}" placeholder="Nome da empresa tal como está no banco" maxlength="80">`)}</div>
      <div class="wide">${field('bankIban', 'IBAN', `<input class="in" id="bankIban" data-ev="bankIban" value="${esc(d.bankIban)}" placeholder="AO06 0000 0000 0000 0000 0000 0" maxlength="40" style="font-family:'IBM Plex Mono',monospace">`)}</div>
      <div class="wide">${phoneField('proofWhatsapp', 'WhatsApp que recebe os comprovativos', d.proofWhatsapp)}</div>
    </div>
    <div class="note">Estes dados aparecem no link do cliente e na mensagem de WhatsApp. Confirma o IBAN antes de publicar: um erro aqui faz o cliente pagar para a conta errada.</div>`;

  const next = { evento: ['pagina', 'Continuar: página de vendas →'], pagina: ['pagamento', 'Continuar: pagamento →'], pagamento: ['evento', '← Voltar ao evento'] };
  const linkBox = published
    ? `<div class="linkbox"><div class="k">Link de vendas</div><div class="u">${esc(location.origin + '/e/' + (ui.events.find(e => e.id === d.id)?.slug || ''))}</div>
       <div style="display:flex;gap:7px;flex-wrap:wrap"><button class="btn btn-g btn-sm" data-action="copy" data-text="${esc(location.origin + '/e/' + (ui.events.find(e => e.id === d.id)?.slug || ''))}">Copiar</button>
       <a class="btn btn-g btn-sm" href="/e/${ui.events.find(e => e.id === d.id)?.slug}" target="_blank" rel="noopener">Abrir</a></div></div>`
    : `<div class="linkbox"><div class="k">Link de vendas</div><div class="u" style="color:#6E7C90">O link é gerado ao publicar.</div></div>`;

  $('#app').innerHTML = consoleShell('novo', `
    <div class="thead"><div><div class="eyebrow">${d.id ? 'Editar evento' : 'Novo evento'}</div>
      <h1 class="t">${d.id ? esc(d.name || 'Sem nome') : 'Criar evento e página de venda'}</h1>
      <p class="tlead">Carrega o cartaz, define os lotes e personaliza a página. O link só fica disponível depois de publicares.</p></div>
      <div class="rowbtns"><a class="btn btn-g" href="/equipa/eventos">Ver eventos</a>
      <button class="btn btn-p" data-action="save">${published ? 'Guardar alterações' : 'Publicar evento'}</button></div></div>
    <div class="ed"><div>
      <div class="steptabs">
        <button type="button" class="${draftTab === 'evento' ? 'on' : ''}" data-action="tab" data-tab="evento"><span class="n">A</span>Evento</button>
        <button type="button" class="${draftTab === 'pagina' ? 'on' : ''}" data-action="tab" data-tab="pagina"><span class="n">B</span>Página de vendas</button>
        <button type="button" class="${draftTab === 'pagamento' ? 'on' : ''}" data-action="tab" data-tab="pagamento"><span class="n">C</span>Pagamento</button>
      </div>
      <div id="editorErrors"></div>
      <form class="tcard" id="evform" novalidate>${draftTab === 'evento' ? tabEvento : draftTab === 'pagina' ? tabPagina : tabPagamento}</form>
    </div>
    <div class="ed-side">
      <div class="sidehead"><span class="eyebrow">Pré-visualização</span><span class="mono">380 px</span></div>
      <div class="phone"><div class="scroll" style="pointer-events:none">${pubHTML(previewEvent(d), true)}</div></div>
      ${linkBox}
      ${published ? '<div class="pubstate">✓ Evento publicado. Alterações passam a valer quando guardares.</div>' : ''}
    </div></div>
    <div class="stickybar"><div class="inner"><span class="msg">${d.id ? 'A editar um evento existente.' : 'O evento fica em rascunho até publicares.'}</span>
      <button class="btn btn-g" data-action="tab" data-tab="${next[draftTab][0]}">${next[draftTab][1]}</button>
      <button class="btn btn-p btn-lg" data-action="save">${published ? 'Guardar alterações' : 'Publicar evento'}</button></div></div>`);
}

function refreshEditorPreview() {
  const box = $('#app .phone .scroll');
  if (box && draft) box.innerHTML = pubHTML(previewEvent(draft), true);
}

async function openEditor(eventId) {
  await loadEvents();
  if (eventId) {
    const data = await api('/api/team/events/' + encodeURIComponent(eventId));
    const ev = data.event;
    draft = {
      id: ev.id, name: ev.name, date: ev.date, time: ev.time, venue: ev.venue, city: ev.city,
      description: ev.description || '', accent: ev.accent, cover: ev.cover, headline: ev.headline || '',
      note: ev.note || '', support: ev.support || '', bankName: ev.bankName || '', bankHolder: ev.bankHolder || '',
      bankIban: ev.bankIban || '', bankAccount: ev.bankAccount || '', proofWhatsapp: ev.proofWhatsapp || '',
      showCountdown: ev.showCountdown, showDesc: ev.showDesc, showNote: ev.showNote,
      flyerAsset: ev.flyer && !ev.flyer.includes('cartaz-padrao') ? ev.flyer.split('/').pop() : null, flyer: ev.flyer || '/cartaz-padrao.jpg',
      lots: data.lots.map(l => ({ id: l.id, name: l.name, price: String(l.price), qty: String(l.qty) }))
    };
  } else {
    draft = blankDraft();
  }
  draftTab = 'evento';
  editorView();
}

function combinarTelefones() {
  for (const key of ['support', 'proofWhatsapp']) {
    const sel = document.getElementById(key + 'Prefix');
    const inp = document.getElementById(key);
    if (!inp) continue;
    const nacional = String(inp.value || '').replace(/\D/g, '');
    const prefixo = String(sel && sel.value || '244').replace(/\D/g, '');
    draft[key] = nacional ? '+' + prefixo + nacional : '';
  }
}

async function saveDraft({ publish }) {
  if (document.getElementById('support')) combinarTelefones();
  if (!draft) return;
  const payload = {
    name: draft.name, date: draft.date, time: draft.time, venue: draft.venue, city: draft.city,
    description: draft.description, accent: draft.accent, cover: draft.cover, headline: draft.headline,
    note: draft.note, support: draft.support, bankName: draft.bankName, bankHolder: draft.bankHolder,
    bankIban: draft.bankIban, bankAccount: draft.bankAccount, proofWhatsapp: draft.proofWhatsapp,
    showCountdown: draft.showCountdown, showDesc: draft.showDesc, showNote: draft.showNote,
    flyerAsset: draft.flyerAsset,
    lots: draft.lots.map(l => ({ id: l.id, name: l.name, price: num(l.price), qty: num(l.qty) }))
  };
  const button = $('[data-action="save"]');
  if (button) { button.disabled = true; button.textContent = 'A guardar…'; }
  try {
    const saved = await api(draft.id ? '/api/team/events/' + draft.id : '/api/team/events', { method: 'POST', body: payload });
    draft.id = saved.event.id;
    draft.flyer = saved.event.flyer || draft.flyer;
    if (publish || saved.event.status !== 'published') {
      try {
        await api('/api/team/events/' + draft.id + '/publish', { method: 'POST' });
      } catch (errP) {
        toast('Guardado, mas não publicado: ' + motivo(errP));
        if (button) { button.disabled = false; button.textContent = 'Publicar evento'; }
        return;
      }
    }
    await loadEvents();
    toast(saved.event.status === 'published' || publish ? 'Evento publicado. Link de vendas atualizado.' : 'Evento guardado.');
    history.replaceState({}, '', '/equipa/editar/' + draft.id);
    await openEditor(draft.id);
    draftTab = 'pagamento';
    editorView();
  } catch (err) {
    const errors = err.data?.errors;
    const box = $('#editorErrors');
    $$('.fld').forEach(f => f.classList.remove('bad'));
    if (errors) {
      if (box) box.innerHTML = `<div class="note warn"><b>Falta concluir:</b> ${Object.values(errors).join(' ')}</div>`;
      Object.keys(errors).forEach(key => {
        const fld = $(`[data-fld="${key}"]`);
        if (fld) { fld.classList.add('bad'); const err = fld.querySelector('.err'); if (err) err.textContent = errors[key]; }
      });
      toast('Falta concluir: ' + Object.values(errors)[0]);
    } else {
      toast(motivo(err));
    }
    if (button) { button.disabled = false; button.textContent = 'Tentar novamente'; }
  }
}

async function uploadFlyer(file) {
  const nome = String(file.name || '').toLowerCase();
  if (/\.(heic|heif)$/.test(nome) || /heic|heif/i.test(file.type || '')) {
    toast('Fotos HEIC do iPhone não abrem no navegador. Em Ajustes → Câmara → Formatos escolhe "Mais compatível", ou exporta como JPG.');
    return;
  }
  if (!/^image\//.test(file.type)) { toast('Escolhe uma imagem JPG, PNG ou WEBP.'); return; }
  if (file.size > 20 * 1024 * 1024) { toast('A imagem é demasiado grande. Máximo 8 MB.'); return; }
  toast('A carregar o cartaz…');
  let blob;
  try { blob = await comprimirAteCaber(file); }
  catch { toast('Não consegui ler esta imagem. Guarda-a como JPG e tenta de novo.'); return; }
  if (blob.size > 1_450_000) { toast(`Imagem com ${Math.round(blob.size / 1024)} KB, acima do limite de 1450 KB. Usa uma imagem mais leve.`); return; }
  try {
    const data = await api('/api/team/assets?kind=flyer', { method: 'POST', raw: { body: blob, type: 'image/jpeg' } });
    draft.flyerAsset = data.assetId;
    draft.flyer = '/api/team/assets/' + data.assetId;
    editorView();
    toast(`Cartaz carregado (${Math.round(data.bytes / 1024)} KB). Clica em Publicar para gravar.`);
  } catch (err) { toast('Cartaz: ' + motivo(err)); }
}

async function comprimirAteCaber(file) {
  const passos = [[1300, 0.85], [1100, 0.8], [950, 0.75], [800, 0.7], [650, 0.65]];
  let blob = null;
  for (const [lado, qualidade] of passos) {
    blob = await compressImage(file, lado, qualidade);
    if (blob.size <= 1_200_000) break;
  }
  return blob;
}

function compressImage(file, max, qualidade) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#0C1118'; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('compressão falhou')), 'image/jpeg', qualidade || 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('imagem inválida')); };
    img.src = url;
  });
}

/* ---------- gestão do evento ---------- */
let showVipForm = false;

async function eventActivityView(eventId) {
  const data = await api('/api/team/events/' + encodeURIComponent(eventId));
  const ev = data.event, occ = data.occupancy;
  const pct = Math.min(100, Math.round((occ.total / Math.max(1, occ.limit)) * 100));
  const full = occ.total >= occ.limit;

  const orderRows = data.orders.length ? data.orders.map(o => `<tr>
    <td><a href="/equipa/reservas/${o.id}" style="color:#A9C0FF">${o.id}</a><div class="sub">${fullDateTime(o.created_at)}</div></td>
    <td><div class="who">${esc(o.buyer_name)}</div><div class="sub">${esc(o.buyer_phone)}</div></td>
    <td class="amt">${money(o.total)}</td>
    <td>${statusPill(o.status)}</td></tr>`).join('')
    : '<tr><td colspan="4">Ainda não há reservas.</td></tr>';

  const cards = data.credentials.length ? data.credentials.map(c => `<div class="tcard">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <h2>${esc(c.name)}</h2><span class="pill ok">VIP · sem expiração</span></div>
    <p style="color:#A9B6C7;font-size:13px;margin-top:10px">${esc(c.id)} · ${c.origin === 'artist' ? 'Artista' : 'Produção'}<br>
      Convidado por: ${esc(c.invited_by || '—')}<br>Registado por: ${esc(c.operator || '—')}<br>${esc(c.phone || 'Sem WhatsApp')}</p>
    ${c.notes ? `<p style="margin-top:10px;color:#A9B6C7">${esc(c.notes)}</p>` : ''}
    ${c.phone ? `<a class="btn btn-p btn-sm" style="margin-top:12px;white-space:normal" href="${waLink(c.phone, vipMessage(c, ev.name))}" target="_blank" rel="noopener">Enviar credenciamento pelo WhatsApp</a>` : ''}
    <p style="font-size:11px;color:#A9B6C7;margin-top:10px">Envio manual. Sem link, anexa a credencial na conversa.</p></div>`).join('')
    : '<p style="color:#A9B6C7">Nenhum convidado registado neste evento.</p>';

  const vipForm = showVipForm ? `<form id="vipForm" class="tcard" style="background:#fff;color:#000;margin-bottom:20px">
    <h2>Novo credenciamento VIP</h2>
    <p style="font-size:13px;margin:8px 0 20px">Um registo por convidado, sem pagamento e sem prazo de 12 horas.</p>
    <div class="fgrp">
      ${field('vipName', 'Nome do convidado', '<input class="in" id="vipName" name="guestName" required maxlength="80" style="color:#000;background:#fff">')}
      ${field('vipOrigin', 'Origem do convite', '<select class="in" id="vipOrigin" name="origin" style="color:#000;background:#fff"><option value="production">Produção</option><option value="artist">Artista</option></select>')}
      ${field('vipInviter', 'Convidado por', '<input class="in" id="vipInviter" name="invitedBy" required maxlength="80" style="color:#000;background:#fff">')}
      ${field('vipOperator', 'Registado por · equipa', `<input class="in" id="vipOperator" name="operator" value="${esc(session?.name || '')}" required maxlength="80" style="color:#000;background:#fff">`)}
      <div class="wide">${field('vipPhone', 'WhatsApp · opcional', `<div class="event-phone-fields"><select class="in" name="prefix" style="color:#000;background:#fff"><option value="244">Angola (+244)</option><option value="351">Portugal (+351)</option><option value="55">Brasil (+55)</option><option value="258">Moçambique (+258)</option></select><input class="in" id="vipPhone" name="phone" type="tel" inputmode="numeric" placeholder="9XX XXX XXX" style="color:#000;background:#fff"></div>`)}</div>
      <div class="wide">${field('vipTicket', 'Link da credencial · opcional', '<input class="in" id="vipTicket" name="ticketLink" type="url" placeholder="https://…" style="color:#000;background:#fff">')}</div>
      <div class="wide">${field('vipNotes', 'Observações · opcional', '<textarea class="in" id="vipNotes" name="notes" maxlength="300" style="color:#000;background:#fff"></textarea>')}</div>
    </div>
    <div class="rowbtns" style="margin-top:20px"><button class="btn btn-p" type="submit" ${full ? 'disabled' : ''}>Criar credenciamento VIP</button>
    <button class="btn btn-g" type="button" data-action="cancel-vip">Cancelar</button></div>
    ${full ? '<p style="margin-top:12px;color:#7A2314">Lotação esgotada: não é possível credenciar.</p>' : ''}
  </form>` : '';

  $('#app').innerHTML = consoleShell('eventos', `
    <a href="/equipa/eventos" style="color:#A9C0FF">← Eventos</a>
    <div class="thead" style="margin-top:16px"><div><div class="eyebrow">Gestão do evento</div>
      <h1 class="t">${esc(ev.name)}</h1>
      <p class="tlead">Reservas comerciais e convidados VIP partilham a capacidade do recinto.</p></div>
      <div class="rowbtns"><a class="btn btn-g" href="/equipa/editar/${ev.id}">Editar evento</a>
        ${ev.status === 'published' ? `<a class="btn btn-g" href="/e/${ev.slug}" target="_blank" rel="noopener">Ver página</a>` : ''}
        <button class="btn btn-p" data-action="toggle-vip">+ Credenciamento VIP</button></div></div>
    <div class="kpis">
      <div class="kpi"><span class="k">Lugares comerciais ocupados</span><span class="v">${occ.commercial}</span></div>
      <div class="kpi"><span class="k">Convidados VIP</span><span class="v">${occ.vip}</span></div>
      <div class="kpi"><span class="k">Ocupação total / limite</span><span class="v">${occ.total} / ${occ.limit}</span></div>
      <div class="kpi"><span class="k">Lugares livres</span><span class="v">${occ.free}</span></div>
    </div>
    <div class="tcard" style="margin-bottom:20px"><h2>Lotação conjunta</h2>
      <p style="color:#A9B6C7;margin:10px 0">${occ.commercial} lugares comerciais + ${occ.vip} convidados VIP = ${occ.total} pessoas. Reservas expiradas não contam. Cada credenciamento vale um lugar.</p>
      <div style="height:10px;background:#273240;border-radius:6px;overflow:hidden"><div style="height:100%;width:${pct}%;background:${full ? '#EF816E' : '#5B7CFF'}"></div></div>
      <form id="capacityForm" data-event="${ev.id}" style="margin-top:18px;display:flex;gap:12px;align-items:end;flex-wrap:wrap">
        <div><label for="venueCapacity" style="display:block;margin-bottom:6px;color:#DCE4EE">Capacidade do recinto · pessoas</label>
        <input id="venueCapacity" name="venueCapacity" type="number" min="1" step="1" required value="${occ.limit}" style="background:#fff;color:#000;border:1px solid #8794A7;border-radius:7px;padding:12px;width:180px"></div>
        <button class="btn btn-p">Guardar capacidade</button></form>
      <p style="font-size:12px;color:#A9B6C7;margin-top:10px">${occ.explicit ? 'Capacidade definida pela equipa.' : 'Capacidade física ainda não confirmada. O limite é a soma das quantidades dos lotes comerciais.'}</p>
      ${full ? `<div class="note warn">${occ.total > occ.limit ? 'Ocupação acima do limite. Revê os registos existentes.' : 'Lotação esgotada.'} Novas reservas e credenciamentos estão bloqueados.</div>` : ''}
    </div>
    ${vipForm}
    <div class="tcard"><h2>Reservas deste evento</h2><div class="tablewrap"><table class="tbl">
      <thead><tr><th>Reserva</th><th>Cliente</th><th>Total</th><th>Estado</th></tr></thead>
      <tbody>${orderRows}</tbody></table></div></div>
    <div style="margin-top:24px"><h2 style="margin-bottom:14px">Credenciamentos VIP</h2>${cards}</div>
    <div class="note">VIP e reservas comerciais partilham a capacidade física do recinto. Esta é a ocupação prevista, não a contagem de entradas.</div>`);
}

/* ---------- reservas ---------- */
async function ordersView() {
  const query = ui.orderFilter === 'all' ? '' : '?status=' + ui.orderFilter;
  const data = await api('/api/team/orders' + query);
  const list = data.orders;
  const overview = await api('/api/team/overview');
  const chips = [['all', 'Todas'], ['review', 'Em análise'], ['pending', 'Aguarda pagamento'], ['confirmed', 'Confirmadas'], ['expired', 'Canceladas']];
  const rows = list.length ? list.map(o => `<tr data-nav="/equipa/reservas/${o.id}" style="cursor:pointer">
    <td><div class="who mono" style="font-size:12px">${o.id}</div><div class="sub">${fullDateTime(o.createdAt)}</div></td>
    <td>${esc(o.eventName)}</td>
    <td><div class="who">${esc(o.buyer.name)}</div><div class="sub">${esc(o.buyer.phone)}</div></td>
    <td class="amt">${money(o.total)}</td>
    <td>${statusPill(o.status)}</td>
    <td>${['pending', 'review'].includes(o.status) ? `<span class="cd" data-dl="${o.deadline}">--:--:--</span>` : '<span class="sub">—</span>'}</td>
  </tr>`).join('') : '<tr><td colspan="6"><div class="empty" style="border:0;background:none"><h3>Nenhuma reserva neste filtro.</h3><p>As reservas aparecem aqui quando um cliente compra pelo link de vendas.</p></div></td></tr>';

  $('#app').innerHTML = consoleShell('reservas', `
    <div class="thead"><div><div class="eyebrow">Pagamento manual</div><h1 class="t">Reservas e conferência</h1>
      <p class="tlead">Confirma o crédito na conta antes de aprovar. O comprovativo sozinho não confirma a compra.</p></div></div>
    <div class="kpis">
      <div class="kpi"><span class="k">Reservas ativas</span><span class="v">${overview.active}</span></div>
      <div class="kpi"><span class="k">Lugares vendidos</span><span class="v">${overview.sold}</span></div>
      <div class="kpi"><span class="k">Receita confirmada</span><span class="v" style="font-size:21px">${money(overview.revenue)}</span></div>
    </div>
    <div class="filters">${chips.map(c => `<button data-action="filter" data-f="${c[0]}" class="${ui.orderFilter === c[0] ? 'on' : ''}">${c[1]}</button>`).join('')}</div>
    <div class="tcard" style="padding:0 24px 8px"><div class="tablewrap"><table class="tbl">
      <thead><tr><th>Reserva</th><th>Evento</th><th>Cliente</th><th>Total</th><th>Estado</th><th>Prazo (12h)</th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>
    <div class="note">A contagem termina 12 horas após a criação da reserva, mesmo que o comprovativo já tenha sido enviado. A expiração é executada pelo servidor a cada 5 minutos.</div>`);
}

async function orderDetailView(orderId) {
  const data = await api('/api/team/orders/' + encodeURIComponent(orderId));
  const o = data.order;
  const running = ['pending', 'review'].includes(o.status) && o.deadline > Date.now();
  const items = o.items.map(i => `${i.qty} × ${esc(i.name)} · ${money(i.price * i.qty)}`).join('<br>');
  const log = data.log.slice().reverse().map(l => `<li class="hit">${esc(l.text)}<span class="when">${fullDateTime(l.ts)}</span></li>`).join('') || '<li>Sem registos.</li>';

  const proof = o.hasProof
    ? `<div class="proof"><img src="/api/team/orders/${o.id}/proof" alt="Comprovativo recebido por WhatsApp"></div>
       <p class="tsub" style="margin:8px 0 0">${esc(data.proofName || 'comprovativo')} · <a class="linkish" href="/api/team/orders/${o.id}/proof" target="_blank" rel="noopener">Abrir em tamanho real</a></p>`
    : '<p class="tsub" style="margin:6px 0 0">Nenhum comprovativo anexado. O cliente envia-o por WhatsApp; anexa-o aqui.</p>';

  const attach = running ? `<form id="attachForm" data-order="${o.id}" style="margin-top:16px;padding-top:14px;border-top:1px solid #1B222C">
      <label for="attachFile" style="display:block;font-size:12px;font-weight:650;color:#000;margin-bottom:6px">Anexar comprovativo recebido por WhatsApp</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><input id="attachFile" type="file" accept="image/jpeg,image/png,image/webp" style="font-size:12px;max-width:100%">
      <button class="btn btn-g btn-sm" type="submit">Anexar à reserva</button></div>
      <div class="hint" style="font-size:11.5px;color:#000;margin-top:6px">O comprovativo fica guardado no servidor, associado a esta reserva.</div></form>` : '';

  const approve = running ? `<form id="approveForm" data-order="${o.id}" style="margin-top:16px;padding-top:14px;border-top:1px solid #1B222C">
      <div class="fgrp"><div class="fld"><label for="operator">Quem conferiu</label><input class="in" id="operator" name="operator" value="${esc(session?.name || '')}" maxlength="60" required></div>
      <div class="fld"><label for="bankRef">Referência do movimento</label><input class="in" id="bankRef" name="bankRef" placeholder="Nº no extrato" maxlength="60" required></div>
      <div class="fld"><label for="amount">Montante recebido (Kz)</label><input class="in" id="amount" name="amount" inputmode="numeric" value="${o.total}" required></div>
      <div class="fld"><label for="ticketLink">Link do ingresso · opcional</label><input class="in" id="ticketLink" name="ticketLink" type="url" placeholder="https://…" value="${esc(o.ticketLink || '')}"></div></div>
      <button class="btn btn-p" type="submit" style="margin-top:14px">Confirmar compra</button></form>`
    : `<div class="note${o.status === 'expired' ? ' warn' : ''}">${o.status === 'confirmed'
      ? `Compra confirmada por <b>${esc(o.operator || '—')}</b>. Movimento: ${esc(o.bankRef || '—')}.`
      : 'Reserva cancelada por prazo. Um pagamento posterior exige resolução manual: não emitas lugares já libertados.'}</div>`;

  const waText = waMessage({ ...o, event: { name: o.eventName }, payment: { bank: o.payment_bank, holder: o.payment_holder, iban: o.payment_iban, account: o.payment_account, whatsapp: o.payment_whatsapp } });
  const label = o.status === 'expired' ? 'Avisar cancelamento pelo WhatsApp' : o.status === 'confirmed' ? 'Enviar confirmação e ingresso pelo WhatsApp' : 'Enviar detalhes de pagamento pelo WhatsApp';

  $('#app').innerHTML = consoleShell('reservas', `
    <a href="/equipa/reservas" style="font-size:12.5px;color:#8DA6FF;text-decoration:none">← Todas as reservas</a>
    <div class="thead" style="margin-top:10px"><div><div class="eyebrow">Reserva</div>
      <h1 class="t" style="font-family:'IBM Plex Mono',monospace;font-size:26px">${o.id}</h1>
      <p class="tlead">${esc(o.eventName)} · ${esc(o.buyer.name)}</p></div><div>${statusPill(o.status)}</div></div>
    <div class="detail"><div>
      <div class="tcard"><h2><span class="mono">01</span> Pedido</h2>
        <dl class="facts">
          <div><dt>Cliente</dt><dd>${esc(o.buyer.name)}</dd></div>
          <div><dt>WhatsApp</dt><dd>${esc(o.buyer.phone)}</dd></div>
          ${o.buyer.aux ? `<div><dt>Contacto auxiliar</dt><dd>${esc(o.buyer.aux)}</dd></div>` : ''}
          <div><dt>Ingressos</dt><dd>${items}</dd></div>
          <div><dt>Total</dt><dd>${money(o.total)}</dd></div>
          <div><dt>Criada</dt><dd>${fullDateTime(o.createdAt)}</dd></div>
          <div><dt>Limite</dt><dd>${fullDateTime(o.deadline)}</dd></div>
        </dl></div>
      <div class="tcard"><h2><span class="mono">02</span> Comprovativo e confirmação</h2>${proof}${attach}${approve}</div>
    </div><aside>
      <div class="tcard" style="text-align:center"><div class="eyebrow">Tempo restante</div>
        <div class="bignum ${o.status === 'confirmed' ? 'ok' : ''}" style="margin:8px 0" ${running ? `data-dl="${o.deadline}"` : ''}>${o.status === 'confirmed' ? 'Concluída' : o.status === 'expired' ? '00:00:00' : '--:--:--'}</div>
        <p class="tsub" style="margin:12px 0 0">Termina em ${fullDateTime(o.deadline)} (hora de Angola).</p>
        ${running ? `<button class="btn btn-g btn-sm" style="margin-top:12px" data-action="expire" data-order="${o.id}">Cancelar agora</button>` : ''}</div>
      <div class="tcard"><h2><span class="mono">03</span> WhatsApp do cliente</h2>
        <p class="tsub" style="margin-bottom:10px">A mensagem muda com o estado. O envio é manual.</p>
        <a class="btn btn-p btn-sm" style="width:100%;white-space:normal;text-align:center" href="${waLink(o.buyer.phone, waText)}" target="_blank" rel="noopener">${label}</a>
        <button class="btn btn-g btn-sm" style="width:100%;margin-top:9px" data-action="copy" data-text="${esc(waText)}">Copiar mensagem</button>
        <p style="font-size:11.5px;color:#A9B6C7;margin-top:8px">Abrir o WhatsApp não confirma a entrega.</p></div>
      <div class="tcard"><h2><span class="mono">04</span> Histórico</h2><ul class="timeline">${log}</ul></div>
    </aside></div>`);
}

/* ---------- página pública ---------- */
let currentSalesEvent = null;

async function salesView(slug) {
  currentSalesEvent = null;
  document.body.className = 'public';
  const data = await api('/api/public/events/' + encodeURIComponent(slug));
  const ev = data.event;
  document.title = ev.name + ' · Boardsound';
  cart.clear();
  currentSalesEvent = ev;
  $('#app').innerHTML = pubHTML(ev, false) + `<div class="sheetwrap" id="sheet"><div class="scrim" data-action="close-sheet"></div>
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
      <button class="x-close" data-action="close-sheet" aria-label="Fechar">×</button>
      <span class="reserve-label">RESERVA VÁLIDA POR 12 HORAS</span>
      <h3 id="sheetTitle">Os teus dados</h3>
      <p class="sub">Os lugares ficam guardados 12 horas. Depois de reservares, recebes no WhatsApp os dados para pagamento por transferência.</p>
      <form id="reserveForm" data-slug="${esc(ev.slug)}" novalidate>
        <div class="f"><label for="rname">Nome</label><input class="in" id="rname" name="name" required maxlength="80" placeholder="O teu nome" autocomplete="name"></div>
        <div class="f"><label for="rphone">WhatsApp</label><div class="phone-fields">
          <select class="in" id="rcountry" name="country" aria-label="País e indicativo">
            <option value="244" selected>Angola (+244)</option><option value="351">Portugal (+351)</option>
            <option value="55">Brasil (+55)</option><option value="258">Moçambique (+258)</option>
            <option value="238">Cabo Verde (+238)</option><option value="239">São Tomé (+239)</option>
            <option value="27">África do Sul (+27)</option><option value="243">RD Congo (+243)</option>
          </select>
          <input class="in" id="rphone" name="phone" type="tel" inputmode="numeric" required maxlength="15" placeholder="9XX XXX XXX" aria-label="Número de WhatsApp sem indicativo"></div></div>
        <div class="f"><label for="raux">Contacto auxiliar · opcional</label><input class="in" id="raux" name="aux" type="tel" maxlength="20" placeholder="Outro número, se necessário"></div>
        <div class="sumline"><span>${Array.from(cart.values()).reduce((a, b) => a + b, 0)} ingresso(s)</span><b data-sheet-total>${money(0)}</b></div>
        <button class="cta-w" type="submit">Criar reserva · 12 h</button>
        <p class="fine">Ao continuar, aceitas receber as mensagens desta reserva no WhatsApp indicado. O comprovativo não confirma a compra nem prolonga o prazo.</p>
      </form></div></div>`;
  updateSheetTotal(ev);
}

function updateSheetTotal(ev) {
  const count = Array.from(cart.values()).reduce((a, b) => a + b, 0);
  const total = (ev?.lots || []).reduce((s, l) => s + l.price * (cart.get(l.id) || 0), 0);
  const line = $('.sheet .sumline');
  if (line) line.innerHTML = `<span>${count} ingresso${count === 1 ? '' : 's'}</span><b>${money(total)}</b>`;
}

/* ---------- link do cliente ---------- */
async function clientView(token) {
  document.body.className = 'client';
  let data;
  try { data = await api('/api/public/reservations/' + encodeURIComponent(token)); }
  catch {
    document.title = 'Reserva não encontrada · Boardsound';
    $('#app').innerHTML = `<div class="cli"><div class="cli-top"><span>BOARDSOUND</span><span class="lk">Link da reserva</span></div>
      <div class="cli-wrap"><div class="cli-card" style="margin-top:20px"><h2>Link inválido</h2>
      <p style="font-size:13.5px;line-height:1.6">Este link não corresponde a nenhuma reserva, ou já expirou. Cada link dá acesso apenas à reserva que o gerou.</p>
      <p class="fine">Se recebeste este endereço da Boardsound, pede um novo link à organização.</p></div></div></div>`;
    return;
  }
  const o = data.order, ev = o.event || {};
  const running = ['pending', 'review'].includes(o.status) && o.deadline > Date.now();
  document.title = 'Reserva ' + o.id + ' · Boardsound';

  const banner = o.status === 'confirmed'
    ? '<div class="banner ok">Compra confirmada. Os teus lugares estão garantidos.</div>'
    : o.status === 'expired'
      ? '<div class="banner late">Reserva cancelada. O prazo de 12 horas terminou sem confirmação do pagamento.</div>'
      : o.status === 'review'
        ? '<div class="banner wait">Comprovativo recebido. A equipa está a conferir o pagamento.</div>'
        : '<div class="banner wait">Reserva criada. Falta pagar e enviar o comprovativo.</div>';

  const countdown = running ? `<div class="cli-card"><h2>Tempo restante</h2>
    <div class="cd"><b data-dl="${o.deadline}">--:--:--</b><span>horas : min : seg<br>limite ${fullDateTime(o.deadline)}</span></div></div>` : '';

  const payment = o.status !== 'expired' ? `<div class="cli-card"><h2>Dados para pagamento</h2>
    <dl class="bank">
      <div><dt>Banco</dt><dd>${esc(o.payment.bank || '—')}</dd></div>
      <div><dt>Titular</dt><dd>${esc(o.payment.holder || '—')}</dd></div>
      <div><dt>IBAN</dt><dd style="font-family:'IBM Plex Mono',monospace;font-size:12px">${esc(o.payment.iban || '—')}</dd></div>
      ${o.payment.account ? `<div><dt>Conta</dt><dd>${esc(o.payment.account)}</dd></div>` : ''}
      <div><dt>Montante</dt><dd>${money(o.total)}</dd></div>
      <div><dt>Referência</dt><dd>${o.id}</dd></div>
    </dl>
    <p class="banknote">Indica a referência na descrição da transferência. O comprovativo não confirma a compra: a equipa confere o crédito antes de emitir os ingressos.</p>
    <button class="btn-line" style="width:100%;margin-top:10px" data-action="copy-bank" data-order='${esc(JSON.stringify({ total: o.total, id: o.id, p: o.payment }))}'>Copiar dados bancários</button></div>` : '';

  const proof = running ? `<div class="cli-card"><h2>Enviar comprovativo</h2>
    <p style="font-size:13px;line-height:1.6">Depois de pagares, envia o comprovativo por WhatsApp${o.payment.whatsapp ? ` para <b>${esc(o.payment.whatsapp)}</b>` : ''}. A mensagem já vai com o número da reserva.</p>
    ${o.payment.whatsapp
      ? `<a class="btn-wa" href="${waLink(o.payment.whatsapp, `Olá! Envio o comprovativo da reserva ${o.id} (${'cliente'}), no valor de ${money(o.total)}.`)}" target="_blank" rel="noopener">Enviar comprovativo por WhatsApp</a>`
      : '<p class="fine" style="color:#A03A2A">O número para comprovativos ainda não está configurado. Contacta a organização.</p>'}
    <div class="wa-note">Abre o WhatsApp com a mensagem escrita. Anexa a imagem ou o PDF do comprovativo e envia.</div>
    <p class="fine">O envio não confirma a compra nem prolonga o prazo de 12 horas.</p></div>` : '';

  const confirmed = o.status === 'confirmed' ? `<div class="cli-card"><h2>Ingressos</h2>
    <p style="font-size:13px;line-height:1.6">Pagamento confirmado em ${fullDateTime(o.confirmedAt || Date.now())}.</p>
    ${o.ticketLink ? `<a class="btn-dark" href="${esc(o.ticketLink)}" target="_blank" rel="noopener" style="display:block;text-align:center;text-decoration:none;margin-top:12px">Abrir os meus ingressos</a>`
      : '<p class="fine">A equipa envia os teus ingressos por WhatsApp. Guarda esta página.</p>'}</div>` : '';

  $('#app').innerHTML = `<div class="cli">
    <div class="cli-top"><span>BOARDSOUND</span><span class="lk">Reserva ${o.id}</span></div>
    <div class="cli-wrap">${banner}
      <div class="cli-card" style="margin-top:12px"><div class="ev">
        <img src="${PUBLIC_DEFAULT_POSTER}" alt="Cartaz do evento">
        <div><div class="t">${esc(ev.name || '')}</div>
          <div class="m">${ev.date ? fullDate(new Date(ev.date + 'T' + (ev.time || '20:00') + ':00+01:00')) + '<br>' + esc(ev.time) + ' · ' + esc(ev.venue) + ', ' + esc(ev.city) : ''}</div></div></div></div>
      ${countdown}
      <div class="cli-card"><h2>A tua reserva</h2><dl class="bank">
        <div><dt>Ingressos</dt><dd>${o.items.map(i => `${i.qty}× ${esc(i.name)}`).join('<br>')}</dd></div>
        <div><dt>Total</dt><dd>${money(o.total)}</dd></div>
        <div><dt>Estado</dt><dd>${o.status === 'confirmed' ? 'Confirmada' : o.status === 'expired' ? 'Cancelada' : o.status === 'review' ? 'Em análise' : 'Aguarda pagamento'}</dd></div>
      </dl></div>
      ${payment}${proof}${confirmed}
      ${o.status === 'expired' ? `<div class="cli-card"><h2>Se já pagaste</h2><p style="font-size:13px;line-height:1.6">Não pagues novamente. Contacta a organização e indica a reserva <b>${o.id}</b>. Os lugares foram libertados e podem já estar ocupados.</p></div>` : ''}
      <p class="fine" style="text-align:center;margin-top:18px">Este link mostra apenas esta reserva e não dá acesso à bilheteira.<br>Boardsound · Luanda</p>
    </div></div>`;
}

/* ---------- contagens ---------- */
setInterval(() => {
  $$('[data-dl]').forEach(el => {
    const left = Number(el.dataset.dl) - Date.now();
    el.textContent = left > 0 ? hms(left).join(':') : '00:00:00';
  });
}, 1000);

/* ---------- ações globais ---------- */
document.addEventListener('click', async event => {
  const nav = event.target.closest('[data-nav]');
  const action = event.target.closest('[data-action]');

  if (nav && !event.target.closest('a,button,input,select,textarea')) {
    location.href = nav.dataset.nav;
    return;
  }
  if (!action) return;
  const a = action.dataset.action;
  event.preventDefault();

  if (a === 'noop') return;
  if (a === 'copy') { copyText(action.dataset.text); return; }
  if (a === 'logout') {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => { });
    session = null; location.href = '/entrar'; return;
  }
  if (a === 'filter') { ui.orderFilter = action.dataset.f; ordersView(); return; }
  if (a === 'tab') { draftTab = action.dataset.tab; editorView(); return; }
  if (a === 'accent') { draft.accent = action.dataset.accent; editorView(); return; }
  if (a === 'cover') { draft.cover = action.dataset.cover; editorView(); return; }
  if (a === 'toggle') { draft[action.dataset.key] = !draft[action.dataset.key]; editorView(); return; }
  if (a === 'add-lot') { draft.lots.push({ id: 'lot-' + Math.random().toString(36).slice(2, 8), name: '', price: '', qty: '' }); editorView(); return; }
  if (a === 'del-lot') {
    if (draft.lots.length === 1) { toast('O evento precisa de pelo menos um lote.'); return; }
    draft.lots = draft.lots.filter(l => l.id !== action.dataset.lot); editorView(); return;
  }
  if (a === 'drop-flyer') { draft.flyer = '/cartaz-padrao.jpg'; draft.flyerAsset = null; editorView(); return; }
  if (a === 'save') { await saveDraft({ publish: true }); return; }
  if (a === 'toggle-vip') { showVipForm = !showVipForm; const id = location.pathname.split('/').pop(); eventActivityView(id); return; }
  if (a === 'cancel-vip') { showVipForm = false; eventActivityView(location.pathname.split('/').pop()); return; }
  if (a === 'expire') {
    if (!confirm('Cancelar esta reserva agora e libertar os lugares?')) return;
    try { await api('/api/team/orders/' + action.dataset.order + '/expire', { method: 'POST' }); orderDetailView(action.dataset.order); toast('Reserva cancelada.'); }
    catch (err) { toast(err.message); }
    return;
  }
  if (a === 'copy-bank') {
    const d = JSON.parse(action.dataset.order);
    copyText(`Banco: ${d.p.bank}\nTitular: ${d.p.holder}\nIBAN: ${d.p.iban}${d.p.account ? '\nConta: ' + d.p.account : ''}\nMontante: ${money(d.total)}\nReferência: ${d.id}`);
    return;
  }
  if (a === 'step') { stepCart(action.dataset.lot, Number(action.dataset.delta)); return; }
  if (a === 'open-sheet') { $('#sheet')?.classList.add('on'); setTimeout(() => $('#rname')?.focus(), 60); return; }
  if (a === 'close-sheet') { $('#sheet')?.classList.remove('on'); return; }
});

function stepCart(lotId, delta) {
  const ev = currentSalesEvent;
  if (!ev) return;
  const lot = ev.lots.find(l => l.id === lotId);
  if (!lot) return;
  const current = cart.get(lotId) || 0;
  let next = current + delta;
  if (next > lot.available) { toast(`Só restam ${lot.available} lugares neste lote.`); next = lot.available; }
  if (next < 0) next = 0;
  cart.set(lotId, next);
  $$('[data-qty]').forEach(el => { if (el.dataset.qty === lotId) el.textContent = next; });
  const total = ev.lots.reduce((s, l) => s + l.price * (cart.get(l.id) || 0), 0);
  const count = Array.from(cart.values()).reduce((x, y) => x + y, 0);
  $$('[data-carttotal]').forEach(el => { el.textContent = money(total); });
  const bar = $('.pub-bar .sum small');
  if (bar) bar.textContent = count ? `${count} ingresso${count > 1 ? 's' : ''}` : 'Seleciona os ingressos';
  const cta = $('.pub-bar .cta');
  if (cta) cta.disabled = !count;
  updateSheetTotal(ev);
}

document.addEventListener('input', event => {
  const t = event.target;
  if (t.dataset?.ev && draft) {
    draft[t.dataset.ev] = t.value;
    if (t.dataset.ev === 'description') {
      const c = $('[data-count="description"]');
      if (c) c.textContent = t.value.length + '/240';
    }
    clearTimeout(window.__prev);
    window.__prev = setTimeout(refreshEditorPreview, 160);
  }
  if (t.dataset?.lotField && draft) {
    const row = t.closest('[data-lot]');
    const lot = draft.lots.find(l => l.id === row?.dataset.lot);
    if (lot) {
      lot[t.dataset.lotField] = t.value;
      const cap = $('.capacity');
      if (cap) cap.textContent = `Capacidade total: ${draft.lots.reduce((s, l) => s + num(l.qty), 0)} lugares`;
      clearTimeout(window.__prev);
      window.__prev = setTimeout(refreshEditorPreview, 160);
    }
  }
});

document.addEventListener('change', event => {
  if (event.target.id === 'flyerInput' && event.target.files?.[0]) uploadFlyer(event.target.files[0]);
});

document.addEventListener('dragover', e => {
  const dz = e.target.closest('#dropzone');
  if (!dz) return;
  e.preventDefault(); dz.classList.add('drag');
});
document.addEventListener('drop', e => {
  const dz = e.target.closest('#dropzone');
  if (!dz) return;
  e.preventDefault(); dz.classList.remove('drag');
  if (e.dataTransfer.files?.[0]) uploadFlyer(e.dataTransfer.files[0]);
});

document.addEventListener('submit', async event => {
  const form = event.target;

  if (form.id === 'reserveForm') {
    event.preventDefault();
    const items = Array.from(cart.entries()).filter(([, qty]) => qty > 0).map(([id, qty]) => ({ id, qty }));
    if (!items.length) { toast('Escolhe pelo menos um ingresso.'); return; }
    const name = form.name.value.trim();
    const national = form.phone.value.replace(/\D/g, '');
    const country = form.country.value;
    if (name.length < 2) { toast('Indica o teu nome.'); form.name.focus(); return; }
    if ((country === '244' && !/^9\d{8}$/.test(national)) || national.length < 7 || (country + national).length > 15) {
      toast(country === '244' ? 'Indica os 9 dígitos do número angolano, sem +244.' : 'Indica o número sem o indicativo.');
      form.phone.focus(); return;
    }
    const button = form.querySelector('.cta-w');
    button.disabled = true; button.innerHTML = '<span class="spin"></span> A reservar…';
    try {
      const data = await api('/api/public/reservations', {
        method: 'POST',
        body: { slug: form.dataset.slug, name, prefix: country, phone: national, aux: form.aux.value.trim(), items }
      });
      location.href = data.url;
    } catch (err) {
      toast(err.message);
      button.disabled = false; button.textContent = 'Criar reserva · 12 h';
    }
    return;
  }

  if (form.id === 'capacityForm') {
    event.preventDefault();
    const evId = form.dataset.event;
    try {
      await api('/api/team/events/' + evId + '/capacity', { method: 'POST', body: { venueCapacity: form.venueCapacity.value } });
      await eventActivityView(evId); toast('Capacidade atualizada.');
    } catch (err) { toast(err.message); }
    return;
  }

  if (form.id === 'vipForm') {
    event.preventDefault();
    const evId = location.pathname.split('/').pop();
    try {
      await api('/api/team/credentials', {
        method: 'POST',
        body: {
          eventId: evId, name: form.guestName.value.trim(), origin: form.origin.value,
          invitedBy: form.invitedBy.value.trim(), operator: form.operator.value.trim(),
          prefix: form.prefix.value, phone: form.phone.value, ticketLink: form.ticketLink.value.trim(),
          notes: form.notes.value.trim()
        }
      });
      showVipForm = false;
      await eventActivityView(evId);
      toast('Credenciamento VIP criado, sem prazo de expiração.');
    } catch (err) { toast(err.message); }
    return;
  }

  if (form.id === 'attachForm') {
    event.preventDefault();
    const orderId = form.dataset.order;
    const file = form.querySelector('#attachFile').files?.[0];
    if (!file) { toast('Escolhe o comprovativo recebido.'); return; }
    if (file.size > 20 * 1024 * 1024) { toast('O ficheiro é demasiado grande.'); return; }
    try {
      const blob = await compressImage(file, 1400);
      const asset = await api('/api/team/assets?kind=proof', { method: 'POST', raw: { body: blob, type: 'image/jpeg' } });
      await api('/api/team/orders/' + orderId + '/proof', { method: 'POST', body: { assetId: asset.assetId, filename: file.name } });
      await orderDetailView(orderId);
      toast('Comprovativo anexado. Falta confirmar o crédito.');
    } catch (err) { toast(err.message); }
    return;
  }

  if (form.id === 'approveForm') {
    event.preventDefault();
    const orderId = form.dataset.order;
    if (!form.operator.value.trim() || !form.bankRef.value.trim()) { toast('Indica quem conferiu e a referência do movimento.'); return; }
    try {
      await api('/api/team/orders/' + orderId + '/confirm', {
        method: 'POST',
        body: {
          operator: form.operator.value.trim(), bankRef: form.bankRef.value.trim(),
          amount: num(form.amount.value), ticketLink: form.ticketLink.value.trim()
        }
      });
      await orderDetailView(orderId);
      toast('Compra confirmada.');
    } catch (err) { toast(err.message); }
    return;
  }
});

/* ---------- encaminhador ---------- */
async function route() {
  const parts = location.pathname.split('/').filter(Boolean);
  const isPublic = parts[0] === 'e' && parts[1];
  const isClient = parts[0] === 'r' && parts[1];

  if (isPublic) { await salesView(parts[1]).catch(() => { location.href = '/e/' + parts[1]; }); return; }
  if (isClient) { await clientView(parts[1]); return; }

  if (!session) {
    try { session = (await api('/api/auth/me')).user; } catch { session = null; }
  }

  if (parts[0] === 'instalar') { location.replace('/entrar'); return; }
  if (parts[0] === 'entrar') { loginView(); return; }
  if (!session) { location.replace('/entrar'); return; }

  document.body.className = 'team';
  if (parts[0] === 'equipa' && parts[1] === 'novo') { await openEditor(null); return; }
  if (parts[0] === 'equipa' && parts[1] === 'editar' && parts[2]) { await openEditor(parts[2]); return; }
  if (parts[0] === 'equipa' && parts[1] === 'evento' && parts[2]) { await eventActivityView(parts[2]); return; }
  if (parts[0] === 'equipa' && parts[1] === 'reservas' && parts[2]) { await orderDetailView(parts[2]); return; }
  if (parts[0] === 'equipa' && parts[1] === 'reservas') { await ordersView(); return; }
  if (parts[0] === 'equipa' && parts[1] === 'conta') { accountView(); return; }
  if (parts[0] === 'equipa') { await eventsView(); return; }
  location.href = '/equipa/eventos';
}


/* ---------- conta ---------- */
function accountView() {
  $('#app').innerHTML = consoleShell('eventos', `
    <div class="acct">
      <h1>Conta</h1>
      <p class="tsub">Muda a palavra-passe de acesso à consola.</p>
      <div class="acctwho"><b>${esc(session?.name || '')}</b><span>${esc(session?.email || '')}${session?.role === 'admin' ? ' · administrador' : ''}</span></div>
      <form id="pwForm" autocomplete="off">
        <div class="fld"><span class="lbl">Palavra-passe atual</span>
          <input type="password" name="current" autocomplete="current-password" required></div>
        <div class="fld"><span class="lbl">Nova palavra-passe (10 caracteres ou mais)</span>
          <input type="password" name="next" autocomplete="new-password" minlength="10" required></div>
        <div class="fld"><span class="lbl">Repetir a nova palavra-passe</span>
          <input type="password" name="again" autocomplete="new-password" required></div>
        <div id="pwMsg" class="acctmsg"></div>
        <button class="btn btn-p" type="submit">Guardar nova palavra-passe</button>
      </form>
    </div>`);

  const form = $('#pwForm');
  const msg = $('#pwMsg');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const atual = String(data.get('current') || '');
    const nova = String(data.get('next') || '');
    const igual = String(data.get('again') || '');
    if (nova.length < 10) { msg.innerHTML = '<span class="bad">A nova palavra-passe precisa de 10 caracteres ou mais.</span>'; return; }
    if (nova !== igual) { msg.innerHTML = '<span class="bad">As duas palavras-passe novas não coincidem.</span>'; return; }
    const btn = form.querySelector('button');
    btn.disabled = true; btn.textContent = 'A guardar…';
    try {
      await api('/api/team/password', { method: 'POST', body: { currentPassword: atual, newPassword: nova } });
      msg.innerHTML = '<span class="good">Palavra-passe alterada. Usa a nova da próxima vez que entrares.</span>';
      form.reset();
    } catch (err) {
      msg.innerHTML = `<span class="bad">${esc(err.message)}</span>`;
    }
    btn.disabled = false; btn.textContent = 'Guardar nova palavra-passe';
  });
}

window.addEventListener('popstate', () => route());
route();
