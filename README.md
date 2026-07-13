# Transcreve Agenda

Extensão de navegador (Chrome/Edge, Manifest V3) que transcreve reuniões do
Microsoft Teams **lendo as legendas ao vivo** que o Teams web já renderiza na
tela. Cada fala é capturada como `[HH:MM:SS] Falante: texto`, acumulada durante
a reunião e exportável em `.md`, `.txt` ou `.json`.

Nada de áudio é capturado e nada sai da sua máquina: a extensão só lê o texto das
legendas que já estão na página. Isso dá custo zero, identificação de quem fala
"de graça" (o Teams já mostra o nome) e transcrição em tempo real.

## Requisitos

- Teams usado no **navegador** (`teams.microsoft.com` ou `teams.live.com`).
- **Legendas ao vivo ligadas** na reunião (a extensão depende disso — veja abaixo).
- Chrome ou Edge com suporte a Manifest V3.

## Instalação (modo desenvolvedor / unpacked)

1. Abra `chrome://extensions` (ou `edge://extensions`).
2. Ligue o **Modo do desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** e selecione a pasta deste projeto
   (a que contém o `manifest.json`).
4. O ícone da extensão aparece na barra. Fixe-o para acesso rápido.

## Como ativar as legendas ao vivo no Teams

Sem legenda ligada, não há o que transcrever. Dentro da reunião:

1. Clique em **Mais ações** (o botão `…` na barra da reunião).
2. Vá em **Idioma e fala**.
3. Clique em **Ativar legendas ao vivo**.
4. Escolha o idioma falado (ex.: Português).

As legendas passam a aparecer na parte de baixo da tela — é delas que a extensão
lê.

## Modo automático (padrão)

Por padrão a extensão trabalha sozinha: **você não precisa habilitar nada**.
Assim que as legendas ao vivo aparecem na tela, a captura começa automaticamente.
O popup vira um visor — mostra o status, o contador de falas, a transcrição ao
vivo e os botões de exportar. O ícone da extensão ganha um selo **REC** enquanto
está capturando, então dá para saber que está gravando sem abrir o popup.

Quando a reunião acaba (o painel de legendas some por mais de 60 segundos ou você
fecha a aba), a sessão é finalizada, **salva automaticamente em disco** (veja
abaixo) e vai para o **histórico**. As últimas 10 sessões ficam listadas no
popup, prontas para exportar depois em `.md`, `.txt` ou `.json`.

Cada reunião vira **um arquivo separado**. Como o Teams web é um app de página
única (não recarrega ao trocar de reunião), a extensão identifica a reunião pela
URL (ou pelo título) e detecta a troca: ao entrar na reunião seguinte — mesmo em
poucos segundos — a anterior é finalizada e salva antes de a nova começar do
zero. Uma reunião nunca é anexada à outra no mesmo arquivo.

Se preferir o controle manual, desligue o **Modo automático** no popup: voltam os
botões **Iniciar captura** / **Parar** / **Limpar**.

## Salvamento automático ao fim da reunião

Assim que a sessão é finalizada — o painel de legendas some por mais de 60
segundos, você fecha a aba ou clica em **Parar** — a transcrição é gravada
sozinha em disco, sem nenhum diálogo. O arquivo cai em:

```
Downloads\Transcricoes Teams\AAAA-MM-DD-HHMM-<titulo-da-reuniao>.md
```

A subpasta **Transcricoes Teams** é criada sozinha dentro da sua pasta de
Downloads. O nome usa a data e a hora de início mais o título da reunião
(capturado da aba do Teams e limpo para virar um nome de arquivo válido no
Windows). Se duas reuniões terminarem no mesmo minuto, o Chrome adiciona um
sufixo numérico para não sobrescrever.

O `.md` traz um cabeçalho com título, data, hora de início e fim e número de
falas, seguido de uma fala por linha no formato `**[HH:MM:SS] Falante:** texto`.
Sessões sem nenhuma fala não geram arquivo.

O toggle **Salvar automaticamente ao fim da reunião** no popup liga/desliga esse
comportamento (vem **ligado** por padrão e a escolha fica salva). Mesmo com ele
desligado, você continua podendo exportar manualmente pelos botões `.md` /
`.txt` / `.json`.

## Como usar

1. Entre na reunião no navegador e ative as legendas ao vivo.
2. Abra o popup só para acompanhar — com o modo automático ligado, a captura já
   está rodando. (Com o modo automático desligado, clique em **Iniciar captura**.)
3. O status mostra se está capturando, se as legendas foram detectadas e quantas
   falas já entraram. A transcrição aparece ao vivo no popup.
4. Ao fim, exporte a sessão atual em **.md**, **.txt** ou **.json** — ou pegue uma
   sessão anterior na lista de histórico.
5. **Limpar transcrição** zera a sessão atual (o histórico é preservado).

O arquivo sai como `teams-transcricao-AAAA-MM-DD-HHMM.<ext>` na sua pasta de
downloads. A transcrição fica salva localmente (`chrome.storage.local`), então
sobrevive a fechar o popup ou recarregar a aba.

## Diagnóstico do DOM (quando não captura nada)

Se as legendas estão visíveis na tela mas a extensão não captura, o Teams
provavelmente mudou a marcação ou renderiza as legendas dentro de um iframe. O
botão **Diagnóstico do DOM** no popup resolve a dúvida sem chute:

1. Com a reunião aberta e as legendas ligadas, clique em **Diagnóstico do DOM**.
2. A extensão varre a página **e os iframes acessíveis** e monta um relatório:
   quantos elementos casam cada seletor, quais `data-tid`/classes contêm
   "caption"/"transcript", quantos iframes existem (e suas origens) e uma amostra
   do HTML do container de legendas mais provável.
3. O relatório é **copiado para a área de transferência** (e salvo em
   `chrome.storage.local`, chave `diagnostico`). O popup confirma:
   *"Diagnóstico copiado — cole no chat do Claude."*
4. Cole esse texto no chat. É ele que revela os seletores reais do seu Teams e
   permite o ajuste final da cadeia em `dom-adapter.js`.

Se o popup disser *"Content script não está rodando nesta aba"*, recarregue a
página do Teams (**F5**) e clique de novo.

## Atualizando a extensão

Depois de trocar os arquivos da extensão (ou puxar uma versão nova):

1. Abra `chrome://extensions` e clique no botão **recarregar** (⟳) do card da
   extensão — isso recarrega o service worker e os content scripts novos.
2. Volte para a aba da reunião e aperte **F5** para o content script atualizado
   ser injetado na página.
3. Só então o comportamento novo (modo automático, diagnóstico, seletores v2)
   passa a valer naquela aba.

## Como funciona (captura + dedupe)

O Teams **reescreve a mesma linha** de legenda enquanto a pessoa fala
(`"Oi"` → `"Oi pessoal"` → `"Oi pessoal, tudo bem?"`). Se gravássemos cada
estado, teríamos a fala repetida em pedaços. Para evitar isso:

- O dedupe é por **conteúdo**, não por nó de DOM: a chave da fala é o
  `data-person-mri` (o id da pessoa no Teams v2) ou, na falta dele, o nome do
  autor. Os parciais da mesma fala atualizam sempre a mesma entrada pendente.
- Quando a linha para de mudar por ~1,2s (debounce), some do DOM, **ou** uma fala
  nova do mesmo autor começa, a anterior é "comitada" **uma única vez** com o
  texto final. Um Set de conteúdo já comitado impede duplicar mesmo se a lista
  re-renderizar um item antigo.
- Os parciais intermediários nunca são gravados; nunca há duplicata.

Isso é essencial porque o painel de legendas do Teams v2 é uma **lista
virtualizada**: ela destrói e reaproveita os nós dos itens conforme rolam. Um
dedupe por identidade de nó perderia falas novas em nós reciclados (a captura
parava depois de ~15 s). O `MutationObserver` ancora sempre no wrapper **estável**
(`closed-caption-renderer-wrapper`), nunca num nó interno da lista, e um
**watchdog** reanexa o observer se ele morrer em silêncio (o texto muda mas
nenhuma mutação chega em 30 s).

## Estrutura

| Arquivo | Papel |
|---|---|
| `manifest.json` | Configuração MV3: permissões, hosts do Teams, service worker, content script, popup. |
| `transcript-core.js` | Núcleo puro: dedupe das legendas + formatação de export. Sem DOM, sem `chrome.*` (testável no Node). |
| `dom-adapter.js` | Todos os seletores do Teams, com cadeia de fallback, e a extração de falante/texto. Ponto mais frágil, centralizado aqui. |
| `content.js` | Cola o DOM ao núcleo e ao Chrome: `MutationObserver`, debounce, persistência. |
| `background.js` | Service worker: estado da sessão e exportação via `chrome.downloads`. |
| `popup.html/.css/.js` | Interface: iniciar/parar/limpar, status, transcrição ao vivo, exportação. |
| `icons/` | Ícones 16/48/128 e o gerador (`generate-icons.js`). |
| `test/` | `driver.js` (Node) e `mock-teams.html` (navegador) que provam captura + dedupe. |

## Limitações conhecidas

- **Depende de legenda ligada.** Sem legenda ao vivo no Teams, não há captura. O
  popup avisa quando as legendas não são detectadas.
- **O DOM do Teams muda.** A estrutura das legendas não é contrato público. Se um
  dia parar de capturar mesmo com legenda ligada, use o botão **Diagnóstico do
  DOM** (acima): ele mostra exatamente o que a página tem. O conserto é pontual —
  ajustar o objeto `SELECTORS` no topo de `dom-adapter.js` (ele já tenta vários
  fallbacks por `data-tid`, ARIA, classe, os `data-tid` do Teams v2 e, em último
  caso, uma heurística de rodapé sinalizada como "modo heurístico" no status).
- **Legendas em iframe.** O content script roda com `all_frames`, então captura
  também quando o Teams renderiza as legendas dentro de um iframe do próprio
  domínio. Um iframe de outra origem (cross-origin) ainda é inacessível — o
  diagnóstico aponta esse caso listando a origem do iframe.
- **Uma reunião por vez.** O MVP assume uma aba de reunião ativa.
- **Precisão vem do Teams.** A qualidade do texto é a da legenda automática do
  Teams; erros de reconhecimento dele passam para a transcrição.

## Roadmap — Fase 2

- **Fallback de áudio:** quando não houver legenda, capturar o áudio da aba
  (`chrome.tabCapture`) e transcrever (ex.: Whisper local), preservando o modelo
  "tudo local".
- **Resumo com IA:** o botão **Resumir no Claude (em breve)** é o gancho — enviar
  a transcrição para a API do Claude e devolver ata/pontos de ação/decisões.
- **Busca no histórico** de sessões (o histórico das últimas 10 já existe; falta
  a busca).

## Privacidade

Tudo local. A extensão não faz nenhuma chamada de rede: lê o texto das legendas,
guarda em `chrome.storage.local` e exporta como arquivo. Nenhum áudio, nenhum
envio para servidores.
