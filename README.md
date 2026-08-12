# Bot Jurídico RP "Salve" — v3

Bot Discord (Node.js + discord.js v14) com três fluxos automatizados por botões — processo penal, processo civil e medida cautelar — mais um módulo de RH que controla cargos e acesso. Armazenamento em `dados.json` (sem banco externo, sem compilação nativa).

## O que ele faz

- **`/medida solicitar`** — Delegado pede medida cautelar (busca, prisão preventiva etc.) ao MP. Vira um ticket com botões **Aprovar/Negar**. Se aprovado, sorteia juiz automaticamente; o juiz só tem o botão **Referendar** (formaliza, não julga mérito) — ao clicar, o mandado é **emitido automaticamente pelo Juiz**, com botão **Cumprir** liberado só pro Delegado. Se negado, Delegado pode **Juntar indícios e recorrer** ao mesmo Promotor.
- **`/processo penal`** — Delegado abre inquérito com uma ou mais tipificações (concurso de crimes). Delegado e Promotor entram automaticamente no canal-ticket. Promotor decide **Oferecer denúncia** (sorteia juiz) ou **Arquivar** (encerra direto). Réu é opcional na abertura (`/processo vincular-reu` adiciona depois) e só ganha acesso ao canal quando um Advogado se habilita como defesa.
- **`/processo civil`** — Advogado abre com petição inicial; sorteia juiz na hora; banca de defesa se habilita depois (`/processo habilitar` via botão).
- **`/crime buscar`** — consulta a base de 126 tipificações extraída do Código Penal do servidor (autocomplete pelo nome/artigo), usada como referência de faixa de pena/fiança sugerida — o juiz sempre define a pena final na sentença.
- **`/rh contratar|demitir|licenca|listar`** — só Staff/Administração. Define quem tem qual cargo jurídico (Delegado/Promotor/Juiz/Advogado), o que também controla o Role do Discord e quem entra no sorteio de juiz.
- **`/oficio criar`** — vinculado a um processo, postado direto no canal dele.
- **`/mandado ver|listar`** — consulta (mandados agora nascem automaticamente do referendo de uma medida, não são mais criados manualmente).

## O que ficou de fora desta versão (combinado)

- Audiência de custódia — fica só no RP orgânico, sem virar mecânica do bot.
- Prazos processuais — revelia é sempre manual (juiz decide quando aplicar, sem contagem automática).
- Recurso/apelação (Desembargador) e Corregedoria (crimes do CPM) — próxima fase.
- Petições administrativas (CNPJ, nome, testamento, porte de arma) — módulo separado, a discutir depois.

## Passo a passo

1. **Node.js 18+** instalado.
2. Extraia o zip, abra terminal na pasta e rode `npm install` (só discord.js e dotenv — sem compilação nativa).
3. Crie a aplicação em https://discord.com/developers/applications, pegue o token e o Application ID, e convide o bot com escopos `bot` + `applications.commands` (permissões: Manage Channels, Send Messages, Embed Links, Manage Roles se for usar `/rh contratar` atribuindo Role automaticamente).
4. Copie `.env.example` para `.env` e preencha:
   - `DISCORD_TOKEN`, `CLIENT_ID`, `GUILD_ID`
   - `CARGO_STAFF_ID` — Role de Staff/Administração (controle total)
   - `CATEGORIA_PROCESSOS_ID` e `CATEGORIA_MEDIDAS_ID` — categorias onde os canais-ticket nascem (crie duas categorias no servidor e copie os IDs)
   - `ROLE_DELEGADO_ID`, `ROLE_PROMOTOR_ID`, `ROLE_JUIZ_ID`, `ROLE_ADVOGADO_ID` — Roles que o `/rh contratar` atribui automaticamente
5. Dê ao bot a permissão **Manage Channels** no servidor (ele precisa criar os canais-ticket) e **Manage Roles** (se for usar `/rh` atribuindo cargo automaticamente — o Role do bot precisa estar **acima** dos Roles jurídicos na lista de cargos).
6. `npm run deploy` pra registrar os comandos, depois `npm start` pra ligar o bot.
7. Cadastre as pessoas com `/rh contratar @usuario cargo:Delegado` (e Promotor, Juiz, Advogado) antes de testar os fluxos — sem isso os comandos de abertura de processo/medida recusam por falta de permissão.

## Estrutura

```
discord-bot-juridico/
├── index.js                 # roteia slash commands, botões, modais, autocomplete
├── deploy-commands.js
├── config.js
├── data/crimes.json          # 126 tipificações do Código Penal do servidor (Títulos I-XII)
├── database/db.js            # camada JSON genérica (processos, medidas, mandados, oficios, rh)
├── utils/
│   ├── numeracao.js           # PROC-0001, MED-0001, MAND-0001, OFI-0001
│   ├── permissoes.js          # admin (staff) + verificação de cargo via RH
│   ├── rh.js                  # cargos, contratar/demitir/licença, sorteio de juiz
│   └── canais.js              # cria/tranca canal-ticket, adiciona membro
└── commands/
    ├── medida.js               # /medida + botões aprovar/negar/referendar/cumprir/recorrer
    ├── processo.js              # /processo + botões oferecer/arquivar/habilitar/julgar + modal de sentença
    ├── mandado.js                # /mandado ver|listar (consulta)
    ├── oficio.js                  # /oficio criar (linkado a processo)
    ├── crime.js                    # /crime buscar (autocomplete)
    └── rh.js                        # /rh contratar|demitir|licenca|listar
```

## Próximos passos sugeridos (não bloqueiam esta versão)
- Corregedoria + crimes do CPM (fase 2, conforme combinado).
- Recurso/apelação ao Desembargador.
- Módulo de petições administrativas (`/peticao`), com integração entre porte de arma deferido e o crime de porte ilegal.
- Fiança — quem arbitra, como é registrada.
