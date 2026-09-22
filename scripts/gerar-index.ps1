#Requires -Version 5.1
<#
    Gerador do visualizador local de transcrições.
    Varre transcricoes/*.md e produz transcricoes/index.html self-contained
    (JSON embutido, zero CDN, zero fetch — abre offline via file://).

    Port do antigo gerar-index.js. O Node saiu da jogada porque a máquina onde
    o sync roda não tem Node instalado e nem sempre pode instalar — a geração
    do índice ficava silenciosamente pulada, e o espelho no OneDrive acabava
    sem a página de navegação. O resto do sync sempre foi PowerShell; carregar
    um runtime inteiro só para montar um HTML era desproporcional.

    Funções puras testadas por gerar-index.test.ps1:
        pwsh -NoProfile -ExecutionPolicy Bypass -File .\gerar-index.test.ps1
    (ou powershell.exe, é compatível com o Windows PowerShell 5.1)

    -SomenteFuncoes carrega as funções sem gerar nada; é como o teste
    consome este arquivo (dot-source).
#>
[CmdletBinding()]
param([switch]$SomenteFuncoes)

$ErrorActionPreference = 'Stop'

$PastaTranscricoes = Join-Path (Split-Path -Parent $PSScriptRoot) 'transcricoes'
$Saida = Join-Path $PastaTranscricoes 'index.html'

function Format-DataISO {
    param($Ano, $Mes, $Dia)
    '{0:0000}-{1:00}-{2:00}' -f [int]$Ano, [int]$Mes, [int]$Dia
}

# Parse do NOME do arquivo: AAAA-MM-DD-HHMM[-(n)]-Titulo-Com-Hifens.md
# Retorna $null quando o nome não segue o padrão (ex.: teams-transcricao-*.md).
function Resolve-NomeArquivo {
    param([string]$Nome)

    $base = $Nome -replace '\.md$', ''
    $m = [regex]::Match($base, '^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(?:-\((\d+)\))?-(.+)$')
    if (-not $m.Success) { return $null }

    $titulo = $m.Groups[7].Value -replace '-', ' '
    $titulo = $titulo -replace '\s+\(\d+\)\s*$', ''   # sufixo de colisão do filesystem: "Titulo (1)"
    $titulo = ($titulo -replace '\s+', ' ').Trim()

    [pscustomobject]@{
        dataISO  = Format-DataISO $m.Groups[1].Value $m.Groups[2].Value $m.Groups[3].Value
        horaHHMM = $m.Groups[4].Value + ':' + $m.Groups[5].Value
        titulo   = $titulo
        colisao  = $(if ($m.Groups[6].Success) { $m.Groups[6].Value } else { $null })
    }
}

# Parse do CABEÇALHO do .md (fonte da verdade quando presente).
function Resolve-Cabecalho {
    param([string]$Conteudo)

    if ($null -eq $Conteudo) { $Conteudo = '' }

    $out = [pscustomobject]@{
        titulo = $null; dataISO = $null; horaHHMM = $null
        inicio = $null; fim = $null; falas = $null
    }

    $mt = [regex]::Match($Conteudo, '(?m)^#\s*Transcri[çc][aã]o\s*[—–-]\s*(.+?)\s*$')
    if ($mt.Success) { $out.titulo = ($mt.Groups[1].Value -replace '^\(\d+\)\s*', '').Trim() }

    $md  = [regex]::Match($Conteudo, '\*\*Data:\*\*\s*(\d{1,2})/(\d{1,2})/(\d{4})')
    $mi  = [regex]::Match($Conteudo, '\*\*In[íi]cio:\*\*\s*(?:(\d{1,2})/(\d{1,2})/(\d{4}),\s*)?(\d{1,2}:\d{2}:\d{2})')
    $mf  = [regex]::Match($Conteudo, '\*\*Fim:\*\*\s*(\d{1,2}:\d{2}:\d{2})')
    $mfa = [regex]::Match($Conteudo, '\*\*Falas:\*\*\s*(\d+)')

    if ($md.Success) {
        $out.dataISO = Format-DataISO $md.Groups[3].Value $md.Groups[2].Value $md.Groups[1].Value
    }
    elseif ($mi.Success -and $mi.Groups[3].Success) {
        $out.dataISO = Format-DataISO $mi.Groups[3].Value $mi.Groups[2].Value $mi.Groups[1].Value
    }

    if ($mi.Success) {
        $out.inicio = $mi.Groups[4].Value
        $out.horaHHMM = $mi.Groups[4].Value.Substring(0, 5)
    }
    if ($mf.Success)  { $out.fim = $mf.Groups[1].Value }
    if ($mfa.Success) { $out.falas = [int]$mfa.Groups[1].Value }

    $out
}

function Measure-Falas {
    param([string]$Conteudo)
    if ($null -eq $Conteudo) { return 0 }
    [regex]::Matches($Conteudo, '(?m)^\*\*\[\d{1,2}:\d{2}:\d{2}\]').Count
}

# Monta o registro final combinando cabeçalho (prioritário) e nome do arquivo.
function New-Registro {
    param([string]$Nome, [string]$Conteudo)

    $doNome = Resolve-NomeArquivo -Nome $Nome
    $h = Resolve-Cabecalho -Conteudo $Conteudo

    $dataISO = $h.dataISO
    if (-not $dataISO) { $dataISO = $(if ($doNome) { $doNome.dataISO } else { $null }) }
    if (-not $dataISO) { $dataISO = '0000-00-00' }

    $hora = $h.horaHHMM
    if (-not $hora) { $hora = $(if ($doNome) { $doNome.horaHHMM } else { $null }) }
    if (-not $hora) { $hora = '00:00' }

    $titulo = $h.titulo
    if (-not $titulo) { $titulo = $(if ($doNome) { $doNome.titulo } else { $null }) }
    if (-not $titulo) { $titulo = $Nome -replace '\.md$', '' }

    $falas = $(if ($null -ne $h.falas) { $h.falas } else { Measure-Falas -Conteudo $Conteudo })

    [pscustomobject]@{
        id       = $Nome
        titulo   = $titulo
        dataISO  = $dataISO
        hora     = $hora
        inicio   = $h.inicio
        fim      = $h.fim
        falas    = $falas
        conteudo = $Conteudo
        sortKey  = $dataISO + ' ' + $hora
    }
}

function Get-Registros {
    param([string]$Pasta)

    if (-not (Test-Path -LiteralPath $Pasta)) { return @() }

    $registros = New-Object System.Collections.ArrayList
    foreach ($arq in Get-ChildItem -LiteralPath $Pasta -Filter *.md -File -ErrorAction SilentlyContinue) {
        # ReadAllText em vez de Get-Content: sem ambiguidade de codificação e
        # sem montar array de linhas para depois juntar de novo.
        $conteudo = [System.IO.File]::ReadAllText($arq.FullName, [System.Text.Encoding]::UTF8)
        [void]$registros.Add((New-Registro -Nome $arq.Name -Conteudo $conteudo))
    }

    # Mais recente primeiro. sortKey é "AAAA-MM-DD HH:MM", só dígitos e
    # separadores ASCII, então ordenação de texto já é ordenação cronológica.
    @($registros | Sort-Object -Property sortKey -Descending)
}

# Escapa uma string para literal JSON. Feito à mão, e não com ConvertTo-Json,
# por dois motivos: o ConvertTo-Json do PS 5.1 engasga com megabytes de
# transcrição, e aqui precisamos escapar < > & de propósito — o JSON vai
# embutido num <script>, e um "</script>" no meio de uma fala encerraria a tag.
function ConvertTo-JsonTexto {
    param($Texto)

    if ($null -eq $Texto) { return 'null' }

    $s = [string]$Texto
    $s = $s.Replace('\', '\\').Replace('"', '\"')      # a barra tem de vir primeiro
    $s = $s.Replace("`r", '\r').Replace("`n", '\n').Replace("`t", '\t')
    $s = $s.Replace([string][char]8, '\b').Replace([string][char]12, '\f')
    $s = $s.Replace('<', '<').Replace('>', '>').Replace('&', '&')
    $s = $s.Replace([string][char]0x2028, ' ').Replace([string][char]0x2029, ' ')
    # Sobras de controle (raras): viram \u00XX em vez de quebrar o JSON.
    $s = [regex]::Replace($s, '[\x00-\x1F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })

    '"' + $s + '"'
}

function ConvertTo-JsonRegistros {
    param($Registros)

    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('[')
    $primeiro = $true
    foreach ($r in $Registros) {
        if (-not $primeiro) { [void]$sb.Append(',') }
        $primeiro = $false
        [void]$sb.Append('{"id":').Append((ConvertTo-JsonTexto $r.id))
        [void]$sb.Append(',"titulo":').Append((ConvertTo-JsonTexto $r.titulo))
        [void]$sb.Append(',"dataISO":').Append((ConvertTo-JsonTexto $r.dataISO))
        [void]$sb.Append(',"hora":').Append((ConvertTo-JsonTexto $r.hora))
        [void]$sb.Append(',"inicio":').Append((ConvertTo-JsonTexto $r.inicio))
        [void]$sb.Append(',"fim":').Append((ConvertTo-JsonTexto $r.fim))
        [void]$sb.Append(',"falas":').Append([string][int]$r.falas)
        [void]$sb.Append(',"conteudo":').Append((ConvertTo-JsonTexto $r.conteudo))
        [void]$sb.Append(',"sortKey":').Append((ConvertTo-JsonTexto $r.sortKey))
        [void]$sb.Append('}')
    }
    [void]$sb.Append(']')
    $sb.ToString()
}

# Here-string literal: nada aqui dentro é interpolado pelo PowerShell, então o
# HTML/CSS/JS da página fica idêntico ao original, sem escaping.
$PAGINA = @'
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Transcrições — Transcreve Agenda</title>
<style>
:root{
  --bg:#0f1220; --surface:#171a2b; --surface-2:#1f2438; --border:#2a3050;
  --text:#eef0f8; --muted:#aeb4d4; --accent:#8a8ef0; --accent-2:#6b6fd6;
  --warn:#f0b64c; --radius:10px;
  --font:"Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:radial-gradient(120% 120% at 0% 0%,#1a1f38 0%,var(--bg) 55%);
  color:var(--text);font-family:var(--font);display:flex;flex-direction:column;height:100vh}
header.topo{display:flex;align-items:center;gap:16px;padding:14px 20px;
  border-bottom:1px solid var(--border);background:rgba(23,26,43,.6);flex:0 0 auto}
header.topo h1{font-size:16px;margin:0;font-weight:600;letter-spacing:.2px}
header.topo .contador{color:var(--muted);font-size:13px}
.busca{flex:1;max-width:520px;position:relative}
.busca input{width:100%;padding:9px 12px;border-radius:var(--radius);border:1px solid var(--border);
  background:var(--surface-2);color:var(--text);font-size:14px;font-family:inherit}
.busca input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.layout{display:flex;flex:1;min-height:0}
nav.sidebar{width:340px;flex:0 0 340px;border-right:1px solid var(--border);overflow-y:auto;
  background:rgba(15,18,32,.4)}
nav.sidebar ul{list-style:none;margin:0;padding:0}
.grupo-data{position:sticky;top:0;background:var(--surface);color:var(--muted);
  font-size:12px;text-transform:capitalize;padding:8px 16px;border-bottom:1px solid var(--border);
  border-top:1px solid var(--border);z-index:1;letter-spacing:.3px}
li.item{padding:10px 16px;border-bottom:1px solid rgba(42,48,80,.5);cursor:pointer;outline:none}
li.item:hover{background:var(--surface-2)}
li.item:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
li.item[aria-selected="true"]{background:rgba(138,142,240,.14);
  box-shadow:inset 3px 0 0 var(--accent)}
li.item .linha1{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
li.item .hora{color:var(--accent);font-size:12px;font-variant-numeric:tabular-nums;flex:0 0 auto}
li.item .falas{color:var(--muted);font-size:11px;flex:0 0 auto}
li.item .nome{font-size:13px;line-height:1.35;margin-top:3px;color:var(--text)}
main.painel{flex:1;overflow-y:auto;padding:26px 34px;min-width:0}
.vazio-painel{color:var(--muted);margin-top:12vh;text-align:center;font-size:15px}
.doc-head{border-bottom:1px solid var(--border);padding-bottom:16px;margin-bottom:20px}
.doc-head h2{margin:0 0 8px;font-size:22px;line-height:1.25}
.doc-head .meta{color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;gap:16px}
.doc-head .meta b{color:var(--text);font-weight:600}
.acoes{display:flex;gap:10px;margin-top:14px}
.acoes button{padding:7px 14px;border-radius:8px;border:1px solid var(--border);
  background:var(--surface-2);color:var(--text);font-size:13px;cursor:pointer;font-family:inherit}
.acoes button:hover{border-color:var(--accent);color:#fff}
.acoes button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.falas-lista{display:flex;flex-direction:column;gap:12px;max-width:820px}
.fala{display:grid;grid-template-columns:70px 1fr;gap:12px;align-items:baseline}
.fala .t{color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums;padding-top:2px}
.fala .c .sp{font-weight:600;color:var(--accent);margin-right:6px}
.fala .c .tx{color:var(--text);line-height:1.5}
.linha-solta{color:var(--text);line-height:1.5;max-width:820px}
.vazio-geral{margin:auto;text-align:center;color:var(--muted);padding:40px}
.vazio-geral h2{color:var(--text);font-weight:600;margin-bottom:8px}
mark{background:rgba(240,182,76,.35);color:#fff;border-radius:2px}
@media (max-width:760px){nav.sidebar{width:44%;flex-basis:44%}main.painel{padding:18px}}
</style>
</head>
<body>
<header class="topo">
  <h1>Transcrições</h1>
  <span class="contador" id="contador" aria-live="polite"></span>
  <div class="busca"><input id="busca" type="search" placeholder="Buscar por reunião, data ou conteúdo…" aria-label="Buscar transcrições"></div>
</header>
<div class="layout">
  <nav class="sidebar" aria-label="Lista de transcrições"><ul id="lista" role="listbox" aria-label="Transcrições" tabindex="0"></ul></nav>
  <main class="painel" id="painel" tabindex="-1"><p class="vazio-painel" id="vaziopainel">Selecione uma transcrição na lista.</p></main>
</div>
<script id="dados" type="application/json">/*__DADOS__*/</script>
<script>
"use strict";
(function(){
  var REG = JSON.parse(document.getElementById("dados").textContent);
  var DIAS = ["domingo","segunda","terça","quarta","quinta","sexta","sábado"];
  var lista = document.getElementById("lista");
  var painel = document.getElementById("painel");
  var contador = document.getElementById("contador");
  var busca = document.getElementById("busca");
  var selecionadoId = null;

  function dataExtenso(isoDate){
    var p = isoDate.split("-");
    var d = new Date(Number(p[0]), Number(p[1])-1, Number(p[2]));
    var dm = p[2]+"/"+p[1]+"/"+p[0];
    if(isNaN(d.getTime())) return dm;
    return DIAS[d.getDay()]+", "+dm;
  }
  function dataCurta(isoDate){var p=isoDate.split("-");return p[2]+"/"+p[1]+"/"+p[0];}

  // haystack de busca por registro (título + datas + conteúdo)
  REG.forEach(function(r){
    r._hay = (r.titulo+" "+r.dataISO+" "+dataCurta(r.dataISO)+" "+(r.conteudo||"")).toLowerCase();
  });

  function corpo(conteudo){
    var partes = (conteudo||"").split(/\n-{3,}\n/);
    return partes.length > 1 ? partes.slice(1).join("\n---\n") : (conteudo||"");
  }

  function el(tag, cls, txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e;}

  function renderFalas(container, conteudo){
    var linhas = corpo(conteudo).split(/\r?\n/);
    var wrap = el("div","falas-lista");
    var re = /^\*\*\[(\d{1,2}:\d{2}:\d{2})\]\s*(.+?):\*\*\s*(.*)$/;
    for(var i=0;i<linhas.length;i++){
      var linha = linhas[i];
      if(!linha.trim()) continue;
      var m = linha.match(re);
      if(m){
        var fala = el("div","fala");
        fala.appendChild(el("div","t",m[1]));
        var c = el("div","c");
        c.appendChild(el("span","sp",m[2]));
        c.appendChild(el("span","tx",m[3]));
        fala.appendChild(c);
        wrap.appendChild(fala);
      } else {
        wrap.appendChild(el("p","linha-solta",linha));
      }
    }
    container.appendChild(wrap);
  }

  function abrir(r){
    selecionadoId = r.id;
    marcarSelecao();
    painel.innerHTML = "";
    var head = el("div","doc-head");
    head.appendChild(el("h2",null,r.titulo));
    var meta = el("div","meta");
    var b1 = el("span",null,null); b1.appendChild(el("b",null,"Data: ")); b1.appendChild(document.createTextNode(dataExtenso(r.dataISO))); meta.appendChild(b1);
    if(r.inicio){var b2=el("span",null,null);b2.appendChild(el("b",null,"Horário: "));b2.appendChild(document.createTextNode(r.inicio+(r.fim?" → "+r.fim:"")));meta.appendChild(b2);}
    var b3 = el("span",null,null); b3.appendChild(el("b",null,"Falas: ")); b3.appendChild(document.createTextNode(String(r.falas))); meta.appendChild(b3);
    head.appendChild(meta);
    var acoes = el("div","acoes");
    var bd = el("button",null,"Baixar .md"); bd.type="button"; bd.addEventListener("click",function(){baixar(r);});
    var bc = el("button",null,"Copiar"); bc.type="button"; bc.addEventListener("click",function(){copiar(r,bc);});
    acoes.appendChild(bd); acoes.appendChild(bc);
    head.appendChild(acoes);
    painel.appendChild(head);
    renderFalas(painel, r.conteudo);
    painel.scrollTop = 0;
  }

  function baixar(r){
    var blob = new Blob([r.conteudo||""], {type:"text/markdown;charset=utf-8"});
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = r.id;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function(){URL.revokeObjectURL(url);}, 1000);
  }

  function copiar(r, botao){
    var texto = r.conteudo||"";
    var done = function(){var o=botao.textContent;botao.textContent="Copiado";setTimeout(function(){botao.textContent=o;},1400);};
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(texto).then(done, function(){fallbackCopy(texto,done);});
    } else { fallbackCopy(texto, done); }
  }
  function fallbackCopy(texto, done){
    var ta = document.createElement("textarea");
    ta.value = texto; ta.setAttribute("readonly",""); ta.style.position="fixed"; ta.style.left="-9999px";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } finally { document.body.removeChild(ta); }
  }

  function marcarSelecao(){
    var itens = lista.querySelectorAll("li.item");
    for(var i=0;i<itens.length;i++){
      var sel = itens[i].getAttribute("data-id")===selecionadoId;
      itens[i].setAttribute("aria-selected", sel?"true":"false");
    }
  }

  function construirLista(filtro){
    lista.innerHTML = "";
    var termo = (filtro||"").trim().toLowerCase();
    var vis = termo ? REG.filter(function(r){return r._hay.indexOf(termo)>=0;}) : REG;
    contador.textContent = REG.length + (REG.length===1?" reunião":" reuniões") + (termo? " · "+vis.length+" encontradas":"");
    if(!vis.length){
      var li = el("li",null, termo?"Nenhum resultado.":"Nenhuma transcrição ainda.");
      li.style.padding="16px"; li.style.color="var(--muted)"; li.style.fontSize="13px";
      lista.appendChild(li); return;
    }
    var dataAtual = null;
    vis.forEach(function(r){
      if(r.dataISO!==dataAtual){
        dataAtual = r.dataISO;
        var h = el("li","grupo-data",dataExtenso(r.dataISO));
        h.setAttribute("role","presentation");
        lista.appendChild(h);
      }
      var li = el("li","item");
      li.setAttribute("role","option");
      li.setAttribute("data-id",r.id);
      li.setAttribute("tabindex","-1");
      li.setAttribute("aria-selected", r.id===selecionadoId?"true":"false");
      var l1 = el("div","linha1");
      l1.appendChild(el("span","hora",r.hora));
      l1.appendChild(el("span","falas",r.falas+" falas"));
      li.appendChild(l1);
      li.appendChild(el("div","nome",r.titulo));
      li.addEventListener("click",function(){var id=this.getAttribute("data-id");abrir(porId(id));});
      lista.appendChild(li);
    });
  }

  function porId(id){for(var i=0;i<REG.length;i++){if(REG[i].id===id)return REG[i];}return null;}

  // Navegação por teclado na lista (setas + Enter/Espaço)
  lista.addEventListener("keydown",function(ev){
    var itens = Array.prototype.slice.call(lista.querySelectorAll("li.item"));
    if(!itens.length) return;
    var atual = document.activeElement;
    var idx = itens.indexOf(atual);
    if(ev.key==="ArrowDown"){ev.preventDefault(); idx = idx<0?0:Math.min(idx+1,itens.length-1); itens[idx].focus();}
    else if(ev.key==="ArrowUp"){ev.preventDefault(); idx = idx<0?0:Math.max(idx-1,0); itens[idx].focus();}
    else if(ev.key==="Home"){ev.preventDefault(); itens[0].focus();}
    else if(ev.key==="End"){ev.preventDefault(); itens[itens.length-1].focus();}
    else if((ev.key==="Enter"||ev.key===" ") && idx>=0){ev.preventDefault(); abrir(porId(itens[idx].getAttribute("data-id")));}
  });
  lista.addEventListener("focus",function(){
    if(document.activeElement===lista){var it=lista.querySelector("li.item");if(it)it.focus();}
  });

  var tBusca=null;
  busca.addEventListener("input",function(){
    clearTimeout(tBusca);
    tBusca = setTimeout(function(){construirLista(busca.value);}, 120);
  });

  if(!REG.length){
    painel.innerHTML = "";
    var v = el("div","vazio-geral");
    v.appendChild(el("h2",null,"Nenhuma transcrição ainda"));
    v.appendChild(el("p",null,"Quando o sync mover novos arquivos para a pasta, eles aparecem aqui."));
    painel.appendChild(v);
    contador.textContent = "0 reuniões";
  } else {
    construirLista("");
  }
})();
</script>
<!-- gerado em __GERADO_EM__ -->
</body>
</html>
'@

function New-PaginaHtml {
    param($Registros)
    $dados = ConvertTo-JsonRegistros -Registros $Registros
    $geradoEm = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    # .Replace() e não -replace: substituição literal, sem interpretar $ nem
    # regex no conteúdo das transcrições.
    $PAGINA.Replace('/*__DADOS__*/', $dados).Replace('__GERADO_EM__', $geradoEm)
}

function Invoke-GerarIndex {
    param([string]$Pasta = $PastaTranscricoes, [string]$Destino = $Saida)

    $registros = Get-Registros -Pasta $Pasta
    $html = New-PaginaHtml -Registros $registros

    if (-not (Test-Path -LiteralPath $Pasta)) {
        New-Item -ItemType Directory -Path $Pasta -Force | Out-Null
    }
    # UTF-8 sem BOM: o <meta charset> já declara, e o BOM só atrapalha quem
    # abre o arquivo por outros meios.
    [System.IO.File]::WriteAllText($Destino, $html, (New-Object System.Text.UTF8Encoding($false)))

    [pscustomobject]@{ total = @($registros).Count; saida = $Destino }
}

if (-not $SomenteFuncoes) {
    $r = Invoke-GerarIndex
    Write-Output ("Indexados {0} arquivo(s). index.html: {1}" -f $r.total, $r.saida)
}
