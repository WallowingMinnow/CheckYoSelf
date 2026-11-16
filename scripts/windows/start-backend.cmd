@echo off
rem Starts the CheckYo'Self backend on http://127.0.0.1:8787.
rem Double-click it, or let the Windows sign-in shortcut run it hidden
rem (see install-autostart.cmd). Output goes to backend\backend.log
rem (ids, statuses and counts only; never post text or secrets).
setlocal
cd /d "%~dp0..\..\backend" || exit /b 1

rem Find Node.js: on the PATH, or in its standard install folder (the PATH
rem isn't always up to date right after installing Node).
where node >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and try again.
  pause
  exit /b 1
)

if not exist ".env" (
  echo backend\.env is missing. Copy backend\.env.example to backend\.env and fill in the Databricks values.
  pause
  exit /b 1
)

rem Already running? Then there is nothing to do.
netstat -ano -p TCP | findstr /r /c:"127\.0\.0\.1:8787 .*LISTENING" >nul
if not errorlevel 1 (
  echo The CheckYo'Self backend is already running on http://127.0.0.1:8787.
  echo If you updated the code since it started, it is still running the OLD code:
  echo run stop-backend.cmd, then this file again.
  exit /b 0
)

rem First run (or a half-finished install): install the backend's packages.
if not exist "node_modules\tsx\dist\cli.mjs" (
  echo Installing backend packages...
  call npm ci >> backend.log 2>&1
)

rem Keep the log small: start a new one when it passes 5 MB.
if exist backend.log for %%A in (backend.log) do if %%~zA GTR 5000000 del backend.log

echo [%date% %time%] starting >> backend.log
call npm start >> backend.log 2>&1
