' Lancador silencioso do sync-transcricoes.ps1.
'
' Por que este arquivo existe: chamar powershell.exe/pwsh.exe direto na tarefa
' agendada pisca uma janela preta a cada execucao, mesmo com -WindowStyle Hidden.
' O motivo e que o console host (conhost.exe) cria e MOSTRA a janela antes de o
' PowerShell chegar a ler esse parametro -- ele esconde algo que ja apareceu.
'
' WScript.Shell.Run com intWindowStyle = 0 cria o processo ja oculto, entao nao
' existe janela nenhuma para piscar. wscript.exe (diferente de cscript.exe) nao
' abre console proprio, entao a cadeia inteira fica invisivel.
'
' Uso:  wscript.exe //nologo //B "sync-oculto.vbs" [engine]
'       engine = powershell.exe (padrao) ou pwsh.exe; quem decide e o instalador.

Option Explicit

Dim shell, fso, pasta, alvo, engine, comando, codigo

Set shell = CreateObject("WScript.Shell")
Set fso   = CreateObject("Scripting.FileSystemObject")

pasta = fso.GetParentFolderName(WScript.ScriptFullName)
alvo  = fso.BuildPath(pasta, "sync-transcricoes.ps1")

If Not fso.FileExists(alvo) Then
    ' Sem caixa de dialogo: um popup de erro seria o mesmo problema com outra
    ' roupa. Codigo 2 = ERROR_FILE_NOT_FOUND, visivel em LastTaskResult.
    WScript.Quit 2
End If

engine = "powershell.exe"
If WScript.Arguments.Count > 0 Then
    If Len(Trim(WScript.Arguments(0))) > 0 Then engine = Trim(WScript.Arguments(0))
End If

comando = """" & engine & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & alvo & """"

' 0 = janela oculta desde a criacao. True = espera terminar, para que a tarefa
' so saia de "Running" quando o sync acabar de verdade -- e assim a politica
' IgnoreNew continue impedindo duas execucoes sobrepostas.
codigo = shell.Run(comando, 0, True)

WScript.Quit codigo
