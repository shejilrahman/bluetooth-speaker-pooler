@echo off
title BT Speaker Pooler
cd /d "%~dp0"

REM Change the host PIN here if you want (default 1234).
if "%ADMIN_PIN%"=="" set ADMIN_PIN=1234
if "%PORT%"=="" set PORT=3010
REM Playback engine: vlc (audio only, default) or browser (YouTube embed on /player).
if "%PLAYER%"=="" set PLAYER=vlc

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

REM Firewall: add the rule once so other devices can reach the page (asks for admin).
netsh advfirewall firewall show rule name="BT Speaker Pooler" >nul 2>nul
if errorlevel 1 (
  echo Adding Windows Firewall rule for port %PORT% - click Yes on the admin prompt...
  powershell -NoProfile -Command "Start-Process netsh -Verb RunAs -Wait -ArgumentList 'advfirewall firewall add rule name=\"BT Speaker Pooler\" dir=in action=allow protocol=TCP localport=%PORT% profile=private,domain,public'"
)

REM Stop any older copy of this server still holding the port.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":%PORT% .*LISTENING"') do (
  echo Stopping old server (PID %%p)...
  taskkill /PID %%p /F >nul 2>nul
)

echo Starting server on port %PORT% ...
if /I "%PLAYER%"=="browser" (
  start "" http://localhost:%PORT%/player
) else (
  start "" http://localhost:%PORT%/
)
node server.js
pause
