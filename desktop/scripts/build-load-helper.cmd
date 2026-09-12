@echo off
setlocal
if not defined VSCMD_VER call "C:\BuildTools\VS2022\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b %errorlevel%
if not exist build\load-helper mkdir build\load-helper
cl /nologo /std:c++17 /O2 /W4 /EHsc /MT /DUNICODE /D_UNICODE src\native\load-helper.cpp /Fobuild\load-helper\load-helper.obj /Febuild\load-helper\dlss5-load-helper.exe /link /SUBSYSTEM:CONSOLE /MANIFEST:EMBED /MANIFESTUAC:"level='asInvoker' uiAccess='false'"
exit /b %errorlevel%
