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
