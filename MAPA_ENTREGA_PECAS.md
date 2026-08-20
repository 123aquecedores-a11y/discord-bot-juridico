# MAPA — Ciclo de vida da PEÇA e a entrega selada in-game

Documento de leitura. Cobre **um** subsistema: como uma peça nasce, é entregue em cena com selo, é
recebida, e o que isso destrava. Não remapeia o bot (ver `AUDITORIA_BOT.md`).

Levantado em 20/08/2026 sobre o commit `990df75`. Onde algo não existe ou está ambíguo, está escrito
**NÃO ENCONTRADO** em vez de suposição.

Arquivos centrais:

| Arquivo | Papel |
|---|---|
| `utils/pecas.js` | Núcleo: selo, janela, recebimento, visibilidade. **Sem discord.js** — testável sem subir o bot. |
| `utils/emissaoPeca.js` | Camada de UI e orquestração: catálogo, rascunho, botões, render, efeitos. |
| `services/gerarPecaPNG.js` | Renderiza o documento (paginado, com selo). |
| `services/gerarDocumentoPNG.js` | Template do tribunal + Puppeteer + brasões. |
| `services/servidorPecas.js` | Servidor HTTP que entrega `/p/<token>.png` para a impressora do jogo. |

---

## 1. NASCIMENTO DA PEÇA

### 1.1 O catálogo

Fonte única: `TIPOS`, em `utils/emissaoPeca.js`. **16 tipos** hoje.

| tipo | emissor | destinatário | tabela | vira peça? |
|---|---|---|---|---|
| `peticao_incidental` | Advogado | Juiz | processos | sim |
| `intimacao_juiz` | Juiz | Advogado | processos | sim |
| `denuncia_mp` | Promotor | Juiz | processos | sim |
| `manifestacao_mp_gated` | Promotor | Juiz | processos | sim |
| `contestacao` | Advogado | Juiz | processos | sim |
| `relatorio_inquerito` | Delegado | Promotor | processos | sim |
| `peticao_inicial_civel` | Advogado | Juiz | processos | sim |
| `peticao_administrativa` | Advogado | Juiz | peticoes | sim |
| `sentenca` | Juiz | Advogado | processos | sim |
| `solicitacao_medida` | Promotor | Juiz | medidas | sim |
| `acordao` | Desembargador | Advogado | processos | sim |
| `decisao_peticao` | Juiz | Requerente | peticoes | sim |
| `razoes_recurso` | Advogado | Desembargador | apelacoes | sim |
| `fundamentacao_sentenca` | Juiz | — | processos | **não** (`semPeca`) |
| `fundamentacao_mandado` | Juiz | — | processos | **não** (`semPeca`) |
| `fundamentacao_medida` | Juiz | — | medidas | **não** (`semPeca`) |

Os três `semPeca: true` **não são peças**. Existem só para reusar o rascunho por trechos: o texto
vira o *corpo* de outro ato (a sentença, o mandado), não um documento entregue. `destinatarios: []`
é declaração, não descuido.

**O MANDADO NÃO É PEÇA.** Não existe tipo `mandado` no catálogo. Ele é gerado por
`commands/mandado.js` → `emitirMandadoNoProcesso` (mandado.js:~190) ou `commands/medida.js` →
`emitirMandadoDaMedida` (medida.js:602), com `services/gerarDocumentoPNG.gerarDocumentoPNG`, e
postado direto no canal. É exclusão declarada por urgência — o cumprimento não espera cena.

**O OFÍCIO TAMBÉM NÃO É PEÇA.** `commands/oficio.js:143` posta o PNG direto. Exclusão declarada:
não há destinatário no processo a quem entregar.

### 1.2 As duas portas de criação

Toda peça nasce por uma destas duas, e ambas terminam no mesmo lugar:

**(a) `abrirEmissao(interaction, tipoChave, numeroProcesso)`** — `emissaoPeca.js:518`
Fluxo do formulário: valida tipo ativo, modo (`legado` recusa com instrução), e `podeEmitir`
(:655). Abre `abrirModalTrecho` (:555) → `receberTrecho` (:582) → `painelRascunho` (:601) com
"Enviar / Adicionar mais texto / Ver texto / Apagar último". O "Enviar" cai em `criarPeca` (:690).

**(b) `emitirAtoComoPeca(ctx, {...})`** — `emissaoPeca.js:890`
Para atos que **já têm o próprio texto** e o próprio fluxo de revisão (sentença, acórdão, razões,
decisão de petição, manifestação, requerimento de medida). Aceita `interaction` OU `{ guild, autorId }`
— essa segunda forma existe porque a decisão de petição também é proferida por decurso de prazo
(`utils/prazos.js`), onde não há clique.

`tabela` sobrepõe a do catálogo quando o mesmo ato existe em ritos diferentes (a manifestação do MP
serve `processos` e `peticoes` com um tipo só).

### 1.3 O que é COMUM

`pecas.gerar()` (`pecas.js:310`) **só insere o registro**. Ela não rende PNG, não manda nada e não
posta o botão de entrega. Chamá-la sozinha produz uma peça que existe no banco e não pode ser
entregue — foi exatamente o defeito da sentença, corrigido em 19/08/2026.

O pipeline comum é **`finalizarPeca(ctx, peca, processo, cfg, tipoChave)`** — `emissaoPeca.js:841`.
Quatro passos, nesta ordem:

1. `pecas.paraRenderizacao` (:672) → `renderizar` (:913) → PNG por destinatário
2. `enviarAoEmissor` (:946) → **DM ao emissor**, com os links `/p/<token>.png` por página
3. `postarNoCanal` (:981) → card de metadado **+ o botão "Entregar agora"**
4. `andamentos.registrar` tipo `peca_emitida`

Quem cria peça chama `criarPeca` ou `emitirAtoComoPeca`. **Nunca `pecas.gerar` sozinho.**

### 1.4 Rascunho por trechos — o componente compartilhado

`rascunhos` (`RascunhoTTL`, 2h de inatividade) + `chaveRascunho(userId, tipo, numero)` (:361).
Teto `MAX_TRECHOS = 3` (:349), 4.000 caracteres cada (limite do campo do Discord, não do documento).

O desfecho é **injetável**: `FINALIZADORES` (`emissaoPeca.js:1284`) + `registrarFinalizador` (:1285).
Quem não registra cai em `criarPeca`. Registrados hoje:

- `fundamentacao_sentenca` → `commands/processo.js` → `finalizarSentencaPorTrechos`
- `fundamentacao_mandado` → `commands/mandado.js` → `emitirMandadosComFundamentacao`
- `fundamentacao_medida` → `commands/medida.js` → `emitirMandadosDaMedida`

`semearRascunho` (:466) deixa um ato começar num modal e **só então** ganhar o "adicionar mais
texto": o que foi digitado vira o primeiro trecho.

---

## 2. ENTREGA IN-GAME COM SELO

### 2.1 O selo: como nasce

Em `pecas.gerar` (:310), quando `gated`:

- `digitos: novosDigitos()` (:256) — **string** de 6 dígitos aleatórios (`crypto.randomInt`), só para
  conferência humana. Não autoriza nada.
- Por destinatário, em `novoDestinatario` (:267): um `token` próprio. **Um token por destinatário** —
  é o que permite dois advogados receberem a mesma sentença em cenas diferentes.

`gated = modo === MODOS.INGAME` (:319). Os três modos estão em `MODOS` (:67): `legado`, `ingame`,
`aberto`. O modo é **carimbado na criação e nunca alterado** (SPEC §11.2); `modoDoProcesso` (:68) lê
`registro.modoEntrega`, e registro sem o campo é `legado` por definição.

O token do selo é **separado** do token público da página (`registrarPaginasPublicas` :693,
`resolverTokenPublico` :708). A separação é obrigatória: se fossem o mesmo, quem recebesse o link do
documento teria a chave que destrava a entrega.

### 2.2 Passo a passo

**1. O emissor clica "Entregar agora"** — botão `peca:entregar:<numero>`, posto por `postarNoCanal`
(:981). Roteado por `router` (:1287) → `entregarAgora` (:1027) → `pecas.abrirEntrega` (:360).

**2. A janela abre.** `abrirEntrega` grava `janela = { abertaEm, expiraEm, aberturas }`.
Duração: `janelaMinutos()` (:92) — env `JANELA_ENTREGA_MIN`, faixa 10–120, **padrão 60 minutos**.
Valor fora da faixa cai no padrão em vez de valer — uma env com "0" não desliga a janela em silêncio.

> A "caixinha de 60s" do enunciado: **NÃO ENCONTRADO** com esse número. A janela de entrega é de
> **60 MINUTOS**. O único intervalo curto no fluxo é a janela de 3 segundos do Discord para
> reconhecer a interação, que o código contorna com `deferReply` antes de gerar PNG.

Só quem ocupa o papel do **emissor** abre (`podeOperarComoEmissor` :353). Janela expirada pode ser
reaberta quantas vezes o emissor quiser; cada abertura incrementa `aberturas`.

**3. O destinatário clica "Receber"** — `peca:receber:<numero>` → `abrirRecebimento`
(`emissaoPeca.js:1084`). Antes de qualquer coisa, faz checagens **de leitura** (não contam como
tentativa): ocupa o papel? já recebeu? selo travado? janela aberta?

**4. A caixa de captura.** `abrirRecebimento` cria um `createMessageCollector` no canal
(:~1115), filtrando mensagens do próprio usuário com anexo, com `time` = o que resta da janela.
Um coletor por `(peça, usuário)` — clique duplo não abre um segundo.

**5. A leitura do QR.** No `collect`: baixa o anexo, `lerSelo.lerToken(buffer)` (`utils/lerSelo.js`,
usa `jsqr` — decodificação local, sem IA/OCR), e chama `pecas.receber`.

### 2.3 A validação — `pecas.receber` (`pecas.js:416`)

Ordem exata das recusas:

| # | Condição | Conta para a trava? |
|---|---|---|
| 1 | peça não existe / não é gated / processo sumiu | não |
| 2 | não ocupa o papel de destinatário (`motivo: 'papel'`) | não |
| 3 | já recebido (`ja_recebido`) | não |
| 4 | selo travado (`travado`) | não |
| 5 | **sem token lido** (QR ilegível) | **não** — incrementa `ilegiveisSeguidas` |
| 6 | janela fechada (`janela`) | **sim** |
| 7 | token já usado (`token_usado`) | **sim** |
| 8 | token ≠ o do destinatário (`token_invalido`) | **sim** |

A distinção do passo 5 é deliberada: `MAX_ILEGIVEIS_AVISO = 5` (:63) avisa a staff mas **nunca
trava** — print ruim não pode punir como quem força entrada. `MAX_RECUSAS_TOKEN = 3` (:62) trava.

Sucesso: `tokenUsado: true` (o token queima), `recebidoEm`, `recebidoComo: 'entrega pessoal'`,
`recebidoPorId`, `capturaUrl`, `capturaMensagemId`.

Selo travado tem saída: `destravarSelo` (:494) — só Desembargador/Procurador/Staff.

### 2.4 `ocupaDestinatario`, `cobreOPapel`, `EFEITOS_POS_RECEBIMENTO`

**`ocupaDestinatario(processoTabela, registro, destinatario, usuarioId)`** — `pecas.js:226`
Responde "esta pessoa ocupa o papel a quem a peça é dirigida?". Duas vias, nesta ordem:

1. `ocupanteAtual` (:151) — resolve o ocupante **agora**: `Advogado` → por habilitação
   (`ocupanteDaHabilitacao` :130); `Autor` → `ocupanteAutor` (:145); `Requerente` → `requerenteId`;
   demais → `ocupanteDoSlot` (:117), lendo `TABELAS_TICKET` de `utils/responsaveis.js`.
2. Cobertura por cargo — `CARGOS_QUE_COBREM` (:219) limita a Juiz/Promotor/Desembargador/Procurador.
   **Advogado, Autor e Requerente NUNCA são cobertos** — é o que impede o advogado de uma parte de
   receber a intimação da outra.

O vínculo é sempre ao **papel**, nunca ao ID: juiz substituído assume a entrega pendente do
antecessor sem regenerar nada.

**`cobreOPapel(discordId, papel)`** — `utils/rh.js` (ponto único desde 19/08/2026)
A chefia cobre a base: `COBERTURA = { Juiz: ['Juiz','Desembargador'], Promotor: ['Promotor','Procurador'],
Desembargador: ['Desembargador'], Procurador: ['Procurador'] }`. Mão única — Juiz não cobre
Desembargador. Papel fora do mapa cai no cargo exato.

Consumidores: `atosPorCargo.podeAtuar`, `pecas.ocupaDestinatario`, `responsaveis.motivoInvalidez` e
`responsaveis.sortearParaPapel`.

**`EFEITOS_POS_RECEBIMENTO`** — `emissaoPeca.js:294`
Mapa tipo → `{ aplicar, aoAplicar }`. Três elos hoje:

| tipo | o que o recebimento destrava |
|---|---|
| `denuncia_mp` | o Juiz que recebeu **assume o processo** (`juiz`, `juizDesde`, status `Instrução`) e o painel é re-renderizado |
| `razoes_recurso` | grava `razoesRecebidasEm`; Manter/Reformar/Anular passam a existir |
| `solicitacao_medida` | grava `requerimentoRecebidoEm`; **se a medida não tinha juiz, quem recebeu assume**; os botões de decidir aparecem |

`aplicar` é síncrono e devolve `{ campos, aviso }`, `{ recusa }` ou `null`. `aoAplicar` é o
pós-processamento (repostar painel, lavrar andamento) — mora em cada efeito, não no coletor, porque
cada elo mexe numa tabela diferente.

### 2.5 Ordem de execução no recebimento

```
clique "Receber"
 └─ abrirRecebimento (emissaoPeca.js:1084)
     ├─ metadados / ocupaDestinatario / janelaAberta      ← leitura, não conta tentativa
     └─ createMessageCollector → collect
         ├─ fetch(anexo) + lerSelo.lerToken               ← jsQR local
         ├─ pecas.receber                                  ← valida e QUEIMA o token
         ├─ msg.reply "✅ Recebido. Selo conferido"
         ├─ andamentos.registrar('peca_recebida')          ← a entrega está lavrada AQUI
         └─ try { aplicarEfeitoDoRecebimento → aoAplicar } ← blindado: falha não desfaz a lavratura
```

A ordem importa: a lavratura vem **antes** do efeito, e o efeito é `try/catch`. Perder a entrega por
causa do efeito seria trocar um problema por um pior.

### 2.6 A válvula

`varrerValvula` (:758), com `valvulaMsPara(destinatario)` (:53): **6h** para Juiz/Promotor
(`PAPEIS_SEMPRE_NO_FORUM`, :44 — eles estão sempre no fórum) e **48h** para os demais. Envs
`VALVULA_FORUM_H` / `VALVULA_EXTERNA_H`. Vencida, o teor destrava sem cena, e o fato é registrado.

---

## 3. RECEBIMENTO — o que acontece, e o que NÃO existe

### 3.1 O despacho é AUTOMÁTICO

**Ninguém escreve despacho de recebimento.** São dois textos fixos, gerados pelo código:

- A resposta no canal: `emissaoPeca.js:1141` —
  `"✅ **Recebido.** Selo conferido — a entrega de **<numero>** está lavrada nos autos."`
- O andamento nos autos: `emissaoPeca.js:1142-1148` — tipo `peca_recebida`, título
  `"📥 Documento recebido em cena"`, detalhe `"<numero>: entrega pessoal confirmada pelo selo,
  recebida por <@id>."`

Não há campo de texto livre, modal, nem template configurável no recebimento.

O que **pode** ser escrito é a mensagem do **efeito** (`aviso`), que também é fixa por tipo — ex.:
`"⚖️ Você recebeu a denúncia e passa a ser o Juiz responsável pelo processo X"`.

### 3.2 Não existe recusar/rejeitar

**NÃO ENCONTRADO.** Não há `recusarPeca`, `rejeitarPeca` nem botão equivalente. O destinatário só
tem dois desfechos: receber (com selo válido) ou não receber. Quem não recebe é destravado pela
válvula por decurso de prazo.

O que existe e **não** é isso: `encerrarEntrega` (`pecas.js:394`) fecha a janela — ato do **emissor**,
não recusa do destinatário.

Consequência prática: o Juiz não tem como devolver um documento dizendo "não recebo". Ele recebe e
decide depois.

---

## 4. ATRIBUIÇÃO DE JUIZ / RESPONSÁVEL

### 4.1 Quatro mecanismos, conforme a origem

| Origem | Como o Juiz é definido | Onde |
|---|---|---|
| Processo penal, denúncia oferecida | `rh.sortearJuiz` (sorteio com balanceamento de carga) | `processo.js:~350` |
| Processo penal, denúncia **entregue em cena** | **quem recebe assume** | `EFEITOS_POS_RECEBIMENTO.denuncia_mp` |
| Medida vinda de dentro de um processo | herda `processo.juiz` | `medida.js:213` |
| Medida avulsa (MP, sem processo) | nasce `juiz: null`; **quem recebe assume** | `EFEITOS_POS_RECEBIMENTO.solicitacao_medida` |
| Medida do Delegado | o MP sorteia ao aprovar (`rh.sortearJuiz`) | `medida.js:~806` |

`rh.sortearJuiz` prioriza quem tem menos casos abertos e aceita `excluirIds` (delegado, promotor,
réus, alvo) — impedimento.

Para a peça **avulsa**, não há juiz na criação de propósito: a peça é dirigida ao **papel** `Juiz`,
`ocupaDestinatario` deixa qualquer um com o cargo receber, e a titularidade é consequência da
entrega. É a mesma fila do resto do bot, não um mecanismo novo.

### 4.2 Onde o responsável fica gravado

Campos por tabela, em `TABELAS_TICKET` (`utils/responsaveis.js:20`):
`processos` → `juiz`, `promotor`, `delegado` · `medidas` → idem · `peticoes` → `juiz`, `promotor` ·
`apelacoes` → `desembargadorId`.

Além do titular, os atos gravam **quem realmente executou**: `atosPorCargo.carimboDeExecucao`
(`executadoPorId`, `executadoEm`). Sem isso o histórico diria "o juiz do processo julgou" quando
quem julgou foi um colega cobrindo.

Manutenção: `responsaveis.tratarResponsavelInvalido` (evento de demissão) e
`varrerResponsaveisFantasma` (rede de segurança, com trava de massa
`LIMITE_RECONCILIACAO_SEM_CARGO = 5`).

### 4.3 `ehMembroDoMP` — e o buraco do admin

`utils/ministerioPublico.js:33`:

```js
function ehMembroDoMP(interaction) {
  return isAdmin(interaction) || temCargo(interaction, 'Promotor') || temCargo(interaction, 'Procurador');
}
```

Libera **três** perfis: Promotor, Procurador e **qualquer admin**.

Existe um segundo predicado, `ehMembroDoMp` (minúsculo no `p`) em `commands/processo.js`, usado por
`abrirManifestacaoMp` (:3061). São nomes quase idênticos com escopo diferente — ponto de confusão.

**Consequência observada em produção (20/08/2026):** os processos `0025PN` e `0027MD` ficaram com
`promotor: 400438471631699978`, que está ativo como **Desembargador**, não como Promotor. Ele é
admin, o painel do MP o liberou, e o fluxo grava **quem clicou** como promotor. A varredura de
fantasma passa a apontá-los para sempre, porque `cobreOPapel(Desembargador, 'Promotor')` é `false` —
corretamente.

Não é bug de código novo; é `isAdmin` dentro de `ehMembroDoMP` encontrando um fluxo que grava o
clicador como responsável.

---

## 5. DIVERGÊNCIAS E PONTOS CEGOS

### 5.1 "Oferecer denúncia": DOIS caminhos, e um pula o selo

Esta é a resposta direta à pergunta.

**Caminho A — pelo hub do MP: USA o fluxo selado.**

```
🏛️ Ministério Público (hub)                    processo.js:625  acoes: ['manifestacao_mp', 'registrar_depoimento', 'anexar_prova']
 └─ botaoManifestacaoMp                        processo.js:3056  painel:acao:processo:manifestacaomp
     └─ abrirManifestacaoMp                    processo.js:3060  select "Ato do MP nesta fase"
         └─ tratarManifestacaoMp               processo.js:3079
             └─ escolha === 'oferecer' && !ehLegado(processo)
                 → abrirEmissao('denuncia_mp') processo.js:3096   ✅ GATED
```

**Caminho B — o botão direto `processo:oferecer`: PULA o selo.**

```
ButtonBuilder 'Oferecer denúncia'              processo.js:430   customId processo:oferecer:<n>
 └─ index.js:311   mapa.processo.oferecer → 'oferecer'
     └─ oferecer()                             processo.js:4160
         └─ showModal(modalParecerMp(numero,'oferecer'))
             └─ confirmarParecerMp → executarParecerMp
                 └─ canal.send({ textoDespacho, files:[Parecer-MP-<n>.png] })  ❌ NÃO GATED
                                                processo.js:343
```

O caminho B posta o **teor e o PNG direto no canal do processo**. Nenhuma peça é criada, nenhum selo
é gerado, nenhuma entrega acontece.

**Estado atual do botão B:** a entrada `oferecer_denuncia` existe em `CATALOGO_ACOES`
(processo.js:428) mas **não está em nenhum hub** (`acoes` das linhas 616/623/628/633) nem em
`ACOES_UNIVERSAIS_PAINEL` (:640). Logo, `montarPainelAcoes` (:659) **não a renderiza**. O botão está
órfão no catálogo — mas o handler continua vivo e roteado, então botões em mensagens **antigas**
ainda funcionam e levam ao caminho não-gated.

O mesmo vale para `arquivar_mp` (:433).

### 5.2 ✅ CORRIGIDO em 20/08/2026: o botão do painel do MP usava o caminho B

**Estado original (registrado aqui porque a lição importa).** `commands/painel.js:500`, no fluxo
"Abrir processo penal" do painel do MP (subiu em `5c33256`), montava:

```js
new ButtonBuilder().setCustomId(`processo:oferecer:${resultado.numero}`).setLabel('📝 Escrever denúncia')
```

O comentário logo acima afirmava *"a denúncia segue o caminho normal"*. Estava errado:
`processo:oferecer` é o caminho **B**, o não-gated. O promotor que abria o penal pelo painel do MP
e clicava "📝 Escrever denúncia" caía no `modalParecerMp` e o teor ia direto ao canal, sem peça,
sem selo e sem entrega ao Juiz. Pior: o elo `EFEITOS_POS_RECEBIMENTO.denuncia_mp` (o Juiz que
recebe assume o processo) nunca disparava.

**Como está agora.** O botão usa `painel:acao:processo:escreverdenuncia:<numero>`, roteado em
`painel.js` para `processoCmd.abrirDenunciaGated` — que faz exatamente o que `tratarManifestacaoMp`
faz na opção 'oferecer': mesmas travas (membro do MP + dono do caso), mesma bifurcação por
`ehLegado`, mesmo destino `abrirEmissao(interaction, 'denuncia_mp', numero)`. Não é um segundo
fluxo; é o mesmo, sem o menu na frente.

**Por que o teste antigo não pegou.** `testes-penal-pelo-mp.js` asserção 3f perguntava se o botão
EXISTIA (`/processo:oferecer:\$\{resultado\.numero\}/`), não para onde ele levava — e passava.
A asserção agora cobra o destino, e há um par negativo (`3f2`) que falha se alguém reapontar para
`processo:oferecer`. Verificado por mutação: revertendo o customId, 3f, 3f2, 6b e 6c falham.

`executarParecerMp` e o handler `processo:oferecer` **continuam existindo** — o arquivamento ainda
depende deles, e essa é decisão separada do operador.

### 5.3 Outros pontos onde o mesmo ato segue caminhos diferentes

| Ato | Caminho gated | Caminho não-gated | Bifurca por |
|---|---|---|---|
| Denúncia | `abrirEmissao('denuncia_mp')` — processo.js:3096 | `oferecer()` → parecer — processo.js:4160 | **origem do clique**, não pelo modo ⚠️ |
| Manifestação do MP (processo) | `manifestacao_mp_gated` — processo.js:3105 | `modalManifestacaoLivre` | `ehLegado(processo)` |
| Manifestação do MP (petição) | `emitirAtoComoPeca` — peticao.js:~350 | teor + PNG no canal — peticao.js:361 | `modoDoProcesso` |
| Sentença | `emitirAtoComoPeca('sentenca')` | `textoSentenca` + PNG — processo.js:3997 | `sentencaGated` |
| Acórdão | `emitirAtoComoPeca('acordao')` | `textoDoc` + PNG — processo.js:3715 | `!emissaoAcordao.ok` |
| Decisão de petição | `decisao_peticao` | `textoSentencaPeticao` + PNG — peticao.js:1040 | `decisaoGated` |
| Medida requerida pelo MP | `solicitacao_medida` — medida.js:~510 | sorteia juiz + botões | `modoDoProcesso(medida)` |

Todas bifurcam por **modo do processo**, que é o desenho correto (SPEC §11.2: o rito não muda no
meio). A única que bifurca pela **origem do clique** é a denúncia. Desde 20/08/2026 as duas portas
de painel levam ao gate (5.2); o caminho B só sobrevive em botões de mensagens antigas.

### 5.4 Fora do gate por decisão declarada

Registrados em `scripts/testes-anexos-em-canal.js`, que falha se um anexo novo aparecer sem
declaração:

`URGENCIA` — mandado, ofício, intimação de pauta, via do réu (SPEC §11.1) ·
`SEM_TEOR` — carteirinha, banner, brasão, edital, comunicado do Diário ·
`PROVA` — anexo das partes ·
`AO_EMISSOR` — a via por DM de quem escreveu ·
`INTERNO` — parecer do MP (bifurcado upstream) e decisão de revisão de arquivamento (roda no
inquérito, sem advogado no canal).

O **Diário Oficial não recebe anexo nenhum** de decisão: `TIPOS_QUE_PODEM_ANEXAR`
(`utils/diarioOficial.js:166`) libera só `comunicado` e `edital_aberto`.

---

## 6. RENDERIZAÇÃO DO DOCUMENTO

### 6.1 Qual função

**`gerarPecaPNG(dados)`** — `services/gerarPecaPNG.js`. Devolve um **array de buffers**, um por
página. Chamada por `renderizar` (`emissaoPeca.js:913`), um render por destinatário (tokens
diferentes → selos diferentes).

Documentos que **não** são peça usam `gerarDocumentoPNG` (`services/gerarDocumentoPNG.js`) —
página única, sem selo. É o caso de mandado, ofício, intimação e parecer do MP.

### 6.2 A paginação

Roda **dentro do Chromium** (`scriptPaginacao`), porque só ele sabe a altura real do texto
renderizado. Move parágrafo a parágrafo comparando `corpo.scrollHeight > corpo.clientHeight`;
estourou, abre folha nova. Segunda passada acomoda a assinatura, que não participa da primeira.

Da página 2 em diante a folha nasce `.continuacao`: cabeçalho compacto (brasão reduzido + número +
`fl. X/Y`), sem título nem metadados — o timbre inteiro custaria ~190px por página.

### 6.3 O brasão — como é decidido

`services/gerarPecaPNG.js:300`:

```js
const chaveOrgao = /minist/i.test(dados.orgao || '') ? 'ministerio_publico'
  : (/pol[ií]cia/i.test(dados.orgao || '') ? 'policia_civil' : 'judiciario');
const brasao = getLogoImgTag(chaveOrgao);
```

Decidido por **regex sobre a string `orgao` do catálogo** (`TIPOS[tipo].orgao`), não por um campo
dedicado. `getLogoImgTag` (`gerarDocumentoPNG.js:~436`) resolve por `LOGO_FILES`:

| chave | arquivo |
|---|---|
| `judiciario` | `assets/logo-tjsp.png` |
| `ministerio_publico` | `assets/logo-mpsp.png` |
| `policia_civil` | `assets/logo-policia-civil.png` — **comentário no código diz "adicionar arquivo quando disponível"** |

Arquivo ausente → `getLogoImgTag` devolve string vazia e o cabeçalho sai só com texto (fail-open).

O brasão usa **`height: 64px` fixo**, não `max-height`. É deliberado: `max-height` só reserva altura
depois que a imagem decodifica, e a paginação mede antes — o corpo recebia altura demais e o último
parágrafo saía cortado pelo selo.

### 6.4 Onde o selo aparece

**Em TODAS as páginas**, com o mesmo token. Deliberado: num documento de três páginas exibido no
jogo, o receptor captura a que estiver na tela — ele não tem como saber que precisaria rolar até o
fim. Qualquer página capturada decodifica igual.

O que fica **só na última**: os 6 dígitos de conferência humana, o aviso de sanção, a caixa de
arquivo físico e a assinatura (CSS `.folha:not(.ultima) ... { display: none }`).

Parâmetros do QR, todos com conta por trás (`gerarPecaPNG.js:40-54`):

- payload = **só o token**, nunca URL (embutir endereço engordaria o código)
- `errorCorrectionLevel: 'Q'` — 25% de redundância, sobrevive a HUD do jogo por cima
- `margin: 4` módulos — zona de silêncio; com margem 1 a borda do selo encosta e a leitura falha
- `QR_PX = 168` → 168/41 = **4,1 px por módulo** (a versão anterior dava 2,74, marginal)
- `image-rendering: pixelated` — se algum navegador escalar, que seja por vizinho mais próximo

### 6.5 Estrutura da página

Template do tribunal, idêntico ao da intimação: brasão · `PODER JUDICIÁRIO` · `Comarca de São Paulo
— Vara Única` · `Processo/Protocolo · Documento · Data` · **Vistos.** · corpo paginado ·
**CUMPRA-SE.** · assinatura cursiva + nome + cargo · selo · rodapé
`Documento gerado eletronicamente pelo sistema do Tribunal`.

`CUMPRA-SE.` só aparece em **ato do Juízo** (`ehAtoDoJuizo`, regex sobre `cargoAssinante`) — numa
petição de advogado seria mandar cumprir o que ele não pode determinar.

O rodapé distingue explicitamente documento **sem** selo (`— modo aberto, sem selo de autenticação`),
para que um documento não gated não finja ter autenticação.

### 6.6 A página pública

`services/servidorPecas.js` serve `/p/<token>.png` sem autenticação — a impressora do jogo busca a
imagem sem sessão, e exigir login quebraria a impressora. Exceção declarada e estreita: o servidor
só chega ao teor por **token público imprevisível** (24 bytes), nunca por número de peça. É a única
entrada em `PERMITIDOS` na varredura de visibilidade além do próprio `utils/pecas.js`.

Os rótulos vêm de `utils/catalogoAtos.js` — fonte única, **sem discord.js**, criada porque o
servidor HTTP não pode importar `emissaoPeca`. Duas cópias do catálogo foram a causa do bug crítico
em que a página impressa saía sem selo.

---

## Resumo dos achados

| # | Achado | Onde |
|---|---|---|
| 1 | ✅ CORRIGIDO 20/08 — o botão "📝 Escrever denúncia" do painel do MP ia ao caminho **não-gated**; agora vai a `abrirDenunciaGated` | `painel.js:500` → `processo.js:abrirDenunciaGated` |
| 2 | `oferecer_denuncia` e `arquivar_mp` estão órfãos no catálogo (não renderizados), mas o handler segue vivo para botões antigos | `processo.js:428,433` |
| 3 | `ehMembroDoMP` inclui `isAdmin`; staff que usa o painel do MP vira `promotor` do caso sem ter o cargo | `ministerioPublico.js:33` |
| 4 | Dois predicados quase homônimos: `ehMembroDoMP` e `ehMembroDoMp` | `ministerioPublico.js` / `processo.js` |
| 5 | Não existe recusar/rejeitar peça | **NÃO ENCONTRADO** |
| 6 | A "caixinha de 60s" é de **60 minutos** | `pecas.js:92` |
| 7 | `logo-policia-civil.png` pode não existir (comentário no código) | `gerarDocumentoPNG.js` |
| 8 | 20/08 — o MP não pede mais cautelar por botão próprio: "Solicitar medida" saiu do hub e "Requerer medida cautelar" saiu do menu da Manifestação. A cautelar vira REQUERIMENTO (gated) e quem expede o mandado é o Juiz, por `emitir_mandado` — caminho verificado como independente | `processo.js` hub `hubmp` / `abrirManifestacaoMp` |

O documento foi escrito numa passada read-only. As alterações de 20/08/2026 marcadas com ✅ vieram
depois, num pedido separado do operador, e estão registradas aqui para o mapa não ficar mentindo.
