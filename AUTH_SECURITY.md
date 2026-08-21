# Seguridad de autenticación — qué se hizo y qué falta

Este documento resume la auditoría de seguridad de auth aplicada al proyecto y el contrato
exacto que debe respetar el workflow de n8n para el 2FA por correo. Contexto importante para
entender las decisiones de abajo: **EduInclusiva AI es un SPA estático (Vite, sin servidor
propio) desplegado en Vercel**; el único componente "backend" real que existe hoy es n8n (ya
usado para el pipeline de adaptación de documentos, con una credencial `service_role` de
Supabase — ver `API_FLOW.md`). Eso condiciona qué es posible implementar sin agregar
infraestructura nueva.

## 1. Tokens de sesión — HttpOnly no es posible sin backend propio

`HttpOnly` es un flag que solo puede setear un servidor al responder `Set-Cookie`; JavaScript
del navegador **no puede** leerlo ni escribirlo (esa es la propiedad de seguridad que ofrece).
Como este SPA no tiene servidor propio, no hay forma de implementarlo de verdad sin agregar uno
(por ejemplo, un proxy de auth en n8n que responda con `Set-Cookie`, o funciones serverless en
Vercel).

Mitigación aplicada del lado cliente (`src/lib/supabaseClient.js`): el storage de la sesión de
Supabase pasó de `localStorage` a `sessionStorage`. Diferencia real:

| | `localStorage` (antes) | `sessionStorage` (ahora) |
|---|---|---|
| Sobrevive a cerrar la pestaña/navegador | Sí | No |
| Se comparte entre pestañas | Sí | No |
| Legible por un XSS mientras la pestaña está abierta | Sí | Sí |

No es HttpOnly real — sigue siendo legible por JS mientras la pestaña está abierta, así que un
XSS exitoso en esa ventana de tiempo puede seguir robando el token. Si en algún momento se agrega
un backend (n8n como proxy de auth, o funciones serverless), la mejora natural es mover la
emisión de sesión ahí y sí usar `Set-Cookie: HttpOnly; Secure; SameSite=Strict`.

El modo demo (sin Supabase configurado) tenía el mismo problema con su propia sesión —
`localStorage['edu_user_v2']`. Se movió a una variable en memoria (`src/lib/auth.js`): se pierde
al recargar la pestaña, no queda ningún rastro persistido en el navegador.

## 2. Permisos de admin — RLS server-side, no un flag del cliente

Auditoría: **el código no tenía ningún concepto de admin** (ni rutas, ni UI, ni columna en
`profiles`). Lo que sí se encontró y se cerró es un problema real:

> La policy `"profiles: update own"` dejaba que cualquier usuario autenticado actualizara
> **cualquier columna** de su propia fila en `profiles` — si se hubiera agregado una columna
> `role` sin blindaje adicional, cualquier usuario podría auto-promoverse a admin desde el
> propio navegador (`supabase.from('profiles').update({role:'admin'})`).

`supabase/migrations/20260820_auth_security_hardening.sql` agrega:

- `profiles.role` (`'user'` por defecto, `check (role in ('user','admin'))`).
- Un trigger `prevent_self_role_escalation()` que **rechaza** cualquier `UPDATE` que cambie
  `role` a menos que la request use la credencial `service_role` (`auth.role() = 'service_role'`)
  — la misma que ya usa n8n para tocar `jobs`. Ni el cliente ni ninguna policy RLS pueden
  saltearlo: corre como trigger de base de datos.
- La policy de `insert` en `profiles` ahora exige `role = 'user'`, cerrando el mismo vector en el
  insert inicial.
- `public.is_admin()`: helper `SECURITY DEFINER` reutilizable. **Cualquier tabla, vista o RPC
  admin que se agregue en el futuro debe usar este helper en su policy/chequeo — nunca confiar en
  un campo `isAdmin` mandado desde el cliente.**

Cómo promover un usuario a admin hoy (no hay UI — se hace a mano, con la service key, desde el
SQL Editor de Supabase o un script server-side, nunca desde el navegador):

```sql
update public.profiles set role = 'admin' where email = 'persona@dominio.com';
```

(Ese `update` corre con privilegios de administrador de base de datos en el SQL Editor, así que
no lo bloquea el trigger — el trigger solo bloquea updates que lleguen vía la API con el rol
`anon`/`authenticated`.)

## 3. 2FA por correo (solo login admin) — esqueleto listo, falta el workflow de n8n

Se implementó todo lo que vive en este repo. **No se creó ningún workflow en n8n** (decisión
explícita: evitar tocar la cuenta de n8n/Gmail en vivo sin que alguien lo revise primero). Lo que
sí quedó funcionando:

- `supabase/migrations/20260820_auth_security_hardening.sql` → tabla `auth_otp_codes` (sin
  policies, inaccesible directo desde el cliente) + función `verify_otp_code(email, code)`.
- `src/lib/auth.js` → `requiresTwoFactor(user)` (true solo si `role === 'admin'` y Supabase está
  configurado), `requestTwoFactorCode(email)` (dispara el webhook de n8n) y
  `verifyTwoFactorCode(email, code)` (llama a `verify_otp_code` vía RPC).
- `src/main.js` / `index.html` → paso de UI completo: al loguear un admin, se pide el código
  antes de abrir la app (`showTwoFactorPanel`), con reenvío y cancelación.

### Contrato que debe implementar el webhook de n8n

**`POST $VITE_2FA_REQUEST_WEBHOOK_URL`** — body `{ "email": "admin@dominio.com" }`.

El workflow debe, en este orden:

1. (Recomendado) Frenar spam de envíos: mismo patrón que el rate limit de login — podés llamar a
   las funciones RPC `check_rate_limit` / `register_failed_attempt` de Supabase con un
   identificador tipo `'otp:' || email`, o llevar tu propio contador en n8n.
2. Generar un código numérico de 6 dígitos (`Math.floor(100000 + Math.random()*900000)` o
   equivalente).
3. Insertar una fila en `public.auth_otp_codes` **usando la credencial `service_role`** (igual
   que ya hace con `jobs`):
   ```json
   {
     "email": "admin@dominio.com",
     "code_hash": "<sha256 hex del código>",
     "expires_at": "<ahora + 5 minutos, ISO 8601>"
   }
   ```
   El hash **debe** calcularse exactamente como `encode(digest(codigo, 'sha256'), 'hex')` en
   Postgres — en n8n, un nodo de Crypto/Function que haga `sha256(codigo).toString('hex')`
   (sin sal: el scoping por `email` + `expires_at` + un solo uso ya acota el riesgo; no se
   reutiliza entre usuarios ni persiste más de 5 minutos).
4. Enviar el código en texto plano por correo (Gmail o Resend) a `email`. Nunca devolverlo en la
   respuesta HTTP del webhook — el frontend no debe verlo, solo el correo.
5. Responder `200` (o cualquier 2xx) sin body sensible. Ante error, `4xx/5xx` — el frontend ya
   maneja ambos casos.

**Verificación**: no necesita otro webhook — el frontend llama directo a
`supabase.rpc('verify_otp_code', { p_email, p_code })`, que ya está implementado en la migración
y corre enteramente en Supabase.

### Notas de seguridad para cuando se implemente el workflow

- No loguear el código en texto plano en el historial de ejecuciones de n8n si se puede evitar.
- `auth_otp_codes` no tiene índice de limpieza automática — si te importa, agregá un cron en n8n
  o un `pg_cron` que borre filas con `expires_at < now() - interval '1 day'`.
- El límite de 5 intentos de verificación por código ya está en `verify_otp_code` (server-side,
  no lo controla el frontend).

## 4. Rate limiting — server-side real, por email

`supabase/migrations/20260820_auth_security_hardening.sql` agrega `auth_rate_limit` (tabla sin
policies, solo accesible vía las funciones de abajo o `service_role`) y tres funciones
`SECURITY DEFINER`:

- `check_rate_limit(identifier)` — antes de intentar el login o el registro.
- `register_failed_attempt(identifier)` — tras una contraseña incorrecta o un registro rechazado.
- `register_successful_attempt(identifier)` — resetea el contador tras un login o registro exitoso.

Reglas: **5 intentos fallidos → bloqueo de 15 minutos**; la ventana de conteo expira a los 30
minutos de inactividad (para no acumular intentos viejos indefinidamente). `src/lib/auth.js` llama
a estas funciones tanto en `signInWithPassword` como en `signUp`. El registro usa el namespace
`signup:<email>` para que un bloqueo de creación no afecte el acceso de una cuenta ya existente.

**Limitación honesta**: el identificador es el email, no la IP (Postgres/Supabase no expone de
forma confiable la IP real del cliente detrás de la mayoría de configuraciones de pooling/CDN).
Esto frena credential stuffing/fuerza bruta contra **una cuenta puntual**, pero no un ataque
distribuido contra muchas cuentas distintas desde la misma IP, ni un DoS volumétrico genérico —
eso se mitiga mejor en la capa de infraestructura (WAF/rate limit de Vercel o Cloudflare delante
del sitio), fuera del alcance del código de la app.

En modo demo (sin Supabase) se agregó un limitador equivalente pero **en memoria** (`Map` en
`src/lib/auth.js`) — se pierde al recargar la página y no es un control real, solo evita que un
script trivial fuerce contraseñas contra el modo demo local.

## 5. Política de contraseñas y placeholders

- `validatePasswordPolicy()` en `src/lib/auth.js`: mínimo 8 caracteres, al menos una mayúscula,
  un número y un carácter especial. Se aplica en `signUp()` tanto en modo Supabase real (antes de
  llamar a `auth.signUp`) como en modo demo.
- Nota: el proyecto de Supabase también tiene su propio mínimo de contraseña configurable en
  *Authentication → Policies* — si querés que el servidor la rechace incluso si alguien pega el
  request a mano (sin pasar por este frontend), configurá ahí el mismo mínimo de 8 caracteres.
- Placeholders actualizados en `index.html`: `ejemplo@correo.com` para los inputs de correo,
  `Mínimo 8 caracteres (Ej: Abc$1234)` en el de contraseña de registro, más un texto de ayuda
  fijo debajo del campo con la regla completa.

## Archivos modificados

- `supabase/migrations/20260820_auth_security_hardening.sql` (nuevo)
- `src/lib/supabaseClient.js`
- `src/lib/auth.js`
- `src/main.js`
- `index.html`
- `.env.example`
