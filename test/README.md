# Testes — Transcreve Agenda

Dois harness provam a captura + dedupe sem precisar de reunião real.

## 1. `driver.js` — teste do núcleo (Node)

Prova três coisas, tudo sem DOM (roda no Node puro):

- **Dedupe:** N atualizações parciais da mesma fala viram 1 entrada final (nunca
  duplica os parciais), com falante e timestamp certos.
- **Histórico de sessões:** uma sessão finalizada entra no histórico e a lista
  trunca nas 10 mais recentes (`TranscriptCore.pushSession`).
- **Parse de falante em caixa alta:** `DomAdapter.splitUppercaseName` separa
  "NOME EM MAIÚSCULAS" da fala (o caminho usado no Teams v2 e na heurística).

```bash
node test/driver.js
```

Esperado: 3 falas finais e `TODOS OS TESTES PASSARAM`, com exit code 0.

## 2. `mock-teams.html` — harness visual (navegador)

Reproduz o DOM de legendas do Teams (com os mesmos `data-tid` que a extensão
procura) e simula, via `setInterval`, o Teams reescrevendo cada linha de
parcial → final e depois removendo o bloco. Roda os arquivos **de verdade** da
extensão (`transcript-core.js` + `dom-adapter.js`), sem modificação.

Como abrir:

1. Dê duplo clique em `test/mock-teams.html` (ou arraste para o navegador).
2. Abra o console (F12) para ver o log.

O que observar:

- Coluna esquerda: as legendas "vivas" mudando (parcial → final) e sumindo.
- Coluna direita: a transcrição capturada — deve ter **exatamente 3 linhas**
  finais, uma por falante, com o texto completo (nenhum parcial intermediário
  vira linha).
- Bloco de asserções embaixo: todos em `[PASS]` e
  `TODOS OS TESTES PASSARAM (3 falas, 0 duplicatas)`.

Se aparecer mais de 3 linhas ou textos cortados, a lógica de dedupe regrediu.

### Verificação Teams v2 (mesmo arquivo)

A seção de largura total no rodapé do `mock-teams.html` monta um DOM no formato
**Teams v2** (`closed-caption-v2-window-wrapper` + `closed-caption-v2-virtual-list-content`,
com `data-tid="author"` e o texto num `span` irmão) e prova que a **nova cadeia
de seletores casa**: `findCaptions` acha o container por seletor (não pela
heurística) e `extractCaptionItems` separa falante e fala das 3 legendas. Todos
os itens devem sair `[PASS]` e `CADEIA TEAMS V2 OK`.
