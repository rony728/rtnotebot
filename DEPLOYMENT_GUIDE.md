# 📖 Guía Completa de Despliegue en Producción — RTNote

Esta guía detalla paso a paso el despliegue del sistema completo de recordatorios:
1. **Frontend PWA**: Alojado en **GitHub Pages** con despliegue automatizado por GitHub Actions.
2. **Backend API**: Ejecutándose en **Ubuntu Server** gestionado por **PM2** y conectado a PostgreSQL.
3. **Exposición Segura**: A través de **Cloudflare Tunnel (`cloudflared`)** bajo el subdominio `https://api-rtnotebot.rtdev.uk`.
4. **Notificaciones**: Integradas con el bot existente `@rtnotebot` en hora local de Honduras (`America/Tegucigalpa` / UTC-6).

---

## 🏗️ Diagrama de Arquitectura de Producción

```text
  [ Dispositivo Móvil / Desktop ]
                │
                ├───────► HTTPS: GitHub Pages (PWA Frontend)
                │         https://<usuario>.github.io/<repo>/
                │
                └───────► HTTPS: Cloudflare Edge
                          https://api-rtnotebot.rtdev.uk
                                    │
                         (Túnel cifrado cloudflared)
                                    ▼
                          [ Ubuntu Server ]
                            ├─ cloudflared (systemd service)
                            │       │ HTTP :3000
                            │       ▼
                            ├─ PM2 (rtnote-api en Node.js)
                            │       │
                            │       ▼
                            ├─ PostgreSQL (localhost:5432)
                            │
                            └─ Telegram Bot API (@rtnotebot)
```

---

## 🚀 PARTE 1: Despliegue del Frontend en GitHub Pages

El repositorio cuenta con el flujo de automatización en `.github/workflows/deploy-pages.yml` que empaqueta y publica automáticamente la carpeta `frontend/` sin necesidad de generar ramas huérfanas manuales.

### Paso 1.1: Habilitar GitHub Actions en GitHub Pages
1. Ve a tu repositorio en GitHub: `https://github.com/<tu-usuario>/<tu-repositorio>`.
2. Haz clic en la pestaña **Settings** (Configuración).
3. En el menú lateral izquierdo, haz clic en **Pages**.
4. En la sección **Build and deployment**:
   - **Source**: Selecciona **GitHub Actions** (en lugar de "Deploy from a branch").
5. Guarda los cambios.

### Paso 1.2: Subir el código a la rama principal (`main`)
En tu entorno de desarrollo local (Windows):
```powershell
# Inicializar git si aún no está inicializado
git init
git add .
git commit -m "feat: release v1.0.0 con backend, frontend PWA y configuración PM2"

# Conectar con tu repositorio remoto en GitHub
git branch -M main
git remote add origin https://github.com/<tu-usuario>/<tu-repositorio>.git
git push -u origin main
```

### Paso 1.3: Verificar el despliegue del Frontend
1. En GitHub, ve a la pestaña **Actions**.
2. Verás el flujo **"Desplegar Frontend PWA en GitHub Pages"** ejecutándose.
3. Al finalizar con éxito (marca verde), GitHub mostrará la URL pública de tu aplicación:
   `https://<tu-usuario>.github.io/<tu-repositorio>/`
4. Abre la URL en tu navegador móvil (Chrome en Android o Safari en iOS). Notarás la opción para **"Instalar aplicación"**.

---

## 🖥️ PARTE 2: Despliegue del Backend en Ubuntu Server

### Paso 2.1: Requisitos previos en el servidor Ubuntu
Conéctate por SSH a tu servidor:
```bash
ssh usuario@tu-servidor-ip
```

Asegúrate de contar con Node.js (v18 o v20 LTS), Git y PM2:
```bash
# Actualizar lista de paquetes
sudo apt update && sudo apt upgrade -y

# Instalar Node.js 20 LTS (si no lo tienes)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git

# Instalar PM2 globalmente
sudo npm install -g pm2
```

### Paso 2.2: Clonar el proyecto
Crea una carpeta de trabajo y clona el repositorio:
```bash
# Ubicación recomendada: /var/www/rtnote o en tu home directory
mkdir -p /var/www/rtnote
sudo chown -R $USER:$USER /var/www/rtnote
cd /var/www/rtnote

# Clonar el repositorio
git clone https://github.com/<tu-usuario>/<tu-repositorio>.git .
```

### Paso 2.3: Configurar variables de entorno (`.env`)
Accede a la carpeta `backend/` y crea el archivo `.env` a partir de la plantilla:
```bash
cd /var/www/rtnote/backend
cp .env.example .env
nano .env
```

Genera un secreto JWT criptográficamente seguro desde la terminal:
```bash
openssl rand -hex 32
# Ejemplo de salida: 4f8b9e...
```

Edita el archivo `.env` con tus credenciales reales:
```ini
# ============================================
# RTNote Backend - Variables de Producción
# ============================================

NODE_ENV=production
PORT=3000

# Base de datos PostgreSQL local
DB_HOST=localhost
DB_PORT=5432
DB_USER=rtnote_user
DB_PASSWORD=TuPasswordSuperSegura123
DB_NAME=rtnote
DB_SSL=false

# Secreto JWT generado
JWT_SECRET=tu_secreto_hexadecimal_de_al_menos_64_caracteres
JWT_EXPIRES_IN=7d

# Token del bot de Telegram obtenido de @BotFather
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ

# Zona horaria de Honduras (UTC-6)
APP_TIMEZONE=America/Tegucigalpa

# Configuración del motor de recordatorios
SCHEDULER_ENABLED=true
SCHEDULER_CRON=* * * * *
SCHEDULER_BATCH_SIZE=50
REMINDER_MAX_ATTEMPTS=5

# CORS: URL de tu GitHub Pages (¡sin barra al final!)
CORS_ORIGINS=https://<tu-usuario>.github.io
```
Guarda y sal (`Ctrl + O`, `Enter`, `Ctrl + X`).

### Paso 2.4: Inicializar la Base de Datos PostgreSQL
Si la base de datos o usuario aún no existen en tu servidor PostgreSQL:
```bash
# Acceder a PostgreSQL como superusuario postgres
sudo -u postgres psql
```
En la consola de PostgreSQL:
```sql
CREATE USER rtnote_user WITH ENCRYPTED PASSWORD 'TuPasswordSuperSegura123';
CREATE DATABASE rtnote OWNER rtnote_user;
GRANT ALL PRIVILEGES ON DATABASE rtnote TO rtnote_user;
\q
```

Ahora ejecuta el esquema SQL de migraciones (idempotente):
```bash
cd /var/www/rtnote/backend
psql -h localhost -U rtnote_user -d rtnote -f schema.sql
```
*(Te solicitará la contraseña configurada para `rtnote_user`).*

### Paso 2.5: Instalar dependencias de producción
```bash
cd /var/www/rtnote/backend
# Instala solo dependencias de producción (omite nodemon y devDependencies)
npm install --omit=dev
```

### Paso 2.6: Puesta en marcha y persistencia con PM2
Inicia la API usando el archivo [ecosystem.config.js](file:///c:/Users/Rony/Documents/Proyectos%20Antigravity/PWA_Recordatorios/backend/ecosystem.config.js):
```bash
cd /var/www/rtnote/backend
pm2 start ecosystem.config.js --env production
```

Comprueba el estado del proceso:
```bash
pm2 status
```
Deberías ver `rtnote-api` con estado `online`.

Revisa los logs para confirmar la conexión a PostgreSQL y el inicio del scheduler:
```bash
pm2 logs rtnote-api --lines 20
```
*(Debe verse: `[server] RTNote API escuchando en http://localhost:3000 (production)`, `[db] Conexión a PostgreSQL OK` y `[scheduler] Iniciado`).*

**Habilitar autoarranque al reiniciar el servidor:**
```bash
# Genera el comando de inicio para systemd
pm2 startup

# (Copia y ejecuta en la terminal el comando `sudo env PATH=...` que te indique PM2)

# Guarda la lista actual de procesos
pm2 save
```

---

## 🛡️ PARTE 3: Exposición Segura con Cloudflare Tunnel (`cloudflared`)

Cloudflare Tunnel permite exponer el puerto local `3000` de forma segura a través de `https://api-rtnotebot.rtdev.uk` sin abrir puertos en el firewall ni necesidad de IP pública estática.

### Paso 3.1: Instalar `cloudflared` en Ubuntu
```bash
# Descargar el paquete oficial de Cloudflare
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb

# Instalar el paquete
sudo dpkg -i cloudflared.deb
rm cloudflared.deb
```

### Paso 3.2: Autenticar `cloudflared` con tu cuenta de Cloudflare
```bash
cloudflared tunnel login
```
*Se mostrará una URL en la terminal. Ábrela en tu navegador para autorizar el dominio `rtdev.uk`.*

### Paso 3.3: Crear el Túnel para la API
```bash
cloudflared tunnel create rtnote-tunnel
```
*Este comando devolverá el **Tunnel ID** (un UUID similar a `a1b2c3d4-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) y creará un archivo de credenciales JSON en `~/.cloudflared/<TUNNEL_ID>.json`.*

### Paso 3.4: Crear el archivo de configuración del túnel
Crea la carpeta de configuración del sistema si no existe:
```bash
sudo mkdir -p /etc/cloudflared
```
Copia el archivo de credenciales al directorio del sistema:
```bash
sudo cp ~/.cloudflared/<TUNNEL_ID>.json /etc/cloudflared/
```

Crea el archivo `/etc/cloudflared/config.yml`:
```bash
sudo nano /etc/cloudflared/config.yml
```
Pega el siguiente contenido (reemplazando `<TUNNEL_ID>` por tu UUID real):
```yaml
tunnel: <TUNNEL_ID>
credentials-file: /etc/cloudflared/<TUNNEL_ID>.json

ingress:
  # Enrutar el subdominio al backend local en Express
  - hostname: api-rtnotebot.rtdev.uk
    service: http://localhost:3000
    originRequest:
      connectTimeout: 10s
      noTLSVerify: false

  # Regla comodín de captura para cualquier otra petición
  - service: http_status:404
```
Guarda y sal (`Ctrl + O`, `Enter`, `Ctrl + X`).

### Paso 3.5: Crear la ruta DNS en Cloudflare
Asocia el subdominio `api-rtnotebot.rtdev.uk` con el túnel recién creado:
```bash
cloudflared tunnel route dns rtnote-tunnel api-rtnotebot.rtdev.uk
```
*Cloudflare creará automáticamente un registro CNAME en tu panel DNS apuntando al túnel.*

### Paso 3.6: Instalar e iniciar `cloudflared` como servicio systemd
Para que el túnel se ejecute como demonio y arranque siempre con el servidor:
```bash
# Instalar el servicio de systemd
sudo cloudflared service install

# Iniciar y habilitar el servicio
sudo systemctl enable cloudflared
sudo systemctl start cloudflared

# Verificar estado
sudo systemctl status cloudflared
```

---

## 🧪 PARTE 4: Checklist de Verificación End-to-End

Sigue esta lista de comprobación para certificar que todo el flujo está operativo al 100%:

- [ ] **1. Prueba de Salud HTTPS del API:**
  Desde cualquier navegador o terminal externa:
  ```bash
  curl -I https://api-rtnotebot.rtdev.uk/api/health
  ```
  *Debe responder `HTTP/2 200` con `{"status":"ok","db":"up",...}`.*

- [ ] **2. Acceso a la PWA en GitHub Pages:**
  Abre en tu teléfono o PC: `https://<tu-usuario>.github.io/<tu-repositorio>/`.
  *La aplicación debe cargar instantáneamente en modo oscuro y mostrar el indicador de instalación PWA.*

- [ ] **3. Registro e Inicio de Sesión:**
  Crea un usuario nuevo (ej. `rony_test`) con contraseña de 8+ caracteres.
  *Debe ingresar de inmediato al Dashboard y persistir la sesión al recargar la página.*

- [ ] **4. Vinculación y Prueba con Telegram Bot:**
  - Abre Telegram y busca `@rtnotebot`.
  - Envía el comando `/start`.
  - Ingresa tu Chat ID en la tarjeta de Telegram en la web y pulsa **"Vincular"**.
  - Pulsa **"🔔 Probar conexión"**.
  *Debes recibir de inmediato en Telegram el mensaje con título: `✅ ¡Conexión exitosa con RTNote!`.*

- [ ] **5. Disparo Puntual de Recordatorio:**
  - Crea un recordatorio con título: `Revisión de Servidor`.
  - Configura la fecha para **2 minutos en el futuro** (respetando la hora de Honduras mostrada).
  - Espera el cambio de minuto.
  *El scheduler de PM2 reclamará el registro atómicamente y recibirás en Telegram:*
  ```text
  🔔 Revisión de Servidor

  📅 DD/MM/YYYY hh:mm AM (hora de Honduras)
  — RTNote
  ```
  *En la PWA, al pasar a la pestaña "Historial", el recordatorio se habrá movido automáticamente a "Enviado".*

---

## 🛠️ Comandos de Mantenimiento y Operaciones

### Actualizar el Backend tras hacer cambios en GitHub
```bash
cd /var/www/rtnote
git pull origin main
cd backend
npm install --omit=dev
psql -h localhost -U rtnote_user -d rtnote -f schema.sql # si hubo cambios de BD
pm2 reload rtnote-api --env production
```

### Monitoreo en Tiempo Real
```bash
# Ver estado y consumo de RAM/CPU
pm2 status
pm2 monit

# Ver logs en vivo
pm2 logs rtnote-api

# Ver logs de errores únicamente
pm2 logs rtnote-api --err
```

### Respaldos de Base de Datos
```bash
# Generar respaldo de seguridad en PostgreSQL
pg_dump -h localhost -U rtnote_user -d rtnote -F c -b -v -f ~/backup_rtnote_$(date +%Y%m%d).dump
```
