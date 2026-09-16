#Requires -Version 5.1
<#
    Envia por e-mail, como anexo, toda transcrição nova que aparecer na pasta do
    OneDrive — sem resumir nada. A ideia é ter o conteúdo bruto na caixa de entrada
    para consultar de qualquer lugar e processar depois com a ferramenta que quiser.

    Por que a pasta do OneDrive e não a do projeto: ela recebe as duas origens —
    o que é capturado nesta máquina (via sync-transcricoes.ps1) e o que vem do
    notebook do escritório (via copiar-para-onedrive.ps1). Fonte única, nada escapa.

    Credencial: app password do Google, guardada criptografada com DPAPI (só este
    usuário, nesta máquina, consegue ler). Nunca em texto plano, nunca no git.

    Uso:
      1. Gerar a app password em https://myaccount.google.com/apppasswords
      2. Salvar a credencial uma única vez:
           powershell -NoProfile -File .\enviar-transcricoes-email.ps1 -SalvarCredencial
      3. Testar sem enviar nada:
           powershell -NoProfile -File .\enviar-transcricoes-email.ps1 -Simular
      4. Instalar a tarefa agendada (a cada 30 min):
           powershell -NoProfile -ExecutionPolicy Bypass -File .\enviar-transcricoes-email.ps1 -Instalar
#>
[CmdletBinding()]
param(
    [switch]$Instalar,
    [switch]$SalvarCredencial,
    [switch]$Simular
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- configuração
$Remetente    = 'amarinho.david@gmail.com'
$Destinatario = 'adriano.david.terceiros@claro.com.br'
$SmtpServidor = 'smtp.gmail.com'
$SmtpPorta    = 587

$origem     = Join-Path $env:USERPROFILE 'OneDrive - Claro SA\Plano de Desenvolvimento\AGENDAS'
$credFile   = Join-Path $env:USERPROFILE '.transcreve-agenda-mail.xml'
$enviadosDb = Join-Path $PSScriptRoot 'enviados-email.txt'
$logFile    = Join-Path $PSScriptRoot 'enviar-transcricoes-email.log'
$nomeTarefa = 'EnviarTranscricoesEmail'

# Piso de tamanho: abaixo disso é fragmento de poucos segundos, não reunião.
# Subir este número corta mais ruído; baixar deixa passar sessões curtas.
$TamanhoMinimoBytes = 2048

# Sufixos que NÃO são transcrição bruta (artefatos gerados por mim no chat).
$SufixosIgnorados = @('-RESUMO-EXECUTIVO', '-EMAIL', '-RECONSTITUIDA')

# ------------------------------------------------------------------- utilidades
function Write-EnvioLog {
    param([string]$Mensagem)
    $ts = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Add-Content -LiteralPath $logFile -Value ("{0}  {1}" -f $ts, $Mensagem) -Encoding UTF8
}

function Get-Credencial {
    if (-not (Test-Path -LiteralPath $credFile)) {
        throw "Credencial não encontrada. Rode uma vez com -SalvarCredencial."
    }
    return Import-Clixml -LiteralPath $credFile
}

# Nome do arquivo sem a data/hora do começo — é o que vai no assunto, para o
# e-mail ser reconhecível na caixa de entrada sem abrir o anexo.
function Get-TituloReuniao {
    param([string]$NomeArquivo)
    $s = [System.IO.Path]::GetFileNameWithoutExtension($NomeArquivo)
    $s = $s -replace '^\d{4}-\d{2}-\d{2}-\d{4}-', ''      # 2026-09-15-1413-
    $s = $s -replace '^\(\d+\)-', ''                       # (3)-
    $s = $s -replace '^(Calendar|Chat)-', ''               # Calendar- / Chat-
    $s = $s -replace '-', ' '
    if (-not $s) { $s = 'Reunião' }
    return $s.Trim()
}

function Get-DataReuniao {
    param([string]$NomeArquivo)
    if ($NomeArquivo -match '^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})') {
        return "{0}/{1}/{2} {3}:{4}" -f $matches[3], $matches[2], $matches[1], $matches[4], $matches[5]
    }
    return ''
}

# ------------------------------------------------------- modo: salvar credencial
if ($SalvarCredencial) {
    Write-Host "Usuário: $Remetente"
    Write-Host "Senha: cole a APP PASSWORD do Google (16 caracteres, sem espaços)."
    Write-Host "Gere em: https://myaccount.google.com/apppasswords"
    Write-Host ""
    $cred = Get-Credential -UserName $Remetente -Message 'App password do Gmail'
    $cred | Export-Clixml -LiteralPath $credFile
    Write-Host "Credencial salva criptografada em: $credFile"
    Write-Host "Só este usuário, nesta máquina, consegue ler (DPAPI)."
    return
}

# ---------------------------------------------------------- modo: instalar tarefa
if ($Instalar) {
    $engine = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
    if (-not $engine) { $engine = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
    $scriptPath = $MyInvocation.MyCommand.Path
    $argumentos = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $scriptPath
    $usuario = "$env:USERDOMAIN\$env:USERNAME"
    $descricao = 'Envia por e-mail as transcrições novas do Teams, como anexo (a cada 30 min e no logon).'

    # Register-ScheduledTask primeiro. Em shell destacado (sem token interativo) o
    # canal CIM local devolve "Acesso negado" — aí cai para schtasks.exe /XML, que
    # usa COM direto e registra a mesma tarefa sem elevação. Mesmo padrão dos outros
    # scripts do projeto.
    try {
        $acao = New-ScheduledTaskAction -Execute $engine -Argument $argumentos
        $gatilho30min = New-ScheduledTaskTrigger -Once -At (Get-Date) `
            -RepetitionInterval (New-TimeSpan -Minutes 30) `
            -RepetitionDuration (New-TimeSpan -Days 3650)
        $gatilhoLogon = New-ScheduledTaskTrigger -AtLogOn
        $principal = New-ScheduledTaskPrincipal -UserId $usuario -LogonType Interactive -RunLevel Limited
        $config = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
            -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
        Register-ScheduledTask -TaskName $nomeTarefa -Description $descricao `
            -Action $acao -Trigger $gatilho30min, $gatilhoLogon -Principal $principal -Settings $config -Force | Out-Null
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
      <Repetition><Interval>PT30M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
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
        $xmlPath = Join-Path $env:TEMP 'EnviarTranscricoesEmail.xml'
        Set-Content -LiteralPath $xmlPath -Value $xml -Encoding Unicode
        $saida = schtasks.exe /Create /TN $nomeTarefa /XML $xmlPath /F 2>&1
        Remove-Item -LiteralPath $xmlPath -ErrorAction SilentlyContinue
        if ($LASTEXITCODE -ne 0) { throw "schtasks falhou (código $LASTEXITCODE): $saida" }
        Write-Host "Tarefa '$nomeTarefa' registrada via schtasks.exe. Engine: $engine"
    }
    return
}

# --------------------------------------------------------------- envio (default)
if (-not (Test-Path -LiteralPath $origem)) {
    Write-EnvioLog "ERRO: pasta de origem não encontrada: $origem"
    throw "Pasta de origem não encontrada: $origem"
}

# Primeira execução sem base de enviados: marca tudo que já existe como enviado e
# sai. Sem isso a rotina dispararia um e-mail para cada transcrição do histórico.
$primeiraVez = -not (Test-Path -LiteralPath $enviadosDb)
$enviados = @()
if (-not $primeiraVez) {
    $enviados = @(Get-Content -LiteralPath $enviadosDb -Encoding UTF8 | Where-Object { $_ })
}

$candidatos = Get-ChildItem -LiteralPath $origem -Filter '*.md' -File | Where-Object {
    $nome = $_.BaseName
    $ignorar = $false
    foreach ($suf in $SufixosIgnorados) { if ($nome.EndsWith($suf)) { $ignorar = $true } }
    (-not $ignorar) -and ($_.Length -ge $TamanhoMinimoBytes) -and ($enviados -notcontains $_.Name)
}

if ($primeiraVez) {
    $todos = Get-ChildItem -LiteralPath $origem -Filter '*.md' -File | ForEach-Object { $_.Name }
    if ($Simular) {
        Write-Host "SIMULAÇÃO — primeira execução: $($todos.Count) arquivo(s) do histórico seriam marcados como enviados."
        Write-Host "Nenhum e-mail sairia. Daqui pra frente, só o que for novo."
        return
    }
    Set-Content -LiteralPath $enviadosDb -Value $todos -Encoding UTF8
    Write-EnvioLog ("PRIMEIRA EXECUÇÃO: {0} arquivo(s) do histórico marcados como enviados. Só as novas serão enviadas daqui pra frente." -f $todos.Count)
    Write-Host "Base criada com $($todos.Count) arquivo(s) do histórico. Nada foi enviado."
    return
}

if (-not $candidatos) { return }  # nada novo: sai em silêncio, sem poluir o log

if ($Simular) {
    Write-Host "SIMULAÇÃO — estes seriam enviados agora:"
    foreach ($f in $candidatos) {
        Write-Host ("  {0}  ({1:N0} KB)  ->  {2}" -f $f.Name, ($f.Length / 1KB), (Get-TituloReuniao $f.Name))
    }
    return
}

$cred = Get-Credencial
$enviadosAgora = 0
$erros = 0

foreach ($f in $candidatos) {
    $titulo = Get-TituloReuniao $f.Name
    $data = Get-DataReuniao $f.Name
    $assunto = if ($data) { "Transcrição — $titulo — $data" } else { "Transcrição — $titulo" }

    $corpo = @"
Transcrição da reunião em anexo.

Reunião: $titulo
Data: $data
Arquivo: $($f.Name)
Tamanho: $([math]::Round($f.Length / 1KB, 1)) KB

Enviado automaticamente pela rotina do Transcreve Agenda.
"@

    $smtp = $null
    $msg = $null
    try {
        $msg = New-Object System.Net.Mail.MailMessage
        $msg.From = New-Object System.Net.Mail.MailAddress($Remetente)
        $msg.To.Add($Destinatario)
        $msg.Subject = $assunto
        $msg.Body = $corpo
        $msg.BodyEncoding = [System.Text.Encoding]::UTF8
        $msg.SubjectEncoding = [System.Text.Encoding]::UTF8
        $msg.Attachments.Add((New-Object System.Net.Mail.Attachment($f.FullName)))

        $smtp = New-Object System.Net.Mail.SmtpClient($SmtpServidor, $SmtpPorta)
        $smtp.EnableSsl = $true
        $smtp.Credentials = New-Object System.Net.NetworkCredential($cred.UserName, $cred.GetNetworkCredential().Password)
        $smtp.Send($msg)

        Add-Content -LiteralPath $enviadosDb -Value $f.Name -Encoding UTF8
        $enviadosAgora++
    }
    catch {
        $erros++
        Write-EnvioLog ("ERRO ao enviar {0}: {1}" -f $f.Name, $_.Exception.Message)
    }
    finally {
        if ($msg) { $msg.Dispose() }
        if ($smtp) { $smtp.Dispose() }
    }
}

if ($enviadosAgora -gt 0 -or $erros -gt 0) {
    Write-EnvioLog ("{0} enviado(s), {1} erro(s)" -f $enviadosAgora, $erros)
}
