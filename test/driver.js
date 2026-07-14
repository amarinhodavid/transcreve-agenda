'use strict';

/**
 * Driver Node do núcleo puro. Prova o dedupe por CONTEÚDO (mri/autor + texto) —
 * o modelo que sobrevive à lista de legendas VIRTUALIZADA do Teams v2, que
 * destrói/recicla os nós dos itens conforme rolam. Também cobre o filtro de
 * ruído de sistema, a sanitização de nome de arquivo e o markdown do
 * salvamento automático.
 *
 * Rode: `node test/driver.js`
 */
const T = require('../transcript-core.js');
const D = require('../dom-adapter.js');

let failures = 0;
function check(label, condition) {
  const status = condition ? 'PASS' : 'FALHOU';
  if (!condition) failures++;
  console.log('  [' + status + '] ' + label);
}

const base = Date.parse('2026-07-10T09:00:00');
const ANA = 'mri:ana@local';
const BRUNO = 'mri:bruno@local';
const CARLA = 'mri:carla@local';

// ============================================================================
console.log('\nDedupe por conteúdo — parciais, nós reciclados e atribuição\n');

const store = T.createStore();

// --- Fala 1: Ana, parciais CRESCENDO (prefixo) → 1 entrada só ---
T.observeItem(store, { key: ANA, speaker: 'Ana', text: 'Oi', ts: base + 1000 });
T.observeItem(store, { key: ANA, speaker: 'Ana', text: 'Oi pessoal', ts: base + 1500 });
T.observeItem(store, { key: ANA, speaker: 'Ana', text: 'Oi pessoal, tudo bem?', ts: base + 2000 });
T.commitPending(store, ANA);

// --- Fala 2: Carla, nome VAZIO no 1º parcial — o mri estável recupera o autor ---
T.observeItem(store, { key: CARLA, speaker: '', text: 'Eu', ts: base + 5000 });
T.observeItem(store, { key: CARLA, speaker: 'Carla', text: 'Eu concordo', ts: base + 5200 });
T.observeItem(store, { key: CARLA, speaker: 'Carla', text: 'Eu concordo com a proposta', ts: base + 5400 });

// --- Lista virtual RECICLA o nó de Ana e re-renderiza a fala JÁ comitada dela ---
const recycled = T.observeItem(store, { key: ANA, speaker: 'Ana', text: 'Oi pessoal, tudo bem?', ts: base + 6000 });
check('re-render de fala já comitada não recria pendente', recycled === null);
T.commitPending(store, ANA); // Ana não tem pendente: no-op
T.commitPending(store, CARLA);

// --- Ruído: legenda só com espaços é descartada ---
T.observeItem(store, { key: BRUNO, speaker: 'Bruno', text: '   ', ts: base + 7000 });
T.commitPending(store, BRUNO);

const entries = T.getEntries(store);
console.log('Entradas finais:', entries.length);
for (const e of entries) console.log('  [' + T.formatTimestamp(e.ts) + '] ' + e.falante + ': ' + e.texto);
console.log('');

check('parciais em crescimento + reciclagem = 2 entradas', entries.length === 2);
check('entrada 1 = Ana', entries[0].falante === 'Ana');
check('entrada 1 texto = último parcial', entries[0].texto === 'Oi pessoal, tudo bem?');
check('entrada 1 timestamp = primeira aparição (base+1000)', entries[0].ts === base + 1000);
check('entrada 2 = Carla (nome recuperado via mri estável)', entries[1].falante === 'Carla');
check('entrada 2 texto = último parcial', entries[1].texto === 'Eu concordo com a proposta');
check('entrada 2 timestamp = primeira aparição (base+5000)', entries[1].ts === base + 5000);
check('legenda só com espaços foi descartada', !entries.some(function (e) { return e.falante === 'Bruno'; }));

// ============================================================================
console.log('\nLista virtual — 2 falas seguidas do MESMO autor viram 2 entradas\n');

const s3 = T.createStore();
T.observeItem(s3, { key: BRUNO, speaker: 'Bruno', text: 'Bom dia', ts: base + 1000 });
T.observeItem(s3, { key: BRUNO, speaker: 'Bruno', text: 'Bom dia a todos', ts: base + 1200 });
// Fala nova (não é prefixo da anterior) → fecha a primeira aqui mesmo.
const closed = T.observeItem(s3, { key: BRUNO, speaker: 'Bruno', text: 'Vamos começar', ts: base + 3000 });
check('fala nova do mesmo autor fecha a anterior no observeItem', closed !== null && closed.texto === 'Bom dia a todos');
T.commitPending(s3, BRUNO);
const e3 = T.getEntries(s3);
check('2 falas seguidas do mesmo autor = 2 entradas', e3.length === 2);
check('...na ordem certa', e3[0].texto === 'Bom dia a todos' && e3[1].texto === 'Vamos começar');
check('...timestamps distintos (base+1000 e base+3000)', e3[0].ts === base + 1000 && e3[1].ts === base + 3000);

// ============================================================================
console.log('\nFiltro de mensagens de sistema do Teams\n');

// Função pura
check('sistema: aviso de idioma casa', T.isSystemCaption('As legendas serão mostradas em Português (Brasil)') === true);
check('sistema: lista de participantes casa', T.isSystemCaption('FULANO, BELTRANO, +2') === true);
check('sistema: fala normal NÃO casa', T.isSystemCaption('bom dia a todos, vamos começar a reunião') === false);

// Integração no commit
const s4 = T.createStore();
const unk = T.speechKey('', ''); // 'name:Desconhecido'

T.observeItem(s4, { key: unk, speaker: '', text: 'As legendas serão mostradas em Português (Brasil)', ts: base });
check('commit descarta aviso de idioma sem falante', T.commitPending(s4, unk) === null);

T.observeItem(s4, { key: unk, speaker: '', text: 'FULANO, BELTRANO, +2', ts: base + 100 });
check('commit descarta lista de participantes sem falante', T.commitPending(s4, unk) === null);

T.observeItem(s4, { key: ANA, speaker: 'Ana', text: 'bom dia a todos', ts: base + 200 });
const kept = T.commitPending(s4, ANA);
check('commit MANTÉM fala normal de falante identificado', kept !== null && kept.texto === 'bom dia a todos');

// Conservador: padrão de sistema, mas COM falante identificado → mantém.
T.observeItem(s4, { key: BRUNO, speaker: 'Bruno', text: 'As legendas serão mostradas em Português (Brasil)', ts: base + 300 });
check('conservador: padrão de sistema COM falante é mantido', T.commitPending(s4, BRUNO) !== null);

check('só a fala real (+ a conservadora) entraram, sistema puro descartado', T.getEntries(s4).length === 2);

// ============================================================================
// Caso REAL (reunião do usuário, v0.3.0): a escadinha crescia e o Teams inseriu
// vírgula/ponto RETROATIVOS na última revisão — cada uma virou "fala". Agora a
// comparação tolerante (sem pontuação) junta tudo em 1 fala.
console.log('\nCaso real — escadinha com pontuação retroativa\n');

const PARTIALS = [
  'Alteradas que já possui um curso que ainda não',
  'Alteradas que já possui um curso que ainda não tem essa se',
  'Alteradas que já possui um curso que ainda não tem essa segurança',
  'Alteradas que já possui um curso que ainda não tem essa segurança a gente',
  'Alteradas, que já possui um curso que ainda não tem essa segurança a gente.',
];
const FINAL_TEXT = PARTIALS[PARTIALS.length - 1];

const sReal = T.createStore();
const oradorKey = T.speechKey('', 'Orador 1'); // sem mri, só o rótulo do Teams
PARTIALS.forEach(function (text, i) {
  T.observeItem(sReal, { key: oradorKey, speaker: 'Orador 1', text: text, ts: base + i * 400 });
});
T.commitPending(sReal, oradorKey);
const eReal = T.getEntries(sReal);
check('5 parciais (com vírgula retroativa) viram 1 entrada', eReal.length === 1);
check('...texto final = a revisão mais completa (com pontuação)', eReal[0] && eReal[0].texto === FINAL_TEXT);
check('...timestamp = primeira aparição da fala', eReal[0] && eReal[0].ts === base);

check('isContinuation tolera a vírgula retroativa', T.isContinuation(PARTIALS[3], PARTIALS[4]) === true);

// ============================================================================
console.log('\nSafety net de exportação — collapseEntries\n');

const rawCommitted = PARTIALS.map(function (text, i) {
  return { ts: base + i * 400, falante: 'Orador 1', texto: text };
});
const collapsed = T.collapseEntries(rawCommitted);
check('exportação colapsa 5 parciais já comitados em 1', collapsed.length === 1);
check('...fica com a versão mais completa', collapsed[0].texto === FINAL_TEXT);
check('...preserva o timestamp mais antigo', collapsed[0].ts === base);

check('collapse NÃO junta falas distintas do mesmo autor',
  T.collapseEntries([
    { ts: base, falante: 'Ana', texto: 'bom dia a todos' },
    { ts: base + 2000, falante: 'Ana', texto: 'vamos ao segundo ponto' },
  ]).length === 2);
check('collapse respeita a janela de 15s (prefixo distante não junta)',
  T.collapseEntries([
    { ts: base, falante: 'Ana', texto: 'oi' },
    { ts: base + 20000, falante: 'Ana', texto: 'oi pessoal tudo bem' },
  ]).length === 2);

// ============================================================================
// Identidade de reunião: separa reuniões trocadas no MESMO tab (Teams v2 é SPA).
console.log('\nIdentidade de reunião — parseMeetingThreadId / stableMeetingId\n');

const urlA = 'https://teams.microsoft.com/v2/?meetup-join/19:meeting_ABCdef123@thread.v2/0?context=%7b%7d';
const urlA2 = 'https://teams.microsoft.com/v2/#/meetup-join/19:meeting_ABCdef123@thread.v2/0?tenantId=x&anon=1';
const urlB = 'https://teams.microsoft.com/v2/?meetup-join/19:meeting_ZZZ999@thread.v2/0';
const urlEnc = 'https://teams.microsoft.com/l/meetup-join/19%3Ameeting_ENC777%40thread.v2/0?ctx=1';

check('extrai threadId cru da URL', T.parseMeetingThreadId(urlA) === '19:meeting_ABCdef123');
check('extrai threadId URL-encoded', T.parseMeetingThreadId(urlEnc) === '19:meeting_ENC777');
check('mesma reunião, hash/query diferentes → MESMO id', T.stableMeetingId(urlA) === T.stableMeetingId(urlA2));
check('reuniões diferentes → ids diferentes', T.stableMeetingId(urlA) !== T.stableMeetingId(urlB));
check('sem threadId cai no título normalizado',
  T.stableMeetingId('https://teams.microsoft.com/v2/', 'Reunião de Vendas') === 'title:reunião de vendas');
check('sem threadId e sem título → id vazio', T.stableMeetingId('https://teams.microsoft.com/', '') === '');
check('título variando em caixa/pontuação → mesmo id',
  T.stableMeetingId('', 'REUNIÃO de Vendas!') === T.stableMeetingId('', 'reunião de vendas'));

// ============================================================================
// Detecção de troca: SÓ threadId decide, com gate de confirmação (N ticks). O
// título é volátil no meio da reunião e NÃO pode disparar troca/auto-save.
console.log('\nDetecção de troca — decideMeetingSwitch (só threadId + confirmação)\n');

const TID_A = '19:meeting_A';
const TID_B = '19:meeting_B';
const NO_CONFIRM = { candidate: '', count: 0 };

// Reproduz o BUG: mesma reunião (threadId estável), rodando vários ticks. Nunca troca.
(function () {
  let cur = TID_A;
  let cs = NO_CONFIRM;
  let switches = 0;
  for (let t = 0; t < 10; t++) {
    const d = T.decideMeetingSwitch(cur, TID_A, cs); // threadId sempre igual
    cs = d.confirmState;
    if (d.action === 'switch') switches++;
    if (d.action === 'adopt') cur = d.currentThreadId;
  }
  check('mesma reunião, título mudando a cada tick → 0 trocas', switches === 0);
})();

// threadId presente → ausente → presente (mesmo id): 0 trocas.
(function () {
  let cur = TID_A;
  let cs = NO_CONFIRM;
  let switches = 0;
  const seq = [TID_A, '', '', TID_A, '', TID_A];
  for (const obs of seq) {
    const d = T.decideMeetingSwitch(cur, obs, cs);
    cs = d.confirmState;
    if (d.action === 'switch') switches++;
    if (d.action === 'adopt') cur = d.currentThreadId;
  }
  check('threadId some e volta (mesmo id) → 0 trocas', switches === 0);
})();

// Começou sintético ('' de threadId) e depois surge um threadId → adota, 0 trocas.
(function () {
  const d = T.decideMeetingSwitch('', TID_A, NO_CONFIRM);
  check('começou sem thread e surgiu um → adota (não troca)',
    d.action === 'adopt' && d.currentThreadId === TID_A);
})();

// threadId genuinamente diferente PERSISTINDO 2 ticks → 1 troca (após confirmação).
(function () {
  let cur = TID_A;
  let cs = NO_CONFIRM;
  const results = [];
  // 1º tick com o novo id: ainda não troca (aguarda confirmação)
  let d = T.decideMeetingSwitch(cur, TID_B, cs); cs = d.confirmState; results.push(d.action);
  // 2º tick consecutivo com o mesmo novo id: confirma e troca
  d = T.decideMeetingSwitch(cur, TID_B, cs); cs = d.confirmState; results.push(d.action);
  if (d.action === 'switch') cur = d.currentThreadId;
  check('1º tick com id novo NÃO troca (aguarda confirmação)', results[0] === 'none');
  check('2º tick consecutivo com o mesmo id novo → troca', results[1] === 'switch' && cur === TID_B);
})();

// Um único tick com id diferente, depois volta ao original → 0 trocas.
(function () {
  let cur = TID_A;
  let cs = NO_CONFIRM;
  let switches = 0;
  let d = T.decideMeetingSwitch(cur, TID_B, cs); cs = d.confirmState; if (d.action === 'switch') switches++;
  d = T.decideMeetingSwitch(cur, TID_A, cs); cs = d.confirmState; if (d.action === 'switch') switches++; // voltou
  d = T.decideMeetingSwitch(cur, TID_B, cs); cs = d.confirmState; if (d.action === 'switch') switches++; // de novo, mas contador zerou
  check('id diferente transitório (volta ao original) → 0 trocas', switches === 0);
})();

// ============================================================================
// Ciclo de vida da sessão amarrado à CALL (não ao painel de legendas). O painel
// some sozinho no meio da reunião — não pode finalizar/salvar por causa disso.
console.log('\nCiclo de vida — decideSessionLifecycle (sessão presa à call)\n');

// REPRODUÇÃO DO BUG: na call, painel de legendas some por 90s → PAUSA, não finaliza.
check('inCall=true + sem legenda 90s → pause (NÃO finaliza/salva)',
  T.decideSessionLifecycle({ sessionOpen: true, inCall: true, hasCaptions: false, sinceCaptionsGoneMs: 90000, sinceCallGoneMs: 0, threadSwitch: false }) === 'pause');
check('inCall=true + legenda presente → capture',
  T.decideSessionLifecycle({ sessionOpen: true, inCall: true, hasCaptions: true, sinceCaptionsGoneMs: 0, sinceCallGoneMs: 0, threadSwitch: false }) === 'capture');
check('inCall=false por 30s → finalize (reunião acabou)',
  T.decideSessionLifecycle({ sessionOpen: true, inCall: false, hasCaptions: false, sinceCaptionsGoneMs: 0, sinceCallGoneMs: 30000, threadSwitch: false }) === 'finalize');
check('inCall=false ainda no grace (10s) → pause, não finaliza',
  T.decideSessionLifecycle({ sessionOpen: true, inCall: false, hasCaptions: false, sinceCaptionsGoneMs: 0, sinceCallGoneMs: 10000, threadSwitch: false }) === 'pause');

// Detector indeterminado (tenant desconhecido): fallback por ausência de legenda
// com grace grande — silêncio de 90s pausa; 6min finaliza.
check('inCall=null + sem legenda 90s → pause (grace 5min)',
  T.decideSessionLifecycle({ sessionOpen: true, inCall: null, hasCaptions: false, sinceCaptionsGoneMs: 90000, sinceCallGoneMs: 0, threadSwitch: false }) === 'pause');
check('inCall=null + sem legenda 6min → finalize (fallback)',
  T.decideSessionLifecycle({ sessionOpen: true, inCall: null, hasCaptions: false, sinceCaptionsGoneMs: 360000, sinceCallGoneMs: 0, threadSwitch: false }) === 'finalize');
check('inCall=null + legenda presente → capture',
  T.decideSessionLifecycle({ sessionOpen: true, inCall: null, hasCaptions: true, sinceCaptionsGoneMs: 0, sinceCallGoneMs: 0, threadSwitch: false }) === 'capture');

check('troca de reunião confirmada → finalize (mesmo na call)',
  T.decideSessionLifecycle({ sessionOpen: true, inCall: true, hasCaptions: true, sinceCaptionsGoneMs: 0, sinceCallGoneMs: 0, threadSwitch: true }) === 'finalize');

check('sem sessão + sem legenda → idle',
  T.decideSessionLifecycle({ sessionOpen: false, inCall: null, hasCaptions: false }) === 'idle');
check('sem sessão + legenda presente → capture (vai iniciar)',
  T.decideSessionLifecycle({ sessionOpen: false, inCall: true, hasCaptions: true }) === 'capture');

// ============================================================================
console.log('\nGuarda anti-lixo do auto-save — shouldAutoSave\n');

check('1 fala / 5s → NÃO salva (arquivo de lixo)',
  T.shouldAutoSave([{ ts: base, falante: 'Ana', texto: 'oi' }],
    new Date(base).toISOString(), new Date(base + 5000).toISOString()) === false);
check('3 falas / 60s → salva',
  T.shouldAutoSave([
    { ts: base, falante: 'Ana', texto: 'a' },
    { ts: base + 1000, falante: 'Bruno', texto: 'b' },
    { ts: base + 2000, falante: 'Ana', texto: 'c' },
  ], new Date(base).toISOString(), new Date(base + 60000).toISOString()) === true);
check('3 falas mas só 5s de duração → NÃO salva',
  T.shouldAutoSave([
    { ts: base, falante: 'Ana', texto: 'a' },
    { ts: base + 1000, falante: 'Bruno', texto: 'b' },
    { ts: base + 2000, falante: 'Ana', texto: 'c' },
  ], new Date(base).toISOString(), new Date(base + 5000).toISOString()) === false);
check('sem timestamps de sessão: usa intervalo das falas (2 falas/20s) → salva',
  T.shouldAutoSave([
    { ts: base, falante: 'Ana', texto: 'a' },
    { ts: base + 20000, falante: 'Bruno', texto: 'b' },
  ], null, null) === true);
check('0 falas → NÃO salva', T.shouldAutoSave([], new Date(base).toISOString(), new Date(base + 60000).toISOString()) === false);

// ============================================================================
console.log('\nDetector de call — isInCall (dom-adapter)\n');

function fakeDoc(html) {
  // mini-doc: só o querySelector que o isInCall usa, via um matcher simples de data-tid.
  return {
    querySelector: function (sel) {
      const m = sel.match(/data-tid\*?=?"?([^"\]]+)"?/);
      const needle = m ? m[1].replace(/"$/, '') : '';
      // suporta [data-tid="x"] e [data-tid*="y" i]
      const wildcard = sel.indexOf('*=') !== -1;
      const tids = html; // array de data-tid presentes
      for (const t of tids) {
        if (wildcard ? t.toLowerCase().indexOf(needle.toLowerCase()) !== -1 : t === needle) return {};
      }
      return null;
    },
  };
}

check('isInCall: com botão de hangup → true', D.isInCall(fakeDoc(['hangup-main-btn'])) === true);
check('isInCall: com calling-stage → true', D.isInCall(fakeDoc(['calling-stage'])) === true);
check('isInCall: DOM sem UI de call → false', D.isInCall(fakeDoc(['some-other-thing'])) === false);
check('isInCall: doc sem querySelector → false (defensivo)', D.isInCall({}) === false);

// ============================================================================
// Transição A → B: simula a sequência do background numa troca de reunião e prova
// que o buffer de B não herda A, e que A foi arquivada finalizada.
console.log('\nTroca de reunião — reset de buffer + arquivamento da anterior\n');

check('planSession: id diferente = reunião nova',
  T.planSession({ startedAt: 't', meetingId: 'tid:A', finalized: false }, 'tid:B').isNew === true);
check('planSession: mesmo id não reabre como nova',
  T.planSession({ startedAt: 't', meetingId: 'tid:A', finalized: false }, 'tid:A').isNew === false);
check('planSession: sessão finalizada = nova',
  T.planSession({ startedAt: 't', meetingId: 'tid:A', finalized: true }, 'tid:A').isNew === true);
check('planSession: sem sessão anterior = nova',
  T.planSession(null, 'tid:A').isNew === true);

(function () {
  let sessionState = null;
  let entriesBuf = [];
  let historyBuf = [];

  function openSim(meetingId, title) {
    const plan = T.planSession(sessionState, meetingId);
    if (plan.isNew) {
      sessionState = { startedAt: 't', title: title || null, meetingId: plan.meetingId, finalized: false };
      entriesBuf = []; // buffer zerado na sessão nova
    } else if (meetingId && sessionState && !sessionState.meetingId) {
      sessionState.meetingId = meetingId;
    }
  }
  function finalizeSim() {
    if (entriesBuf.length && sessionState && !sessionState.finalized) {
      historyBuf = T.pushSession(historyBuf, {
        inicio: 'a', fim: 'b',
        titulo: sessionState.title || 'Reunião do Teams',
        falas: entriesBuf.slice(),
      });
    }
    if (sessionState) sessionState.finalized = true;
  }

  // Reunião A
  openSim('tid:19:meeting_A', 'Reunião A');
  entriesBuf.push({ ts: base, falante: 'Ana', texto: 'fala da reunião A' });
  // Troca detectada: content chama endCapture (AUTO_END) e depois beginCapture (AUTO_START).
  finalizeSim();
  openSim('tid:19:meeting_B', 'Reunião B');
  entriesBuf.push({ ts: base + 1000, falante: 'Bruno', texto: 'fala da reunião B' });

  check('buffer da reunião B NÃO herda falas da A',
    entriesBuf.length === 1 && entriesBuf[0].texto === 'fala da reunião B');
  check('reunião A arquivada no histórico, finalizada',
    historyBuf.length === 1 && historyBuf[0].titulo === 'Reunião A' &&
    historyBuf[0].falas.length === 1 && historyBuf[0].falas[0].texto === 'fala da reunião A');
})();

// ============================================================================
console.log('\nNome de arquivo — sanitização Windows\n');

check('remove inválidos do Windows e mantém acentos',
  T.sanitizeFilePart('Reunião: Projeto <X>/Y | Q3?') === 'Reunião-Projeto-X-Y-Q3');
check('espaços viram hífen', T.sanitizeFilePart('Alinhamento   de   Time') === 'Alinhamento-de-Time');
check('título vazio vira "reuniao"', T.sanitizeFilePart('') === 'reuniao');
check('título só com inválidos vira "reuniao"', T.sanitizeFilePart(' ?? :: // ') === 'reuniao');
check('título longo é limitado a ~60 chars', T.sanitizeFilePart('A'.repeat(120)).length <= 60);

const fname = T.buildAutoSaveFilename(
  { title: 'Reunião de Vendas', startedAt: new Date(base).toISOString() },
  new Date(base).toISOString()
);
console.log('  filename:', fname);
check('auto-save cai em "Transcricoes Teams/" com timestamp + título',
  fname === 'Transcricoes Teams/2026-07-10-0900-Reunião-de-Vendas.md');

// ============================================================================
console.log('\nMarkdown do salvamento automático — cabeçalho\n');

const mdSession = {
  title: 'Reunião de Vendas',
  startedAt: new Date(base).toISOString(),
  endedAt: new Date(base + 3600 * 1000).toISOString(),
};
const md = T.toMeetingMarkdown(mdSession, [
  { ts: base + 1000, falante: 'Ana', texto: 'bom dia' },
  { ts: base + 2000, falante: 'Bruno', texto: 'vamos começar' },
]);
console.log(md.split('\n').slice(0, 9).map(function (l) { return '  | ' + l; }).join('\n'));

check('md: título no cabeçalho', md.indexOf('# Transcrição — Reunião de Vendas') === 0);
check('md: linha de Data local', md.indexOf('- **Data:** 10/07/2026') !== -1);
check('md: linha de Início HH:MM:SS', md.indexOf('- **Início:** 09:00:00') !== -1);
check('md: linha de Fim HH:MM:SS', md.indexOf('- **Fim:** 10:00:00') !== -1);
check('md: contagem de falas', md.indexOf('- **Falas:** 2') !== -1);
check('md: corpo, uma fala por linha',
  md.indexOf('**[09:00:01] Ana:** bom dia') !== -1 &&
  md.indexOf('**[09:00:02] Bruno:** vamos começar') !== -1);

// ============================================================================
console.log('\nFluxo de sessão — histórico das últimas 10\n');

function makeRecord(n) {
  return {
    inicio: new Date(base + n * 1000).toISOString(),
    fim: new Date(base + n * 1000 + 500).toISOString(),
    titulo: 'Reunião ' + n,
    falas: [{ ts: base + n * 1000, falante: 'Falante ' + n, texto: 'fala ' + n }],
  };
}

let history = T.pushSession([], makeRecord(1));
check('sessão finalizada entra no histórico', history.length === 1 && history[0].titulo === 'Reunião 1');

history = T.pushSession(history, null);
check('registro nulo é ignorado (não suja o histórico)', history.length === 1);

for (let n = 2; n <= 12; n++) history = T.pushSession(history, makeRecord(n));
check('12 sessões finalizadas truncam em 10', history.length === 10);
check('histórico mantém as 10 mais recentes (Reunião 3..12)',
  history[0].titulo === 'Reunião 3' && history[9].titulo === 'Reunião 12');

let capped = [];
for (let n = 1; n <= 5; n++) capped = T.pushSession(capped, makeRecord(n), 3);
check('maxKept custom (3) mantém só as 3 últimas', capped.length === 3 && capped[0].titulo === 'Reunião 3');

// ============================================================================
console.log('\nDOM adapter — separa falante em caixa alta do texto\n');

let sp = D.splitUppercaseName('ANA SOUZA bom dia a todos');
check('nome de 2 palavras separado da fala', sp.speaker === 'ANA SOUZA' && sp.text === 'bom dia a todos');

sp = D.splitUppercaseName('BRUNO trouxe os números do trimestre');
check('nome de 1 palavra', sp.speaker === 'BRUNO' && sp.text === 'trouxe os números do trimestre');

sp = D.splitUppercaseName('MARIA DA SILVA COSTA vamos ao ponto');
check('nome de até 4 palavras', sp.speaker === 'MARIA DA SILVA COSTA' && sp.text === 'vamos ao ponto');

// Caso real: o nome completo NÃO pode ser cortado no meio (bug "PATRICIA SILVA
// DE" | "SOUZA"). Consome todas as palavras em caixa alta consecutivas.
sp = D.splitUppercaseName('PATRICIA SILVA DE SOUZA bom dia');
check('nome completo (4 palavras, "DE" incluso) não corta a última',
  sp.speaker === 'PATRICIA SILVA DE SOUZA' && sp.text === 'bom dia');

sp = D.splitUppercaseName('PATRICIA SILVA DE SOUZA');
check('texto só com nome (sem fala) é descartado', sp.speaker === '' && sp.text === '');

sp = D.splitUppercaseName('texto comum sem nome em caixa alta');
check('sem prefixo maiúsculo mantém a fala inteira', sp.speaker === '' && sp.text === 'texto comum sem nome em caixa alta');

sp = D.splitUppercaseName('BRUNO Vamos começar');
check('palavra capitalizada (não caixa alta) fica na fala', sp.speaker === 'BRUNO' && sp.text === 'Vamos começar');

console.log('');
if (failures === 0) {
  console.log('TODOS OS TESTES PASSARAM');
  process.exit(0);
} else {
  console.log(failures + ' TESTE(S) FALHARAM');
  process.exit(1);
}
