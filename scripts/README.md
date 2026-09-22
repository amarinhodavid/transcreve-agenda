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
- É idempotente — pode rodar quantas vezes quiser.
- Roda **sem aparecer janela** quando disparado pela tarefa agendada (veja
  [Por que não pisca janela](#por-que-não-pisca-janela)).

Depois de mover os arquivos e regenerar o `index.html`, o script **espelha** a
pasta de transcrições nos destinos configurados (veja abaixo).

## Espelhar em outra pasta (OneDrive, rede, pen drive)

Para acessar as transcrições de outra máquina, crie o arquivo
`espelhos.local.txt` nesta pasta com **um caminho absoluto por linha**:

```
# Um destino por linha; linhas com # são comentário.
C:\Users\<voce>\OneDrive - <Empresa>\<Pasta>\AGENDAS
```

Como funciona:

- Cópia **incremental**: transfere só o que falta ou mudou (compara tamanho e
  data), então a primeira execução faz o backfill do histórico inteiro sozinha e
  as seguintes são baratas.
- **Nunca apaga** nada no espelho — é cópia de segurança, não sincronização
  bidirecional. Arquivo removido da pasta local continua lá.
- O `index.html` do visualizador vai junto, então o espelho é navegável.
- Espelho indisponível (OneDrive offline, rede caída) é registrado no log e não
  interrompe o sync — a função crítica é mover os arquivos.
- O arquivo **não vai para o git**: caminho de OneDrive é específico da máquina e
  do usuário. Sem ele, o script só não espelha; o resto funciona igual.

## Instalar a tarefa agendada

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\instalar-tarefa.ps1
```

Ou clique-direito no `instalar-tarefa.ps1` → **Executar com PowerShell**.

Cria a tarefa `TranscricoesTeamsSync`, que roda como o usuário atual (sem senha,
sem admin), a cada 5 minutos e sempre que você faz logon. O instalador tenta o
cmdlet `Register-ScheduledTask` e, se o ambiente negar acesso a esse canal, cai
automaticamente para `schtasks.exe` — o resultado é o mesmo.

Ao final ele imprime duas linhas: o método e o engine usados, e o estado da
janela. O esperado é `Janela: sem janela (wscript.exe)`.

## Por que não pisca janela

A tarefa **não chama o PowerShell direto**. Ela chama `sync-oculto.vbs` através
do `wscript.exe`, e é o VBS que abre o PowerShell.

O motivo é específico: `powershell.exe -WindowStyle Hidden` **não** evita a
janela quando a tarefa dispara. O console host (`conhost.exe`) cria e mostra a
janela antes de o PowerShell chegar a ler esse parâmetro — ele esconde algo que
já apareceu. O resultado é uma tela preta piscando a cada execução (a cada 5
minutos, e no logon).

`WScript.Shell.Run(comando, 0, True)` cria o processo **já oculto**, então não
existe janela para piscar. O `wscript.exe` (ao contrário do `cscript.exe`) não
abre console próprio — a cadeia inteira fica invisível.

O `True` do `Run` faz o VBS **esperar** o sync terminar e repassar o código de
saída. Sem isso a tarefa sairia de "Running" imediatamente, a política
`IgnoreNew` perderia o efeito e `LastTaskResult` seria sempre 0, mentindo sobre
o resultado.

**Já tem a tarefa instalada do jeito antigo?** Rode o instalador de novo — ele
usa `-Force` e substitui a ação da tarefa existente:

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\instalar-tarefa.ps1
```

Se o ambiente tiver o VBScript removido por política, o instalador **avisa** na
última linha e registra do jeito antigo, para não deixar você sem sync — nesse
caso a janela volta a piscar.

## O visualizador (`index.html`)

Ao final de cada execução o sync regenera `transcricoes/index.html`: uma página
única, sem CDN e sem `fetch`, com os `.md` embutidos como JSON. Abre offline por
`file://` e dá lista por data, navegação por teclado e **busca no conteúdo** de
todas as reuniões de uma vez.

Quem gera é o `gerar-index.ps1`, rodando dentro do próprio PowerShell do sync.
Não há dependência de runtime externo: a versão anterior chamava um
`gerar-index.js` via Node e, em máquina sem Node instalado, a geração ficava
pulada **em silêncio** — o espelho acabava com as transcrições e sem a página
que as torna navegáveis. Só restava uma linha no log que ninguém lia.

Para abrir o visualizador na mão, regenerando antes:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\abrir-transcricoes.ps1
```

### Testes do gerador

As funções de parse (nome de arquivo, cabeçalho do `.md`, contagem de falas) e
a serialização do JSON têm testes:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\gerar-index.test.ps1
```

Imprime uma linha por caso e sai com código 1 se algum falhar. Vale rodar depois
de mexer em qualquer regex de parse — é o que garante que o índice não passe a
ler as transcrições errado sem ninguém notar.

## Rodar o sync na mão (sem esperar os 5 min)

```powershell
Start-ScheduledTask -TaskName TranscricoesTeamsSync   # oculto, igual ao agendado
# oculto, sem passar pela tarefa:
wscript.exe //nologo //B .\sync-oculto.vbs
# visível, para acompanhar a saída e depurar:
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
Get-Content .\sync-transcricoes.log -Tail 20            # últimos arquivos movidos e espelhados

# Confere se a tarefa está usando o lançador oculto:
(Get-ScheduledTask -TaskName TranscricoesTeamsSync).Actions |
    Select-Object Execute, Arguments
```

O `Execute` precisa terminar em `wscript.exe`. Se aparecer `powershell.exe` ou
`pwsh.exe` ali, a tarefa ainda é a versão antiga — rode o instalador de novo.

Linhas `ESPELHO ...: N copiado(s), M erro(s)` mostram o resultado de cada destino
configurado; `ESPELHO ERRO ...` detalha o arquivo que falhou. `INDEX: indexados
N arquivo(s)` confirma que o visualizador foi regenerado.

Um espelho que falha **não** interrompe o sync, de propósito — mas também não
aparece em lugar nenhum além do log. Se você depende da cópia em outra pasta,
confira essas linhas de vez em quando: um caminho de outra máquina no
`espelhos.local.txt` faz o espelhamento falhar silenciosamente para sempre.
