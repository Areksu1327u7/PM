-- 008: ingreso rápido con código de 4 dígitos en equipos recordados.
-- Aplicar después de 007. Reejecutable. No modifica registros comerciales ni permisos existentes.
--
-- Modelo de seguridad:
--  * El código solo funciona en un equipo donde la persona ya inició sesión con correo y contraseña
--    y creó su código. El equipo guarda un secreto aleatorio de 256 bits; aquí solo se guarda su hash.
--  * El hash del código incluye el secreto del equipo: aunque se filtrara esta tabla no se pueden
--    probar las 10 000 combinaciones sin el equipo.
--  * 5 códigos incorrectos eliminan el acceso rápido de esa cuenta en ese equipo (vuelve a pedir contraseña).
--  * Cuentas suspendidas, pendientes o bloqueadas no pueden ingresar con código.
--  * La sesión la emite Supabase Auth desde la Edge Function pin-login (única que puede llamar a
--    store_pin_check, mediante service_role).
begin;
do $$ begin
 if to_regprocedure('public.store_session()') is null or to_regclass('public.store_members') is null then
   raise exception 'Instale las migraciones 001–007 antes de aplicar 008';
 end if;
end $$;

create table if not exists store_private.quick_access (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  secret_hash text not null,
  pin_hash text not null,
  salt text not null,
  failed integer not null default 0,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  primary key (user_id, device_id)
);
revoke all on table store_private.quick_access from public, anon, authenticated;

create or replace function store_private.quick_hash(p_value text) returns text
language sql immutable set search_path='' as $$
 select encode(pg_catalog.sha256(convert_to(p_value,'UTF8')),'hex')
$$;
revoke all on function store_private.quick_hash(text) from public, anon, authenticated;

create or replace function store_private.quick_pin_valid(p_pin text) returns boolean
language sql immutable set search_path='' as $$
 select p_pin ~ '^[0-9]{4}$' and p_pin !~ '^(.)\1{3}$'
   and p_pin <> all(array['0123','1234','2345','3456','4567','5678','6789','9876','8765','7654','6543','5432','4321','3210'])
$$;
revoke all on function store_private.quick_pin_valid(text) from public, anon, authenticated;

-- Crear o cambiar el código de la cuenta actual en este equipo. Requiere sesión activa y autorizada.
create or replace function public.store_pin_register(p_device uuid, p_secret text, p_pin text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s jsonb; salt text;
begin
 s := public.store_session();
 if not coalesce((s->>'active')::boolean,false) then raise exception 'Su cuenta no está autorizada.' using errcode='42501'; end if;
 if p_device is null or coalesce(p_secret,'') !~ '^[0-9a-f]{64}$' then raise exception 'Equipo no válido.' using errcode='22023'; end if;
 if not store_private.quick_pin_valid(coalesce(p_pin,'')) then
   raise exception 'El código debe tener 4 números y no puede ser repetido (1111) ni seguido (1234).' using errcode='22023';
 end if;
 salt := gen_random_uuid()::text;
 insert into store_private.quick_access(user_id,device_id,secret_hash,pin_hash,salt,failed,created_at,last_used_at)
 values(auth.uid(),p_device,store_private.quick_hash(p_secret),store_private.quick_hash(salt||':'||p_secret||':'||p_pin),salt,0,now(),null)
 on conflict(user_id,device_id) do update set secret_hash=excluded.secret_hash,pin_hash=excluded.pin_hash,salt=excluded.salt,failed=0,created_at=now();
 -- Como máximo 10 equipos por cuenta: se retiran los menos usados.
 delete from store_private.quick_access q where q.user_id=auth.uid() and q.device_id in (
   select device_id from store_private.quick_access where user_id=auth.uid()
   order by coalesce(last_used_at,created_at) desc offset 10);
 insert into store_private.security_audit(actor,action,details) values(auth.uid(),'quick_access.register',jsonb_build_object('device',p_device));
 return jsonb_build_object('ok',true);
end $$;

-- Quitar el código de la cuenta actual en este equipo.
create or replace function public.store_pin_remove(p_device uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'Inicie sesión.' using errcode='42501'; end if;
 delete from store_private.quick_access where user_id=auth.uid() and device_id=p_device;
 if found then insert into store_private.security_audit(actor,action,details) values(auth.uid(),'quick_access.remove',jsonb_build_object('device',p_device)); end if;
 return found;
end $$;

-- ¿La cuenta actual tiene código en este equipo? (para «Mi perfil»)
create or replace function public.store_pin_status(p_device uuid, p_secret text) returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists(select 1 from store_private.quick_access
   where user_id=auth.uid() and device_id=p_device and secret_hash=store_private.quick_hash(coalesce(p_secret,'')))
$$;

-- Quitar una cuenta de la lista del equipo sin iniciar sesión. Exige el secreto del equipo.
create or replace function public.store_pin_forget(p_user uuid, p_device uuid, p_secret text) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 delete from store_private.quick_access where user_id=p_user and device_id=p_device and secret_hash=store_private.quick_hash(coalesce(p_secret,''));
 return found;
end $$;

-- Verificación del código. Solo service_role (Edge Function pin-login). Devuelve resultado en lugar de
-- lanzar errores para que el contador de intentos fallidos se conserve.
create or replace function public.store_pin_check(p_user uuid, p_device uuid, p_secret text, p_pin text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q store_private.quick_access%rowtype; u auth.users%rowtype; attempts integer;
begin
 select * into q from store_private.quick_access where user_id=p_user and device_id=p_device for update;
 if not found or q.secret_hash<>store_private.quick_hash(coalesce(p_secret,'')) then
   return jsonb_build_object('ok',false,'reason','unknown');
 end if;
 select * into u from auth.users where id=p_user;
 if not found or u.email_confirmed_at is null or (u.banned_until is not null and u.banned_until>now()) then
   return jsonb_build_object('ok',false,'reason','blocked');
 end if;
 if not exists(select 1 from store_private.owner_account where user_id=p_user)
    and not exists(select 1 from public.store_members where user_id=p_user and active) then
   return jsonb_build_object('ok',false,'reason','inactive');
 end if;
 if coalesce(p_pin,'') !~ '^[0-9]{4}$' or q.pin_hash<>store_private.quick_hash(q.salt||':'||p_secret||':'||p_pin) then
   attempts := q.failed+1;
   if attempts>=5 then
     delete from store_private.quick_access where user_id=p_user and device_id=p_device;
     insert into store_private.security_audit(actor,action,details) values(p_user,'quick_access.locked',jsonb_build_object('device',p_device));
     return jsonb_build_object('ok',false,'reason','locked');
   end if;
   update store_private.quick_access set failed=attempts where user_id=p_user and device_id=p_device;
   return jsonb_build_object('ok',false,'reason','pin','remaining',5-attempts);
 end if;
 update store_private.quick_access set failed=0,last_used_at=now() where user_id=p_user and device_id=p_device;
 return jsonb_build_object('ok',true,'email',u.email);
end $$;

revoke all on function public.store_pin_register(uuid,text,text) from public, anon;
revoke all on function public.store_pin_remove(uuid) from public, anon;
revoke all on function public.store_pin_status(uuid,text) from public, anon;
revoke all on function public.store_pin_forget(uuid,uuid,text) from public;
revoke all on function public.store_pin_check(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.store_pin_register(uuid,text,text) to authenticated;
grant execute on function public.store_pin_remove(uuid) to authenticated;
grant execute on function public.store_pin_status(uuid,text) to authenticated;
grant execute on function public.store_pin_forget(uuid,uuid,text) to anon, authenticated;
grant execute on function public.store_pin_check(uuid,uuid,text,text) to service_role;

create or replace function public.store_health() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('version',1,'revision',8,'atomic',true,'auth',true,'reversal_reasons',true,'profiles',true,'inventory_integrity',true,'performance',true,'quick_access',true);
$$;
revoke all on function public.store_health() from public;
grant execute on function public.store_health() to anon,authenticated;
notify pgrst,'reload schema';
commit;
