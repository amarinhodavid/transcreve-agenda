#Requires -Version 5.1
<#
    Sincronizador de transcrições do Teams.
    Move os arquivos que a extensão Chrome baixa em
    Downloads\Transcricoes Teams para a pasta do projeto e, em seguida,
    espelha a pasta para os destinos extras configurados (ex.: OneDrive),
    para acessar as transcrições de outra máquina.
    Compatível com Windows PowerShell 5.1 e PowerShell 7.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$origem  = Join-Path $env:USERPROFILE 'Downloads\Transcricoes Teams'
# Destino = pasta transcricoes do próprio repositório (o script vive em scripts/),
# então funciona em qualquer máquina sem editar caminho.
$destino = Join-Path (Split-Path -Parent $PSScriptRoot) 'transcricoes'
$logFile = Join-Path $PSScriptRoot 'sync-transcricoes.log'

# Espelhos: pastas que recebem uma CÓPIA de tudo que está em transcricoes/ (ex.:
# OneDrive corporativo, pra abrir a transcrição de outro computador). Um caminho
# absoluto por linha em scripts/espelhos.local.txt; linhas com # são comentário.
# O arquivo fica FORA do git de propósito — caminho de OneDrive é específico da
# máquina e do usuário, não pertence a um repositório público.
$espelhosConfig = Join-Path $PSScriptRoot 'espelhos.local.txt'
$espelhos = @()
if (Test-Path -LiteralPath $espelhosConfig) {
    $espelhos = @(
        Get-Content -LiteralPath $espelhosConfig -Encoding UTF8 |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ -and -not $_.StartsWith('#') }
    )
}

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

# Espelha transcricoes/ em uma pasta extra. Cópia incremental: só transfere o que
# falta ou mudou (compara tamanho e data), então a primeira execução faz o backfill
# do histórico inteiro sozinha e as seguintes ficam baratas. Nunca apaga nada no
# espelho — arquivo removido aqui continua lá, de propósito.
function Sync-Espelho {
    param([string]$Espelho)

    if (-not (Test-Path -LiteralPath $Espelho)) {
        try {
            New-Item -ItemType Directory -Path $Espelho -Force | Out-Null
        }
        catch {
            Write-SyncLog ("ESPELHO: pasta indisponível {0}: {1}" -f $Espelho, $_.Exception.Message)
            return
        }
    }

    $copiados = 0
    $erros = 0
    foreach ($arq in Get-ChildItem -LiteralPath $destino -File -ErrorAction SilentlyContinue) {
        $alvo = Join-Path $Espelho $arq.Name
        if (Test-Path -LiteralPath $alvo) {
            $atual = Get-Item -LiteralPath $alvo
            # Mesmo tamanho e cópia não mais antiga que a origem = já espelhado.
            if ($atual.Length -eq $arq.Length -and $atual.LastWriteTime -ge $arq.LastWriteTime) { continue }
        }
        try {
            Copy-Item -LiteralPath $arq.FullName -Destination $alvo -Force
            $copiados++
        }
        catch {
            # OneDrive offline, arquivo travado ou sem espaço: registra e segue.
            $erros++
            Write-SyncLog ("ESPELHO ERRO {0} -> {1}: {2}" -f $arq.Name, $Espelho, $_.Exception.Message)
        }
    }
    Write-SyncLog ("ESPELHO {0}: {1} copiado(s), {2} erro(s)" -f $Espelho, $copiados, $erros)
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

# Regenera o index.html do visualizador. Roda dentro deste mesmo PowerShell
# (dot-source), sem runtime externo: a versão anterior dependia do Node e, numa
# máquina sem Node instalado, a geração ficava pulada em silêncio — o espelho
# acabava com as transcrições e sem a página que as torna navegáveis.
# Ainda assim vai num try: falha ao gerar o índice não pode derrubar o sync,
# que é a função crítica.
$gerador = Join-Path $PSScriptRoot 'gerar-index.ps1'
if (-not (Test-Path -LiteralPath $gerador)) {
    Write-SyncLog 'INDEX: gerar-index.ps1 ausente, geração pulada.'
}
else {
    try {
        . $gerador -SomenteFuncoes
        $indice = Invoke-GerarIndex
        Write-SyncLog ("INDEX: indexados {0} arquivo(s)." -f $indice.total)
    }
    catch {
        Write-SyncLog ("INDEX: falha ao gerar index.html: {0}" -f $_.Exception.Message)
    }
}

# Espelho por último: roda depois do index.html regenerado, então o visualizador
# também vai junto e o espelho fica navegável fora desta máquina.
if ($espelhos.Count -eq 0) {
    Write-SyncLog 'ESPELHO: nenhum configurado (scripts/espelhos.local.txt ausente ou vazio).'
}
else {
    foreach ($espelho in $espelhos) { Sync-Espelho -Espelho $espelho }
}
