@echo off
setlocal
title deepblue launcher

rem Run from the repo root regardless of where this file is double-clicked.
cd /d "%~dp0"

echo.
echo   deepblue - arrancando...
echo   carpeta: %cd%
echo.

rem pnpm must be on PATH. If double-clicking fails here, install Node/pnpm.
where pnpm >nul 2>&1
if errorlevel 1 (
  echo   ERROR: no encuentro 'pnpm' en el PATH.
  echo   Instala Node.js y pnpm, luego vuelve a intentarlo.
  echo.
  pause
  exit /b 1
)

rem PGlite is single-writer: a stale web server on :3000 holds the DB lock and
rem a second one would fail to boot. Kill whatever is listening there first.
echo   cerrando cualquier servidor anterior en :3000...
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"

rem Web dashboard + scheduler (backs up the DB on boot) and the Playwright
rem runner, each in its own window so you can watch the logs.
echo   abriendo el panel web...
start "deepblue web" cmd /k "pnpm dev:web"

echo   abriendo el runner...
start "deepblue runner" cmd /k "pnpm dev:runner"

rem Wait for the dashboard to answer, then open the browser (max ~40s).
echo   esperando al panel (http://localhost:3000)...
set /a tries=0
:waitloop
set /a tries+=1
if %tries% gtr 20 goto giveup
timeout /t 2 >nul
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://localhost:3000 -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 goto waitloop

echo   listo - abriendo el navegador.
start "" http://localhost:3000
goto done

:giveup
echo   el panel tarda mas de lo normal; abre http://localhost:3000 a mano cuando cargue.

:done
echo.
echo   deepblue en marcha. Cierra las dos ventanas (web y runner) para pararlo.
echo   Esta ventana se puede cerrar.
echo.
timeout /t 6 >nul
endlocal
