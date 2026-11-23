-- 009: un código por persona, válido en cualquier equipo donde haya ingresado con contraseña.
-- Aplicar después de 008. Reejecutable. No modifica registros comerciales ni permisos.
--
-- Cambios respecto de 008:
--  * El código es de la persona (no del equipo) y puede ser cualquier combinación de 4 números.
--  * Un equipo queda habilitado para esa persona solo cuando inicia sesión con CONTRASEÑA en él
--    (se comprueba el método de autenticación del token de Supabase, no lo que diga el navegador).
--  * 5 códigos incorrectos (sumando todos los equipos) desactivan el código: la persona vuelve a
--    entrar con contraseña y crea uno nuevo (puede repetir el mismo).
--  * Los códigos creados con 008 eran por equipo y no se pueden convertir: cada persona crea su
--    código una vez más. Los equipos ya habilitados se conservan.
begin;
do $$ begin
 if to_regclass('store_private.quick_access') is null then
   raise exception 'Instale la migración 008 antes de aplicar 009';
 end if;
end $$;

create table if not exists store_private.quick_pins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  pin_hash text not null,
  salt text not null,
  failed integer not null default 0,
  updated_at timestamptz not null default now()
);
revoke all on table store_private.quick_pins from public, anon, authenticated;

-- quick_access pasa a registrar solo equipos habilitados por persona.
alter table store_private.quick_access alter column pin_hash drop not null;
alter table store_private.quick_access alter column salt drop not null;
update store_private.quick_access set pin_hash=null, salt=null, failed=0 where pin_hash is not null;

-- ¿La sesión actual se abrió con contraseña?
create or replace function store_private.quick_password_session() returns boolean
language sql stable set search_path='' as $$
 select coalesce((select bool_or(a->>'method'='password')
   from jsonb_array_elements(case when jsonb_typeof(auth.jwt()->'amr')='array' then auth.jwt()->'amr' else '[]'::jsonb end) a),false)
$$;
revoke all on function store_private.quick_password_session() from public, anon, authenticated;

create or replace function store_private.quick_require_active() returns void
language plpgsql security definer set search_path='' as $$
declare s jsonb;
begin
 s := public.store_session();
 if not coalesce((s->>'active')::boolean,false) then raise exception 'Su cuenta no está autorizada.' using errcode='42501'; end if;
end $$;
revoke all on function store_private.quick_require_active() from public, anon, authenticated;

create or replace function store_private.quick_trust(p_device uuid, p_secret text) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if p_device is null or coalesce(p_secret,'') !~ '^[0-9a-f]{64}$' then raise exception 'Equipo no válido.' using errcode='22023'; end if;
 if not store_private.quick_password_session() then return false; end if;
 insert into store_private.quick_access(user_id,device_id,secret_hash,pin_hash,salt,failed,created_at,last_used_at)
 values(auth.uid(),p_device,store_private.quick_hash(p_secret),null,null,0,now(),null)
 on conflict(user_id,device_id) do update set secret_hash=excluded.secret_hash;
 -- Como máximo 20 equipos por persona: se retiran los menos usados.
 delete from store_private.quick_access q where q.user_id=auth.uid() and q.device_id in (
   select device_id from store_private.quick_access where user_id=auth.uid()
   order by coalesce(last_used_at,created_at) desc offset 20);
 return true;
end $$;
revoke all on function store_private.quick_trust(uuid,text) from public, anon, authenticated;

-- Llamada tras iniciar sesión con contraseña: habilita este equipo e indica si ya tiene código.
create or replace function public.store_device_trust(p_device uuid, p_secret text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare trusted boolean;
begin
 perform store_private.quick_require_active();
 trusted := store_private.quick_trust(p_device,p_secret);
 return jsonb_build_object('trusted',trusted,'has_pin',exists(select 1 from store_private.quick_pins where user_id=auth.uid()));
end $$;

-- Crear o cambiar el código de la persona (vale para todos sus equipos habilitados).
create or replace function public.store_pin_register(p_device uuid, p_secret text, p_pin text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare salt text;
begin
 perform store_private.quick_require_active();
 if coalesce(p_pin,'') !~ '^[0-9]{4}$' then raise exception 'El código debe tener exactamente 4 números.' using errcode='22023'; end if;
 if p_device is null or coalesce(p_secret,'') !~ '^[0-9a-f]{64}$' then raise exception 'Equipo no válido.' using errcode='22023'; end if;
 salt := gen_random_uuid()::text;
 insert into store_private.quick_pins(user_id,pin_hash,salt,failed,updated_at)
 values(auth.uid(),store_private.quick_hash(salt||':'||p_pin),salt,0,now())
 on conflict(user_id) do update set pin_hash=excluded.pin_hash,salt=excluded.salt,failed=0,updated_at=now();
 perform store_private.quick_trust(p_device,p_secret);
 insert into store_private.security_audit(actor,action,details) values(auth.uid(),'quick_access.pin_set',jsonb_build_object('device',p_device));
 return jsonb_build_object('ok',true,'trusted',exists(select 1 from store_private.quick_access where user_id=auth.uid() and device_id=p_device and secret_hash=store_private.quick_hash(p_secret)));
end $$;

-- ¿Puede esta persona entrar con código en este equipo? (equipo habilitado y código creado)
create or replace function public.store_pin_status(p_device uuid, p_secret text) returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null
   and exists(select 1 from store_private.quick_access where user_id=auth.uid() and device_id=p_device and secret_hash=store_private.quick_hash(coalesce(p_secret,'')))
   and exists(select 1 from store_private.quick_pins where user_id=auth.uid())
$$;

-- Verificación del código. Solo service_role (Edge Function pin-login).
create or replace function public.store_pin_check(p_user uuid, p_device uuid, p_secret text, p_pin text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q store_private.quick_pins%rowtype; u auth.users%rowtype; attempts integer;
begin
 if not exists(select 1 from store_private.quick_access where user_id=p_user and device_id=p_device and secret_hash=store_private.quick_hash(coalesce(p_secret,''))) then
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
 select * into q from store_private.quick_pins where user_id=p_user for update;
 if not found then return jsonb_build_object('ok',false,'reason','no_pin'); end if;
 if coalesce(p_pin,'') !~ '^[0-9]{4}$' or q.pin_hash<>store_private.quick_hash(q.salt||':'||p_pin) then
   attempts := q.failed+1;
   if attempts>=5 then
     delete from store_private.quick_pins where user_id=p_user;
     insert into store_private.security_audit(actor,action,details) values(p_user,'quick_access.locked',jsonb_build_object('device',p_device));
     return jsonb_build_object('ok',false,'reason','locked');
   end if;
   update store_private.quick_pins set failed=attempts where user_id=p_user;
   return jsonb_build_object('ok',false,'reason','pin','remaining',5-attempts);
 end if;
 update store_private.quick_pins set failed=0 where user_id=p_user;
 update store_private.quick_access set last_used_at=now() where user_id=p_user and device_id=p_device;
 return jsonb_build_object('ok',true,'email',u.email);
end $$;

revoke all on function public.store_device_trust(uuid,text) from public, anon;
revoke all on function public.store_pin_register(uuid,text,text) from public, anon;
revoke all on function public.store_pin_status(uuid,text) from public, anon;
revoke all on function public.store_pin_check(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.store_device_trust(uuid,text) to authenticated;
grant execute on function public.store_pin_register(uuid,text,text) to authenticated;
grant execute on function public.store_pin_status(uuid,text) to authenticated;
grant execute on function public.store_pin_check(uuid,uuid,text,text) to service_role;

create or replace function public.store_health() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('version',1,'revision',9,'atomic',true,'auth',true,'reversal_reasons',true,'profiles',true,'inventory_integrity',true,'performance',true,'quick_access',true,'quick_access_v2',true);
$$;
revoke all on function public.store_health() from public;
grant execute on function public.store_health() to anon,authenticated;
notify pgrst,'reload schema';
commit;
