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
  // Observando, o texto do painel mudou mas nenhuma mutation chegou nesse tempo =
  // observer morreu em silêncio (lista virtual reciclou o nó) → força relatch.
  const OBSERVER_STALE_MS = 30000;

  // De quanto em quanto tempo, no máximo, carimbamos "vi a UI de call" no storage.
  const CALL_MARK_THROTTLE_MS = 10000;
  // De quanto em quanto tempo repetir o aviso de "em reunião e sem legenda".
  // 60s: curto o bastante para a pessoa ver no começo da reunião, enquanto ainda
  // dá tempo de ligar a legenda, e longo o bastante para não poluir o console.
  const AVISO_LEGENDA_OFF_MS = 60000;

  const ENTRIES_KEY = 'entries';
  const CAPSTATE_KEY = 'capState';
  const AUTOMODE_KEY = 'autoMode';
  // Carimbo compartilhado entre TODOS os frames: quando algum deles viu a UI de
  // call pela última vez. O frame que renderiza as legendas quase nunca é o mesmo
  // que tem o botão de desligar, então sem esse canal ele jamais enxergaria a call.
  const CALLSEEN_KEY = 'callSeenAt';

  const store = TranscriptCore.createStore();
  // Dedupe é por CONTEÚDO (mri/autor + texto), nunca por nó: a lista de legendas
  // do Teams v2 é virtualizada e recicla os nós dos itens.
  const commitTimers = new Map(); // chave da fala -> timeout do debounce
  let committedEntries = []; // espelho em memória do que está no storage
  let observer = null;
  let pollTimer = null;
  let container = null; // wrapper ESTÁVEL das legendas (onde o observer ancora)
  let capturing = false; // SESSÃO aberta (pode estar pausada — a call segue ativa)
  let autoMode = true; // captura sozinho ao detectar legenda
  let manualRequested = false; // usuário clicou Iniciar (modo manual)
  let detectionMode = 'selector'; // 'selector' | 'heuristic'
  let warnedMiss = false;
  let lastStatusJson = '';
  let lastMutationAt = 0; // quando o observer disparou pela última vez (watchdog)
  let lastTextSnapshot = ''; // textContent do wrapper no último tick (watchdog)
  let currentThreadId = ''; // threadId da reunião em captura ('' se começou sem)
  let switchConfirm = { candidate: '', count: 0, lost: 0 }; // gate de confirmação da troca
  let currentTitleKey = ''; // título normalizado da reunião em captura
  let titleConfirm = { candidate: '', count: 0 }; // gate de confirmação da troca por título
  let callSeenAt = 0; // carimbo compartilhado: algum frame viu a UI de call
  let lastCallMark = 0; // último carimbo QUE ESTE frame escreveu (throttle)
  let captionsGoneAt = 0; // quando o painel de legendas sumiu (0 = presente)
  let legendaDesligadaAvisadaEm = 0; // último aviso de "em reunião e sem legenda"
  let callGoneAt = 0; // quando a UI de call sumiu depois de vista (0 = na call/indef)
  let sawCallUi = false; // já vimos a UI de call nesta sessão (confia no "false" depois)
  let lastSpeechAt = 0; // última fala COMITADA (0 = sem sessão); base do corte por silêncio
  let tituloEnviado = ''; // último título já mandado ao background (evita reenvio igual)

  // Recarregar/atualizar a extensão deixa ÓRFÃO todo content script já injetado:
  // o `chrome.runtime` dele aponta para um contexto morto e qualquer chamada lança
  // "Extension context invalidated" — exceção SÍNCRONA, que derrubava o tick inteiro
  // e matava a captura sem nenhum sinal visível. Só recarregar a aba do Teams religa,
  // então aqui a resposta é específica: parar o motor e dizer o que fazer.
  let contextDead = false;

  function contextAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_invalidated) {
      return false;
    }
  }

  function markContextDead() {
    if (contextDead) return;
    contextDead = true;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    detach();
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[Transcreve Agenda] a extensão foi recarregada e este content script ficou órfão — recarregue a aba do Teams (F5) para voltar a capturar.');
    }
  }

  function sendToBackground(message) {
    if (contextDead) return;
    if (!contextAlive()) { markContextDead(); return; }
    try {
      const p = chrome.runtime.sendMessage(message);
      // Fire-and-forget: sem receptor o SW pode rejeitar; não é erro nosso.
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (_invalidated) {
      markContextDead();
    }
  }

  // Mesma proteção para o storage: é o outro canal com a extensão no caminho
  // quente (cada fala comitada e cada carimbo de call passam por aqui).
  function storageSet(patch) {
    if (contextDead) return;
    if (!contextAlive()) { markContextDead(); return; }
    try {
      const p = chrome.storage.local.set(patch);
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (_invalidated) {
      markContextDead();
    }
  }

  async function init() {
    let data;
    try {
      data = await chrome.storage.local.get([ENTRIES_KEY, CAPSTATE_KEY, AUTOMODE_KEY, CALLSEEN_KEY]);
    } catch (_invalidated) {
      markContextDead(); // extensão recarregada antes mesmo deste frame subir
      return;
    }
    committedEntries = Array.isArray(data[ENTRIES_KEY]) ? data[ENTRIES_KEY] : [];
    autoMode = data[AUTOMODE_KEY] !== false; // padrão ON
    manualRequested = !!(data[CAPSTATE_KEY] && data[CAPSTATE_KEY].capturing);
    callSeenAt = typeof data[CALLSEEN_KEY] === 'number' ? data[CALLSEEN_KEY] : 0;
    startEngine();
  }

  // Carimba "vi a UI de call agora" para os outros frames. Com throttle porque o
  // tick roda a cada 2s e isso aqui não precisa dessa resolução.
  function markCallSeen(now) {
    callSeenAt = now;
    if (now - lastCallMark < CALL_MARK_THROTTLE_MS) return;
    lastCallMark = now;
    storageSet({ [CALLSEEN_KEY]: now });
  }

  // Um único laço serve aos dois modos: procura o container e decide o que fazer.
  function startEngine() {
    if (!pollTimer) pollTimer = setInterval(tick, CONTAINER_POLL_MS);
    tick();
  }

  function tick() {
    if (contextDead) return;
    const now = Date.now();
    const found = DomAdapter.findCaptions(document);
    const hasCaptions = !!found.container;

    if (hasCaptions) {
      detectionMode = found.mode || 'selector';
      captionsGoneAt = 0;
      warnedMiss = false;
      legendaDesligadaAvisadaEm = 0;
    } else {
      if (!warnedMiss) { DomAdapter.warnSelectorsMiss(document); warnedMiss = true; }
      if (!captionsGoneAt) captionsGoneAt = now;
    }

    // Estado da CALL (não do painel de legendas): true = UI de call presente;
    // false = já vista e agora sumida (saiu da reunião); null = nunca vista neste
    // tenant (indeterminado → fallback seguro por ausência de legenda).
    //
    // A leitura é AGREGADA entre os frames: a UI de call mora no frame de topo e as
    // legendas costumam vir de outro. Cada frame carimba o que vê em storage e aqui
    // aceitamos o carimbo mais recente de qualquer um enquanto ele estiver fresco.
    // O carimbo dura CALL_FRESH_MS (2 min) porque o Chrome derruba o timer desta
    // aba para ~1x/min quando ela está em segundo plano — janela curta demais daria
    // "saiu da call" no meio da reunião só por a aba estar atrás de outra janela.
    const callHere = DomAdapter.isInCall(document);
    if (callHere) markCallSeen(now);
    const callNow = callHere ||
      (callSeenAt > 0 && now - callSeenAt < TranscriptCore.CALL_FRESH_MS);
    if (callNow) { sawCallUi = true; callGoneAt = 0; }
    else if (sawCallUi && !callGoneAt) callGoneAt = now;
    const inCall = callNow ? true : (sawCallUi ? false : null);

    // Reunião ao vivo E sem legenda = nada está sendo capturado, e dá para
    // resolver AGORA ligando a legenda. É a única combinação acionável: fora da
    // call a ausência é normal. Em 09/10/2026 uma reunião inteira do Meet se
    // perdeu assim, sem erro nenhum, porque a legenda não tinha sido ativada.
    // Repete a cada AVISO_LEGENDA_OFF_MS para não virar uma linha só perdida no
    // console de uma aba que ninguém olha.
    const emReuniaoSemLegenda = inCall === true && !hasCaptions;
    if (emReuniaoSemLegenda) {
      if (!legendaDesligadaAvisadaEm || now - legendaDesligadaAvisadaEm >= AVISO_LEGENDA_OFF_MS) {
        legendaDesligadaAvisadaEm = now;
        console.warn(DomAdapter.captionsMissingMessage(document));
        sendToBackground({ type: 'CAPTIONS_OFF_IN_CALL' });
      }
    } else if (legendaDesligadaAvisadaEm && !emReuniaoSemLegenda) {
      legendaDesligadaAvisadaEm = 0;
      sendToBackground({ type: 'CAPTIONS_OFF_CLEARED' });
    }

    // Sinais de fronteira entre reuniões — só enquanto há sessão aberta.
    let threadSwitch = false;
    let threadLost = false;
    let titleSwitch = false;
    if (capturing) {
      const observed = TranscriptCore.parseMeetingThreadId(location.href);
      const decision = TranscriptCore.decideMeetingSwitch(currentThreadId, observed, switchConfirm);
      switchConfirm = decision.confirmState;
      if (decision.action === 'adopt') currentThreadId = decision.currentThreadId;
      if (decision.action === 'switch') threadSwitch = true;
      if (decision.action === 'lost') threadLost = true;

      // Título como sinal SECUNDÁRIO: é o que separa reuniões consecutivas da
      // agenda quando o threadId não muda e a call não é reconhecida.
      const observedTitle = TranscriptCore.normalizeMeetingTitle(document.title);
      const titleDecision = TranscriptCore.decideTitleSwitch(currentTitleKey, observedTitle, titleConfirm);
      titleConfirm = titleDecision.confirmState;
      if (titleDecision.action === 'adopt') currentTitleKey = titleDecision.currentTitle;
      if (titleDecision.action === 'switch') titleSwitch = true;
    }

    const action = TranscriptCore.decideSessionLifecycle({
      sessionOpen: capturing,
      inCall: inCall,
      hasCaptions: hasCaptions,
      sinceCaptionsGoneMs: captionsGoneAt ? now - captionsGoneAt : 0,
      sinceCallGoneMs: callGoneAt ? now - callGoneAt : 0,
      sinceLastSpeechMs: capturing && lastSpeechAt ? now - lastSpeechAt : 0,
      threadSwitch: threadSwitch,
      titleSwitch: titleSwitch,
      threadLost: threadLost,
    });


    if (action === 'capture') {
      if (capturing) {
        attach(found.container);
        runWatchdog(found.container);
      } else if (autoMode || manualRequested) {
        beginCapture(found.container);
      }
    } else if (action === 'pause') {
      // Sem legenda mas ainda na call: PAUSA (comita pendentes e destaca o observer)
      // sem finalizar nem salvar. A mesma sessão retoma quando a legenda voltar.
      pauseCapture();
    } else if (action === 'finalize') {
      if (capturing) {
        if (typeof console !== 'undefined' && console.warn) {
          let reason = 'fim da reunião';
          if (threadSwitch) reason = 'troca de reunião confirmada (threadId)';
          else if (titleSwitch) reason = 'troca de reunião confirmada (título)';
          else if (threadLost) reason = 'saiu da reunião (URL sem threadId, fora da call)';
          else if (inCall === false) reason = 'UI de call sumiu';
          else if (hasCaptions) reason = 'silêncio prolongado com painel aberto';
          console.warn('[Transcreve Agenda] ' + reason + ' — finalizando a anterior');
        }
        endCapture();
        // Troca de reunião OU corte por silêncio com o painel ainda aberto: a
        // próxima reunião começa em sessão nova (buffer, título e identidade
        // recomputados) em vez de colar no arquivo da anterior.
        if (hasCaptions && (autoMode || manualRequested)) beginCapture(found.container);
      }
    }
    reportStatus();
  }

  function firstVisibleMri() {
    try {
      const el = (container || document).querySelector('[data-person-mri]');
      return el ? el.getAttribute('data-person-mri') || '' : '';
    } catch (_noQuery) {
      return '';
    }
  }

  // Id da reunião enviado ao background como IDENTIDADE de sessão (separa reuniões
  // no reset de buffer). É o threadId quando há; senão um id sintético CONGELADO
  // (1º person-mri + timestamp), computado UMA vez aqui e nunca recomputado de
  // título no meio da captura.
  function meetingIdFor(threadId) {
    if (threadId) return 'tid:' + threadId;
    const mri = firstVisibleMri();
    return 'ts:' + (mri ? mri + '|' : '') + Date.now();
  }

  function beginCapture(found) {
    capturing = true;
    committedEntries = []; // buffer local SEMPRE limpo ao abrir a sessão nova
    currentThreadId = TranscriptCore.parseMeetingThreadId(location.href);
    switchConfirm = { candidate: '', count: 0, lost: 0 };
    // Identidade por título da reunião que está começando AGORA — é contra ela que
    // os próximos ticks comparam para detectar a reunião seguinte.
    currentTitleKey = TranscriptCore.normalizeMeetingTitle(document.title);
    titleConfirm = { candidate: '', count: 0 };
    // Nova sessão re-aprende a UI de call e reinicia os relógios de ausência.
    sawCallUi = false;
    callGoneAt = 0;
    captionsGoneAt = 0;
    lastSpeechAt = Date.now(); // relógio do corte por silêncio conta da abertura
    // Abre a sessão no background (badge REC + startedAt) com título (só nome de
    // arquivo) e o meetingId de identidade. O id separa reuniões distintas mesmo se
    // AUTO_END/AUTO_START intercalarem. No manual o START já abriu; reenviar é idempotente.
    tituloEnviado = '';
    sendToBackground({ type: 'AUTO_START', title: meetingTitle(), meetingId: meetingIdFor(currentThreadId) });
    if (found) attach(found);
  }

  /**
   * Reenvia o título quando ele melhora depois da abertura. Duas razões: no
   * `beginCapture` o painel ainda não tem falas, então o fallback por participantes
   * não tem o que ler; e o Teams às vezes troca um título genérico pelo nome real da
   * reunião alguns segundos depois de entrar. Só sobe quando muda de fato e quando o
   * novo nome não é o fallback 'Reunião' — o background sobrescreve o título da
   * sessão aberta, e o arquivo nasce com o último valor.
   */
  function reavaliarTitulo() {
    if (!capturing) return;
    const titulo = meetingTitle();
    if (!titulo || titulo === 'Reunião' || titulo === tituloEnviado) return;
    tituloEnviado = titulo;
    sendToBackground({ type: 'AUTO_START', title: titulo, meetingId: meetingIdFor(currentThreadId) });
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
    lastTextSnapshot = '';
    lastMutationAt = 0;
  }

  // PAUSA a captura sem finalizar a sessão: comita as falas pendentes (não perde a
  // última) e destaca o observer. A sessão, o buffer e o meetingId ficam de pé —
  // quando a legenda voltar na MESMA call, attach() retoma tudo. Não fala com o
  // background (nada de AUTO_END), então não salva.
  function pauseCapture() {
    if (!observer && !container) return; // já pausado
    for (const key of Array.from(commitTimers.keys())) commitNow(key);
    detach();
  }

  function endCapture() {
    // Finaliza qualquer fala pendente para não perder a última frase dita.
    for (const key of Array.from(commitTimers.keys())) commitNow(key);
    detach();
    capturing = false;
    currentThreadId = ''; // próxima captura recomputa a identidade do zero
    switchConfirm = { candidate: '', count: 0, lost: 0 };
    currentTitleKey = '';
    titleConfirm = { candidate: '', count: 0 };
    captionsGoneAt = 0;
    callGoneAt = 0;
    sawCallUi = false;
    lastSpeechAt = 0;
    sendToBackground({ type: 'AUTO_END' });
    reportStatus();
  }

  function persistEntry(entry) {
    lastSpeechAt = Date.now(); // fala nova = reunião viva; zera o relógio do silêncio
    committedEntries.push(entry);
    storageSet({ [ENTRIES_KEY]: committedEntries });
    // Com falas no painel, o título por participantes passa a existir. É aqui que
    // a sessão aberta com nome genérico ganha o nome de quem está na call.
    reavaliarTitulo();
  }

  function scan() {
    if (!container || !document.contains(container)) {
      detach();
      reportStatus();
      return;
    }

    // Re-query dos itens a partir do wrapper atual a cada scan — nunca guardamos
    // referência a nó de item (a lista virtual os destrói/recicla).
    const items = DomAdapter.extractCaptionItems(container).filter(function (it) { return it.text; });
    const keys = items.map(function (it) { return TranscriptCore.speechKey(it.mri, it.speaker); });

    for (let i = 0; i < items.length; i++) {
      const closed = TranscriptCore.observeItem(store, {
        key: keys[i],
        speaker: items[i].speaker,
        text: items[i].text,
        ts: Date.now(),
      });
      // observeItem fecha a fala ANTERIOR do mesmo autor quando uma nova começa.
      if (closed) persistEntry(closed);
    }

    // Regra de posição da lista virtual do Teams v2: o ÚLTIMO item é o único "em
    // progresso"; qualquer autor cuja última ocorrência NÃO é o último item já
    // tem legenda mais nova abaixo → está final, comita agora. O último item fica
    // pendente e é fechado pelo debounce (1,2s sem mudança) ou pelo fim da sessão.
    const lastIdx = keys.length - 1;
    const lastOccurrence = new Map();
    for (let i = 0; i < keys.length; i++) lastOccurrence.set(keys[i], i);
    for (const [key, idx] of lastOccurrence) {
      if (idx < lastIdx) commitNow(key);
      else scheduleCommit(key);
    }
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

  // Nomes que o Teams põe no título quando a reunião NÃO tem nome próprio: a aba
  // aberta ("Chat", "Calendar"), o app embutido ("Microsoft Copilot") ou o próprio
  // usuário ("FULANO (Você)", numa call iniciada do chat 1:1). Virar nome de arquivo
  // produz "Chat-ADRIANO-MARINHO-DAVID-(Você).md" para uma reunião real com outras
  // pessoas — foi o que aconteceu em 29/09. Aqui eles são descartados e o nome sai
  // dos participantes reais.
  const TITULO_SEM_NOME = /^\s*(chat|calendar|calend[áa]rio|atividade|activity|chamadas|calls|equipes|teams|arquivos|files|microsoft\s+\w+|.*\(voc[êe]\))\s*$/i;

  /**
   * Nome legível da reunião para o arquivo. Diferente de `normalizeMeetingTitle`,
   * que devolve uma CHAVE minúscula sem pontuação para comparar troca de reunião:
   * aqui o texto vai para o disco, então preserva acento e caixa.
   *
   * Limpa, na ordem: sufixo do app, contador de não-lidas, prefixos de aba
   * empilhados ("(3) Calendar | Chat | X"). Se o que sobra não nomeia reunião
   * nenhuma, cai para os participantes visíveis no painel de legendas — quem está
   * na call identifica melhor que o rótulo da aba.
   */
  function meetingTitle() {
    let s = (document.title || '').replace(/\s*[|\-–—]\s*Microsoft Teams.*$/i, '');
    s = s.replace(/^\s*\(\s*\d+\s*\)\s*/, ''); // contador "(3) "
    // Corta prefixo de aba repetidamente: o Teams empilha mais de um.
    let prev;
    do {
      prev = s;
      s = s.replace(/^\s*(chat|calendar|calend[áa]rio|atividade|activity|chamadas|calls|equipes|teams|arquivos|files)\s*\|\s*/i, '');
    } while (s !== prev);
    s = s.trim();
    if (s && !TITULO_SEM_NOME.test(s)) return s;
    const pelosParticipantes = tituloPorParticipantes();
    return pelosParticipantes || 'Reunião';
  }

  // Últimos falantes distintos do painel, na ordem em que aparecem. Serve de nome
  // quando o título não identifica a reunião. Sem painel ou sem nome reconhecível,
  // devolve '' e quem chama decide o fallback.
  function tituloPorParticipantes() {
    if (!container) return '';
    let itens;
    try {
      itens = DomAdapter.extractCaptionItems(container);
    } catch (_semPainel) {
      return '';
    }
    const nomes = [];
    for (const item of itens) {
      const nome = (item.speaker || '').trim();
      if (!nome || nome === 'Desconhecido' || /^orador\s*\d+$/i.test(nome)) continue;
      if (nomes.indexOf(nome) === -1) nomes.push(nome);
      if (nomes.length === 3) break;
    }
    return nomes.join(', ');
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
      lines.push('  [call UI — isInCall=' + (d.inCall ? 'SIM' : 'não') + ']');
      for (const item of d.callUi || []) {
        const flag = item.count < 0 ? '(inválido)  ' : '';
        lines.push('    ' + flag + item.count + '  ' + item.sel);
      }
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

    // Outro frame viu a UI de call: adota o carimbo mais recente. Não chamamos
    // tick() aqui — o próximo já lê o valor atualizado, e um tick por escrita de
    // carimbo só geraria trabalho repetido.
    if (changes[CALLSEEN_KEY]) {
      const seen = changes[CALLSEEN_KEY].newValue;
      if (typeof seen === 'number' && seen > callSeenAt) callSeenAt = seen;
    }
  });

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (msg && msg.type === 'DIAGNOSE') {
      // Só o frame de topo monta o relatório completo (ele enxerga os iframes).
      const report = buildDiagnostic();
      storageSet({ diagnostico: { report, ts: Date.now() } });
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
