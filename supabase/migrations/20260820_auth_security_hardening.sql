-- EduInclusiva AI — blindaje de autenticación (roles server-side, rate
-- limiting y 2FA por correo)
--
-- Migración aditiva e idempotente. Cubre 3 cosas:
--   1) Rol de usuario (profiles.role) que SOLO puede cambiar el servidor
--      (service_role) — cierra una escalación de privilegios: hoy
--      "profiles: update own" deja que cualquier usuario autenticado
--      actualice cualquier columna de su propia fila, incluyendo `role`.
--   2) Rate limiting de login/registro contra fuerza bruta, contado en el
--      servidor (tabla sin políticas ⇒ inaccesible directo desde el
--      cliente, solo vía las funciones RPC de abajo).
--   3) Códigos OTP de un solo uso para el 2FA de logins admin (ver
--      AUTH_SECURITY.md para el contrato completo con n8n).

create extension if not exists pgcrypto;

-- ── 1) Rol de usuario + blindaje contra auto-escalación ──────────────
alter table public.profiles add column if not exists role text not null default 'user';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_role_check') then
    alter table public.profiles add constraint profiles_role_check check (role in ('user', 'admin'));
  end if;
end $$;

-- Un usuario autenticado puede seguir actualizando su propio perfil (nombre,
-- avatar), pero nunca su propio `role`: solo una llamada hecha con la
-- credencial de servidor (service_role, la misma que ya usa n8n) puede
-- promoverlo a admin. auth.role() lee el rol Postgres/JWT de la request
-- actual, no el de la tabla profiles.
create or replace function public.prevent_self_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'No autorizado: el rol de usuario solo puede modificarse desde el servidor.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_self_role_escalation on public.profiles;
create trigger trg_prevent_self_role_escalation
  before update on public.profiles
  for each row execute procedure public.prevent_self_role_escalation();

-- Mismo blindaje en el insert: un cliente que intente insertar su propia
-- fila de perfil (por ejemplo si el trigger handle_new_user aún no corrió)
-- no puede auto-asignarse 'admin'.
drop policy if exists "profiles: insert own" on public.profiles;
create policy "profiles: insert own" on public.profiles
  for insert with check (auth.uid() = id and role = 'user');

-- Helper reutilizable para futuras políticas/rutas admin. Hoy la app no
-- tiene ninguna tabla ni vista admin — este helper es el patrón que
-- cualquier función/policy admin futura DEBE usar en vez de confiar en un
-- flag mandado desde el cliente.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$$;

grant execute on function public.is_admin() to authenticated;

-- ── 2) Rate limiting de login/registro (server-side, anti fuerza bruta) ──
create table if not exists public.auth_rate_limit (
  identifier text primary key,           -- típicamente lower(email); también sirve para namespacear con prefijos, ej. 'signup:' || email
  failed_count integer not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

-- Sin políticas ⇒ RLS deniega todo acceso directo a anon/authenticated.
-- Solo se toca a través de las funciones SECURITY DEFINER de abajo (o de
-- service_role, que igual bypassea RLS).
alter table public.auth_rate_limit enable row level security;

create or replace function public.check_rate_limit(p_identifier text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := lower(trim(p_identifier));
  v_row public.auth_rate_limit;
  v_max_attempts constant integer := 5;
begin
  select * into v_row from public.auth_rate_limit where identifier = v_key;

  if v_row is null then
    return jsonb_build_object('allowed', true, 'locked_until', null, 'attempts_remaining', v_max_attempts);
  end if;

  if v_row.locked_until is not null and v_row.locked_until > now() then
    return jsonb_build_object('allowed', false, 'locked_until', v_row.locked_until, 'attempts_remaining', 0);
  end if;

  return jsonb_build_object(
    'allowed', true, 'locked_until', null,
    'attempts_remaining', greatest(0, v_max_attempts - v_row.failed_count)
  );
end;
$$;

grant execute on function public.check_rate_limit(text) to anon, authenticated;

create or replace function public.register_failed_attempt(p_identifier text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := lower(trim(p_identifier));
  v_max_attempts constant integer := 5;
  v_lock_minutes constant integer := 15;
  v_window_minutes constant integer := 30;
  v_row public.auth_rate_limit;
  v_new_count integer;
  v_locked_until timestamptz;
begin
  select * into v_row from public.auth_rate_limit where identifier = v_key for update;

  -- Sin fila previa, o la última racha de intentos ya expiró: arranca de nuevo.
  if v_row is null or (now() - v_row.updated_at) > (v_window_minutes || ' minutes')::interval then
    insert into public.auth_rate_limit (identifier, failed_count, locked_until, updated_at)
    values (v_key, 1, null, now())
    on conflict (identifier) do update
      set failed_count = 1, locked_until = null, updated_at = now();
    return jsonb_build_object('allowed', true, 'locked_until', null, 'attempts_remaining', v_max_attempts - 1);
  end if;

  v_new_count := v_row.failed_count + 1;
  v_locked_until := case when v_new_count >= v_max_attempts then now() + (v_lock_minutes || ' minutes')::interval else null end;

  update public.auth_rate_limit
    set failed_count = v_new_count, locked_until = v_locked_until, updated_at = now()
    where identifier = v_key;

  return jsonb_build_object(
    'allowed', v_locked_until is null,
    'locked_until', v_locked_until,
    'attempts_remaining', greatest(0, v_max_attempts - v_new_count)
  );
end;
$$;

grant execute on function public.register_failed_attempt(text) to anon, authenticated;

create or replace function public.register_successful_attempt(p_identifier text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.auth_rate_limit where identifier = lower(trim(p_identifier));
$$;

grant execute on function public.register_successful_attempt(text) to anon, authenticated;

-- ── 3) Códigos OTP de un solo uso (2FA por correo vía n8n) ────────────
-- n8n genera el código y lo inserta con su credencial service_role (igual
-- que ya hace con public.jobs) — nunca desde el navegador. El frontend
-- solo puede verificar un código a través de verify_otp_code(). Contrato
-- completo (columnas exactas que debe escribir n8n, fórmula del hash) en
-- AUTH_SECURITY.md.
create table if not exists public.auth_otp_codes (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  code_hash text not null,          -- encode(digest(código_de_6_dígitos, 'sha256'), 'hex')
  expires_at timestamptz not null,
  consumed_at timestamptz,
  attempt_count integer not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists auth_otp_codes_email_idx
  on public.auth_otp_codes (lower(email), created_at desc);

-- Sin políticas ⇒ deny-all para anon/authenticated. Igual que la tabla de
-- rate limit, solo accesible vía service_role (n8n) o verify_otp_code().
alter table public.auth_otp_codes enable row level security;

create or replace function public.verify_otp_code(p_email text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(trim(p_email));
  v_row public.auth_otp_codes;
  v_max_attempts constant integer := 5;
begin
  select * into v_row
    from public.auth_otp_codes
    where lower(email) = v_email and consumed_at is null and expires_at > now()
    order by created_at desc
    limit 1
    for update;

  if v_row is null then
    return jsonb_build_object('success', false, 'reason', 'no_code');
  end if;

  if v_row.attempt_count >= v_max_attempts then
    update public.auth_otp_codes set consumed_at = now() where id = v_row.id;
    return jsonb_build_object('success', false, 'reason', 'too_many_attempts');
  end if;

  if v_row.code_hash = encode(digest(p_code, 'sha256'), 'hex') then
    update public.auth_otp_codes set consumed_at = now() where id = v_row.id;
    return jsonb_build_object('success', true);
  end if;

  update public.auth_otp_codes set attempt_count = attempt_count + 1 where id = v_row.id;
  return jsonb_build_object('success', false, 'reason', 'invalid_code');
end;
$$;

grant execute on function public.verify_otp_code(text, text) to anon, authenticated;
