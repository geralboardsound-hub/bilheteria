#!/usr/bin/env node
/**
 * Trocar de conta Cloudflare.
 * Desliga o wrangler da conta antiga e liga-o à conta nova, mostrando no fim
 * qual conta ficou ativa (e, se houver várias, fixa a certa no projeto).
 *
 * Usar: duplo clique em TROCAR-CONTA.cmd
 *        node trocar-conta.mjs
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const JANELA = process.platform === 'win32';
const TOML = path.join(RAIZ, 'wrangler.toml');
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

function quemSou() {
  const r = wrangler(['whoami', '--json']);
  try {
    const dados = JSON.parse(r.saida.slice(r.saida.indexOf('{')));
    return dados && dados.loggedIn ? dados : null;
  } catch { return null; }
}

async function main() {
  console.log(`
  ╔══════════════════════════════════════════════════════════╗
  ║        BILHETERIA · TROCAR DE CONTA CLOUDFLARE           ║
  ╚══════════════════════════════════════════════════════════╝`);

  /* 1. variáveis de ambiente que forçam outra conta */
  titulo('1 de 4 · Verificar o que está a mandar na conta');
  const variaveis = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'CF_API_TOKEN']
    .filter((v) => process.env[v]);
  if (variaveis.length) {
    aviso('Estas variáveis estão definidas e SOBREPÕEM-SE ao login: ' + variaveis.join(', '));
    console.log('  Se o instalador continuar a usar a conta antiga, é por causa delas.');
    const r = (await rl.question('\n  Remover estas variáveis só nesta sessão? (s/n) ')).trim().toLowerCase();
    if (r.startsWith('s')) {
      for (const v of variaveis) delete process.env[v];
      ok('Removidas nesta janela. (Se forem definidas no Windows, remove-as em Variáveis de Ambiente.)');
    }
  } else ok('Nenhuma variável de ambiente a forçar conta.');

  /* 2. quem está ligado agora */
  titulo('2 de 4 · Conta ligada neste momento');
  const antes = quemSou();
  if (antes) {
    ok(`Ligado como ${antes.email || '(sem e-mail)'}`);
    const contas = antes.accounts || antes.memberships || [];
    for (const c of contas) console.log(`      · ${c.name || c.account_name}  (${c.id || c.account_id})`);
  } else ok('Nenhuma conta ligada — ainda mais simples.');

  if (antes) {
    console.log('\n  A desligar a conta antiga...');
    wrangler(['logout']);
    const depois = quemSou();
    if (depois) {
      const cfg = path.join(os.homedir(), '.wrangler', 'config', 'default.toml');
      if (existsSync(cfg)) {
        const copia = cfg + '.bkp';
        try {
          writeFileSync(copia, readFileSync(cfg));
          console.log(`  Guardei uma cópia em ${copia}`);
          writeFileSync(cfg, '');
          ok('Credenciais antigas apagadas.');
        } catch (e) { aviso('Não consegui apagar o ficheiro: ' + (e?.message || e)); }
      }
    } else ok('Sessão antiga encerrada.');
  }

  /* 3. entrar na conta nova */
  titulo('3 de 4 · Entrar na conta nova');
  console.log(`
  Vai abrir o navegador. ATENÇÃO ao ecrã que aparecer:

    · se mostrar a conta ANTIGA no canto, carrega no nome da conta e escolhe
      a nova (ou "Use a different account" / "Sign in to a different account");
    · se não houver como trocar, fecha essa janela, abre
      https://dash.cloudflare.com/logout no navegador, e corre este ficheiro outra vez;
    · no fim, carrega em "Allow" (permitir).

  Uma janela anónima/privada também resolve — o login fica separado do antigo.
`);
  await rl.question('  Prime Enter quando estiveres pronto... ');
  const login = spawnSync(JANELA ? 'cmd.exe' : 'npx', JANELA ? ['/c', 'npx', 'wrangler', 'login'] : ['wrangler', 'login'], { cwd: RAIZ, stdio: 'inherit' });
  if (login.status !== 0) { aviso('O login não terminou.'); process.exit(1); }

  const agora = quemSou();
  if (!agora) { aviso('Ainda não há conta ligada. Repete o passo 3.'); process.exit(1); }
  ok(`Ligado como ${agora.email}`);

  /* 4. fixar a conta certa no projeto */
  titulo('4 de 4 · Fixar a conta no projeto');
  const contas = agora.accounts || agora.memberships || [];
  let escolhida = null;
  if (contas.length === 1) {
    escolhida = contas[0];
    ok(`Só há uma conta: ${escolhida.name || escolhida.account_name}`);
  } else if (contas.length > 1) {
    console.log('\n  Esta conta participa em vários espaços. Qual é o da Bilheteria?\n');
    contas.forEach((c, i) => console.log(`    ${i + 1}) ${c.name || c.account_name}  (${c.id || c.account_id})`));
    const n = Number((await rl.question('\n  Número: ')).trim());
    escolhida = contas[n - 1] || contas[0];
  }

  if (escolhida) {
    const id = escolhida.id || escolhida.account_id;
    const nome = escolhida.name || escolhida.account_name;
    let toml = readFileSync(TOML, 'utf8');
    if (/^account_id\s*=/m.test(toml)) {
      toml = toml.replace(/^account_id\s*=.*$/m, `account_id = "${id}"`);
    } else {
      toml = toml.replace(/^name\s*=.*$/m, (linha) => `${linha}\naccount_id = "${id}"`);
    }
    writeFileSync(TOML, toml, 'utf8');
    ok(`Projeto preso ao espaço "${nome}" — o deploy nunca vai para a conta antiga.`);
  }

  titulo('CONCLUÍDO');
  console.log(`
  Conta ativa: ${agora.email}
${escolhida ? `  Espaço:      ${escolhida.name || escolhida.account_name}\n` : ''}
  Agora corre INSTALAR-WINDOWS.cmd (ou ATUALIZAR-WINDOWS.cmd se já estava instalado).
`);
}

main().catch((e) => { console.log('\n  Erro: ' + (e?.message || e)); process.exit(1); }).finally(() => rl.close());
