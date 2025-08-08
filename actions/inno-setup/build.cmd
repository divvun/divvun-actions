@echo off

REM Get command line arguments
set "scriptPath=%1"
set "installerOutput=%2"
set "issPath=%3"

REM Build the iscc command arguments
set "signToolArg="/Ssigntool=$q%scriptPath%$q sign $f""

REM Execute iscc.exe with all arguments
iscc.exe %signToolArg% /Qp "/O%installerOutput%" %issPath%
