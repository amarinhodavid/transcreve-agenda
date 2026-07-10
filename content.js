'use strict';

/**
 * Content script: liga o DOM do Teams (via DomAdapter) ao núcleo puro
 * (TranscriptCore) e à API do Chrome (storage/mensagens).
 *
 * Ordem de carga garantida pelo manifest:
 *   transcript-core.js -> dom-adapter.js -> content.js
 * então `TranscriptCore` e `DomAdapter` já existem aqui.
 *
 * Roda com `all_frames: true`: cada frame (topo e iframes do Teams) tem sua
 * própria instância e cuida SÓ do próprio documento. Só o frame que realmente
 * renderiza as legendas encontra o container e captura — os demais ficam
 * ociosos. O status é agregado no background para os frames não brigarem.
 */
(function () {
  'use strict';

  // Uma legenda é considerada FINAL após esse tempo sem mudar de texto.
  const COMMIT_DEBOUNCE_MS = 1200;
  // De quanto em quanto tempo procuramos o container (só surge com legenda ligada).
  const CONTAINER_POLL_MS = 2000;
  // Container sumido por mais que isso = reunião acabou → finaliza a sessão.
  const MEETING_GONE_MS = 60000;
  // Observando, o texto do painel mudou mas nenhuma mutation chegou nesse tempo =
  // observer morreu em silêncio (lista virtual reciclou o nó) → força relatch.
  const OBSERVER_STALE_MS = 30000;

  const ENTRIES_KEY = 'entries';
  const CAPSTATE_KEY = 'capState';
  const AUTOMODE_KEY = 'autoMode';

  const store = TranscriptCore.createStore();
  // Dedupe é por CONTEÚDO (mri/autor + texto), nunca por nó: a lista de legendas
  // do Teams v2 é virtualizada e recicla os nós dos itens.
  const commitTimers = new Map(); // chave da fala -> timeout do debounce
  let liveKeys = new Set(); // falas visíveis no último scan (por chave de autor)
  let committedEntries = []; // espelho em memória do que está no storage
  let observer = null;
  let pollTimer = null;
  let container = null; // wrapper ESTÁVEL das legendas (onde o observer ancora)
  let capturing = false; // observer ligado e comitando falas
  let autoMode = true; // captura sozinho ao detectar legenda
  let manualRequested = false; // usuário clicou Iniciar (modo manual)
  let detectionMode = 'selector'; // 'selector' | 'heuristic'
  let disappearAt = 0; // quando o container sumiu (para o corte de 60s)
  let warnedMiss = false;
  let lastStatusJson = '';
  let lastMutationAt = 0; // quando o observer disparou pela última vez (watchdog)
  let lastTextSnapshot = ''; // textContent do wrapper no último tick (watchdog)

  function sendToBackground(message) {
    const p = chrome.runtime.sendMessage(message);
    // Fire-and-forget: sem receptor o SW pode rejeitar; não é erro nosso.
    if (p && typeof p.catch === 'function') p.catch(function () {});
  }

  async function init() {
    const data = await chrome.storage.local.get([ENTRIES_KEY, CAPSTATE_KEY, AUTOMODE_KEY]);
    committedEntries = Array.isArray(data[ENTRIES_KEY]) ? data[ENTRIES_KEY] : [];
    autoMode = data[AUTOMODE_KEY] !== false; // padrão ON
    manualRequested = !!(data[CAPSTATE_KEY] && data[CAPSTATE_KEY].capturing);
    startEngine();
  }

  // Um único laço serve aos dois modos: procura o container e decide o que fazer.
  function startEngine() {
    if (!pollTimer) pollTimer = setInterval(tick, CONTAINER_POLL_MS);
    tick();
  }

  function tick() {
    const found = DomAdapter.findCaptions(document);

    if (found.container) {
      disappearAt = 0;
      detectionMode = found.mode || 'selector';
      warnedMiss = false;
      if (!capturing && (autoMode || manualRequested)) {
        beginCapture(found.container);
      } else if (capturing) {
        attach(found.container);
        runWatchdog(found.container);
      }
    } else {
      if (!warnedMiss) {
        DomAdapter.warnSelectorsMiss();
        warnedMiss = true;
      }
      if (capturing) {
        detach();
        if (!disappearAt) disappearAt = Date.now();
        else if (Date.now() - disappearAt > MEETING_GONE_MS) endCapture();
      }
    }
    reportStatus();
  }

  function beginCapture(found) {
    capturing = true;
    // Abre a sessão no background (badge REC + startedAt) já com o título da
    // reunião, capturado do document.title no momento em que a sessão abre. No
    // manual isso já veio do START, mas reenviar é idempotente.
    sendToBackground({ type: 'AUTO_START', title: meetingTitle() });
    if (found) attach(found);
  }

  // Chamado a cada mutation do painel de legendas. Marca o pulso (watchdog) e varre.
  function onMutations() {
    lastMutationAt = Date.now();
    scan();
  }

  // Ancora o observer no wrapper ESTÁVEL das legendas. Re-observar quando o
  // wrapper é substituído (legendas fechadas/reabertas) ou o observer foi perdido.
  function attach(found) {
    if (found === container && observer) return;
    container = found;
    if (observer) observer.disconnect();
    observer = new MutationObserver(onMutations);
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    lastMutationAt = Date.now();
    scan();
  }

  // Reanexa o observer à força (sem o atalho de "mesmo nó"). Usado pelo watchdog
  // quando o observer morre em silêncio por reciclagem da lista virtual.
  function relatch(wrapper) {
    if (observer) { observer.disconnect(); observer = null; }
    container = null;
    attach(wrapper);
  }

  /**
   * Watchdog: se estamos capturando e o texto visível do painel MUDOU mas
   * nenhuma mutation chegou em OBSERVER_STALE_MS, o observer morreu em silêncio
   * (o Teams v2 reciclou o nó da lista virtual) → força relatch. Compara o
   * textContent do wrapper a cada tick para detectar a mudança.
   */
  function runWatchdog(wrapper) {
    const snapshot = (wrapper.textContent || '').replace(/\s+/g, ' ').trim();
    const textChanged = snapshot !== lastTextSnapshot;
    lastTextSnapshot = snapshot;
    if (textChanged && lastMutationAt && Date.now() - lastMutationAt > OBSERVER_STALE_MS) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[Transcreve Agenda] observer relatch (watchdog)');
      }
      relatch(wrapper);
    }
  }

  function detach() {
    if (observer) { observer.disconnect(); observer = null; }
    container = null;
    liveKeys = new Set();
    lastTextSnapshot = '';
    lastMutationAt = 0;
  }

  function endCapture() {
    // Finaliza qualquer fala pendente para não perder a última frase dita.
    for (const key of Array.from(commitTimers.keys())) commitNow(key);
    detach();
    capturing = false;
    disappearAt = 0;
    sendToBackground({ type: 'AUTO_END' });
    reportStatus();
  }

  function persistEntry(entry) {
    committedEntries.push(entry);
    chrome.storage.local.set({ [ENTRIES_KEY]: committedEntries });
  }

  function scan() {
    if (!container || !document.contains(container)) {
      detach();
      reportStatus();
      return;
    }

    // Re-query dos itens a partir do wrapper atual a cada scan — nunca guardamos
    // referência a nó de item (a lista virtual os destrói/recicla).
    const items = DomAdapter.extractCaptionItems(container);
    const seen = new Set();
    for (const item of items) {
      if (!item.text) continue;
      const key = TranscriptCore.speechKey(item.mri, item.speaker);
      seen.add(key);
      const closed = TranscriptCore.observeItem(store, {
        key,
        speaker: item.speaker,
        text: item.text,
        ts: Date.now(),
      });
      // observeItem fecha a fala ANTERIOR do mesmo autor quando uma nova começa.
      if (closed) persistEntry(closed);
      scheduleCommit(key);
    }

    // Autor que sumiu do DOM = fala encerrada: comita agora.
    for (const key of liveKeys) {
      if (!seen.has(key)) commitNow(key);
    }
    liveKeys = seen;
    reportStatus();
  }

  function scheduleCommit(key) {
    clearTimeout(commitTimers.get(key));
    commitTimers.set(key, setTimeout(function () { commitNow(key); }, COMMIT_DEBOUNCE_MS));
  }

  function commitNow(key) {
    clearTimeout(commitTimers.get(key));
    commitTimers.delete(key);
    const entry = TranscriptCore.commitPending(store, key);
    if (!entry) return;
    persistEntry(entry);
    reportStatus();
  }

  // O background agrega o status de todos os frames e grava storage.status.
  // Só emitimos quando algo relevante muda, para não inundar as mensagens.
  function reportStatus() {
    const status = {
      capturing,
      captionsDetected: !!container,
      count: committedEntries.length,
      mode: capturing ? detectionMode : null,
    };
    const json = JSON.stringify(status);
    if (json === lastStatusJson) return;
    lastStatusJson = json;
    sendToBackground({ type: 'SESSION_STATUS', status });
  }

  // Título da reunião a partir do document.title, tirando o sufixo do Teams.
  function meetingTitle() {
    const raw = document.title || '';
    return raw.replace(/\s*[|\-–—]\s*Microsoft Teams.*$/i, '').trim();
  }

  // Monta o relatório de diagnóstico: varre o documento principal E os iframes
  // acessíveis (cross-origin cai no catch e vira só a nota de origem).
  function buildDiagnostic() {
    const lines = [];
    const manifest = chrome.runtime.getManifest();
    let sample = null;

    function truncate(html) {
      return String(html || '').slice(0, 3000);
    }

    function dumpDoc(label, doc) {
      const d = DomAdapter.diagnoseDocument(doc);
      lines.push('### ' + label);
      for (const group of Object.keys(d.selectorCounts)) {
        lines.push('  [' + group + ']');
        for (const item of d.selectorCounts[group]) {
          const flag = item.count < 0 ? '(inválido)  ' : '';
          lines.push('    ' + flag + item.count + '  ' + item.sel);
        }
      }
      const tids = Object.keys(d.tid);
      lines.push('  data-tid com caption/transcript: ' +
        (tids.length ? tids.map(function (t) { return t + '×' + d.tid[t]; }).join(', ') : 'nenhum'));
      const cls = Object.keys(d.classes);
      lines.push('  classes com caption/transcript: ' +
        (cls.length ? cls.slice(0, 40).join(', ') : 'nenhuma'));
      lines.push('  container provável (modo ' + (d.mode || 'nenhum') + '): ' +
        (d.sampleEl ? 'ENCONTRADO' : 'não encontrado'));
      if (d.sampleEl) {
        lines.push('  --- AMOSTRA outerHTML (até 3000 chars) ---');
        lines.push(truncate(d.sampleEl.outerHTML));
        lines.push('  --- fim amostra ---');
      }
      lines.push('');
      return d.sampleEl;
    }

    lines.push('=== DIAGNÓSTICO Transcreve Agenda ===');
    lines.push('Versão: ' + manifest.version);
    lines.push('URL: ' + location.href);
    lines.push('Timestamp: ' + new Date().toISOString());
    lines.push('window.frames.length: ' + window.frames.length);
    lines.push('');

    sample = dumpDoc('Documento principal (' + location.origin + ')', document);

    const iframes = document.querySelectorAll('iframe');
    for (let i = 0; i < iframes.length; i++) {
      let doc = null;
      let origin = '(cross-origin — DOM inacessível)';
      try {
        doc = iframes[i].contentDocument;
        if (doc) origin = (doc.location && doc.location.origin) || '(same-origin)';
      } catch (_crossOrigin) {
        // esperado em iframe de outra origem: só reportamos que existe
      }
      const src = iframes[i].getAttribute('src') || '(sem src)';
      if (doc) {
        const s = dumpDoc('IFRAME #' + i + ' ' + origin + ' — src=' + src, doc);
        if (!sample && s) sample = s;
      } else {
        lines.push('### IFRAME #' + i + ' ' + origin + ' — src=' + src);
        lines.push('  DOM inacessível (provável cross-origin). Legenda AQUI dentro');
        lines.push('  só é capturável com "all_frames" + host correspondente no manifest.');
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  // O popup dispara START/STOP/CLEAR (via background) escrevendo em capState, e
  // pode ligar/desligar o modo automático. Reagimos aqui — cobre também abrir a
  // aba DEPOIS de já estar capturando.
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;

    if (changes[AUTOMODE_KEY]) {
      autoMode = changes[AUTOMODE_KEY].newValue !== false;
      tick();
    }

    if (changes[CAPSTATE_KEY]) {
      manualRequested = !!(changes[CAPSTATE_KEY].newValue && changes[CAPSTATE_KEY].newValue.capturing);
      if (!manualRequested && capturing && !autoMode) endCapture();
      else tick();
    }

    if (changes[ENTRIES_KEY]) {
      const next = changes[ENTRIES_KEY].newValue;
      if (Array.isArray(next) && next.length === 0) committedEntries = [];
    }
  });

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg && msg.type === 'DIAGNOSE') {
      // Só o frame de topo monta o relatório completo (ele enxerga os iframes).
      const report = buildDiagnostic();
      chrome.storage.local.set({ diagnostico: { report, ts: Date.now() } });
      sendResponse({ ok: true, report });
      return false;
    }
    if (msg && msg.type === 'GET_STATUS') {
      sendResponse({ capturing, captionsDetected: !!container, count: committedEntries.length });
    }
    return false;
  });

  init();
})();
