-- Clon tgggakuinkbibqvvuvob. Requiere 001, 002 y 003.
-- Conserva registros comerciales y la matriz antigua. Sustituye acceso público.
begin;
create schema if not exists store_private;
revoke all on schema store_private from public, anon, authenticated;
create table public.store_roles (
  name text primary key check(length(name) between 2 and 50),
  permissions text[] not null default '{}', version integer not null default 1
);
create table public.store_members (
  user_id uuid primary key references auth.users(id),
  role_name text references public.store_roles(name), active boolean not null default false,
  cache_key text not null default (gen_random_uuid()::text||gen_random_uuid()::text),
  created_at timestamptz not null default now(), version integer not null default 1
);
create table store_private.owner_account (singleton boolean primary key default true check(singleton), user_id uuid unique not null references auth.users(id));
create table store_private.security_audit (
  id bigint generated always as identity primary key, actor uuid not null,
  action text not null, details jsonb not null, created_at timestamptz not null default now()
);
create table store_private.operation_actors (operation_key uuid primary key references public.store_operations(operation_key), user_id uuid not null references auth.users(id));
create table public.store_quotes (id text primary key, data jsonb not null, version integer not null default 1, created_by uuid not null references auth.users(id));
create table store_private.legacy_archives (user_id uuid not null references auth.users(id), name text not null, content text not null, primary key(user_id,name));
create table store_private.settings (singleton boolean primary key default true check(singleton), data jsonb not null default '{}',version integer not null default 1);
insert into store_private.settings default values;

create function public.store_permission_keys() returns text[] language sql immutable set search_path='' as $$
select array['inventory.read','inventory.write','sales.read','sales.create','sales.edit','sales.cancel','movements.read','movements.create','movements.reverse','receipts.create','quotes.manage','dashboard.read','settings.manage','access.manage','exports.read']::text[] $$;
insert into public.store_roles(name,permissions) values
 ('Administrador',public.store_permission_keys()),
 ('Vendedor',array['inventory.read','sales.read','sales.create','quotes.manage']);

create function public.store_has_permission(p_permission text) returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists(select 1 from auth.users u where u.id=auth.uid() and u.email_confirmed_at is not null and (u.banned_until is null or u.banned_until<now())) and (
 exists(select 1 from store_private.owner_account o where o.user_id=auth.uid()) or
 exists(select 1 from public.store_members m join public.store_roles r on r.name=m.role_name
 where m.user_id=auth.uid() and m.active and p_permission=any(r.permissions)))
$$;
create function store_private.require_permission(p_permission text) returns void
language plpgsql security definer set search_path='' as $$ begin
 if not public.store_has_permission(p_permission) then raise exception 'Acceso no autorizado: %',p_permission using errcode='42501'; end if;
end $$;

create function public.store_session() returns jsonb language plpgsql security definer set search_path='' as $$
declare u auth.users%rowtype; result jsonb;
begin
 select * into u from auth.users where id=auth.uid() and email_confirmed_at is not null and (banned_until is null or banned_until<now());
 if not found then raise exception 'Verifique su correo e inicie sesión.' using errcode='42501'; end if;
 -- No se confía en user_metadata ni en el email enviado por el navegador.
 perform pg_advisory_xact_lock(729194832);
 if lower(u.email)='alexfloresbe@gmail.com' and not exists(select 1 from store_private.owner_account) then
   insert into store_private.owner_account(user_id) values(u.id);
   insert into public.store_members(user_id,role_name,active) values(u.id,'Administrador',true) on conflict(user_id) do nothing;
 end if;
 insert into public.store_members(user_id) values(u.id) on conflict(user_id) do nothing;
 select jsonb_build_object('user_id',u.id,'email',u.email,'owner',exists(select 1 from store_private.owner_account where user_id=u.id),
 'active',m.active or exists(select 1 from store_private.owner_account where user_id=u.id), 'role',m.role_name,'cache_key',m.cache_key,
 'permissions',case when exists(select 1 from store_private.owner_account where user_id=u.id) then to_jsonb(public.store_permission_keys()) when m.active then to_jsonb(coalesce(r.permissions,'{}'::text[])) else '[]'::jsonb end)
 into result from public.store_members m left join public.store_roles r on r.name=m.role_name where m.user_id=u.id;
 return result;
end $$;

create function public.store_access_list() returns jsonb language plpgsql security definer set search_path='' as $$ begin
 perform store_private.require_permission('access.manage');
 return jsonb_build_object('roles',(select coalesce(jsonb_agg(to_jsonb(r) order by name),'[]') from public.store_roles r),
 'members',(select coalesce(jsonb_agg(jsonb_build_object('user_id',m.user_id,'email',u.email,'role',m.role_name,'active',m.active,'version',m.version,'owner',o.user_id is not null) order by u.email),'[]') from public.store_members m join auth.users u on u.id=m.user_id left join store_private.owner_account o on o.user_id=m.user_id));
end $$;
create function public.store_settings_read() returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
 if auth.uid() is null or not exists(select 1 from auth.users where id=auth.uid() and email_confirmed_at is not null) then raise exception 'Inicie sesión' using errcode='42501'; end if;
 return (select jsonb_build_object('data',data,'version',version) from store_private.settings);
end $$;
create function public.store_settings_save(p_data jsonb,p_version integer) returns void language plpgsql security definer set search_path='' as $$ begin
 perform store_private.require_permission('settings.manage');
 if jsonb_typeof(p_data) is distinct from 'object' or length(btrim(p_data->>'brandName')) not between 1 and 100 or p_data->>'brandName' is null or (p_data->>'coverageDays')::numeric not between 1 and 3650 or (p_data->>'coverageDays')::numeric<>trunc((p_data->>'coverageDays')::numeric) or p_data->>'coverageDays' is null then raise exception 'Configuración inválida'; end if;
 update store_private.settings set data=jsonb_build_object('brandName',btrim(p_data->>'brandName'),'coverageDays',(p_data->>'coverageDays')::integer),version=version+1 where version=p_version;
 if not found then raise exception 'La configuración cambió; actualice antes de guardar'; end if;
end $$;
create function public.store_role_save(p_name text,p_permissions text[],p_version integer) returns void language plpgsql security definer set search_path='' as $$
declare dep text; begin
 perform pg_advisory_xact_lock(729194832); perform store_private.require_permission('access.manage');
 if p_name is null or length(btrim(p_name)) not between 2 and 50 or p_permissions is null or array_position(p_permissions,null) is not null or not p_permissions <@ public.store_permission_keys() then raise exception 'Rol o permisos inválidos'; end if;
 if p_permissions && array['inventory.write','sales.create','sales.edit','receipts.create','movements.create','quotes.manage','dashboard.read'] and not 'inventory.read'=any(p_permissions) then raise exception 'Estos permisos requieren consultar inventario'; end if;
 if p_permissions && array['sales.create','sales.edit','sales.cancel','dashboard.read'] and not 'sales.read'=any(p_permissions) then raise exception 'Estos permisos requieren consultar ventas'; end if;
 if p_permissions && array['movements.create','movements.reverse','receipts.create','dashboard.read'] and not 'movements.read'=any(p_permissions) then raise exception 'Estos permisos requieren consultar movimientos'; end if;
 if p_name='Administrador' and not 'access.manage'=any(p_permissions) then raise exception 'Administrador debe conservar la administración de accesos'; end if;
 if p_version=0 then insert into public.store_roles(name,permissions) values(btrim(p_name),p_permissions);
 else update public.store_roles set permissions=p_permissions,version=version+1 where name=p_name and version=p_version;
   if not found then raise exception 'El rol cambió; actualice antes de guardar'; end if;
 end if;
 insert into store_private.security_audit(actor,action,details) values(auth.uid(),'role.save',jsonb_build_object('role',p_name,'permissions',p_permissions));
end $$;
create function public.store_member_save(p_user uuid,p_role text,p_active boolean,p_version integer) returns void language plpgsql security definer set search_path='' as $$ begin
 perform pg_advisory_xact_lock(729194832); perform store_private.require_permission('access.manage');
 if p_user=auth.uid() or exists(select 1 from store_private.owner_account where user_id=p_user) then raise exception 'No puede cambiar su propio acceso ni el del administrador principal'; end if;
 if p_active is null or (p_active and p_role is null) then raise exception 'Seleccione un rol válido'; end if;
 update public.store_members set role_name=p_role,active=p_active,version=version+1 where user_id=p_user and version=p_version;
 if not found then raise exception 'La cuenta cambió; actualice antes de guardar'; end if;
 insert into store_private.security_audit(actor,action,details) values(auth.uid(),'member.save',jsonb_build_object('user',p_user,'role',p_role,'active',p_active));
end $$;
create function public.store_roles_save(p_roles jsonb) returns void language plpgsql security definer set search_path='' as $$
declare r jsonb; begin
 perform pg_advisory_xact_lock(729194832); perform store_private.require_permission('access.manage');
 if p_roles is null or jsonb_typeof(p_roles)<>'array' then raise exception 'Matriz inválida'; end if;
 for r in select value from jsonb_array_elements(p_roles) loop
 perform public.store_role_save(r->>'name',array(select jsonb_array_elements_text(r->'permissions')),(r->>'version')::integer);
 end loop;
end $$;

-- El motor original queda privado; ninguna llamada directa puede omitir permisos.
alter function public.store_commit(uuid,text,jsonb) set schema store_private;
revoke all on function store_private.store_commit(uuid,text,jsonb) from public,anon,authenticated;
create function public.store_commit(p_key uuid,p_action text,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare perm text; result jsonb; actor uuid; begin
 perform pg_advisory_xact_lock(729194832);
 perm:=case p_action when 'sale_create' then 'sales.create' when 'sale_edit' then 'sales.edit' when 'sale_cancel' then 'sales.cancel' when 'receipt' then 'receipts.create' when 'transfer' then 'movements.create' when 'transfer_reverse' then 'movements.reverse' when 'products_save' then 'inventory.write' end;
 if perm is null then raise exception 'Operación no admitida' using errcode='42501'; end if;
 perform store_private.require_permission(perm);
 if exists(select 1 from public.store_operations where operation_key=p_key) then
   select user_id into actor from store_private.operation_actors where operation_key=p_key;
   if actor is distinct from auth.uid() then raise exception 'Esta operación pertenece a otra sesión o es anterior al control de acceso' using errcode='42501'; end if;
 end if;
 result:=store_private.store_commit(p_key,p_action,p_payload);
 insert into store_private.operation_actors values(p_key,auth.uid()) on conflict do nothing;
 return result;
end $$;

-- Única lectura pública: 12 productos, sin stock, cantidades vendidas, costos ni clientes.
create function public.store_public_catalog() returns table(nombre text,categoria text,precio numeric)
language sql stable security definer set search_path='' as $$
 select p.nombre,p.categoria,p.precio from public.products p left join (
 select si.item,sum(si.cantidad) units from public.sales_items si join public.sales s on s.id=si.sale_id
 where coalesce(to_jsonb(s)->>'estado','')<>'anulada' and not exists(select 1 from public.movements m where m.detalle='Anulación comprobante '||s.numero)
 group by si.item) best on best.item=p.item
 order by coalesce(best.units,0) desc,p.id limit 12
$$;
create or replace function public.store_product_transfers(p_item text)
returns table(id bigint,fecha date,item text,nombre text,cantidad integer,detalle text,created_at timestamptz)
language plpgsql stable security definer set search_path='' as $$ begin
 perform store_private.require_permission('movements.read');
 return query select m.id,m.fecha,m.item,m.nombre,m.cantidad,m.detalle,o.created_at from public.movements m left join public.store_operations o on o.operation_key::text=lower(substring(m.detalle from '\[MOV:([0-9a-fA-F-]{36})\]')) and o.action in ('transfer','transfer_reverse') where m.item=p_item and m.tipo='transfer' order by m.fecha desc,m.id desc;
end $$;

create function public.store_quote_save(p_id text,p_data jsonb,p_version integer) returns integer language plpgsql security definer set search_path='' as $$
declare v integer; line jsonb; sub numeric:=0; pct numeric; qty numeric; price numeric; begin
 perform store_private.require_permission('quotes.manage');
 if p_id is null or length(p_id)>150 or p_data is null or jsonb_typeof(p_data)<>'object' or p_data->>'id' is distinct from p_id or jsonb_typeof(p_data->'items') is distinct from 'array' then raise exception 'Cotización inválida'; end if;
 if jsonb_array_length(p_data->'items') not between 1 and 1000 then raise exception 'Agregue productos a la cotización'; end if;
 pct:=coalesce((p_data->>'descuentoPct')::numeric,0);
 if pct<0 or pct>100 or pct::text in ('NaN','Infinity','-Infinity') then raise exception 'Descuento inválido'; end if;
 for line in select value from jsonb_array_elements(p_data->'items') loop
   qty:=(line->>'cantidad')::numeric;price:=(line->>'precio')::numeric;
   if qty is null or price is null or qty<=0 or qty>2147483647 or qty<>trunc(qty) or price<0 or price>9999999999 or price<>round(price,2) or price::text in ('NaN','Infinity','-Infinity') then raise exception 'Cantidad o precio inválidos'; end if;
   sub:=sub+round(qty*price,2);
 end loop;
 p_data:=p_data||jsonb_build_object('subtotal',sub,'descuento',round(sub*pct/100,2),'total',sub-round(sub*pct/100,2));
 if p_version=0 then insert into public.store_quotes(id,data,created_by) values(p_id,p_data,auth.uid()) returning version into v;
 else update public.store_quotes set data=p_data,version=version+1 where id=p_id and version=p_version returning version into v;
 if not found then raise exception 'La cotización cambió en otro equipo; actualice antes de guardar'; end if; end if;
 return v;
end $$;
-- Archiva sin sobrescribir el original; permite retirar copias locales confidenciales.
create function public.store_archive_legacy(p_name text,p_content text) returns void language plpgsql security definer set search_path='' as $$ begin
 perform store_private.require_permission('access.manage');
 if p_name is null or p_content is null or length(p_name)>200 then raise exception 'Archivo inválido'; end if;
 insert into store_private.legacy_archives values(auth.uid(),p_name,p_content) on conflict do nothing;
 if not exists(select 1 from store_private.legacy_archives where user_id=auth.uid() and name=p_name and content=p_content) then raise exception 'Ya existe un archivo diferente; se conserva la copia local'; end if;
end $$;
create function public.store_quote_import(p_data jsonb) returns void language plpgsql security definer set search_path='' as $$ begin
 perform store_private.require_permission('access.manage');
 if p_data->>'id' is null or jsonb_typeof(p_data) is distinct from 'object' then raise exception 'Cotización anterior inválida'; end if;
 insert into public.store_quotes(id,data,created_by) values(p_data->>'id',p_data,auth.uid()) on conflict do nothing;
 if not exists(select 1 from public.store_quotes where id=p_data->>'id' and data=p_data) then raise exception 'La cotización anterior difiere del servidor; se conserva el original local'; end if;
end $$;
create function public.store_legacy_archives() returns table(name text,content text) language plpgsql stable security definer set search_path='' as $$ begin
 perform store_private.require_permission('access.manage'); return query select a.name,a.content from store_private.legacy_archives a;
end $$;

-- Elimina políticas antiguas permisivas, no filas. Privilegios y RLS son independientes.
do $$ declare t text; p record; begin
 foreach t in array array['products','sales','sales_items','movements','roles_matrix','store_operations','store_roles','store_members','store_quotes'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 for p in select policyname from pg_policies where schemaname='public' and tablename=t loop execute format('drop policy %I on public.%I',p.policyname,t); end loop;
 end loop;
end $$;
-- También cierra vistas y RPC antiguos que podrían eludir las políticas nuevas.
revoke all on all tables in schema public from public,anon,authenticated;
revoke all on all sequences in schema public from public,anon,authenticated;
revoke execute on all functions in schema public from public,anon,authenticated;
grant select on public.products,public.sales,public.sales_items,public.movements,public.store_quotes to authenticated;
create policy inventory_read on public.products for select to authenticated using(public.store_has_permission('inventory.read'));
create policy sales_read on public.sales for select to authenticated using(public.store_has_permission('sales.read'));
create policy sales_items_read on public.sales_items for select to authenticated using(public.store_has_permission('sales.read'));
create policy movements_read on public.movements for select to authenticated using(public.store_has_permission('movements.read') or (tipo='venta' and public.store_has_permission('sales.read')));
create policy quotes_read on public.store_quotes for select to authenticated using(public.store_has_permission('quotes.manage'));
revoke all on all tables in schema store_private from public,anon,authenticated;
revoke all on all functions in schema store_private from public,anon,authenticated;
revoke all on function public.store_commit(uuid,text,jsonb),public.store_product_transfers(text),public.store_session(),public.store_access_list(),public.store_role_save(text,text[],integer),public.store_member_save(uuid,text,boolean,integer),public.store_quote_save(text,jsonb,integer),public.store_archive_legacy(text,text),public.store_legacy_archives(),public.store_has_permission(text),public.store_permission_keys(),public.store_public_catalog() from public,anon,authenticated;
grant execute on function public.store_commit(uuid,text,jsonb),public.store_product_transfers(text),public.store_session(),public.store_access_list(),public.store_role_save(text,text[],integer),public.store_member_save(uuid,text,boolean,integer),public.store_quote_save(text,jsonb,integer),public.store_archive_legacy(text,text),public.store_legacy_archives(),public.store_has_permission(text),public.store_permission_keys() to authenticated;
grant execute on function public.store_public_catalog() to anon,authenticated;
grant execute on function public.store_roles_save(jsonb),public.store_quote_import(jsonb) to authenticated;
grant execute on function public.store_settings_read(),public.store_settings_save(jsonb,integer) to authenticated;
create or replace function public.store_health() returns jsonb language sql stable security definer set search_path='' as $$ select jsonb_build_object('version',1,'revision',4,'atomic',true,'auth',true); $$;
grant execute on function public.store_health() to anon,authenticated;
notify pgrst,'reload schema';
commit;
