# StreamTune Backend — Guía de Instalación en Windows

## Requisitos previos

### 1. Node.js (versión LTS)
Descarga e instala desde **https://nodejs.org**
- Elige la versión **LTS** (Long Term Support), actualmente 20.x
- Durante la instalación, asegúrate de marcar **"Add to PATH"**
- Verifica en CMD: `node --version` y `npm --version`

### 2. Docker Desktop
Descarga desde **https://www.docker.com/products/docker-desktop/**
- Durante la instalación activa la opción **WSL2** (recomendado)
- Después de instalar, abre Docker Desktop y espera a que diga "Running"
- Docker nos dará PostgreSQL y Redis sin instalar nada más

### 3. Git (opcional pero recomendado)
Descarga desde **https://git-scm.com/download/win**

---

## Instalación rápida (setup automático)

Abre **CMD como Administrador**, navega a la carpeta del proyecto y ejecuta:

```bat
setup-windows.bat
```

Esto hace todo automáticamente:
- Verifica Node.js y Docker
- Crea el archivo `.env`
- Levanta PostgreSQL y Redis con Docker
- Instala dependencias npm
- Carga datos de ejemplo

---

## Instalación manual (paso a paso)

### Paso 1 — Levantar base de datos y Redis

Abre CMD o PowerShell en la carpeta del proyecto:

```bat
docker compose up -d
```

Para verificar que están corriendo:
```bat
docker compose ps
```

Deberías ver `streamtune_pg` y `streamtune_redis` con estado `running`.

### Paso 2 — Configurar variables de entorno

```bat
copy .env.example .env
```

Abre `.env` con el Bloc de notas o VS Code y edita lo necesario.
Para desarrollo local, los valores por defecto funcionan sin cambios.

### Paso 3 — Instalar dependencias

```bat
npm install
```

### Paso 4 — Cargar datos de ejemplo

```bat
node src/utils/seed.js
```

### Paso 5 — Iniciar el servidor

```bat
npm run dev
```

Verás en la consola:
```
2024-01-15 10:30:00 [INFO] PostgreSQL connected
2024-01-15 10:30:00 [INFO] Redis connected
2024-01-15 10:30:00 [INFO] WebSocket server attached
2024-01-15 10:30:00 [INFO] SyncEngine started
2024-01-15 10:30:00 [INFO] StreamTune listening on port 3000 [development]
```

---

## Probar que funciona

### Health check (abre en el navegador):
```
http://localhost:3000/api/health
```
Debe responder: `{ "status": "ok", "ts": 1234567890 }`

### Login de prueba (usa Postman, Insomnia o curl):
```
POST http://localhost:3000/api/auth/login
Content-Type: application/json

{
  "email": "admin@streamtune.app",
  "password": "Admin1234!"
}
```

### Listar canales:
```
GET http://localhost:3000/api/channels
```

### WebSocket (usa wscat o Postman WebSocket):
```
ws://localhost:3000/ws/lofi-study-room
```

---

## Comandos útiles del día a día

```bat
REM Iniciar el servidor en desarrollo (con hot-reload)
npm run dev

REM Ver logs de PostgreSQL
docker compose logs postgres

REM Ver logs de Redis
docker compose logs redis

REM Detener los contenedores Docker
docker compose down

REM Reiniciar los contenedores
docker compose restart

REM Conectarse a PostgreSQL directamente
docker exec -it streamtune_pg psql -U streamtune_user -d streamtune

REM Conectarse a Redis directamente
docker exec -it streamtune_redis redis-cli

REM Resetear la base de datos (borra todo y re-seedea)
node src/utils/seed.js

REM Ejecutar tests
npm test
```

---

## Solución de problemas comunes en Windows

### "Error: EADDRINUSE: address already in use :::3000"
El puerto 3000 ya está ocupado. Cambia el puerto en `.env`:
```
PORT=3001
```
O encuentra y mata el proceso:
```bat
netstat -ano | findstr :3000
taskkill /PID <número_del_proceso> /F
```

### "Error: connect ECONNREFUSED 127.0.0.1:5432"
PostgreSQL no está corriendo. Verifica Docker Desktop y ejecuta:
```bat
docker compose up -d
```

### "Error: connect ECONNREFUSED 127.0.0.1:6379"
Redis no está corriendo. Mismo solución que arriba.

### "npm install" falla con errores de bcryptjs o pg
Algunos paquetes necesitan compilar código nativo. Instala las herramientas:
```bat
npm install --global windows-build-tools
```
O desde un CMD como Administrador:
```bat
npm install --global node-gyp
```

### Docker Desktop no arranca / WSL2 error
Abre PowerShell como Administrador y ejecuta:
```powershell
wsl --update
wsl --set-default-version 2
```
Luego reinicia Docker Desktop.

### Caracteres especiales (acentos, emojis) en la consola
El Bloc de notas y algunos terminales viejos no muestran UTF-8 bien.
Usa **Windows Terminal** (disponible en Microsoft Store, gratis) o **VS Code Terminal**.
Para habilitar UTF-8 en CMD clásico:
```bat
chcp 65001
```

---

## Herramientas recomendadas para Windows

| Herramienta | Para qué | Descarga |
|-------------|----------|----------|
| **VS Code** | Editor de código | code.visualstudio.com |
| **Windows Terminal** | Terminal moderna con UTF-8 | Microsoft Store |
| **Postman** | Probar la API REST | postman.com |
| **DBeaver** | Ver la base de datos PostgreSQL visualmente | dbeaver.io |
| **Another Redis Desktop Manager** | Ver Redis visualmente | github.com/qishibo/AnotherRedisDesktopManager |
| **Docker Desktop** | Correr Postgres y Redis | docker.com |

---

## Estructura de archivos en Windows

Los paths en el código usan `path.join()` de Node.js, que maneja
automáticamente las barras invertidas `\` de Windows vs `/` de Linux/Mac.

La carpeta de uploads se creará en:
```
C:\ruta\del\proyecto\uploads\
```

Los logs (en producción) en:
```
C:\ruta\del\proyecto\logs\
```

---

## Variables de entorno importantes

Edita el archivo `.env` en la raíz del proyecto:

```env
# Puertos (no cambiar si no hay conflicto)
PORT=3000

# Base de datos (coincide con docker-compose.yml)
DB_HOST=localhost
DB_PORT=5432
DB_NAME=streamtune
DB_USER=streamtune_user
DB_PASS=supersecret

# Redis
REDIS_URL=redis://localhost:6379

# JWT (cambia esto en producción)
JWT_SECRET=mi_secreto_muy_largo_de_al_menos_64_caracteres_aqui
JWT_REFRESH_SECRET=otro_secreto_muy_largo_de_al_menos_64_caracteres

# YouTube API (opcional en desarrollo)
YOUTUBE_API_KEY=

# Stripe (opcional en desarrollo - usa modo dev sin Stripe)
STRIPE_SECRET_KEY=
```
