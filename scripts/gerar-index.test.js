'use strict';

// Testes de parse (funções puras). Roda com: node scripts/gerar-index.test.js
const assert = require('assert');
const { parseFilename, parseHeader, buildRecord } = require('./gerar-index');

let ok = 0;
function check(nome, fn) {
  fn();
  ok++;
  console.log('  ok  ' + nome);
}

// 1) parse do nome: data, hora e título (sem o sufixo de colisão -(n))
check('parseFilename extrai data/hora/titulo', () => {
  const r = parseFilename('2026-07-14-0900-(1)-Calendar-Daily-Segurança.md');
  assert.strictEqual(r.dataISO, '2026-07-14');
  assert.strictEqual(r.horaHHMM, '09:00');
  assert.strictEqual(r.titulo, 'Calendar Daily Segurança');
});

// 2) colchetes preservados no título
check('parseFilename preserva colchetes', () => {
  const r = parseFilename('2026-07-13-1713-(4)-Calendar-[BIOMETRIA-RESIDENCIAL].md');
  assert.strictEqual(r.dataISO, '2026-07-13');
  assert.strictEqual(r.horaHHMM, '17:13');
  assert.ok(r.titulo.indexOf('[BIOMETRIA') >= 0 && r.titulo.indexOf('RESIDENCIAL]') >= 0, r.titulo);
});

// 3) nome sem colisão
check('parseFilename sem sufixo de colisão', () => {
  const r = parseFilename('2026-07-13-1457-Calendar-TLV-Alinhamentos-com-Arquitetura.md');
  assert.strictEqual(r.titulo, 'Calendar TLV Alinhamentos com Arquitetura');
  assert.strictEqual(r.colisao, null);
});

// 4) nome fora do padrão retorna null
check('parseFilename fora do padrão -> null', () => {
  assert.strictEqual(parseFilename('teams-transcricao-2026-07-13-1706.md'), null);
});

// 5) cabeçalho é fonte da verdade e vence o nome (data divergente de propósito)
check('cabeçalho tem prioridade sobre o nome', () => {
  const nome = '2026-01-01-0000-Reuniao-Teste.md'; // nome diz 01/01 00:00
  const conteudo = [
    '# Transcrição — (2) Calendar | Reunião Real',
    '',
    '- **Data:** 14/07/2026',
    '- **Início:** 09:05:10',
    '- **Fim:** 09:40:00',
    '- **Falas:** 42',
    '',
    '---',
    '',
    '**[09:05:10] FULANO:** olá'
  ].join('\n');
  const rec = buildRecord(nome, conteudo);
  assert.strictEqual(rec.dataISO, '2026-07-14', 'data do cabeçalho deve vencer');
  assert.strictEqual(rec.hora, '09:05', 'hora do cabeçalho deve vencer');
  assert.strictEqual(rec.fim, '09:40:00');
  assert.strictEqual(rec.falas, 42, 'falas do cabeçalho deve vencer a contagem');
  assert.strictEqual(rec.titulo, 'Calendar | Reunião Real', 'título limpo sem o (n) de colisão');
  assert.strictEqual(rec.id, nome);
});

// 6) cabeçalho estilo "Início: DD/MM/AAAA, HH:MM:SS" (sem campo Data e sem Fim)
check('cabeçalho com data embutida no Início', () => {
  const conteudo = [
    '# Transcrição — (1) Chamadas',
    '',
    '- **Início:** 13/07/2026, 16:26:48',
    '- **Falas:** 327',
    '',
    '---',
    '',
    '**[16:38:48] SYNC:** teste'
  ].join('\n');
  const rec = buildRecord('teams-transcricao-2026-07-13-1706.md', conteudo);
  assert.strictEqual(rec.dataISO, '2026-07-13');
  assert.strictEqual(rec.hora, '16:26');
  assert.strictEqual(rec.fim, null);
  assert.strictEqual(rec.titulo, 'Chamadas');
});

// 7) sem cabeçalho: cai no nome e conta falas do corpo
check('sem cabeçalho usa nome e conta falas', () => {
  const conteudo = '**[10:00:00] A:** oi\n**[10:00:05] B:** tudo bem';
  const rec = buildRecord('2026-07-15-1430-Calendar-Sem-Cabecalho.md', conteudo);
  assert.strictEqual(rec.dataISO, '2026-07-15');
  assert.strictEqual(rec.hora, '14:30');
  assert.strictEqual(rec.titulo, 'Calendar Sem Cabecalho');
  assert.strictEqual(rec.falas, 2);
});

console.log('\n' + ok + ' testes passaram.');
