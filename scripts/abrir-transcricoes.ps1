#Requires -Version 5.1
<#
    Atalho: regenera o index.html das transcrições e abre no navegador padrão.
    Compatível com Windows PowerShell 5.1 e PowerShell 7.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$gerador = Join-Path $PSScriptRoot 'gerar-index.ps1'
$index   = Join-Path (Split-Path -Parent $PSScriptRoot) 'transcricoes\index.html'

if (Test-Path -LiteralPath $gerador) {
    # Regenerar não pode impedir de abrir o que já existe: se a geração falhar,
    # avisa e segue para o index.html anterior.
    try {
        . $gerador -SomenteFuncoes
        $indice = Invoke-GerarIndex
        Write-Host ("Indexados {0} arquivo(s)." -f $indice.total)
    }
    catch {
        Write-Host "Falha ao regenerar o índice ($($_.Exception.Message)) — abrindo o index.html existente."
    }
}
else {
    Write-Host 'gerar-index.ps1 não encontrado — abrindo o index.html existente.'
}

if (Test-Path -LiteralPath $index) {
    Start-Process $index
}
else {
    Write-Host "index.html não existe ainda em: $index"
    Write-Host 'Rode o sync para gerá-lo, ou confira se há .md em transcricoes/.'
}
