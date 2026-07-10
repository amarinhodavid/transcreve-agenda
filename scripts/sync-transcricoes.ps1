#Requires -Version 5.1
<#
    Sincronizador de transcrições do Teams.
    Move os arquivos que a extensão Chrome baixa em
    Downloads\Transcricoes Teams para a pasta do projeto.
    Compatível com Windows PowerShell 5.1 e PowerShell 7.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$origem  = Join-Path $env:USERPROFILE 'Downloads\Transcricoes Teams'
$destino = 'C:\Users\amari\Documents\A FUNDO - LOCAL\CLAUDE CODE\PROJETOS\TRANSCREVE AGENDA\transcricoes'
$logFile = Join-Path $PSScriptRoot 'sync-transcricoes.log'

# Idade mínima: arquivo recém-criado pode ainda estar sendo gravado pelo Chrome.
$idadeMinimaSegundos = 10

foreach ($dir in @($origem, $destino)) {
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
}

function Write-SyncLog {
    param([string]$Mensagem)
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -LiteralPath $logFile -Value ("{0}  {1}" -f $ts, $Mensagem) -Encoding UTF8
}

# Rotação: log acima de 1 MB é truncado mantendo as últimas ~200 linhas.
function Invoke-LogRotation {
    if (-not (Test-Path -LiteralPath $logFile)) { return }
    $info = Get-Item -LiteralPath $logFile
    if ($info.Length -le 1MB) { return }
    $ultimas = Get-Content -LiteralPath $logFile -Tail 200
    Set-Content -LiteralPath $logFile -Value $ultimas -Encoding UTF8
}

# Resolve um nome livre no destino, sem sobrescrever: "nome (1).md", "nome (2).md"...
function Resolve-DestinoLivre {
    param([string]$PastaDestino, [string]$NomeArquivo)
    $alvo = Join-Path $PastaDestino $NomeArquivo
    if (-not (Test-Path -LiteralPath $alvo)) { return $alvo }
    $base = [System.IO.Path]::GetFileNameWithoutExtension($NomeArquivo)
    $ext  = [System.IO.Path]::GetExtension($NomeArquivo)
    $i = 1
    while ($true) {
        $candidato = Join-Path $PastaDestino ("{0} ({1}){2}" -f $base, $i, $ext)
        if (-not (Test-Path -LiteralPath $candidato)) { return $candidato }
        $i++
    }
}

Invoke-LogRotation

$agora = Get-Date
$extensoes = @('*.md', '*.txt', '*.json')

foreach ($padrao in $extensoes) {
    $arquivos = Get-ChildItem -LiteralPath $origem -Filter $padrao -File -ErrorAction SilentlyContinue
    foreach ($arq in $arquivos) {
        if (($agora - $arq.LastWriteTime).TotalSeconds -lt $idadeMinimaSegundos) { continue }

        $destinoLivre = Resolve-DestinoLivre -PastaDestino $destino -NomeArquivo $arq.Name
        try {
            Move-Item -LiteralPath $arq.FullName -Destination $destinoLivre
            Write-SyncLog ("MOVIDO: {0} -> {1}" -f $arq.Name, [System.IO.Path]::GetFileName($destinoLivre))
        }
        catch {
            # Arquivo travado (Chrome ainda escrevendo, antivírus) não pode
            # abortar o lote inteiro; registra e segue para o próximo.
            Write-SyncLog ("ERRO ao mover {0}: {1}" -f $arq.Name, $_.Exception.Message)
        }
    }
}
