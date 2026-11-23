-- Ejecutar una vez, después de 004, en el clon tgggakuinkbibqvvuvob.
-- No modifica registros comerciales anteriores ni inventa motivos históricos.
begin;
create table store_private.profiles (
 user_id uuid primary key references auth.users(id),
 alias text not null check(length(alias) between 2 and 50),
 version integer not null default 1
);
create table store_private.operation_reasons (
 id bigint generated always as identity primary key,
 operation_key uuid unique not null references public.store_operations(operation_key),
 action text not null check(action in ('sale_cancel','transfer_reverse')),
 reference text not null, reason text not null check(length(reason) between 5 and 500),
 actor_id uuid not null references auth.users(id), actor_email text not null, actor_alias text,
 products jsonb not null, created_at timestamptz not null default clock_timestamp()
);
alter table store_private.profiles enable row level security;
alter table store_private.operation_reasons enable row level security;
revoke all on store_private.profiles,store_private.operation_reasons from public,anon,authenticated;
revoke all on sequence store_private.operation_reasons_id_seq from public,anon,authenticated;

create function store_private.require_active_user() returns void language plpgsql stable security definer set search_path='' as $$ begin
 if auth.uid() is null or not exists(select 1 from auth.users u where u.id=auth.uid() and u.email_confirmed_at is not null and (u.banned_until is null or u.banned_until<now())) or not (
 exists(select 1 from public.store_members m where m.user_id=auth.uid() and m.active) or exists(select 1 from store_private.owner_account o where o.user_id=auth.uid())) then
 raise exception 'Inicie sesión con una cuenta autorizada' using errcode='42501'; end if;
end $$;
create function public.store_profile_read() returns jsonb language plpgsql stable security definer set search_path='' as $$ begin
 perform store_private.require_active_user();
 return coalesce((select jsonb_build_object('alias',alias,'version',version) from store_private.profiles where user_id=auth.uid()),jsonb_build_object('alias','','version',0));
end $$;
create function public.store_profile_save(p_alias text,p_version integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare clean text; begin
 perform pg_advisory_xact_lock(729194832); perform store_private.require_active_user();
 clean:=btrim(regexp_replace(p_alias,'[[:space:]]+',' ','g'));
 if clean is null or length(clean) not between 2 and 50 or clean ~ '[[:cntrl:]]' then raise exception 'El alias debe tener entre 2 y 50 caracteres'; end if;
 if p_version=0 then insert into store_private.profiles(user_id,alias) values(auth.uid(),clean);
 else update store_private.profiles set alias=clean,version=version+1 where user_id=auth.uid() and version=p_version;
 if not found then raise exception 'El perfil cambió en otra pestaña. Actualice antes de guardar'; end if; end if;
 return public.store_profile_read();
end $$;

create or replace function public.store_commit(p_key uuid,p_action text,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare perm text; result jsonb; actor uuid; cached public.store_operations%rowtype;
 reason text; reference text; products jsonb; email text; nickname text;
begin
 perform pg_advisory_xact_lock(729194832);
 perm:=case p_action when 'sale_create' then 'sales.create' when 'sale_edit' then 'sales.edit' when 'sale_cancel' then 'sales.cancel' when 'receipt' then 'receipts.create' when 'transfer' then 'movements.create' when 'transfer_reverse' then 'movements.reverse' when 'products_save' then 'inventory.write' end;
 if perm is null then raise exception 'Operación no admitida' using errcode='42501'; end if;
 perform store_private.require_permission(perm);
 select * into cached from public.store_operations where operation_key=p_key;
 if found then
   select user_id into actor from store_private.operation_actors where operation_key=p_key;
   if actor is distinct from auth.uid() then raise exception 'Esta operación pertenece a otra sesión o es anterior al control de acceso' using errcode='42501'; end if;
   if cached.action is distinct from p_action or cached.payload is distinct from p_payload then raise exception 'El identificador de operación ya tiene otros datos'; end if;
   -- Los reintentos de operaciones ya confirmadas nunca vuelven a mover stock.
   return cached.result;
 end if;
 if p_action in ('sale_cancel','transfer_reverse') then
   if jsonb_typeof(p_payload->'reason') is distinct from 'string' then raise exception 'Indique el motivo de la anulación o reversión'; end if;
   reason:=btrim(regexp_replace(p_payload->>'reason','[[:space:]]+',' ','g'));
   if length(reason) not between 5 and 500 then raise exception 'El motivo debe tener entre 5 y 500 caracteres'; end if;
   select u.email,p.alias into email,nickname from auth.users u left join store_private.profiles p on p.user_id=u.id where u.id=auth.uid();
   if p_action='sale_cancel' then
     select s.numero into reference from public.sales s where s.id=(p_payload->>'sale_id')::bigint;
     select coalesce(jsonb_agg(jsonb_build_object('item',si.item,'nombre',si.nombre,'cantidad',si.cantidad,'destino','CEJA') order by si.id),'[]') into products from public.sales_items si where si.sale_id=(p_payload->>'sale_id')::bigint and si.cantidad>0;
   else
     select 'Movimiento #'||m.id,jsonb_build_array(jsonb_build_object('item',m.item,'nombre',m.nombre,'cantidad',abs(m.cantidad),'origen','CEJA','destino','SENKATA')) into reference,products from public.movements m where m.id=(p_payload->>'movement_id')::bigint;
   end if;
 end if;
 result:=store_private.store_commit(p_key,p_action,p_payload);
 insert into store_private.operation_actors values(p_key,auth.uid());
 if p_action in ('sale_cancel','transfer_reverse') then
   insert into store_private.operation_reasons(operation_key,action,reference,reason,actor_id,actor_email,actor_alias,products)
   values(p_key,p_action,reference,reason,auth.uid(),email,nickname,products);
 end if;
 return result;
end $$;

create function public.store_reversal_history(p_before bigint default null)
returns table(id bigint,action text,reference text,reason text,actor_id uuid,actor_email text,actor_alias text,products jsonb,created_at timestamptz)
language plpgsql stable security definer set search_path='' as $$ begin
 perform store_private.require_permission('access.manage');
 return query select r.id,r.action,r.reference,r.reason,r.actor_id,r.actor_email,r.actor_alias,r.products,r.created_at from store_private.operation_reasons r
 where p_before is null or r.id<p_before order by r.id desc limit 51;
end $$;
revoke all on function store_private.require_active_user(),public.store_profile_read(),public.store_profile_save(text,integer),public.store_reversal_history(bigint),public.store_commit(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.store_profile_read(),public.store_profile_save(text,integer),public.store_reversal_history(bigint),public.store_commit(uuid,text,jsonb) to authenticated;
create or replace function public.store_health() returns jsonb language sql stable security definer set search_path='' as $$ select jsonb_build_object('version',1,'revision',5,'atomic',true,'auth',true,'reversal_reasons',true,'profiles',true); $$;
notify pgrst,'reload schema';
commit;
