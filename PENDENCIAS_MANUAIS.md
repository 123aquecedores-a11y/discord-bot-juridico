# Pendências manuais

O que só um humano pode rodar ou clicar. Atualizado em **21/08/2026**.

---

## Rodar no terminal

Registra os comandos de barra no Discord. **Não roda no boot** — é sempre manual, e é o que faz
`/rh contratar|demitir|licenca` passarem a exigir o campo **motivo**.

```bash
node deploy-commands.js
```

---

## Conferir no painel do Railway

Variáveis do serviço `discord-bot-juridico`, projeto `virtuous-perfection`.

| Variável | Estado esperado | Efeito se estiver errado |
|---|---|---|
| `RESETAR_BANCO` | **vazia ou removida** | Ligada, **zera o banco a cada redeploy** |
| `REFUNDAR_NUMERACAO` | **vazia ou removida** | Ligada, zera os contadores de numeração a cada redeploy |
| `SKIP_BOOT_TASKS` | **vazia ou removida** | É o freio de emergência. Só ligar se o boot der problema |
| `BASE_URL_PECAS` | **falta configurar** | Sem ela o link da página do documento no jogo nunca é gerado |
| `CANAL_AUDITORIA_ID` | configurada ✅ | Sem ela o aviso de backup quebrado fica só no log do container |
| `DADOS_JSON_PATH` | `/data/dados.json` ✅ | Fora do volume, o banco some a cada redeploy |

`BASE_URL_PECAS` recebe o domínio público do serviço no Railway, sem barra no fim.
Exemplo: `https://discord-bot-juridico-production.up.railway.app`

---

## Clicar no Discord

- **🛠️ Administração → 🔀 Modo Entrega In-Game** — confere o estado. Ligado em 18/08, verde.
- **🛠️ Administração → 📊 Relatório da entrega** — quantas entregas pendentes e quantos processos
  ainda no modo legado.
- **🛠️ Administração → 📜 Log de RH** — as contratações, demissões e licenças com motivo.

---

## Deploy

O deploy é automático a partir do `main` no GitHub. **Não usar `railway up`**: sobe o diretório
local, que tem script destrutivo fora do controle de versão.

```bash
git push origin main
```

O `pre-push` roda a suíte completa com `FULL_RENDER=1` antes de deixar subir. Para pular numa
emergência de verdade: `git push --no-verify`.
