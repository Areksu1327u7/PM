const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite'),{randomUUID}=require('node:crypto');
test('motivos y perfiles: integridad, identidad y permisos en PostgreSQL',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`);
 await db.exec(fs.readFileSync('tests/transactions.test.cjs','utf8').match(/create table products[\s\S]*?(?=\n  `\);)/)[0]);
 await db.exec('create table roles_matrix(id bigint primary key,data_json jsonb);');
 for(const f of ['001_atomic_store.sql','002_movement_compatibility.sql','003_product_movement_history.sql','004_auth_roles.sql'])await db.exec(fs.readFileSync('migrations/'+f,'utf8'));
 const old=(await db.query('select * from products')).rows;
 await db.exec(fs.readFileSync('migrations/005_reasons_profiles.sql','utf8'));
 const owner=randomUUID(),seller=randomUUID();
 await db.query("insert into auth.users values($1,'alexfloresbe@gmail.com',now(),null),($2,'seller@test.example',now(),null)",[owner,seller]);
 async function as(id,fn,role='authenticated'){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||'']);await db.exec('set role '+role);try{return await fn();}finally{await db.exec('reset role');}}
 const rpc=async(name,args=[])=> (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0]?.result;
 const commit=(action,payload,key=randomUUID())=>rpc('store_commit',[key,action,JSON.stringify(payload)]);
 const history=()=>db.query('select * from store_reversal_history(null)');
 await as(owner,()=>rpc('store_session'));await as(seller,()=>rpc('store_session'));
 await as(owner,()=>rpc('store_member_save',[seller,'Vendedor',true,1]));
 await t.test('la migración no modifica productos anteriores',async()=>assert.deepEqual((await db.query('select * from products')).rows,old));
 await t.test('perfil propio: alias validado, conflicto de versión y aislamiento',async()=>{
  await as(owner,async()=>{assert.equal((await rpc('store_profile_read')).version,0);await assert.rejects(rpc('store_profile_save',[' ',0]),/alias/);await assert.rejects(rpc('store_profile_save',['x'.repeat(51),0]),/alias/);assert.equal((await rpc('store_profile_save',[' Alex   Flores ',0])).alias,'Alex Flores');await assert.rejects(rpc('store_profile_save',['Otro',99]),/cambió/);});
  await as(seller,async()=>{assert.equal((await rpc('store_profile_read')).alias,'');await rpc('store_profile_save',['Vendedor',0]);await assert.rejects(db.query('select * from store_private.profiles'),/permission denied/);await assert.rejects(history(),/autorizado/);});
  await as(null,()=>assert.rejects(rpc('store_profile_read'),/permission denied/),'anon');
 });
 await as(owner,()=>commit('products_save',{products:[{id:null,changes:{item:'TEST-REASON',nombre:'Producto de prueba',ceja:10,senkata:10,precio:5}}]}));
 const pid=(await db.query("select id from products where item='TEST-REASON'")).rows[0].id;
 const stock=async()=>(await db.query('select ceja,senkata from products where id=$1',[pid])).rows[0];
 const sale=await as(owner,()=>commit('sale_create',{numero:'V-REASON',fecha:'2026-11-03',cliente:'Prueba',items:[{product_id:pid,cantidad:2,precio:5}]}));
 const snapshot={sale_id:sale.sale_id,expected_sale:(await db.query('select to_jsonb(s) data from sales s where id=$1',[sale.sale_id])).rows[0].data,expected_items:(await db.query('select to_jsonb(i) data from sales_items i where sale_id=$1 order by id',[sale.sale_id])).rows.map(r=>r.data)};
 await t.test('motivo obligatorio; anulación y auditoría idempotentes con identidad del servidor',async()=>{
  await as(owner,async()=>{
   for(const reason of [undefined,'','  ','abcd','x'.repeat(501),123])await assert.rejects(commit('sale_cancel',{...snapshot,reason}),/motivo/);
   assert.equal((await stock()).ceja,8);
   const key=randomUUID(),payload={...snapshot,reason:'Cliente solicita cancelar',actor_id:seller,actor_email:'falso@test.example'};
   await commit('sale_cancel',payload,key);await commit('sale_cancel',payload,key);
   await assert.rejects(commit('sale_cancel',{...payload,reason:'Motivo distinto'},key),/otros datos/);
   assert.equal((await stock()).ceja,10);const rows=(await history()).rows;assert.equal(rows.length,1);
   assert.equal(rows[0].actor_id,owner);assert.equal(rows[0].actor_email,'alexfloresbe@gmail.com');assert.equal(rows[0].actor_alias,'Alex Flores');assert.equal(rows[0].reference,'V-REASON');assert.equal(rows[0].products[0].cantidad,2);assert.ok(rows[0].created_at);
   await rpc('store_profile_save',['Alias nuevo',1]);assert.equal((await history()).rows[0].actor_alias,'Alex Flores');
  });
 });
 await as(owner,()=>commit('transfer',{fecha:'2026-11-03',items:[{product_id:pid,cantidad:3}]}));
 const mid=(await db.query("select id from movements where tipo='transfer' order by id desc limit 1")).rows[0].id;
 await t.test('si falla auditoría, no cambia stock ni confirma la reversión',async()=>{
  await db.exec("create function store_private.test_audit_failure() returns trigger language plpgsql as $$begin raise exception 'Fallo de auditoría simulado';end$$;create trigger test_fail before insert on store_private.operation_reasons for each row execute function store_private.test_audit_failure();");
  const before=await stock();await as(owner,()=>assert.rejects(commit('transfer_reverse',{movement_id:mid,reason:'Destino incorrecto'}),/auditoría/));assert.deepEqual(await stock(),before);
  await db.exec('drop trigger test_fail on store_private.operation_reasons');
 });
 await t.test('reversión registra producto, unidades, motivo y destino; paginación sin duplicados',async()=>{
  await as(owner,async()=>{
   await assert.rejects(commit('transfer_reverse',{movement_id:mid}),/motivo/);
   await commit('transfer_reverse',{movement_id:mid,reason:'Destino incorrecto'});
   const rows=(await history()).rows;assert.equal(rows.length,2);assert.equal(rows[0].products[0].cantidad,3);assert.equal(rows[0].products[0].destino,'SENKATA');assert.equal(rows[0].actor_alias,'Alias nuevo');
   const next=(await db.query('select * from store_reversal_history($1)',[rows[0].id])).rows;assert.equal(next.length,1);assert.equal(next[0].id,rows[1].id);
   await assert.rejects(db.query('delete from store_private.operation_reasons'),/permission denied/);
  });
  await as(seller,()=>assert.rejects(history(),/autorizado/));
  await as(null,()=>assert.rejects(history(),/permission denied/),'anon');
  assert.deepEqual((await db.query("select * from products where item='ANTERIOR'")).rows,old);
 });
});
