@echo off
chcp 65001 >nul
set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS_EXE%" (
  echo [FAIL] 找不到系统 Windows PowerShell：%PS_EXE%
  pause
  exit /b 3
)
"%PS_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0startup-diagnostics.ps1" %*
set "RESULT=%ERRORLEVEL%"
echo.
if "%RESULT%"=="0" (echo 诊断已完成。) else (echo 诊断已完成，但发现缺失、未知或报告写入问题。错误码：%RESULT%)
pause
exit /b %RESULT%
