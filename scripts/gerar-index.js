#!/usr/bin/env node
'use strict';

/*
 * Gerador do visualizador local de transcrições.
 * Varre transcricoes/*.md e produz transcricoes/index.html self-contained
 * (JSON embutido, zero CDN, zero fetch — abre offline via file://).
 */

const fs = require('fs');
const path = require('path');

const PASTA_TRANSCRICOES = path.resolve(__dirname, '..', 'transcricoes');
const SAIDA = path.join(PASTA_TRANSCRICOES, 'index.html');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function iso(ano, mes, dia) {
  return ano + '-' + pad2(mes) + '-' + pad2(dia);
}

// Parse do NOME do arquivo: AAAA-MM-DD-HHMM[-(n)]-Titulo-Com-Hifens.md
// Retorna null quando o nome não segue o padrão (ex.: teams-transcricao-*.md).
function parseFilename(name) {
  const base = name.replace(/\.md$/i, '');
  const m = base.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(?:-\((\d+)\))?-(.+)$/);
  if (!m) return null;
  const resto = m[7];
  const titulo = resto
    .replace(/-/g, ' ')
    .replace(/\s+\(\d+\)\s*$/, '') // sufixo de colisão do filesystem: "Titulo (1)"
    .replace(/\s+/g, ' ')
    .trim();
  return {
    dataISO: iso(m[1], m[2], m[3]),
    horaHHMM: m[4] + ':' + m[5],
    titulo: titulo,
    colisao: m[6] || null
  };
}

// Parse do CABEÇALHO do .md (fonte da verdade quando presente).
function parseHeader(content) {
  const out = { titulo: null, dataISO: null, horaHHMM: null, inicio: null, fim: null, falas: null };

  const mt = content.match(/^#\s*Transcri[çc][aã]o\s*[—–-]\s*(.+?)\s*$/m);
  if (mt) out.titulo = mt[1].replace(/^\(\d+\)\s*/, '').trim();

  const md = content.match(/\*\*Data:\*\*\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  const mi = content.match(/\*\*In[íi]cio:\*\*\s*(?:(\d{1,2})\/(\d{1,2})\/(\d{4}),\s*)?(\d{1,2}:\d{2}:\d{2})/);
  const mf = content.match(/\*\*Fim:\*\*\s*(\d{1,2}:\d{2}:\d{2})/);
  const mfa = content.match(/\*\*Falas:\*\*\s*(\d+)/);

  if (md) out.dataISO = iso(md[3], md[2], md[1]);
  else if (mi && mi[3]) out.dataISO = iso(mi[3], mi[2], mi[1]);

  if (mi) {
    out.inicio = mi[4];
    out.horaHHMM = mi[4].slice(0, 5);
  }
  if (mf) out.fim = mf[1];
  if (mfa) out.falas = parseInt(mfa[1], 10);

  return out;
}

function contarFalas(content) {
  const m = content.match(/^\*\*\[\d{1,2}:\d{2}:\d{2}\]/gm);
  return m ? m.length : 0;
}

// Monta o registro final combinando cabeçalho (prioritário) e nome do arquivo.
function buildRecord(name, content) {
  const nome = parseFilename(name);
  const h = parseHeader(content || '');

  const dataISO = h.dataISO || (nome && nome.dataISO) || '0000-00-00';
  const hora = h.horaHHMM || (nome && nome.horaHHMM) || '00:00';
  const titulo = h.titulo || (nome && nome.titulo) || name.replace(/\.md$/i, '');
  const falas = h.falas != null ? h.falas : contarFalas(content);

  return {
    id: name,
    titulo: titulo,
    dataISO: dataISO,
    hora: hora,
    inicio: h.inicio,
    fim: h.fim,
    falas: falas,
    conteudo: content,
    sortKey: dataISO + ' ' + hora
  };
}

function coletarRegistros(pasta) {
  let entradas;
  try {
    entradas = fs.readdirSync(pasta);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
  const registros = [];
  for (const nome of entradas) {
    if (!nome.toLowerCase().endsWith('.md')) continue;
    const full = path.join(pasta, nome);
    if (!fs.statSync(full).isFile()) continue;
    const content = fs.readFileSync(full, 'utf8');
    registros.push(buildRecord(nome, content));
  }
  registros.sort((a, b) => (a.sortKey < b.sortKey ? 1 : a.sortKey > b.sortKey ? -1 : 0));
  return registros;
}

// Torna o JSON seguro dentro de <script> e resistente a caracteres de linha JS.
function jsonSeguro(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function montarHtml(registros) {
  const dados = jsonSeguro(registros);
  const geradoEm = new Date().toISOString();
  return PAGINA.replace('/*__DADOS__*/', dados).replace('__GERADO_EM__', geradoEm);
}

// CSS e JS do cliente ficam sem backticks e sem "${" para conviverem
// dentro deste template literal do Node sem escaping frágil.
const PAGINA = [
'<!DOCTYPE html>',
'<html lang="pt-BR">',
'<head>',
'<meta charset="utf-8">',
'<meta name="viewport" content="width=device-width, initial-scale=1">',
'<title>Transcrições — Transcreve Agenda</title>',
'<style>',
':root{',
'  --bg:#0f1220; --surface:#171a2b; --surface-2:#1f2438; --border:#2a3050;',
'  --text:#eef0f8; --muted:#aeb4d4; --accent:#8a8ef0; --accent-2:#6b6fd6;',
'  --warn:#f0b64c; --radius:10px;',
'  --font:"Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;',
'}',
'*{box-sizing:border-box}',
'html,body{height:100%}',
'body{margin:0;background:radial-gradient(120% 120% at 0% 0%,#1a1f38 0%,var(--bg) 55%);',
'  color:var(--text);font-family:var(--font);display:flex;flex-direction:column;height:100vh}',
'header.topo{display:flex;align-items:center;gap:16px;padding:14px 20px;',
'  border-bottom:1px solid var(--border);background:rgba(23,26,43,.6);flex:0 0 auto}',
'header.topo h1{font-size:16px;margin:0;font-weight:600;letter-spacing:.2px}',
'header.topo .contador{color:var(--muted);font-size:13px}',
'.busca{flex:1;max-width:520px;position:relative}',
'.busca input{width:100%;padding:9px 12px;border-radius:var(--radius);border:1px solid var(--border);',
'  background:var(--surface-2);color:var(--text);font-size:14px;font-family:inherit}',
'.busca input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}',
'.layout{display:flex;flex:1;min-height:0}',
'nav.sidebar{width:340px;flex:0 0 340px;border-right:1px solid var(--border);overflow-y:auto;',
'  background:rgba(15,18,32,.4)}',
'nav.sidebar ul{list-style:none;margin:0;padding:0}',
'.grupo-data{position:sticky;top:0;background:var(--surface);color:var(--muted);',
'  font-size:12px;text-transform:capitalize;padding:8px 16px;border-bottom:1px solid var(--border);',
'  border-top:1px solid var(--border);z-index:1;letter-spacing:.3px}',
'li.item{padding:10px 16px;border-bottom:1px solid rgba(42,48,80,.5);cursor:pointer;outline:none}',
'li.item:hover{background:var(--surface-2)}',
'li.item:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}',
'li.item[aria-selected="true"]{background:rgba(138,142,240,.14);',
'  box-shadow:inset 3px 0 0 var(--accent)}',
'li.item .linha1{display:flex;justify-content:space-between;gap:8px;align-items:baseline}',
'li.item .hora{color:var(--accent);font-size:12px;font-variant-numeric:tabular-nums;flex:0 0 auto}',
'li.item .falas{color:var(--muted);font-size:11px;flex:0 0 auto}',
'li.item .nome{font-size:13px;line-height:1.35;margin-top:3px;color:var(--text)}',
'main.painel{flex:1;overflow-y:auto;padding:26px 34px;min-width:0}',
'.vazio-painel{color:var(--muted);margin-top:12vh;text-align:center;font-size:15px}',
'.doc-head{border-bottom:1px solid var(--border);padding-bottom:16px;margin-bottom:20px}',
'.doc-head h2{margin:0 0 8px;font-size:22px;line-height:1.25}',
'.doc-head .meta{color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;gap:16px}',
'.doc-head .meta b{color:var(--text);font-weight:600}',
'.acoes{display:flex;gap:10px;margin-top:14px}',
'.acoes button{padding:7px 14px;border-radius:8px;border:1px solid var(--border);',
'  background:var(--surface-2);color:var(--text);font-size:13px;cursor:pointer;font-family:inherit}',
'.acoes button:hover{border-color:var(--accent);color:#fff}',
'.acoes button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}',
'.falas-lista{display:flex;flex-direction:column;gap:12px;max-width:820px}',
'.fala{display:grid;grid-template-columns:70px 1fr;gap:12px;align-items:baseline}',
'.fala .t{color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums;padding-top:2px}',
'.fala .c .sp{font-weight:600;color:var(--accent);margin-right:6px}',
'.fala .c .tx{color:var(--text);line-height:1.5}',
'.linha-solta{color:var(--text);line-height:1.5;max-width:820px}',
'.vazio-geral{margin:auto;text-align:center;color:var(--muted);padding:40px}',
'.vazio-geral h2{color:var(--text);font-weight:600;margin-bottom:8px}',
'mark{background:rgba(240,182,76,.35);color:#fff;border-radius:2px}',
'@media (max-width:760px){nav.sidebar{width:44%;flex-basis:44%}main.painel{padding:18px}}',
'</style>',
'</head>',
'<body>',
'<header class="topo">',
'  <h1>Transcrições</h1>',
'  <span class="contador" id="contador" aria-live="polite"></span>',
'  <div class="busca"><input id="busca" type="search" placeholder="Buscar por reunião, data ou conteúdo…" aria-label="Buscar transcrições"></div>',
'</header>',
'<div class="layout">',
'  <nav class="sidebar" aria-label="Lista de transcrições"><ul id="lista" role="listbox" aria-label="Transcrições" tabindex="0"></ul></nav>',
'  <main class="painel" id="painel" tabindex="-1"><p class="vazio-painel" id="vaziopainel">Selecione uma transcrição na lista.</p></main>',
'</div>',
'<script id="dados" type="application/json">/*__DADOS__*/</script>',
'<script>',
'"use strict";',
'(function(){',
'  var REG = JSON.parse(document.getElementById("dados").textContent);',
'  var DIAS = ["domingo","segunda","terça","quarta","quinta","sexta","sábado"];',
'  var lista = document.getElementById("lista");',
'  var painel = document.getElementById("painel");',
'  var contador = document.getElementById("contador");',
'  var busca = document.getElementById("busca");',
'  var selecionadoId = null;',
'',
'  function dataExtenso(isoDate){',
'    var p = isoDate.split("-");',
'    var d = new Date(Number(p[0]), Number(p[1])-1, Number(p[2]));',
'    var dm = p[2]+"/"+p[1]+"/"+p[0];',
'    if(isNaN(d.getTime())) return dm;',
'    return DIAS[d.getDay()]+", "+dm;',
'  }',
'  function dataCurta(isoDate){var p=isoDate.split("-");return p[2]+"/"+p[1]+"/"+p[0];}',
'',
'  // haystack de busca por registro (título + datas + conteúdo)',
'  REG.forEach(function(r){',
'    r._hay = (r.titulo+" "+r.dataISO+" "+dataCurta(r.dataISO)+" "+(r.conteudo||"")).toLowerCase();',
'  });',
'',
'  function corpo(conteudo){',
'    var partes = (conteudo||"").split(/\\n-{3,}\\n/);',
'    return partes.length > 1 ? partes.slice(1).join("\\n---\\n") : (conteudo||"");',
'  }',
'',
'  function el(tag, cls, txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e;}',
'',
'  function renderFalas(container, conteudo){',
'    var linhas = corpo(conteudo).split(/\\r?\\n/);',
'    var wrap = el("div","falas-lista");',
'    var re = /^\\*\\*\\[(\\d{1,2}:\\d{2}:\\d{2})\\]\\s*(.+?):\\*\\*\\s*(.*)$/;',
'    for(var i=0;i<linhas.length;i++){',
'      var linha = linhas[i];',
'      if(!linha.trim()) continue;',
'      var m = linha.match(re);',
'      if(m){',
'        var fala = el("div","fala");',
'        fala.appendChild(el("div","t",m[1]));',
'        var c = el("div","c");',
'        c.appendChild(el("span","sp",m[2]));',
'        c.appendChild(el("span","tx",m[3]));',
'        fala.appendChild(c);',
'        wrap.appendChild(fala);',
'      } else {',
'        wrap.appendChild(el("p","linha-solta",linha));',
'      }',
'    }',
'    container.appendChild(wrap);',
'  }',
'',
'  function abrir(r){',
'    selecionadoId = r.id;',
'    marcarSelecao();',
'    painel.innerHTML = "";',
'    var head = el("div","doc-head");',
'    head.appendChild(el("h2",null,r.titulo));',
'    var meta = el("div","meta");',
'    var b1 = el("span",null,null); b1.appendChild(el("b",null,"Data: ")); b1.appendChild(document.createTextNode(dataExtenso(r.dataISO))); meta.appendChild(b1);',
'    if(r.inicio){var b2=el("span",null,null);b2.appendChild(el("b",null,"Horário: "));b2.appendChild(document.createTextNode(r.inicio+(r.fim?" → "+r.fim:"")));meta.appendChild(b2);}',
'    var b3 = el("span",null,null); b3.appendChild(el("b",null,"Falas: ")); b3.appendChild(document.createTextNode(String(r.falas))); meta.appendChild(b3);',
'    head.appendChild(meta);',
'    var acoes = el("div","acoes");',
'    var bd = el("button",null,"Baixar .md"); bd.type="button"; bd.addEventListener("click",function(){baixar(r);});',
'    var bc = el("button",null,"Copiar"); bc.type="button"; bc.addEventListener("click",function(){copiar(r,bc);});',
'    acoes.appendChild(bd); acoes.appendChild(bc);',
'    head.appendChild(acoes);',
'    painel.appendChild(head);',
'    renderFalas(painel, r.conteudo);',
'    painel.scrollTop = 0;',
'  }',
'',
'  function baixar(r){',
'    var blob = new Blob([r.conteudo||""], {type:"text/markdown;charset=utf-8"});',
'    var url = URL.createObjectURL(blob);',
'    var a = document.createElement("a");',
'    a.href = url; a.download = r.id;',
'    document.body.appendChild(a); a.click(); document.body.removeChild(a);',
'    setTimeout(function(){URL.revokeObjectURL(url);}, 1000);',
'  }',
'',
'  function copiar(r, botao){',
'    var texto = r.conteudo||"";',
'    var done = function(){var o=botao.textContent;botao.textContent="Copiado";setTimeout(function(){botao.textContent=o;},1400);};',
'    if(navigator.clipboard && navigator.clipboard.writeText){',
'      navigator.clipboard.writeText(texto).then(done, function(){fallbackCopy(texto,done);});',
'    } else { fallbackCopy(texto, done); }',
'  }',
'  function fallbackCopy(texto, done){',
'    var ta = document.createElement("textarea");',
'    ta.value = texto; ta.setAttribute("readonly",""); ta.style.position="fixed"; ta.style.left="-9999px";',
'    document.body.appendChild(ta); ta.select();',
'    try { document.execCommand("copy"); done(); } finally { document.body.removeChild(ta); }',
'  }',
'',
'  function marcarSelecao(){',
'    var itens = lista.querySelectorAll("li.item");',
'    for(var i=0;i<itens.length;i++){',
'      var sel = itens[i].getAttribute("data-id")===selecionadoId;',
'      itens[i].setAttribute("aria-selected", sel?"true":"false");',
'    }',
'  }',
'',
'  function construirLista(filtro){',
'    lista.innerHTML = "";',
'    var termo = (filtro||"").trim().toLowerCase();',
'    var vis = termo ? REG.filter(function(r){return r._hay.indexOf(termo)>=0;}) : REG;',
'    contador.textContent = REG.length + (REG.length===1?" reunião":" reuniões") + (termo? " · "+vis.length+" encontradas":"");',
'    if(!vis.length){',
'      var li = el("li",null, termo?"Nenhum resultado.":"Nenhuma transcrição ainda.");',
'      li.style.padding="16px"; li.style.color="var(--muted)"; li.style.fontSize="13px";',
'      lista.appendChild(li); return;',
'    }',
'    var dataAtual = null;',
'    vis.forEach(function(r){',
'      if(r.dataISO!==dataAtual){',
'        dataAtual = r.dataISO;',
'        var h = el("li","grupo-data",dataExtenso(r.dataISO));',
'        h.setAttribute("role","presentation");',
'        lista.appendChild(h);',
'      }',
'      var li = el("li","item");',
'      li.setAttribute("role","option");',
'      li.setAttribute("data-id",r.id);',
'      li.setAttribute("tabindex","-1");',
'      li.setAttribute("aria-selected", r.id===selecionadoId?"true":"false");',
'      var l1 = el("div","linha1");',
'      l1.appendChild(el("span","hora",r.hora));',
'      l1.appendChild(el("span","falas",r.falas+" falas"));',
'      li.appendChild(l1);',
'      li.appendChild(el("div","nome",r.titulo));',
'      li.addEventListener("click",function(){var id=this.getAttribute("data-id");abrir(porId(id));});',
'      lista.appendChild(li);',
'    });',
'  }',
'',
'  function porId(id){for(var i=0;i<REG.length;i++){if(REG[i].id===id)return REG[i];}return null;}',
'',
'  // Navegação por teclado na lista (setas + Enter/Espaço)',
'  lista.addEventListener("keydown",function(ev){',
'    var itens = Array.prototype.slice.call(lista.querySelectorAll("li.item"));',
'    if(!itens.length) return;',
'    var atual = document.activeElement;',
'    var idx = itens.indexOf(atual);',
'    if(ev.key==="ArrowDown"){ev.preventDefault(); idx = idx<0?0:Math.min(idx+1,itens.length-1); itens[idx].focus();}',
'    else if(ev.key==="ArrowUp"){ev.preventDefault(); idx = idx<0?0:Math.max(idx-1,0); itens[idx].focus();}',
'    else if(ev.key==="Home"){ev.preventDefault(); itens[0].focus();}',
'    else if(ev.key==="End"){ev.preventDefault(); itens[itens.length-1].focus();}',
'    else if((ev.key==="Enter"||ev.key===" ") && idx>=0){ev.preventDefault(); abrir(porId(itens[idx].getAttribute("data-id")));}',
'  });',
'  lista.addEventListener("focus",function(){',
'    if(document.activeElement===lista){var it=lista.querySelector("li.item");if(it)it.focus();}',
'  });',
'',
'  var tBusca=null;',
'  busca.addEventListener("input",function(){',
'    clearTimeout(tBusca);',
'    tBusca = setTimeout(function(){construirLista(busca.value);}, 120);',
'  });',
'',
'  if(!REG.length){',
'    painel.innerHTML = "";',
'    var v = el("div","vazio-geral");',
'    v.appendChild(el("h2",null,"Nenhuma transcrição ainda"));',
'    v.appendChild(el("p",null,"Quando o sync mover novos arquivos para a pasta, eles aparecem aqui."));',
'    painel.appendChild(v);',
'    contador.textContent = "0 reuniões";',
'  } else {',
'    construirLista("");',
'  }',
'})();',
'</script>',
'<!-- gerado em __GERADO_EM__ -->',
'</body>',
'</html>'
].join('\n');

function gerar() {
  const registros = coletarRegistros(PASTA_TRANSCRICOES);
  const html = montarHtml(registros);
  fs.mkdirSync(PASTA_TRANSCRICOES, { recursive: true });
  fs.writeFileSync(SAIDA, html, 'utf8');
  return { total: registros.length, saida: SAIDA };
}

if (require.main === module) {
  const r = gerar();
  console.log('Indexados ' + r.total + ' arquivo(s). index.html: ' + r.saida);
}

module.exports = { parseFilename, parseHeader, buildRecord, contarFalas, gerar };
