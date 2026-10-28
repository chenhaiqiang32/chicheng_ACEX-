@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem ACEX convert - Windows SERVER manual start (double-click / CMD)
rem Copy to each instance folder, then set PORT below:
rem   fuwu_8787  -> set PORT=8787
rem   fuwu_8788  -> set PORT=8788
rem NSSM: D:\chenhaiqiang\nssm\nssm-2.24-101-g897c7ad\win64\nssm.exe
rem   Do NOT point Application to this bat; use node.exe + index.mjs
rem   Tianzheng T3: NSSM runs in Session 0 (no visible CAD UI, slow cold start).
rem   For stable T3 prefer AtLogOn scheduled task. See docs\windows-deploy.md
rem Keep this file ASCII-only (no Chinese comments).

if not defined PORT set PORT=8788

set CONVERT_IDLE_TIMEOUT_MS=600000
set CONVERT_USE_SWIFTSHADER=1
set T3_MODE=auto
set T3CONV_EXE=D:\chenhaiqiang\tianzheng\t3-conv\t3conv.exe
set "PLAYWRIGHT_CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe"

set "NODE_EXE="
where node >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%i in ('where node') do (
    if not defined NODE_EXE set "NODE_EXE=%%i"
  )
)
if not defined NODE_EXE if exist "D:\chenhaiqiang\node\node.exe" set "NODE_EXE=D:\chenhaiqiang\node\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "D:\install\node\node.exe" set "NODE_EXE=D:\install\node\node.exe"
if not defined NODE_EXE (
  echo [fuwu] node.exe not found. Install Node.js 20+ or add it to system PATH.
  goto fail
)

if not exist "index.mjs" (
  echo [fuwu] index.mjs missing in: %CD%
  goto fail
)

if not exist "logs" mkdir logs

echo [fuwu] ROOT=%CD%
echo [fuwu] NODE=%NODE_EXE%
echo [fuwu] PORT=%PORT%
echo [fuwu] T3CONV_EXE=%T3CONV_EXE%
echo [fuwu] PLAYWRIGHT_CHROME_PATH=%PLAYWRIGHT_CHROME_PATH%
echo [fuwu] health: http://127.0.0.1:%PORT%/api/health
echo [fuwu] Keep this window open. Close it to stop the server.
echo.

"%NODE_EXE%" index.mjs
set EXITCODE=%ERRORLEVEL%
echo.
if not "%EXITCODE%"=="0" (
  echo [fuwu] exit code %EXITCODE%. Check errors above / port in use / cad-data.
) else (
  echo [fuwu] process exited normally.
)
goto end

:fail
set EXITCODE=1

:end
echo.
pause
endlocal & exit /b %EXITCODE%
