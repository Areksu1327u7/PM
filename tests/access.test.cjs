const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {JSDOM,VirtualConsole}=require('jsdom'),{webcrypto}=require('node:crypto');
const wait=()=>new Promise(r=>setTimeout(r,40));
function setup(t,{user=null,health=true,active=true,recovery=false}={}){
 const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'http://localhost:4173/'+(recovery?'#type=recovery':''),runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:new VirtualConsole()});t.after(()=>dom.window.close());
 const w=dom.window,calls=[],scripts=[],events={},intervals=[];
 Object.defineProperty(w,'crypto',{value:webcrypto});w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;
 w.setInterval=fn=>{intervals.push(fn);return 1;};
 const profile={user_id:'seller-id',email:'seller@example.test',active,owner:false,role:'Vendedor',cache_key:'secret-server-key',permissions:['inventory.read','sales.read','sales.create','quotes.manage']};
 const client={auth:{getUser:async()=>({data:{user},error:null}),onAuthStateChange:fn=>{events.auth=fn;},signOut:async()=>({error:null})},rpc:async(name,args)=>{
  calls.push({name,args});
  if(name==='store_public_catalog')return {data:[{nombre:'<img src=x onerror=alert(1)>',categoria:'Prueba',precio:5}]};
  if(name==='store_health')return {data:{version:1,auth:health}};
  if(name==='store_profile_read')return {data:{alias:'',version:0}};
  if(name==='store_session')return {data:structuredClone(profile)};
  if(name==='store_settings_read')return {data:{data:{},version:1}};
  throw Error('RPC inesperado: '+name);
 }};
 w.supabase={createClient:()=>client};
 const append=w.document.body.append.bind(w.document.body);w.document.body.append=(el)=>{if(el.tagName==='SCRIPT'){scripts.push(el.getAttribute('src'));queueMicrotask(()=>el.onload());}else append(el);};
 vm.runInContext(fs.readFileSync('modules/experience.js','utf8'),dom.getInternalVMContext());
 vm.runInContext(fs.readFileSync('modules/access.js','utf8'),dom.getInternalVMContext());
 return {w,client,calls,scripts,events,intervals,profile};
}
test('visitante: solo catálogo, sin cargar módulos privados ni interpretar HTML',async t=>{
 const {w,calls,scripts}=setup(t);await wait();
 assert.equal(w.document.documentElement.dataset.access,'public');assert.deepEqual(scripts,[]);
 assert.deepEqual(calls.map(c=>c.name),['store_public_catalog']);
 assert.equal(w.document.querySelector('#publicProducts img'),null);assert.match(w.document.getElementById('publicProducts').textContent,/<img/);
 assert.throws(()=>w.Access.require('sales.create'),/permiso/);
});
test('sesión con migración ausente o cuenta pendiente permanece cerrada',async t=>{
 for(const opts of [{health:false},{active:false}]){
  const {w,scripts}=setup(t,{user:{id:'seller-id'},...opts});await wait();
  assert.equal(w.document.documentElement.dataset.access,'public');assert.deepEqual(scripts,[]);assert.ok(w.document.getElementById('authStatus').textContent);
 }
});
test('enlace de recuperación muestra cambio de contraseña sin arrancar área privada',async t=>{
 const {w,scripts}=setup(t,{user:{id:'seller-id'},recovery:true});await wait();
 assert.equal(w.document.getElementById('authNewPasswordForm').hidden,false);
 assert.equal(w.document.getElementById('authForm').hidden,true);
 assert.equal(w.document.documentElement.dataset.access,'public');assert.deepEqual(scripts,[]);
});
test('vendedor: menús por permisos, caché cifrada, cierre bloquea descifrado y revocación',async t=>{
 const {w,scripts,events,intervals,profile}=setup(t,{user:{id:'seller-id'}});await wait();
 assert.equal(w.document.documentElement.dataset.access,'private');assert.equal(scripts.length,4);
 assert.equal(w.document.querySelector('[data-target=realizarVentaSection]').disabled,false);
 assert.equal(w.document.querySelector('[data-target=dashboardSection]').disabled,true);
 assert.equal(w.document.getElementById('accessManagement').hidden,true);
 assert.throws(()=>w.Access.require('sales.cancel'),/permiso/);
 const encrypted=await w.Access.seal('{"cliente":"CONFIDENCIAL"}');assert.ok(!encrypted.includes('CONFIDENCIAL'));assert.equal(await w.Access.open(encrypted),'{"cliente":"CONFIDENCIAL"}');
 profile.active=false;await intervals[0]();assert.equal(w.document.documentElement.dataset.access,'public');assert.equal(w.document.getElementById('publicView').hidden,false);
 await assert.rejects(w.Access.open(encrypted),/sesión/);
 events.auth('SIGNED_OUT');assert.equal(w.Access.can('inventory.read'),false);
});

test('portada: un acceso discreto abre el diálogo; cerrar devuelve foco y borra contraseña',async t=>{
 const {w,calls}=setup(t);await wait();const d=w.document,dialog=d.getElementById('authDialog');
 assert.equal(dialog.hidden,true);assert.equal(dialog.open,false);
 assert.equal(d.querySelector('.login-rail'),null);
 assert.equal(d.querySelector('.public-heading button').textContent,'Iniciar sesión');
 d.getElementById('publicLogin').click();assert.equal(dialog.hidden,false);assert.equal(dialog.open,true);
 assert.equal(d.activeElement.id,'authEmail');d.getElementById('authPassword').value='test-password-only';
 dialog.dispatchEvent(new w.Event('cancel',{cancelable:true}));assert.equal(dialog.hidden,true);assert.equal(dialog.open,false);
 assert.equal(d.activeElement.id,'publicLogin');assert.equal(d.getElementById('authPassword').value,'');
 assert.deepEqual(calls.map(c=>c.name),['store_public_catalog']);
});
