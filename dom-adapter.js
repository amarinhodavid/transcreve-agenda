'use strict';

/**
 * Camada de leitura do DOM do Teams. É o ponto MAIS frágil da extensão: o Teams
 * web reescreve o DOM com frequência, então todo seletor vive aqui, centralizado,
 * com cadeia de fallback. Se o Teams mudar a marcação, ajuste só o objeto
 * SELECTORS — o resto da extensão não muda.
 *
 * Só toca no DOM (nada de `chrome.*`), então é reaproveitado tanto pelo content
 * script quanto pelo harness de teste (test/mock-teams.html).
 *
 * AVISO: a estrutura exata do DOM do Teams NÃO é contrato público. Os seletores
 * abaixo são best-effort, do mais específico (data-tid) ao mais genérico. Trate
 * como algo que pode precisar de manutenção, não como verdade absoluta.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.DomAdapter = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * Seletores do Google Meet, levantados do DOM real em 02/10/2026
   * (meet.google.com, interface em pt-BR).
   *
   * O Meet é mais previsível que o Teams num ponto: o painel de legendas tem
   * `role="region"` com `aria-label` legível, que é contrato de acessibilidade e
   * muda menos que classe. As classes (`.a4cQT`, `.iOzk7`) são geradas por build
   * e entram só como último fallback.
   *
   * Diferença estrutural que importa: no Meet o nome do falante vem COLADO ao
   * texto no mesmo bloco ("VocêSome test."), sem elemento dedicado. Quem resolve
   * isso é o `splitUppercaseName` do core, já usado no Teams pelo mesmo motivo.
   */
  const MEET_SELECTORS = {
    captionsContainer: [
      '[role="region"][aria-label="Legendas"]',
      '[role="region"][aria-label="Captions"]',
      '[role="region"][aria-label*="egenda" i]',
      '[role="region"][aria-label*="aption" i]',
      '[jsname="dsyhDe"]',
      '.vNKgIf',
    ],
    captionItem: [
      '.a4cQT',
      '[jsname="dsyhDe"] > div > div',
      '.iOzk7 > div > div',
    ],
    captionText: [
      // No Meet não há elemento dedicado ao texto: o bloco traz nome + fala
      // juntos, e o core separa. A lista fica vazia de propósito para o
      // extractCaptionItems cair no caminho de texto do próprio nó.
    ],
    captionAuthor: [
      '.zs7s8d',
      '[class*="author" i]',
    ],
  };

  // UI de chamada do Meet. Todos por aria-label, que o Google mantém estável por
  // ser contrato com leitor de tela; os botões não têm data-tid nem id previsível.
  const MEET_CALL_UI = [
    '[aria-label*="Sair da chamada" i]',
    '[aria-label*="Leave call" i]',
    '[aria-label*="Desativar microfone" i]',
    '[aria-label*="Turn off microphone" i]',
    '[aria-label*="Ativar microfone" i]',
    '[aria-label*="Turn on microphone" i]',
    '[aria-label*="Controles de chamada" i]',
    '[aria-label*="Call controls" i]',
    '[jsname="vNB5le"]',
  ];

  // Em qual plataforma este documento está. Decide qual conjunto de seletores
  // vale, em vez de misturar os dois numa cadeia só: seletor genérico de uma
  // plataforma pode casar na outra e produzir falso positivo (um `[class*="author"]`
  // do Meet casaria em qualquer coisa do Teams com "author" na classe).
  function plataformaDe(doc) {
    const target = doc || (typeof document !== 'undefined' ? document : null);
    let host = '';
    try {
      host = (target && target.location && target.location.hostname) ||
        (typeof location !== 'undefined' ? location.hostname : '');
    } catch (_semLocation) {
      host = '';
    }
    return /(^|\.)meet\.google\.com$/i.test(host) ? 'meet' : 'teams';
  }

  const TEAMS_SELECTORS = {
    // Container ESTÁVEL que embrulha as legendas ao vivo. O 1º
    // (`closed-caption-renderer-wrapper`) é o ancestral confirmado no Teams v2
    // (teams.microsoft.com/v2) — tem aria-label="Legendas ao Vivo" e NÃO é
    // reciclado. É nele que o observer deve ancorar; JAMAIS num nó interno da
    // lista virtual (`closed-caption-v2-virtual-list-content`), cujos filhos são
    // destruídos/reaproveitados conforme rolam. Os demais são fallback p/ outros tenants.
    captionsContainer: [
      '[data-tid="closed-caption-renderer-wrapper"]',
      '[data-tid="closed-caption-v2-window-wrapper"]',
      '[data-tid="closed-caption-v2-window"]',
      '[data-tid="closed-caption-v2-virtual-list-content"]',
      '[data-tid="closed-captions-renderer"]',
      '[data-tid^="closed-caption"]',
      '[class*="captions-renderer"]',
      '[class*="ClosedCaptionsWrapper"]',
      '[class*="closedCaption"]',
      '[aria-label="Legendas ao vivo"]',
      '[aria-label*="egendas"]',
      '[aria-label*="aptions"]',
    ],
    // Cada bloco de legenda (uma fala). No Teams v2 confirmado é o
    // `.fui-ChatMessageCompact` (avatar com data-person-mri + author + texto).
    captionItem: [
      '.fui-ChatMessageCompact',
      '[data-tid="closed-caption-message"]',
      '[data-tid="closed-caption-v2-virtual-list-content"] > div',
      '[class*="captions-renderer"] > div',
      '.ui-chat__item',
      '[class*="captionMessage"]',
      '[class*="ccMessage"]',
      'li',
    ],
    // O texto falado dentro do bloco.
    captionText: [
      '[data-tid="closed-caption-text"]',
      '[data-tid="closed-caption-v2-text"]',
      '.ui-chat__message__content',
      '[class*="captionText"]',
      '[class*="captionContent"]',
    ],
    // O nome de quem fala.
    captionAuthor: [
      '[data-tid="author"]',
      '.ui-chat__item__author',
      '[class*="authorName"]',
      '[class*="author"]',
    ],
  };

  // Seletores da plataforma deste documento. `SELECTORS` continua apontando para
  // os do Teams para não quebrar quem já importa o nome (testes e diagnóstico);
  // o que o runtime usa é o resultado de selectorsDe().
  const SELECTORS = TEAMS_SELECTORS;

  function selectorsDe(doc) {
    return plataformaDe(doc) === 'meet' ? MEET_SELECTORS : TEAMS_SELECTORS;
  }

  // ID estável da pessoa no Teams v2: `data-person-mri="<guid>@..."`. Fica no
  // container do avatar (`closed-captions-v2-items-renderer`) dentro do item.
  // É a melhor chave de atribuição de falante — sobrevive à reciclagem de nós.
  // O Meet não tem equivalente por fala: o `data-participant-id` existe, mas
  // aponta o dispositivo do próprio usuário, não o autor de cada legenda. Lá a
  // chave cai no nome textual, que é o fallback do speechKey.
  const MRI_ATTR = 'data-person-mri';

  // Sinais de que estamos numa REUNIÃO AO VIVO (call ativa). O ciclo de vida da
  // sessão se amarra a ISTO, não ao painel de legendas (que some sozinho no meio
  // da reunião). Cadeia de fallback como a das legendas — do específico ao amplo.
  const CALL_UI = [
    // Botão de sair/desligar da chamada.
    '[data-tid="hangup-main-btn"]',
    '[data-tid="hangup-button"]',
    '[data-tid="call-hangup"]',
    // Barra/controles de chamada.
    '[data-tid="calling-toolbar"]',
    '[data-tid="call-controls"]',
    '[id="call-controls"]',
    // Palco/stage da reunião.
    '[data-tid="calling-stage"]',
    '[data-tid="meetup-stage"]',
    // Roster (lista de participantes).
    '[data-tid="roster-button"]',
    // Genéricos (fallback para variação de tenant).
    '[data-tid*="hangup" i]',
    '[data-tid*="call-controls" i]',
    // Domínio teams.cloud.microsoft (set/2026): a Microsoft reescreveu a UI de
    // chamada e NENHUM dos data-tid acima sobreviveu — o diagnóstico deu 11 de 11
    // com zero. Estes são mais largos de propósito: casam por prefixo/substring e
    // por rótulo de acessibilidade, que muda menos que nome interno de componente.
    '[data-tid*="leave" i]',
    '[data-tid*="end-call" i]',
    '[data-tid*="meeting-stage" i]',
    '[data-tid*="calling" i]',
    '[data-tid*="call-status" i]',
    '[data-tid*="toggle-mute" i]',
    '[data-tid*="microphone-button" i]',
    '[data-tid*="camera-button" i]',
    '[id*="hangup" i]',
    // Rótulos de acessibilidade — PT-BR e EN. Sobrevivem a troca de data-tid
    // porque o texto lido por leitor de tela é contrato com o usuário, não com o
    // código; o Teams o mantém mesmo quando reescreve a marcação por baixo.
    '[aria-label*="Sair" i][role="button"]',
    '[aria-label*="Desligar" i]',
    '[aria-label*="Encerrar reunião" i]',
    '[aria-label*="Hang up" i]',
    '[aria-label*="Leave call" i]',
    '[aria-label*="Leave meeting" i]',
  ];

  // Painel de legendas ao vivo = prova de que há reunião em curso. Legenda não
  // existe fora de chamada, então a presença do container é sinal de call tão
  // válido quanto o botão de desligar — e MUITO mais estável, porque a Microsoft
  // reescreve a barra de controles sem mexer no renderer de legenda (visto na
  // migração para teams.cloud.microsoft: os 11 seletores de call zeraram e os de
  // legenda continuaram casando todos).
  //
  // Só os data-tid ESPECÍFICOS entram aqui: o genérico `[data-tid^="closed-caption"]`
  // casa 50 elementos incluindo botão de menu e painel de configuração, que existem
  // fora da reunião e dariam call falso-positivo.
  const CAPTIONS_AS_CALL_PROOF = [
    '[data-tid="closed-caption-renderer-wrapper"]',
    '[data-tid="closed-caption-v2-window-wrapper"]',
    '[data-tid="closed-caption-v2-virtual-list-content"]',
    '[data-tid="closed-captions-renderer"]',
  ];

  /**
   * Estamos numa reunião ao vivo? true se qualquer sinal de UI de call casar, OU
   * se o painel de legendas estiver presente (legenda não existe fora de chamada).
   * Snapshot booleano — o content script trata a ausência como "fora da call" (se
   * já viu a UI antes) ou "indeterminado" (se nunca viu neste tenant).
   *
   * As duas provas são independentes de propósito: a da barra de controles corta
   * rápido quando o usuário desliga, a da legenda sobrevive a reescrita da UI. Em
   * set/2026 só a segunda funcionava no domínio novo.
   */
  function isInCall(doc) {
    const target = doc || (typeof document !== 'undefined' ? document : null);
    if (!target || typeof target.querySelector !== 'function') return false;
    const uiDaCall = plataformaDe(target) === 'meet' ? MEET_CALL_UI : CALL_UI;
    for (const sel of uiDaCall) {
      try {
        if (target.querySelector(sel)) return true;
      } catch (_selectorNotSupported) {
        // seletor não suportado neste engine: tenta o próximo
      }
    }
    const provaPorLegenda = plataformaDe(target) === 'meet'
      ? MEET_SELECTORS.captionsContainer.slice(0, 2)
      : CAPTIONS_AS_CALL_PROOF;
    for (const sel of provaPorLegenda) {
      try {
        if (target.querySelector(sel)) return true;
      } catch (_selectorNotSupported) {
        // idem
      }
    }
    return false;
  }

  // querySelector com fallback: percorre a lista e devolve o 1º que casar.
  // O catch existe porque um seletor pode ser inválido em algum engine —
  // nesse caso a resposta correta é cair pro próximo, não abortar.
  function queryFirst(scope, selectorList) {
    for (const selector of selectorList) {
      try {
        const el = scope.querySelector(selector);
        if (el) return el;
      } catch (_selectorNotSupported) {
        // seletor não suportado neste DOM: tenta o próximo fallback
      }
    }
    return null;
  }

  function queryAll(scope, selectorList) {
    for (const selector of selectorList) {
      try {
        const found = scope.querySelectorAll(selector);
        if (found && found.length) return Array.from(found);
      } catch (_selectorNotSupported) {
        // idem: tenta o próximo fallback
      }
    }
    return [];
  }

  /**
   * Heurística de ÚLTIMO recurso: quando nenhum seletor casa, procura um bloco
   * visível no terço inferior da viewport cujo texto tem "NOME EM MAIÚSCULAS".
   * Escolhe o menor (mais específico) para não pegar a página inteira.
   * Só roda no navegador (precisa de layout); no Node devolve null.
   */
  function findByHeuristic(scope) {
    if (typeof window === 'undefined') return null;
    const vh = window.innerHeight || 0;
    if (!vh) return null;
    let candidates;
    try {
      candidates = scope.querySelectorAll('div, section, ul, ol');
    } catch (_notQueryable) {
      return null;
    }
    let best = null;
    let bestArea = Infinity;
    for (const el of candidates) {
      let rect;
      try {
        rect = el.getBoundingClientRect();
      } catch (_noLayout) {
        continue;
      }
      if (!rect || !rect.height) continue;
      if (rect.top < vh * 0.55) continue; // fora do terço inferior
      if (rect.width < 120 || rect.height < 18) continue;
      const txt = (el.textContent || '').trim();
      if (txt.length < 3) continue;
      if (!/\p{Lu}{2,}/u.test(txt)) continue; // sem nome em caixa alta
      const area = rect.width * rect.height;
      if (area < bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  }

  /**
   * Localiza o container de legendas e diz por qual caminho:
   *   { mode: 'selector' }  — casou um seletor da cadeia (caso feliz);
   *   { mode: 'heuristic' } — só a heurística de rodapé achou (fallback frágil);
   *   { mode: null }        — nada encontrado.
   */
  function findCaptions(scope) {
    const target = scope || (typeof document !== 'undefined' ? document : null);
    if (!target) return { container: null, mode: null };
    const bySelector = queryFirst(target, selectorsDe(target).captionsContainer);
    if (bySelector) return { container: bySelector, mode: 'selector' };
    const heuristic = findByHeuristic(target);
    if (heuristic) return { container: heuristic, mode: 'heuristic' };
    return { container: null, mode: null };
  }

  function findCaptionsContainer(scope) {
    return findCaptions(scope).container;
  }

  function textOf(el) {
    return el && el.textContent ? el.textContent : '';
  }

  function authorFromAria(node) {
    if (!node || typeof node.getAttribute !== 'function') return '';
    const label = node.getAttribute('aria-label') || '';
    const match = label.match(/^(.+?)\s*(?:disse|said|:)\s*/i);
    return match ? match[1].trim() : '';
  }

  // Lê o data-person-mri do item: no próprio nó, num descendente, ou no ancestral
  // mais próximo (a marcação varia). '' quando não há (tenants sem o atributo).
  function personMri(node) {
    if (!node) return '';
    if (typeof node.getAttribute === 'function' && node.getAttribute(MRI_ATTR)) {
      return node.getAttribute(MRI_ATTR);
    }
    let el = null;
    try {
      el = node.querySelector ? node.querySelector('[' + MRI_ATTR + ']') : null;
    } catch (_notQueryable) {
      el = null;
    }
    if (!el && typeof node.closest === 'function') {
      try {
        el = node.closest('[' + MRI_ATTR + ']');
      } catch (_noClosest) {
        el = null;
      }
    }
    return el && el.getAttribute ? el.getAttribute(MRI_ATTR) || '' : '';
  }

  // Uma palavra é "nome em caixa alta" se tem 2+ letras, TODAS maiúsculas
  // (permitindo . ' -). "DE", "SILVA", "SOUZA" casam; "bom", "Vamos", "A" não.
  const UPPERCASE_WORD = /^\p{Lu}[\p{Lu}'.\-]+$/u;

  /**
   * Separa "NOME EM MAIÚSCULAS" + fala quando o Teams v2 empacota autor e texto
   * no mesmo nó sem elementos dedicados. Ex.: "ANA SOUZA bom dia a todos" →
   * { speaker: 'ANA SOUZA', text: 'bom dia a todos' }.
   *
   * Consome TODAS as palavras em caixa alta consecutivas do início (até 6 — nome
   * completo tipo "PATRICIA SILVA DE SOUZA"); a fala começa na 1ª palavra que não
   * é caixa alta pura. Sem prefixo maiúsculo, o texto inteiro é a fala. Se o texto
   * é SÓ nome (tudo em caixa alta, sem fala), devolve fala vazia — que o chamador
   * descarta, como as legendas de sistema.
   */
  function splitUppercaseName(fullText) {
    const s = String(fullText || '').replace(/\s+/g, ' ').trim();
    if (!s) return { speaker: '', text: '' };
    const tokens = s.split(' ');
    const nameParts = [];
    let i = 0;
    while (i < tokens.length && nameParts.length < 6 && UPPERCASE_WORD.test(tokens[i])) {
      nameParts.push(tokens[i]);
      i++;
    }
    if (!nameParts.length) return { speaker: '', text: s }; // sem nome em caixa alta
    const text = tokens.slice(i).join(' ').trim();
    if (!text) return { speaker: '', text: '' }; // só nome, sem fala → descartar
    return { speaker: nameParts.join(' '), text };
  }

  /**
   * Extrai { node, speaker, text } de cada legenda dentro do container.
   * `node` é a referência estável usada lá fora (WeakMap) para casar parciais da
   * mesma fala. Retorna [] quando ainda não há legenda visível.
   */
  function extractCaptionItems(container) {
    if (!container) return [];

    // A plataforma vem do documento que contém o container, não de `document`:
    // com all_frames, este código roda em iframe cujo `document` pode ser outro.
    const sel = selectorsDe(container.ownerDocument || null);

    let itemNodes = queryAll(container, sel.captionItem);
    if (!itemNodes.length) {
      // Sem "item" reconhecível: usa os próprios blocos de texto como âncora.
      itemNodes = queryAll(container, sel.captionText);
    }
    if (!itemNodes.length) {
      // Último recurso (container heurístico): trata cada filho direto como uma
      // legenda. Se nem filhos há, o próprio container vira o único item.
      const children = container.children ? Array.from(container.children) : [];
      itemNodes = children.length ? children : [container];
    }

    const results = [];
    for (const node of itemNodes) {
      const authorEl =
        queryFirst(node, sel.captionAuthor) ||
        (node.parentElement ? queryFirst(node.parentElement, sel.captionAuthor) : null);

      let speaker = authorEl ? textOf(authorEl) : '';
      if (!speaker) speaker = authorFromAria(node);

      const textEl = queryFirst(node, sel.captionText);
      let text;
      if (textEl) {
        text = textOf(textEl);
      } else {
        // Sem elemento de texto dedicado: usa o texto do nó, tirando o nome
        // do autor caso ele venha prefixado.
        const full = textOf(node);
        if (speaker && full.indexOf(speaker) === 0) {
          text = full.slice(speaker.length);
        } else if (!speaker) {
          // Nem autor dedicado nem prefixo conhecido: tenta o padrão v2/heurístico
          // "NOME EM MAIÚSCULAS + fala".
          const split = splitUppercaseName(full);
          speaker = split.speaker;
          text = split.text;
        } else {
          text = full;
        }
      }

      results.push({ node, mri: personMri(node), speaker: speaker.trim(), text: text.trim() });
    }
    return results;
  }

  /**
   * Varre um documento e devolve um retrato para o botão de diagnóstico:
   * quantos elementos casam cada seletor da cadeia, quais data-tid/classes
   * contêm "caption"/"transcript" e qual é o container de legendas mais provável.
   * `count: -1` sinaliza seletor inválido naquele engine.
   */
  function diagnoseDocument(doc) {
    const plataforma = plataformaDe(doc);
    const selDaPlataforma = selectorsDe(doc);
    const selectorCounts = {};
    for (const group of Object.keys(selDaPlataforma)) {
      selectorCounts[group] = selDaPlataforma[group].map(function (sel) {
        try {
          return { sel: sel, count: doc.querySelectorAll(sel).length };
        } catch (_selectorNotSupported) {
          return { sel: sel, count: -1 };
        }
      });
    }

    const tid = {};
    try {
      doc.querySelectorAll('[data-tid]').forEach(function (el) {
        const value = el.getAttribute('data-tid') || '';
        if (/caption|transcript/i.test(value)) tid[value] = (tid[value] || 0) + 1;
      });
    } catch (_noTid) {
      // documento sem querySelectorAll utilizável: segue sem essa seção
    }

    const classes = {};
    try {
      doc.querySelectorAll('[class]').forEach(function (el) {
        const cls = el.getAttribute('class') || '';
        if (!/caption|transcript/i.test(cls)) return;
        cls.split(/\s+/).forEach(function (c) {
          if (/caption|transcript/i.test(c)) classes[c] = (classes[c] || 0) + 1;
        });
      });
    } catch (_noClass) {
      // idem
    }

    const callUi = (plataformaDe(doc) === 'meet' ? MEET_CALL_UI : CALL_UI).map(function (sel) {
      try {
        return { sel: sel, count: doc.querySelectorAll(sel).length };
      } catch (_selectorNotSupported) {
        return { sel: sel, count: -1 };
      }
    });

    const found = findCaptions(doc);
    return {
      plataforma: plataforma,
      selectorCounts: selectorCounts,
      tid: tid,
      classes: classes,
      mode: found.mode,
      sampleEl: found.container,
      callUi: callUi,
      inCall: isInCall(doc),
    };
  }

  const CAPTIONS_MISSING_MESSAGE =
    '[Transcreve Agenda] Container de legendas não encontrado. ' +
    'Ative as legendas ao vivo no Teams: Mais ações (…) → Idioma e fala → ' +
    'Ativar legendas ao vivo. Se as legendas JÁ estão ligadas e mesmo assim ' +
    'este aviso aparece, o DOM do Teams mudou — atualize o objeto SELECTORS em ' +
    'dom-adapter.js.';

  function warnSelectorsMiss() {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(CAPTIONS_MISSING_MESSAGE);
    }
    return CAPTIONS_MISSING_MESSAGE;
  }

  return {
    SELECTORS,
    TEAMS_SELECTORS,
    MEET_SELECTORS,
    plataformaDe,
    selectorsDe,
    queryFirst,
    queryAll,
    findCaptions,
    findCaptionsContainer,
    extractCaptionItems,
    personMri,
    isInCall,
    splitUppercaseName,
    diagnoseDocument,
    warnSelectorsMiss,
    CAPTIONS_MISSING_MESSAGE,
  };
});
