#Requires -Version 5.1
<#
    Registra a tarefa agendada TranscricoesTeamsSync.
    Roda como usuário corrente, só quando logado (sem senha, sem admin).
    Gatilhos: a cada 5 minutos e no logon.

    Tenta primeiro o cmdlet Register-ScheduledTask. Em contextos onde o
    canal CIM local devolve "Acesso negado" (shell destacado, sem token
    interativo), cai para schtasks.exe /XML, que usa COM direto e registra
    a mesma tarefa sem elevação.

    A tarefa NÃO chama o PowerShell direto: chama sync-oculto.vbs via
    wscript.exe. Chamar powershell.exe/pwsh.exe direto pisca uma janela preta
    a cada execução mesmo com -WindowStyle Hidden, porque o console host já
    mostrou a janela antes de o PowerShell ler esse parâmetro. O wscript cria
    o processo já oculto, então não há janela para piscar.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$nomeTarefa = 'TranscricoesTeamsSync'
$scriptSync = Join-Path $PSScriptRoot 'sync-transcricoes.ps1'
$descricao  = 'Move transcrições do Teams de Downloads para a pasta do projeto (a cada 5 min e no logon).'

if (-not (Test-Path -LiteralPath $scriptSync)) {
    throw "sync-transcricoes.ps1 não encontrado em $PSScriptRoot"
}

# pwsh (PS7) se disponível; senão o Windows PowerShell 5.1, com que o script é compatível.
# Caminho completo, não só o nome: a tarefa agendada não herda o PATH da sessão
# em que o instalador rodou, e um engine "não encontrado" falha silenciosamente.
$engine = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue
if ($pwsh) {
    $engine = $pwsh.Source
}

# Ação da tarefa: wscript.exe abre o processo já oculto (ver cabeçalho). O
# engine escolhido acima vai como argumento, então a decisão fica só aqui.
$lancador   = Join-Path $PSScriptRoot 'sync-oculto.vbs'
$wscript    = Join-Path $env:WINDIR 'System32\wscript.exe'
$janelaNota = 'sem janela (wscript.exe)'

if ((Test-Path -LiteralPath $lancador) -and (Test-Path -LiteralPath $wscript)) {
    $executavel = $wscript
    # //B = modo lote: erro do script vira código de saída, nunca caixa de
    # diálogo (um popup seria o mesmo problema com outra roupa).
    $argumentos = '//nologo //B "{0}" "{1}"' -f $lancador, $engine
}
else {
    # VBScript removido por política, ou sync-oculto.vbs ausente: registra do
    # jeito antigo em vez de falhar. Volta a piscar a janela — avisado abaixo.
    $executavel = $engine
    $argumentos = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $scriptSync
    $janelaNota = 'AVISO: sync-oculto.vbs ou wscript.exe indisponível — a janela do console vai piscar a cada execução'
}

$usuario = "$env:USERDOMAIN\$env:USERNAME"

function Register-ViaCmdlet {
    $acao = New-ScheduledTaskAction -Execute $executavel -Argument $argumentos
    $gatilho5min = New-ScheduledTaskTrigger -Once -At (Get-Date) `
        -RepetitionInterval (New-TimeSpan -Minutes 5) `
        -RepetitionDuration (New-TimeSpan -Days 3650)
    $gatilhoLogon = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId $usuario -LogonType Interactive -RunLevel Limited
    $config = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
    Register-ScheduledTask -TaskName $nomeTarefa -Description $descricao `
        -Action $acao -Trigger $gatilho5min, $gatilhoLogon -Principal $principal -Settings $config -Force | Out-Null
}

function Register-ViaSchtasks {
    $inicio = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')
    $cmdArgs = [System.Security.SecurityElement]::Escape($argumentos)
    $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>$descricao</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$usuario</UserId>
    </LogonTrigger>
    <TimeTrigger>
      <Repetition>
        <Interval>PT5M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>$inicio</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$usuario</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$executavel</Command>
      <Arguments>$cmdArgs</Arguments>
    </Exec>
  </Actions>
</Task>
"@
    $xmlPath = Join-Path $env:TEMP 'TranscricoesTeamsSync.xml'
    # schtasks exige XML em UTF-16 (Unicode).
    Set-Content -LiteralPath $xmlPath -Value $xml -Encoding Unicode
    $saida = schtasks.exe /Create /TN $nomeTarefa /XML $xmlPath /F 2>&1
    Remove-Item -LiteralPath $xmlPath -ErrorAction SilentlyContinue
    if ($LASTEXITCODE -ne 0) {
        throw "schtasks falhou (código $LASTEXITCODE): $saida"
    }
}

$metodo = 'Register-ScheduledTask'
try {
    Register-ViaCmdlet
}
catch {
    Write-Host "Register-ScheduledTask indisponível ($($_.Exception.Message.Trim())). Usando schtasks.exe."
    $metodo = 'schtasks.exe /XML'
    Register-ViaSchtasks
}

Write-Host "Tarefa '$nomeTarefa' registrada via $metodo. Engine: $engine"
Write-Host "Janela: $janelaNota"
