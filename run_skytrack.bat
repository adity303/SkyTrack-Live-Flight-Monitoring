@echo off
setlocal enabledelayedexpansion

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "BACKEND=%ROOT%\backend"
set "VENV_PY=%ROOT%\.venv\Scripts\python.exe"
set "PYTHON_EXE="

if exist "%VENV_PY%" (
  set "PYTHON_EXE=%VENV_PY%"
) else (
  where py >nul 2>&1
  if !errorlevel! equ 0 (
    for /f "delims=" %%I in ('where py 2^>nul') do (
      if not defined PYTHON_EXE set "PYTHON_EXE=%%I"
    )
  ) else (
    where python >nul 2>&1
    if !errorlevel! equ 0 (
      for /f "delims=" %%I in ('where python 2^>nul') do (
        if not defined PYTHON_EXE set "PYTHON_EXE=%%I"
      )
    )
  )
)

if not defined PYTHON_EXE (
  echo [1/9] Python environment check FAILED.
  echo       Python was not found. Install Python 3.10+ or create .venv in the project root.
  pause
  exit /b 1
)

echo [1/9] Launching SkyTrack...
echo [2/9] Python environment: OK ("%PYTHON_EXE%")

echo [3/9] Verifying Python dependencies...
"%PYTHON_EXE%" -c "import importlib.util,sys; mods=['fastapi','uvicorn','requests','dotenv']; missing=[m for m in mods if importlib.util.find_spec(m) is None]; (print('Missing packages: ' + ', '.join(missing)) or sys.exit(1)) if missing else print('Dependencies: OK')" 
if errorlevel 1 (
  echo.
  echo Install dependencies with:
  echo   "%PYTHON_EXE%" -m pip install -r "%BACKEND%\requirements.txt"
  echo.
  pause
  exit /b 1
)

echo [4/9] Initializing database...
"%PYTHON_EXE%" -c "import os,sqlite3,json; root=r'%ROOT%'; cfg=os.path.join(root,'config.json'); db=os.path.join(root,'backend','skytrack_history.db');
if os.path.exists(cfg):
    try:
        c=json.load(open(cfg,'r',encoding='utf-8'));
        db=os.path.join(root,c.get('database_path','backend/skytrack_history.db'))
    except Exception:
        pass
os.makedirs(os.path.dirname(db), exist_ok=True); conn=sqlite3.connect(db); conn.execute('CREATE TABLE IF NOT EXISTS flight_history (id INTEGER PRIMARY KEY AUTOINCREMENT, icao24 TEXT NOT NULL, callsign TEXT, origin_country TEXT, longitude REAL, latitude REAL, altitude REAL, on_ground INTEGER, velocity REAL, heading REAL, timestamp TEXT NOT NULL)'); conn.execute('CREATE INDEX IF NOT EXISTS idx_icao24 ON flight_history(icao24)'); conn.execute('CREATE INDEX IF NOT EXISTS idx_timestamp ON flight_history(timestamp)'); conn.commit(); conn.close(); print('Database: OK ('+db+')')" 
if errorlevel 1 (
  echo Database initialization failed.
  pause
  exit /b 1
)

echo [5/9] Starting FastAPI server (no reload)...
cd /d "%BACKEND%"
start "SkyTrack Server" /D "%BACKEND%" "%PYTHON_EXE%" main.py

echo [6/9] Waiting for /health response at http://127.0.0.1:8000/health ...
powershell -NoProfile -Command "$u='http://127.0.0.1:8000/health'; $ok=$false; for($i=0;$i -lt 60;$i++){ try { $r=Invoke-WebRequest -UseBasicParsing -Uri $u -TimeoutSec 2; if($r.StatusCode -ge 200 -and $r.StatusCode -lt 500){ $ok=$true; break } } catch {}; Start-Sleep -Milliseconds 500 }; if(-not $ok){ exit 1 }"
if errorlevel 1 (
  echo.
  echo Server did not become healthy in time. Check the "SkyTrack Server" window for errors.
  echo.
  pause
  exit /b 1
)

echo [7/9] Opening http://127.0.0.1:8000 ...
start "" "http://127.0.0.1:8000"

echo [8/9] Flight dashboard will initialize in the browser.
echo [9/9] Flight-data provider connects when you search/track a flight.
echo.
echo SkyTrack is running. Close the "SkyTrack Server" window or press Ctrl+C in it to stop.
echo.
pause
