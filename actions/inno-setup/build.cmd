@echo off

REM Print all command line arguments for debugging
echo All arguments: %*
echo Arg 1 (scriptPath): %1
echo Arg 2 (installerOutput): %2
echo Arg 3 (issPath): %3

REM Get command line arguments
set scriptPath=%1
set installerOutput=%2
set issPath=%3

echo iscc.exe /S"signtool=$q%scriptPath%$q sign $f" /Qp "/O%installerOutput%" %issPath%
iscc.exe /S"signtool=$q%scriptPath%$q sign $f" /Qp "/O%installerOutput%" %issPath%
