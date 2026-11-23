const {test}=require('node:test');const assert=require('node:assert/strict');const {JSDOM,VirtualConsole}=require('jsdom');const fs=require('node:fs');const vm=require('node:vm');
const tick=()=>new Promise(r=>setTimeout(r,30));

function boot(products){
  const errors=[],alerts=[],calls=[],notices=[];const state={failProducts:false};
  const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'http://localhost:4173/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
  const w=dom.window;
  w.alert=x=>alerts.push(x);w.confirm=()=>true;w.setInterval=()=>1;
  w.fetch=async()=>({ok:false,status:503,json:async()=>({})});
  w.HTMLCanvasElement.prototype.getContext=()=>({});
  w.Chart=class{destroy(){} update(){} constructor(_,c){this.data=c.data;}};
  w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.addEventListener('unhandledrejection',e=>errors.push('unhandled: '+(e.reason?.message||e.reason)));
  const tables={products,sales:[],sales_items:[],movements:[],roles_matrix:[]};
  const query=table=>{
    let rows=structuredClone(tables[table]||[]),single=false;
    const q={select(){return q},eq(k,v){rows=rows.filter(r=>String(r[k])===String(v));return q},ilike(){return q},gte(){return q},lte(){return q},in(){return q},order(){return q},limit(){return q},range(a,b){rows=rows.slice(a,b+1);return q},maybeSingle(){single=true;return q},single(){single=true;return q},
      then(resolve){if(state.failProducts&&state.blockAfterSave&&table==='products')return new Promise(()=>{});const fail=table==='products'&&state.failProducts;return Promise.resolve(fail?{data:null,error:{message:'sin conexión'}}:{data:single?(rows[0]||null):rows,error:null}).then(resolve)}};
    return q;
  };
  const client={from:query,channel:()=>({on(){return this},subscribe(){return this}}),rpc:async(name,p)=>{
    if(name==='store_health')return {data:{version:1},error:null};
    calls.push(structuredClone(p));
    if(p.p_action==='sale_create'){state.failProducts=true;return {data:{sale_id:9,numero:p.p_payload.numero,subtotal:10,descuento:0,total:10},error:null};}
    throw Error('Acción inesperada: '+p.p_action);
  }};
  w.supabase=client;require('./access-fixture.cjs')(w);
  for(const file of ['modules/store.js','modules/dashboard.js','app.js','modules/cotizaciones.js'])vm.runInContext(fs.readFileSync(file,'utf8'),dom.getInternalVMContext(),{filename:file});
  const realNotice=w.Store.notice;w.Store.notice=(m,e)=>{notices.push({m,e:!!e});return realNotice(m,e);};
  return {dom,w,d:w.document,errors,alerts,calls,notices,state};
}

test('venta: un fallo visual posterior al guardado no se presenta como venta fallida',async()=>{
  const t=boot([{id:1,item:'TEST-R',nombre:'Robusto',categoria:'P',ceja:5,senkata:0,unidad:'PCS',precio:5}]);
  await tick();await tick();
  const {d,w}=t;
  d.querySelector('[data-target=realizarVentaSection]').click();await tick();
  d.getElementById('venCliente').value='Cliente';d.getElementById('venFecha').value='2026-10-29';d.getElementById('venNum').value='TEST-R-V';
  d.querySelector('.ven-sku').value='TEST-R';d.querySelector('.ven-cant').value='2';d.querySelector('.ven-pvent').value='5';
  d.getElementById('formVenta').dispatchEvent(new w.Event('submit',{cancelable:true}));
  for(let i=0;i<5;i++)await tick();
  assert.equal(t.calls.filter(c=>c.p_action==='sale_create').length,1);
  assert.deepEqual(t.alerts,[],'no se muestra una alerta de error tras confirmar la venta');
  assert.ok(t.notices.some(n=>/TEST-R-V guardada/.test(n.m)),'se informa que la venta quedó guardada');
  assert.equal(d.getElementById('venGuardar').disabled,false);
  assert.deepEqual(t.errors,[]);
  t.dom.window.close();
});

test('venta confirmada libera el formulario aunque la recarga visual no responda',async()=>{
  const t=boot([{id:1,item:'TEST-FAST',nombre:'Prueba',ceja:5,senkata:0,precio:5}]);
  try{
    await tick();const {d,w}=t;t.state.blockAfterSave=true;
    d.querySelector('[data-target=realizarVentaSection]').click();await tick();
    for(const [id,value] of Object.entries({venCliente:'Prueba local',venFecha:'2026-11-03',venNum:'FAST-1'}))d.getElementById(id).value=value;
    d.querySelector('.ven-sku').value='TEST-FAST';d.querySelector('.ven-cant').value='2';d.querySelector('.ven-pvent').value='5';
    d.getElementById('formVenta').dispatchEvent(new w.Event('submit',{cancelable:true}));
    for(let i=0;i<8;i++)await tick();
    assert.equal(t.calls.length,1);assert.equal(w.Store.busy.has('sale'),false);
    assert.equal(d.getElementById('venGuardar').disabled,false);assert.equal(d.getElementById('ventaComprobante').hidden,false);
    assert.equal(d.querySelector('.ven-sku').value,'');assert.deepEqual(t.alerts,[]);
  }finally{t.dom.window.close();}
});

test('venta: ITEM ambiguo o respuesta atrasada no rompen la fila',async()=>{
  const t=boot([{id:1,item:'TEST-DUP',nombre:'Uno',ceja:1,senkata:0,precio:1},{id:2,item:'test-dup',nombre:'Dos',ceja:2,senkata:0,precio:2},{id:3,item:'TEST-OK',nombre:'Correcto',ceja:7,senkata:0,precio:9}]);
  await tick();await tick();
  const {d,w}=t;const sku=d.querySelector('.ven-sku');
  sku.value='Test-Dup';sku.dispatchEvent(new w.Event('change',{bubbles:true}));
  for(let i=0;i<3;i++)await tick();
  assert.ok(t.notices.some(n=>n.e&&/varios productos/.test(n.m)),'el error de ITEM ambiguo se muestra');
  assert.equal(d.querySelector('.ven-nombre').value,'');
  // Dos búsquedas seguidas: solo la última puede llenar la fila.
  sku.value='Test-Dup';sku.dispatchEvent(new w.Event('change',{bubbles:true}));
  sku.value='TEST-OK';sku.dispatchEvent(new w.Event('change',{bubbles:true}));
  for(let i=0;i<3;i++)await tick();
  assert.equal(d.querySelector('.ven-nombre').value,'Correcto');
  assert.equal(d.querySelector('.ven-ceja').value,'7');
  assert.deepEqual(t.errors,[]);assert.deepEqual(t.alerts,[]);
  t.dom.window.close();
});
