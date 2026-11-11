@echo off
cd /d "%~dp0"
if not exist node_modules call npm install
start "" http://localhost:8080
rem "Developer: restart" in the app ends the server with code 75: start it again
set TRAINER_SUPERVISED=1
:run
node --no-warnings src/server.js
if %errorlevel%==75 goto run
pause
