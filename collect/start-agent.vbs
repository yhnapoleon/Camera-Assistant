Option Explicit
Dim shell, fs, folder, script, command
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
folder = fs.GetParentFolderName(WScript.ScriptFullName)
script = fs.BuildPath(folder, "screen-agent.ps1")
command = "powershell.exe -NoProfile -STA -File """ & script & """"
shell.Run command, 0, False
