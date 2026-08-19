# Bloco F — Disponibilidade e distribuição

> **REGISTRADO, NÃO IMPLEMENTADO.** Decisão do operador em 18/08/2026. Este documento existe para
> que o desenho não se perca e para que ninguém construa metade dele por engano.

## Problema

O sorteio pode designar um juiz ou promotor que não entra no jogo há dias. O processo trava
esperando alguém perceber e substituir.

## Solução decidida

Botão **"Estou disponível"**. O sorteio passa a considerar **apenas** quem está marcado como
disponível.

## Regras já fechadas pelo operador

| Situação | Comportamento |
|---|---|
| Há disponíveis | Sorteia entre eles, por **rodízio** — não aleatório puro. Com dois disponíveis, o aleatório concentra tudo no mesmo. |
| Não há nenhum | O processo **fica em fila** (ordem de chegada) e o sistema avisa quem peticionou que não há juiz no momento — para ele saber que não é erro. |
| Alguém se marca disponível | O sorteio acontece **automaticamente**, sem intervenção. |
| Processo na fila, sem responsável | **NENHUM prazo corre** — nem válvula, nem prazo de decisão. O relógio só começa quando existe juiz (ou promotor) designado. |

Vale igualmente para o sorteio de promotor.

### Por que "nenhum prazo corre" é a regra mais importante daqui

Sem ela, o processo destrava sozinho pela válvula **sem nunca ter tido destinatário** — a entrega
in-game é pulada de graça, e o ato é lavrado como "distribuição automática pelo cartório" quando na
verdade não havia cartório nenhum para distribuir. É o furo que anula o desenho inteiro.

## Expiração da disponibilidade — decisão a tomar na implementação

O operador pediu que se defina. **Recomendação: os dois critérios juntos.**

1. **Tempo desde o clique** — expira em algumas horas. Sozinho é insuficiente: quem clica e desloga
   continua contando até o prazo vencer.
2. **Saída do Discord** — o evento `guildMemberRemove`/presença já é observado pela reconciliação de
   responsáveis (`utils/responsaveis.js`). Sozinho também é insuficiente: quem fica online no Discord
   mas sai do jogo continuaria "disponível".

Os dois juntos cobrem os dois modos de falha. O primeiro é o piso; o segundo é a correção imediata.

## Verificação pedida: isto atropela a §6.2 (vínculo por papel)?

**Não. E a verificação foi feita no código, não por raciocínio.**

São camadas diferentes, e elas se complementam:

- **Disponibilidade é PREVENÇÃO** — decide *quem entra* no papel.
- **Substituição (§6.2) é REMÉDIO** — conserta *quem já estava* e saiu. O substituto assume as
  entregas pendentes automaticamente, por papel, sem regenerar nada.

Nenhuma das duas lê o estado da outra. O sorteio filtra candidatos; a substituição opera sobre um
papel já ocupado.

### Mas a verificação achou um problema real — e ele foi corrigido

`pecas.reiniciarValvulaPorTroca` **existia, estava testado e nunca era chamado** — o sexto caso de
código órfão deste projeto. A regra da SPEC §7 ("a contagem reinicia na troca de responsável")
**não valia em produção**: o substituto herdava um caso cuja válvula já estava correndo e podia
destravar sozinho em minutos.

Isso interage diretamente com o Bloco F: de nada adianta escolher bem quem entra (disponibilidade)
se quem entra herda um relógio prestes a estourar. **Ligado em `utils/responsaveis.js`,
`trocarManual`.**

## O que NÃO construir

Registrado porque o operador foi explícito, e porque é a tentação óbvia de quem lê "disponibilidade":

- ❌ Sistema de presença ou "estou no fórum"
- ❌ Notificação de chegada
- ❌ Agendamento de encontro

Os jogadores **se telefonam dentro do jogo**. Coordenar encontro não é problema do software.
