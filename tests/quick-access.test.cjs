const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {JSDOM,VirtualConsole}=require('jsdom'),{webcrypto}=require('node:crypto');
const wait=(ms=40)=>new Promise(r=>setTimeout(r,ms));
const DEVICE={device_id:'11111111-2222-4333-8444-555555555555',secret:'ab'.repeat(32)};
const SELLER={user_id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',email:'seller@example.test',alias:'Doña Rosa',last_used:1};

function setup(t,{remembered=[],invoke,user=null,hasPin=false}={}){
 const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'http://localhost:4173/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:new VirtualConsole()});t.after(()=>dom.window.close());
 const w=dom.window,calls=[],invokes=[],otps=[],events={};
 Object.defineProperty(w,'crypto',{value:webcrypto});w.TextEncoder=TextEncoder;w.TextDecoder=TextDecoder;
 w.setInterval=()=>1;w.confirm=()=>true;
 if(remembered.length)w.localStorage.setItem('mb_quick_access_v1',JSON.stringify({...DEVICE,accounts:remembered}));
 const state={user};
 const profile={user_id:SELLER.user_id,email:SELLER.email,active:true,owner:false,role:'Vendedor',cache_key:'k',permissions:['sales.read']};
 const client={
  auth:{getUser:async()=>({data:{user:state.user},error:null}),onAuthStateChange:fn=>{events.auth=fn;},signOut:async()=>({error:null}),
   signInWithPassword:async()=>{state.user={id:SELLER.user_id};return {error:null};},
   verifyOtp:async args=>{otps.push(args);state.user={id:SELLER.user_id};return {error:null};}},
  functions:{invoke:async(name,opts)=>{invokes.push({name,body:opts.body});return invoke(opts.body);}},
  rpc:async(name,args)=>{
   calls.push({name,args});
   if(name==='store_public_catalog')return {data:[]};
   if(name==='store_health')return {data:{version:1,auth:true,quick_access:true,quick_access_v2:true}};
   if(name==='store_profile_read')return {data:{alias:'Doña Rosa',version:1}};
   if(name==='store_session')return {data:structuredClone(profile)};
   if(name==='store_settings_read')return {data:{data:{},version:1}};
   if(name==='store_pin_register')return {data:{ok:true,trusted:true}};
   if(name==='store_pin_forget')return {data:true};
   if(name==='store_device_trust')return {data:{trusted:true,has_pin:hasPin}};
   if(name==='store_pin_status')return {data:true};
   throw Error('RPC inesperado: '+name);
  }};
 w.supabase={createClient:()=>client};
 const append=w.document.body.append.bind(w.document.body);w.document.body.append=el=>{if(el.tagName==='SCRIPT')queueMicrotask(()=>el.onload());else append(el);};
 for(const f of ['modules/experience.js','modules/access.js','modules/quick-access.js'])vm.runInContext(fs.readFileSync(f,'utf8'),dom.getInternalVMContext());
 const $=id=>w.document.getElementById(id);
 const press=keys=>{for(const k of keys)w.document.querySelector(`[data-key="${k}"]`).click();};
 return {w,$,calls,invokes,otps,events,press};
}

test('visitante sin cuentas recordadas: formulario normal, sin consultas adicionales',async t=>{
 const {$,calls}=setup(t,{invoke:()=>{throw Error('no debe llamarse');}});await wait();
 assert.equal($('quickPanel').hidden,true);assert.equal($('authForm').hidden,false);
 assert.deepEqual(calls.map(c=>c.name),['store_public_catalog']);
});

test('equipo recordado: elige persona, teclado de 4 números y sesión emitida por pin-login',async t=>{
 const {w,$,invokes,otps,events,press}=setup(t,{remembered:[SELLER],invoke:async()=>({data:{ok:true,token_hash:'hash-123'},error:null})});await wait();
 assert.equal($('authDialog').hidden,false,'la lista se abre al cargar la página');
 assert.equal($('authForm').hidden,true);assert.equal($('quickPick').hidden,false);
 assert.match($('quickAccounts').textContent,/Doña Rosa/);
 w.document.querySelector('.quick-person').click();
 assert.equal($('quickPinForm').hidden,false);assert.equal($('quickName').textContent,'Doña Rosa');
 press(['2','5','8']);assert.equal(invokes.length,0,'no envía antes de 4 números');
 press(['del','8','0']);await wait();
 assert.deepEqual(JSON.parse(JSON.stringify(invokes)),[{name:'pin-login',body:{user_id:SELLER.user_id,device_id:DEVICE.device_id,secret:DEVICE.secret,pin:'2580'}}]);
 assert.deepEqual(JSON.parse(JSON.stringify(otps)),[{token_hash:'hash-123',type:'magiclink'}]);
 assert.equal($('quickPin').value,'','el código no queda escrito');
 events.auth('SIGNED_IN');await wait(80);
 assert.equal(w.document.documentElement.dataset.access,'private');
});

test('código incorrecto informa intentos restantes; bloqueo retira la cuenta y pide contraseña',async t=>{
 let answer={data:{ok:false,reason:'pin',remaining:3},error:null};
 const {w,$,otps,press}=setup(t,{remembered:[SELLER],invoke:async()=>answer});await wait();
 w.document.querySelector('.quick-person').click();press(['1','3','5','7']);await wait();
 assert.match($('quickPinStatus').textContent,/Quedan 3 intentos/);assert.equal(otps.length,0);
 answer={data:{ok:false,reason:'locked'},error:null};
 press(['1','3','5','7']);await wait();
 assert.equal($('authForm').hidden,false);assert.equal($('authEmail').value,SELLER.email);
 assert.match($('authStatus').textContent,/contraseña/);
 assert.deepEqual(JSON.parse(w.localStorage.getItem('mb_quick_access_v1')).accounts,[]);
});

test('función no publicada: mensaje claro sin perder la cuenta recordada',async t=>{
 const {w,$,press}=setup(t,{remembered:[SELLER],invoke:async()=>({data:null,error:{name:'FunctionsHttpError',context:{status:404}}})});await wait();
 w.document.querySelector('.quick-person').click();press(['2','5','8','0']);await wait();
 assert.match($('quickPinStatus').textContent,/pin-login/);
 assert.equal(JSON.parse(w.localStorage.getItem('mb_quick_access_v1')).accounts.length,1);
});

test('tras ingresar con contraseña se ofrece crear el código y se recuerda la cuenta',async t=>{
 const {w,$,calls}=setup(t,{invoke:()=>{throw Error('no');}});await wait();
 $('authEmail').value=SELLER.email;$('authPassword').value='contraseña-larga-123';
 $('authForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await wait(120);
 assert.equal(w.document.documentElement.dataset.access,'private');
 assert.ok($('pinSetupDialog').open||$('pinSetupDialog').hasAttribute('open'),'se ofrece crear el código');
 assert.ok(calls.some(c=>c.name==='store_device_trust'),'ingresar con contraseña habilita el equipo');
 $('pinSetupPin').value='1234';$('pinSetupConfirm').value='1235';
 $('pinSetupForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await wait();
 assert.match($('pinSetupStatus').textContent,/no coinciden/);
 assert.equal(calls.filter(c=>c.name==='store_pin_register').length,0);
 $('pinSetupPin').value='1111';$('pinSetupConfirm').value='1111';
 $('pinSetupForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await wait();
 const reg=calls.find(c=>c.name==='store_pin_register');
 assert.equal(reg.args.p_pin,'1111','cualquier código de 4 números es válido');assert.match(reg.args.p_secret,/^[0-9a-f]{64}$/);
 const saved=JSON.parse(w.localStorage.getItem('mb_quick_access_v1'));
 assert.equal(saved.accounts[0].user_id,SELLER.user_id);assert.equal(saved.device_id,reg.args.p_device);
 assert.ok(!JSON.stringify(saved).includes('1111'),'el código no se guarda en el navegador');
 assert.equal($('quickProfileCard').hidden,false);assert.match($('quickProfileStatus').textContent,/Activo/);
});

test('PC nuevo de alguien que ya tiene código: al entrar con contraseña aparece en la lista sin pedir nada',async t=>{
 const {w,$,calls}=setup(t,{hasPin:true,invoke:()=>{throw Error('no');}});await wait();
 $('authEmail').value=SELLER.email;$('authPassword').value='contraseña-larga-123';
 $('authForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await wait(120);
 assert.ok(calls.some(c=>c.name==='store_device_trust'));
 assert.ok(!($('pinSetupDialog').open||$('pinSetupDialog').hasAttribute('open')),'no vuelve a pedir el código');
 const saved=JSON.parse(w.localStorage.getItem('mb_quick_access_v1'));
 assert.equal(saved.accounts[0].user_id,SELLER.user_id);
});

test('código desactivado o inexistente envía a la contraseña con un mensaje claro',async t=>{
 const {w,$,press}=setup(t,{remembered:[SELLER],invoke:async()=>({data:{ok:false,reason:'no_pin'},error:null})});await wait();
 w.document.querySelector('.quick-person').click();press(['9','9','9','9']);await wait();
 assert.equal($('authForm').hidden,false);assert.match($('authStatus').textContent,/todavía no tiene código/);
});
