#!/usr/bin/env node
/**
 * ATUALIZAÇÃO da Bilheteria.
 * Publica as alterações sem tocar nos dados: eventos, reservas, contas e
 * palavras-passe ficam exatamente como estão.
 *
 * Usar:  duplo clique em ATUALIZAR-WINDOWS.cmd
 *        node atualizar.mjs --ensaio   (mostra o que faria, sem publicar)
 *        node atualizar.mjs --local    (teste na base de dados local)
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { criarAdmin, CONTA } from './semente.mjs';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const JANELA = process.platform === 'win32';
const ENSAIO = process.argv.includes('--ensaio');
const LOCAL = process.argv.includes('--local');
const TOML = path.join(RAIZ, 'wrangler.toml');
const MARCA = 'SUBSTITUIR_PELO_DATABASE_ID';
const DB = 'bilheteria';

const titulo = (t) => console.log('\n' + '─'.repeat(56) + '\n  ' + t + '\n' + '─'.repeat(56));
const ok = (t) => console.log('  ✔ ' + t);
const aviso = (t) => console.log('  ! ' + t);

function wr(args) {
  const argv = JANELA ? ['/c', 'npx', 'wrangler', ...args] : ['wrangler', ...args];
  const r = spawnSync(JANELA ? 'cmd.exe' : 'npx', argv, {
    cwd: RAIZ, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' }
  });
  return { status: r.status, saida: `${r.stdout || ''}\n${r.stderr || ''}`.trim() };
}

function passo(args) {
  const argv = JANELA ? ['/c', 'npx', 'wrangler', ...args] : ['wrangler', ...args];
  return spawnSync(JANELA ? 'cmd.exe' : 'npx', argv, { cwd: RAIZ, stdio: 'inherit' });
}

const versao = existsSync(path.join(RAIZ, 'VERSAO'))
  ? readFileSync(path.join(RAIZ, 'VERSAO'), 'utf8').trim()
  : '1.1.0';

console.log('\n  BILHETERIA · atualização');
console.log(`  Versão a instalar: ${versao}`);

/* 1. pasta certa */
titulo('1 de 5 · Confirmar a pasta');
if (!existsSync(path.join(RAIZ, 'src', 'index.js')) || !existsSync(TOML)) {
  aviso('Esta pasta não é a da aplicação (falta wrangler.toml ou src/index.js).');
  console.log("\n  Extrai o conteúdo do .zip POR CIMA da pasta 'bilheteria' que já usas.");
  process.exit(1);
}
const toml = readFileSync(TOML, 'utf8');
if (toml.includes(MARCA)) {
  aviso('O wrangler.toml ainda não tem o Database ID — esta pasta nunca foi instalada.');
  console.log('\n  Corre INSTALAR-WINDOWS.cmd nesta pasta.');
  process.exit(1);
}
ok('Pasta correta e base de dados configurada.');

/* 2. componentes */
titulo('2 de 5 · Componentes');
if (ENSAIO) ok('[ensaio] instalaria as ferramentas (npm install).');
else {
  const r = spawnSync(JANELA ? 'cmd.exe' : 'npm',
    JANELA ? ['/c', 'npm', 'install', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'],
    { cwd: RAIZ, stdio: 'inherit', env: process.env });
  if (r.status !== 0) { aviso('Falhou por falta de Internet? Tenta de novo.'); process.exit(1); }
  ok('Ferramentas prontas.');
}

/* 3. conta Cloudflare */
titulo('3 de 5 · Conta Cloudflare');
if (ENSAIO || LOCAL) ok(LOCAL ? 'Teste local — sem contactar a Cloudflare.' : '[ensaio] verificaria a sessão.');
else {
  const q = wr(['whoami']);
  const dentro = /associated with the email|You are logged in/i.test(q.saida) && !/not authenticated|You are not/i.test(q.saida);
  if (dentro) ok('Sessão ativa.');
  else {
    console.log('\n  A sessão expirou. Vai abrir o navegador: escolhe a conta da Bilheteria e');
    console.log('  carrega em "Allow".\n');
    const r = passo(['login']);
    if (r.status !== 0) { aviso('O login não terminou.'); process.exit(1); }
  }
}

/* 4. tabelas novas, se existirem */
titulo('4 de 5 · Base de dados');
if (ENSAIO) ok('[ensaio] aplicaria só migrações novas.');
else {
  const r = wr(['d1', 'migrations', 'apply', DB, LOCAL ? '--local' : '--remote']);
  if (r.status !== 0) {
    console.log('\n' + r.saida.slice(-1200));
    aviso('Falhou nas tabelas. Nada foi publicado — a versão anterior continua no ar.');
    process.exit(1);
  }
  if (/No migrations to apply/i.test(r.saida)) ok('Sem alterações de esquema — dados intactos.');
  else ok('Migrações novas aplicadas — dados existentes preservados.');
}

/* 5. publicar */
titulo('5 de 5 · Publicar');
let url = existsSync(path.join(RAIZ, 'URL-APP')) ? readFileSync(path.join(RAIZ, 'URL-APP'), 'utf8').trim() : null;
if (ENSAIO || LOCAL) ok(LOCAL ? 'Teste local — publicação ignorada.' : '[ensaio] aqui publicaria.');
else {
  const r = wr(['deploy']);
  const m = r.saida.match(/https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+\.workers\.dev/);
  if (m) url = m[0];
  if (r.status !== 0) {
    console.log(r.saida.slice(-1500));
    aviso('A publicação falhou. A versão anterior continua no ar — nada se perdeu.');
    process.exit(1);
  }
  ok('Nova versão no ar.');
  if (url) writeFileSync(path.join(RAIZ, 'URL-APP'), url + '\n', 'utf8');
}

/* conferir contas e testar login */
let contas = null;
if (!ENSAIO && url) {
  try {
    const res = await fetch(url + '/api/diag', { headers: { 'cache-control': 'no-cache' } });
    const d = await res.json().catch(() => ({}));
    if (d?.ok) contas = d;
  } catch { }
}

titulo('CONCLUÍDO');
console.log(`\n  Versão ${versao} publicada.`);
if (url) console.log('  Endereço: ' + url);

if (contas) {
  console.log(`  Contas: ${contas.users} · Eventos: ${contas.events}`);
  if (contas.users === 0) {
    console.log('\n  A base de dados não tem contas — a criar a de administrador.');
    const r = criarAdmin({ remote: true });
    if (r.ok) console.log(`  E-mail: ${CONTA.email}\n  Palavra-passe: ${CONTA.password}`);
    else { aviso('Não consegui criar.'); console.log('  Corre REPOR-ADMIN.cmd.'); }
  }
} else if (!ENSAIO) {
  console.log('  (não consegui confirmar as contas — usa DIAGNOSTICO.cmd se não entrares)');
}

console.log(`
  Abre a consola e faz Ctrl+F5 (recarregar sem cache):
      ${url ? url + '/entrar' : '(o endereço da aplicação)/entrar'}

  Se o login falhar: DIAGNOSTICO.cmd diz o que está errado e corrige.
`);
