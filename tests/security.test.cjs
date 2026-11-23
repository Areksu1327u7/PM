const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');
const {randomUUID}=require('node:crypto');
test('seguridad SQL: RLS, matriz, propietarios y acceso público',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to anon,authenticated;grant execute on function auth.uid() to anon,authenticated;`);
 const fixture=fs.readFileSync('tests/transactions.test.cjs','utf8').match(/create table products[\s\S]*?(?=\n  `\);)/)[0];await db.exec(fixture);
 await db.exec('create table roles_matrix(id bigint primary key,data_json jsonb);insert into roles_matrix values(1,\'{"previous":true}\');create view leaked_products as select * from products;grant select on leaked_products to anon;');
 for(const name of ['001_atomic_store.sql','002_movement_compatibility.sql','003_product_movement_history.sql'])await db.exec(fs.readFileSync('migrations/'+name,'utf8'));
 const prior=(await db.query('select * from products')).rows;
 await db.exec(fs.readFileSync('migrations/004_auth_roles.sql','utf8'));
 const owner=randomUUID(),seller=randomUUID(),pending=randomUUID(),unverified=randomUUID();
 for(const [id,email,confirmed] of [[owner,'alexfloresbe@gmail.com',true],[seller,'seller@example.test',true],[pending,'visitor@example.test',true],[unverified,'fake@example.test',false]])await db.query('insert into auth.users values($1,$2,$3,null)',[id,email,confirmed?'2026-11-02T00:00:00Z':null]);
 async function as(role,id,fn){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||'']);await db.exec('set role '+role);try{return await fn();}finally{await db.exec('reset role');}}
 const rpc=async(name,params=[])=> (await db.query(`select public.${name}(${params.map((_,i)=>'$'+(i+1)).join(',')}) result`,params)).rows[0]?.result;
 await t.test('conserva productos y matriz anterior; cierra tablas, vistas y RPC anónimos',async()=>{
   assert.deepEqual((await db.query('select * from products')).rows,prior);
   assert.equal((await db.query('select data_json from roles_matrix')).rows[0].data_json.previous,true);
   await as('anon',null,async()=>{
    for(const table of ['products','sales','sales_items','movements','store_operations','roles_matrix','store_members','store_roles','store_quotes','leaked_products'])await assert.rejects(db.query('select * from '+table),/permission denied/);
    await assert.rejects(rpc('store_commit',[randomUUID(),'products_save','{}']),/permission denied/);
    await assert.rejects(rpc('store_product_transfers',['ANTERIOR']),/permission denied/);
    const catalog=(await db.query('select * from store_public_catalog()')).rows;assert.deepEqual(Object.keys(catalog[0]).sort(),['categoria','nombre','precio']);assert.ok(catalog.length<=12);
   });
 });
 await t.test('cuenta sin verificar o pendiente no recibe permisos',async()=>{
   await as('authenticated',unverified,()=>assert.rejects(rpc('store_session'),/Verifique/));
   await as('authenticated',pending,async()=>{const s=await rpc('store_session');assert.equal(s.active,false);assert.deepEqual(s.permissions,[]);assert.equal((await db.query('select * from products')).rows.length,0);await assert.rejects(rpc('store_access_list'),/autorizado/);await assert.rejects(rpc('store_role_save',['Administrador',['access.manage'],1]),/autorizado/);});
 });
 await t.test('correo verificado inicializa propietario, autoriza vendedor y protege al propietario',async()=>{
   await as('authenticated',seller,()=>rpc('store_session'));
   await as('authenticated',owner,async()=>{
    assert.equal((await rpc('store_session')).owner,true);
    await rpc('store_member_save',[seller,'Vendedor',true,1]);
    await assert.rejects(rpc('store_member_save',[owner,'Vendedor',false,1]),/principal/);
    await assert.rejects(rpc('store_role_save',['Inseguro',['sales.create'],0]),/inventario/);
    await assert.rejects(rpc('store_role_save',['Inseguro',['unknown'],0]),/inválidos/);
   });
 });
 let saleKey=randomUUID();const payload={numero:'SEC-1',fecha:'2026-11-02',cliente:'Prueba local',items:[{product_id:1,cantidad:1,precio:99}]};
 await t.test('matriz atómica: un rol inválido revierte todo; configuración exige permiso',async()=>{
   await as('authenticated',owner,async()=>{
    await assert.rejects(rpc('store_roles_save',[JSON.stringify([{name:'Temporal',permissions:[],version:0},{name:'Inválido',permissions:['unknown'],version:0}])]),/inválidos/);
    assert.ok(!(await rpc('store_access_list')).roles.some(r=>r.name==='Temporal'));
    await rpc('store_settings_save',[JSON.stringify({brandName:'Prueba',coverageDays:15}),1]);
    await assert.rejects(rpc('store_settings_save',[JSON.stringify({brandName:'Otro',coverageDays:15}),1]),/cambió/);
   });
   await as('authenticated',seller,()=>assert.rejects(rpc('store_settings_save',[JSON.stringify({brandName:'No autorizado',coverageDays:1}),2]),/autorizado/));
 });
 await t.test('vendedor vende con reintento único; no altera roles, catálogo ni anula',async()=>{
   await as('authenticated',seller,async()=>{
    assert.equal((await db.query('select * from products')).rows.length,1);
    await assert.rejects(db.query("update products set precio=0"),/permission denied/);
    await assert.rejects(rpc('store_commit',[randomUUID(),'products_save','{}']),/autorizado/);
    await assert.rejects(rpc('store_commit',[randomUUID(),'sale_cancel','{}']),/autorizado/);
    await assert.rejects(db.query("select store_private.store_commit($1,'sale_cancel','{}')",[randomUUID()]),/permission denied/);
    const a=await rpc('store_commit',[saleKey,'sale_create',JSON.stringify(payload)]);const b=await rpc('store_commit',[saleKey,'sale_create',JSON.stringify(payload)]);assert.deepEqual(a,b);
    await assert.rejects(rpc('store_access_list'),/autorizado/);
   });
   assert.equal((await db.query('select ceja from products')).rows[0].ceja,76);
   await as('authenticated',owner,()=>assert.rejects(rpc('store_commit',[saleKey,'sale_create',JSON.stringify(payload)]),/otra sesión/));
 });
 await t.test('cotizaciones y archivos privados; conflicto de versión no sobrescribe',async()=>{
   const q={id:'Q1',items:[{item:'ANTERIOR',cantidad:1,precio:5}],cliente:'Privado'};
   await as('authenticated',seller,async()=>{assert.equal(await rpc('store_quote_save',['Q1',JSON.stringify(q),0]),1);await assert.rejects(rpc('store_quote_save',['Q1',JSON.stringify(q),9]),/cambió/);await assert.rejects(rpc('store_legacy_archives'),/autorizado/);});
   await as('authenticated',pending,async()=>{assert.equal((await db.query('select * from store_quotes')).rows.length,0);await assert.rejects(rpc('store_quote_save',['BAD',JSON.stringify(q),0]),/autorizado/);});
 });
 await t.test('revocación inmediata invalida JWT vigente y reintentos; auditoría conservada',async()=>{
   await as('authenticated',owner,()=>rpc('store_member_save',[seller,'Vendedor',false,2]));
   await as('authenticated',seller,async()=>{assert.equal((await db.query('select * from products')).rows.length,0);await assert.rejects(rpc('store_commit',[saleKey,'sale_create',JSON.stringify(payload)]),/autorizado/);});
   assert.ok((await db.query('select * from store_private.security_audit')).rows.length>=2);
 });
});
