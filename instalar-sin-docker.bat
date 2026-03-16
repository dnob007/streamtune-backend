@echo off
chcp 65001 >nul
echo.
echo  ==============================================
echo   StreamTune - Configurar PostgreSQL nativo
echo   (Sin Docker)
echo  ==============================================
echo.
echo  Este script asume que ya instalaste PostgreSQL
echo  desde https://www.postgresql.org/download/windows/
echo.
echo  Si aun no lo instalaste, abre SIN-DOCKER-SETUP.md
echo  y sigue el Paso 1 primero.
echo.
pause

REM ── Buscar psql en rutas comunes de instalacion ───────────
set PSQL=
IF EXIST "C:\Program Files\PostgreSQL\16\bin\psql.exe" set PSQL="C:\Program Files\PostgreSQL\16\bin\psql.exe"
IF EXIST "C:\Program Files\PostgreSQL\15\bin\psql.exe" set PSQL="C:\Program Files\PostgreSQL\15\bin\psql.exe"
IF EXIST "C:\Program Files\PostgreSQL\14\bin\psql.exe" set PSQL="C:\Program Files\PostgreSQL\14\bin\psql.exe"
IF EXIST "C:\Program Files\PostgreSQL\17\bin\psql.exe" set PSQL="C:\Program Files\PostgreSQL\17\bin\psql.exe"

REM Intentar desde PATH
IF "%PSQL%"=="" (
    where psql >nul 2>&1
    IF %ERRORLEVEL% EQU 0 set PSQL=psql
)

IF "%PSQL%"=="" (
    echo.
    echo  ERROR: No encuentro psql.exe
    echo  Instala PostgreSQL desde:
    echo  https://www.postgresql.org/download/windows/
    echo.
    pause
    exit /b 1
)
echo  OK - PostgreSQL encontrado: %PSQL%
echo.

REM ── Pedir contrasena del superusuario postgres ────────────
echo  Ingresa la contrasena del superusuario de PostgreSQL
echo  (la que pusiste al instalar, por defecto: supersecret)
echo.
set /p PG_SUPER_PASS="Contrasena de postgres: "
echo.

REM ── Crear usuario y base de datos ────────────────────────
echo  Creando usuario streamtune_user y base de datos...
echo.

set PGPASSWORD=%PG_SUPER_PASS%

REM Crear usuario (ignora error si ya existe)
%PSQL% -U postgres -c "CREATE USER streamtune_user WITH PASSWORD 'supersecret';" 2>nul
%PSQL% -U postgres -c "ALTER USER streamtune_user WITH PASSWORD 'supersecret';" 2>nul

REM Crear base de datos (ignora error si ya existe)
%PSQL% -U postgres -c "CREATE DATABASE streamtune OWNER streamtune_user;" 2>nul
%PSQL% -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE streamtune TO streamtune_user;" 2>nul

REM Verificar conexion con el nuevo usuario
echo  Verificando conexion con streamtune_user...
set PGPASSWORD=supersecret
%PSQL% -U streamtune_user -d streamtune -c "SELECT 'Conexion OK' as estado;" 2>&1

IF %ERRORLEVEL% NEQ 0 (
    echo.
    echo  ERROR: No se pudo conectar con streamtune_user.
    echo  Verifica la contrasena del superusuario e intenta de nuevo.
    echo.
    pause
    exit /b 1
)

REM ── Actualizar .env ───────────────────────────────────────
echo.
echo  Verificando .env...
IF NOT EXIST .env (
    IF EXIST .env.example (
        copy .env.example .env >nul
        echo  OK - .env creado desde .env.example
    ) ELSE (
        echo  AVISO: .env.example no encontrado
    )
)

REM ── Ejecutar migracion ────────────────────────────────────
echo.
echo  Ejecutando migracion de base de datos...
node src/utils/migrate.js
IF %ERRORLEVEL% NEQ 0 (
    echo.
    echo  ERROR en la migracion.
    echo  Verifica que .env tenga las credenciales correctas.
    pause
    exit /b 1
)

REM ── Ejecutar seed ─────────────────────────────────────────
echo.
echo  Cargando datos de ejemplo...
node src/utils/seed.js

echo.
echo  ==============================================
echo   PostgreSQL configurado correctamente.
echo.
echo   IMPORTANTE: Para Redis necesitas instalar
echo   Memurai (gratis) desde:
echo   https://www.memurai.com/get-memurai
echo.
echo   Una vez instalado Redis/Memurai, arranca
echo   el servidor con:
echo     npx nodemon src/server.js
echo  ==============================================
echo.
pause
