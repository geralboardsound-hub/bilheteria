# BILHETERIA — pacote completo

**Uma pasta, tudo dentro.** Instala, atualiza, repõe a conta e diagnostica.
Não há ficheiros espalhados, nem página de instalação, nem token.

| Acesso | |
|---|---|
| Único endereço | `https://bilheteria.….workers.dev/entrar` |
| E-mail | `geral.boardsound@gmail.com` |
| Palavra-passe | `@Angola123` |

> A conta de administrador é criada **pela própria aplicação** na primeira ligação
> à base de dados. Não depende de migração, de token nem de nenhum passo manual.
> Por isso o login funciona numa base de dados nova e numa base de dados vazia.

---

## 1. Primeira instalação (15 min)

1. **Conta Cloudflare** — `https://dash.cloudflare.com/sign-up` → confirmar no e-mail → plano **Free**.
2. **Node.js** — `https://nodejs.org` → botão verde **LTS** → Next, Next, Install → **reiniciar o computador**.
3. **Extrair** este `.zip` em Documentos, pasta `bilheteria`.
4. Duplo clique em **`INSTALAR-WINDOWS.cmd`**:
   - abre o navegador → escolhe a conta → **Allow**;
   - cria a base de dados `bilheteria`, as tabelas e o administrador;
   - publica e **testa o login no servidor** — tem de aparecer `✔ Login de administrador confirmado`.
5. Guardar o endereço `https://bilheteria.….workers.dev` que aparece no fim.

Se o navegador mostra a conta antiga: carrega no nome da conta (canto superior direito)
e escolhe a nova, ou usa uma janela anónima. O script `TROCAR-CONTA.cmd` faz isto por ti.

---

## 2. Atualizar depois (1 min)

1. Extrair o `.zip` novo **por cima** da pasta `bilheteria` → substituir tudo.
2. Duplo clique em **`ATUALIZAR-WINDOWS.cmd`** → esperar **CONCLUÍDO**.
3. **Ctrl+F5** na consola.

Nunca apaga eventos, reservas, comprovativos, contas nem palavras-passe. O ficheiro
`wrangler.toml` (com o teu Database ID) **não vem no zip**, por isso nunca é substituído.

---

## 3. Se não conseguir entrar

| Passo | Ficheiro | O que faz |
|---|---|---|
| 1.º | `DIAGNOSTICO.cmd` | Diz exatamente o que falha (conta, base, contas de equipa, versão) e **testa o login real**. Corrige o que pode. |
| 2.º | `REPOR-ADMIN.cmd` | Repõe `geral.boardsound@gmail.com` / `@Angola123`. Não apaga nada. |
| 3.º | `TROCAR-CONTA.cmd` | Se o `wrangler` está preso na conta antiga: faz logout, entra na nova e fixa o `account_id` no projeto. |

O ecrã de login mostra em rodapé a versão do servidor e o número de contas —
se disser `0 conta(s)`, a base está vazia e o `DIAGNOSTICO.cmd` resolve.

---

## 4. Links da aplicação

| Endereço | Função |
|---|---|
| `…/entrar` | **Único acesso da equipa.** `/` e `/instalar` redirecionam para aqui |
| `…/equipa/eventos` | Consola (pede login) |
| `…/equipa/conta` | Mudar a palavra-passe |
| `…/e/nome-do-evento` | Página de vendas **de cada evento** — o link que envias aos clientes |
| `…/r/código` | Link pessoal de cada pedido, gerado na reserva |

---

## 5. Criar o primeiro evento

**Criar evento** → nome, data, recinto, capacidade → **dados bancários**
(Banco, Titular, IBAN, WhatsApp que recebe comprovativos) → **lotes**
(nome, preço em Kz, quantidade) → **Publicar** → copiar o link `/e/…`.

Fluxo diário: cliente reserva (12 h) → recebe IBAN e botão de WhatsApp → paga e envia
comprovativo → equipa confere na conta BNI, anexa o comprovativo e **Confirma** com o
valor certo → cliente recebe o ingresso no mesmo link. Sem pagamento, o pedido
cancela-se sozinho e os lugares voltam a ficar disponíveis.

---

## 6. Manutenção

```
npx wrangler d1 export bilheteria --remote --output copia.sql     (cópia de segurança)
npx wrangler tail                                                  (registos em direto)
```

Plano gratuito: 100 000 pedidos/dia · D1: 5 M leituras/dia, 100 000 escritas/dia, 5 GB.

---

## Histórico

| Versão | O que mudou |
|---|---|
| **1.3.0** | **Corrigido o login em produção**: o Cloudflare recusa PBKDF2 acima de 100 000 iterações e a versão anterior usava 210 000 — o login respondia erro 500 sem explicação. Custo reduzido para 20 000 (dentro do limite e do CPU do plano gratuito); contas gravadas em formato antigo são convertidas automaticamente no arranque; o ecrã de login passa a mostrar o motivo real da recusa |
| 1.2.0 | A aplicação cria as tabelas **e** o administrador sozinha no primeiro acesso — login já não depende de migração; ecrã de login mostra versão e nº de contas; pacote único com todos os scripts |
| 1.1.0 | Removida a página/token de instalação; único acesso em `/entrar`; `DIAGNOSTICO.cmd` |
| 1.0.0 | Projeto novo `bilheteria`; administrador na migração |
