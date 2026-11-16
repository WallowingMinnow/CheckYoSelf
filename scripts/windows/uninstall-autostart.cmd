@echo off
rem Undoes install-autostart.cmd: removes the Startup shortcut and stops the backend.
setlocal
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\CheckYoSelf backend.lnk"
if exist "%LNK%" (
  del "%LNK%"
  echo Removed the Startup shortcut.
) else (
  echo No Startup shortcut found.
)
call "%~dp0stop-backend.cmd"
