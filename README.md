# 🎓 EduInclusiva AI

Aplicación web que adapta material educativo (texto, PDF, DOCX, imágenes) para personas con
discapacidad visual, auditiva o neurodivergencia (dislexia, TDAH, baja visión, daltonismo, etc.)
usando inteligencia artificial. El frontend envía el contenido a un workflow de **n8n**, que lo
procesa con IA y devuelve el material adaptado.

## Requisitos previos

- [Node.js](https://nodejs.org/) 18 o superior
- [Git](https://git-scm.com/)

## Cómo ejecutar el proyecto localmente

```bash
# 1. Cloná el repositorio
git clone <URL-del-repositorio>
cd "codico academy"

# 2. Instalá las dependencias
npm install

# 3. Configurá las variables de entorno (ver sección siguiente)
cp .env.example .env

# 4. Iniciá el servidor de desarrollo
npm run dev
```

La app quedará disponible en `http://localhost:5173`.

### Otros comandos

```bash
npm run build     # genera la versión de producción en dist/
npm run preview   # sirve localmente el build de producción, para verificarlo antes de deployar
```

## Configuración de variables de entorno

El proyecto usa [Vite](https://vitejs.dev/), que expone al frontend cualquier variable de entorno
que empiece con el prefijo `VITE_`.

1. Copiá `.env.example` a un nuevo archivo `.env` en la raíz del proyecto.
2. Completá las URLs de tus webhooks de n8n:

   ```
   VITE_WEBHOOK_URL=https://tu-instancia.n8n.cloud/webhook/eduinclusiva
   VITE_STATUS_WEBHOOK_URL=https://tu-instancia.n8n.cloud/webhook/eduinclusiva-status
   ```

3. `.env` **no se sube al repositorio** (está en `.gitignore`) — cada desarrollador/equipo o
   entorno (local, staging, producción) usa el suyo.
4. Si trabajás con Vercel, cargá esas mismas variables en el proyecto desde
   *Settings → Environment Variables*.

> Nota: estas URLs viajan al bundle final del navegador (como cualquier variable `VITE_*`), así
> que no deben usarse para guardar secretos. El control de acceso real debe vivir del lado de n8n.

## Despliegue en Vercel

El repositorio incluye un `vercel.json` con:

- Cabeceras de seguridad (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`).
- Cabeceras CORS básicas para restringir qué orígenes pueden consumir el sitio desplegado.

Antes de deployar a producción, actualizá el valor de `Access-Control-Allow-Origin` en
`vercel.json` con tu dominio real, y recordá configurar las variables de entorno del paso anterior
en el proyecto de Vercel.

## Estructura del proyecto

```
.
├── index.html          # Markup y estilos de la app
├── src/
│   └── main.js          # Lógica de la app (auth demo, upload, llamadas a n8n, TTS, etc.)
├── .env.example          # Plantilla de variables de entorno
├── vercel.json           # Config de build, headers de seguridad y CORS para Vercel
└── vite.config.js
```
