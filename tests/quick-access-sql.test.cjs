const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite'),{randomUUID,randomBytes}=require('node:crypto');

test('008+009: un código por persona en todos sus equipos habilitados con contraseña',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
 grant usage on schema auth to anon,authenticated,service_role;grant execute on all functions in schema auth to anon,authenticated,service_role;`);
 await db.exec(fs.readFileSync('tests/transactions.test.cjs','utf8').match(/create table products[\s\S]*?(?=\n  `\);)/)[0]);
 await db.exec('create table roles_matrix(id bigint primary key,data_json jsonb);');
 for(const f of ['001_atomic_store.sql','002_movement_compatibility.sql','003_product_movement_history.sql','004_auth_roles.sql','005_reasons_profiles.sql','006_inventory_integrity.sql','007_performance.sql','008_quick_access.sql'])await db.exec(fs.readFileSync('migrations/'+f,'utf8'));
 const owner=randomUUID(),seller=randomUUID(),pending=randomUUID();
 await db.query("insert into auth.users values($1,'alexfloresbe@gmail.com',now(),null),($2,'seller@example.test',now(),null),($3,'pending@example.test',now(),null)",[owner,seller,pending]);
 // method: 'password' (ingreso con contraseña) u 'otp' (ingreso con código).
 async function as(id,sql,args=[],{role='authenticated',method='password'}={}){
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[id||'',JSON.stringify(id?{sub:id,amr:[{method,timestamp:1}]}:{})]);
  await db.exec('set role '+role);try{return (await db.query(sql,args)).rows[0]?.r;}finally{await db.exec('reset role');}
 }
 for(const id of [owner,seller,pending])await as(id,'select store_session() r');
 await as(owner,'select store_member_save($1,$2,true,1) r',[seller,'Vendedor']);
 const dev=()=>({id:randomUUID(),secret:randomBytes(32).toString('hex')});
 const pc1=dev(),pc2=dev(),pc3=dev();
 // Equipo habilitado con código creado según 008 (por equipo): debe pedir un código nuevo tras 009.
 await as(seller,'select store_pin_register($1,$2,$3) r',[pc1.id,pc1.secret,'2580']);
 const migration=fs.readFileSync('migrations/009_quick_access_any_device.sql','utf8');
 await db.exec(migration);await db.exec(migration);
 const trust=(id,d,method='password')=>as(id,'select store_device_trust($1,$2) r',[d.id,d.secret],{method});
 const register=(id,d,pin,method='password')=>as(id,'select store_pin_register($1,$2,$3) r',[d.id,d.secret,pin],{method});
 const check=(id,d,pin)=>as(null,'select store_pin_check($1,$2,$3,$4) r',[id,d.id,d.secret,pin],{role:'service_role'});

 await t.test('equipos de 008 se conservan, pero el código anterior ya no vale',async()=>{
  assert.deepEqual(await check(seller,pc1,'2580'),{ok:false,reason:'no_pin'});
 });

 await t.test('cualquier código de 4 números es válido; formato incorrecto y cuentas pendientes no',async()=>{
  for(const pin of ['123','12345','abcd',''])await assert.rejects(register(seller,pc1,pin),/4 números/);
  await assert.rejects(register(pending,pc1,'1234'),/no está autorizada/);
  assert.deepEqual(await register(seller,pc1,'1111'),{ok:true,trusted:true});
  assert.deepEqual(await check(seller,pc1,'1111'),{ok:true,email:'seller@example.test'});
  await register(seller,pc1,'1234');assert.equal((await check(seller,pc1,'1234')).ok,true);
 });

 await t.test('el mismo código sirve en otro equipo solo después de ingresar ahí con contraseña',async()=>{
  assert.deepEqual(await check(seller,pc2,'1234'),{ok:false,reason:'unknown'},'equipo nunca usado con contraseña');
  assert.deepEqual(await trust(seller,pc2,'otp'),{trusted:false,has_pin:true},'una sesión abierta con código no habilita equipos nuevos');
  assert.deepEqual(await check(seller,pc2,'1234'),{ok:false,reason:'unknown'});
  assert.deepEqual(await trust(seller,pc2),{trusted:true,has_pin:true});
  assert.deepEqual(await check(seller,pc2,'1234'),{ok:true,email:'seller@example.test'});
  assert.equal(await as(seller,'select store_pin_status($1,$2) r',[pc2.id,pc2.secret]),true);
  assert.equal(await as(seller,'select store_pin_status($1,$2) r',[pc3.id,pc3.secret]),false);
  assert.deepEqual(await check(seller,{...pc2,secret:'f'.repeat(64)},'1234'),{ok:false,reason:'unknown'});
 });

 await t.test('cambiar el código desde un equipo lo cambia en todos',async()=>{
  await register(seller,pc2,'0000','otp');
  assert.equal((await check(seller,pc1,'0000')).ok,true);assert.equal((await check(seller,pc2,'1234')).ok,false);
  await register(seller,pc1,'4321');
 });

 await t.test('5 errores sumando equipos desactivan el código; se crea de nuevo tras la contraseña',async()=>{
  assert.deepEqual(await check(seller,pc1,'9999'),{ok:false,reason:'pin',remaining:4});
  assert.deepEqual(await check(seller,pc2,'9999'),{ok:false,reason:'pin',remaining:3});
  assert.equal((await check(seller,pc1,'4321')).ok,true,'un acierto reinicia el contador');
  for(let i=4;i>=1;i--)assert.deepEqual(await check(seller,i%2?pc1:pc2,'9999'),{ok:false,reason:'pin',remaining:i});
  assert.deepEqual(await check(seller,pc1,'9999'),{ok:false,reason:'locked'});
  assert.deepEqual(await check(seller,pc2,'4321'),{ok:false,reason:'no_pin'},'ni el correcto funciona en ningún equipo');
  assert.deepEqual(await trust(seller,pc2),{trusted:true,has_pin:false});
  await register(seller,pc2,'4321');assert.equal((await check(seller,pc1,'4321')).ok,true);
 });

 await t.test('cuenta suspendida o bloqueada no ingresa ni consume intentos',async()=>{
  await as(owner,'select store_member_save($1,$2,false,2) r',[seller,'Vendedor']);
  assert.deepEqual(await check(seller,pc1,'4321'),{ok:false,reason:'inactive'});
  await as(owner,'select store_member_save($1,$2,true,3) r',[seller,'Vendedor']);
  await db.query("update auth.users set banned_until=now()+interval '1 day' where id=$1",[seller]);
  assert.deepEqual(await check(seller,pc1,'4321'),{ok:false,reason:'blocked'});
  await db.query('update auth.users set banned_until=null where id=$1',[seller]);
  assert.equal((await check(seller,pc1,'4321')).ok,true);
 });

 await t.test('permisos: nadie fuera de service_role verifica códigos ni lee tablas',async()=>{
  for(const role of ['anon','authenticated'])await assert.rejects(as(seller,'select store_pin_check($1,$2,$3,$4) r',[seller,pc1.id,pc1.secret,'4321'],{role}),/permission denied/);
  await assert.rejects(as(seller,'select count(*) r from store_private.quick_pins'),/permission denied/);
  await assert.rejects(as(null,'select store_device_trust($1,$2) r',[pc1.id,pc1.secret],{role:'anon'}),/permission denied/);
  const row=JSON.stringify((await db.query('select * from store_private.quick_pins')).rows);
  assert.ok(!row.includes('"4321"'),'el código no se guarda en claro');
 });

 await t.test('quitar un equipo no afecta a los demás',async()=>{
  assert.equal(await as(null,'select store_pin_forget($1,$2,$3) r',[seller,pc1.id,pc1.secret],{role:'anon'}),true);
  assert.deepEqual(await check(seller,pc1,'4321'),{ok:false,reason:'unknown'});
  assert.equal((await check(seller,pc2,'4321')).ok,true);
  assert.equal(await as(seller,'select store_pin_remove($1) r',[pc2.id]),true);
  assert.deepEqual(await check(seller,pc2,'4321'),{ok:false,reason:'unknown'});
  assert.equal((await as(null,'select store_health() r',[],{role:'anon'})).quick_access_v2,true);
 });
});
