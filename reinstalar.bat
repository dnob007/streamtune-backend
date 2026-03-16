@echo off

echo.
echo ============================================
echo  StreamTune - Reinstalar dependencias
echo ============================================
echo.
echo Este script borra node_modules y reinstala
echo todo desde cero. Tarda 2-3 minutos.
echo.
pause

IF NOT EXIST package.json (
    echo ERROR: Ejecuta desde la carpeta del proyecto.
    pause
    exit /b 1
)

echo Borrando node_modules...
IF EXIST node_modules rmdir /s /q node_modules

echo Borrando package-lock.json...
IF EXIST package-lock.json del /f /q package-lock.json

echo Limpiando cache de npm...
npm cache clean --force

echo.
echo Reinstalando... (puede tardar unos minutos)
echo.
npm install

IF %ERRORLEVEL% NEQ 0 (
    echo.
    echo ERROR: npm install fallo.
    echo Ejecuta CMD como Administrador e intenta de nuevo.
    pause
    exit /b 1
)

echo.
echo Verificando modulos...
node -e "require('express');        console.log('   OK express')"        2>&1
node -e "require('better-sqlite3'); console.log('   OK better-sqlite3')" 2>&1
node -e "require('sequelize');      console.log('   OK sequelize')"      2>&1
node -e "require('ws');             console.log('   OK ws')"             2>&1

npm install -g nodemon >nul 2>&1

echo.
echo ============================================
echo  Reinstalacion completa.
echo  Inicia el servidor con:
echo    npm run dev
echo ============================================
echo.
pause
