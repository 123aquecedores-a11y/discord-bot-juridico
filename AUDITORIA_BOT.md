# AUDITORIA_BOT.md — Mapa completo e auditoria do bot jurídico

> **Auditoria READ-ONLY.** Nenhum arquivo de código foi alterado para produzir este documento.
> Repositório: `D:\discord-bot-juridico` · Node.js + discord.js v14 · banco JSON (`database/db.js` → `dados.json`).
> Citações no formato `arquivo:linha`. As mudanças planejadas (mover Petições→Processos, Ofício/Mandado→Medidas, Ficha→Supervisão, remover "Revisar texto", "medida provisória"→"medida cautelar", renomear Diário Oficial) estão mapeadas na **seção 5, Parte 2**.

---

## Índice
1. [Mapa funcional completo](#1-mapa-funcional-completo)
2. [Permissões por cargo](#2-permissões-por-cargo)
3. [Modelo de dados](#3-modelo-de-dados)
4. [Fluxos ponta a ponta](#4-fluxos-ponta-a-ponta)
5. [Redundâncias + impacto das mudanças planejadas](#5-redundâncias--impacto-das-mudanças-planejadas)
6. [Pontos de risco / inconsistência](#6-pontos-de-risco--inconsistência)
7. [Tabela-resumo final](#7-tabela-resumo-final)

---

## 1. Mapa funcional completo

### 1.1 Comandos slash
Registro por-guild: `deploy-commands.js:6-13` varre `commands/*.js`, lê `command.data.toJSON()`. Carregamento no runtime: `index.js:39-45`. **10 arquivos de comando**, todos com `data` + `execute`.

| Comando | Subcomandos (parâmetros) | O que faz | Arquivo |
|---|---|---|---|
| `/crime` | `buscar(termo*)` autocomplete | Consulta a base do Código Penal, devolve a tipificação | `crime.js:22` |
| `/ficha` (SISBAJUS) | `buscar(rg, discord, discord_id, termo)` | Consulta ficha central do cidadão (antecedentes) — Promotor+ | `ficha.js:303` |
| `/instituicao` | `adicionar`, `listar` | Cadastro de instituições destinatárias de ofício (árvore) | `instituicao.js:19` |
| `/mandado` | `ver(numero*)`, `listar(status)` | Consulta mandados (gerados ao referendar medida) | `mandado.js:198` |
| `/medida` | `solicitar(tipo*, alvo*, motivo*, alvo_discord, promotor)`, `ver(numero*)`, `listar(status)` | Pedido de medida (fase de inquérito); `solicitar` sorteia Promotor e envia ao MP | `medida.js:329` |
| `/oficio` | `criar(processo, destinatario*, assunto*, conteudo*, aguarda_retorno)` | Emite ofício (processo vazio = **avulso**); gera PNG; cópia à P. Civil se Delegado | `oficio.js:192` |
| `/painel` | — (sem opções) | Posta o menu interativo com todos os módulos em botões | `painel.js:1488` |
| `/peticao` | `porte-arma`, `troca-nome`, `limpeza-ficha`, `alvara-evento` (cada um com dados do cliente) | Petições administrativas protocoladas por Advogado em nome do cliente | `peticao.js:771` |
| `/processo` | `penal(crimes*, motivo*, promotor, reus, medida)`, `civil(nome_acao*, autor_nome*, reu_nome*, autor_discord*, reu_discord*)`, `listar`, `ver(numero*)`, `historico(numero*)` | Abre/consulta processos penais e civis | `processo.js:2222` |
| `/rh` | `contratar(usuario*, cargo*)`, `demitir(usuario*)`, `licenca(usuario*, afastado*)`, `listar(cargo*)` | Gestão de cargos jurídicos — **só Staff** | `rh.js:273` |

**Interações fora do `data`** (roteadas no mapa "bare" de `index.js:143-167`): `medida:{aprovar,negar,recorrer,referendar,cumprir,abrirprocesso,anexarindicios}`, `processo:{oferecer,arquivar,julgar}`, e o modal `medida:processomodal`.

### 1.2 Botões / modais / selects (por módulo)
Convenção de customId: `painel:acao:<modulo>:<acao>:<extra>` (botão), `painel:select:<mod>:<campo>:<extra>`, `painel:userselect:...`, `painel:modal:<mod>:<acao>:<extra>`. O `<extra>` às vezes carrega um segundo parâmetro após `#`. Tudo roteado por `painel.js` (`router` em `painel.js:1356-1391`), exceto os customIds "bare" acima.

**Menu principal do painel** — `botoesMenuPrincipal` (`painel.js` ~85-116), cada botão filtrado por predicado de cargo:
`📁 Processo`, `📋 Medida`, `📜 Mandado`, `✉️ Ofício`, `🔍 Crime`, `📄 Petição`, `🗂️ SISBAJUS`, `🏛️ Ministério Público`, `⚖️ Supervisão`, `📌 Minhas pendências`, `🪪 Solicitar cargo`, `🏅 Ficha do judiciário`, `✨ Revisar texto`, `👥 RH` (staff), e a linha do toggle **✨ Revisão automática (IA): LIGADA/desligada** (`painel:acao:pessoal:revisaoauto`).

#### Processo (`commands/processo.js`)
- **Botões (fase denúncia, penal sem juiz):** `processo:oferecer` (Oferecer denúncia, `:90/:358`), `processo:arquivar` (Arquivar, `:91/:363`), `painel:acao:processo:partetardia` (Identificar réu, `:92/:368`), `painel:acao:processo:historicoclique` (Histórico, `:93`), `painel:acao:processo:anexarrelatorio` (Anexar relatório, `:94/:373`).
- **Botões (fase Juiz):** `processo:julgar` (Julgar, `:318`), `gerenciardefesa` (`:319`), `partetardia` (Adicionar parte tardia, `:320`), `intimar` (Emitir intimação, `:321`), `arquivarmanual` (`:322`), `historicoclique` (`:325`); catálogo `CATALOGO_ACOES`/`montarPainelAcoes` (`:353-477`) — fonte-da-verdade das ações por fase; `recebereintimar` (Receber e citar réu — civil, `:388`), `solicitardocumento` (`:442`).
- **Depoimento:** `regdepoimento` (`:519`); **Recurso/civil/instrução:** `recorrer` (`:592`), `arquivarcivil` (`:599`), `recebereintimar` (`:600`), `anexarpeticaoinicial` (`:608`), `anexarcontestacao:<numero>#<habId>` (`:617`), `decretarrevelia` (`:625`), `concluirinstrucao` (`:935`).
- **Habilitação:** `habilitacao:solicitar` (`:1023`), `habilitacao:aprovar/negar:<numero>#<novoId>` (`:1293-1294`).
- **Petição avulsa:** `peticionar` (`:1713`), `deferirpeticao/indeferirpeticao:<numero>#<peticaoId>` (`:1718-1719`).
- **Apelação:** `apelacao:manter/reformar/anular/arquivarmanual:<numeroApelacao>` (`:1922-1925`).
- **Revisão de arquivamento:** `pedirrevisao` (`:1640`), `supervisao:manterarquivamento` (`:1674`), `supervisao:forcardenunciadireto` (`:1675`).
- **Modais:** sentença `sentenca:<numero>#<resultado>` (campos `texto`, e `pena`+`regime` se Condenado, `:102`); parecer MP `parecermp:<numero>#<acao>` (`parecer`, `:175`); depoimento (`:555`); parte tardia (`nomeCompleto`, `rg`, `mencao` — todos opcionais, `:1178`); habilitação (`nome`, `rg`, `reu`, `:1256`); intimação (`destinatario`, `teor`, `:1415`); intimação fora/genérica (`:1484/:1516`); razões do recurso (`razoes`, `:1843`); fundamentação da reforma/decisão de apelação (`fundamentacao`, `:1989/:2003`).
- **Selects:** atenuantes (multi, de `utils/atenuantes.js`, `:153`); testemunha do depoimento (`:547`); papel de parte tardia (`:1166`); remover habilitação (`:1376`); destinatário de intimação (de `partesProcesso`, `:1476`); teor de intimação (presets, `:1493/1508`); resultado da reforma (`:1982`); **resultado da sentença** (`:2336`, Penal: Condenado/Absolvido; Civil: Procedente/Improcedente).

#### Medida (`commands/medida.js`) — `TIPOS_MEDIDA` (`:41`): Busca e Apreensão, Prisão Preventiva, Interceptação Telefônica, Quebra de Sigilo Bancário, Outra
- **Botões:** `medida:aprovar/negar` (análise MP, `:63-64`); `medida:anexarindicios` (`:96`); `medida:referendar` + `painel:acao:medida:negarjuiz` + `arquivarmanual` (decisão do Juiz, `:72-74`); `medida:recorrer` + `pedirreconsideracao` (recurso do Delegado, `:80-81`); `decidirreconsideracao:<n>#aprovar|#manter` (`:505-506`); `pedirreconsideracaojuiz` (`:799`) e `decidirreconsideracaojuiz:<n>#aprovar|#manter` (`:602-603`); `medida:cumprir:<numeroMandado>` (`:87`); `medida:abrirprocesso` (`:102`); medida direta `solicitardireta` (`:118`), `deferirdireta/indeferirdireta` (`:176-177`).
- **Modais:** aprovação MP `aprovarmp` (`fundamentacao`, `:402`); referendar (`fundamentacao`, `:675`); negar provimento `negarjuiz` (`fundamentacao`, `:769`); justificativa da medida direta (`tipoLivre`/`nomeCompleto`/`idTexto`/`justificativa`, condicionais, `:151`); abrir processo `medida:processomodal` (`motivo`, `reus`, `:951`).
- **Selects:** tipo da medida direta (de `utils/tiposMedidaCoercitiva.js` — 6 tipos, `:132`); destinatário (de `partesProcesso`, `:146`). As decisões do Juiz passam pela tela de revisão-IA (`revisaoIA.telaEscolha`, `:824`).

#### Petição administrativa (`commands/peticao.js`)
- **Modais de abertura:** `porte-arma`, `troca-nome`, `limpeza-ficha`, `alvara-evento` (`:402/:417/:432/:448`); "mais dados" (`:359`); "vincular manual" (`:320`); decisão indeferir/diligência (`motivo`, `:698`).
- **Botões:** `anexardocumento` (`:81`); `deferir/indeferir/diligencia/certidao/arquivarmanual` (linha de decisão, `:101-107`); `vincularmanual` (`:309`); `maisdados` (`:349`); `confirmardeferir/cancelardecisao` (`:688-689`).
- **Selects:** UserSelect `vincularcliente#<numero>` (`:306`); StringSelect `risco:<numero>` (níveis 0-3, só porte de arma, `:721`).

#### Ofício (`commands/oficio.js`) e Mandado (`commands/mandado.js`)
- **Ofício — botões:** `arquivarmanual` (`:46`), `cumprir` (só se `aguardaRetorno`, `:50`). Emissão é via slash (não modal). `podeEmitirOficio` = Delegado/Promotor/Procurador/Juiz/Staff (`:40`); cabeçalho por cargo (`instituicaoDoEmissor`, `:34`).
- **Mandado — botão** `medida:cumprir` (bare, `:19`) e `painel:acao:mandado:emitir` (`:43`). **Cadeia:** emitir → select tipo (`:57`) → select destinatário (`:72`) → modal teor (`tipoLivre?/nomeCompleto?/idTexto?/teor`, `:80`) → `emitirMandado` (`:117`). Só o Juiz do processo (`:49,121`), exige processo penal.

#### Ficha/SISBAJUS (`commands/ficha.js`) e RH (`commands/rh.js`)
- **Ficha — botões:** `consultarrg`, `consultardiscordid`, `consultartermo` (`:128/132/138`); UserSelect `consultarpessoa` (`:125`); 3 modais de consulta. Gate `podeConsultar` = Promotor/Juiz/Desembargador/Procurador/Staff (`:23`) — **Delegado e Advogado NÃO**.
- **RH — botões:** `cargo:aprovar/negar:<solId>` (só Staff, `:120-121`); modal `cargo:solicitar:<cargo>` (`nome`, `:80`); StringSelect `cargo:desejado` (`:71`). Contratar/demitir/licença = subcomandos slash (só `isAdmin`).

#### Supervisão (`utils/supervisao.js`) e Ministério Público (`utils/ministerioPublico.js`)
- **Supervisão — 6 modais:** trocar juiz/promotor/desembargador (`numero`/`novo`/`motivo`), forçar denúncia (`:175/190`), manter arquivamento (`:282`). Sem botões/selects próprios (reusa `montarPainelAcoes`). Gate `podeSupervisionar` = Desembargador/Procurador/Staff (`:26`); troca de juiz/relator → Desembargador; trocar promotor/forçar denúncia → Procurador.
- **MP — botões:** `mp:abrirprocesso` (Abrir processo penal/denúncia), `mp:arquivarmanual` (`:48-49`); modal `mp:denunciamodal` (`motivo`, `reus`, `:121`). Atos: `abrirRequisicao`(REQ)/`abrirRecomendacao`(REC)/`abrirInqueritoCivil`(IC). Gate `ehMembroDoMP` = Promotor/Procurador/Staff (`:33`).

### 1.3 Jobs / tarefas automáticas
Disparo em `client.once('ready')` (`index.js:47-90`). Dois timers `setInterval`. **DMs DESLIGADAS por padrão** — toda notificação privada passa por `dmSeguro` (`prazos.js:51`), que retorna cedo se `!config.avisosPorDmLigado` (env `AVISOS_POR_DM=1`, `config.js:84`). Sem a var, só há avisos **no canal**.

**Job diário** (`rodarChecagens`, 24h, `index.js:62`):
- `verificarPrazosJulgamento` (`prazos.js:68`): processo com Juiz e sem desfecho; **7 dias** desde `juizDesde` → arquiva "sem julgamento de mérito".
- `verificarRenovacoesPorteArma` (`prazos.js:102`): porte deferido, **validade 15 dias**, aviso 3 dias antes, marca "Vencido".

**Job frequente** (`rodarChecagensFrequentes`, 10 min, `index.js:73`):
- `verificarVinculosPendentes` (`:125`): petição "Aguardando vínculo" → **cancela aos 60min**.
- `verificarProcessosSemJuiz` (`:157`) e `verificarProcessosPenaisSemJuiz` (`:183`): **sorteio automático de Juiz** (civil / penal aguardando).
- `verificarPeticoesSemJuiz` (`:242`): sorteio automático para petição.
- `verificarDiligenciasPendentes` (`:210`): diligência 24h → **indeferimento automático**.
- `verificarMedidasAguardandoMP` (`:264`) / `verificarMedidasAguardandoJuiz` (`:288`): avisos + escalonamento (48h) a Procuradores/Desembargadores.
- `verificarMandadosPendentes` (`:313`): lembra o Delegado às 40h.
- `verificarApelacoesPendentes` (`:335`): aviso 8 dias, escalonamento 15 dias.
- `verificarPrazosContestacao` (`:365`): só **avisa** ao vencer (revelia continua manual).
- `postarPainelFixo` (boot), `guildMemberAdd` (sincroniza apelido), `messageCreate` (alimenta integração da P. Civil).

### 1.4 Integrações
- **Sistema Integrado / Polícia Civil.** *Entrada* (`utils/integracaoPoliciaCivil.js`): `messageCreate` no canal `config.canalRequerimentoPoliciaCivilId`, só age se **`message.webhookId`** existir; lê o campo "Evento" do embed → "encerramento de inquérito" vira processo penal (`processoCmd.criarProcessoPenal`), caso padrão vira medida (`medidaCmd.solicitarMedida`, a mesma do `/painel`). *Volta* (`utils/devolutivaPoliciaCivil.js`): POST ao webhook `config.webhookDevolutivaPoliciaCivilUrl` — devolutiva de mandado (`enviarDevolutivaMandado`), ofício de Delegado (`enviarOficioPoliciaCivil`), sentença de processo nascido de medida (`enviarSentencaPoliciaCivil`).
- **PNG de documentos** (`services/gerarDocumentoPNG.js`): Puppeteer renderiza HTML A4 (TJSP/MPSP) e captura PNG; browser singleton. Tipos: sentenças penal/cível (condenatória/absolutória/procedente/improcedente), indeferimento de inicial, parecer MP (denúncia/arquivamento), ofício, mandado (citação/intimação/genérico), decisões de revisão. Serviço irmão `gerarBannerPainel.js`.
- **IA (Google Gemini)** (`utils/cartorio.js`, `utils/analiseDocumento.js`): REST via `fetch`, modelo `gemini-flash-latest`, chave `config.geminiApiKey`. `fetchComTimeout` (AbortController 25s). `gerarResumoCartorio`/`despachoParaCanal` (despacho de apoio), `revisarTexto` (botão Revisar + toggle inline), `analisarPdfEstruturado` (PDF multimodal → JSON) consumido por `analiseDocumento.gerarAnaliseEmbed` (8 tipos: relatorio_inquerito com schema próprio + petição inicial, contestação, resposta de ofício, cumprimento de mandado, indícios de medida, petição avulsa, documento). **Fallback gracioso** em todas (sem chave → null, fluxo segue).
- **Fivemanage / hospedagem de mídia:** **não existe.** PDFs são baixados por URL de anexo do Discord; PNGs anexados direto na mensagem/webhook.

---

## 2. Permissões por cargo

**Base:** `isAdmin` (`permissoes.js:9`) = `Administrator` do Discord OU role Staff. `temCargo` (`:16`) = `isAdmin` **OU** cargo no RH — ⚠️ *qualquer Administrator passa em todo cargo*. `isSuperStaff` (`:29`) = role "Staff Salve", único override nas **decisões de mérito**. Ações "de responsável" checam `user.id === entidade.{juiz|promotor|delegado|autor}` **|| isSuperStaff**. Teor de processo: `temAcessoTotal` (`processo.js:996`) = partes + advogado **habilitado** + isAdmin/isSuperStaff.

Legenda: ✅ pode · ⛔ não · 🔒 só o responsável do caso (`user.id === X`).

| Ação | Delegado | Promotor | Juiz | Advogado | Desemb. | Procurador | Staff/Dono |
|---|---|---|---|---|---|---|---|
| Abrir processo penal | ✅ | ✅ (via ato MP / da medida 🔒) | ⛔ | ⛔ | ⛔ | ✅ forçar denúncia | ✅ |
| Abrir processo civil | ⛔ | ⛔ | ⛔ | ✅ | ⛔ | ⛔ | ✅ |
| Oferecer denúncia / sortear juiz | ⛔ | 🔒 `=== promotor` | ⛔ | ⛔ | ⛔ | ✅ forçar | ✅ |
| Solicitar medida | ✅ | 🔒 direta no processo | ⛔ | ⛔ | ⛔ | ⛔ | ✅ |
| Aprovar/negar medida (MP) | ⛔ | 🔒 `=== medida.promotor` | ⛔ | ⛔ | ⛔ | ⛔ (só reconsideração) | ✅ |
| Referendar / negar medida | ⛔ | ⛔ | 🔒 `=== medida.juiz` | ⛔ | ⛔ | ⛔ | ✅ |
| Reconsideração de medida | ✅ pedir | ✅ pedir | ⛔ | ⛔ | ✅ decidir (juiz) | ✅ decidir (MP) | ✅ |
| Cumprir mandado / ofício | 🔒 emissor | 🔒 emissor | 🔒 emissor | ⛔ | — | — | ✅ |
| Emitir mandado (no processo) | ⛔ | ⛔ | 🔒 `=== processo.juiz` | ⛔ | ⛔ | ⛔ | ✅ |
| Emitir ofício | ✅ (P. Civil) | ✅ (MP) | ✅ (Judiciário) | ⛔ | ⛔ | ✅ (MP) | ✅ |
| Peticionar (avulsa no processo) | ⛔ | ⛔ | ⛔ | ✅ (só `temCargo('Advogado')`, **sem exigir habilitação**) | ⛔ | ⛔ | ✅ |
| Petição administrativa | ⛔ | ⛔ | 🔒 decide | ✅ protocola | ⛔ | ⛔ | ✅ |
| Habilitar-se (defesa) | ⛔ | ⛔ | 🔒 decide/remove | ✅ solicita | ⛔ | ⛔ | ✅ |
| Anexar contestação | ⛔ | ⛔ | ⛔ | 🔒 só habilitação Aprovada do réu | ⛔ | ⛔ | ✅ |
| Sentenciar / julgar | ⛔ | ⛔ | 🔒 `=== juiz` (revalida em `executarSentenca:2159`) | ⛔ | ⛔ | ⛔ | ✅ |
| Intimar / citar | ⛔ | ⛔ | 🔒 | ⛔ | ⛔ | ⛔ | ✅ |
| Decidir apelação | ⛔ | ⛔ | ⛔ | ⛔ | 🔒 `=== desembargadorId` | ⛔ | ✅ |
| Recorrer / apelar | ⛔ | 🔒 se perdeu | ⛔ | 🔒 defesa habilitada que perdeu | ⛔ | 🔒 autor que perdeu | ✅ |
| Supervisão — trocar Juiz/relator | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ⛔ | ✅ |
| Supervisão — trocar Promotor / forçar denúncia | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ |
| Ficha / SISBAJUS / certidão | ⛔ | ✅ | ✅ | ⛔ | ✅ | ✅ | ✅ |
| Atos do MP | ⛔ | ✅ | ⛔ | ⛔ | ⛔ | ✅ | ✅ |
| Cadastrar instituições | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ✅ | ✅ |
| RH (contratar/demitir/aprovar cargo) | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ⛔ | ✅ |
| Ver TEOR dos autos | 🔒 se parte | 🔒 se parte | 🔒 se parte | 🔒 só habilitado | ⛔ (salvo isAdmin) | ⛔ (salvo isAdmin) | ✅ |

Predicados-chave: `podeEmitirOficio` (`oficio.js:40`), `podeConsultar`/SISBAJUS (`ficha.js:23`), `ehMembroDoMP` (`ministerioPublico.js:33`), `podeSupervisionar` (`supervisao.js:26`), `podeRecorrer` (`processo.js:1795`), `temAcessoTotal`/`processoPublico` (`processo.js:996/991`).

---

## 3. Modelo de dados
Banco JSON plano. Todo registro ganha `id` (autoincremento global) + `criado_em` (`db.js:69`). Tabelas (`db.js:8`): processos, medidas, mandados, oficios, rh, apelacoes, peticoes, fichas, consultas, estado, certidoes, atosMp, documentosAnexados, dossiesInquerito, instituicoes, andamentos, solicitacoesCargo, preferencias.

- **`processos`** (`processo.js:654/722`): `numero`, `tipo` (Penal/Civil), `status`, `canalId`; penal: `delegado/promotor/juiz/juizDesde/reus[]/advogados[]/crimes[]/motivo`; civil: `autor/autorNome/autorRg/autorDiscordId/reuNome/reuRg/reus[]`; `partes[]` (registro unificado — `{id:'pN',papel,nome,discordId,rg,origem,...}`), `depoimentos[]`, `habilitacoes[]` (`{id,reuId,advogadoId,nomeCliente,rgCliente,status}` ∈ Pendente/Aprovado/Negado/Removido), `peticoes[]` (avulsas — **≠ tabela `peticoes`**), `sentenca/resultado/pena/regime/sentencaEm`, `revelia/contestacaoEm/prazoContestacaoAte`, vínculos (`medidaVinculada/atoMpVinculado/apelacaoNumero/codigoExterno`), UI (`painelMsgId/diarioMessageId/revisaoArquivamento`).
  - **status:** Aguardando decisão do MP · Aguardando sorteio de juiz · Aguardando defesa · Denúncia oferecida - aguardando juiz · Instrução · Aguardando contestação · Concluso para julgamento · Em instrução · Encerrado · Arquivado · Arquivado sem julgamento de mérito.
- **`medidas`** (`medida.js:307/189`): `numero`, `tipo`, `alvo/alvoDiscordId/nomeAlvo/rgAlvo`, `motivo`, `status`, `delegado/promotor/juiz`, `canalId`, `processoVinculado`, `codigoExterno`, `fundamentacaoPromotor/fundamentacaoJuiz`, reconsideração + campos de job.
  - **status:** Aguardando anexo de indícios · Aguardando MP · Aprovada - aguardando juiz · Negada · Deferida · Indeferida pelo Juiz.
- **`mandados`** (`mandado.js:147`/`medida.js:698`): `numero`, `medidaNumero`, `processoVinculado`, `tipo`, `alvo`, `status` (Emitido/Cumprido), `emitidoPor`, `cumpridoPor`.
- **`oficios`** (`oficio.js:162`): `numero`, `processoNumero` (null=avulso), `destinatario/assunto/conteudo`, `emitidoPor`, `status` (Pendente/Cumprido), `aguardaRetorno`, `cumpridoPor/cumpridoEm`.
- **`apelacoes`** (`processo.js:1905`): `numero`, `processoOriginalNumero`, `tipo`, `recorrenteId/parteContrariaId/desembargadorId`, `razoes`, `status` (Aguardando decisão → Mantida/Reformada/Anulada), `decisao`, `canalId`.
- **`peticoes`** (administrativas, `peticao.js:140`): `numero`, `tipo` (PorteArma/TrocaNome/LimpezaFicha/AlvaraEvento), `requerenteId/promotor/juiz`, `status`, `discordIdCliente`, dados do cliente, `validadeAte` (porte). status: Aguardando vínculo → Pendente → Diligência/Deferido/Indeferido/Vencido/Cancelada.
- **`atosMp`** (`ministerioPublico.js`): `numero` (REQ/REC/IC), `tipo`, `destinatario/fundamentacao/objeto/prazo`, `executorId`, `processoVinculado`.
- **`documentosAnexados`** (`anexos.js:15`): todo PDF juntado — `tipo`, `url`, `nomeArquivo`, `autorId`, `atoOrigemId`, `protocoloVinculado`.
- **`dossiesInquerito`** (`dossie.js:16`): `protocoloInquerito`, `medidas[]/mandados[]/documentos[]`, `processoVinculado`.
- **`fichas`** (chave RG, `ficha.js:23`): `rg`, `nomeCivil`, `historicoNomes[]`, `trocasDeNome`, `discordIds[]`, `enderecos[]/telefones[]/redesSociais[]`.
- **`rh`** (`rh.js:21`): `discordId`, `cargo`, `ativo`, `licenca`, `nomePersonagem`. **`solicitacoesCargo`**: auto-atendimento de contratação. **`preferencias`**: `{discordId, revisaoAutomatica}`. **`instituicoes`/`andamentos`/`consultas`/`certidoes`/`estado`** conforme seção 1.
- **Objeto "parte"** (`partesProcesso.js`): dentro de `processo.partes[]`; `papel` ∈ reu/autor/testemunha_acusacao/testemunha_defesa/terceiro.

---

## 4. Fluxos ponta a ponta
**[CADEIA]** = botão que leva ao próximo passo · **[MANUAL]** = exige slash / anexar PDF / @menção digitada.

### (a) Penal
1. **Abertura** → `criarProcessoPenal` (`processo.js:629`, status `Aguardando decisão do MP`), por 3 vias: [MANUAL] `/medida solicitar` → Promotor clica "Abrir processo penal" [CADEIA] → crime picker; [CADEIA] a partir de ato do MP; [CADEIA] direto no painel.
2. **Relatório de inquérito** → [MANUAL, anexa PDF] "📎 Anexar relatório" (IA analisa pro Promotor).
3. **Parecer/denúncia** → [CADEIA] "Oferecer denúncia"/"Arquivar" → parecer → revisão-IA → `executarParecerMp`.
4. **Sorteio de juiz** → automático no "oferecer" (`rh.sortearJuiz`); sem juiz → `Denúncia oferecida - aguardando juiz` + retry a cada 10 min. Capa publicada no Diário Oficial.
5. **Instrução** → [CADEIA] habilitação (advogado solicita no Diário → Juiz Aprova/Nega); [MANUAL] petição avulsa (anexa PDF) → Juiz Defere/Indefere [CADEIA]; [MANUAL] `/oficio criar` + cumprimento [MANUAL]; [CADEIA] mandado (Juiz emite via selects) ou medida coercitiva (Promotor solicita → Juiz defere → **mandado gerado automaticamente**); [CADEIA] depoimento.
6. **Sentença** → [CADEIA] "Julgar" → select resultado → (Condenado: atenuantes/pena) → modal → revisão-IA → `executarSentenca` (status `Encerrado`, PNG).
7. **Apelação** → [CADEIA] só quem perdeu vê "Recorrer" → razões → `criarApelacao` sorteia Desembargador → Manter/Reformar/Anular. Anular [CADEIA] re-sorteia Juiz e reabre.

### (b) Civil
Inicial [CADEIA] (`criarProcessoCivil`, **sorteia Juiz na abertura**) → [MANUAL] anexa PDF da inicial → [CADEIA] "Receber e citar réu" (vira citação, prazo de contestação) → [MANUAL, anexa PDF] contestação **ou** [CADEIA] "Decretar revelia" após prazo → dossiê de conclusão com botão "Julgar" [CADEIA] → sentença → recurso (= penal).

### (c) Medida cautelar
[MANUAL] `/medida solicitar` (`Aguardando MP`) → [CADEIA] MP Aprova/Nega (aprovar sorteia Juiz) → [CADEIA] Juiz Referenda/Nega provimento → **mandado gerado automaticamente** no referendo (devolutiva à P. Civil) → [MANUAL, anexa PDF] "Cumprir mandado". Reconsiderações (Procurador/Desembargador) são [CADEIA].

### (d) Petições administrativas
[MANUAL] `/peticao ...` ou [CADEIA] modais do painel (`Aguardando vínculo`) → [CADEIA] vínculo obrigatório do cliente (UserSelect / manual) → sorteio automático de Promotor+Juiz → [CADEIA] Juiz Defere/Indefere/Diligência/Certidão/Arquiva (deferir pede confirmação; porte de arma abre select de risco 0-3). Efeitos aplicados em `finalizarDecisao` (ex.: troca de nome muda apelido + grava na ficha).

> **Pontos que sempre quebram a cadeia (exigem ação manual):** abertura via `/medida solicitar` e `/oficio criar`; e **toda juntada de PDF** (`aguardarAnexoPDF` pede o arquivo na conversa — relatório de inquérito, contestação, cumprimento de mandado/ofício, documentos de petição, petição avulsa/inicial).

---

## 5. Redundâncias + impacto das mudanças planejadas

### Parte 1 — Redundâncias restantes
> Nota: uma auditoria recente já consolidou parsers de menção (`utils/texto.js`), telas de revisão-in-flow (`utils/revisaoIA.js`), rascunho com TTL (`utils/rascunhoTtl.js`), análise de documento (`utils/analiseDocumento.js`) e removeu `utils/identidade.js`. Os itens abaixo são o que **ainda** sobrou.

1. **[FORTE] Botões do painel de processo definidos 3×** — `botoesDenuncia` (`processo.js:88-96`), `botoesJuiz` (`:315-345`), `CATALOGO_ACOES`/`montarPainelAcoes` (`:353-477`). O próprio comentário (`:456-458`) admite que o catálogo é a fonte-da-verdade e as duas funções são "espelho por compatibilidade". Os mesmos customIds estão codificados três vezes e podem divergir. **Consolidar:** eliminar `botoesDenuncia`/`botoesJuiz`, call sites (`:669/:736/:2053`) usam `montarPainelAcoes`.
2. **[FORTE] Filtro de busca de crime duplicado 3×** — `crime.js:40-43`, `painel.js:1111-1114`, `painel.js:1304-1307` (predicado idêntico). Os dois handlers de modal de busca (`crimepick:buscar`/`crime:buscar`) são quase iguais. **Consolidar:** `buscarCrimes(termo)` em `utils/crimesTexto.js`.
3. **[MÉDIO] `instituicaoDoSolicitante` (`certidoes.js:25`) ≈ `instituicaoDoEmissor` (`oficio.js:34`)** — mesma função, ofício só acrescenta o ramo Delegado→Polícia Civil. **Consolidar:** helper único `papelInstitucional(interaction)`.
4. **[MÉDIO] Checagem de MP reinlined** — `temCargo('Promotor')||temCargo('Procurador')` repetido em `certidoes.js:22/26` e `oficio.js:35/41` em vez de reusar `ehMembroDoMP`.
5. **[BAIXO] Embeds de listagem duplicados** — `embedListaMandados` (`painel.js:300`) = inline de `mandado.js:222`; `embedListaMedidas` (`painel.js:296`) espelha `medida.js:385`.
6. **[BAIXO/design] Dispositivos jurídicos em 2 lugares** — fórmulas de sentença/denúncia como texto em `utils/documentos.js` e como HTML em `services/gerarDocumentoPNG.js:150-271`. Mídias diferentes, mas o texto canônico pode divergir — candidato a dicionário único.
7. **Código morto:** `limparCanalPainel` (`painel.js:1400-1419`, nunca chamada) e `limparCanalPainelPeriodico` (`painel.js:1483-1485`, stub no-op ainda exportado e fiado em `index.js:84`). Remover ambos + a chamada.
8. **[Arquitetural, não bug]** Duas superfícies de roteamento convivem: "bare" `modulo:acao:numero` (`index.js:143-167`) e `painel:...` (`painel.js router`). Todos os handlers bare ainda são criados — não é morto, mas vale unificar no futuro.

### Parte 2 — Impacto das 6 mudanças planejadas (arquivo:linha a mexer)

**1. Mover Petições → Processos.** `painel.js`: botão menu `:96`, título `:134`, `submenuPeticao :229-241`, `SUBMENUS :278`, roteamento botões `:751-765`, select `:976-978`, userselect `:1049-1052`, modais `:1215-1216`/`:1234-1239`, `TABELAS_ARQUIVAR :581`, permissão `:594`, pendências `:324/347`. Slash+módulo: `peticao.js` inteiro (`:771`). Categoria: `config.js:31` (`categoriaPeticoesId`), `peticao.js:136`. ⚠️ **Não confundir** `processo.peticoes` (avulsa) com a tabela/módulo `peticoes`.

**2. Mover Ofício + Mandado → Medidas.** `painel.js`: botões menu `:90/:91/:94`, títulos `:128-130`, submenus `submenuMedida/Mandado/Oficio :167-195`, `SUBMENUS :272-274`, roteamento botões `:775-812`, selects `:895-933`, modais `:1071-1072`/`:1254-1301`. Módulos `oficio.js`/`mandado.js` inteiros. `botaoEmitirMandado` (`mandado.js:42`, usado em `processo.js:334/422`), `botaoSolicitarMedidaDireta` (`medida.js:117`, usado em `processo.js:335/427`). Ofício cria a própria categoria; mandado posta no canal do processo → mudança é de **agrupamento de UI**, não de canais.

**3. Mover Ficha Judiciária → Supervisão.** São **duas fichas**: 🏅 "Ficha do judiciário" (`cargo:ficha` → `rh.mostrarFichaFuncional`, botão `painel.js:106`, rota `:632`, `rh.js:267`) e 🗂️ SISBAJUS (botão `painel.js:99`, `submenuFicha :243-253`, roteamento `:767-773`, modais `:1241-1244`, gate `ficha.js:23`). Destino Supervisão: botão `painel.js:101`, `submenuSupervisao :216-227`, gate `abrirSubmenu :287-289`.

**4. Remover "Revisar texto" → toggle inline.** Botão `painel.js:107`; handler abrir modal `:659-667`; handler modal submetido `:1126-1137` → `cartorio.revisarTexto` (`utils/cartorio.js:80+`). Toggle que **já existe**: `painel.js:112-116` + roteamento `:671-683` + `utils/preferencias.js:8-24`.

**5. "medida provisória" → "medida cautelar" (global).** Voltadas ao usuário (prioridade): `medida.js:45/323/330/331/343/355/385`, `painel.js:297/777`, `ficha.js:101`, `processo.js:2229`, `documentos.js:182/187/188`. Comentários/docs (coerência): `documentos.js:151/171`, `ficha.js:154`, `integracaoPoliciaCivil.js:2`, `config.js:52`, `mandado.js:39/194`, `README.md:3/7`, `package.json:4`. (grep `provis[oó]ri`.)

**6. Renomear "Diário Oficial".** O código sempre referencia `config.canalDiarioOficialId` (`config.js:16`, env `CANAL_DIARIO_OFICIAL_ID`), nunca o nome literal → renomear o **canal** + a **env var** basta. Uso: `postarOuAtualizarDiario` (`processo.js:1027-1053`), chamadas `:297/751/1132`, capa `embedCapaPublica :1003`, habilitação via Diário (`botaoSolicitarHabilitacao :1021`, anexada em `:1040`). Textos/comentários a atualizar: `processo.js:311/1003/1027`, `auditoria.js:5`.

---

## 6. Pontos de risco / inconsistência
> Só reportado — nada corrigido.

### 🔴 ALTA — Vazamento de teor de medida/mandado (sem gate + resposta pública)
- `painel.js:1254-1259` (`medida:ver`) e `:1275-1280` (`mandado:ver`) respondem `embedMedida`/`embedMandado` **sem nenhuma checagem** de acesso; o botão "Ver" é exibido a **todos** (`painel.js:171/181`, `botaoSe(true,...)`).
- `/medida ver` (`medida.js:373-377`) e `/mandado ver` (`mandado.js:211-215`): **pior** — `interaction.reply({embeds})` **sem `ephemeral:true`** → o teor é postado **publicamente no canal**.
- Vaza: tipo (Prisão Preventiva/Interceptação/Quebra de Sigilo), alvo, Discord/nome/RG do alvo, motivo/indícios — dados do inquérito na fase pré-pública. O autocomplete lista todas as medidas/mandados a qualquer um, então descobrir números é trivial.
- **Contraste que confirma esquecimento:** `verProcesso` faz o gate certo (`temAcessoTotal`/`processoPublico`, `processo.js:1057-1067`). Só medida/mandado ficaram sem. **→ prioridade máxima de correção.**

### 🟠 MÉDIA
- **Petição avulsa de qualquer Advogado** — `processo.js:1723-1726`: `peticionar` só exige `temCargo('Advogado')`, **sem** habilitação no processo → qualquer advogado protocola PDF em qualquer processo.
- **Integração P. Civil confia no webhook** — `integracaoPoliciaCivil.js:28-51`: Delegado/réus/crimes vêm do embed; única barreira é `message.webhookId`. Quem postar via webhook (ou vazar a URL) pode forjar requerimento e criar medida/processo atribuídos a um Delegado arbitrário.

### 🟡 BAIXA
- **Entidades sem juiz/promotor** quando o sorteio falha (nunca há cargo elegível) ficam presas; só destravam com `isSuperStaff`. Habilitações Pendentes órfãs no mesmo caso.
- **`Administrator` genérico herda todos os cargos** (`permissoes.js:16`) — pode disparar ações "de cargo" não-mérito (abrir processo, peticionar, ofício, atos do MP). Decisões de mérito estão protegidas (`isSuperStaff`), mas a amplitude nas ações de cadastro/protocolo vale registrar.
- **Roteador de supervisão sem gate próprio** (`painel.js:741-748`) — depende 100% do self-check em `supervisao.js`; um handler novo ali sem self-check nasceria aberto.
- **Referências a canal apagado** — em geral tratadas com `.catch(()=>null)`; campos `diarioMessageId`/`canalId` podem apontar para canais inexistentes sem limpeza (mitigado, repostam quando possível).

---

## 7. Tabela-resumo final (índice de gatilhos)

| Gatilho (comando/botão) | Função | Cargo(s) | Arquivo |
|---|---|---|---|
| `/processo penal\|civil\|ver\|historico` | Abrir/consultar processo | Delegado (penal) / Advogado (civil) | `processo.js:2222` |
| `/medida solicitar\|ver\|listar` | Pedido de medida | Delegado / Promotor | `medida.js:329` |
| `/oficio criar` | Emitir ofício (avulso ok) | Delegado/Promotor/Procurador/Juiz | `oficio.js:192` |
| `/peticao porte-arma\|troca-nome\|limpeza-ficha\|alvara-evento` | Petição administrativa | Advogado | `peticao.js:771` |
| `/ficha buscar` · `/mandado ver` · `/crime buscar` · `/instituicao` | Consultas / cadastro | ver seção 2 | `ficha.js`/`mandado.js`/`crime.js`/`instituicao.js` |
| `/rh contratar\|demitir\|licenca\|listar` | Gestão de cargos | Staff | `rh.js:273` |
| `/painel` | Menu interativo (todos os módulos) | todos (filtrado por cargo) | `painel.js:1488` |
| Botão `processo:oferecer`/`arquivar` | Denúncia / arquivamento | Promotor 🔒 | `processo.js:90-91` |
| Botão `processo:julgar` → select → modal | Sentença | Juiz 🔒 | `processo.js:318`, `executarSentenca:2154` |
| Botão `apelacao:manter/reformar/anular` | Decidir apelação | Desembargador 🔒 | `processo.js:1922` |
| Botão `habilitacao:solicitar`/`aprovar`/`negar` | Habilitação de defesa | Advogado / Juiz 🔒 | `processo.js:1023/1293` |
| Botão `processo:peticionar` → PDF | Petição avulsa | Advogado (⚠️ sem vínculo) | `processo.js:1713` |
| Botão `medida:aprovar/negar` | Aprovação MP da medida | Promotor 🔒 | `medida.js:63` |
| Botão `medida:referendar`/`negarjuiz` | Referendo/negativa (gera mandado) | Juiz 🔒 | `medida.js:72` |
| Botão `medida:cumprir` / `oficio:cumprir` → PDF | Cumprimento (mandado/ofício) | emissor 🔒 | `medida.js:87`/`oficio.js:50` |
| Botão `mandado:emitir` → selects → modal | Emitir mandado no processo | Juiz 🔒 | `mandado.js:43` |
| Botão `medida:solicitardireta` (no processo) | Medida coercitiva | Promotor 🔒 | `medida.js:117` |
| Botão `mp:abrirprocesso` / atos MP | Denúncia a partir de ato / atos | Promotor/Procurador | `ministerioPublico.js:48` |
| Modais Supervisão (trocar/forçar) | Supervisão | Desembargador/Procurador | `supervisao.js:36+` |
| Botão `ficha:consultar*` / UserSelect | SISBAJUS | Promotor/Juiz/Desemb./Procurador | `ficha.js:120` |
| Botão `cargo:solicitar`/`aprovar`/`negar` | Auto-atendimento de cargo | todos / Staff decide | `rh.js:71/120` |
| Toggle `pessoal:revisaoauto` · botão `revisar:abrir` | Revisão de texto por IA | todos | `painel.js:107/112` |
| Jobs `verificar*` (10 min / 24h) | Prazos, sorteio automático, escalonamento | bot | `utils/prazos.js`, `index.js:62-87` |
| Webhook P. Civil (`messageCreate`) | Requerimento → medida/processo | bot | `integracaoPoliciaCivil.js` |

---

*Fim do mapa. Documento gerado por leitura estática; nenhuma alteração de código-fonte foi feita. Aguardando revisão antes de qualquer implementação.*
