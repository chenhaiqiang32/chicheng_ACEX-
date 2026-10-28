@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem ACEX convert - LOCAL verify (port 8788)
rem Do NOT double-click the .md docs; run this .bat
rem Server deploy: start-fuwu.bat + docs\windows-deploy.md
rem Tianzheng T3: NSSM = Session 0 (no CAD window, slow first job).
rem   Prefer AtLogOn task for stable T3. See docs\windows-deploy.local.md


if not defined PORT set PORT=8788

set CONVERT_IDLE_TIMEOUT_MS=600000
set CONVERT_USE_SWIFTSHADER=1
set T3_MODE=off
set T3CONV_EXE=D:\work\tianzheng\t3-conv\t3conv.exe
set "PLAYWRIGHT_CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe"

set "NODE_EXE="
where node >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%i in ('where node') do (
    if not defined NODE_EXE set "NODE_EXE=%%i"
  )
)
if not defined NODE_EXE if exist "D:\install\node\node.exe" set "NODE_EXE=D:\install\node\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE (
  echo [fuwu-local] node.exe not found. Install Node.js 20+ or add it to PATH.
  echo [fuwu-local] Or edit NODE fallback path in this bat: D:\install\node\node.exe
  goto fail
)

if not exist "index.mjs" (
  echo [fuwu-local] index.mjs missing in: %CD%
  goto fail
)

if not exist "logs" mkdir logs

echo [fuwu-local] ROOT=%CD%
echo [fuwu-local] NODE=%NODE_EXE%
echo [fuwu-local] PORT=%PORT%
echo [fuwu-local] T3CONV_EXE=%T3CONV_EXE%
echo [fuwu-local] PLAYWRIGHT_CHROME_PATH=%PLAYWRIGHT_CHROME_PATH%
echo [fuwu-local] health: http://127.0.0.1:%PORT%/api/health
echo [fuwu-local] Keep this window open. Close it to stop the server.
echo.

"%NODE_EXE%" index.mjs
set EXITCODE=%ERRORLEVEL%
echo.
if not "%EXITCODE%"=="0" (
  echo [fuwu-local] exit code %EXITCODE%. Check errors above / port in use / cad-data.
) else (
  echo [fuwu-local] process exited normally.
)
goto end

:fail
set EXITCODE=1

:end
echo.
pause
endlocal & exit /b %EXITCODE%
