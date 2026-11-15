@echo off
cd /d "%~dp0"
rem install the dependencies on first run, and again whenever package-lock.json changed (e.g. after git pull)
fc /b package-lock.json node_modules\.paddock-installed-lock >nul 2>&1
if errorlevel 1 (
  call npm install --no-audit --no-fund || (echo npm install failed & pause & exit /b 1)
  copy /y package-lock.json node_modules\.paddock-installed-lock >nul
)
start "" http://localhost:8080
rem "Restart Paddock" (Game page) ends the server with code 75: start it again
set TRAINER_SUPERVISED=1
:run
node --no-warnings src/server.js
if %errorlevel%==75 goto run
pause
