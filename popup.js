'use strict';

/**
 * Lógica do popup: controla captura, mostra status e transcrição ao vivo e
 * dispara exportação. A fonte da verdade é o chrome.storage.local; o popup só
 * lê/renderiza e reage a storage.onChanged (assim continua correto mesmo se
 * fechar e reabrir durante a reunião).
 *
 * Com o modo automático ligado (padrão), o popup vira um visor: o content script
 * captura sozinho e o popup só mostra status, contador, transcrição e exportação.
 */
(function () {
  'use strict';

  const CAPTIONS_OFF_HINT =
    'Legendas não detectadas. No Teams: Mais ações (…) → Idioma e fala → Ativar legendas ao vivo.';

  const els = {
    capDot: document.getElementById('capDot'),
    capLabel: document.getElementById('capLabel'),
    capDetectedDot: document.getElementById('capDetectedDot'),
    capDetectedLabel: document.getElementById('capDetectedLabel'),
    countValue: document.getElementById('countValue'),
    hint: document.getElementById('hint'),
    autoToggle: document.getElementById('autoToggle'),
    saveToggle: document.getElementById('saveToggle'),
    manualControls: document.getElementById('manualControls'),
    btnStart: document.getElementById('btnStart'),
    btnStop: document.getElementById('btnStop'),
    btnClear: document.getElementById('btnClear'),
    btnClearAuto: document.getElementById('btnClearAuto'),
    btnDiag: document.getElementById('btnDiag'),
    list: document.getElementById('transcriptList'),
    emptyState: document.getElementById('emptyState'),
    historySection: document.getElementById('historySection'),
    historyList: document.getElementById('historyList'),
  };

  function send(type, extra) {
    return chrome.runtime.sendMessage(Object.assign({ type }, extra || {}));
  }

  function showHint(text) {
    els.hint.textContent = text;
    els.hint.hidden = false;
  }

  function renderStatus(status, capState, autoMode) {
    const capturing = !!(status && status.capturing) || !!(capState && capState.capturing);
    const detected = !!(status && status.captionsDetected);
    const count = status && typeof status.count === 'number' ? status.count : 0;
    const heuristic = status && status.mode === 'heuristic';

    els.capDot.className = 'status-dot ' + (capturing ? 'on' : 'off');
    els.capLabel.textContent = capturing ? 'Capturando' : autoMode ? 'Aguardando legenda' : 'Parado';

    els.capDetectedDot.className =
      'status-dot ' + (detected ? (heuristic ? 'warn' : 'on') : capturing ? 'warn' : 'off');
    let detLabel = 'Legendas: ';
    if (detected) detLabel += heuristic ? 'detectadas (modo heurístico)' : 'detectadas';
    else detLabel += capturing || autoMode ? 'procurando…' : '—';
    els.capDetectedLabel.textContent = detLabel;

    els.countValue.textContent = String(count);

    els.manualControls.hidden = autoMode;
    if (els.btnStart) els.btnStart.disabled = capturing;
    if (els.btnStop) els.btnStop.disabled = !capturing;

    if (capturing && !detected) showHint(CAPTIONS_OFF_HINT);
    else if (!els.hint.textContent || els.hint.textContent === CAPTIONS_OFF_HINT) els.hint.hidden = true;
  }

  function renderEntries(entries) {
    els.list.textContent = '';
    if (!entries.length) {
      els.emptyState.hidden = false;
      return;
    }
    els.emptyState.hidden = true;

    const frag = document.createDocumentFragment();
    for (const entry of entries) {
      const li = document.createElement('li');
      li.className = 'entry';

      const meta = document.createElement('div');
      meta.className = 'entry-meta';

      const time = document.createElement('span');
      time.className = 'entry-time';
      time.textContent = TranscriptCore.formatTimestamp(entry.ts);

      const who = document.createElement('span');
      who.className = 'entry-who';
      who.textContent = entry.falante;

      meta.append(time, who);

      const text = document.createElement('span');
      text.className = 'entry-text';
      text.textContent = entry.texto;

      li.append(meta, text);
      frag.append(li);
    }
    els.list.append(frag);
    els.list.scrollTop = els.list.scrollHeight; // auto-scroll para a fala mais recente
  }

  function formatWhen(iso) {
    if (!iso) return 'sessão';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? 'sessão' : d.toLocaleString('pt-BR');
  }

  function renderHistory(history) {
    els.historyList.textContent = '';
    // As mais recentes primeiro; o storage guarda em ordem cronológica.
    const list = Array.isArray(history) ? history.slice().reverse() : [];
    if (!list.length) {
      els.historySection.hidden = true;
      return;
    }
    els.historySection.hidden = false;

    list.forEach(function (rec, revIndex) {
      const realIndex = history.length - 1 - revIndex; // índice no array original
      const li = document.createElement('li');
      li.className = 'history-item';

      const info = document.createElement('div');
      info.className = 'history-info';
      const title = document.createElement('span');
      title.className = 'history-title';
      title.textContent = rec.titulo || 'Reunião do Teams';
      const meta = document.createElement('span');
      meta.className = 'history-meta';
      meta.textContent = formatWhen(rec.inicio) + ' · ' + (rec.falas ? rec.falas.length : 0) + ' falas';
      info.append(title, meta);

      const actions = document.createElement('div');
      actions.className = 'history-actions';
      for (const fmt of ['md', 'txt', 'json']) {
        const b = document.createElement('button');
        b.className = 'btn btn-export';
        b.type = 'button';
        b.textContent = '.' + fmt;
        b.addEventListener('click', async function () {
          const result = await send('EXPORT_HISTORY', { index: realIndex, format: fmt });
          if (result && result.ok === false) showHint('Sessão sem falas para exportar.');
        });
        actions.append(b);
      }

      li.append(info, actions);
      els.historyList.append(li);
    });
  }

  // Assinatura leve do estado relevante: evita re-render (e o snap do auto-scroll)
  // quando nada mudou, tanto no onChanged quanto no polling.
  let lastSig = '';

  async function refresh(force) {
    const data = await chrome.storage.local.get(['entries', 'status', 'capState', 'autoMode', 'autoSave', 'history']);
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const sig = JSON.stringify({
      n: entries.length,
      s: data.status || null,
      c: data.capState || null,
      a: data.autoMode !== false,
      sv: data.autoSave !== false,
      h: Array.isArray(data.history) ? data.history.length : 0,
    });
    if (!force && sig === lastSig) return;
    lastSig = sig;

    const autoMode = data.autoMode !== false;
    els.autoToggle.checked = autoMode;
    els.saveToggle.checked = data.autoSave !== false;
    renderStatus(data.status, data.capState, autoMode);
    renderEntries(entries);
    renderHistory(data.history);
  }

  els.autoToggle.addEventListener('change', function () {
    chrome.storage.local.set({ autoMode: els.autoToggle.checked });
  });

  els.saveToggle.addEventListener('change', function () {
    chrome.storage.local.set({ autoSave: els.saveToggle.checked });
  });

  if (els.btnStart) els.btnStart.addEventListener('click', function () { send('START'); });
  if (els.btnStop) els.btnStop.addEventListener('click', function () { send('STOP'); });
  if (els.btnClear) els.btnClear.addEventListener('click', function () { send('CLEAR'); });
  els.btnClearAuto.addEventListener('click', function () { send('CLEAR'); });

  els.btnDiag.addEventListener('click', async function () {
    showHint('Rodando diagnóstico…');
    let tab;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = tabs && tabs[0];
    } catch (_noTab) {
      tab = null;
    }
    if (!tab || !tab.id) {
      showHint('Não encontrei a aba ativa. Abra a reunião do Teams e tente de novo.');
      return;
    }

    let res = null;
    try {
      // frameId 0 = frame de topo, que enxerga e enumera os iframes.
      res = await chrome.tabs.sendMessage(tab.id, { type: 'DIAGNOSE' }, { frameId: 0 });
    } catch (_noContentScript) {
      res = null;
    }
    if (!res || !res.ok || !res.report) {
      showHint('Content script não está rodando nesta aba — recarregue a página do Teams (F5) e tente de novo.');
      return;
    }

    try {
      await navigator.clipboard.writeText(res.report);
      showHint('Diagnóstico copiado — cole no chat do Claude.');
    } catch (_clipboardBlocked) {
      showHint('Diagnóstico salvo em storage.local (chave "diagnostico") — não consegui copiar automaticamente.');
    }
  });

  for (const button of document.querySelectorAll('.export-buttons .btn-export')) {
    button.addEventListener('click', async function () {
      const result = await send('EXPORT', { format: button.dataset.format });
      if (result && result.ok === false && result.reason === 'empty') {
        showHint('Nada para exportar ainda — capture ao menos uma fala.');
      }
    });
  }

  // Caminho principal: reage na hora a cada gravação no storage (fala nova
  // comitada → changes.entries → re-render imediato, mesmo com o popup aberto).
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local') return;
    if (changes.entries || changes.status || changes.capState ||
        changes.autoMode || changes.autoSave || changes.history) {
      refresh();
    }
  });

  // Rede de segurança: se algum evento de onChanged escapar (o popup pode perder
  // notificações em certas situações), um polling leve garante o visor ao vivo.
  // O refresh só re-renderiza quando a assinatura muda, então isso é barato.
  setInterval(function () { refresh(); }, 1000);

  refresh(true);
})();
