#!/usr/bin/env node
/**
 * Instalador da Bilheteria.
 * Cria tudo numa conta Cloudflare nova: base de dados, tabelas (com a conta de
 * administrador já dentro), publicação — e no fim confirma que o login funciona.
 *
 * Usar:  duplo clique em INSTALAR-WINDOWS.cmd
 *        node instalar.mjs
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const JANELA = process.platform === 'win32';
const TOML = path.join(RAIZ, 'wrangler.toml');
const MARCA = 'SUBSTITUIR_PELO_DATABASE_ID';
const DB = 'bilheteria';
const CONTA = { email: 'geral.boardsound@gmail.com', password: '@Angola123' };
const rl = createInterface({ input: process.stdin, output: process.stdout });

const titulo = (t) => console.log('\n' + '─'.repeat(58) + '\n  ' + t + '\n' + '─'.repeat(58));
const ok = (t) => console.log('  ✔ ' + t);
const aviso = (t) => console.log('  ! ' + t);

function wrangler(args, { entrada = null } = {}) {
  const argv = JANELA ? ['/c', 'npx', 'wrangler', ...args] : ['wrangler', ...args];
  const r = spawnSync(JANELA ? 'cmd.exe' : 'npx', argv, {
    cwd: RAIZ, encoding: 'utf8', input: entrada, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' }
  });
  return { status: r.status, saida: `${r.stdout || ''}\n${r.stderr || ''}`.trim() };
}

const idDaBase = (t) => {
  const m = String(t).match(/database_id\s*[=:]\s*"([0-9a-fA-F-]{32,40})"/);
  return m ? m[1] : null;
};

async function main() {
  console.log(`
  ╔══════════════════════════════════════════════════════════╗
  ║              BILHETERIA · INSTALAÇÃO                     ║
  ╚══════════════════════════════════════════════════════════╝`);

  titulo('1 de 6 · Computador');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    aviso(`Node.js ${process.versions.node} é antigo.`);
    console.log('  Instala a versão LTS em https://nodejs.org e repete.');
    process.exit(1);
  }
  ok(`Node.js ${process.versions.node}.`);

  console.log('\n  A instalar componentes (1-3 min, é normal parecer parado)...');
  const npmArgs = JANELA ? ['/c', 'npm', 'install', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'];
  const npm = spawnSync(JANELA ? 'cmd.exe' : 'npm', npmArgs, { cwd: RAIZ, stdio: 'inherit', env: process.env });
  if (npm.status !== 0) { aviso('Falhou a instalação dos componentes — verifica a Internet.'); process.exit(1); }
  ok('Componentes prontos.');

  titulo('2 de 6 · Entrar na conta Cloudflare');
  let dentro = false;
  const quem = wrangler(['whoami']);
  dentro = /associated with the email|You are logged in/i.test(quem.saida) && !/not authenticated|You are not/i.test(quem.saida);
  if (dentro) ok('Sessão já ativa.');
  else {
    console.log('\n  Vai abrir o navegador. Escolhe a conta da Bilheteria e carrega em');
    console.log('  "Allow" (permitir). Depois volta a esta janela.\n');
    const argv = JANELA ? ['/c', 'npx', 'wrangler', 'login'] : ['wrangler', 'login'];
    const r = spawnSync(JANELA ? 'cmd.exe' : 'npx', argv, { cwd: RAIZ, stdio: 'inherit' });
    if (r.status !== 0) { aviso('O login não terminou.'); process.exit(1); }
    ok('Sessão iniciada.');
  }

  titulo('3 de 6 · Base de dados');
  let dbId = idDaBase(readFileSync(TOML, 'utf8'));
  if (dbId) ok('Base de dados já configurada neste projeto.');
  else {
    const r = wrangler(['d1', 'create', DB]);
    dbId = idDaBase(r.saida);
    if (!dbId) {
      if (/already exists/i.test(r.saida)) {
        aviso('Já existe uma base de dados "bilheteria" nesta conta.');
        const lista = wrangler(['d1', 'list', '--json']);
        const ids = [...lista.saida.matchAll(/"uuid"\s*:\s*"([0-9a-fA-F-]{32,40})"/g)].map((m) => m[1]);
        dbId = ids[0] || null;
        if (dbId) ok('Usei a base de dados existente.');
      }
      if (!dbId) {
        console.log('\n  ' + r.saida.slice(-900));
        console.log('\n  Copia o "Database ID" em dash.cloudflare.com → Storage & Databases → D1');
        const resp = (await rl.question('  Cola aqui e prime Enter: ')).trim();
        dbId = idDaBase(`database_id = "${resp}"`);
        if (!dbId) { aviso('Valor inválido.'); process.exit(1); }
      }
    } else ok('Base de dados criada.');
    writeFileSync(TOML, readFileSync(TOML, 'utf8').replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${dbId}"`), 'utf8');
  }

  titulo('4 de 6 · Tabelas + administrador');
  const mig = wrangler(['d1', 'migrations', 'apply', DB, '--remote']);
  if (mig.status !== 0) {
    console.log('\n' + mig.saida.slice(-1400));
    aviso('Não consegui preparar as tabelas. Nada foi publicado.');
    process.exit(1);
  }
  ok('Tabelas criadas — a conta de administrador já está dentro.');

  titulo('5 de 6 · Publicar');
  const dep = wrangler(['deploy']);
  if (dep.status !== 0) {
    console.log(dep.saida.slice(-1600));
    aviso('A publicação falhou. Envia esta mensagem a quem te deu a pasta.');
    process.exit(1);
  }
  const m = dep.saida.match(/https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+\.workers\.dev/);
  let url = m ? m[0] : null;
  if (!url) {
    const resp = (await rl.question('\n  Cola o endereço https://….workers.dev que apareceu acima: ')).trim();
    url = resp.replace(/\/+$/, '');
  }
  writeFileSync(path.join(RAIZ, 'URL-APP'), url + '\n', 'utf8');
  ok('Publicado.');

  titulo('6 de 6 · Confirmar o acesso');
  let loginOk = false;
  try {
    const res = await fetch(url + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: url },
      body: JSON.stringify({ email: CONTA.email, password: CONTA.password })
    });
    const dados = await res.json().catch(() => ({}));
    loginOk = res.ok && dados?.user?.role === 'admin';
    if (!loginOk) console.log(`  resposta ${res.status}: ${JSON.stringify(dados).slice(0, 200)}`);
  } catch (e) {
    console.log('  não consegui contactar o endereço: ' + (e?.message || e));
  }
  if (loginOk) ok('Login de administrador confirmado no servidor.');
  else aviso('Não consegui confirmar o login — vê a nota no fim.');

  titulo('ESTÁ PRONTO');
  console.log(`
  Endereço:   ${url}

  Entrar:     ${url}/entrar
  E-mail:     ${CONTA.email}
  Palavra-passe: ${CONTA.password}
${loginOk ? '\n  ✔ O acesso já foi testado por este instalador.' : '\n  ! Se não entrares, corre REPOR-ADMIN.cmd e tenta de novo.'}

  Depois de entrares: canto superior direito → "Conta" → mudar a palavra-passe.

  Criar o primeiro evento:
    Criar evento → nome, data, capacidade → dados bancários (Banco, Titular,
    IBAN, WhatsApp) → lotes (preço em Kz) → Publicar → copiar o link /e/…
`);
}

main().catch((e) => { console.log('\n  Erro: ' + (e?.message || e)); process.exit(1); }).finally(() => rl.close());
