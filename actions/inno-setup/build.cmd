@echo off

@REM echo All arguments: %*
@REM echo Arg 1 (scriptPath): %1
@REM echo Arg 2 (installerOutput): %2
@REM echo Arg 3 (issPath): %3

set scriptPath=%1
set installerOutput=%2
set issPath=%3

@REM echo iscc.exe /S"signtool=$q%scriptPath%$q sign $f" /Qp "/O%installerOutput%" %issPath%
iscc.exe /S"signtool=$q%scriptPath%$q sign $f" /Qp "/O%installerOutput%" %issPath%
