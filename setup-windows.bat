@echo off

echo.
echo ============================================
echo  StreamTune Backend - Setup Windows SQLite
echo  Sin Docker, sin PostgreSQL, sin Redis
echo ============================================
echo.

REM Verificar carpeta correcta
IF NOT EXIST package.json (
    echo ERROR: Ejecuta este .bat desde la carpeta del proyecto
    echo Carpeta actual: %CD%
    pause
    exit /b 1
)

REM 1. Verificar Node.js
echo [1/4] Verificando Node.js...
node --version >nul 2>&1
IF %ERRORLEVEL% NEQ 0 (
    echo ERROR: Node.js no encontrado.
    echo Instala desde: https://nodejs.org
    echo Marca "Add to PATH" durante la instalacion.
    pause
    exit /b 1
)
FOR /F %%i IN ('node --version') DO echo    Node.js: %%i
FOR /F %%i IN ('npm --version')  DO echo    npm:     %%i

REM 2. Crear .env
echo.
echo [2/4] Configurando .env...
IF NOT EXIST .env (
    copy .env.example .env >nul
    echo    .env creado desde .env.example
) ELSE (
    echo    .env ya existe, omitiendo
)

REM 3. Instalar dependencias
echo.
echo [3/4] Instalando dependencias Node.js...
echo    Esto puede tardar 2-3 minutos la primera vez.
echo.

IF EXIST node_modules (
    echo    Borrando node_modules anterior...
    rmdir /s /q node_modules
)
IF EXIST package-lock.json (
    del /f /q package-lock.json
)

npm install
IF %ERRORLEVEL% NEQ 0 (
    echo.
    echo ERROR: npm install fallo.
    echo Intenta ejecutar CMD como Administrador.
    pause
    exit /b 1
)

echo.
echo    Verificando modulos criticos...
node -e "require('express');        console.log('   OK express')"        2>&1
node -e "require('better-sqlite3'); console.log('   OK better-sqlite3')" 2>&1
node -e "require('sequelize');      console.log('   OK sequelize')"      2>&1
node -e "require('ws');             console.log('   OK ws')"             2>&1
node -e "require('jsonwebtoken');   console.log('   OK jsonwebtoken')"   2>&1
node -e "require('bcryptjs');       console.log('   OK bcryptjs')"       2>&1

REM 4. Crear base de datos y cargar datos de ejemplo
echo.
echo [4/4] Creando base de datos y cargando datos de ejemplo...
node src/utils/seed.js
IF %ERRORLEVEL% NEQ 0 (
    echo    Aviso: seed fallo. Ejecuta manualmente: node src/utils/seed.js
)

REM Instalar nodemon global
echo.
echo    Instalando nodemon...
npm install -g nodemon >nul 2>&1

echo.
echo ============================================
echo  Setup completo!
echo.
echo  Para iniciar el servidor:
echo    npm run dev
echo.
echo  Si falla usa:
echo    npx nodemon src/server.js
echo    npm start
echo.
echo  Servidor en: http://localhost:3000
echo  Health:      http://localhost:3000/api/health
echo.
echo  Base de datos: streamtune.db (esta carpeta)
echo  No necesitas Docker ni PostgreSQL.
echo.
echo  Usuarios de prueba:
echo    admin@streamtune.app  / Admin1234!
echo    lofi@streamtune.app   / Creator123!
echo    viewer@streamtune.app / Viewer123!
echo ============================================
echo.
pause
