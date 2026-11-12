@echo off
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\ZenX.exe" "%~dp0..\app\out\main\chrome-native-host-cli.js" %*
