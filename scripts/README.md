# Sincronizador de Transcrições do Teams

Ponte entre a extensão Chrome "Transcreve Agenda" e a pasta do projeto. A
extensão só consegue salvar em `Downloads` (sandbox do Chrome), então uma tarefa
agendada do Windows move os arquivos para cá a cada 5 minutos.

## O que faz

`sync-transcricoes.ps1` move todos os `*.md`, `*.txt` e `*.json` de:

- **Origem:** `%USERPROFILE%\Downloads\Transcricoes Teams\`
- **Destino:** `...\PROJETOS\TRANSCREVE AGENDA\transcricoes\`

Regras:

- Ignora arquivos com menos de 10 segundos de idade (o Chrome ainda pode estar
  gravando) e qualquer `.crdownload` (download em andamento).
- Nunca sobrescreve: em colisão de nome, renomeia com sufixo ` (1)`, ` (2)`...
- Registra cada arquivo movido em `sync-transcricoes.log` (uma linha por arquivo,
  com data e hora). Execução sem novidade não escreve nada. Acima de 1 MB, o log
  é truncado mantendo as últimas ~200 linhas.
- É idempotente e sem janela — pode rodar quantas vezes quiser.

## Instalar a tarefa agendada

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\instalar-tarefa.ps1
```

Ou clique-direito no `instalar-tarefa.ps1` → **Executar com PowerShell**.

Cria a tarefa `TranscricoesTeamsSync`, que roda como o usuário atual (sem senha,
sem admin), a cada 5 minutos e sempre que você faz logon. O instalador tenta o
cmdlet `Register-ScheduledTask` e, se o ambiente negar acesso a esse canal, cai
automaticamente para `schtasks.exe` — o resultado é o mesmo.

## Rodar o sync na mão (sem esperar os 5 min)

```powershell
Start-ScheduledTask -TaskName TranscricoesTeamsSync
# ou diretamente:
pwsh -NoProfile -ExecutionPolicy Bypass -File .\sync-transcricoes.ps1
```

## Mudar o intervalo

Edite `instalar-tarefa.ps1` e troque os dois pontos onde aparece o intervalo de
5 minutos:

- No caminho do cmdlet: `New-TimeSpan -Minutes 5`
- No XML de fallback: `<Interval>PT5M</Interval>` (formato ISO 8601 de duração —
  `PT10M` = 10 min, `PT1H` = 1 hora)

Depois rode o instalador de novo (ele usa `-Force` e sobrescreve a tarefa).

## Desinstalar

```powershell
Unregister-ScheduledTask -TaskName TranscricoesTeamsSync -Confirm:$false
```

Isso remove só a tarefa. Os scripts e as transcrições já movidas continuam onde
estão.

## Diagnóstico

```powershell
Get-ScheduledTask     -TaskName TranscricoesTeamsSync   # estado (Ready/Running)
Get-ScheduledTaskInfo -TaskName TranscricoesTeamsSync   # LastRunTime, LastTaskResult (0 = ok)
Get-Content .\sync-transcricoes.log -Tail 20            # últimos arquivos movidos
```
