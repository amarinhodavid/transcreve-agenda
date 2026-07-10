'use strict';

/**
 * Núcleo puro da transcrição: dedupe de legendas + formatação de export.
 *
 * NÃO depende de `chrome.*` nem do DOM de propósito — assim roda no Node
 * (test/driver.js) e é reaproveitado pelo content script, pelo service worker
 * e pelo popup sem duplicar lógica.
 *
 * Carregado como script clássico (content script / popup) OU via require/
 * importScripts. O wrapper abaixo publica a API em `globalThis.TranscriptCore`
 * e também em `module.exports`.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.TranscriptCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '0.3.1';
  const COLLAPSE_WHITESPACE = /\s+/g;
  const MAX_HISTORY = 10;
  // Janela para colapsar parciais consecutivos do mesmo autor na exportação.
  const COLLAPSE_WINDOW_MS = 15000;
  // Nº de chars normalizados iguais no início que já indicam a MESMA fala em revisão.
  const REVISION_PREFIX_CHARS = 20;

  /**
   * Padrões de legenda que o Teams injeta e NÃO são fala de ninguém — ruído a
   * descartar. Centralizados e comentados para manutenção fácil. Conservador de
   * propósito: só casam avisos de sistema bem específicos em PT-BR.
   */
  const SYSTEM_CAPTION_PATTERNS = [
    // Aviso de idioma: "As legendas serão mostradas em Português (Brasil)".
    /^as legendas ser[aã]o/i,
    // Aviso de ativação: "As legendas ao vivo estão ativadas/ligadas".
    /^as legendas ao vivo/i,
    // Rótulo do painel exibido isolado: "Legendas ao vivo".
    /^legendas ao vivo\b/i,
  ];

  // Lista de participantes que o Teams mostra como "FULANO, BELTRANO, +2":
  // apenas nomes em CAIXA ALTA separados por vírgula, terminando em "+N".
  const PARTICIPANT_LIST = /^\p{Lu}[\p{Lu}\s.'-]*(?:,\s*\p{Lu}[\p{Lu}\s.'-]*)*$/u;

  function normalize(text) {
    if (text == null) return '';
    return String(text).replace(COLLAPSE_WHITESPACE, ' ').trim();
  }

  /**
   * Normaliza para COMPARAÇÃO de parciais: minúsculas, sem pontuação e espaços
   * colapsados. O Teams insere vírgula/ponto retroativos ("Alteradas" vira
   * "Alteradas,") — então a comparação de crescimento tem de ignorar pontuação,
   * senão cada revisão parece uma fala nova.
   */
  function normalizeForCompare(text) {
    return normalize(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N} ]/gu, '') // tira pontuação, preserva letras acentuadas
      .replace(COLLAPSE_WHITESPACE, ' ')
      .trim();
  }

  function normalizeSpeaker(name) {
    return normalize(name) || 'Desconhecido';
  }

  function isUnknownSpeaker(name) {
    const s = normalize(name);
    return !s || s === 'Desconhecido';
  }

  // "FULANO, BELTRANO, +2" → só nomes em caixa alta + "+N" no fim.
  function isParticipantList(text) {
    const s = normalize(text);
    if (!/\+\d+$/.test(s)) return false; // exige o "+N" no final
    const body = s.replace(/,?\s*\+\d+$/, '').trim();
    return !!body && PARTICIPANT_LIST.test(body);
  }

  /**
   * Diz se uma legenda é ruído de sistema do Teams (aviso de idioma, rótulo do
   * painel, lista de participantes) — não fala de gente. Casa contra os padrões
   * centralizados acima. Conservador: texto normal devolve false.
   */
  function isSystemCaption(text) {
    const t = normalize(text);
    if (!t) return true;
    for (const re of SYSTEM_CAPTION_PATTERNS) {
      if (re.test(t)) return true;
    }
    return isParticipantList(t);
  }

  /**
   * Cria o estado de captura de uma sessão.
   * - pending: fala EM ANDAMENTO por autor (chave estável mri/nome), ainda crescendo.
   * - committed: falas finalizadas, na ordem em que foram comitadas.
   * - committedKeys: conteúdo (autor+texto final) já comitado, para nunca duplicar
   *   mesmo quando a lista virtual do Teams re-renderiza um item antigo.
   */
  function createStore() {
    return {
      pending: new Map(),
      committed: [],
      committedKeys: new Set(),
    };
  }

  function timestampOf(value) {
    return typeof value === 'number' ? value : Date.now();
  }

  // Chave estável da fala: o `data-person-mri` do Teams v2 (id da pessoa) quando
  // existe; senão o nome textual. NÃO é identidade de nó — a lista virtual recicla
  // nós, então dedupe por nó perde falas novas em nós reaproveitados.
  function speechKey(mri, speaker) {
    const m = normalize(mri);
    if (m) return 'mri:' + m;
    return 'name:' + normalizeSpeaker(speaker);
  }

  // Chave de conteúdo (autor + texto NORMALIZADO p/ comparação). Usa a forma sem
  // pontuação para que "Bom dia" e "Bom dia," não sejam falas diferentes quando a
  // lista virtual re-renderiza um item já comitado com pontuação retroativa.
  function contentKey(key, text) {
    return key + '\n' + normalizeForCompare(text);
  }

  function commonPrefixLen(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return i;
  }

  /**
   * A nova legenda é a MESMA fala em progresso (crescimento OU revisão retroativa)
   * da pendente? Compara pela forma NORMALIZADA (sem pontuação), tolerante a:
   *   - crescimento: normalizado(anterior) é prefixo do normalizado(novo);
   *   - regressão de parcial: novo é prefixo do anterior (re-render mais curto);
   *   - revisão: os primeiros ~20 chars normalizados batem (o Teams reescreve o
   *     começo com vírgula/acento sem que seja fala nova).
   */
  function isContinuation(oldText, newText) {
    const a = normalizeForCompare(oldText);
    const b = normalizeForCompare(newText);
    if (!a || !b) return true;
    if (b.indexOf(a) === 0) return true; // novo estende o anterior
    if (a.indexOf(b) === 0) return true; // novo mais curto, mas início do anterior
    const shared = commonPrefixLen(a, b);
    if (shared >= Math.min(REVISION_PREFIX_CHARS, a.length, b.length)) return true;
    return shared >= Math.min(a.length, b.length) * 0.6;
  }

  /**
   * Fecha a fala pendente de um autor: move de `pending` para `committed` UMA vez.
   * Retorna a entrada comitada, ou null (autor sem pendente, já comitado, ou ruído
   * de sistema descartado). Usado pelo debounce/saída-do-DOM e internamente quando
   * uma fala nova do mesmo autor começa.
   */
  function commitPending(store, key) {
    const p = store.pending.get(key);
    if (!p) return null;
    store.pending.delete(key);

    const ck = contentKey(key, p.text);
    if (store.committedKeys.has(ck)) return null; // guarda contra re-render duplo
    store.committedKeys.add(ck);

    // Ruído de sistema do Teams (aviso de idioma, lista de participantes) só é
    // descartado quando NÃO há falante identificado — na dúvida, preserva.
    if (isUnknownSpeaker(p.speaker) && isSystemCaption(p.text)) return null;

    const entry = { ts: p.ts, falante: p.speaker, texto: p.text };
    store.committed.push(entry);
    return entry;
  }

  /**
   * Processa UMA legenda visível da lista de legendas. Dedupe por CONTEÚDO
   * (autor + texto), nunca por nó de DOM — a lista virtual do Teams recicla nós.
   *
   * Retorna a fala ANTERIOR do mesmo autor quando ela é fechada aqui (porque uma
   * fala nova do mesmo autor começou logo em seguida); senão null. A ÚLTIMA fala
   * de cada autor é fechada por content.js via commitPending (debounce/saída do DOM).
   */
  function observeItem(store, item) {
    const key = item && item.key;
    if (!key) return null;
    const text = normalize(item.text);
    if (!text) return null;

    let speaker = normalizeSpeaker(item.speaker);
    const pending = store.pending.get(key);

    if (pending) {
      if (isContinuation(pending.text, text)) {
        // Mesma fala: mantém o melhor nome já visto e o texto mais completo,
        // preservando o ts da PRIMEIRA aparição (quando a fala começou).
        if (speaker === 'Desconhecido' && pending.speaker !== 'Desconhecido') {
          speaker = pending.speaker;
        }
        const bestText = text.length >= pending.text.length ? text : pending.text;
        store.pending.set(key, { speaker, text: bestText, ts: pending.ts });
        return null;
      }
      // Fala nova do MESMO autor: fecha a anterior e abre a nova.
      const closed = commitPending(store, key);
      store.pending.set(key, { speaker, text, ts: timestampOf(item.ts) });
      return closed;
    }

    // Sem pendente: ignora re-render de uma fala que já foi comitada.
    if (store.committedKeys.has(contentKey(key, text))) return null;
    store.pending.set(key, { speaker, text, ts: timestampOf(item.ts) });
    return null;
  }

  function getEntries(store) {
    return store.committed.slice();
  }

  /**
   * Safety net de exportação: colapsa entradas CONSECUTIVAS do mesmo autor onde
   * uma é prefixo normalizado da outra dentro de uma janela curta (parciais da
   * mesma escadinha que escaparam e viraram falas separadas). Mantém a versão
   * mais completa e o timestamp mais antigo. Conserta inclusive sessões gravadas
   * antes deste fix, na hora de exportar. Puro: recebe/retorna array.
   */
  function collapseEntries(entries, windowMs) {
    const win = typeof windowMs === 'number' ? windowMs : COLLAPSE_WINDOW_MS;
    const out = [];
    for (const e of Array.isArray(entries) ? entries : []) {
      const prev = out[out.length - 1];
      if (prev && prev.falante === e.falante && Math.abs(e.ts - prev.ts) <= win) {
        const a = normalizeForCompare(prev.texto);
        const b = normalizeForCompare(e.texto);
        if (a && b && (b.indexOf(a) === 0 || a.indexOf(b) === 0)) {
          // Mesma fala em progresso: fica com a mais completa; ts mais antigo (o
          // de prev, pois a lista está em ordem cronológica).
          if (b.length >= a.length) prev.texto = e.texto;
          continue;
        }
      }
      out.push({ ts: e.ts, falante: e.falante, texto: e.texto });
    }
    return out;
  }

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function formatTimestamp(ts) {
    const date = ts instanceof Date ? ts : new Date(ts);
    return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
  }

  function sessionTitle(session) {
    return (session && session.title) || 'Reunião do Teams';
  }

  function sessionStart(session) {
    if (session && session.startedAt) {
      const d = new Date(session.startedAt);
      if (!Number.isNaN(d.getTime())) return d;
    }
    return null;
  }

  function sessionEnd(session) {
    if (session && session.endedAt) {
      const d = new Date(session.endedAt);
      if (!Number.isNaN(d.getTime())) return d;
    }
    return null;
  }

  function toPlainText(session, rawEntries) {
    const entries = collapseEntries(rawEntries);
    const started = sessionStart(session);
    const header = [
      'Transcrição — ' + sessionTitle(session),
      'Início: ' + (started ? started.toLocaleString('pt-BR') : '—'),
      'Falas: ' + entries.length,
      '========================================',
      '',
    ];
    const body = entries.map(function (e) {
      return '[' + formatTimestamp(e.ts) + '] ' + e.falante + ': ' + e.texto;
    });
    return header.concat(body).join('\n') + '\n';
  }

  function toMarkdown(session, rawEntries) {
    const entries = collapseEntries(rawEntries);
    const started = sessionStart(session);
    const out = [
      '# Transcrição — ' + sessionTitle(session),
      '',
    ];
    if (started) out.push('- **Início:** ' + started.toLocaleString('pt-BR'));
    out.push('- **Falas:** ' + entries.length);
    out.push('- **Gerado por:** Transcreve Agenda');
    out.push('');
    out.push('---');
    out.push('');
    for (const e of entries) {
      out.push('**[' + formatTimestamp(e.ts) + '] ' + e.falante + ':** ' + e.texto);
      out.push('');
    }
    return out.join('\n');
  }

  function toJSON(session, rawEntries) {
    const entries = collapseEntries(rawEntries);
    const started = sessionStart(session);
    return JSON.stringify({
      app: 'transcreve-agenda',
      versao: VERSION,
      sessao: {
        titulo: sessionTitle(session),
        inicio: started ? started.toISOString() : null,
        falas: entries.length,
      },
      transcricao: entries.map(function (e) {
        return {
          ts: new Date(e.ts).toISOString(),
          hora: formatTimestamp(e.ts),
          falante: e.falante,
          texto: e.texto,
        };
      }),
    }, null, 2);
  }

  function buildFilename(ext, when) {
    const d = when ? new Date(when) : new Date();
    return 'teams-transcricao-' +
      d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      '-' + pad2(d.getHours()) + pad2(d.getMinutes()) + '.' + ext;
  }

  /**
   * Markdown do salvamento automático em disco: cabeçalho com título, data e
   * hora de início/fim + nº de falas; corpo com uma fala por linha. Datas no
   * fuso local do sistema (o chamador passa `new Date()` local).
   */
  function toMeetingMarkdown(session, rawEntries) {
    const entries = collapseEntries(rawEntries);
    const started = sessionStart(session);
    const ended = sessionEnd(session);
    const out = [
      '# Transcrição — ' + sessionTitle(session),
      '',
      '- **Data:** ' + (started ? started.toLocaleDateString('pt-BR') : '—'),
      '- **Início:** ' + (started ? formatTimestamp(started) : '—'),
      '- **Fim:** ' + (ended ? formatTimestamp(ended) : '—'),
      '- **Falas:** ' + entries.length,
      '',
      '---',
      '',
    ];
    for (const e of entries) {
      out.push('**[' + formatTimestamp(e.ts) + '] ' + e.falante + ':** ' + e.texto);
    }
    return out.join('\n') + '\n';
  }

  /**
   * Limpa um título de reunião para virar nome de arquivo válido no Windows:
   * remove os caracteres proibidos (< > : " / \ | ? * e controles), colapsa
   * espaços em hífen, apara pontas e limita ~60 chars. Acentos são preservados
   * (válidos no Windows). Vazio/só-inválido → "reuniao".
   */
  function sanitizeFilePart(name) {
    let s = String(name == null ? '' : name);
    s = s.replace(/[<>:"/\\|?*\x00-\x1f -]/g, ' '); // proibidos do Windows
    s = s.replace(COLLAPSE_WHITESPACE, ' ').trim();
    s = s.replace(/ /g, '-');
    s = s.replace(/^[.\-]+|[.\-]+$/g, ''); // Windows não aceita ponto/hífen nas pontas
    if (s.length > 60) s = s.slice(0, 60).replace(/[.\-]+$/, '');
    return s || 'reuniao';
  }

  // Caminho relativo dentro de Downloads: "Transcricoes Teams/AAAA-MM-DD-HHMM-<titulo>.md".
  // O chrome.downloads cria a subpasta sozinho.
  function buildAutoSaveFilename(session, when) {
    const d = when ? new Date(when) : (sessionStart(session) || new Date());
    const stamp = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      '-' + pad2(d.getHours()) + pad2(d.getMinutes());
    return 'Transcricoes Teams/' + stamp + '-' + sanitizeFilePart(session && session.title) + '.md';
  }

  /**
   * Anexa uma sessão finalizada ao histórico, mantendo só as `maxKept` mais
   * recentes (padrão 10). Puro: recebe/retorna array, não toca em storage nem
   * relógio — o registro já chega pronto de quem chama. Assim é testável no Node.
   */
  function pushSession(history, record, maxKept) {
    const list = Array.isArray(history) ? history.slice() : [];
    if (!record) return list;
    list.push(record);
    const max = typeof maxKept === 'number' && maxKept > 0 ? maxKept : MAX_HISTORY;
    return list.length > max ? list.slice(list.length - max) : list;
  }

  return {
    VERSION,
    MAX_HISTORY,
    normalize,
    normalizeForCompare,
    createStore,
    speechKey,
    observeItem,
    commitPending,
    isContinuation,
    isSystemCaption,
    getEntries,
    collapseEntries,
    formatTimestamp,
    toPlainText,
    toMarkdown,
    toMeetingMarkdown,
    toJSON,
    buildFilename,
    sanitizeFilePart,
    buildAutoSaveFilename,
    pushSession,
  };
});
