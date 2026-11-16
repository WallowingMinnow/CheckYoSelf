@echo off
rem Stops the CheckYo'Self backend (whatever is listening on 127.0.0.1:8787).
rem It starts again at the next Windows sign-in if autostart is installed.
setlocal
set "FOUND="
for /f "tokens=5" %%P in ('netstat -ano -p TCP ^| findstr /r /c:"127\.0\.0\.1:8787 .*LISTENING"') do (
  set "FOUND=1"
  taskkill /PID %%P /T /F >nul 2>nul
)
if defined FOUND (
  echo Stopped the CheckYo'Self backend.
) else (
  echo The CheckYo'Self backend was not running.
)
