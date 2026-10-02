/**
 * Inspetor de DOM do Google Meet.
 *
 * Cola este arquivo inteiro no console (F12) de uma reunião do Meet com as
 * LEGENDAS LIGADAS, e ele devolve os seletores que o dom-adapter.js precisa
 * para capturar lá. Não altera nada na página: só lê e imprime.
 *
 * Como usar:
 *   1. Entrar na reunião e ligar as legendas (ícone CC na barra inferior)
 *   2. Esperar alguém falar, para que haja legenda na tela
 *   3. F12 → aba Console → colar tudo → Enter
 *   4. Copiar o relatório e mandar para o Claude
 *
 * O Meet troca classe a cada build, então o relatório prioriza o que é estável:
 * atributos semânticos (jsname, data-*, aria-*) acima de nome de classe.
 */
(function () {
  'use strict';

  const linhas = [];
  const diz = (s) => linhas.push(s);

  diz('=== INSPETOR DE DOM: GOOGLE MEET ===');
  diz('URL: ' + location.href);
  diz('Timestamp: ' + new Date().toISOString());
  diz('iframes: ' + window.frames.length);
  diz('');

  // ---------------------------------------------------------------- utilidades

  // Assinatura de um elemento: o que serve de seletor, do mais estável ao menos.
  function assinatura(el) {
    if (!el || !el.getAttribute) return '(sem elemento)';
    const partes = [];
    partes.push(el.tagName.toLowerCase());
    for (const attr of ['jsname', 'data-tid', 'data-self-name', 'data-participant-id', 'role', 'aria-label', 'data-is-persistent']) {
      const v = el.getAttribute(attr);
      if (v) partes.push(`[${attr}="${v.length > 50 ? v.slice(0, 50) + '…' : v}"]`);
    }
    const cls = (el.getAttribute('class') || '').trim();
    if (cls) partes.push('.' + cls.split(/\s+/).slice(0, 4).join('.'));
    return partes.join('');
  }

  // Caminho do elemento até o body, para entender a hierarquia do painel.
  function caminho(el, limite) {
    const saida = [];
    let n = el;
    let i = 0;
    while (n && n.tagName && n.tagName !== 'BODY' && i < (limite || 8)) {
      saida.push('  '.repeat(i) + assinatura(n));
      n = n.parentElement;
      i++;
    }
    return saida.reverse();
  }

  function visivel(el) {
    try {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (_e) {
      return false;
    }
  }

  // --------------------------------------------- 1. painel de legendas (o alvo)

  diz('### 1. CANDIDATOS A PAINEL DE LEGENDAS');
  diz('');

  // O Meet marca a região de legendas com aria-label em pt-BR ou en.
  const porAria = [
    '[aria-label*="egenda" i]',
    '[aria-label*="aption" i]',
    '[aria-label*="subtitul" i]',
    '[aria-label*="subtitle" i]',
    '[role="region"][aria-label]',
  ];
  for (const sel of porAria) {
    let achados;
    try {
      achados = document.querySelectorAll(sel);
    } catch (_e) {
      continue;
    }
    if (!achados.length) continue;
    diz(`  ${achados.length}  ${sel}`);
    for (const el of Array.from(achados).slice(0, 3)) {
      diz('     ' + assinatura(el) + (visivel(el) ? '  [visível]' : '  [oculto]'));
    }
  }
  diz('');

  // ------------------------------------- 2. busca pelo TEXTO da legenda na tela

  diz('### 2. ONDE O TEXTO FALADO ESTÁ (busca por conteúdo)');
  diz('Pegamos os blocos de texto do terço inferior da tela, que é onde a legenda aparece.');
  diz('');

  const vh = window.innerHeight || 0;
  const candidatos = [];
  const todos = document.querySelectorAll('div, span, p');
  for (const el of todos) {
    let r;
    try {
      r = el.getBoundingClientRect();
    } catch (_e) {
      continue;
    }
    if (!r.height || r.top < vh * 0.5) continue;      // só terço inferior
    if (r.width < 150 || r.height < 14) continue;
    const txt = (el.textContent || '').trim();
    if (txt.length < 15 || txt.length > 600) continue;
    // Descarta quem só embrulha: queremos o nó mais específico com o texto.
    const filhosComMesmoTexto = Array.from(el.children).filter(
      (c) => (c.textContent || '').trim() === txt
    );
    if (filhosComMesmoTexto.length) continue;
    candidatos.push({ el, txt, area: r.width * r.height });
  }
  candidatos.sort((a, b) => a.area - b.area);

  if (!candidatos.length) {
    diz('  NENHUM texto encontrado no terço inferior.');
    diz('  As legendas estão LIGADAS? Alguém falou nos últimos segundos?');
  } else {
    for (const c of candidatos.slice(0, 5)) {
      diz('  TEXTO: "' + c.txt.slice(0, 90) + (c.txt.length > 90 ? '…' : '') + '"');
      diz('  HIERARQUIA (de fora para dentro):');
      for (const l of caminho(c.el, 7)) diz('    ' + l);
      diz('');
    }
  }

  // ------------------------------------------------ 3. nome de quem está falando

  diz('### 3. CANDIDATOS A NOME DO FALANTE');
  diz('No Meet o nome costuma vir ao lado do texto, ou como atributo do bloco.');
  diz('');

  const atributosDeNome = ['data-self-name', 'data-participant-id', 'data-sender-name'];
  for (const attr of atributosDeNome) {
    const achados = document.querySelectorAll(`[${attr}]`);
    if (!achados.length) continue;
    diz(`  ${achados.length}  [${attr}]`);
    for (const el of Array.from(achados).slice(0, 3)) {
      diz(`     valor="${el.getAttribute(attr)}"  texto="${(el.textContent || '').trim().slice(0, 40)}"`);
    }
  }
  diz('');

  // ------------------------------------------------------ 4. UI de call (isInCall)

  diz('### 4. UI DE CHAMADA (para o isInCall reconhecer reunião ativa)');
  diz('');

  const uiChamada = [
    '[aria-label*="Sair da chamada" i]',
    '[aria-label*="Leave call" i]',
    '[aria-label*="Desativar microfone" i]',
    '[aria-label*="Turn off microphone" i]',
    '[aria-label*="microfone" i]',
    '[aria-label*="câmera" i]',
    '[aria-label*="camera" i]',
    '[aria-label*="Participantes" i]',
    '[aria-label*="people" i]',
    '[data-promo-anchor-id]',
    '[data-call-ended]',
  ];
  for (const sel of uiChamada) {
    let n = 0;
    try {
      n = document.querySelectorAll(sel).length;
    } catch (_e) {
      n = -1;
    }
    diz(`  ${n}  ${sel}`);
  }
  diz('');

  // -------------------------------------------- 5. identidade da reunião (URL)

  diz('### 5. IDENTIDADE DA REUNIÃO');
  const codigo = location.pathname.replace(/^\//, '').split('?')[0];
  diz('  pathname: ' + location.pathname);
  diz('  código provável: ' + (codigo || '(vazio)'));
  diz('  title: ' + document.title);
  diz('');

  // ------------------------------------------------------------ 6. jsname úteis

  diz('### 6. ATRIBUTOS jsname NO TERÇO INFERIOR');
  diz('jsname é mais estável que classe no Meet, embora mude entre builds.');
  diz('');
  const jsnames = {};
  for (const el of document.querySelectorAll('[jsname]')) {
    let r;
    try {
      r = el.getBoundingClientRect();
    } catch (_e) {
      continue;
    }
    if (!r.height || r.top < vh * 0.5) continue;
    const j = el.getAttribute('jsname');
    const txt = (el.textContent || '').trim();
    if (!jsnames[j]) jsnames[j] = { n: 0, exemplo: txt.slice(0, 50) };
    jsnames[j].n++;
  }
  const ordenados = Object.keys(jsnames).sort((a, b) => jsnames[b].n - jsnames[a].n);
  if (!ordenados.length) {
    diz('  (nenhum)');
  } else {
    for (const j of ordenados.slice(0, 15)) {
      diz(`  ${jsnames[j].n}×  jsname="${j}"  exemplo: "${jsnames[j].exemplo}"`);
    }
  }
  diz('');

  // ------------------------------------------------------------------- saída

  diz('=== FIM ===');

  const relatorio = linhas.join('\n');
  console.log(relatorio);

  // Tenta copiar para a área de transferência; se o navegador bloquear, fica só no console.
  try {
    if (typeof copy === 'function') {
      copy(relatorio);
      console.log('\n>>> Relatório copiado. Cole no chat com o Claude.');
    } else {
      navigator.clipboard.writeText(relatorio).then(
        () => console.log('\n>>> Relatório copiado. Cole no chat com o Claude.'),
        () => console.log('\n>>> Não consegui copiar: selecione o texto acima e copie à mão.')
      );
    }
  } catch (_e) {
    console.log('\n>>> Não consegui copiar: selecione o texto acima e copie à mão.');
  }

  return 'Relatório gerado. Veja acima.';
})();
