-- Ejecutar solo en el clon tgggakuinkbibqvvuvob.
-- Consulta de transferencias por producto; no modifica registros existentes.
begin;

create or replace function public.store_product_transfers(p_item text)
returns table (
  id bigint,
  fecha date,
  item text,
  nombre text,
  cantidad integer,
  detalle text,
  created_at timestamptz
)
language sql stable security definer set search_path = public, pg_temp
as $$
  select m.id, m.fecha, m.item, m.nombre, m.cantidad, m.detalle, o.created_at
  from public.movements m
  left join public.store_operations o
    on o.operation_key::text = lower(substring(m.detalle from '\[MOV:([0-9a-fA-F-]{36})\]'))
    and o.action in ('transfer', 'transfer_reverse')
  where m.item = p_item and m.tipo = 'transfer'
  order by m.fecha desc, m.id desc;
$$;

revoke all on function public.store_product_transfers(text) from public;
grant execute on function public.store_product_transfers(text) to anon, authenticated;
notify pgrst, 'reload schema';

commit;
