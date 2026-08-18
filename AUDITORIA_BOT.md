# AUDITORIA DO BOT JURÍDICO

> **Escopo:** leitura completa do projeto `discord-bot-juridico` (discord.js v14, storage em `dados.json`).
> **Natureza:** documento de **mapa/diagnóstico**. Nenhum arquivo de código foi alterado nesta tarefa.
> **Data:** 13/08/2026. **Versão do código auditada:** `processo.js` com 3561 linhas, `painel.js` com 1500 linhas.
> **Método:** varredura de todos os `commands/`, `utils/`, `services/`, `database/`, `config.js`, `index.js` + inspeção do `dados.json` real.

---

## COMO LER / PRINCIPAIS ACHADOS

**Arquitetura em uma frase:** `index.js` roteia; cada arquivo em `commands/` é um slash command; **quase toda interação de botão/select/modal tem `customId` com prefixo `painel:` e é despachada por `painel.router()`**; alguns botões "nus" `modulo:acao:numero` vão direto pra handlers de `medida.js`/`processo.js`. O painel de ações dentro do canal do processo (a "HUD") é montado em `processo.js` a partir de um **catálogo central** (`CATALOGO_ACOES`), não em `painel.js`.

**Top achados desta auditoria (detalhe nas seções 5 e 6):**

| # | Achado | Gravidade | Onde |
|---|---|---|---|
| A | Webhook da Polícia Civil aceito **sem validação de origem** por padrão → medida cautelar forjada com Delegado arbitrário | 🔴 Alto | `integracaoPoliciaCivil.js:175-183` |
| B | `indeferirMedidaDireta` responde **sem `ephemeral`** → teor de indeferimento vaza no canal | 🟠 Médio | `medida.js:301` |
| C | `verRolProvas` e "Listar recentes" de medida/mandado **não checam acesso** → vazam teor/rol a não-partes | 🟠 Médio | `processo.js:2258`; `painel.js:304-308,794,810` |
| D | `cumprirMandado` tem checagem de permissão **pulável** quando não há delegado responsável | 🟠 Médio | `medida.js:877-880` |
| E | PNG dos documentos **só escapa `corpoTexto`** → nome/crime/pena crus quebram/injetam o template | 🟠 Médio | `gerarDocumentoPNG.js:150-272` |
| F | Divergência de schema na tabela `mandados` (referendo grava `medidaNumero`, direto grava `processoVinculado`) → acesso/exibição inconsistentes | 🟡 Baixo | `medida.js:712` vs `mandado.js:173` |
| G | Ações de `processo`/`supervisao`/`cargo` **sem gate no `painel.js`** — dependem 100% da revalidação interna (a maioria revalida; ver ressalvas) | 🟡 Verificar | `painel.js:701-756` |

**Sobre a nomenclatura a renomear (importante):** **"medida provisória" NÃO existe no código** — o termo usado em toda parte é **"medida cautelar"**. **"Diário Oficial" NÃO aparece em texto de usuário** (já migrado pra "Advogar - Pegar Casos"); sobra só como **identificador interno** (`config.canalDiarioOficialId`, função `postarOuAtualizarDiario`, campo `diarioMessageId`). O **botão "Revisão de texto" já foi removido** (hoje é o toggle "Revisão automática (IA)"). Detalhe na **seção 9**.

**Sobre as mudanças "que vamos fazer depois" (importante):** **parte já está implementada** no menu de navegação — Petições já está dentro de Processos, Ofício/Mandado dentro de Medidas, Ficha do Judiciário dentro de Supervisão (`painel.js:158,174-175,231`). O que **falta** é reorganizar a **HUD de ações dentro do canal** por cargo (seção 8) e os renames de identificadores (seção 9). **Fivemanage não existe no projeto** (PDFs vêm do CDN do Discord).

---

## 1. MAPA FUNCIONAL COMPLETO

### 1.1 Comandos slash

| Comando | Subcomando(s) · parâmetros | Gate de cargo | Arquivo |
|---|---|---|---|
| **/processo** | `penal` (crimes*, motivo*, promotor, reus, medida) · `civil` (nome_acao*, autor_nome*, autor_discord*, reu_nome*, reu_discord*) · `listar` (status) · `ver` (numero*) · `historico` (numero*) | penal→Delegado; civil→Advogado; ver/histórico→partes | `processo.js:3229` |
| **/medida** | `solicitar` (tipo*, alvo*, motivo*, alvo_rg, alvo_discord, promotor) · `ver` (numero*) · `listar` (status) | solicitar→Delegado; ver→acesso à medida | `medida.js:342` |
| **/mandado** | `ver` (numero*) · `listar` (status) — **sem emissão manual** (nasce do referendo) | ver→partes/emissor | `mandado.js:223` |
| **/oficio** | `criar` (destinatario*, assunto*, conteudo*, processo, aguarda_retorno) | Delegado ∨ MP ∨ Juiz | `oficio.js:190` |
| **/peticao** | `porte-arma` · `troca-nome` · `limpeza-ficha` · `alvara-evento` (cada um com rg*, nome*, endereco* etc.) | Advogado (comando inteiro) | `peticao.js:822` |
| **/ficha** | `buscar` (rg, discord, discord_id, termo) — SISBAJUS | Promotor/Juiz/Des./Procurador/Staff | `ficha.js:302` |
| **/rh** | `contratar` (usuario*, cargo*) · `demitir` (usuario*) · `licenca` (usuario*, afastado*) · `listar` (cargo*) | Staff (isAdmin) | `rh.js:273` |
| **/crime** | `buscar` (termo*) — base de 126 tipificações, autocomplete | aberto a todos | `crime.js:22` |
| **/instituicao** | `adicionar` (modal) · `listar` | adicionar→Admin ∨ Procurador; listar→todos | `instituicao.js:18` |

Todos com `autocomplete` onde há parâmetro `numero`/`termo` (roteado por `index.js:136`). `deploy-commands.js` registra os 9 comandos por guild.

### 1.2 Botões — roteamento e catálogo

**Dois caminhos de roteamento** (`index.js:124-176`):
- **`customId` começa com `painel:`** → `painel.router()` (o hub; `painel.js:1392`). Formato: `painel:<tipo>:<modulo>:<acao>:<extra>`, onde `tipo` ∈ {`menu`, `acao`, `select`, `userselect`, `modal`}.
- **Botão "nu" `modulo:acao:numero`** → mapa fixo em `index.js:152-153`: `medida:{aprovar,negar,recorrer,referendar,cumprir→cumprirMandado,abrirprocesso→abrirProcesso,anexarindicios→anexarIndicios}` e `processo:{oferecer,arquivar,julgar}`.

**HUD do processo — `CATALOGO_ACOES` (`processo.js:389-538`):** fonte única dos botões do painel dentro do canal. Cada ação declara `id`, `grupo` (1/2/3, empacotamento em linhas), `cargo` (para quem serve) e `quando(processo)` (condição de fase/tipo/status). `montarPainelAcoes` (`:553`) filtra por `quando()` e empacota por `grupo`. **Hoje o painel mostra a UNIÃO de todos os botões aplicáveis à fase** (botões do Discord são compartilhados, não por-usuário) — daí a poluição visual que a seção 8 ataca.

Inventário do catálogo (id · label · cargo · condição):

| id | label | cargo | quando |
|---|---|---|---|
| `oferecer_denuncia` | Oferecer denúncia | Promotor | penal sem juiz |
| `arquivar_mp` | Arquivar | Promotor | penal sem juiz |
| `identificar_reu` | Identificar réu | Delegado | penal sem juiz |
| `anexar_relatorio` | 📎 Anexar relatório de inquérito | Delegado | penal sem juiz |
| `julgar` | Julgar | Juiz | com juiz |
| `intimar_reu` | 📃 Intimar réu (abre defesa) | Juiz | penal, juiz, réu não intimado |
| `citar_reu_civil` | 📨 Receber e citar réu | Juiz | civil "Aguardando defesa" |
| `gerenciar_defesa` | Gerenciar defesa | Juiz | com juiz |
| `parte_tardia` | Adicionar parte tardia | Juiz | com juiz |
| `emitir_intimacao` | Emitir intimação | Juiz | com juiz |
| `arquivar_manual` | 📦 Arquivar | Juiz | com juiz |
| `designar_juiz` | ⚖️ Designar Juiz | Desembargador/Procurador | preso sem juiz |
| `historico` | 📜 Histórico (autos) | qualquer | sempre |
| `emitir_mandado` | ⚖️ Emitir mandado | Juiz | penal com juiz |
| `solicitar_medida` | 📋 Solicitar medida | Promotor | penal com juiz + promotor |
| `registrar_depoimento` | 🗣️ Registrar depoimento | Juiz/Promotor/Delegado | penal com juiz |
| `solicitar_documento_externo` | 📨 Solicitar documento externo | qualquer | sempre |
| `peticionar` | 📄 Peticionar | Advogado | sempre |
| `anexar_prova` | 🧾 Anexar prova | qualquer parte | sempre |
| `rol_provas` | 🗂️ Rol de provas | qualquer | se há provas |
| `gerenciar` | ⚙️ Gerenciar | Delegado/Juiz/Promotor | sempre |
| `voltar_fase` | ↩️ Voltar fase | Juiz/Desembargador/Procurador | se há volta possível |
| `manifestacao_mp` | 🏛️ Manifestação do MP | Promotor | penal |

**Botões contextuais fora do catálogo** (nascem em mensagens específicas, não no painel geral): `recorrer` (pós-sentença), `anexarpeticaoinicial`, `anexarcontestacao`, `decretarrevelia`, `concluirinstrucao`, `habilitacao:solicitar` (capa pública), `intimarreucumprida`, `addadvogado`/`removeradvogado`, `pedirrevisao`, e os pares de decisão `deferirpeticao`/`indeferirpeticao`, `deferirreqmp`/`indeferirreqmp`, apelação `manter`/`reformar`/`anular`.

**Botões de medida** (nus + painel): `medida:aprovar|negar|referendar|recorrer|cumprir|abrirprocesso|anexarindicios`, e via painel `deferirdireta`/`indeferirdireta`/`solicitardireta`/`negarjuiz`/`pedirreconsideracao[juiz]`/`decidirreconsideracao[juiz]`. Ofício: `oficio:criar|cumprir`. Todos os módulos compartilham o botão universal `arquivarmanual` (roteado pelo guard em `painel.js:629` → `arquivarManual`, gate por módulo em `podeArquivarManualmente` `painel.js:593-607`).

### 1.3 Modais e select menus

**Modais** (todos `painel:modal:...`, tratados em `painel.tratarModal` `painel.js:1104`; exceção: `medida:processomodal` tratado em `index.js:168`):
- **Processo:** `sentenca`, `sentencapocrime`, `parecermp`, `depoimento`, `partetardia`, `intimar`/`intimarforadestinatario`/`intimargenerico`, `anexarprova`, `gerenciarrg`/`gerenciarnome`/`gerenciaraddcrime`, `voltarfase`, `manifestacaomplivre`, `recorrer`, `habilitacao:solicitar`. Abertura: `processo:penal`/`processo:civil`.
- **Apelação:** `reformar`, `decidir`.
- **Medida:** `aprovarmp`, `referendar`, `negarjuiz`, `solicitardireta`, `emitir` (mandado); `medida:processomodal` (abrir processo).
- **Petição:** `porte-arma`, `troca-nome`, `limpeza-ficha`, `alvara-evento`, `vincularmanual`, `maisdados`, `<acao>:<numero>` (indeferir/diligência).
- **Outros:** `mp:requisicao`/`recomendacao`/`inqueritocivil`, `oficio:criar`, `ficha:consultarrg`/`consultardiscordid`/`consultartermo`, `ficha:certidao`, `crime:buscar`, `cargo:solicitar`, `instituicao:adicionar`, supervisão `trocar*`/`forcardenuncia`/etc.

**Select menus** (StringSelect + UserSelect, tratados em `tratarSelect`/`tratarUserSelect` `painel.js:888/1059`): tipo de medida/mandado, destinatário (instituição), atenuantes, veredicto por crime, resultado da sentença, papel de parte tardia, testemunha p/ depoimento, remover habilitação, risco (petição porte de arma), cargo desejado/contratação (RH), user-selects para vincular cliente/advogado/consultar pessoa.

### 1.4 Jobs / tarefas automáticas (`utils/prazos.js`)

Agendados em `index.js:68-94`: um bloco **diário** (`setInterval(DIA_MS)`) e um **a cada 10 min**. **Avisos por DM passam por `dmSeguro` e estão DESLIGADOS por padrão** (`config.avisosPorDmLigado`, `config.js:92`) — hoje só saem avisos **no canal**.

| Job | Cadência | Dispara | Move estado? |
|---|---|---|---|
| `verificarPrazosJulgamento` | diária | 7 dias sem julgar → **arquiva** processo (`Arquivado sem julgamento de mérito`) | ✅ arquivamento automático |
| `verificarRenovacoesPorteArma` | diária | porte vencido → status `Vencido`; aviso 3 dias antes | ✅ |
| `verificarProcessosSemJuiz` / `...PenaisSemJuiz` / `verificarPeticoesSemJuiz` | 10 min | **sorteia e distribui Juiz** automaticamente; senão avisa + botão "Designar Juiz" | ✅ sorteio automático |
| `verificarDiligenciasPendentes` | 10 min | diligência 24h não cumprida → **indefere petição automaticamente** | ✅ indeferimento automático |
| `verificarPrazoHabilitacao` | 10 min | 48h sem defesa habilitada → **nomeia defensor dativo** (sorteio); senão avisa | ✅ cria habilitação Aprovada |
| `verificarPrazoDefesa` | 10 min | 24h: dativo que não atuou → **re-sorteia** outro dativo; constituído → só avisa | ✅ parcial |
| `verificarMedidasAguardandoMP` / `...AguardandoJuiz` | 10 min | avisos 20h (responsável) / escalonamento 48h (Procurador/Desembargador) | ❌ só flags |
| `verificarMandadosPendentes` | 10 min | 40h → avisa Delegado de origem | ❌ |
| `verificarApelacoesPendentes` | 10 min | 8d avisa relator / 15d escala | ❌ |
| `verificarPrazosContestacao` | 10 min | avisa Juiz; **revelia continua manual** (por design) | ❌ |
| `verificarVinculosPendentes` | 10 min | **NO-OP** (desativado na Frente 7, mantido só p/ não quebrar o agendamento) | ❌ |

Idempotência: cada job grava um flag (`lembrete*Enviado`, `escalonamento*Enviado`, `avisoDefesaEnviado`) antes de enviar — padrão consistente (ressalva de entrega em 6.3).

### 1.5 Integrações

- **Sistema Integrado / Polícia Civil (entrada)** — `utils/integracaoPoliciaCivil.js`. `index.js:112` escuta `messageCreate` só no `canalRequerimentoPoliciaCivilId`; requerimento via webhook vira **medida cautelar** (`solicitarMedida`) ou **abre processo penal** (`ehEncerramentoInquerito`). Precisa da intent privilegiada `MessageContent` (senão embed chega vazio). **Validação de origem é opcional** — ver risco A (6.1).
- **Polícia Civil (devolutiva)** — `utils/devolutivaPoliciaCivil.js`. Devolve decisão de mandado/ofício/**sentença integral** ao `webhookDevolutivaPoliciaCivilUrl` (egress de teor — 6.1).
- **IA Google Gemini** — `utils/cartorio.js` (REST, sem SDK). Três usos: despacho de apoio, **revisão de forma** de textos (`revisarTexto`), **análise estruturada de PDF** (`analisarPdfEstruturado`). **Fallback gracioso sem chave** (`config.geminiApiKey` nulo → funções retornam null e o fluxo segue). Princípio "IA nunca decide o mérito" reforçado nos prompts. Chave vai na URL como query param mas **não é logada**.
- **Fivemanage** — **não existe.** Nenhum upload de mídia próprio; PDFs são baixados por URL de anexo do Discord e PNGs seguem anexados na mensagem/webhook.

---

## 2. PERMISSÕES POR CARGO

**Base (`utils/permissoes.js`):** `isAdmin` = Administrator do Discord ∨ `staffRoleId`. `temCargo` = a role `staffRoleId` ∨ `isSuperStaff` ∨ registro em `utils/rh` (**Administrator genérico NÃO age mais como cargo jurídico** — Frente 6). `isSuperStaff` = só a role `roleSuperStaffId` (atribuída à mão; usada como "coringa" nas decisões de mérito). Fonte de cargo = tabela `rh` (não a role do Discord).

| Cargo | Pode | Não pode / limites | Onde é checado |
|---|---|---|---|
| **Delegado** | Abrir inquérito penal (`/processo penal`); solicitar medida (`/medida`); anexar relatório de inquérito; identificar réu; gerenciar dados no inquérito; cumprir mandado; recorrer de medida negada (reconsideração ao Procurador); pedir revisão de arquivamento; emitir ofício; registrar depoimento | Não julga, não oferece denúncia, não consulta SISBAJUS, não pede certidão | `processo.js:3255,897`; `medida.js:370,476,924`; `oficio.js:39` |
| **Promotor** | Oferecer/arquivar denúncia (do **seu** caso); aprovar/negar medida; manifestação/requerimento do MP; solicitar medida direta no processo; consultar SISBAJUS; pedir certidão; atos extrajudiciais do MP (requisição/recomendação/inquérito civil) | Não julga; não decide reconsideração (é do Procurador) | `processo.js:234,3314`; `medida.js:413,461`; `ministerioPublico.js:33`; `ficha.js:23` |
| **Juiz** | Referendar/deferir medida; emitir mandado; julgar/sentenciar (do **seu** processo); intimar/citar; decidir habilitação, petição e requerimento do MP; decretar revelia; arquivar civil; SISBAJUS; certidão; voltar fase | Não oferece denúncia; não decide apelação (é do Desembargador) | `processo.js:3332,1566,2123,2731`; `medida.js:686,262` |
| **Advogado** | Abrir processo civil (`/processo civil`); protocolar petições administrativas; habilitar-se na defesa; peticionar; anexar petição inicial/contestação/prova; recorrer (quem perdeu) | Não julga; não consulta SISBAJUS; não pede certidão | `processo.js:3275,856,945,2072`; `peticao.js:846` |
| **Desembargador** | Decidir apelação (relator): manter/reformar/anular; trocar Juiz (supervisão); designar Juiz; reconsideração de medida indeferida por Juiz; voltar fase; reabrir petição | Só o **relator** decide a apelação | `processo.js:2929`; `supervisao.js:33,240`; `medida.js:630` |
| **Procurador** | Reconsideração de medida negada por Promotor; trocar Promotor/Delegado; forçar/manter denúncia; designar Juiz; gerir instituições; reabrir petição | — | `medida.js:535`; `supervisao.js:133,283`; `instituicao.js:7` |
| **Staff / Dono** | `isAdmin`: visão/ação ampla, RH (`/rh`), arquivamento manual. `isSuperStaff` (role "Staff Salve", à mão): coringa nas decisões de **mérito** (aprovar/negar/referendar/sentença/petição/apelação) | `isAdmin` **não** conta como cargo jurídico para abrir/decidir casos (Frente 6); só `isSuperStaff` é o coringa de mérito | `permissoes.js:9-38` |

**Padrão dominante nas decisões de medida:** checagem de **identidade da parte** (`interaction.user.id === medida.{promotor|delegado|juiz}`) com escape `isSuperStaff` — não por cargo genérico. As decisões recursais (reconsideração) usam **cargo institucional** (`temCargo('Procurador'/'Desembargador')`).

**Gates de renderização vs. execução:** o menu (`painel.js`) esconde botões por cargo (UX), mas a **trava real** está no handler de cada ação. Ver risco G (6.2) sobre ações que dependem só da revalidação interna.

---

## 3. MODELO DE DADOS

Storage: **um único `dados.json`** (`database/db.js`), com 18 tabelas declaradas em `TABELAS` + a órfã `identidades` (ver 6.5). Cada registro tem `id` (auto-incremental **global**) e `criado_em` (string pt-BR). Sem banco externo.

| Entidade (tabela) | Campos principais |
|---|---|
| **processo** (`processos`) | `numero`, `tipo` (Penal/Civil), `status`, `crimes[]`, `motivo`, `autor`/`autorNome`/`autorRg`/`autorDiscordId`, `reuNome`/`reuRg`/`reus[]`, `delegado`, `promotor`, `juiz`, `juizDesde`, `canalId`, `painelMsgId`, `diarioMessageId`, `medidaVinculada`, `atoMpVinculado`, `codigoExterno`, `sentenca`/`resultado`/`pena`/`regime`/`sentencaPorCrime[]`/`sentencaEm`, `habilitacoes[]`, `partes[]`, `depoimentos[]`, `intimacaoReuCumpridaEm`, `defesaApresentadaEm`, `prazoContestacaoAte`, `revisaoArquivamento`/`revisaoArquivamentoCanalId`, flags de aviso |
| **habilitacao** (subdoc de processo) | `id`, `reuId`, `reuNome`, `advogadoId`, `nomeCliente`, `rgCliente`, `status` (Pendente/Aprovado), `dativo`, `criadoEm`, `aprovadoEm`, `avisoDefesaEnviado` |
| **parte** (subdoc) | `id` (`p1`…), `papel` (reu/autor/testemunha_acusacao/testemunha_defesa/terceiro), `nome`, `discordId`, `rg`, `origem` |
| **depoimento** (subdoc) | `parteId`, `colhidoPor`, `papelDeQuemColheu`, `texto`, `dataHora` |
| **medida** (`medidas`) | `numero`, `tipo`, `alvo`/`alvoDiscordId`/`rgAlvo`, `motivo`, `status`, `delegado`, `promotor`, `juiz`, `canalId`, `codigoExterno`, `processoVinculado`, `fundamentacaoPromotor`/`fundamentacaoJuiz`/`decisaoJuizEm`, `aguardandoMpDesde`/`aguardandoJuizDesde` + flags de lembrete/escalonamento, `reconsideracao[Juiz]`/`...CanalId` |
| **mandado** (`mandados`) | `numero`, `medidaNumero`, `processoVinculado`, `tipo`, `alvo`, `status` (Emitido/Cumprido), `emitidoPor`, `cumpridoPor`, `lembreteMandadoEnviado` — **schema divergente entre origens** (6.4) |
| **oficio** (`oficios`) | `numero` (`OFI-0001`), `processoNumero`, `destinatario`, `assunto`, `conteudo`, `emitidoPor`, `canalId`, `status`, `aguardaRetorno`, `cumpridoPor`/`cumpridoEm` |
| **peticao** (`peticoes`) | `numero` (`0001PA`…), `tipo` (PorteArma/TrocaNome/LimpezaFicha/AlvaraEvento), `requerenteId`, `promotor`, `juiz`, `status`, `canalId`, dados do cliente (`rgCliente`/`nomeCliente`/`enderecoCliente`/`discordIdCliente`), `nivelRisco`, `validadeAte`, `nomeAtual`/`nomeNovo`/`primeiraVez`, `nomeEvento`/`localEvento`/`numeroPessoas`, `diligenciaDesde` |
| **ficha** (`fichas`) | `rg` (PK lógica), `nomeCivil`, `nomeCivilOrigem`, `historicoNomes[]`, `trocasDeNome`, `discordIds[]`, `vinculosOrigem[]`, `enderecos[]`, `telefones[]`, `redesSociais[]`, `criadoEm`/`atualizadoEm` |
| **rh** (`rh`) | `discordId`, `cargo`, `ativo`, `licenca`, `nomePersonagem` |
| **solicitacaoCargo** (`solicitacoesCargo`) | `discordId`, `cargo`, `nomePersonagem`, `status`, `decididoPor`/`decididoEm` |
| **apelacao** (`apelacoes`) | `numero`, `status`, `desembargadorId`, `recorrenteId`, `parteContrariaId`, `processoOriginalNumero`, `razoes`, `canalId` |
| **certidao** (`certidoes`) | `numero`, `rg`, `nomeCliente`, `finalidade`, `executorId`, `instituicao`, `canalId` |
| **atoMp** (`atosMp`) | `numero`, `tipo` (Requisição/Recomendação/Inquérito Civil), `destinatario`, `fundamentacao`, `prazo`/`objeto`, `executorId`, `canalId`, `processoVinculado`, `status` |
| **consulta** (`consultas`) | `numero`, `executorId`, `criterioRg`/`criterioDiscordId`/`criterioTermo`, `encontrado`, `canalId` (SISBAJUS) |
| **instituicao** (`instituicoes`) | `slug` (PK lógica), `nome`, `pai` — **nasce com semente de 10 instituições** (`db.js:13`) |
| **andamento** (`andamentos`) | `id`, `processoNumero`, `tipo`, `titulo`, `detalhe`, `executorId`, `anexoUrl`, `metadata`, `criadoEm` (timeline dos autos) |
| **documentoAnexado** (`documentosAnexados`) | `tipo`, `url`, `nomeArquivo`, `autorId`, `atoOrigemId`, `protocoloVinculado`, `dataEnvio` |
| **dossieInquerito** (`dossiesInquerito`) | `protocoloInquerito`, `medidas[]`, `mandados[]`, `documentos[]`, `processoVinculado` |
| **preferencia** (`preferencias`) | `discordId`, `revisaoAutomatica` (toggle de revisão por IA) |
| **estado** (`estado`) | `chave`/`valor` (KV para sobreviver a restart: IDs de painel/mensagens) |

**Observações estruturais:**
- **Numeração inconsistente:** processos/medidas/petições usam sufixo (`0001CV`, `0001MD`, `0001MO`, `0001PA`); ofício usa prefixo clássico (`OFI-0001`). Esquemas diferentes convivendo (`utils/numeracao.js`).
- **Campos de partes sobrepostos** em `processo`: coexistem `autorNome`/`autor`/`autorDiscordId`, `reuNome`/`reus[]`/`partes[]`/`habilitacoes[]` — várias representações da mesma informação (candidato a consolidação de modelo).
- `RESETAR_BANCO=1` zera o banco a cada deploy (produção/Railway) — precisa ser removida após subir limpo (`db.js:57`).

---

## 4. FLUXOS PONTA A PONTA

Legenda: **[botão]** = clique em cadeia; **[manual]** = exige comando/ação manual da parte; **[auto]** = job automático.

### 4.1 Penal (inquérito → sentença → recurso)

1. **Abertura do inquérito** — `/processo penal` (Delegado) **[manual]** → `criarProcessoPenal` (`processo.js:724`): cria canal, status `Aguardando decisão do MP`, sorteia Promotor se não informado, entra Delegado+Promotor. (Também pode nascer da Polícia Civil ou de ato do MP.)
2. **(Opcional) Relatório de inquérito** — botão `📎 Anexar relatório` **[botão]** → IA resume pro Promotor.
3. **Decisão do MP** — botões nus `Oferecer denúncia`/`Arquivar` **[botão]** → `modalParecerMp` → `confirmarParecerMp` → tela de revisão IA → `executarParecerMp`:
   - **Oferecer:** **[auto]** sorteia Juiz (exclui delegado/promotor/réus). Sem Juiz → aguarda (retry por job); com Juiz → status `Instrução`.
   - **Arquivar:** status `Arquivado`; oferece "Pedir revisão" ao Delegado.
4. **Intimação do réu (abre defesa)** — botão `📃 Intimar réu` **[botão]** → gera código + PNG → `✅ Marcar intimação cumprida` **[botão]** libera a **capa cega** em "Advogar - Pegar Casos" e inicia prazo de **48h** **[auto]**.
5. **Habilitação da defesa** — advogado clica na capa **[manual]** → `abrirModalHabilitacao` → valida **código + nome/RG** do réu → Juiz aprova/nega **[botão]**. Se 48h sem defesa: **[auto]** nomeia **defensor dativo**.
6. **Instrução** — depoimentos, intimações, petições, provas, manifestação/requerimento do MP, mandado/medida — todos **[botão]** ou **[manual]** por parte responsável.
7. **Sentença** — botão `Julgar` **[botão]** → **veredicto por crime** (≤25 crimes) → tela de apoio → `modalSentencaPorCrime` → revisão IA → `executarSentenca`: status `Encerrado`, PNG, **devolutiva à Polícia Civil**, arquiva canal, posta `Recorrer`.
8. **Recurso** — `Recorrer` (só quem perdeu) **[botão]** → razões → `criarApelacao`: **[auto]** sorteia Desembargador. Relator decide `manter`/`reformar`/`anular` **[botão]**. **Anular** re-sorteia Juiz e reabre o processo.

> **Onde ainda é manual (não encadeia sozinho):** toda a cadeia intimar → marcar cumprida → aprovar habilitação → julgar → sentença → recorrer é clique manual da parte. O único passo automático é o sorteio de Juiz (+ retry por job).

### 4.2 Civil (petição inicial → julgamento)

1. **Abertura** — `/processo civil` (Advogado) **[manual]** → `criarProcessoCivil` (`:800`): **[auto]** sorteia Juiz na hora. Status `Aguardando defesa`. PDF da inicial anexado depois.
2. **Recebimento/indeferimento** — `Arquivar` (indefere a inicial) ou `📨 Receber e citar réu` **[botão]**.
3. **Citação** — `Receber e citar réu` → `emitirIntimacao` (`ehCitacaoCivil`): status `Aguardando contestação`, calcula `prazoContestacaoAte`, posta `Decretar revelia`.
4. **Habilitação da defesa** — capa cível detalhada **[manual]** → `criarHabilitacaoCivil` (sem código, só nome/RG + @ opcional) → Juiz aprova → posta `Anexar contestação`.
5. **Contestação** — `📎 Anexar contestação` **[botão]** → status `Concluso para julgamento`, IA resume, dossiê de conclusão. Sem contestação após prazo → `Decretar revelia` **[botão, só após vencido]**.
6. **Julgamento** — `Julgar` (exige `Concluso para julgamento`) → select resultado (Procedente/Improcedente) → `modalSentenca` → `executarSentenca`. Recurso idêntico ao penal (parte contrária = autor).

### 4.3 Medida → apreciação → mandado

1. `/medida solicitar` (Delegado) **[manual]** → ticket, status `Aguardando MP` (ou `Aguardando anexo de indícios`). Sem indícios: `📎 Anexar indícios` **[botão]**.
2. Promotor `Aprovar` **[botão]** → **[auto]** sorteia Juiz → status `Aprovada - aguardando juiz`. `Negar` → Delegado `Juntar indícios e recorrer` ou reconsideração ao Procurador.
3. Juiz `Referendar` **[botão]** → revisão IA → **emite mandado automaticamente** (insere em `mandados`), PNG, devolutiva PC, libera `Cumprir`. `Negar provimento` → reconsideração ao Desembargador.
4. Delegado `Cumprir mandado` **[botão]** (exige PDF) → status `Cumprido`.
5. Promotor `Abrir processo penal` **[botão]** → modal → inicia processo penal vinculado.

> **Vias "diretas" dentro do processo já aberto:** Juiz emite mandado direto (`emitir_mandado` → select tipo/destinatário → modal), e Promotor solicita medida direta (`solicitar_medida`) sem passar por Delegado/MP — Juiz defere/indefere.

### 4.4 Petições administrativas

Os 4 tipos (Porte de Arma, Troca de Nome, Limpeza de Ficha, Alvará de Evento) seguem o **mesmo rito**:
1. **Protocolo** — `/peticao <tipo>` ou botão do painel (Advogado) **[manual]** → modal → `criarPeticao*` → ticket em `categoriaPeticoesId`, status `Aguardando sorteio de juiz`, grava endereço na ficha.
2. **Distribuição** — **[auto]** sorteia Promotor + Juiz (retry por job se faltar Juiz). Vínculo do Discord do cliente é **opcional**.
3. **Decisão (Juiz)** — `Deferir` (com confirmação; PorteArma pede nível de risco 0-3), `Indeferir`, `Converter em diligência` **[botão]**. Diligência 24h não cumprida → **[auto]** indefere.
4. **Efeitos** — PorteArma deferido → `validadeAte` +15d (renovação por job); TrocaNome deferido → `registrarTrocaNome` + `setNickname`; gera PNG (sentença/intimação), arquiva canal.

---

## 5. RELATÓRIO DE REDUNDÂNCIAS (FOCO)

> A boa notícia: **PNG, textos jurídicos, análise de PDF e telas de revisão-IA já estão bem consolidados** (fonte única, ver 5.E). As redundâncias reais são de **handlers/fluxos quase idênticos** e de **botões/caminhos sobrepostos**.

### 5.A — Handlers de fluxo quase idênticos (maior impacto)

| # | O quê | Onde | Por que é redundante | Consolidação sugerida |
|---|---|---|---|---|
| R1 | **Revisão-IA in-flow ×4** (parecer, razões, acórdão, sentença) | `processo.js:247,2838,3097,3450` (+ blocos `publicar*`/`usarRevisado*`) | Mesmo esqueleto (get rascunho → guard expirou → `deferUpdate` → `cartorio.revisarTexto` → tela) diferindo só no nome da função | `revisarRascunho(interaction,{chave,campoTexto,tela})` + `resolverTextoFinal(d,modo)` |
| R2 | **"Anexar PDF" ×3** (petição inicial, relatório, contestação) | `processo.js:853,894,935` | Sequência idêntica: busca → gate dono → "já anexado" → `aguardarAnexoPDF` → `criarDocumento` → editar → `gerarAnaliseEmbed` | `anexarDocumentoPdf({tipo,gateFn,statusPatch})` |
| R3 | **2 pares de reconsideração** (Procurador vs Desembargador) | `medida.js:491-582` e `587-679` | ~180 linhas espelhadas (cria ticket, embed, 2 botões, on-aprovar sorteia + reencaminha) | Parametrizar por cargo/estado |
| R4 | **Cumprimento com PDF** (mandado vs ofício) | `medida.js:870` e `oficio.js:61` | Mesma sequência perm→`aguardarAnexoPDF`→`criarDocumento`→update `Cumprido`→análise | Helper "registrar cumprimento com PDF" |
| R5 | **Petição: SLASH × MODAL × criar ×4 tipos** | `peticao.js:844-909` (execute) refaz o que `processarModal*` (`:523-594`) e `criarPeticao*` (`:196-301`) já fazem | 3 cópias do mesmo fluxo por tipo (12 blocos) | 1 função por tipo consumida pelas duas entradas |
| R6 | **Modais de fundamentação de campo único** (aprovar/referendar/negarjuiz) | `medida.js:416,689,783` | Só muda customId/título/label | `modalFundamentacao(customId,titulo,label)` |
| R7 | **RH aprovar × negar solicitação** | `rh.js:135` e `:167` | Estrutura quase idêntica (gate, buscar, `atualizarPorFiltro`, DM, embed) | Função comum parametrizada por decisão |
| R8 | **Esqueleto tipo→destinatário→modal** (mandado direto vs medida direta) | `mandado.js:72-141` vs `medida.js:135-186` | `modalTeorMandado`≈`modalJustificativaMedidaDireta`; resolução de destinatário duplicada | Helpers compartilhados de "select tipo/destinatário" |

### 5.B — Ações/caminhos sobrepostos

- **Duas intimações que convergem** — fluxo genérico (`abrirSelectDestinatarioIntimacao`→`confirmarIntimacaoGenerica`) e clássico (`modalIntimacao`/`emitirIntimacao`) terminam ambos em `postarIntimacaoNoCanal` (`processo.js:1773`); os próprios comentários admitem que só se distinguem "pelo momento". Consolidável.
- **Dois caminhos pro mesmo ofício** — submenu Ofício (`painel:menu:oficio`) e HUD do processo `📨 Solicitar documento externo` (`solicitardocumento`) desembocam ambos em `oficioCmd.criarOficio`. Além disso, a chamada a `criarOficio` está **triplicada** com payload quase igual (`painel.js:983,1206,1328`) → extrair `montarChamadaOficio()`.
- **Views legadas vs catálogo** — `botoesDenuncia`/`botoesJuiz` (`processo.js:108,357`) ainda são usadas na **abertura** do processo, mostrando um subconjunto diferente de botões frente ao `montarPainelAcoes` reposto depois. Aposentar as views legadas e abrir já com `painelAtual`.
- **4 blocos revisar/publicar/usarrevisado idênticos no router** — `painel.js:640-662` (sentenca/parecermp/acordao/razoes) → mapa `{modulo:{revisar,publicar,usarrevisado}}`.
- **UserSelect de RH ×3** (contratar/demitir/licenca) — mesma estrutura (`painel.js:850,854,858`).

### 5.C — Textos jurídicos que deveriam ser template único

- Vários teores **hardcoded inline** em `processo.js` que já poderiam morar em `utils/documentos.js` (onde já vivem `textoDespacho`/`textoIntimacao`): intimação do réu (`:1184`), decreto de revelia (`:1008`), despacho de recebimento (`:328`), indeferimento da inicial (`:1964`), citação (`:1884`), presets de intimação (`TEOR_PRESETS_INTIMACAO :1755`), crime-tardio (`:2399`).
- **Já consolidado (não mexer):** `crimesTexto.js` unificou formatação/busca de crime que estava em 3 lugares; `documentos.js` é fonte única dos 13 textos formais.

### 5.D — Código morto e exports supérfluos

| Item | Onde | Situação |
|---|---|---|
| `rh.aplicarApelido` | `rh.js:335` (export) | **Morto** externamente (uso só interno) |
| `rh.fichaFuncional` | `rh.js:341` (export) | **Morto** externamente (uso só interno) |
| `ficha.enderecosDe` | `ficha.js:178` (util) | **Morto** — nenhum chamador no projeto |
| `historico.medidaOrigem: null` | `historico.js:32` | Campo sempre nulo (resquício) |
| `verificarVinculosPendentes` | `prazos.js:162` | **NO-OP** ainda agendado a cada 10 min |
| Ramo `Condenado` de `modalSentenca`/`salvarSentenca` | `processo.js:125-130,3431` | **Ramo morto** — Penal+Condenado sempre vai por-crime |
| 8 exports supérfluos de `processo.js` | `vincularReu`, `embedCapaPublica`, `processoPublico`, `temAcessoTotal`, `painelAtual`, `botoesJuiz`, `finalizarApelacao`, `criarApelacao` | Rodam por dentro, mas o `module.exports` não é consumido de fora (poluição de API) |
| Wrappers passthrough | `certidoes.instituicaoDoSolicitante`, `oficio.instituicaoDoEmissor` | Só chamam `permissoes.papelInstitucional` — chamar direto |
| Comentário obsoleto | `cartorio.blocoDespacho` (`:60`) cita `blocoResumoPdf` inexistente | Justificativa de dedup caducou; 1 só chamador |

### 5.E — O que já está bem fatorado (para não "consolidar o que já está consolidado")

PNG (único `gerarDocumentoPNG` com 15 tipos + banner reusando o mesmo browser), textos jurídicos (`documentos.js`), análise/extração de PDF (1 engine `cartorio.analisarPdfEstruturado` + `analiseDocumento.gerarAnaliseEmbed`), telas de revisão-IA (`revisaoIA.js` substituiu ~40 linhas × 5), e o cabeçalho institucional (`permissoes.papelInstitucional`). **Nenhuma duplicação real remanescente de PNG/embed/PDF entre `utils/` e `commands/`.**

---

## 6. PONTOS DE RISCO / INCONSISTÊNCIA

### 6.1 Segurança / vazamento

- **[🔴 A] Webhook da Polícia Civil sem validação por padrão** — `integracaoPoliciaCivil.js:175-183`. Sem `WEBHOOK_REQUERIMENTO_POLICIA_CIVIL_ID` no `.env`, **qualquer** webhook no canal cria medida cautelar real, atribuída a um **Delegado arbitrário** (via `@menção` extraída do embed). O código reconhece a brecha mas o default é inseguro. → Exigir a env em produção (falhar fechado).
- **[🟠 B] `indeferirMedidaDireta` responde sem `ephemeral`** — `medida.js:301`. O texto do indeferimento vai **público** ao canal, ao contrário de todos os outros replies do arquivo. → Adicionar `ephemeral: true`.
- **[🟠 C] Vazamento de teor por listagem/rol sem gate:**
  - `verRolProvas` (`processo.js:2258`) **não checa parte** — mostra descrição/links de todas as provas a qualquer clicante (o `anexarprova` usa `ehParteDoProcesso`, o `rolprovas` não).
  - "Listar recentes" de medida/mandado (`painel.js:794,810` → `listarEResponder :304`) faz `db.todos(...).slice(0,15)` **sem filtrar por acesso** — só o `ver` individual é gated (`temAcessoMedida`/`temAcessoMandado`). Medidas são sigilosas na fase de inquérito.
  - **Autocomplete** de `/medida`, `/mandado`, `/oficio` lista **todos** os números com tipo/status, ignorando o sigilo do `ver`.
  - `processo/ver` (`painel.js:1283`) e `verProcesso` — confirmar se travam sigilo de inquérito (medida/mandado travam, processo aparenta não travar da mesma forma).
- **[🟠 E] PNG sem sanitização uniforme** — `gerarDocumentoPNG.js:150-272`. Só `corpoTexto` passa por `escapeHtml`; `nomeReu`, `crimeDescricao`, `pena`, `destinatario`, `subunidade`, `tituloDocumento`, `nomeAssinante` entram **crus** no HTML. Texto livre do usuário com `<` ou tag **quebra o layout** (sem exfiltração — imagem estática). → Escapar todos os campos interpolados.
- **[🟡] Egress de teor integral** — `devolutivaPoliciaCivil.js:87` envia a **sentença completa** ao webhook externo da PC, sem revalidar o dono do webhook (URL estática). Por design, mas é saída de decisão para fora do servidor.

### 6.2 Autorização

- **[🟡 D] `cumprirMandado` com checagem pulável** — `medida.js:877-880`: `responsavelCumprimento = medida?.delegado || processo?.delegado`. Se ambos forem falsy (mandado direto sem delegado), o `if (responsavel && ...)` **curto-circuita** e qualquer um pode marcar como cumprido. → Exigir Staff quando não há responsável.
- **[🟡 G] Ações sem gate no `painel.js`** — as ações de `processo` (`painel.js:701-733`), `supervisao` (`748-756`) e `cargo` (`635-636`), além das decisões de fundamentação (`640-662,737-744`), **não têm gate inline** — dependem 100% da revalidação interna do handler. **A maioria revalida** (verificado: `decidirPeticao`, `decidirRequerimentoMp`, `julgar`, `arquivarCivil`, supervisão via `podeSupervisionar`/`podeDesignar`). Ponto de atenção para replay de `customId` antigo: garantir que **toda** função de supervisão/decisão revalide (algumas só checavam na renderização do submenu).
- **[🟡] `salvarManifestacaoLivre` com gate largo** — `processo.js:2678`: `ehMembroDoMp` aceita **qualquer** Promotor/Procurador, não o `processo.promotor`. Um MP alheio ao caso junta manifestação/requerimento em qualquer processo penal (diferente de oferecer/arquivar, que exigem o dono).
- **[🟡] `instituicao.processarModalAdicionar` não re-checa `podeGerenciar`** — `instituicao.js:45` (contraste com `ficha.js`, que re-checa em todo `processarModal*`).
- **[🟡] Ações sensíveis de petição sem gate de cargo** — `anexarDocumentoPeticao`, `vincularClienteDiscord`, `processarVincularManual`, `abrirModalMaisDados` (`peticao.js:92,444,386,416`) confiam só no acesso ao canal — qualquer membro do ticket pode anexar/alterar vínculo e gravar na ficha do RG.

### 6.3 Consistência de dados / bugs

- **[🟡 F] Divergência de schema em `mandados`** — `medida.referendar` grava `medidaNumero` **sem** `processoVinculado` (`medida.js:712`); `emitirMandadoNoProcesso` grava `processoVinculado` com `medidaNumero:null` (`mandado.js:173`). Consequência: mandado de referendo não concede acesso via partes do processo (`temAcessoMandado`) nem mostra o processo no embed. Além disso, o PNG do referendo **não** é registrado em `documentosAnexados` (o direto é) — rastreabilidade inconsistente.
- **[🟡] `ficha.js:21` `TIPO_LABEL` sem `AlvaraEvento`** — uma petição de Alvará renderiza `undefined` na ficha do cidadão (`peticao.js` tem os 4 tipos; `ficha.js` só 3).
- **[🟡] Comentário/lógica stale de vínculo obrigatório** — `peticao.js:619` diz "vínculo do Discord é obrigatório antes de deferir", mas `decidir` (`:732`, Frente 7) não exige mais. Efeito real: TrocaNome pode deferir sem `discordIdCliente` → `setNickname` é pulado em silêncio.
- **[🟡] AlvaraEvento grava o local do evento como endereço pessoal** — `peticao.js:279/539`: `ficha.adicionarEndereco(rg, localEvento)` polui a ficha central do organizador.
- **[🟡] Slash `civil` força `@` obrigatório** — `processo.js:3241,3243` exige `autor_discord`/`reu_discord`, contra todo o resto que trata Discord como opcional. Abrir cível de quem não está no Discord é impossível pelo slash.
- **[🟡] `removerHabilitacao` monta `<@null>`** — `processo.js:1723`: quando o réu é só nome/RG (`reuId=null`), gera menção quebrada (`decidirHabilitacao` já trata com `reuRef`).
- **[🟡] Anulação deixa `sentencaPorCrime` órfão** — `finalizarApelacao` (`:3011`) zera `sentenca`/`resultado` mas não `sentencaPorCrime`; fica stale até o re-julgamento.
- **[🟡] Possível lockout da defesa (penal)** — `dadosBatemComReu` (`:1422`) exige `reuNome`+`reuRg`; inquérito aberto sem identificar o réu bloqueia toda habilitação (mesmo com o código certo) sem mensagem explicando a causa.
- **[🟡] Perda silenciosa de aviso** — vários jobs de `prazos.js` gravam o flag "avisado" **antes** do `canal.send`; se o envio falhar, o aviso nunca reenvia.
- **[🟡] `parseCriadoEm` frágil a formato** — `data.js:3` assume estritamente `DD/MM/AAAA, HH:mm:ss` pt-BR; um `criado_em` em ISO retorna `Invalid Date` e derruba cruzamentos por dias.
- **[🟡] RH: troca de cargo deixa role antiga no Discord** — `contratarComRole` só adiciona a role nova; promover Delegado→Juiz deixa a role Delegado pendurada (o `temCargo` segue o registro, não a role).
- **[🟡] RH: auto-atendimento sem restrição de cargo** — usuário pode solicitar Juiz/Desembargador/Procurador livremente (mitigado só pela aprovação da staff); canal de contratações tem fallback amplo (`rh.js:124-126`) que pode postar o card num canal público.

### 6.4 (consolidado em F acima)

### 6.5 Estrutural

- **Tabela `identidades` órfã** — existe no `dados.json` (0 registros) mas **não** está na lista `TABELAS` do `db.js` (aparentemente migrada para `fichas`). Não é semeada nem garantida em banco novo. → Remover do arquivo ou reintroduzir formalmente.
- **README desatualizado** — descreve apelação/petições como "próxima fase / fora desta versão", mas ambos já existem e estão implementados. Deriva de documentação.
- **`AUDITORIA_BOT.md` anterior** citava números de linha de uma versão antiga do `processo.js` — este documento substitui com a numeração atual.

---

## 7. TABELA-RESUMO (índice gatilho → função → cargo → arquivo)

> Índice de referência. "nu" = botão `modulo:acao:numero` direto por `index.js`; demais são `painel:*`.

### Processo (penal/civil)
| Gatilho | Função | Cargo | Arquivo |
|---|---|---|---|
| `/processo penal` | `criarProcessoPenal` | Delegado | `processo.js:3260,724` |
| `/processo civil` | `criarProcessoCivil` | Advogado | `processo.js:3280,800` |
| `/processo ver`·`listar`·`historico` | `verProcesso`/`listarProcessos`/`verHistoricoProcesso` | partes | `processo.js:3288-3302` |
| `processo:oferecer` (nu) | `oferecer`→`confirmarParecerMp` | Promotor dono | `processo.js:3311,230` |
| `processo:arquivar` (nu) | `arquivar` | Promotor dono | `processo.js:3320` |
| `processo:julgar` (nu) | `julgar` | Juiz do caso | `processo.js:3329` |
| `...:partetardia` | `abrirSelectPapelParteTardia` | Delegado/Juiz | `processo.js:3492` |
| `...:anexarrelatorio` | `anexarRelatorioInquerito` | Delegado dono | `processo.js:894` |
| `...:intimarreu`·`intimarreucumprida` | `intimarReu`/`marcarIntimacaoReuCumprida` | Juiz | `processo.js:1172,1210` |
| `...:recebereintimar` | `abrirModalReceberEIntimar`→`emitirIntimacao` | Juiz | `processo.js:1874,1888` |
| `...:gerenciardefesa`·`addadvogado`·`removeradvogado` | `abrirGerenciarDefesa`/`abrirAdicionarAdvogado`/`abrirRemoverAdvogado` | Juiz | `processo.js:3498,3530-3532` |
| `habilitacao:solicitar`·`aprovar`·`negar` | `abrirModalHabilitacao`/`decidirHabilitacao` | Advogado / Juiz | `processo.js:1436,1561` |
| `...:intimar`·`teorintimacao` | `abrirSelectDestinatarioIntimacao`/`confirmarIntimacaoGenerica` | Juiz | `processo.js:3500,1850` |
| `...:arquivarcivil` | `arquivarCivil` | Juiz | `processo.js:1949` |
| `...:decretarrevelia` | `decretarRevelia` | Juiz (após prazo) | `processo.js:986` |
| `...:requererprovas`·`concluirinstrucao` | `requererNovasProvas`/`concluirInstrucaoNovamente` | Juiz | `processo.js:1030,1057` |
| `...:regdepoimento` | `abrirSelectTestemunha`→`registrarDepoimentoHandler` | Juiz/Promotor/Delegado | `processo.js:3515,657` |
| `...:peticionar` | `peticionar` | Advogado parte | `processo.js:2062` |
| `...:deferirpeticao`·`indeferirpeticao` | `decidirPeticao` | Juiz | `processo.js:2118` |
| `...:anexarprova`·`rolprovas` | `abrirModalAnexarProva`/`verRolProvas` | parte / (sem gate) | `processo.js:3522,2258` |
| `...:gerenciar`·`gerenciarremovecrime` | `abrirGerenciar`/`tratarGerenciar`/`removerCrime` | Delegado/Juiz/Promotor | `processo.js:3525-3529` |
| `...:voltarfase` | `abrirModalVoltarFase`→`voltarFase` | Juiz/Des./Procurador | `processo.js:2489,2547` |
| `...:manifestacaomp`·`deferirreqmp`·`indeferirreqmp` | `abrirManifestacaoMp`/`decidirRequerimentoMp` | MP / Juiz | `processo.js:2616,2726` |
| `...:pedirrevisao` | `pedirRevisaoArquivamento` | Delegado dono | `processo.js:1983` |
| `...:recorrer` | `abrirModalRecorrer`→`criarApelacao` | quem perdeu | `processo.js:2808,2848` |
| `apelacao:manter`·`reformar`·`anular` | `abrirModalFundamentacaoDecisao`/`abrirSelecaoResultadoReforma`→`finalizarApelacao` | Desembargador relator | `processo.js:3550,3548,2981` |
| modal `processo:sentenca`/`sentencapocrime` | `salvarSentenca`/`salvarSentencaPorCrime`→`executarSentenca` | Juiz do caso | `processo.js:3418,3128` |

### Medida / Mandado / Ofício
| Gatilho | Função | Cargo | Arquivo |
|---|---|---|---|
| `/medida solicitar`·`ver`·`listar` | `solicitarMedida`/`embedMedida`/`embedListaMedidas` | Delegado / acesso | `medida.js:304,43,62` |
| `medida:aprovar` (nu) | `aprovar`→`processarAprovacaoMP` | Promotor dono | `medida.js:410,423` |
| `medida:negar` (nu) | `negar` | Promotor dono | `medida.js:458` |
| `medida:referendar` (nu) | `referendar`→`confirmarDecisaoMedida` | Juiz da medida | `medida.js:683,827` |
| `medida:recorrer` (nu) | `recorrer` | Delegado da medida | `medida.js:473` |
| `medida:cumprir` (nu) | `cumprirMandado` | Delegado responsável | `medida.js:870` |
| `medida:anexarindicios` (nu) | `anexarIndicios` | Delegado | `medida.js:921` |
| `medida:abrirprocesso` (nu) + modal `processomodal` | `abrirProcesso`/`criarProcessoModal` | Promotor | `medida.js:955,983` |
| `...:negarjuiz` | `abrirModalNegarJuiz`→`negarJuiz` | Juiz da medida | `medida.js:777,790` |
| `...:pedirreconsideracao`·`decidirreconsideracao` | reconsideração (Procurador) | Delegado / Procurador | `medida.js:491,533` |
| `...:pedirreconsideracaojuiz`·`decidirreconsideracaojuiz` | reconsideração (Desembargador) | Del./Prom. / Desembargador | `medida.js:587,628` |
| `...:solicitardireta`·`deferirdireta`·`indeferirdireta` | medida direta no processo | Promotor / Juiz | `medida.js:135,259,285` |
| `/mandado ver`·`listar` | `embedMandado`/`embedListaMandados` | partes | `mandado.js:23,39` |
| `...:mandado:emitir` | `abrirSelectTipo`→`emitirMandado`→`emitirMandadoNoProcesso` | Juiz do processo | `mandado.js:72,143,169` |
| `/oficio criar` / `...:oficio:criar` | `criarOficio` | Delegado/MP/Juiz | `oficio.js:113` |
| `...:oficio:cumprir` | `cumprirOficio` | emissor / SuperStaff | `oficio.js:61` |

### Petição / Ficha / RH / Crime / Instituição / Supervisão
| Gatilho | Função | Cargo | Arquivo |
|---|---|---|---|
| `/peticao <tipo>` / `...:peticao:abrir*` | `criarPeticao*` | Advogado | `peticao.js:196-301` |
| `...:peticao:deferir`·`indeferir`·`diligencia` | `decidir`→`finalizarDecisao` | Juiz do caso | `peticao.js:721,598` |
| `...:peticao:certidao`·`reabrir`·`anexardocumento` | `solicitarCertidaoDaPeticao`/`reabrirCaso`/`anexarDocumentoPeticao` | Juiz+ / Des./Proc. / — | `peticao.js:122,323,92` |
| `/ficha buscar` / `...:ficha:*` (SISBAJUS) | `abrirConsulta`/`abrirModalConsulta*`/`consultarPorPessoaSelecionada` | Promotor/Juiz/Des./Procurador | `ficha.js:119,145,280` |
| `/rh contratar`·`demitir`·`licenca`·`listar` | `contratarComRole`/`demitirComRole`/... | Staff (isAdmin) | `rh.js:39,51` |
| `...:cargo:solicitar`·`aprovar`·`negar` | `solicitarCargo`/`aprovarSolicitacao`/`negarSolicitacao` | qualquer / Staff | `rh.js:91,135,167` |
| `...:cargo:ficha` | `mostrarFichaFuncional` (ficha funcional/RH) | (via Supervisão) | `rh.js:267` |
| `/crime buscar` / `crime:resultado` | `embedCrime` | todos | `crime.js:27,44` |
| `/instituicao adicionar`·`listar` | `processarModalAdicionar`/`embedInstituicoes` | Admin/Procurador / todos | `instituicao.js:45` |
| `...:supervisao:trocar*`·`forcardenuncia`·`designarjulgador`·`filas` | `supervisao.abrirModal*`/`designarJulgador`/`filasPendentes` | Desembargador/Procurador | `supervisao.js:33,133,283,86,458` |
| `...:mp:requisicao`·`recomendacao`·`inqueritocivil`·`abrirprocesso` | atos do MP | Promotor/Procurador | `painel.js:831-834`, `ministerioPublico.js` |
| `...:pessoal:revisaoauto` (toggle) | `preferencias.alternarRevisaoAutomatica` | todos | `painel.js:666` |
| botão-portal `pessoal:abrirmenu` | abre o menu por cargo | todos | `painel.js:1454` |

---

## 8. PROPOSTA DE OTIMIZAÇÃO DO HUD (FOCO)

### 8.1 O problema, medido

Hoje `montarPainelAcoes` (`processo.js:553`) mostra a **união de TODOS os botões aplicáveis à fase** (botões do Discord são compartilhados na mensagem, não por-usuário). Num **processo penal em instrução**, o painel exibe ~16 botões em 4 linhas: `Julgar`, `Gerenciar defesa`, `Adicionar parte tardia`, `Emitir intimação`, `📦 Arquivar`, `🏛️ Manifestação do MP`, `📜 Histórico`, `📨 Solicitar documento externo`, `📄 Peticionar`, `🧾 Anexar prova`, `🗂️ Rol de provas`, `⚙️ Gerenciar`, `↩️ Voltar fase`, `⚖️ Emitir mandado`, `📋 Solicitar medida`, `🗣️ Registrar depoimento`. Um Advogado vê o mesmo muro cheio de botões de Juiz/MP que não pode usar.

### 8.2 A oportunidade: o metadado de cargo **já existe**

`CATALOGO_ACOES` **já declara `cargo` em cada ação** (ex.: `julgar → ['Juiz']`, `oferecer_denuncia → ['Promotor']`, `peticionar → ['Advogado']`). Hoje o empacotamento é por `grupo` (função); **basta reagrupar por `cargo`**. O custo de implementação é baixo — a informação está pronta.

### 8.3 Proposta: HUD enxuta com hubs por cargo

Substituir o muro de botões por **poucos botões-hub** (cada um abre um submenu efêmero com as ações daquele cargo, filtradas por fase) + uma linha fixa de **ações universais**. Sugestão de agrupamento a partir do catálogo atual:

**Linha fixa — Ações universais (sempre visíveis, sem hub):**
- `📜 Histórico (autos)` · `📨 Solicitar documento externo` · `🗂️ Rol de provas` (quando houver prova)

**👨‍⚖️ Hub Juiz** (`cargo: Juiz`): `Julgar`, `Emitir intimação` / `Receber e citar réu`, `Intimar réu`, `Gerenciar defesa`, `Adicionar parte tardia`, `Emitir mandado`, `Decretar revelia`, `Requerer provas`, `Concluir instrução`, `📦 Arquivar`, `↩️ Voltar fase`, decidir petição/requerimento do MP.

**🏛️ Hub Ministério Público** (`cargo: Promotor`): `Oferecer denúncia`, `Arquivar (denúncia)`, `🏛️ Manifestação do MP`, `📋 Solicitar medida`.

**🛡️ Hub Advogado** (`cargo: Advogado`): `📄 Peticionar`, `🧾 Anexar prova`, `📎 Anexar petição inicial`, `📎 Anexar contestação`, `Solicitar habilitação`, `Recorrer`.

**👮 Hub Delegado / Polícia** (`cargo: Delegado`): `Identificar réu`, `📎 Anexar relatório de inquérito`, `⚙️ Gerenciar (RG/nome/crime)` na fase de inquérito, `Pedir revisão de arquivamento`.

**🧑‍⚖️ Supervisão** (Desembargador/Procurador — pode ficar fora de hub, contextual): `⚖️ Designar Juiz`, `↩️ Voltar fase`, trocar Juiz/Promotor/Delegado, forçar/manter denúncia.

**Ações compartilhadas entre cargos** (reusam a MESMA função, aparecem em mais de um hub sem duplicar código):
- `🗣️ Registrar depoimento` → Hub Juiz + Hub MP + Hub Delegado (`cargo: ['Juiz','Promotor','Delegado']`).
- `🧾 Anexar prova` → qualquer parte (poderia ficar nas universais ou em Advogado + Juiz).
- `⚙️ Gerenciar` → Delegado (inquérito) + Juiz/Promotor (com juiz).

> Implementação sugerida: um `montarPainelHubs(processo)` que, em vez de `porGrupo`, faz `porCargo` a partir de `a.cargo`; cada hub é um botão `painel:hub:<cargo>:<numero>` que abre (efêmero) os botões daquele cargo já filtrados por `quando()`. Ações `cargo:['qualquer']` viram a linha fixa. Como o gate real continua no clique de cada ação, esconder por hub é só UX (não enfraquece segurança).

### 8.4 Botões redundantes/sobrepostos a eliminar ou fundir no HUD

| Botão | Sobrepõe-se a | Ação sugerida |
|---|---|---|
| `Emitir intimação` (genérico) | `Receber e citar réu` (civil) / intimação clássica — ambos caem em `postarIntimacaoNoCanal` | Fundir num único fluxo de intimação que decide "cita?" pelo estado |
| `📨 Solicitar documento externo` (HUD) | Submenu **Ofício** (`painel:menu:oficio`) — mesma `criarOficio` | Manter um só ponto de entrada (o do processo) e remover a duplicação de payload (`painel.js:983,1206,1328`) |
| `botoesDenuncia`/`botoesJuiz` (abertura) | `montarPainelAcoes` (painel reposto) | Aposentar as views legadas; abrir já com o painel do catálogo |
| `📦 Arquivar` (manual) vs `Arquivar` (denúncia MP) vs `Arquivar` (civil/inicial) | 3 "Arquivar" com significados distintos | Rotular claramente ("Arquivar inquérito" / "Indeferir inicial" / "📦 Arquivar canal") para não confundir |
| Ramo `Condenado` do `modalSentenca` | `modalSentencaPorCrime` (sempre usado no penal) | Remover o ramo morto (`processo.js:125-130,3431`) |

*(Só proposta — nada implementado.)*

---

## 9. IMPACTO DAS MUDANÇAS JÁ PLANEJADAS (onde afetam)

> Você listou 7 mudanças "para depois". Aqui está o estado real de cada uma e onde tocam.

| Mudança pretendida | Estado no código hoje | Onde afeta |
|---|---|---|
| **Mover Petições → Processos** | ✅ **Já feito no menu**: botão de petição dentro do submenu de Processos (`painel.js:158`). Falta (se quiser): mover a **ação** para dentro do HUD/fluxo do processo, não só do menu. Acoplamentos: `painel.js` (rotas `peticao:*`), `prazos.js:213,220`, `distribuicaoJuiz.js` (sorteio de Juiz **compartilhado**), `utils/ficha`, tabela própria `peticoes` (distinta de `processos`) | `peticao.js`, `painel.js:761-773`, `prazos.js`, `distribuicaoJuiz.js` |
| **Mover Ofício e Mandado → Medidas** | ✅ **Já feito no menu**: Ofício e Mandado dentro do submenu de Medidas (`painel.js:174-175`). **Mandado já é fortemente acoplado à medida** (nasce do referendo; cumprimento mora em `medida.js`). **Ofício é independente** — mover é só organizacional | `painel.js:181-198`, `medida.js`, `mandado.js`, `oficio.js` |
| **Mover Ficha Judiciária → Supervisão** | ⚠️ **Ambíguo — são DUAS "fichas":** (a) **SISBAJUS** (`ficha.js`, consulta criminal do cidadão) e (b) **Ficha Funcional** (`rh.js:267`, estatísticas dos membros). A **Ficha Funcional já está** dentro de Supervisão (`painel.js:231`). **Decidir qual das duas** você quer mover — têm rotas e gates distintos | `painel.js:231,251-261,637`, `ficha.js`, `rh.js:233,267` |
| **Remover botão "Revisão de texto" (vira toggle inline)** | ✅ **Botão já removido**; hoje é o toggle "Revisão automática (IA)" (`painel.js:87,107` confirma a saída). O que resta é o **passo intermediário** (tela "revisar/publicar/usar-revisado") nos 5 fluxos de fundamentação — se "toggle inline" significa eliminar essa tela, mexe em ~13 pontos de `processo.js` + `medida.js` | `revisaoIA.js`, `cartorio.js:111` (comentário), `processo.js:247,2838,3097,3450`, `medida.js:846` |
| **Trocar "medida provisória" por "medida"** | ⚠️ **"medida provisória" NÃO existe no código.** O termo real é **"Medida Cautelar"**. Se o alvo é uniformizar para "medida", os textos de usuário estão em: `medida.js:45,344` (título/descrição), `processo.js:2635` ("Requerer medida cautelar"), `processo.js:3237` (descrição do parâmetro), `documentos.js:201-207` | `medida.js`, `processo.js`, `documentos.js`, `ficha.js:101` |
| **Renomear canal "Diário Oficial" → "Habilitação de Advogado"** | ⚠️ **Texto de usuário já migrado** para "Advogar - Pegar Casos". Sobra **identificador interno**: `config.canalDiarioOficialId` + env `CANAL_DIARIO_OFICIAL_ID` (fallback), função `postarOuAtualizarDiario`, campo `processo.diarioMessageId`. Renomear = tocar `config.js:16-18`, `processo.js:1129` (+ chamadas `prazos.js:132`, `supervisao.js:367`, `distribuicaoJuiz.js:57`), `fase2.js:32`, `limpar-historico.js:17`. **Confirme o nome-alvo** ("Habilitação de Advogado" vs "Advogar - Pegar Casos" já em uso) | `config.js`, `processo.js`, `prazos.js`, `supervisao.js`, `distribuicaoJuiz.js`, `fase2.js` |
| **Reorganizar botões de ação por cargo (hubs)** | ❌ **Não feito** — é a proposta da seção 8. Metadado de cargo já existe em `CATALOGO_ACOES` (baixo custo) | `processo.js:389-572` |

---

## APÊNDICE — Arquivos de operação (não-runtime)

- `fase2.js` — script REST (dry-run / `--apply`) que configura **visibilidade de canais por cargo**; hardcoda IDs de canal. Referencia o canal "Diário Oficial".
- `limpar-servidor.js` / `.bat` / `limpar-historico.js` — scripts de faxina/reset (uso manual/ops).
- `scripts/simulador.js` / `simuladorDemo.js` — simuladores de fluxo (ligados por `SIMULAR=1` / `SIMULAR_DEMO=1`).
- `scripts/changelog.js` — histórico de mudanças.
- `deploy-commands.js` — registro dos slash commands por guild.

---

*Fim da auditoria. Nenhum código foi alterado. Aguardando sua revisão antes de qualquer mudança.*
