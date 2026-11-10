@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem ACEX html-exporter convert server (Node, no browser)
rem Keep this file ASCII-only (no Chinese comments).
rem On crash (exit code != 0): kill leftovers, free memory, restart after delay.
rem Ctrl+C / closing the window still stops everything.

if not defined PORT set PORT=8788
if not defined T3_MODE set T3_MODE=auto
rem Seconds to wait before restarting after a crash.
if not defined RESTART_DELAY set RESTART_DELAY=3

set "NODE_EXE="
where node >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%i in ('where node') do (
    if not defined NODE_EXE set "NODE_EXE=%%i"
  )
)
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE (
  echo [html-exporter] node.exe not found. Install Node.js 22+ or add it to PATH.
  goto fail
)

if not exist "index.mjs" (
  echo [html-exporter] index.mjs missing in: %CD%
  goto fail
)

if not exist "cad-data\fonts\fonts.json" (
  echo [html-exporter] cad-data missing. Running sync:cad-data ...
  "%NODE_EXE%" scripts\sync-cad-data.mjs
  if errorlevel 1 goto fail
)

if not exist "logs" mkdir logs

echo [html-exporter] ROOT=%CD%
echo [html-exporter] NODE=%NODE_EXE%
echo [html-exporter] PORT=%PORT%
echo [html-exporter] T3_MODE=%T3_MODE%
echo [html-exporter] RESTART_DELAY=%RESTART_DELAY%s (on crash)
echo [html-exporter] health: http://127.0.0.1:%PORT%/api/health
echo [html-exporter] Keep this window open. Close it / Ctrl+C to stop.
echo.

set ATTEMPT=0

:run
set /a ATTEMPT+=1
if %ATTEMPT% GTR 1 (
  echo [html-exporter] restart attempt #%ATTEMPT% ...
)

rem Free PORT and any leftover workers before each launch.
call :cleanup_leftovers

"%NODE_EXE%" index.mjs
set EXITCODE=%ERRORLEVEL%
echo.

if "%EXITCODE%"=="0" (
  echo [html-exporter] process exited normally.
  goto end
)

echo [html-exporter] exit code %EXITCODE%. Cleaning leftover processes / memory ...
call :cleanup_leftovers
echo [html-exporter] Will restart in %RESTART_DELAY%s ...
echo [html-exporter] ^(Ctrl+C now to stop; in-memory jobs will be lost on restart^)
timeout /t %RESTART_DELAY% /nobreak >nul
goto run

:fail
set EXITCODE=1

:end
echo.
pause
endlocal & exit /b %EXITCODE%
