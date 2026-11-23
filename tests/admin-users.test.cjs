const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {JSDOM,VirtualConsole}=require('jsdom'),{webcrypto}=require('node:crypto');
const wait=(ms=60)=>new Promise(r=>setTimeout(r,ms));
const OWNER='00000000-0000-4000-8000-000000000001',SELLER='00000000-0000-4000-8000-000000000002',PENDING='00000000-0000-4000-8000-000000000003',REQ='00000000-0000-4000-8000-000000000004';

function setup(t,{invoke=async()=>({data:{ok:true},error:null}),requests}={}){
 const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'http://localhost:4173/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:new VirtualConsole()});t.after(()=>dom.window.close());
 const w=dom.window,invokes=[],notices=[];
 Object.defineProperty(w,'crypto',{value:webcrypto});w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;
 w.setInterval=()=>1;w.confirm=()=>true;w.prompt=()=>'clave-nueva-segura-1';
 const session={user_id:OWNER,email:'alexfloresbe@gmail.com',active:true,owner:true,role:'Administrador',cache_key:'k',permissions:['access.manage']};
 const client={auth:{getUser:async()=>({data:{user:{id:OWNER}},error:null}),onAuthStateChange:()=>{},signOut:async()=>({error:null})},
  functions:{invoke:async(name,opts)=>{invokes.push({name,body:JSON.parse(JSON.stringify(opts.body))});return invoke(opts.body);}},
  rpc:async name=>{
   if(name==='store_public_catalog')return {data:[]};
   if(name==='store_health')return {data:{version:1,auth:true}};
   if(name==='store_session')return {data:structuredClone(session)};
   if(name==='store_settings_read')return {data:{data:{},version:1}};
   if(name==='store_profile_read')return {data:{alias:'',version:1}};
   if(name==='store_access_list')return {data:{roles:[{name:'Administrador',permissions:['access.manage'],version:1},{name:'Vendedor',permissions:[],version:1}],members:[
    {user_id:OWNER,email:'alexfloresbe@gmail.com',role:'Administrador',active:true,version:1,owner:true},
    {user_id:SELLER,email:'rosa@example.test',role:'Vendedor',active:true,version:2,owner:false},
    {user_id:PENDING,email:'pendiente@example.test',role:null,active:false,version:1,owner:false}]}};
   if(name==='store_access_requests')return requests??{data:[{user_id:REQ,email:'nuevo@example.test',requested_at:'2026-11-20T15:00:00Z',confirmed:false},{user_id:PENDING,email:'pendiente@example.test',requested_at:'2026-11-19T15:00:00Z',confirmed:true}]};
   throw Error('RPC inesperado: '+name);
  }};
 w.supabase={createClient:()=>client};
 const append=w.document.body.append.bind(w.document.body);w.document.body.append=el=>{if(el.tagName==='SCRIPT')queueMicrotask(()=>el.onload());else append(el);};
 for(const f of ['modules/experience.js','modules/access.js','modules/admin-users.js'])vm.runInContext(fs.readFileSync(f,'utf8'),dom.getInternalVMContext());
 w.Store={notice:(m,e)=>notices.push([m,!!e]),busy:new Set(),hasPending:()=>false};
 return {w,$:id=>w.document.getElementById(id),invokes,notices};
}

test('solicitudes visibles, aprobar con rol y lista de usuarios sin pendientes',async t=>{
 const {w,$,invokes,notices}=setup(t);await wait();await w.Access.renderAdmin();
 const rows=[...$('requestsBody').querySelectorAll('tr')];
 assert.equal(rows.length,2);assert.match(rows[0].textContent,/nuevo@example\.test/);assert.match(rows[0].textContent,/Sin confirmar/);
 assert.doesNotMatch($('membersBody').textContent,/pendiente@example/,'las solicitudes no se repiten en Usuarios');
 assert.equal($('membersBody').querySelectorAll('[data-password]').length,1,'no se ofrece cambiar la contraseña propia ni la del principal');
 rows[0].querySelector('select').value='Administrador';rows[0].querySelector('[data-approve]').click();await wait();
 assert.deepEqual(invokes[0],{name:'admin-users',body:{action:'approve',user_id:REQ,role:'Administrador'}});
 assert.match(notices.at(-1)[0],/aprobado/);
});

test('crear cuenta con correo, contraseña y rol; cambiar contraseña de un usuario',async t=>{
 const {w,$,invokes}=setup(t);await wait();await w.Access.renderAdmin();
 assert.deepEqual([...$('accountRole').options].map(o=>o.value),['Administrador','Vendedor']);assert.equal($('accountRole').value,'Vendedor');
 $('accountGenerate').click();assert.match($('accountPassword').value,/^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
 $('accountEmail').value='jorge@example.test';$('accountPassword').value='contraseña-larga-1';
 $('accountCreateForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await wait();
 assert.deepEqual(invokes[0].body,{action:'create',email:'jorge@example.test',password:'contraseña-larga-1',role:'Vendedor'});
 assert.match($('accountStatus').textContent,/jorge@example\.test/);
 $('membersBody').querySelector('[data-password]').click();await wait();
 assert.deepEqual(invokes.at(-1).body,{action:'password',user_id:SELLER,password:'clave-nueva-segura-1'});
});

test('errores claros: función no publicada, rechazo del servidor y migración faltante',async t=>{
 let answer={data:null,error:{name:'FunctionsHttpError',context:{status:404}}};
 const {w,$,notices}=setup(t,{invoke:async()=>answer});await wait();await w.Access.renderAdmin();
 $('requestsBody').querySelector('[data-approve]').click();await wait();
 assert.match(notices.at(-1)[0],/admin-users/);assert.equal(notices.at(-1)[1],true);
 answer={data:{ok:false,message:'Ya existe una cuenta con ese correo.'},error:null};
 $('accountEmail').value='rosa@example.test';$('accountPassword').value='contraseña-larga-1';
 $('accountCreateForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await wait();
 assert.match(notices.at(-1)[0],/Ya existe/);
 const missing=setup(t,{requests:{error:{message:'Could not find the function public.store_access_requests in the schema cache'}}});await wait();
 await missing.w.Access.renderAdmin();assert.match(missing.$('requestsBody').textContent,/010_admin_accounts/);
});
