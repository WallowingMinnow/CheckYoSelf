' Runs start-backend.cmd with no window. Used by the shortcut that
' install-autostart.cmd puts in the Windows Startup folder.
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & here & "\start-backend.cmd""", 0, False
