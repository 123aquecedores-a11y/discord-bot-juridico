# A suíte de testes

```bash
npm run test:completo          # modo rápido — é o que o dia a dia usa
FULL_RENDER=1 npm run test:completo   # renderização integral
```

## FULL_RENDER=1 é obrigatório antes de deploy

O hook de `pre-push` já roda com a flag ligada, então **um push normal está coberto**. A flag existe
para quem rodar a suíte à mão antes de subir alguma coisa, e para o caso de alguém usar
`git push --no-verify`.

O que muda: `scripts/testes-emissao-peca.js` faz cinco emissões que renderizam PNG. No modo rápido,
**uma continua real** — a do item 7, que decodifica o QR com o `jsQR` de produção e é o teste de
ponta a ponta do selo. As outras quatro usam um gerador stubbado, porque nelas o PNG é subproduto:
o que se afirma é visibilidade, janela de entrega e guarda de duplicidade, não um pixel.

Com `FULL_RENDER=1` as cinco voltam a ser reais.

O arquivo tem um canário (`R1`) que **falha se o modo mentir** — se o switch quebrar e nenhuma
renderização real acontecer, o teste do selo deixaria de existir sem ninguém notar.

## Por que a suíte era lenta, e o que era de verdade

`testes-emissao-peca` levava **302 segundos**, quase metade da suíte inteira. O diagnóstico passou
por duas hipóteses erradas antes de fechar:

1. ~~"são seis renderizações, stub cinco"~~ — stubbar não mudou nada: continuou 302s.
2. ~~"é o timer de ociosidade do Chromium"~~ — ele já tinha `unref()`.

O que era: **o Puppeteer deixa o `ChildProcess` do Chromium e ~6 sockets abertos**, e o Node não
encerra enquanto houver handle vivo. Medido: `require` 117ms, renderização **2,3s**, e ~300s de
processo preso esperando para morrer.

A correção é `gerarDocumentoPNG.fecharBrowser()`, chamada no fim do teste. Vale igual para
scripts de linha de comando que gerem PNG (`conferir-selo`, `reset-tribunal`) — sem ela, eles
também ficam presos cinco minutos depois de terminar o trabalho.

| | antes | depois |
|---|---:|---:|
| `testes-emissao-peca` (rápido) | 302s | **4s** |
| `testes-emissao-peca` (FULL_RENDER=1) | 302s | **13s** |

## Se um teste voltar a ficar lento

Meça o arquivo isolado antes de supor:

```bash
time node scripts/o-teste.js
```

Se o tempo estiver no *fim* (o teste imprime o resumo e o processo não sai), é handle preso —
provavelmente Chromium sem `fecharBrowser()`. Para confirmar:

```js
console.log(process._getActiveHandles().map(h => h.constructor.name).join(','));
```

## Fim de linha

`.gitattributes` normaliza tudo para LF, inclusive no working tree. Isso existe porque teste que
varre código-fonte com regex de multilinha passava verde **antes** do commit e reprovava **depois**
— o git reescrevia o arquivo com CRLF no checkout. Se você escrever uma regex que cruza linhas,
use `\r?\n` mesmo assim: ela defende quem clonar com outra configuração.
