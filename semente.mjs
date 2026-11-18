#!/usr/bin/env node
/**
 * Repõe a conta de administrador da Bilheteria (não apaga eventos nem reservas).
 * Usar: node semente.mjs            → ambiente publicado
 *        node semente.mjs --local    → base de dados local
 */
import { spawnSync } from 'node:child_process';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CONTA = { email: 'geral.boardsound@gmail.com', password: '@Angola123', name: 'Boardsound' };

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const JANELA = process.platform === 'win32';
const ITERACOES = 210000;

export function criarAdmin({ email = CONTA.email, password = CONTA.password, name = CONTA.name, remote = true } = {}) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, ITERACOES, 32, 'sha256');
  const q = (v) => "'" + String(v).replace(/'/g, "''") + "'";
  const sql = [
    `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ${q(email)});`,
    `DELETE FROM users WHERE email = ${q(email)};`,
    `INSERT INTO users (id, email, name, role, salt, hash, iterations, active, created_at)`,
    `VALUES ('u-ADMIN0001', ${q(email)}, ${q(name)}, 'admin', ${q(salt.toString('hex'))}, ${q(hash.toString('hex'))}, ${ITERACOES}, 1, ${Date.now()});`
  ].join(' ');

  const args = ['wrangler', 'd1', 'execute', 'bilheteria', remote ? '--remote' : '--local', '--command', sql];
  const r = spawnSync(JANELA ? 'cmd.exe' : 'npx', JANELA ? ['/c', 'npx', ...args] : args, {
    cwd: RAIZ, encoding: 'utf8',
    env: { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' }
  });
  const saida = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
  return { ok: r.status === 0 && /"success":\s*true/i.test(saida), saida };
}

const direto = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (direto) {
  const remote = !process.argv.includes('--local');
  console.log('\n  A repor a conta de administrador' + (remote ? '' : ' (local)') + '...');
  const r = criarAdmin({ remote });
  if (!r.ok) {
    console.log('\n  Falhou:\n' + r.saida.slice(-1200));
    process.exit(1);
  }
  console.log(`
  ✔ Pronto.
    E-mail:        ${CONTA.email}
    Palavra-passe: ${CONTA.password}
`);
}
