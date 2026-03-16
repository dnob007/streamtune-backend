@echo off
chcp 65001 >nul
echo.
echo  ==============================================
echo   StreamTune - Verificar Virtualizacion
echo  ==============================================
echo.

echo [1] Estado de Virtualizacion en este equipo:
echo.
systeminfo | findstr /i "Virtualizacion\|Hyper-V\|Virtualization"
echo.

echo [2] Detalles del procesador:
wmic cpu get Name, VirtualizationFirmwareEnabled /format:list 2>nul
echo.

echo [3] Estado de Hyper-V y WSL:
dism /online /get-featureinfo /featurename:VirtualMachinePlatform 2>nul | findstr /i "State\|Estado"
dism /online /get-featureinfo /featurename:Microsoft-Windows-Subsystem-Linux 2>nul | findstr /i "State\|Estado"
echo.

echo  ==============================================
echo   Interpreta los resultados:
echo.
echo   VirtualizationFirmwareEnabled = TRUE
echo     -> Virtualizacion YA habilitada en BIOS
echo        El problema es otro (ver abajo)
echo.
echo   VirtualizationFirmwareEnabled = FALSE
echo     -> Hay que habilitarla en el BIOS/UEFI
echo        Ver instrucciones en la guia
echo.
echo   Si no aparece nada -> systeminfo no esta
echo        disponible, usa el Administrador de tareas
echo  ==============================================
echo.
pause
