# ACHADOS (fora do escopo)

Registro de coisas encontradas durante a feature `manifestacao-mp-e-troca-peticoes`
que **não** fazem parte do escopo dela. Anotadas aqui (regra 4 do workflow) para não
virar refatoração oportunista.

---

## 1. Teste stale por causa do RG (Update 2) — CORRIGIDO no commit `4a9645d`

**O quê:** O formulário de solicitar cargo passou a exigir **RG** (Update 2:
`modalSolicitacao` + `solicitarCargo` em `commands/rh.js`). Os mocks `itJ`/`itAdv`
do Item 11 em `scripts/testes-correcoes.js` não foram atualizados e não forneciam
`rg`, deixando a suíte em **44/1** — o controle *"solicitar Advogado cria a
solicitação"* caía no early-return de "Informe o RG".

**Varredura (condição 3):** confirmado que **apenas esses dois** mocks de cargo
estavam sem `rg`. Os demais mocks de modal (habilitação linhas ~149-179, alvará
~242, porte ~253) já forneciam `rg`. Não há outros stale pelo mesmo motivo.

**Ação:** corrigido **só no teste** (adicionado `rg` aos dois mocks), sem tocar
produção — a produção estava correta ao exigir RG. Gate restaurado a **45/45**.
O `itJ` (Juiz) passava "por sorte" (rejeitado pela trava de cargo alto antes do
check de RG); o `rg` foi adicionado pra o teste isolar a causa certa da rejeição.

## 2. Suíte vermelha mergeou na main sem bloquear (processo/gate) — RECOMENDAÇÃO PENDENTE

**O quê:** o achado #1 quebrou a suíte na `main` e o merge passou mesmo assim.
Uma suíte que fica vermelha sem bloquear nada deixou de ser gate e virou decoração.

**Ação:** nada implementado agora (a pedido). A recomendação de como evitar que se
repita (rodar a suíte antes do merge / CI) vai no **relatório final** da feature.

## 3. Petição ficou fora do refactor de hubs por cargo (dívida da Fase 4)

**O quê:** o ticket da petição **não** usa hub por cargo — nem `commands/peticao.js`
tem hub, nem `abrirHubProcesso` (que serve `hubjuiz/hubmp/hubadvogado/hubdelegado`)
trata petições. A Fase 4 consolidou ação-por-cargo em hub para o **processo**, mas a
petição continuou com botões soltos no card (`botoesDecisao`).

**Impacto nesta feature:** os botões "Manifestar-se" / "Nada a opor" entram **soltos**
no ticket da petição por ora (combinado com o operador). Quando a petição ganhar hub
por cargo, esses botões (e os de decisão do juiz) devem migrar pro hub do cargo
correspondente. Dívida da Fase 4, não desta feature — reforçada no relatório final.

## 4. Segredo de justiça — lacuna conhecida (NÃO implementado, a pedido)

**O quê:** não existe hoje um "segredo de justiça" que esconda um processo/medida
**inteiro** dos magistrados-leitores. A leitura ampla (Juiz/Promotor/Procurador/
Desembargador enxergam todos os tickets) só tem **uma** exceção: o impedimento por a
pessoa ser **parte** (réu/investigado/alvo/autor/testemunha). Não há como um juiz
decretar sigilo e tirar um caso da vista dos demais magistrados.

**Onde entraria (uma linha):** um campo `segredoJustica: true` no registro do
processo/medida + guard em dois pontos — (a) na concessão de `ViewChannel` da leitura
ampla (não concede pros 4 cargos quando em segredo, só pros responsáveis) e (b) nas
funções de consulta/listagem/autocomplete (o mesmo gate de `podeVerTeor`). Default
aberto; só quem decreta o segredo restringe.

**Por que não agora:** decisão do operador — é feature separada, não bloqueia a leitura
ampla nem o impedimento. Registrado pra não sumir.
