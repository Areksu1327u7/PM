const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {JSDOM}=require('jsdom');

test('guardado bloqueado sin 006 e identificadores equivalentes rechazados antes del RPC',async t=>{
 const dom=new JSDOM('<div id="connectionStatus"></div><div id="pendingOperations"></div>',{url:'http://localhost',runScripts:'outside-only'});t.after(()=>dom.window.close());
 const w=dom.window,calls=[];require('./access-fixture.cjs')(w);w.Access.inventoryIntegrity=false;
 w.supabase={rpc:async(name,args)=>{if(name==='store_health')return {data:{version:1}};calls.push({name,args});return {data:{sale_id:1}};}};
 vm.runInContext(fs.readFileSync('modules/store.js','utf8'),dom.getInternalVMContext());
 await assert.rejects(w.Store.commit('sale_create',{numero:'NO-ENVIAR'}),/006_inventory_integrity/);
 assert.equal(calls.length,0);assert.equal(w.sessionStorage.length,0);
 w.Access.inventoryIntegrity=true;
 for(const alias of [7,'7','0007','+7',' 7 '])await assert.rejects(w.Store.commit('sale_edit',{sale_id:1,items:[{product_id:2,line_id:7,cantidad:1,precio:5},{product_id:2,line_id:alias,cantidad:1,precio:5}]}),/Línea repetida/);
 await assert.rejects(w.Store.commit('transfer_reverse',{movement_id:9007199254740992,reason:'Prueba de identificador'}),/identificador/);
 assert.equal(calls.length,0);assert.equal(w.sessionStorage.length,0);
});
test('reintentos inciertos conservan UUID; errores SQL no se confunden con guardados',async()=>{
  const dom=new JSDOM('<div id="connectionStatus"></div><div id="pendingOperations" hidden></div><button id="retryPending"></button>',{url:'http://localhost',runScripts:'outside-only'});
  const w=dom.window,keys=[];let lost=true;
  w.supabase={rpc:async(name,p)=>{
    if(name==='store_health')return {data:{version:1}};
    keys.push(p.p_key);
    if(lost){lost=false;return {error:{code:'',message:'Failed to fetch'}};}
    return {data:{sale_id:1,total:5}};
  }};
  require('./access-fixture.cjs')(w);
  vm.runInContext(fs.readFileSync('modules/store.js','utf8'),dom.getInternalVMContext());
  await assert.rejects(w.Store.commit('sale_create',{numero:'A'}));
  assert.equal(w.sessionStorage.length,1);
  await assert.rejects(w.Store.commit('sale_create',{numero:'B'}),/pendiente/);
  assert.deepEqual(await w.Store.commit('sale_create',{numero:'A'}),{sale_id:1,total:5});
  assert.equal(keys[0],keys[1]);assert.equal(w.sessionStorage.length,0);
  w.supabase.rpc=async()=>({error:{code:'P0001',message:'Stock insuficiente'}});
  await assert.rejects(w.Store.commit('sale_create',{numero:'C'}),/Stock/);assert.equal(w.sessionStorage.length,0);
  dom.window.close();
});
test('paginación completa más allá de mil filas y errores de lectura visibles',async()=>{
  const dom=new JSDOM('<div id="connectionStatus"></div>',{url:'http://localhost',runScripts:'outside-only'}),w=dom.window;
  const rows=Array.from({length:1205},(_,id)=>({id}));
  w.supabase={rpc:async()=>({data:{version:1}}),from:()=>({select(){return this},order(){return this},range(a,b){return Promise.resolve({data:rows.slice(a,b+1)})}})};
  require('./access-fixture.cjs')(w);
  vm.runInContext(fs.readFileSync('modules/store.js','utf8'),dom.getInternalVMContext());
  assert.equal((await w.Store.all('products')).length,1205);
  w.supabase.from=()=>({select(){return this},order(){return this},range(){return Promise.resolve({error:{message:'sin conexión'}})}});
  await assert.rejects(w.Store.all('products'),/sin conexión/);
  w.supabase.from=()=>({select(){return this},order(){return this},range(){return Promise.resolve({data:null,error:null});}});
  await assert.rejects(w.Store.all('products'),/Respuesta inválida/);
  dom.window.close();
});

test('confirmacion desconocida nunca elimina el UUID ni permite cambiar la accion',async t=>{
  const dom=new JSDOM('<div id="connectionStatus"></div><div id="pendingOperations" hidden></div>',{url:'http://localhost',runScripts:'outside-only'}),w=dom.window;
  t.after(()=>w.close());
  const calls=[];
  w.supabase={rpc:async(name,args)=>{
    if(name==='store_health')return {data:{version:1}};
    calls.push(args);return {data:null,error:null};
  }};
  require('./access-fixture.cjs')(w);
  vm.runInContext(fs.readFileSync('modules/store.js','utf8'),dom.getInternalVMContext());
  await assert.rejects(w.Store.commit('transfer',{items:[{product_id:1,cantidad:2}]},'same'),/confirmación/);
  const original=w.sessionStorage.getItem('mb_pending_v2:test-user:same');
  assert.ok(original);
  await assert.rejects(w.Store.commit('receipt',{items:[{product_id:1,cantidad:2}]},'same'),/pendiente/);
  assert.equal(calls.length,1);
  w.supabase.rpc=async(name,args)=>{calls.push(args);return {data:{cantidad:2,total:0}};};
  await w.Store.commit('transfer',{items:[{product_id:1,cantidad:2}]},'same');
  assert.equal(calls[0].p_key,calls[1].p_key);
  assert.equal(w.sessionStorage.length,0);
});

test('diario corrupto o almacenamiento bloqueado impiden enviar escrituras',async t=>{
  const dom=new JSDOM('<div id="connectionStatus"></div>',{url:'http://localhost',runScripts:'outside-only'}),w=dom.window;
  t.after(()=>w.close());
  let writes=0;
  w.supabase={rpc:async name=>{if(name==='store_health')return {data:{version:1}};writes++;return {data:{total:5}};}};
  require('./access-fixture.cjs')(w);
  vm.runInContext(fs.readFileSync('modules/store.js','utf8'),dom.getInternalVMContext());
  w.sessionStorage.setItem('mb_pending_v2:test-user:transfer','{"unexpected":true}');
  await assert.rejects(w.Store.commit('transfer',{}),/pendiente.*dañad/i);
  assert.equal(writes,0);
  assert.equal(w.sessionStorage.getItem('mb_pending_v2:test-user:transfer'),'{"unexpected":true}');
  w.sessionStorage.removeItem('mb_pending_v2:test-user:transfer');
  w.Storage.prototype.setItem=()=>{throw new w.DOMException('Quota exceeded','QuotaExceededError');};
  await assert.rejects(w.Store.commit('transfer',{}),/No se envió/);
  assert.equal(writes,0);
});

test('el cuerpo de una operacion se conserva aunque cambie el objeto original',async t=>{
  const dom=new JSDOM('<div id="connectionStatus"></div>',{url:'http://localhost',runScripts:'outside-only'}),w=dom.window;
  t.after(()=>w.close());
  let received,resolve;
  w.supabase={rpc:(name,args)=>{
    if(name==='store_health')return Promise.resolve({data:{version:1}});
    received=args;return new Promise(done=>{resolve=done;});
  }};
  require('./access-fixture.cjs')(w);
  vm.runInContext(fs.readFileSync('modules/store.js','utf8'),dom.getInternalVMContext());
  const payload={items:[{product_id:1,cantidad:2}]};
  const request=w.Store.commit('transfer',payload);
  payload.items[0].cantidad=99;
  await new Promise(r=>setImmediate(r));
  assert.equal(received.p_payload.items[0].cantidad,2);
  resolve({data:{cantidad:2,total:0}});
  await request;
});

test('fallo al limpiar el diario distingue una operacion ya confirmada',async t=>{
  const dom=new JSDOM('<div id="connectionStatus"></div>',{url:'http://localhost',runScripts:'outside-only'}),w=dom.window;
  t.after(()=>w.close());
  w.supabase={rpc:async name=>({data:name==='store_health'?{version:1}:{cantidad:1,total:0}})};
  require('./access-fixture.cjs')(w);
  vm.runInContext(fs.readFileSync('modules/store.js','utf8'),dom.getInternalVMContext());
  w.Storage.prototype.removeItem=()=>{throw Error('Storage unavailable');};
  await assert.rejects(w.Store.commit('transfer',{items:[{product_id:1,cantidad:1}]}),/ya se confirmó/);
  assert.ok(w.sessionStorage.getItem('mb_pending_v2:test-user:transfer'));
  assert.equal(w.Store.hasPending(),true);
});

test('confirmaciones incompletas o de otra accion conservan el UUID',async t=>{
  const dom=new JSDOM('<div id="connectionStatus"></div>',{url:'http://localhost',runScripts:'outside-only'}),w=dom.window;
  t.after(()=>w.close());
  let result={};
  w.supabase={rpc:async name=>({data:name==='store_health'?{version:1}:result})};
  require('./access-fixture.cjs')(w);
  vm.runInContext(fs.readFileSync('modules/store.js','utf8'),dom.getInternalVMContext());
  const cases=[
    ['sale_create',{total:5},{sale_id:1,total:5}],
    ['sale_edit',{sale_id:0},{sale_id:1}],
    ['sale_cancel',{sale_id:1,cancelled:false},{sale_id:1,cancelled:true}],
    ['transfer',{cantidad:1,total:'0'},{cantidad:1,total:0}],
    ['receipt',{cantidad:0,total:0},{cantidad:1,total:0}],
    ['transfer_reverse',{reversed:-1},{reversed:1}],
    ['products_save',{updated:0},{updated:1}]
  ];
  for(const [action,invalid,valid] of cases){
    result=invalid;
    await assert.rejects(w.Store.commit(action,['sale_cancel','transfer_reverse'].includes(action)?{reason:'Motivo de prueba'}:{}),/confirmación/);
    const slot='mb_pending_v2:test-user:'+action,original=w.sessionStorage.getItem(slot);
    result={};
    await assert.rejects(w.Store.commit(action,['sale_cancel','transfer_reverse'].includes(action)?{reason:'Motivo de prueba'}:{}),/confirmación/);
    assert.equal(w.sessionStorage.getItem(slot),original);
    result=valid;
    await w.Store.commit(action,['sale_cancel','transfer_reverse'].includes(action)?{reason:'Motivo de prueba'}:{});
    assert.equal(w.sessionStorage.getItem(slot),null);
  }
});

test('SQLSTATE de conexion o resultado incierto no permite inferir rollback',async t=>{
  const dom=new JSDOM('<div id="connectionStatus"></div>',{url:'http://localhost',runScripts:'outside-only'}),w=dom.window;
  t.after(()=>w.close());
  let code='08006';
  w.supabase={rpc:async name=>name==='store_health'?{data:{version:1}}:
    code?{error:{code,message:'Confirmacion incierta'}}:{data:{cantidad:1,total:0}}};
  require('./access-fixture.cjs')(w);
  vm.runInContext(fs.readFileSync('modules/store.js','utf8'),dom.getInternalVMContext());
  for(const unknown of ['08006','08007','40003','57P01','XX000','PGRST000']){
    code=unknown;
    await assert.rejects(w.Store.commit('transfer',{}),/incierta/);
    const original=w.sessionStorage.getItem('mb_pending_v2:test-user:transfer');
    assert.ok(original,unknown);
    code='';
    await w.Store.commit('transfer',{});
    assert.equal(w.sessionStorage.length,0);
  }
});
