#Requires -Version 5.1
<#
    Duplicador standalone: copia (nunca move) as transcrições que a extensão salva
    em Downloads\Transcricoes Teams para uma pasta do OneDrive, a cada 5 minutos.

    Diferente de sync-transcricoes.ps1 (que MOVE para a pasta do projeto e depois
    espelha), este script não depende do repositório — é um arquivo único, pensado
    para uma máquina que só tem a extensão instalada, sem o projeto clonado (ex.:
    o notebook do escritório). Roda como usuário comum, sem admin, sem senha.

    Uso:
      1. Copie só este arquivo para a máquina de destino.
      2. Edite $DestinoOneDrive logo abaixo com o caminho real do OneDrive lá.
      3. Rode uma vez para instalar a tarefa agendada:
           powershell -NoProfile -ExecutionPolicy Bypass -File .\copiar-para-onedrive.ps1 -Instalar
      4. Pronto — a cada 5 min ele confere Downloads\Transcricoes Teams e copia
         o que for novo ou tiver mudado. Nada em Downloads é apagado nem movido.
#>
[CmdletBinding()]
param(
    [switch]$Instalar
)

$ErrorActionPreference = 'Stop'

# EDITE AQUI: caminho absoluto da pasta no OneDrive desta máquina.
$DestinoOneDrive = Join-Path $env:USERPROFILE 'OneDrive - Claro SA\Plano de Desenvolvimento\AGENDAS'

$origem  = Join-Path $env:USERPROFILE 'Downloads\Transcricoes Teams'
$logFile = Join-Path $PSScriptRoot 'copiar-para-onedrive.log'
$idadeMinimaSegundos = 10 # arquivo recém-criado pode ainda estar sendo gravado pelo Chrome

function Write-CopiaLog {
    param([string]$Mensagem)
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -LiteralPath $logFile -Value ("{0}  {1}" -f $ts, $Mensagem) -Encoding UTF8
}

function Invoke-LogRotation {
    if (-not (Test-Path -LiteralPath $logFile)) { return }
    if ((Get-Item -LiteralPath $logFile).Length -le 1MB) { return }
    $ultimas = Get-Content -LiteralPath $logFile -Tail 200
    Set-Content -LiteralPath $logFile -Value $ultimas -Encoding UTF8
}

# Faz a cópia em si: um ciclo de varredura, chamado tanto pelo agendamento
# quanto (opcionalmente) na hora de instalar, para já sincronizar o que existir.
function Invoke-Copia {
    if (-not (Test-Path -LiteralPath $origem)) {
        New-Item -ItemType Directory -Path $origem -Force | Out-Null
    }
    if (-not (Test-Path -LiteralPath $DestinoOneDrive)) {
        try {
            New-Item -ItemType Directory -Path $DestinoOneDrive -Force | Out-Null
        }
        catch {
            Write-CopiaLog ("DESTINO indisponível ({0}): {1}" -f $DestinoOneDrive, $_.Exception.Message)
            return
        }
    }

    Invoke-LogRotation
    $agora = Get-Date
    $copiados = 0
    $erros = 0

    foreach ($padrao in @('*.md', '*.txt', '*.json')) {
        $arquivos = Get-ChildItem -LiteralPath $origem -Filter $padrao -File -ErrorAction SilentlyContinue
        foreach ($arq in $arquivos) {
            if (($agora - $arq.LastWriteTime).TotalSeconds -lt $idadeMinimaSegundos) { continue }

            $alvo = Join-Path $DestinoOneDrive $arq.Name
            if (Test-Path -LiteralPath $alvo) {
                $atual = Get-Item -LiteralPath $alvo
                # Mesmo tamanho e cópia não mais antiga que a origem = já copiado.
                if ($atual.Length -eq $arq.Length -and $atual.LastWriteTime -ge $arq.LastWriteTime) { continue }
            }
            try {
                Copy-Item -LiteralPath $arq.FullName -Destination $alvo -Force
                $copiados++
            }
            catch {
                # OneDrive offline, arquivo travado ou sem espaço: registra e segue.
                $erros++
                Write-CopiaLog ("ERRO {0} -> {1}: {2}" -f $arq.Name, $DestinoOneDrive, $_.Exception.Message)
            }
        }
    }
    if ($copiados -gt 0 -or $erros -gt 0) {
        Write-CopiaLog ("{0} copiado(s), {1} erro(s)" -f $copiados, $erros)
    }
}

# Registra a tarefa agendada CopiarTranscricoesOneDrive (usuário comum, sem admin,
# sem senha). Mesmo padrão de fallback do instalar-tarefa.ps1: tenta o cmdlet, cai
# para schtasks.exe se o canal CIM local negar acesso.
function Install-Tarefa {
    $nomeTarefa = 'CopiarTranscricoesOneDrive'
    $engine = 'powershell.exe'
    if (Get-Command pwsh.exe -ErrorAction SilentlyContinue) { $engine = 'pwsh.exe' }
    $scriptPath = $MyInvocation.PSCommandPath
    if (-not $scriptPath) { $scriptPath = $PSCommandPath }
    $argumentos = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $scriptPath
    $usuario = "$env:USERDOMAIN\$env:USERNAME"
    $descricao = 'Copia as transcrições do Teams de Downloads para o OneDrive, sem apagar o original (a cada 5 min e no logon).'

    try {
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
        Write-Host "Tarefa '$nomeTarefa' registrada via Register-ScheduledTask. Engine: $engine"
    }
    catch {
        Write-Host "Register-ScheduledTask indisponível ($($_.Exception.Message.Trim())). Usando schtasks.exe."
        $inicio = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ss')
        $cmdArgs = [System.Security.SecurityElement]::Escape($argumentos)
        $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>$descricao</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>$usuario</UserId></LogonTrigger>
    <TimeTrigger>
      <Repetition><Interval>PT5M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
      <StartBoundary>$inicio</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author"><UserId>$usuario</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author"><Exec><Command>$engine</Command><Arguments>$cmdArgs</Arguments></Exec></Actions>
</Task>
"@
        $xmlPath = Join-Path $env:TEMP 'CopiarTranscricoesOneDrive.xml'
        Set-Content -LiteralPath $xmlPath -Value $xml -Encoding Unicode
        $saida = schtasks.exe /Create /TN $nomeTarefa /XML $xmlPath /F 2>&1
        Remove-Item -LiteralPath $xmlPath -ErrorAction SilentlyContinue
        if ($LASTEXITCODE -ne 0) { throw "schtasks falhou (código $LASTEXITCODE): $saida" }
        Write-Host "Tarefa '$nomeTarefa' registrada via schtasks.exe. Engine: $engine"
    }
}

if ($Instalar) {
    Write-Host "Destino configurado: $DestinoOneDrive"
    Install-Tarefa
    Invoke-Copia
    Write-Host "Primeira cópia feita. Log em: $logFile"
}
else {
    Invoke-Copia
}
