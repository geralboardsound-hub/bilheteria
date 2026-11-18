#!/usr/bin/env node
/**
 * Diagnóstico da Bilheteria: diz exatamente o que está errado no acesso.
 * Verifica conta Cloudflare, projeto publicado, base de dados, contas de equipa
 * e testa o login real. Corrige o que pode corrigir sozinho.
 *
 * Usar: duplo clique em DIAGNOSTICO.cmd
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { criarAdmin, CONTA } from './semente.mjs';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const JANELA = process.platform === 'win32';
const ok = (t) => console.log('  ✔ ' + t);
const mau = (t) => console.log('  ✖ ' + t);
const info = (t) => console.log('    ' + t);

function wr(args) {
  const argv = JANELA ? ['/c', 'npx', 'wrangler', ...args] : ['wrangler', ...args];
  const r = spawnSync(JANELA ? 'cmd.exe' : 'npx', argv, {
    cwd: RAIZ, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' }
  });
  return { status: r.status, saida: `${r.stdout || ''}\n${r.stderr || ''}`.trim() };
}

const url = existsSync(path.join(RAIZ, 'URL-APP')) ? readFileSync(path.join(RAIZ, 'URL-APP'), 'utf8').trim() : null;

console.log('\n  DIAGNÓSTICO DA BILHETERIA\n  ' + '─'.repeat(50));

/* 1. conta */
console.log('\n  1) Conta Cloudflare');
const w = wr(['whoami', '--json']);
let conta = null;
try { conta = JSON.parse(w.saida.slice(w.saida.indexOf('{'))); } catch { }
if (conta?.loggedIn) ok('Ligado como ' + (conta.email || '(sem e-mail)'));
else { mau('Nenhuma conta ligada. Corre TROCAR-CONTA.cmd ou INSTALAR-WINDOWS.cmd.'); process.exit(1); }

/* 2. base de dados */
console.log('\n  2) Base de dados "bilheteria"');
const lista = wr(['d1', 'list', '--json']);
const nomes = [...lista.saida.matchAll(/"(?:name|database_name)"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
const existe = nomes.includes('bilheteria');
if (existe) ok('Existe nesta conta.');
else { mau('Não existe nesta conta — o instalador cria-a em INSTALAR-WINDOWS.cmd.'); info('Bases encontradas: ' + (nomes.join(', ') || 'nenhuma')); }

/* 3. contas de equipa */
console.log('\n  3) Contas de equipa na base de dados');
let usuarios = null;
if (existe) {
  const q = wr(['d1', 'execute', 'bilheteria', '--remote', '--json', '--command', 'SELECT COUNT(*) AS n, SUM(CASE WHEN role = \'admin\' THEN 1 ELSE 0 END) AS a FROM users']);
  const n = q.saida.match(/"n"\s*:\s*(\d+)/);
  const a = q.saida.match(/"a"\s*:\s*(\d+)/);
  if (n) {
    usuarios = Number(n[1]);
    info(`${usuarios} conta(s), ${a ? a[1] : '?'} administrador(es).`);
    if (usuarios === 0) { mau('A base de dados não tem contas.'); }
    else ok('Contas presentes.');
  } else {
    mau('Não consegui ler a tabela de contas:');
    info(q.saida.slice(-400));
  }
}

/* 4. projeto publicado */
console.log('\n  4) Aplicação publicada');
if (url) info('Endereço registado: ' + url);
else mau('Não há endereço registado (ficheiro URL-APP). Indica-o tu:');
let alvo = url;
if (!alvo) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  alvo = (await rl.question('    Endereço (https://….workers.dev): ')).trim().replace(/\/+$/, '');
  rl.close();
}

let versaoApi = null, contagens = null;
try {
  const res = await fetch(alvo + '/api/diag', { headers: { 'cache-control': 'no-cache' } });
  const d = await res.json().catch(() => ({}));
  if (res.ok && d.ok) {
    versaoApi = d.version; contagens = d;
    ok(`Responde. Versão ${d.version} · ${d.users} conta(s) · ${d.events} evento(s).`);
    if (d.users === 0) mau('O servidor publicado não vê nenhuma conta — vou criar.');
  } else {
    mau('Respondeu ' + res.status + ': ' + JSON.stringify(d).slice(0, 200));
    info('A versão publicada pode ser anterior à 1.1.0 (sem /api/diag). Atualiza com ATUALIZAR-WINDOWS.cmd.');
  }
} catch (e) {
  mau('Não responde: ' + (e?.message || e));
  info('Confirma que o projeto está publicado e que o endereço está certo.');
}

/* 5. corrigir contas */
if (existe && (usuarios === 0 || contagens?.users === 0)) {
  console.log('\n  5) A criar a conta de administrador');
  const r = criarAdmin({ remote: true });
  if (r.ok) ok('Conta criada.');
  else { mau('Falhou:'); info(r.saida.slice(-500)); }
}

/* 6. teste de login real */
console.log('\n  6) Teste de login no servidor publicado');
try {
  const res = await fetch(alvo + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: alvo },
    body: JSON.stringify({ email: CONTA.email, password: CONTA.password })
  });
  const d = await res.json().catch(() => ({}));
  if (res.ok && d?.user) {
    ok('LOGIN OK — ' + d.user.email + ' (' + d.user.role + ')');
    console.log('\n  Entra em: ' + alvo + '/entrar\n');
  } else {
    mau(`Login recusado (${res.status}) ${JSON.stringify(d).slice(0, 160)}`);
    info('Se a versão publicada for antiga, atualiza primeiro: ATUALIZAR-WINDOWS.cmd.');
    info('Se continuar, a palavra-passe pode ter sido mudada: REPOR-ADMIN.cmd.');
  }
} catch (e) { mau('Não consegui testar: ' + (e?.message || e)); }

console.log('');
