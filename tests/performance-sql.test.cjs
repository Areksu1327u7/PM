const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite'),{randomUUID}=require('node:crypto');

test('007: índices, reejecución sin cambios y guardado limitado a los productos de la venta',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`);
 await db.exec(fs.readFileSync('tests/transactions.test.cjs','utf8').match(/create table products[\s\S]*?(?=\n  `\);)/)[0]);
 await db.exec('create table roles_matrix(id bigint primary key,data_json jsonb);');
 for(const f of ['001_atomic_store.sql','002_movement_compatibility.sql','003_product_movement_history.sql','004_auth_roles.sql','005_reasons_profiles.sql','006_inventory_integrity.sql'])await db.exec(fs.readFileSync('migrations/'+f,'utf8'));
 const owner=randomUUID();
 await db.query("insert into auth.users values($1,'alexfloresbe@gmail.com',now(),null)",[owner]);
 async function as(fn){await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);await db.exec('set role authenticated');try{return await fn();}finally{await db.exec('reset role');}}
 const call=(action,payload,key=randomUUID())=>as(async()=>(await db.query('select public.store_commit($1,$2,$3) r',[key,action,JSON.stringify(payload)])).rows[0].r);
 await as(()=>db.query('select store_session()'));
 const product=async(item,ceja=10,senkata=20,precio=5)=>{await call('products_save',{products:[{id:null,changes:{item,nombre:item,ceja,senkata,precio}}]});return (await db.query('select * from products where item=$1',[item])).rows[0];};
 const a=await product('PERF-A'),b=await product('PERF-B'),other=await product('PERF-OTRO');
 const first=await call('sale_create',{numero:'PERF-1',fecha:'2026-11-21',cliente:'Prueba',items:[{product_id:a.id,cantidad:2,precio:5}]});
 const snapshot=async()=>JSON.stringify((await db.query(`select jsonb_build_object('p',(select jsonb_agg(p order by id) from products p),'s',(select jsonb_agg(s order by id) from sales s),'i',(select jsonb_agg(i order by id) from sales_items i),'m',(select jsonb_agg(m order by id) from movements m),'o',(select count(*) from store_operations)) x`)).rows[0].x);
 const before=await snapshot(),migration=fs.readFileSync('migrations/007_performance.sql','utf8');

 await t.test('se aplica dos veces sin modificar registros y crea los índices',async()=>{
  await db.exec(migration);await db.exec(migration);assert.equal(await snapshot(),before);
  const names=(await db.query("select indexname from pg_indexes where schemaname='public'")).rows.map(r=>r.indexname);
  for(const n of ['sales_fecha_id_idx','sales_numero_idx','sales_items_sale_id_idx','sales_items_item_idx','movements_tipo_fecha_id_idx','movements_detalle_hash_idx','movements_item_idx','products_item_key_idx'])assert.ok(names.includes(n),n);
  const health=(await db.query('select store_health() h')).rows[0].h;
  assert.equal(health.inventory_integrity,true);assert.equal(health.revision,7);
 });

 await t.test('editar cambiando de producto devuelve el anterior y descuenta el nuevo; otros productos intactos',async()=>{
  const snap=async id=>({sale_id:id,expected_sale:(await db.query('select to_jsonb(s) x from sales s where id=$1',[id])).rows[0].x,expected_items:(await db.query('select to_jsonb(i) x from sales_items i where sale_id=$1 order by id',[id])).rows.map(r=>r.x)});
  const stock=async id=>(await db.query('select ceja,senkata from products where id=$1',[id])).rows[0];
  assert.deepEqual(await stock(a.id),{ceja:8,senkata:20});
  await call('sale_edit',{...await snap(first.sale_id),descuento_pct:0,items:[{product_id:b.id,cantidad:3,precio:5}]});
  assert.deepEqual(await stock(a.id),{ceja:10,senkata:20});
  assert.deepEqual(await stock(b.id),{ceja:7,senkata:20});
  assert.deepEqual(await stock(other.id),{ceja:10,senkata:20});
  await call('sale_cancel',{...await snap(first.sale_id),reason:'Prueba de rendimiento'});
  assert.deepEqual(await stock(b.id),{ceja:10,senkata:20});
  await assert.rejects(call('sale_create',{numero:'PERF-2',fecha:'2026-11-21',cliente:'Prueba',items:[{product_id:a.id,cantidad:11,precio:5}]}),/insuficiente/);
  assert.deepEqual(await stock(a.id),{ceja:10,senkata:20});
 });

 await t.test('descuento con más de dos decimales se guarda redondeado y coherente (antes se rechazaba)',async()=>{
  const big=await product('PERF-PCT',10,0,1000);
  const r=await call('sale_create',{numero:'PERF-PCT',fecha:'2026-11-21',cliente:'Prueba',descuento_pct:7.125,items:[{product_id:big.id,cantidad:1,precio:1000}]});
  assert.deepEqual({subtotal:r.subtotal,descuento:r.descuento,total:r.total},{subtotal:1000,descuento:71.3,total:928.7});
  const row=(await db.query('select descuento_pct::text pct from sales where id=$1',[r.sale_id])).rows[0];
  assert.equal(row.pct,'7.13');
 });
});
