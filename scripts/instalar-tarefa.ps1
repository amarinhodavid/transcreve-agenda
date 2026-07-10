#Requires -Version 5.1
<#
    Registra a tarefa agendada TranscricoesTeamsSync.
    Roda como usuário corrente, só quando logado (sem senha, sem admin).
    Gatilhos: a cada 5 minutos e no logon.

    Tenta primeiro o cmdlet Register-ScheduledTask. Em contextos onde o
    canal CIM local devolve "Acesso negado" (shell destacado, sem token
    interativo), cai para schtasks.exe /XML, que usa COM direto e registra
    a mesma tarefa sem elevação.
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
$engine = 'powershell.exe'
if (Get-Command pwsh.exe -ErrorAction SilentlyContinue) {
    $engine = 'pwsh.exe'
}

$argumentos = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $scriptSync
$usuario = "$env:USERDOMAIN\$env:USERNAME"

function Register-ViaCmdlet {
    $acao = New-ScheduledTaskAction -Execute $engine -Argument $argumentos
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
      <Command>$engine</Command>
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
