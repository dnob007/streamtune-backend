@echo off

echo.
echo ============================================
echo  StreamTune - Diagnostico del Sistema
echo ============================================
echo.

echo Carpeta actual:
cd
echo.

echo [Node.js]
node --version >nul 2>&1
IF %ERRORLEVEL% NEQ 0 (
    echo    NO encontrado - instala desde nodejs.org
) ELSE (
    FOR /F %%i IN ('node --version') DO echo    Node.js: %%i
    FOR /F %%i IN ('npm --version')  DO echo    npm:     %%i
)
echo.

echo [package.json]
IF EXIST package.json (
    echo    OK - encontrado
) ELSE (
    echo    NO encontrado - ejecuta este .bat desde la carpeta del proyecto
)
echo.

echo [node_modules]
IF EXIST node_modules (
    echo    OK - existe
    node -e "require('express');        console.log('   OK express')"        2>&1
    node -e "require('better-sqlite3'); console.log('   OK better-sqlite3')" 2>&1
    node -e "require('sequelize');      console.log('   OK sequelize')"      2>&1
    node -e "require('ws');             console.log('   OK ws')"             2>&1
    node -e "require('jsonwebtoken');   console.log('   OK jsonwebtoken')"   2>&1
    node -e "require('bcryptjs');       console.log('   OK bcryptjs')"       2>&1
) ELSE (
    echo    NO existe - ejecuta: npm install
)
echo.

echo [Archivo .env]
IF EXIST .env (
    echo    OK - existe
    echo    Variables de base de datos:
    findstr /i "DB_ REDIS PORT NODE_ENV" .env 2>nul
) ELSE (
    echo    NO existe - ejecuta: copy .env.example .env
)
echo.

echo [Base de datos SQLite]
IF EXIST streamtune.db (
    echo    OK - streamtune.db existe
) ELSE (
    echo    NO existe aun - se creara al arrancar el servidor
    echo    O ejecuta: node src/utils/seed.js
)
echo.

echo [Puerto 3000]
netstat -ano 2>nul | findstr ":3000 " >nul 2>&1
IF %ERRORLEVEL% EQU 0 (
    echo    Algo escucha en el puerto 3000 (servidor posiblemente corriendo)
) ELSE (
    echo    Puerto 3000 libre (servidor no esta corriendo)
)
echo.

echo [nodemon global]
nodemon --version >nul 2>&1
IF %ERRORLEVEL% EQU 0 (
    FOR /F %%i IN ('nodemon --version') DO echo    OK - nodemon: %%i
) ELSE (
    echo    nodemon no instalado globalmente
    echo    Instala con:  npm install -g nodemon
    echo    O usa:        npx nodemon src/server.js
)
echo.

echo ============================================
echo  Comandos utiles:
echo    Instalar todo:   npm install
echo    Cargar datos:    node src/utils/seed.js
echo    Iniciar server:  npm run dev
echo    Sin hot-reload:  npm start
echo ============================================
echo.
pause
