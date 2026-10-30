@echo off
REM Makes Windows sign in automatically after power-on, so Speaker Queue starts
REM without anyone touching the PC. Run once; it asks for admin rights.
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
  exit /b
)
REM Windows 11 hides the "Users must enter a user name and password" checkbox
REM while Windows Hello sign-in is required. This shows it again.
reg add "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device" /v DevicePasswordLessBuildVersion /t REG_DWORD /d 0 /f >nul
echo.
echo  A "User Accounts" window will open now.
echo    1. UNTICK  "Users must enter a user name and password to use this computer"
echo    2. Click OK, type this account's password twice, OK.
echo.
echo  Also recommended: Settings ^> Accounts ^> Sign-in options ^> set
echo  "If you've been away, when should Windows require you to sign in again?" to Never.
echo.
start /wait netplwiz
pause
