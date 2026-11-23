/* Auditoría reproducible y exclusivamente local. No usa red ni credenciales.
   Ejecutar: node scripts/audit-transactions.cjs
   Un código de salida 1 indica un fallo de integridad reproducido. */
const fs=require('node:fs'),assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite'),{randomUUID}=require('node:crypto');
async function main({writeReport=true,log=true}={}){
 const db=new PGlite(),results=[];
 try{
  await db.exec(`create role anon;create role authenticated;create schema auth;
   create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);
   create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`);
  const fixture=fs.readFileSync('tests/transactions.test.cjs','utf8').match(/create table products[\s\S]*?(?=\n  `\);)/)[0];
  await db.exec(fixture);await db.exec('create table roles_matrix(id bigint primary key,data_json jsonb);');
  for(const file of ['001_atomic_store.sql','002_movement_compatibility.sql','003_product_movement_history.sql','004_auth_roles.sql','005_reasons_profiles.sql','006_inventory_integrity.sql','007_performance.sql'])await db.exec(fs.readFileSync('migrations/'+file,'utf8'));
  const owner=randomUUID();await db.query("insert into auth.users values($1,'alexfloresbe@gmail.com',now(),null)",[owner]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);await db.exec('set role authenticated');
  await db.query('select store_session()');
  const call=async(action,payload,key=randomUUID())=>(await db.query('select store_commit($1,$2,$3) result',[key,action,JSON.stringify(payload)])).rows[0].result;
  const date='2026-11-03',reason='Prueba local de integridad';
  const stock=async id=>(await db.query('select ceja,senkata from products where id=$1',[id])).rows[0];
  const snapshot=async id=>({sale_id:id,expected_sale:(await db.query('select to_jsonb(s) value from sales s where id=$1',[id])).rows[0].value,expected_items:(await db.query('select to_jsonb(i) value from sales_items i where sale_id=$1 order by id',[id])).rows.map(r=>r.value)});
  const before=async()=>JSON.stringify((await db.query("select jsonb_build_object('p',(select jsonb_agg(p order by id) from products p),'s',(select jsonb_agg(s order by id) from sales s),'i',(select jsonb_agg(i order by id) from sales_items i),'m',(select jsonb_agg(m order by id) from movements m)) value")).rows[0].value);
  const initial=await db.query("select * from products where item='ANTERIOR'");
  async function product(ceja=10,senkata=20){const item='AUDIT-'+randomUUID();await call('products_save',{products:[{id:null,changes:{item,nombre:'Prueba aislada',ceja,senkata,precio:5}}]});return (await db.query('select * from products where item=$1',[item])).rows[0];}
  const salePayload=(p,qty=2)=>({numero:'AUDIT-'+randomUUID(),fecha:date,cliente:'Prueba local',items:[{product_id:p.id,cantidad:qty,precio:5}]});
  async function transfer(p,qty=3){const key=randomUUID();await call('transfer',{fecha:date,items:[{product_id:p.id,cantidad:qty}]},key);return (await db.query("select id from movements where detalle like $1",['%'+key+'%'])).rows[0].id;}
  async function test(name,fn){const evidence={};try{await fn(evidence);results.push({name,status:'PASS',evidence});log&&console.log('PASS '+name);}catch(e){results.push({name,status:'FAIL',message:e.message,evidence});log&&console.log('FAIL '+name+' — '+e.message);}}
  await test('Venta con descuento y 5 reintentos conserva un único descuento de stock',async()=>{
   const p=await product(),key=randomUUID(),payload={...salePayload(p,3),descuento_pct:10};
   const first=await call('sale_create',payload,key);assert.equal(first.total,13.5);
   for(let i=0;i<5;i++)assert.deepEqual(await call('sale_create',payload,key),first);
   assert.deepEqual(await stock(p.id),{ceja:7,senkata:20});
  });
  await test('Fallo de stock en la segunda línea revierte toda la venta',async()=>{
   const a=await product(),b=await product(1),state=await before();
   await assert.rejects(call('sale_create',{...salePayload(a),items:[{product_id:a.id,cantidad:2,precio:5},{product_id:b.id,cantidad:3,precio:5}]}));assert.equal(await before(),state);
  });
  await test('Venta repetida del mismo producto: edición y anulación restituyen las cantidades',async()=>{
   const p=await product(),sale=await call('sale_create',{...salePayload(p),items:[{product_id:p.id,cantidad:2,precio:5},{product_id:p.id,cantidad:3,precio:4}]});
   assert.equal((await stock(p.id)).ceja,5);
   const original=await snapshot(sale.sale_id);await call('sale_edit',{...original,items:[{line_id:original.expected_items[0].id,product_id:p.id,cantidad:1,precio:5}],descuento_pct:0});
   assert.equal((await stock(p.id)).ceja,9);await call('sale_cancel',{...await snapshot(sale.sale_id),reason});assert.equal((await stock(p.id)).ceja,10);
  });
  await test('Cancelación con reintentos y segunda clave no duplica devolución',async()=>{
   const p=await product(),sale=await call('sale_create',salePayload(p)),key=randomUUID(),payload={...await snapshot(sale.sale_id),reason};
   await call('sale_cancel',payload,key);await call('sale_cancel',payload,key);await assert.rejects(call('sale_cancel',payload));assert.equal((await stock(p.id)).ceja,10);
  });
  await test('Transferencia con SKU repetido y stock insuficiente revierte todas las líneas',async()=>{
   const p=await product(0,5),state=await before();await assert.rejects(call('transfer',{fecha:date,items:[{product_id:p.id,cantidad:3},{product_id:p.id,cantidad:3}]}));assert.equal(await before(),state);
  });
  await test('No se revierte mercadería ya vendida si falta stock en CEJA',async()=>{
   const p=await product(0,5),mid=await transfer(p,5);await call('sale_create',salePayload(p,5));const state=await before();
   await assert.rejects(call('transfer_reverse',{movement_id:mid,reason}),/insuficiente/);assert.equal(await before(),state);
  });
  await test('Reversión normal: reintento único, segunda reversión y reversión de reversión bloqueadas',async()=>{
   const p=await product(),mid=await transfer(p),key=randomUUID(),payload={movement_id:mid,reason};
   await call('transfer_reverse',payload,key);await call('transfer_reverse',payload,key);await assert.rejects(call('transfer_reverse',payload));
   const reverse=(await db.query("select id from movements where detalle like $1",['Reversión movimiento '+mid+' %'])).rows[0].id;
   await assert.rejects(call('transfer_reverse',{movement_id:reverse,reason}));assert.deepEqual(await stock(p.id),{ceja:10,senkata:20});
  });
  await test('Edición con datos antiguos no sobrescribe otra edición',async()=>{
   const p=await product(),sale=await call('sale_create',salePayload(p)),old=await snapshot(sale.sale_id);
   await call('sale_edit',{...old,items:[{product_id:p.id,cantidad:3,precio:5}]});const state=await before();
   await assert.rejects(call('sale_edit',{...old,items:[{product_id:p.id,cantidad:4,precio:5}]}),/cambió/);assert.equal(await before(),state);
  });
  await test('Ingreso repetido y fallo en segunda línea no duplican existencias',async()=>{
   const p=await product(),payload={numero:'AUDIT-'+randomUUID(),fecha:date,proveedor:'Prueba',items:[{item:p.item,nombre:p.nombre,cantidad:2,precioCompra:3,precioVenta:5}]},key=randomUUID();
   await call('receipt',payload,key);await call('receipt',payload,key);await assert.rejects(call('receipt',payload));assert.equal((await stock(p.id)).senkata,22);
   const state=await before();await assert.rejects(call('receipt',{...payload,numero:payload.numero+'-BAD',items:[...payload.items,{item:'MISSING',nombre:'Inválido',cantidad:1,precioCompra:-1,precioVenta:5}]}));assert.equal(await before(),state);
  });
  await test('Cantidades inválidas y motivos ausentes se rechazan sin modificar tablas',async()=>{
   const p=await product(),mid=await transfer(p);
   for(const qty of [-1,0,1.5,null,'NaN',2147483648]){const state=await before();await assert.rejects(call('sale_create',salePayload(p,qty)));await assert.rejects(call('transfer',{fecha:date,items:[{product_id:p.id,cantidad:qty}]}));assert.equal(await before(),state);}
   const state=await before();await assert.rejects(call('transfer_reverse',{movement_id:mid}));assert.equal(await before(),state);
  });
  await test('Identificador equivalente no permite revertir dos veces el mismo movimiento',async evidence=>{
   const p=await product(),mid=await transfer(p,3);evidence.before=await stock(p.id);
   await call('transfer_reverse',{movement_id:'000'+mid,reason});evidence.afterFirst=await stock(p.id);
   let rejected=false;try{await call('transfer_reverse',{movement_id:mid,reason});}catch{rejected=true;}
   evidence.afterSecond=await stock(p.id);evidence.secondRejected=rejected;
   assert.equal(rejected,true,'Se aceptó una segunda reversión usando otra representación del mismo ID');assert.deepEqual(evidence.afterSecond,{ceja:10,senkata:20});
  });
  await test('IDs de línea equivalentes no descuadran venta, detalle y devolución',async evidence=>{
   const p=await product(),sale=await call('sale_create',salePayload(p)),original=await snapshot(sale.sale_id),id=original.expected_items[0].id;
   let rejected=false;try{await call('sale_edit',{...original,items:[{line_id:id,product_id:p.id,cantidad:2,precio:5},{line_id:'000'+id,product_id:p.id,cantidad:3,precio:5}],descuento_pct:0});}catch{rejected=true;}
   evidence.rejected=rejected;if(rejected)return;
   const updated=await snapshot(sale.sale_id);evidence.headerTotal=updated.expected_sale.total;evidence.linesTotal=updated.expected_items.reduce((n,i)=>n+Number(i.subtotal),0);evidence.stockAfterEdit=await stock(p.id);
   await call('sale_cancel',{...updated,reason});evidence.stockAfterCancel=await stock(p.id);
   assert.equal(evidence.headerTotal,evidence.linesTotal,'El total de la venta no coincide con sus líneas');assert.equal(evidence.stockAfterCancel.ceja,10,'La anulación no restituye el saldo inicial');
  });
  await test('El producto anterior al ensayo conserva todos sus campos',async()=>assert.deepEqual((await db.query("select * from products where item='ANTERIOR'")).rows,initial.rows));
  if(writeReport)fs.writeFileSync('test-artifacts/transaction-audit-fixed.json',JSON.stringify({environment:'PGlite local, migraciones 001–006, rol authenticated',realSupabaseWrites:false,results},null,2));
  if(log)console.log(JSON.stringify({passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length}));
  return results;
 }finally{await db.close();}
}
module.exports={runAudit:main};
if(require.main===module)main().then(results=>{if(results.some(r=>r.status==='FAIL'))process.exitCode=1;}).catch(e=>{console.error(e);process.exitCode=1;});
