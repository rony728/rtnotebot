# 🔔 RTNote — Recordatorios multiplataforma con Telegram

Sistema de recordatorios compuesto por:

| Componente | Tecnología | Despliegue |
|---|---|---|
| **Frontend** | PWA (HTML/CSS/JS vanilla) | GitHub Pages |
| **Backend** | Node.js + Express + PostgreSQL | Ubuntu + PM2 + Cloudflare Tunnel (`api-rtnotebot.rtdev.uk`) |
| **Notificaciones** | Telegram Bot API | Bot `@rtnotebot` |

> [!IMPORTANT]
> Este repositorio es **público**. Ninguna credencial va en el código.
> Todas las claves viven en `backend/.env` (ignorado por git). Usa `backend/.env.example` como plantilla.

---

## 📁 Estructura

```text
├── backend/
│   ├── src/
│   │   ├── config/          # env.js (validación de variables), db.js (pool pg)
│   │   ├── controllers/     # authController.js
│   │   ├── middlewares/     # auth.js (JWT), errorHandler.js
│   │   ├── routes/          # index.js, authRoutes.js
│   │   ├── services/        # (Etapa 2) Telegram + scheduler
│   │   ├── utils/           # http.js (HttpError, asyncHandler)
│   │   └── index.js
│   ├── .env.example
│   ├── package.json
│   └── schema.sql
├── frontend/                # (Etapa 3)
├── .gitignore
└── README.md
```

---

## 🚀 Etapa 1 — Backend core, base de datos y autenticación

### Requisitos

- Node.js **18+** (`node -v`)
- PostgreSQL **12+** accesible (local o remoto)
- `psql` en el PATH (en Windows viene con el instalador de PostgreSQL, p. ej. `C:\Program Files\PostgreSQL\16\bin`)

### 1. Instalar dependencias

```bash
cd backend
npm install
```

### 2. Preparar la base de datos

Si aún no tienes una base/usuario dedicados, créalos (como superusuario `postgres`):

```sql
CREATE USER rtnote_user WITH PASSWORD 'una_contraseña_segura';
CREATE DATABASE rtnote OWNER rtnote_user;
```

Ejecuta el esquema (idempotente, se puede repetir sin perder datos):

**Windows (PowerShell):**
```powershell
cd backend
psql -h localhost -U rtnote_user -d rtnote -f .\schema.sql
```

**Ubuntu:**
```bash
cd backend
psql -h localhost -U rtnote_user -d rtnote -f ./schema.sql
```

Verifica las tablas:
```bash
psql -h localhost -U rtnote_user -d rtnote -c "\dt"
```

### 3. Configurar variables de entorno

```powershell
# Windows
Copy-Item .env.example .env
```
```bash
# Ubuntu
cp .env.example .env
```

Genera un `JWT_SECRET` fuerte y pégalo en `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

| Variable | Descripción |
|---|---|
| `PORT` | Puerto HTTP de la API (por defecto `3000`) |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Conexión a PostgreSQL |
| `DB_SSL` | `true` si el servidor exige SSL |
| `JWT_SECRET` | Clave de firma de tokens (mín. 32 caracteres) |
| `JWT_EXPIRES_IN` | Validez del token (`7d`, `12h`…) |
| `TELEGRAM_BOT_TOKEN` | Token de `@rtnotebot` (se usa desde la Etapa 2) |
| `CORS_ORIGINS` | Orígenes permitidos separados por coma |

### 4. Arrancar

```bash
npm run dev     # con recarga automática (nodemon)
# o
npm start
```

Deberías ver:
```
[server] RTNote API escuchando en http://localhost:3000 (development)
[db] Conexión a PostgreSQL OK (...)
```

---

## 🧪 Probar los endpoints

### Endpoints disponibles

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `GET` | `/api/health` | — | Estado de la API y la BD |
| `POST` | `/api/auth/register` | — | Registro `{ username, password, telegram_chat_id? }` |
| `POST` | `/api/auth/login` | — | Login `{ username, password }` → `{ token, user }` |
| `GET` | `/api/auth/profile` | Bearer | Perfil del usuario autenticado |
| `GET` | `/api/auth/telegram/status` | Bearer | Estado de conexión y username de `@rtnotebot` |
| `PUT` | `/api/auth/telegram` | Bearer | Vincular chat `{ telegram_chat_id }` (valida existencia) |
| `DELETE` | `/api/auth/telegram` | Bearer | Desvincular Telegram |
| `POST` | `/api/auth/test-telegram` | Bearer | Enviar mensaje de prueba al chat vinculado |
| `GET` | `/api/reminders` | Bearer | Listar recordatorios (`?view=upcoming`, `?view=history`, `?status=...`) |
| `GET` | `/api/reminders/:id` | Bearer | Detalle de un recordatorio |
| `POST` | `/api/reminders` | Bearer | Crear recordatorio `{ title, description?, scheduled_at }` |
| `PUT` | `/api/reminders/:id` | Bearer | Modificar recordatorio (solo si está `pending`) |
| `DELETE` | `/api/reminders/:id` | Bearer | Cancelar (`status='cancelled'`) o permanente (`?permanent=true`) |

### Zona Horaria de Honduras (America/Tegucigalpa / UTC-6)
- Si envías `scheduled_at` sin offset (ej: `"2026-10-15T08:30"`), el backend lo asume automáticamente en **hora de Honduras**.
- Si envías formato con offset/UTC (`"2026-10-15T14:30:00Z"`), se normaliza correctamente.
- La respuesta incluye siempre `scheduled_at` (UTC ISO), `scheduled_at_local` (ISO con -06:00) y `scheduled_at_display` (`DD/MM/YYYY hh:mm A`).

---

## 🔐 Seguridad y Concurrencia Implementada

- Contraseñas con **bcrypt** (12 rondas); login con mensaje genérico y hash ficticio contra timing attacks.
- **JWT HS256** con algoritmo fijado e `issuer` verificado.
- **Rate limiting** en `/register`, `/login` y `/test-telegram`.
- **Bloqueo Atómico en Scheduler**: Sentencia `WITH due AS (SELECT ... FOR UPDATE SKIP LOCKED)` + lease `locked_until` para evitar colisiones entre workers o PM2 clusters.
- **Backoff Exponencial**: Reintentos automáticos para errores de red/Telegram (429/5xx) y marcación `failed` si el bot está bloqueado o supera el límite.
- Consultas **100% parametrizadas** en PostgreSQL.

---

---

## 📱 Frontend PWA (GitHub Pages)

El frontend vive en la carpeta `frontend/` y no requiere ningún proceso de compilación (`npm run build` o similar). Está diseñado con rutas relativas (`./`) para funcionar tanto en la raíz de un dominio como en subdirectorios de GitHub Pages (`https://<usuario>.github.io/<repo>/`).

- **PWA Instalable**: `manifest.json` e iconos (192x192, 512x512 y SVG) en `frontend/icons/`.
- **Offline & Cache**: `sw.js` con estrategia Stale-While-Revalidate para estáticos y Network-Only para endpoints de API.
- **Configuración de API dinámica**: Apunta por defecto a `https://api-rtnotebot.rtdev.uk`, pero se puede cambiar a local (`http://localhost:3000`) desde el botón de configuración (⚙️) en la interfaz.

Para probar el frontend en local:
```bash
# Puedes usar cualquier servidor estático:
npx serve frontend
# O abrir con la extensión "Live Server" en VS Code
```

---

## 🚀 Despliegue en Producción

La guía completa paso a paso para el despliegue del sistema (Ubuntu Server, PM2, Cloudflare Tunnel y GitHub Pages) se encuentra en:
👉 **[DEPLOYMENT_GUIDE.md](file:///c:/Users/Rony/Documents/Proyectos%20Antigravity/PWA_Recordatorios/DEPLOYMENT_GUIDE.md)**

---

## 🗺️ Hoja de ruta

- [x] **Etapa 1** — Backend core, BD y autenticación
- [x] **Etapa 2** — API de recordatorios + motor de notificaciones Telegram
- [x] **Etapa 3** — Frontend PWA (Mobile-First) lista para GitHub Pages
- [x] **Etapa 4** — Despliegue en producción (Ubuntu Server, PM2, Cloudflare Tunnel y GitHub Pages)


