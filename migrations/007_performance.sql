-- 007: rendimiento de consultas y guardado de ventas.
-- Aplicar después de 006. No actualiza ni elimina registros comerciales; solo crea índices
-- y reemplaza la función privada de guardado con la misma lógica de negocio.
-- Reejecutable. Conserva autenticación, motivos, autoría, bloqueos e idempotencia.
begin;
do $$ begin
 if to_regprocedure('store_private.assert_sale_balanced(bigint)') is null then
   raise exception 'Instale las migraciones 001–006 antes de aplicar 007';
 end if;
end $$;

-- Historial de ventas: filtro por fecha y orden fecha desc, id desc.
create index if not exists sales_fecha_id_idx on public.sales (fecha desc, id desc);
-- Número de comprobante (unicidad al crear y detalle).
create index if not exists sales_numero_idx on public.sales (numero);
-- Detalle de una venta, dashboard y comprobaciones del guardado.
create index if not exists sales_items_sale_id_idx on public.sales_items (sale_id);
-- Historial por producto y verificación de renombres.
create index if not exists sales_items_item_idx on public.sales_items (item);
-- Historial de transferencias, ingresos del dashboard y anulaciones.
create index if not exists movements_tipo_fecha_id_idx on public.movements (tipo, fecha desc, id desc);
-- Estado de anulación por comprobante e ingreso duplicado (igualdad exacta).
create index if not exists movements_detalle_hash_idx on public.movements using hash (detalle);
create index if not exists movements_item_idx on public.movements (item);
-- Búsqueda de ITEM sin distinguir mayúsculas en ingresos y catálogo.
create index if not exists products_item_key_idx on public.products (lower(btrim(item)));

create or replace function store_private.store_commit(p_key uuid, p_action text, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  cached public.store_operations%rowtype;
  p public.products%rowtype;
  s public.sales%rowtype;
  m public.movements%rowtype;
  line jsonb; oldline record; entry jsonb; changes jsonb;
  result jsonb; lines jsonb; snapshot jsonb;
  sid bigint; pid bigint; qty integer; oldqty integer; delta integer;
  price numeric; sub numeric := 0; pct numeric := 0; discount numeric; total_amount numeric;
  num text; customer text; sku text; dt date; count_rows integer := 0;
begin
  if p_key is null or p_payload is null then raise exception 'Operación incompleta'; end if;
  -- Serializa operaciones de negocio y reintentos en todos los equipos.
  perform pg_advisory_xact_lock(729194831);
  select * into cached from public.store_operations where operation_key=p_key;
  if found then
    if cached.action <> p_action or cached.payload <> p_payload then
      raise exception 'El identificador de operación ya tiene otros datos';
    end if;
    return cached.result;
  end if;

  if p_action in ('sale_create','sale_edit','sale_cancel') then
    if p_action <> 'sale_create' then
      sid := (p_payload->>'sale_id')::bigint;
      select * into s from public.sales where id=sid for update;
      if not found then raise exception 'Venta no encontrada'; end if;
      if exists(select 1 from public.movements where detalle='Anulación comprobante '||s.numero)
        or coalesce(to_jsonb(s)->>'estado','')='anulada' then
        raise exception 'Esta venta ya fue anulada. Actualice el historial';
      end if;
      select coalesce(jsonb_agg(to_jsonb(si) order by si.id),'[]') into snapshot
        from public.sales_items si where sale_id=sid;
      if p_payload->'expected_sale' is distinct from to_jsonb(s)
        or p_payload->'expected_items' is distinct from snapshot then
        raise exception 'La venta cambió en otro equipo. Cierre y vuelva a abrir sus detalles';
      end if;
      perform store_private.assert_sale_balanced(sid);
      num := s.numero; dt := s.fecha; customer := s.cliente;
    else
      num := btrim(p_payload->>'numero'); dt := (p_payload->>'fecha')::date;
      customer := btrim(p_payload->>'cliente');
      if coalesce(num,'')='' or coalesce(customer,'')='' or dt is null then raise exception 'Complete número, fecha y cliente'; end if;
      if exists(select 1 from public.sales where numero=num) then raise exception 'El número de venta ya existe'; end if;
    end if;

    if p_action='sale_cancel' then
      for oldline in select item,sum(cantidad)::integer cantidad from public.sales_items where sale_id=sid group by item order by item loop
        if oldline.cantidad=0 then continue; end if;
        select * into strict p from public.products where item=oldline.item for update;
        update public.products set ceja=ceja+oldline.cantidad where id=p.id;
      end loop;
      select -coalesce(sum(cantidad),0) into count_rows from public.sales_items where sale_id=sid;
      insert into public.movements(tipo,fecha,item,nombre,cantidad,detalle,total,descuento)
        values('venta',dt,'-',customer||' (ANULADA)',abs(count_rows),'Anulación comprobante '||num,0,0);
      result := jsonb_build_object('sale_id',sid,'numero',num,'cancelled',true);
    else
      lines := p_payload->'items'; pct := coalesce((p_payload->>'descuento_pct')::numeric,0);
      if lines is null or jsonb_typeof(lines)<>'array' or jsonb_array_length(lines)=0 then raise exception 'Agregue productos a la venta'; end if;
      -- Comparar IDs numéricamente antes de tocar existencias impide aliases como 7 y "0007".
      if (select count(*) from jsonb_array_elements(lines) x where x->>'line_id' is not null) <>
         (select count(distinct (x->>'line_id')::bigint) from jsonb_array_elements(lines) x where x->>'line_id' is not null)
      then raise exception 'Línea repetida: cada identificador debe aparecer una sola vez'; end if;
      if pct<0 or pct>100 or pct::text in ('NaN','Infinity','-Infinity') then raise exception 'Descuento inválido'; end if;
      -- 007: la columna guarda 2 decimales; calcular con el mismo valor que se almacena.
      pct := round(pct,2);
      for line in select value from jsonb_array_elements(lines) loop
        if (line->>'cantidad')::numeric <> trunc((line->>'cantidad')::numeric) then raise exception 'La cantidad debe ser entera'; end if;
        qty := (line->>'cantidad')::integer; price := (line->>'precio')::numeric;
        if qty is null or qty<=0 or price is null or price<0 or price::text in ('NaN','Infinity','-Infinity') then raise exception 'Cantidad o precio inválidos'; end if;
        select * into strict p from public.products where id=(line->>'product_id')::bigint for update;
        if price<>round(price,2) then raise exception 'El precio debe tener como máximo dos decimales'; end if;
        sub := sub+round(qty*price,2);
      end loop;
      -- Una sola variación por producto; quitar una línea nunca devuelve dos veces.
      -- 007: solo se bloquean y recorren los productos de la solicitud o de la venta original.
      -- Para cualquier otro producto qty=0 y oldqty=0, por lo que el resultado es idéntico.
      for p in select * from public.products pr
        where pr.id in (select (x->>'product_id')::bigint from jsonb_array_elements(lines) x)
           or pr.item in (select si.item from public.sales_items si where si.sale_id=sid)
        order by pr.id for update loop
        select coalesce(sum((x->>'cantidad')::integer),0) into qty
          from jsonb_array_elements(lines) x where (x->>'product_id')::bigint=p.id;
        select coalesce(sum(cantidad),0) into oldqty from public.sales_items where sale_id=sid and item=p.item;
        delta := oldqty-qty;
        if delta<>0 then
          if p.ceja+delta<0 then raise exception 'Stock CEJA insuficiente para %: disponible %',p.item,p.ceja; end if;
          update public.products set ceja=ceja+delta where id=p.id;
        end if;
      end loop;
      if p_action='sale_edit' and exists(select 1 from public.sales_items si where si.sale_id=sid and si.cantidad<>0 and not exists(select 1 from public.products p2 where p2.item=si.item)) then
        raise exception 'Hay un producto histórico ausente del catálogo. No se modificó la venta';
      end if;
      discount := round(sub*pct/100,2); total_amount := sub-discount;
      select coalesce(sum((x->>'cantidad')::integer),0) into count_rows from jsonb_array_elements(lines) x;
      if p_action='sale_edit' then
        select count_rows-coalesce(sum(cantidad),0) into count_rows from public.sales_items where sale_id=sid;
      end if;
      if p_action='sale_create' then
        insert into public.sales(numero,fecha,cliente,subtotal,descuento_pct,descuento,total)
          values(num,dt,customer,sub,pct,discount,total_amount) returning id into sid;
      else
        -- Conservar las líneas anteriores en el diario y filas retiradas con cantidad cero.
        update public.sales_items set cantidad=0,subtotal=0 where sale_id=sid;
        update public.sales set subtotal=sub,descuento_pct=pct,descuento=discount,total=total_amount where id=sid;
      end if;
      for line in select value from jsonb_array_elements(lines) loop
        select * into strict p from public.products where id=(line->>'product_id')::bigint;
        qty := (line->>'cantidad')::integer; price := (line->>'precio')::numeric;
        if p_action='sale_edit' and line->>'line_id' is not null then
          update public.sales_items set cantidad=qty,precio=price,subtotal=round(qty*price,2)
            where id=(line->>'line_id')::bigint and sale_id=sid and item=p.item;
          if not found then raise exception 'Línea de venta inválida'; end if;
        else
          insert into public.sales_items(sale_id,item,nombre,cantidad,precio,subtotal)
            values(sid,p.item,p.nombre,qty,price,round(qty*price,2));
        end if;
      end loop;
      perform store_private.assert_sale_balanced(sid);
      -- Comprueba por producto las cantidades y los importes persistidos, no solo el total.
      if exists (
        with expected as (
          select p2.item,sum((x->>'cantidad')::bigint) qty,sum(round((x->>'cantidad')::numeric*(x->>'precio')::numeric,2)) amount
          from jsonb_array_elements(lines) x join public.products p2 on p2.id=(x->>'product_id')::bigint group by p2.item
        ), actual as (
          select item,sum(cantidad) qty,sum(subtotal) amount from public.sales_items where sale_id=sid and cantidad>0 group by item
        )
        select 1 from expected e full join actual a using(item)
        where e.qty is distinct from a.qty or e.amount is distinct from a.amount
      ) then raise exception 'El detalle de la venta no coincide con lo solicitado. No se aplicó ningún cambio'; end if;
      insert into public.movements(tipo,fecha,item,nombre,cantidad,detalle,total,descuento)
        values('venta',dt,'-',customer,abs(count_rows),case when p_action='sale_create' then 'Venta comprobante ' else 'Ajuste comprobante ' end||num,
          abs(total_amount-case when p_action='sale_edit' then s.total else 0 end),discount);
      result := jsonb_build_object('sale_id',sid,'numero',num,'subtotal',sub,'descuento',discount,'total',total_amount);
    end if;

  elsif p_action in ('transfer','receipt') then
    dt := (p_payload->>'fecha')::date; lines := p_payload->'items';
    if dt is null or lines is null or jsonb_typeof(lines)<>'array' or jsonb_array_length(lines)=0 then raise exception 'Fecha o productos inválidos'; end if;
    num := btrim(p_payload->>'numero'); customer := btrim(p_payload->>'proveedor');
    if p_action='receipt' then
      if coalesce(num,'')='' or coalesce(customer,'')='' then raise exception 'Complete comprobante y proveedor'; end if;
      if exists(select 1 from public.movements where tipo='ingreso' and detalle='Ingreso comprobante '||num) then raise exception 'El comprobante de ingreso ya existe'; end if;
    end if;
    for line in select value from jsonb_array_elements(lines) loop
      if (line->>'cantidad')::numeric <> trunc((line->>'cantidad')::numeric) then raise exception 'La cantidad debe ser entera'; end if;
      qty := (line->>'cantidad')::integer;
      if qty is null or qty<=0 then raise exception 'Cantidad inválida'; end if;
      if p_action='transfer' then
        select * into strict p from public.products where id=(line->>'product_id')::bigint for update;
        if p.senkata<qty then raise exception 'Stock SENKATA insuficiente para %',p.item; end if;
        update public.products set ceja=ceja+qty,senkata=senkata-qty where id=p.id;
        insert into public.movements(tipo,fecha,item,nombre,cantidad,detalle,total,descuento)
          values('transfer',dt,p.item,p.nombre,qty,'SENKATA → CEJA [MOV:'||p_key||']',0,0);
      else
        sku := btrim(line->>'item'); price := (line->>'precioCompra')::numeric;
        if coalesce(sku,'')='' or coalesce(btrim(line->>'nombre'),'')='' or price is null or price<0 or price::text in ('NaN','Infinity','-Infinity') then raise exception 'Producto o costo inválido'; end if;
        if (select count(*) from public.products where lower(btrim(item))=lower(sku))>1 then
          raise exception 'Existen ITEMs ambiguos para %. Revise el catálogo antes de registrar el ingreso',sku;
        end if;
        select * into p from public.products where lower(btrim(item))=lower(sku) for update;
        if found then
          update public.products set senkata=senkata+qty where id=p.id;
        else
          if (line->>'precioVenta')::numeric<0 or (line->>'precioVenta') is null or (line->>'precioVenta')::numeric::text in ('NaN','Infinity','-Infinity') then raise exception 'Precio inválido'; end if;
          insert into public.products(item,nombre,categoria,ceja,senkata,unidad,precio)
            values(sku,btrim(line->>'nombre'),coalesce(nullif(line->>'categoria',''),'General'),0,qty,'PCS',(line->>'precioVenta')::numeric);
        end if;
        sub := sub+round(qty*price,2);
      end if;
      count_rows := count_rows+qty;
    end loop;
    if p_action='receipt' then
      insert into public.movements(tipo,fecha,item,nombre,cantidad,detalle,total,descuento)
        values('ingreso',dt,'-',customer,count_rows,'Ingreso comprobante '||num,sub,0);
    end if;
    result := jsonb_build_object('numero',coalesce(num,p_key::text),'total',sub,'cantidad',count_rows);

  elsif p_action='transfer_reverse' then
    select * into strict m from public.movements where id=(p_payload->>'movement_id')::bigint for update;
    if m.tipo<>'transfer' or m.cantidad<=0 or m.detalle like 'Reversión movimiento %' then raise exception 'Movimiento no reversible'; end if;
    -- Incluye solicitudes anteriores a esta corrección que guardaron el ID como texto.
    if exists(select 1 from public.store_operations where action='transfer_reverse' and (payload->>'movement_id')::bigint=m.id)
       or exists(select 1 from public.movements r where r.tipo='transfer'
         and substring(r.detalle from '^Reversión movimiento ([0-9]+)(?:[[:space:]]|$)')::numeric=m.id)
    then raise exception 'Este movimiento ya fue revertido'; end if;
    select * into strict p from public.products where item=m.item for update;
    if p.ceja<m.cantidad then raise exception 'Stock CEJA insuficiente para revertir'; end if;
    update public.products set ceja=ceja-m.cantidad,senkata=senkata+m.cantidad where id=p.id;
    insert into public.movements(tipo,fecha,item,nombre,cantidad,detalle,total,descuento)
      values('transfer',(now() at time zone 'America/La_Paz')::date,m.item,m.nombre,m.cantidad,'Reversión movimiento '||m.id||' [MOV:'||p_key||']',0,0);
    result := jsonb_build_object('reversed',m.id);

  elsif p_action='products_save' then
    if p_payload->'products' is null or jsonb_typeof(p_payload->'products')<>'array' or jsonb_array_length(p_payload->'products')=0 then raise exception 'No hay productos para guardar'; end if;
    for entry in select value from jsonb_array_elements(p_payload->'products') loop
      changes := entry->'changes'; pid := (entry->>'id')::bigint;
      if pid is not null then
        select * into strict p from public.products where id=pid for update;
        if entry->'expected' is distinct from to_jsonb(p) then raise exception 'El producto % cambió en otro equipo. Actualice y vuelva a editar',p.item; end if;
        if changes ? 'item' and changes->>'item'<>p.item and (
          exists(select 1 from public.sales_items where item=p.item) or exists(select 1 from public.movements where item=p.item)) then
          raise exception 'No se puede cambiar el ITEM % porque tiene historial',p.item;
        end if;
        snapshot := to_jsonb(p)||changes;
      else
        snapshot := jsonb_build_object('ceja',0,'senkata',0,'precio',0,'unidad','PCS','categoria','General')||changes;
      end if;
      if coalesce(btrim(snapshot->>'item'),'')='' or coalesce(btrim(snapshot->>'nombre'),'')='' then raise exception 'ITEM y nombre son obligatorios'; end if;
      if exists(select 1 from public.products where lower(btrim(item))=lower(btrim(snapshot->>'item')) and id is distinct from pid) then raise exception 'ITEM duplicado'; end if;
      if (snapshot->>'ceja')::numeric<0 or (snapshot->>'senkata')::numeric<0 or (snapshot->>'precio')::numeric<0
        or (snapshot->>'ceja')::numeric<>trunc((snapshot->>'ceja')::numeric)
        or (snapshot->>'senkata')::numeric<>trunc((snapshot->>'senkata')::numeric)
        or (snapshot->>'precio')::numeric::text in ('NaN','Infinity','-Infinity') then raise exception 'Stock o precio inválido'; end if;
      if pid is null then
        insert into public.products(item,nombre,categoria,ceja,senkata,unidad,precio)
          values(btrim(snapshot->>'item'),btrim(snapshot->>'nombre'),snapshot->>'categoria',(snapshot->>'ceja')::integer,(snapshot->>'senkata')::integer,snapshot->>'unidad',(snapshot->>'precio')::numeric)
          returning id into pid;
      else
        update public.products set item=btrim(snapshot->>'item'),nombre=btrim(snapshot->>'nombre'),categoria=snapshot->>'categoria',
          ceja=(snapshot->>'ceja')::integer,senkata=(snapshot->>'senkata')::integer,unidad=snapshot->>'unidad',precio=(snapshot->>'precio')::numeric where id=pid;
      end if;
      count_rows := count_rows+1;
    end loop;
    result := jsonb_build_object('updated',count_rows);
  else raise exception 'Operación no admitida';
  end if;
  insert into public.store_operations(operation_key,action,payload,result) values(p_key,p_action,p_payload,result);
  return result;
end $$;

revoke all on function store_private.store_commit(uuid,text,jsonb) from public,anon,authenticated;
create or replace function public.store_health() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('version',1,'revision',7,'atomic',true,'auth',true,'reversal_reasons',true,'profiles',true,'inventory_integrity',true,'performance',true);
$$;
revoke all on function public.store_health() from public;
grant execute on function public.store_health() to anon,authenticated;
analyze public.products; analyze public.sales; analyze public.sales_items; analyze public.movements;
notify pgrst,'reload schema';
commit;
