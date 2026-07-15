#Requires -Version 5.1
<#
    Atalho: regenera o index.html das transcrições e abre no navegador padrão.
    Compatível com Windows PowerShell 5.1 e PowerShell 7.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$gerador = Join-Path $PSScriptRoot 'gerar-index.js'
$index   = Join-Path (Split-Path -Parent $PSScriptRoot) 'transcricoes\index.html'

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node -and (Test-Path -LiteralPath $gerador)) {
    & $node.Source $gerador
}
else {
    Write-Host 'Node ausente ou gerador não encontrado — abrindo o index.html existente.'
}

if (Test-Path -LiteralPath $index) {
    Start-Process $index
}
else {
    Write-Host "index.html não existe ainda em: $index"
    Write-Host 'Rode o sync ou instale o Node para gerá-lo.'
}
