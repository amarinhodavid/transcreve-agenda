#Requires -Version 5.1
<#
    Testes das funções puras de gerar-index.ps1.
    Roda com:  powershell -NoProfile -ExecutionPolicy Bypass -File .\gerar-index.test.ps1
    (ou pwsh, tanto faz). Sai com código 1 se algum caso falhar.

    Os casos 1 a 7 são o port direto de gerar-index.test.js, mantidos com os
    mesmos nomes e as mesmas fixtures para que uma divergência de parse entre
    as duas implementações apareça como falha.
    Os casos 8 em diante cobrem o serializador JSON, que não existia na versão
    Node (lá o JSON.stringify do próprio runtime fazia o trabalho).
#>
[CmdletBinding()]
param()

$gerador = Join-Path $PSScriptRoot 'gerar-index.ps1'
. $gerador -SomenteFuncoes

$script:ok = 0
$script:falhou = 0

function Test-Caso {
    param([string]$Nome, [scriptblock]$Corpo)
    try {
        & $Corpo
        $script:ok++
        Write-Host ('  ok      ' + $Nome)
    }
    catch {
        $script:falhou++
        Write-Host ('  FALHOU  ' + $Nome) -ForegroundColor Red
        Write-Host ('          ' + $_.Exception.Message) -ForegroundColor Red
    }
}

function Assert-Igual {
    param($Esperado, $Obtido, [string]$Contexto)
    if ($Esperado -ne $Obtido) {
        $ctx = if ($Contexto) { $Contexto + ': ' } else { '' }
        throw ('{0}esperado <{1}>, obtido <{2}>' -f $ctx, $Esperado, $Obtido)
    }
}

function Assert-Verdadeiro {
    param($Condicao, [string]$Contexto)
    if (-not $Condicao) { throw ($(if ($Contexto) { $Contexto } else { 'condição falsa' })) }
}

# 1) parse do nome: data, hora e título (sem o sufixo de colisão -(n))
Test-Caso 'Resolve-NomeArquivo extrai data/hora/titulo' {
    $r = Resolve-NomeArquivo '2026-07-14-0900-(1)-Calendar-Daily-Segurança.md'
    Assert-Igual '2026-07-14' $r.dataISO 'dataISO'
    Assert-Igual '09:00' $r.horaHHMM 'horaHHMM'
    Assert-Igual 'Calendar Daily Segurança' $r.titulo 'titulo'
}

# 2) colchetes preservados no título
Test-Caso 'Resolve-NomeArquivo preserva colchetes' {
    $r = Resolve-NomeArquivo '2026-07-13-1713-(4)-Calendar-[BIOMETRIA-RESIDENCIAL].md'
    Assert-Igual '2026-07-13' $r.dataISO 'dataISO'
    Assert-Igual '17:13' $r.horaHHMM 'horaHHMM'
    Assert-Verdadeiro ($r.titulo -like '*[[]BIOMETRIA*') "titulo sem '[BIOMETRIA': $($r.titulo)"
    Assert-Verdadeiro ($r.titulo -like '*RESIDENCIAL]*') "titulo sem 'RESIDENCIAL]': $($r.titulo)"
}

# 3) nome sem colisão
Test-Caso 'Resolve-NomeArquivo sem sufixo de colisão' {
    $r = Resolve-NomeArquivo '2026-07-13-1457-Calendar-TLV-Alinhamentos-com-Arquitetura.md'
    Assert-Igual 'Calendar TLV Alinhamentos com Arquitetura' $r.titulo 'titulo'
    Assert-Igual $null $r.colisao 'colisao'
}

# 4) nome fora do padrão retorna $null
Test-Caso 'Resolve-NomeArquivo fora do padrão -> null' {
    Assert-Igual $null (Resolve-NomeArquivo 'teams-transcricao-2026-07-13-1706.md') 'retorno'
}

# 5) cabeçalho é fonte da verdade e vence o nome (data divergente de propósito)
Test-Caso 'cabeçalho tem prioridade sobre o nome' {
    $nome = '2026-01-01-0000-Reuniao-Teste.md'   # nome diz 01/01 00:00
    $conteudo = @(
        '# Transcrição — (2) Calendar | Reunião Real'
        ''
        '- **Data:** 14/07/2026'
        '- **Início:** 09:05:10'
        '- **Fim:** 09:40:00'
        '- **Falas:** 42'
        ''
        '---'
        ''
        '**[09:05:10] FULANO:** olá'
    ) -join "`n"
    $rec = New-Registro -Nome $nome -Conteudo $conteudo
    Assert-Igual '2026-07-14' $rec.dataISO 'data do cabeçalho deve vencer'
    Assert-Igual '09:05' $rec.hora 'hora do cabeçalho deve vencer'
    Assert-Igual '09:40:00' $rec.fim 'fim'
    Assert-Igual 42 $rec.falas 'falas do cabeçalho deve vencer a contagem'
    Assert-Igual 'Calendar | Reunião Real' $rec.titulo 'título limpo sem o (n) de colisão'
    Assert-Igual $nome $rec.id 'id'
}

# 6) cabeçalho estilo "Início: DD/MM/AAAA, HH:MM:SS" (sem campo Data e sem Fim)
Test-Caso 'cabeçalho com data embutida no Início' {
    $conteudo = @(
        '# Transcrição — (1) Chamadas'
        ''
        '- **Início:** 13/07/2026, 16:26:48'
        '- **Falas:** 327'
        ''
        '---'
        ''
        '**[16:38:48] SYNC:** teste'
    ) -join "`n"
    $rec = New-Registro -Nome 'teams-transcricao-2026-07-13-1706.md' -Conteudo $conteudo
    Assert-Igual '2026-07-13' $rec.dataISO 'dataISO'
    Assert-Igual '16:26' $rec.hora 'hora'
    Assert-Igual $null $rec.fim 'fim'
    Assert-Igual 'Chamadas' $rec.titulo 'titulo'
}

# 7) sem cabeçalho: cai no nome e conta falas do corpo
Test-Caso 'sem cabeçalho usa nome e conta falas' {
    $conteudo = "**[10:00:00] A:** oi`n**[10:00:05] B:** tudo bem"
    $rec = New-Registro -Nome '2026-07-15-1430-Calendar-Sem-Cabecalho.md' -Conteudo $conteudo
    Assert-Igual '2026-07-15' $rec.dataISO 'dataISO'
    Assert-Igual '14:30' $rec.hora 'hora'
    Assert-Igual 'Calendar Sem Cabecalho' $rec.titulo 'titulo'
    Assert-Igual 2 $rec.falas 'falas'
}

# 8) JSON: aspas e barra invertida escapadas na ordem certa
Test-Caso 'ConvertTo-JsonTexto escapa aspas e barra' {
    Assert-Igual '"a\\b"'  (ConvertTo-JsonTexto 'a\b')  'barra invertida'
    Assert-Igual '"diz \"oi\""' (ConvertTo-JsonTexto 'diz "oi"') 'aspas'
}

# 9) JSON: < > & escapados — o dado vai dentro de um <script>, e uma fala
#    contendo "</script>" encerraria a tag e quebraria a página inteira.
Test-Caso 'ConvertTo-JsonTexto neutraliza fechamento de script' {
    $r = ConvertTo-JsonTexto 'antes </script> depois'
    Assert-Verdadeiro ($r -notmatch '</script>') "sobrou </script> literal: $r"
    Assert-Verdadeiro ($r -like '*<*') 'nao escapou <'
    Assert-Verdadeiro ($r -like '*>*') 'nao escapou >'
    Assert-Igual '"a&b"' (ConvertTo-JsonTexto 'a&b') 'e comercial'
}

# 10) JSON: quebras de linha e nulo
Test-Caso 'ConvertTo-JsonTexto trata quebras e nulo' {
    Assert-Igual '"l1\nl2"' (ConvertTo-JsonTexto "l1`nl2") 'quebra de linha'
    Assert-Igual '"a\r\nb"' (ConvertTo-JsonTexto "a`r`nb") 'CRLF'
    Assert-Igual 'null' (ConvertTo-JsonTexto $null) 'nulo'
    Assert-Igual '""' (ConvertTo-JsonTexto '') 'string vazia'
}

# 11) JSON: caractere de controle solto vira \u00XX em vez de quebrar o JSON
Test-Caso 'ConvertTo-JsonTexto escapa controle residual' {
    Assert-Igual '"a\u0001b"' (ConvertTo-JsonTexto ("a" + [char]1 + "b")) 'controle 0x01'
}

# 12) fim a fim: o registro atravessa a serialização e a página sai montada
Test-Caso 'New-PaginaHtml embute os dados e resolve os marcadores' {
    $rec = New-Registro -Nome '2026-07-15-1430-Reuniao-Com-Tag.md' -Conteudo "**[10:00:00] A:** vi um </script> na tela"
    $html = New-PaginaHtml -Registros @($rec)
    # .Contains() e não -like: os marcadores têm '*', que seria curinga.
    Assert-Verdadeiro (-not $html.Contains('/*__DADOS__*/')) 'marcador de dados nao substituido'
    Assert-Verdadeiro (-not $html.Contains('__GERADO_EM__')) 'marcador de data nao substituido'
    Assert-Verdadeiro ($html.Contains('Reuniao Com Tag')) 'titulo ausente na pagina'
    # A página tem exatamente dois </script>: o do bloco de dados e o do código.
    # Um terceiro significaria que o '</script>' da fala vazou sem escapar e
    # encerrou a tag antes da hora.
    $fechamentos = ([regex]::Matches($html, '</script>')).Count
    Assert-Igual 2 $fechamentos 'numero de </script> na pagina'
}

Write-Host ''
if ($script:falhou -gt 0) {
    Write-Host ("{0} passaram, {1} FALHARAM." -f $script:ok, $script:falhou) -ForegroundColor Red
    exit 1
}
Write-Host ("{0} testes passaram." -f $script:ok) -ForegroundColor Green
exit 0
