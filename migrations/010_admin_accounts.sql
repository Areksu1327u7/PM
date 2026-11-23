-- 010: solicitudes de acceso visibles para el administrador, aprobación y creación de cuentas.
-- Aplicar después de 009 (o de 004 como mínimo). Reejecutable. No modifica registros comerciales.
--
-- Antes, una cuenta solicitada solo aparecía en «Usuarios» después de confirmar el correo e iniciar
-- sesión. Con el correo por defecto de Supabase la confirmación no llega a cuentas externas, así que
-- nunca aparecía. Ahora:
--  * store_access_requests lista toda cuenta registrada que nunca fue aprobada (confirmó o no el correo).
--  * La Edge Function admin-users (service_role) aprueba solicitudes, crea cuentas con correo y
--    contraseña y cambia contraseñas. Cada acción comprueba aquí que quien la pide tiene
--    access.manage; nadie puede modificarse a sí mismo ni al administrador principal.
begin;
do $$ begin
 if to_regprocedure('public.store_access_list()') is null then
   raise exception 'Instale la migración 004 antes de aplicar 010';
 end if;
end $$;

-- Igual que store_has_permission, pero para una cuenta dada (la usa solo service_role).
create or replace function store_private.user_can(p_user uuid, p_permission text) returns boolean
language sql stable security definer set search_path='' as $$
 select p_user is not null
   and exists(select 1 from auth.users u where u.id=p_user and u.email_confirmed_at is not null and (u.banned_until is null or u.banned_until<now()))
   and (exists(select 1 from store_private.owner_account o where o.user_id=p_user)
     or exists(select 1 from public.store_members m join public.store_roles r on r.name=m.role_name
               where m.user_id=p_user and m.active and p_permission=any(r.permissions)))
$$;
revoke all on function store_private.user_can(uuid,text) from public, anon, authenticated;

-- Cuentas que pidieron acceso y nunca fueron aprobadas (sin rol y sin acceso).
create or replace function public.store_access_requests() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 perform store_private.require_permission('access.manage');
 return (select coalesce(jsonb_agg(jsonb_build_object(
     'user_id',u.id,'email',u.email,'requested_at',u.created_at,'confirmed',u.email_confirmed_at is not null)
     order by u.created_at desc),'[]'::jsonb)
   from auth.users u left join public.store_members m on m.user_id=u.id
   where not exists(select 1 from store_private.owner_account o where o.user_id=u.id)
     and coalesce((to_jsonb(u)->>'is_anonymous')::boolean,false)=false
     and (m.user_id is null or (not m.active and m.role_name is null)));
end $$;

-- ¿Puede p_actor administrar a p_target (y asignar p_role)? Devuelve {ok, message}.
create or replace function public.store_admin_authorize(p_actor uuid, p_target uuid, p_role text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not store_private.user_can(p_actor,'access.manage') then
   return jsonb_build_object('ok',false,'message','No tiene permiso para administrar usuarios.');
 end if;
 if p_target is not null and p_target=p_actor then
   return jsonb_build_object('ok',false,'message','No puede modificar su propia cuenta desde aquí.');
 end if;
 if p_target is not null and exists(select 1 from store_private.owner_account where user_id=p_target) then
   return jsonb_build_object('ok',false,'message','No se puede modificar al administrador principal.');
 end if;
 if p_role is not null and not exists(select 1 from public.store_roles where name=p_role) then
   return jsonb_build_object('ok',false,'message','Seleccione un rol válido.');
 end if;
 return jsonb_build_object('ok',true);
end $$;

-- Da acceso activo con el rol indicado (aprobar solicitud o cuenta recién creada).
create or replace function public.store_admin_provision(p_actor uuid, p_user uuid, p_role text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a jsonb;
begin
 perform pg_advisory_xact_lock(729194832);
 if p_user is null or p_role is null then return jsonb_build_object('ok',false,'message','Seleccione un rol válido.'); end if;
 a := public.store_admin_authorize(p_actor,p_user,p_role);
 if not (a->>'ok')::boolean then return a; end if;
 if not exists(select 1 from auth.users where id=p_user) then return jsonb_build_object('ok',false,'message','La cuenta no existe.'); end if;
 insert into public.store_members(user_id,role_name,active) values(p_user,p_role,true)
 on conflict(user_id) do update set role_name=excluded.role_name,active=true,version=public.store_members.version+1;
 insert into store_private.security_audit(actor,action,details) values(p_actor,'member.provision',jsonb_build_object('user',p_user,'role',p_role));
 return jsonb_build_object('ok',true);
end $$;

-- Registro de auditoría para acciones hechas por la Edge Function (crear cuenta, cambiar contraseña).
create or replace function public.store_admin_audit(p_actor uuid, p_action text, p_details jsonb) returns void
language sql security definer set search_path='' as $$
 insert into store_private.security_audit(actor,action,details)
 select p_actor,p_action,coalesce(p_details,'{}'::jsonb) where p_action in ('member.create','member.password');
$$;

revoke all on function public.store_access_requests() from public, anon;
revoke all on function public.store_admin_authorize(uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.store_admin_provision(uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.store_admin_audit(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.store_access_requests() to authenticated;
grant execute on function public.store_admin_authorize(uuid,uuid,text) to service_role;
grant execute on function public.store_admin_provision(uuid,uuid,text) to service_role;
grant execute on function public.store_admin_audit(uuid,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
