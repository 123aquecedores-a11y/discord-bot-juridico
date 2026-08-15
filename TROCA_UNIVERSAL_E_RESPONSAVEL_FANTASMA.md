# Parte 2 (revisada e ampliada) + Parte 3 (responsável fantasma)

Substitui a "Parte 2" descrita em `MANIFESTACAO_MP_E_TROCA_PETICOES.md`. O escopo cresceu: não é mais "troca nas petições", é troca universal. E entrou uma Parte 3 nova, motivada por um bug ativo.

## PARTE 2 — Troca de responsável, universal e dentro do ticket

### Princípio de desenho (leia antes de codar)

Não enumere tipos de ticket. A regra não é "vale para processo penal, civil, medida, petição, apelação, reconsideração". A regra é:

> Todo ticket que tem alguém marcado como responsável permite trocar esse alguém.

Se amanhã surgir um tipo novo de ticket com responsável, ele herda a função sem ninguém cadastrar exceção. Se você escrever uma lista de tipos, ela vai ficar desatualizada na próxima feature.

Na prática: o resolvedor genérico já previsto (`{ tipo, id } → { canalId, responsaveis[], statusAtual, permiteTroca }`) descobre quem são os responsáveis daquele ticket e monta as opções de troca a partir disso — não a partir de um `switch` por tipo.

### Papéis trocáveis

- Juiz → trocado por Desembargador (e Staff)
- Promotor → trocado por Procurador (e Staff)
- Delegado → trocado por Staff + Desembargador + Procurador
- Advogado habilitado → mantém a regra que já existe (só o Juiz remove); não muda aqui

Staff/dono continua com controle total sobre tudo.

### Onde fica o botão

Dois pontos de entrada, UMA implementação. O painel central mantém o botão que já existe; entra um novo dentro do ticket. Os dois chamam a mesma função — se você acabar com duas implementações, errou.

Divisão natural de papéis:
- Painel central = onde se descobre o que está parado (a lista, com tempo de parado)
- Ticket = onde se age

Dentro do ticket, a troca é ação de supervisão — não cabe no Hub Juiz, nem no do MP, nem no do Advogado. Coloque num acesso próprio (botão/entrada "Supervisão") visível só para Staff, Desembargador e Procurador. Quem não tem esses cargos não deve nem ver que o botão existe.

### Regras (mantidas da spec anterior)

- Disponível em qualquer fase do ticket, enquanto ele não estiver encerrado/arquivado.
- Seleção manual por @menção, igual ao processo faz hoje.
- Validação no fluxo compartilhado: o substituto tem o cargo, é diferente do atual, e existe candidato válido. Corrige de passagem o furo do processo.
- Motivo obrigatório, log no canal de auditoria com o tipo do ticket explícito.
- Acesso ao canal migra na hora; ações pendentes do antigo repontam pro novo.
- Ato praticado não se desfaz. Manifestação, decisão, despacho anterior permanecem nos autos.
- Prazos em curso reiniciam para o substituto (incluindo as 24h da manifestação do MP).
- Andamento narrativo no histórico: data/hora, quem trocou, quem saiu, quem entrou, motivo.
- Ticket encerrado → botão não aparece.
- Sem substituto disponível → erro claro, estado inalterado.

## PARTE 3 — Responsável que saiu do servidor ou perdeu o cargo

### O problema, com caso real

Quando alguém sai do Discord, perde os cargos — mas continua marcado como responsável nos tickets. Caso concreto em produção agora: o processo `002AP` tem uma juíza marcada que não está mais no servidor e não consta mais com o cargo. O ticket está órfão e ninguém pode agir nele.

Solução: duas camadas. As duas são necessárias.

### Camada 1 — Evento (reação imediata)

Escutar os eventos do Discord:
- `guildMemberRemove` → a pessoa saiu do servidor
- `guildMemberUpdate` → a pessoa perdeu o cargo relevante mas continua no servidor

Ao disparar, verificar se essa pessoa é responsável por algum ticket aberto e reatribuir.

### Camada 2 — Varredura periódica (correção)

Esta é a parte que não pode faltar. Evento sozinho não resolve nada do que já está quebrado: se o bot estava offline quando a pessoa saiu, ou se ela saiu antes desta feature existir (o caso do `002AP`), nenhum evento vai chegar.

Aproveitando o job diário que já existe: percorrer todos os tickets abertos e, para cada responsável marcado, verificar se ele:
1. ainda está no servidor, e
2. ainda tem o cargo correspondente.

Se falhar qualquer um dos dois → reatribuir.

No primeiro run, reporte quantos tickets tinham responsável fantasma. Quero esse número — ele diz há quanto tempo o problema existe.

### O que acontece na reatribuição

- Re-sorteio automático entre quem tem o cargo, excluindo quem saiu e quem já atua no ticket.
- Andamento nos autos, no padrão narrativo: "O(a) Juiz(a) [nome] deixou de integrar o quadro; redistribuídos os autos a [novo nome]."
- Log de auditoria com motivo automático (`responsável ausente do servidor` / `responsável sem o cargo`) — reatribuição automática nunca acontece em silêncio.
- Aviso no canal do ticket e para o novo responsável.
- Prazos reiniciam, como na troca manual.

### Cobertura

Juiz, promotor, delegado — e advogado habilitado. Se o advogado de defesa sai do servidor, o réu fica sem defesa, o que contraria a regra já estabelecida (ninguém é julgado sem advogado): nesse caso, sorteia defensor dativo, mesmo mecanismo dos 24h sem atuação.

### Decisões já tomadas (não reabrir)

- Sem período de carência. Sair do servidor é ato deliberado; reatribui na hora.
- Se a pessoa voltar ao servidor depois, não desfaz. Ato praticado não se desfaz. Se ela deve voltar ao caso, é troca manual (Parte 2).
- Sem substituto disponível (nenhum outro com o cargo): não trava, não deixa o fantasma. Marca o ticket como pendência no painel do Desembargador/Procurador e avisa. O ticket fica explicitamente "sem responsável", não falsamente atribuído.
- Tickets encerrados/arquivados: não mexe. Responsável histórico é registro, não atribuição ativa.

## Testes

### Parte 2

- Trocar juiz, promotor e delegado em: processo penal, processo civil, medida, petição administrativa, apelação, reconsideração — pelo ticket e pelo painel, com o mesmo resultado.
- Cada papel só é trocável por quem tem o cargo certo; Desembargador não troca promotor e vice-versa; Staff troca tudo.
- Quem não é Staff/Des/Proc não vê o acesso de supervisão no ticket.
- Substituto sem o cargo → rejeitado (vale também no processo).
- Substituto igual ao atual → rejeitado.
- Sem motivo → rejeitado.
- Ticket encerrado → botão ausente.
- Troca de promotor reinicia as 24h; manifestação anterior permanece nos autos.
- Um tipo de ticket novo/fictício com responsável: a troca funciona sem ninguém ter cadastrado esse tipo. (É o teste que prova que não virou `switch`.)

### Parte 3

- Juiz sai do servidor → evento dispara → novo juiz sorteado, andamento, log, aviso.
- Juiz perde só o cargo (continua no servidor) → mesmo tratamento.
- Bot offline quando a pessoa sai → a varredura seguinte corrige.
- Ticket com fantasma pré-existente (simular o `002AP`) → a primeira varredura conserta.
- Advogado habilitado sai → defensor dativo sorteado, réu nunca fica sem defesa.
- Nenhum substituto com o cargo → ticket marcado como pendência, não trava, não mantém o fantasma.
- Ticket arquivado com responsável ausente → intocado.
- Pessoa sai e volta → não desfaz a reatribuição.

## Verificações antes de codar

1. O bot tem o intent `GuildMembers` ligado? (já verificado: sim)
2. Onde ficam os IDs de cargo hoje (`ROLE_JUIZ_ID` etc.) e se estão todos preenchidos em produção — a varredura depende deles pra saber "tem o cargo".
3. O job diário existente: onde engancha a varredura sem criar cron novo.
4. Quais tipos de ticket hoje persistem responsável, e com que nome de campo — pra confirmar que o resolvedor genérico cobre todos.

## Ordem sugerida

Parte 3 primeiro. Ela conserta um bug ativo em produção (`002AP` e possivelmente outros). A Parte 2 é melhoria de ergonomia — importante, mas ninguém está travado por falta dela.

## PARTE 4 — Aplicar tudo isso aos tickets que já existem

Nada disso pode valer só para o que nascer depois do deploy. Os processos, medidas e petições já abertos precisam receber essas funções.

### O que é retroativo sem esforço

Parte 2 (troca) e Parte 3 (fantasma) são retroativas por natureza. São ações e reparos, não máquina de estados — elas operam sobre o ticket como ele está. Não precisa migração, backfill nem campo novo:
- O botão de supervisão aparece em todo ticket aberto, inclusive os antigos.
- A varredura da Parte 3 percorre todos os tickets abertos e conserta os fantasmas existentes — é justamente assim que o `002AP` se resolve.

Confirme que nenhum caminho depende de campo criado depois do deploy. Se o código fizer `if (ticket.campoNovo)` e o ticket antigo não tiver o campo, ele fica de fora silenciosamente — que é exatamente o erro a evitar aqui.

### O que exige decisão: a trava da manifestação do MP

Na Parte 1 ficou combinado que a trava das 24h só vale se `sorteioPromotorEm` existir — ou seja, petições já abertas não travam. Isso foi para não congelar fila existente.

Decidido: opção A — backfill na subida. Numa rotina de migração de uso único, gravar `sorteioPromotorEm = momento do deploy` em toda petição aberta que ainda não tenha o campo. Efeito: as antigas passam a exigir manifestação, com as 24h contando do deploy — ninguém trava retroativamente, todo mundo ganha a janela cheia a partir de agora.

Não faça o caminho ingênuo (ligar a trava sem backfill, contando de uma data que não existe): petição antiga sem `sorteioPromotorEm` cairia em cálculo indefinido.

### Relatório obrigatório

Ao subir, reporte:
- quantos tickets abertos existem, por tipo;
- quantos tinham responsável fantasma (e quais);
- quantas petições receberam backfill.

Sem esse número não dá pra saber se a retroatividade realmente pegou tudo ou se metade ficou de fora por causa de um campo ausente.
