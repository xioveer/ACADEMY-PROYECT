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

## Configurar Supabase (Auth + Database + Storage)

Sin estas variables, la app funciona igual en **modo demo** (login con cualquier email/contraseña,
"Google" simulado, historial en `localStorage` del navegador). Para pasar a autenticación y
persistencia reales:

1. Creá un proyecto en [supabase.com](https://supabase.com).
2. **SQL Editor** → pegá el contenido de [`supabase/schema.sql`](./supabase/schema.sql) → Run.
   Esto crea las tablas `profiles`, `accessibility_preferences` y `adaptation_history` (con RLS,
   cada usuario solo ve sus propios datos) y los buckets privados `avatars` y `uploads`.
3. Aplicá, en este orden, todas las migraciones versionadas:
   - [`20260819_add_jobs_rag_progress.sql`](./supabase/migrations/20260819_add_jobs_rag_progress.sql):
     crea `public.jobs`, requerida para el seguimiento de trabajos de n8n definido en
     [`API_FLOW.md`](./API_FLOW.md).
   - [`20260820_auth_security_hardening.sql`](./supabase/migrations/20260820_auth_security_hardening.sql):
     protege roles, añade rate limiting y soporte de 2FA.
   - [`20260821_private_avatars.sql`](./supabase/migrations/20260821_private_avatars.sql):
     vuelve privados los avatares existentes y migra las URLs públicas históricas a rutas internas.
   Ejecutá cada archivo una sola vez, desde el SQL Editor o el mecanismo de migraciones elegido por
   el equipo. Un entorno no está listo hasta que el esquema base y las tres migraciones estén aplicados.
4. **Authentication → Providers → Google**: activalo y completá el Client ID / Client Secret de un
   proyecto en [Google Cloud Console](https://console.cloud.google.com/apis/credentials) (tipo
   "OAuth 2.0 Client ID", aplicación web). Como *Authorized redirect URI* en Google Cloud, usá la
   URL de callback que Supabase te muestra en esa misma pantalla
   (`https://<tu-proyecto>.supabase.co/auth/v1/callback`).
5. **Project Settings → API** → copiá `Project URL` y `anon public key` a tu `.env`:
   ```
   VITE_SUPABASE_URL=https://tu-proyecto.supabase.co
   VITE_SUPABASE_ANON_KEY=tu-clave-anon-publica
   ```
6. Reiniciá `npm run dev` (o redeployá). La app detecta automáticamente que Supabase está
   configurado y deja de usar el modo demo.

Los avatares usan URLs firmadas de una hora y solo el propietario puede leerlos. No deben cambiarse
a un bucket público sin una revisión explícita de privacidad y consentimiento.

## Configurar Google Analytics 4

1. Creá una propiedad GA4 en [analytics.google.com](https://analytics.google.com) y copiá su
   *Measurement ID* (formato `G-XXXXXXXXXX`).
2. Agregalo a tu `.env`: `VITE_GA_MEASUREMENT_ID=G-XXXXXXXXXX`.
3. El script de GA4 se inyecta recién cuando el usuario acepta el banner de consentimiento de la
   app (nunca antes) y reporta vistas virtuales por cada interfaz (`ceguera`, `auditivo`,
   `baja-vision`, `tdah`, `docente`, `lobby`) más eventos clave (`login`, `sign_up`,
   `adapt_content`). Ver `src/lib/analytics.js`.

## Despliegue en Vercel

El repositorio incluye un `vercel.json` con:

- Cabeceras de seguridad (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`).
- Cabeceras CORS básicas para restringir qué orígenes pueden consumir el sitio desplegado.

Antes de deployar a producción, configurá las variables de entorno del paso anterior en el proyecto
de Vercel. Las integraciones externas (n8n, Supabase y Google OAuth) deben restringir sus propios
orígenes permitidos; esta SPA no publica cabeceras CORS globales.

## Estructura del proyecto

```
.
├── index.html          # Markup y estilos de la app
├── src/
│   ├── main.js          # Router, UI de las 6 vistas, upload, llamadas a n8n, TTS, etc.
│   └── lib/
│       ├── supabaseClient.js  # Cliente Supabase (o null en modo demo)
│       ├── auth.js            # Login/registro/Google — Supabase real o localStorage demo
│       ├── db.js               # Historial de adaptaciones + preferencias
│       ├── storage.js          # Subida de archivos originales y avatares
│       ├── analytics.js        # Google Analytics 4 (gateado por consentimiento)
│       └── search.js           # Índice y filtro del buscador global
├── supabase/
│   ├── schema.sql        # Esquema base (tablas, RLS y buckets privados)
│   └── migrations/       # Migraciones obligatorias aplicadas en orden
├── .env.example          # Plantilla de variables de entorno
├── vercel.json           # Config de build, headers de seguridad y CORS para Vercel
└── vite.config.js
```
