@echo off
REM Run this ONCE as Administrator (right-click -> Run as administrator).
REM It lets other devices on your Wi-Fi/LAN reach the queue page on port 3010.
if "%PORT%"=="" set PORT=3010
netsh advfirewall firewall delete rule name="BT Speaker Pooler" >nul 2>nul
netsh advfirewall firewall add rule name="BT Speaker Pooler" dir=in action=allow protocol=TCP localport=%PORT% profile=private,domain
if errorlevel 1 (
  echo Failed. Make sure you ran this as Administrator.
) else (
  echo Firewall rule added for TCP port %PORT% on private networks.
)
pause
