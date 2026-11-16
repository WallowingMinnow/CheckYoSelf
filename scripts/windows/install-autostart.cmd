@echo off
rem Makes the CheckYo'Self backend start automatically (hidden) every time you
rem sign in to Windows, and starts it now. Undo with uninstall-autostart.cmd.
rem It only adds one shortcut to YOUR Startup folder; no admin rights needed.
setlocal
set "VBS=%~dp0start-backend-hidden.vbs"
set "LNK_NAME=CheckYoSelf backend.lnk"

powershell -NoProfile -Command ^
  "$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) $env:LNK_NAME;" ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk);" ^
  "$s.TargetPath = 'wscript.exe';" ^
  "$s.Arguments = '\"' + $env:VBS + '\"';" ^
  "$s.WorkingDirectory = Split-Path $env:VBS;" ^
  "$s.Description = 'Starts the CheckYo''Self backend (http://127.0.0.1:8787)';" ^
  "$s.Save();" ^
  "Write-Output ('Added to Startup: ' + $lnk)"
if errorlevel 1 (
  echo Could not create the Startup shortcut.
  pause
  exit /b 1
)

wscript.exe "%VBS%"
echo Started the backend in the background. It will also start at every sign-in.
echo Check it: open the CheckYo'Self popup, or visit http://127.0.0.1:8787/api/health
