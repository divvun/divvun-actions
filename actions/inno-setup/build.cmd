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

REM Build the iscc command arguments
set signToolArg="/Ssigntool=%scriptPath% sign $f"

iscc.exe %signToolArg% /Qp "/O%installerOutput%" %issPath%
