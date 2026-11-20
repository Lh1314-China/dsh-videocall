@echo off
title dsh-videocall - firewall fix
chcp 65001 >nul

net session >nul 2>&1
if %errorLevel% neq 0 (
  echo.
  echo   [x] Need administrator rights.
  echo       Right-click this file -^> "Run as administrator".
  echo.
  pause
  exit /b 1
)

echo.
echo   ============================================================
echo    Step 1: inspect DeepSeek Harness inbound rules
echo   ============================================================
echo.
netsh advfirewall firewall show rule name="DeepSeek Harness" dir=in

echo.
echo   ============================================================
echo    Step 2: remove the BLOCK rules that shadow everything
echo   ============================================================
echo.

set FOUND=0
for /f "delims=" %%R in ('netsh advfirewall firewall show rule name^="DeepSeek Harness" dir^=in ^| findstr /b /c:"Rule Name:"') do set FOUND=1

if "%FOUND%"=="1" (
  echo   Deleting inbound rules named "DeepSeek Harness" ...
  netsh advfirewall firewall delete rule name="DeepSeek Harness" dir=in >nul 2>&1
  echo   [ok] deleted ^(if a Block rule existed, it is gone now^)
) else (
  echo   [i] no "DeepSeek Harness" inbound rule found, skipping
)

echo.
echo   ============================================================
echo    Step 3: allow inbound TCP 8790 only
echo   ============================================================
echo.

netsh advfirewall firewall delete rule name="dsh-videocall 8790" >nul 2>&1
netsh advfirewall firewall add rule name="dsh-videocall 8790" dir=in action=allow protocol=TCP localport=8790 profile=private,public >nul

if %errorLevel% equ 0 (
  echo   [ok] inbound TCP 8790 allowed for Private and Public
) else (
  echo   [x] failed to add the rule
)

echo.
echo   Current state:
netsh advfirewall firewall show rule name="dsh-videocall 8790"

echo.
echo   Next: on the phone, close the old tab and open the link again.
echo.
echo   Press any key to close.
pause >nul
