const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite'),{randomUUID}=require('node:crypto');

test('regresión comercial completa con la migración de integridad',async t=>{
 const results=await require('../scripts/audit-transactions.cjs').runAudit({writeReport:false,log:false});
 for(const result of results)await t.test(result.name,()=>assert.equal(result.status,'PASS',JSON.stringify(result)));
});

test('006: compatibilidad histórica, integridad, rollback y permisos',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`);
 await db.exec(fs.readFileSync('tests/transactions.test.cjs','utf8').match(/create table products[\s\S]*?(?=\n  `\);)/)[0]);
 await db.exec('create table roles_matrix(id bigint primary key,data_json jsonb);');
 for(const f of ['001_atomic_store.sql','002_movement_compatibility.sql','003_product_movement_history.sql','004_auth_roles.sql','005_reasons_profiles.sql'])await db.exec(fs.readFileSync('migrations/'+f,'utf8'));
 const owner=randomUUID(),seller=randomUUID();
 await db.query("insert into auth.users values($1,'alexfloresbe@gmail.com',now(),null),($2,'seller@example.test',now(),null)",[owner,seller]);
 async function as(id,fn,role='authenticated'){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||'']);await db.exec('set role '+role);try{return await fn();}finally{await db.exec('reset role');}}
 const rpc=async(name,args=[])=>(await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;
 const call=(action,payload,key=randomUUID())=>as(owner,()=>rpc('store_commit',[key,action,JSON.stringify(payload)]));
 await as(owner,()=>rpc('store_session'));await as(seller,()=>rpc('store_session'));await as(owner,()=>rpc('store_member_save',[seller,'Vendedor',true,1]));
 const snap=async id=>({sale_id:id,expected_sale:(await db.query('select to_jsonb(s) x from sales s where id=$1',[id])).rows[0].x,expected_items:(await db.query('select to_jsonb(i) x from sales_items i where sale_id=$1 order by id',[id])).rows.map(r=>r.x)});
 const snapshot=async()=>JSON.stringify((await db.query(`select jsonb_build_object(
 'p',(select jsonb_agg(p order by id) from products p),'s',(select jsonb_agg(s order by id) from sales s),
 'i',(select jsonb_agg(i order by id) from sales_items i),'m',(select jsonb_agg(m order by id) from movements m),
 'o',(select jsonb_agg(o order by operation_key) from store_operations o),
 'a',(select jsonb_agg(a order by operation_key) from store_private.operation_actors a),
 'r',(select jsonb_agg(r order by id) from store_private.operation_reasons r)) x`)).rows[0].x);
 await call('products_save',{products:[{id:null,changes:{item:'LEGACY',nombre:'Prueba histórica',ceja:100,senkata:100,precio:5}}]});
 const pid=(await db.query("select id from products where item='LEGACY'")).rows[0].id;
 await call('transfer',{fecha:'2026-11-03',items:[{product_id:pid,cantidad:3}]});
 const mid=(await db.query("select id from movements where tipo='transfer' order by id desc limit 1")).rows[0].id;
 const reverseKey=randomUUID(),reversePayload={movement_id:'000'+mid,reason:'Reversión histórica de prueba'};
 const reversed=await call('transfer_reverse',reversePayload,reverseKey);
 const newSale=()=>call('sale_create',{numero:randomUUID(),fecha:'2026-11-03',cliente:'Prueba',items:[{product_id:pid,cantidad:2,precio:5}]});
 const corrupt=await newSale(),old=await snap(corrupt.sale_id),line=old.expected_items[0].id;
 await call('sale_edit',{...old,items:[{line_id:line,product_id:pid,cantidad:2,precio:5},{line_id:'000'+line,product_id:pid,cantidad:3,precio:5}]});
 const before=await snapshot(),migration=fs.readFileSync('migrations/006_inventory_integrity.sql','utf8');
 await t.test('migración repetible conserva todas las filas, incluso las inconsistentes antiguas',async()=>{
  await db.exec(migration);await db.exec(migration);assert.equal(await snapshot(),before);
  assert.equal((await rpc('store_health')).inventory_integrity,true);
 });
 await t.test('reintento histórico confirma sin repetir y otra clave no permite segunda reversión',async()=>{
  assert.deepEqual(await call('transfer_reverse',reversePayload,reverseKey),reversed);
  for(const value of [mid,String(mid),'000'+mid,' +'+mid+' '])await assert.rejects(call('transfer_reverse',{movement_id:value,reason:'Intento de duplicado'}),/ya fue revertido/);
  assert.equal(await snapshot(),before);
 });
 await t.test('una venta previamente descuadrada bloquea cancelación y edición sin tocar stock',async()=>{
  const data=await snap(corrupt.sale_id),state=await snapshot();
  await assert.rejects(call('sale_cancel',{...data,reason:'Prueba de venta inconsistente'}),/diferencias entre cabecera y detalle/);
  await assert.rejects(call('sale_edit',{...data,items:[{product_id:pid,cantidad:1,precio:5}]}),/diferencias entre cabecera y detalle/);
  assert.equal(await snapshot(),state);
 });
 await t.test('IDs numéricos equivalentes se rechazan antes de cambiar venta, stock o auditoría',async()=>{
  const sale=await newSale(),data=await snap(sale.sale_id),id=data.expected_items[0].id,state=await snapshot();
  for(const alias of [id,String(id),'000'+id,'+'+id,' '+id+' ']){
   await assert.rejects(call('sale_edit',{...data,items:[{line_id:id,product_id:pid,cantidad:2,precio:5},{line_id:alias,product_id:pid,cantidad:3,precio:5}]}),/Línea repetida/);
   assert.equal(await snapshot(),state);
  }
 });
 await t.test('reversión histórica sin diario también bloquea una nueva devolución',async()=>{
  await call('transfer',{fecha:'2026-11-03',items:[{product_id:pid,cantidad:1}]});
  const movement=(await db.query("select id from movements where tipo='transfer' order by id desc limit 1")).rows[0].id;
  // Simula un registro heredado en la base aislada; nunca toca Supabase.
  await db.query("insert into movements(tipo,fecha,item,nombre,cantidad,detalle,total,descuento) values('transfer','2026-11-03','LEGACY','Prueba histórica',1,$1,0,0)",['Reversión movimiento 000'+movement]);
  const state=await snapshot();await assert.rejects(call('transfer_reverse',{movement_id:movement,reason:'Registro histórico'}),/ya fue revertido/);assert.equal(await snapshot(),state);
 });
 await t.test('fallo de integridad después de escribir el detalle revierte también existencias',async()=>{
  await db.exec("create function public.test_break_line() returns trigger language plpgsql as $$begin new.subtotal:=new.subtotal+1;return new;end$$;create trigger break_line before insert on sales_items for each row execute function public.test_break_line();");
  const state=await snapshot();await assert.rejects(newSale(),/diferencias entre cabecera y detalle/);assert.equal(await snapshot(),state);
  await db.exec('drop trigger break_line on sales_items;drop function public.test_break_line();');
 });
 await t.test('funciones privadas inaccesibles y roles conservados',async()=>{
  for(const [id,role] of [[owner,'authenticated'],[null,'anon']])await as(id,async()=>{
   await assert.rejects(db.query('select store_private.assert_sale_balanced($1)',[corrupt.sale_id]),/permission denied/);
   await assert.rejects(db.query("select store_private.store_commit($1,'transfer_reverse','{}')",[randomUUID()]),/permission denied/);
  },role);
  await as(seller,()=>assert.rejects(rpc('store_commit',[randomUUID(),'transfer_reverse',JSON.stringify({movement_id:mid,reason:'Sin permisos'})]),/autorizado/));
  await as(null,()=>assert.rejects(rpc('store_commit',[randomUUID(),'sale_create','{}']),/permission denied/),'anon');
 });
});
