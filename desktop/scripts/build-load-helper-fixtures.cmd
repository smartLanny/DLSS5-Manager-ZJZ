@echo off
setlocal
if not defined VSCMD_VER call "C:\BuildTools\VS2022\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b %errorlevel%
if not exist build\load-helper mkdir build\load-helper
cl /nologo /std:c++17 /O2 /W4 /EHsc /MT test\native\load-helper-target.cpp /Fobuild\load-helper\fixture-target.obj /Febuild\load-helper\fixture-target.exe /link /SUBSYSTEM:CONSOLE /MANIFEST:EMBED /MANIFESTUAC:"level='asInvoker' uiAccess='false'"
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++17 /O2 /W4 /EHsc /MT /LD test\native\load-helper-module.cpp /Fobuild\load-helper\fixture-module.obj /Febuild\load-helper\fixture-module.dll
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++17 /O2 /W4 /EHsc /MT /LD test\native\load-helper-reshade-fixture.cpp /Fobuild\load-helper\fixture-reshade.obj /Febuild\load-helper\fixture-reshade.dll
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++17 /O2 /W4 /EHsc /MT /LD test\native\load-helper-neutral-fixture.cpp /Fobuild\load-helper\fixture-neutral.obj /Febuild\load-helper\fixture-neutral.dll
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++17 /O2 /W4 /EHsc /MT /DFIXTURE_IMPORT_ORDINARY test\native\load-helper-target.cpp build\load-helper\fixture-neutral.lib /Fobuild\load-helper\fixture-preloaded-neutral.obj /Febuild\load-helper\fixture-preloaded-neutral.exe /link /SUBSYSTEM:CONSOLE /MANIFEST:EMBED /MANIFESTUAC:"level='asInvoker' uiAccess='false'"
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++17 /O2 /W4 /EHsc /MT /DFIXTURE_IMPORT_RESHADE test\native\load-helper-target.cpp build\load-helper\fixture-reshade.lib /Fobuild\load-helper\fixture-preloaded-reshade.obj /Febuild\load-helper\fixture-preloaded-reshade.exe /link /SUBSYSTEM:CONSOLE /MANIFEST:EMBED /MANIFESTUAC:"level='asInvoker' uiAccess='false'"
exit /b %errorlevel%
