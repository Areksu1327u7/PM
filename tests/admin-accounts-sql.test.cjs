const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite'),{randomUUID}=require('node:crypto');

test('010: solicitudes visibles, aprobación y permisos de administración',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,banned_until timestamptz,created_at timestamptz default now());
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql stable as $$select '{}'::jsonb$$;
 grant usage on schema auth to anon,authenticated,service_role;grant execute on all functions in schema auth to anon,authenticated,service_role;`);
 await db.exec(fs.readFileSync('tests/transactions.test.cjs','utf8').match(/create table products[\s\S]*?(?=\n  `\);)/)[0]);
 await db.exec('create table roles_matrix(id bigint primary key,data_json jsonb);');
 for(const f of fs.readdirSync('migrations').filter(f=>/^0(0[1-9]|10)_/.test(f)).sort()){const sql=fs.readFileSync('migrations/'+f,'utf8');await db.exec(sql);if(f.startsWith('010'))await db.exec(sql);}
 const owner=randomUUID(),admin=randomUUID(),seller=randomUUID(),unconfirmed=randomUUID(),pending=randomUUID();
 await db.query(`insert into auth.users(id,email,email_confirmed_at,created_at) values
  ($1,'alexfloresbe@gmail.com',now(),now()-interval '5 day'),($2,'admin2@example.test',now(),now()-interval '4 day'),
  ($3,'seller@example.test',now(),now()-interval '3 day'),($4,'nuevo@example.test',null,now()-interval '2 day'),($5,'pendiente@example.test',now(),now()-interval '1 day')`,[owner,admin,seller,unconfirmed,pending]);
 async function as(id,sql,args=[],role='authenticated'){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id||'']);await db.exec('set role '+role);try{return (await db.query(sql,args)).rows[0]?.r;}finally{await db.exec('reset role');}}
 for(const id of [owner,admin,seller,pending])await as(id,'select store_session() r');
 await as(owner,'select store_member_save($1,$2,true,1) r',[admin,'Administrador']);
 await as(owner,'select store_member_save($1,$2,true,1) r',[seller,'Vendedor']);
 const svc=(sql,args)=>as(null,sql,args,'service_role');

 await t.test('el administrador ve solicitudes con y sin correo confirmado; no ve cuentas activas',async()=>{
  const list=await as(owner,'select store_access_requests() r');
  assert.deepEqual(list.map(r=>[r.email,r.confirmed]),[['pendiente@example.test',true],['nuevo@example.test',false]]);
  assert.deepEqual((await as(admin,'select store_access_requests() r')).length,2);
  await assert.rejects(as(seller,'select store_access_requests() r'),/Acceso no autorizado/);
  await assert.rejects(as(null,'select store_access_requests() r',[],'anon'),/permission denied/);
 });

 await t.test('aprobar da rol y acceso; la solicitud desaparece',async()=>{
  assert.deepEqual(await svc('select store_admin_provision($1,$2,$3) r',[owner,unconfirmed,'Vendedor']),{ok:true});
  await db.query('update auth.users set email_confirmed_at=now() where id=$1',[unconfirmed]); // lo hace la Edge Function
  const s=await as(unconfirmed,'select store_session() r');
  assert.equal(s.active,true);assert.equal(s.role,'Vendedor');
  assert.deepEqual((await as(owner,'select store_access_requests() r')).map(r=>r.email),['pendiente@example.test']);
  assert.deepEqual(await svc('select store_admin_provision($1,$2,$3) r',[admin,pending,'Vendedor']),{ok:true},'otro administrador también puede aprobar');
  assert.deepEqual(await as(owner,'select store_access_requests() r'),[]);
 });

 await t.test('reglas: solo administradores, no a sí mismo, no al principal, rol válido',async()=>{
  const auth=(a,t,r)=>svc('select store_admin_authorize($1,$2,$3) r',[a,t,r]);
  assert.equal((await auth(seller,pending,'Vendedor')).ok,false);
  assert.match((await auth(admin,admin,null)).message,/propia/);
  assert.match((await auth(admin,owner,null)).message,/principal/);
  assert.match((await auth(owner,pending,'NoExiste')).message,/rol válido/);
  assert.equal((await auth(owner,seller,null)).ok,true);
  assert.equal((await svc('select store_admin_provision($1,$2,$3) r',[seller,pending,'Administrador'])).ok,false,'un vendedor no se da acceso a otros');
  assert.equal((await svc('select store_admin_provision($1,$2,$3) r',[admin,owner,'Vendedor'])).ok,false);
 });

 await t.test('solo service_role usa las funciones de administración',async()=>{
  for(const role of ['anon','authenticated']){
   await assert.rejects(as(owner,'select store_admin_provision($1,$2,$3) r',[owner,pending,'Vendedor'],role),/permission denied/);
   await assert.rejects(as(owner,'select store_admin_authorize($1,$2,$3) r',[owner,pending,null],role),/permission denied/);
  }
  await svc("select store_admin_audit($1,'member.create',$2) r",[owner,JSON.stringify({user:pending})]);
  await svc("select store_admin_audit($1,'otra.cosa',$2) r",[owner,'{}']);
  const actions=(await db.query("select action from store_private.security_audit where action like 'member.%' or action='otra.cosa'")).rows.map(r=>r.action);
  assert.ok(actions.includes('member.create')&&actions.includes('member.provision')&&!actions.includes('otra.cosa'));
 });
});
