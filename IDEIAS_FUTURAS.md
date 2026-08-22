# Ideias futuras

Aberto em **21/08/2026**, junto com o freeze do bot.

**Regra do freeze:** no código só entra o que **quebra um fluxo** ou **põe dado em risco**.
Ideia nova, ajuste de texto, melhoria de fluxo — vem para cá.

Este arquivo é uma **fila**, não um plano. Nada aqui está aprovado, prometido ou agendado.

---

## 1. Os dois `catch` Tipo C que sobraram

A varredura de falha silenciosa de 21/08 achou 6 casos. Os dois piores foram consertados
(`database/db.js` e `utils/logRh.js` — ver `scripts/testes-falha-silenciosa.js`). Dos quatro
"Tipo C — loga e segue", dois se revelaram já tratados e dois continuam abertos:

| Local | O que silencia | Por que ficou |
|---|---|---|
| `commands/processo.js:1396` | `db.atualizar` do `diarioMessageId` da capa pública | A capa não atualiza e ninguém sabe. Não quebra fluxo nem perde dado — a capa é derivada, pode ser regerada |
| `utils/diarioAtos.js:199` | publicação no Diário | O `catch` está no fim de uma função que já devolve `false` em vários pontos legítimos; quem chama não distingue "não devia publicar" de "tentou e falhou" |

Já tratados, sem ação necessária: `commands/medida.js:761` (devolve `{postado:false, erro}` ao
chamador) e `utils/emissaoPeca.js:1394` (responde ao usuário na tela).

## 2. A varredura de `catch` tem um ponto cego conhecido

Ela pega `.catch` vazio e bloco `catch` sem `console`/`throw`. **Não pega** o caso de um `catch` que
loga em nível baixo dentro de uma função que devolve valor "ok" — para isso seria preciso analisar o
retorno de cada função, e isso não foi feito. Se um dia a varredura virar rotina, é aqui que ela
precisa crescer.

## 3. Backup: a checagem só roda no boot

`auditoria.avisarBackupAtrasado()` roda uma vez, no `ready`. Um bot que fica semanas de pé sem
reiniciar não é avisado se o `.bak` quebrar no meio do caminho. O gancho natural é o `setInterval`
de 10 minutos que já existe no `index.js` — mas aí precisa de throttle próprio no aviso, senão vira
uma mensagem a cada 10 minutos no canal de auditoria.

## 4. Role de cargo dada na mão pula o `/rh contratar` inteiro

Sem carteira, sem publicação no Diário, sem `logRh`, e o RH não fica sabendo. A reconciliação de
boot (`utils/reconciliacaoRoles.js`) desfaz — mas só no **próximo boot**, e até lá a pessoa lê os
canais-ticket, porque quem dá `ViewChannel` neles é a role, não o RH.

**Caso real, 21/08/2026:** `devilhelsing` (`1009949546278830080`) foi demitido pelo bot em 12/08 —
o audit log mostra `PODER JUDICIÁRIO#9208 −Promotor de Justiça`. Em 19/08 um humano (`uniao7345`)
devolveu a role à mão. Resultado: role de Promotor, nenhum registro no RH, e acesso a 31 canais
incluindo os 4 tickets abertos. Descoberto só porque a auditoria de catch silencioso foi olhar.

**Depois do freeze:** detectar por evento `GuildMemberUpdate` e avisar na auditoria **na hora**, em
vez de esperar o boot. O listener já existe no `index.js` para outros eventos de membro.

## 5. Processo já existente não converte para o modo in-game

O `modoEntrega` é carimbado na **criação** do processo e é imutável por decisão de projeto
(SPEC §11.2). Ligar o interruptor hoje não converte o que já existe: processo aberto antes continua
`aberto`/`legado` e nunca mostra o botão **Entregar agora**.

Isso é o desenho, e a imutabilidade tem razão de ser — mudar o modo no meio muda o que já foi
prometido às partes. Mas o efeito prático confunde: em 21/08 havia 1 processo `legado` e 2 `ingame`
no mesmo tribunal, e quem liga o interruptor espera que valha para tudo.

Ideia, não decisão: uma ação de staff explícita, um processo por vez, com registro nos autos —
nunca uma conversão em massa silenciosa.

## 6. `BASE_URL_PECAS` não está configurada

Sem ela, `servidorPecas.urlPublica()` devolve `null` e **o link da página do documento no jogo nunca
é gerado**. O servidor HTTP sobe e avisa no log, mas a metade in-game da entrega fica sem endereço.
Ver a pendência manual correspondente em `PENDENCIAS_MANUAIS.md`.

## 7. Aposentadoria do modo `legado` (SPEC §11.2.1)

Nenhum processo novo nasce `legado` desde 18/08. Quando o último processo `legado` for arquivado, o
ramo `MODOS.LEGADO` e o `modoDoProcesso()` que o produz podem sair do código. O botão
**📊 Relatório da entrega** no painel já serve para medir isso — é ele que diz quando chegou a hora.

## 8. Código de arquivo físico (`codigoArquivo`)

O campo existe em `utils/pecas.js`, nasce `null` e **não há nenhuma lógica de atribuição**. Foi
reservado de propósito para que acrescentá-lo depois não exija migrar registro nem mexer no rodapé
do PNG. Continua reservado.

## 9. Gemini: qual o teto do free-tier

A `GEMINI_API_KEY` está configurada e a revisão automática de fundamentação usa o modelo. Nunca foi
verificado qual é o limite diário do free-tier nem o que acontece com o fluxo quando ele estoura —
se o texto sai sem revisão, se a ação falha, ou se trava. Vale medir antes de depender disso num dia
de movimento.

## 10. Diário Oficial: varredura retroativa

Chegou a ser construído um paliativo de varredura do Diário e foi **descartado** em 21/08, porque a
política de sigilo que ele reimplementava **já existia completa** em `utils/diarioAtos.js`
(`MANDADOS_QUE_NUNCA_PUBLICAM`, `MANDADOS_QUE_PUBLICAM_AO_CUMPRIR`, `mandadoPodePublicar`).

O Diário foi conferido no mesmo dia: 0 publicações sigilosas em 35 mensagens de histórico. Não há
nada a limpar hoje. Se um dia houver, a varredura precisa nascer **lendo** a política que já existe,
não reescrevendo-a.

## 11. `FULL_RENDER=1` só no hook de pre-push

O dia a dia roda a suíte com renderização stubada (75s); a renderização integral só acontece no
push. É a troca certa hoje, mas significa que um defeito exclusivo do render real só aparece na
fronteira. Se a suíte ficar mais rápida, vale reconsiderar. Ver `scripts/README-testes.md`.
