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

  const SELECTORS = {
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

  // ID estável da pessoa no Teams v2: `data-person-mri="<guid>@..."`. Fica no
  // container do avatar (`closed-captions-v2-items-renderer`) dentro do item.
  // É a melhor chave de atribuição de falante — sobrevive à reciclagem de nós.
  const MRI_ATTR = 'data-person-mri';

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
    const bySelector = queryFirst(target, SELECTORS.captionsContainer);
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

  /**
   * Separa "NOME EM MAIÚSCULAS" + fala quando o Teams v2 empacota autor e texto
   * no mesmo nó sem elementos dedicados. Ex.: "ANA SOUZA bom dia a todos" →
   * { speaker: 'ANA SOUZA', text: 'bom dia a todos' }. Sem prefixo maiúsculo,
   * devolve o texto inteiro como fala.
   */
  function splitUppercaseName(fullText) {
    const s = String(fullText || '').trim();
    const match = s.match(/^((?:\p{Lu}[\p{Lu}'.\-]+\s+){1,4})(\p{L}.*)$/u);
    if (!match) return { speaker: '', text: s };
    const speaker = match[1].trim();
    const text = match[2].trim();
    if (!text) return { speaker: '', text: s };
    return { speaker, text };
  }

  /**
   * Extrai { node, speaker, text } de cada legenda dentro do container.
   * `node` é a referência estável usada lá fora (WeakMap) para casar parciais da
   * mesma fala. Retorna [] quando ainda não há legenda visível.
   */
  function extractCaptionItems(container) {
    if (!container) return [];

    let itemNodes = queryAll(container, SELECTORS.captionItem);
    if (!itemNodes.length) {
      // Sem "item" reconhecível: usa os próprios blocos de texto como âncora.
      itemNodes = queryAll(container, SELECTORS.captionText);
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
        queryFirst(node, SELECTORS.captionAuthor) ||
        (node.parentElement ? queryFirst(node.parentElement, SELECTORS.captionAuthor) : null);

      let speaker = authorEl ? textOf(authorEl) : '';
      if (!speaker) speaker = authorFromAria(node);

      const textEl = queryFirst(node, SELECTORS.captionText);
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
    const selectorCounts = {};
    for (const group of Object.keys(SELECTORS)) {
      selectorCounts[group] = SELECTORS[group].map(function (sel) {
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

    const found = findCaptions(doc);
    return {
      selectorCounts: selectorCounts,
      tid: tid,
      classes: classes,
      mode: found.mode,
      sampleEl: found.container,
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
    queryFirst,
    queryAll,
    findCaptions,
    findCaptionsContainer,
    extractCaptionItems,
    personMri,
    splitUppercaseName,
    diagnoseDocument,
    warnSelectorsMiss,
    CAPTIONS_MISSING_MESSAGE,
  };
});
