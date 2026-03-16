@echo off
chcp 65001 >nul
echo.
echo  ==============================================
echo   StreamTune - Habilitar Hyper-V y WSL2
echo   (Ejecutar como Administrador)
echo  ==============================================
echo.
echo  Este script habilita los componentes de Windows
echo  necesarios para Docker Desktop.
echo.
echo  IMPORTANTE: Se reiniciara el equipo al finalizar.
echo.
pause

REM Verificar que se ejecuta como administrador
net session >nul 2>&1
IF %ERRORLEVEL% NEQ 0 (
    echo.
    echo  ERROR: Debes ejecutar este .bat como Administrador.
    echo  Haz clic derecho sobre el archivo y elige
    echo  "Ejecutar como administrador"
    echo.
    pause
    exit /b 1
)

echo.
echo [1/4] Habilitando Plataforma de Maquina Virtual...
dism /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
echo.

echo [2/4] Habilitando Subsistema de Windows para Linux (WSL)...
dism /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
echo.

echo [3/4] Habilitando Hyper-V...
dism /online /enable-feature /featurename:Microsoft-Hyper-V /all /norestart 2>nul
IF %ERRORLEVEL% NEQ 0 (
    echo  Hyper-V no disponible en esta edicion de Windows
    echo  (normal en Windows Home - WSL2 es suficiente)
)
echo.

echo [4/4] Estableciendo WSL2 como version por defecto...
wsl --set-default-version 2 >nul 2>&1

echo.
echo  ==============================================
echo   Componentes habilitados.
echo.
echo   SIGUIENTE PASO: Reinicia el equipo ahora.
echo   Despues del reinicio:
echo     1. Instala o reinstala Docker Desktop
echo     2. Ejecuta setup-windows.bat
echo  ==============================================
echo.
set /p REINICIAR="Reiniciar ahora? (s/n): "
IF /i "%REINICIAR%"=="s" (
    shutdown /r /t 10 /c "Reiniciando para aplicar cambios de virtualizacion"
    echo  El equipo se reiniciara en 10 segundos...
)
echo.
pause
