@echo off
REM Mirror phone screen to PC (scrcpy). Uses SDK adb so "adb reverse tcp:5173" is not dropped.
set "ADB=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"
set "SCRCPY=%LOCALAPPDATA%\Microsoft\WinGet\Packages\Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe\scrcpy-win64-v5.0.1\scrcpy.exe"
"%ADB%" reverse tcp:5173 tcp:5173 >nul 2>&1
REM --stay-awake: no sleep on USB / --show-touches: show tap dots / Alt+F: fullscreen
"%SCRCPY%" --stay-awake --show-touches --no-audio --window-title "aid-helper demo" --window-height 1000
if errorlevel 1 pause
