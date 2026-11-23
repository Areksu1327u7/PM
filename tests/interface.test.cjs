const {test}=require('node:test');const assert=require('node:assert/strict');const {JSDOM,VirtualConsole}=require('jsdom');const fs=require('node:fs');
const tick=()=>new Promise(r=>setTimeout(r,30));
test('interfaz: navegación, validaciones, venta, ingreso, movimientos y pendientes',async()=>{
  const html=fs.readFileSync('index.html','utf8'); const errors=[],alerts=[],calls=[],reads=[];
  const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM(html,{url:'http://localhost:4173/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
  const w=dom.window,d=w.document;
  w.alert=x=>alerts.push(x);w.confirm=()=>true;w.setInterval=()=>1;
  w.fetch=async()=>({ok:false,status:503,json:async()=>({})});
  w.HTMLCanvasElement.prototype.getContext=()=>({});
  w.Chart=class{destroy(){} update(){} constructor(_,config){this.data=config.data;}};
  w.HTMLElement.prototype.scrollIntoView=()=>{};
  const tables={products:[{id:1,item:'TEST-UI',nombre:'Producto <b>texto</b>',categoria:'Pruebas',ceja:20,senkata:30,unidad:'PCS',precio:5}],sales:[],sales_items:[],movements:[],roles_matrix:[]};
  function query(table){
    reads.push(table);
    let rows=structuredClone(tables[table]||[]),single=false;
    const q={select(){return q},eq(k,v){rows=rows.filter(r=>String(r[k])===String(v));return q},ilike(k,v){rows=rows.filter(r=>String(r[k]).toLowerCase().includes(v.replaceAll('%','').toLowerCase()));return q},gte(k,v){rows=rows.filter(r=>r[k]>=v);return q},lte(k,v){rows=rows.filter(r=>r[k]<=v);return q},in(k,v){rows=rows.filter(r=>v.includes(r[k]));return q},order(){return q},limit(n){rows=rows.slice(0,n);return q},range(a,b){rows=rows.slice(a,b+1);return q},maybeSingle(){single=true;return q},single(){single=true;return q},then(resolve){return Promise.resolve({data:single?(rows[0]||null):rows,error:null}).then(resolve)}};
    return q;
  }
  const client={from:query,channel:()=>({on(){return this},subscribe(){return this}}),rpc:async(name,p)=>{
    if(name==='store_health')return {data:{version:1},error:null};
    if(name==='store_quote_save'){const row=tables.store_quotes.find(q=>q.id===p.p_id);if(row){row.data=structuredClone(p.p_data);row.version++;return {data:row.version};}tables.store_quotes.push({id:p.p_id,data:structuredClone(p.p_data),version:1});return {data:1};}
    calls.push(structuredClone(p));
    if(p.p_action==='sale_create'){
      const x=p.p_payload,subtotal=x.items.reduce((a,i)=>a+i.precio*i.cantidad,0),descuento=subtotal*x.descuento_pct/100;
      const result={sale_id:1,numero:x.numero,subtotal,descuento,total:subtotal-descuento};
      tables.sales.push({id:1,numero:x.numero,fecha:x.fecha,cliente:x.cliente,subtotal,descuento,total:result.total});
      tables.sales_items.push(...x.items.map((i,n)=>({id:n+1,sale_id:1,item:'TEST-UI',nombre:'Producto <b>texto</b>',cantidad:i.cantidad,precio:i.precio,subtotal:i.cantidad*i.precio})));
      return {data:result,error:null};
    }
    if(p.p_action==='sale_edit')return {data:{sale_id:1,total:10},error:null};
    if(p.p_action==='receipt'||p.p_action==='transfer')return {data:{cantidad:1,total:10},error:null};
    throw Error('Acción inesperada en la prueba: '+p.p_action);
  }};
  w.supabase=client;require('./access-fixture.cjs')(w);
  const oldQuote={id:'ANTERIOR',numero:'C-ANTERIOR',createdAt:1,updatedAt:1,cliente:'Anterior',items:[{item:'TEST-UI',nombre:'Anterior',cantidad:1,precio:5}],subtotal:5,descuento:0,total:5};
  tables.store_quotes=[{id:oldQuote.id,data:oldQuote,version:1}];
  for(const file of ['modules/store.js','modules/dashboard.js','app.js','modules/cotizaciones.js'])require('node:vm').runInContext(fs.readFileSync(file,'utf8'),dom.getInternalVMContext(),{filename:file});
  await tick();await tick();
  assert.equal(calls.length,0,'abrir la app no escribe datos');
  assert.equal(reads.length,0,'abrir Inicio no carga catálogo, historiales ni dashboard');
  d.querySelector('[data-target=dashboardSection]').click();await tick();await tick();
  assert.equal(d.getElementById('kpiStockTotal').textContent,'50');
  d.querySelector('[data-dash-days="90"]').click();
  assert.equal(d.querySelector('[data-dash-days="90"]').getAttribute('aria-pressed'),'true');
  assert.equal(d.querySelector('[data-dash-days="30"]').getAttribute('aria-pressed'),'false');
  assert.equal(d.getElementById('dashError').hidden,true);
  d.getElementById('dashRefresh').click();await tick();
  assert.equal(calls.length,0,'filtrar y actualizar el panel no escribe datos');
  assert.equal(d.querySelector('#invTabla tbody b'),null,'los nombres se muestran como texto');
  for(const btn of d.querySelectorAll('.nav-btn')){btn.click();await tick();assert.equal(d.getElementById(btn.dataset.target).hidden,false);}
  d.querySelector('[data-target=realizarVentaSection]').click();await tick();
  d.getElementById('venCliente').value='Cliente de prueba';d.getElementById('venFecha').value='2026-10-29';d.getElementById('venNum').value='TEST-UI-V';
  d.querySelector('.ven-sku').value='TEST-UI';d.querySelector('.ven-cant').value='2';d.querySelector('.ven-pvent').value='5';
  d.getElementById('formVenta').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();await tick();
  assert.equal(calls.at(-1).p_action,'sale_create');assert.equal(calls.at(-1).p_payload.items[0].cantidad,2);
  assert.equal(d.getElementById('ventaComprobante').hidden,false);assert.match(d.getElementById('ventaComprobanteBody').textContent,/10.00/);
  assert.equal(d.getElementById('venGuardar').disabled,false);
  d.querySelector('[data-target=ventasHistSection]').click();
  // El filtro inicial depende del día del equipo; abrir directamente desde el id conocido.
  await require('node:vm').runInContext("onVerDetallesVenta({currentTarget:{dataset:{saleId:1}}})",dom.getInternalVMContext());
  d.getElementById('ventaDetallesEditar').click();
  const discountInput=d.getElementById('editDescPct');assert.ok(discountInput,'se conserva el campo de descuento');
  discountInput.value='15';discountInput.dispatchEvent(new w.Event('input',{bubbles:true}));
  assert.equal(d.getElementById('editDescPct'),discountInput,'recalcular no destruye el editor');
  assert.match(d.querySelector('.sale-totals-values').textContent,/8.50/);
  d.getElementById('ventaDetallesGuardar').click();await tick();assert.equal(calls.at(-1).p_action,'sale_edit');assert.equal(calls.at(-1).p_payload.descuento_pct,15);
  const n=calls.length;
  d.querySelector('.ven-sku').value='TEST-UI';d.querySelector('.ven-cant').value='-1';d.querySelector('.ven-pvent').value='5';
  d.getElementById('formVenta').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();assert.equal(calls.length,n);
  d.querySelector('[data-target=ingresoSection]').click();d.getElementById('ingNum').value='TEST-I';d.getElementById('ingFecha').value='2026-10-29';d.getElementById('ingProveedor').value='Prueba';
  for(const [selector,value] of Object.entries({'.ing-sku':'TEST-UI','.ing-nombre':'Prueba','.ing-cant':'2','.ing-pcomp':'3','.ing-pvent':'5'}))d.querySelector(selector).value=value;
  d.getElementById('formIngreso').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();assert.equal(calls.at(-1).p_action,'receipt');
  d.querySelector('[data-target=movSection]').click();d.getElementById('movFecha').value='2026-10-29';d.querySelector('.mov-item').value='TEST-UI';d.querySelector('.mov-cant').value='2';
  d.getElementById('formMov').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();assert.equal(calls.at(-1).p_action,'transfer');
  // Cotizar e imprimir no realiza escrituras comerciales ni cambia stock.
  d.querySelector('[data-target=cotizacionSection]').click();await tick();
  d.getElementById('cotCliente').value='Cliente de cotización';
  d.querySelector('.cot-item').value='TEST-UI';d.querySelector('.cot-item').dispatchEvent(new w.Event('change',{bubbles:true}));
  d.querySelector('.cot-cant').value='3';d.querySelector('.cot-precio').value='5';d.getElementById('cotDescPct').value='10';
  const printRequests=[],beforePrint=calls.length,realPDF=w.descargarComprobantePDF;
  w.descargarComprobantePDF=async(tipo,options)=>printRequests.push({tipo,options});
  d.getElementById('cotImprimir').click();await tick();
  d.getElementById('cotPDF').click();await tick();
  assert.equal(calls.length,beforePrint);assert.equal(printRequests[0].tipo,'cotizacion');assert.equal(printRequests[0].options.autoPrint,true);
  assert.equal(printRequests[1].options.autoPrint,false);assert.equal(printRequests[0].options.payload.total,13.5);
  assert.deepEqual(tables.store_quotes.find(c=>c.id==='ANTERIOR').data,oldQuote);
  d.querySelector('[data-action=print][data-id=ANTERIOR]').click();await tick();
  assert.match(printRequests.at(-1).options.payload.validaHasta,/VENCIDA/);
  // Generar con las bibliotecas reales para comprobar el PDF, no solo el evento.
  for(const file of ['vendor/jspdf.umd.min.js','vendor/jspdf.autotable.min.js'])require('node:vm').runInContext(fs.readFileSync(file,'utf8'),dom.getInternalVMContext(),{filename:file});
  const quotePayload=printRequests[0].options.payload;
  const doc=await realPDF('cotizacion',{payload:quotePayload,returnDocument:true});assert.ok(doc);assert.equal(doc.getNumberOfPages(),1);
  fs.mkdirSync('test-artifacts',{recursive:true});fs.writeFileSync('test-artifacts/cotizacion-prueba.pdf',Buffer.from(doc.output('arraybuffer')));
  const longPayload={...quotePayload,comprobante:{...quotePayload.comprobante,entidad:'Cliente con nombre extenso '.repeat(6)},items:Array.from({length:70},(_,i)=>({item:'TEST-'+i,nombre:'Producto de prueba con descripción detallada '+i,cantidad:3,precioVenta:5})),subtotal:1050,descuento:105,total:945};
  const longDoc=await realPDF('cotizacion',{payload:longPayload,returnDocument:true});assert.ok(longDoc.getNumberOfPages()>1);
  fs.writeFileSync('test-artifacts/cotizacion-multipagina.pdf',Buffer.from(longDoc.output('arraybuffer')));
  d.getElementById('cotConvertir').click();await tick();await tick();
  assert.equal(d.getElementById('realizarVentaSection').hidden,false);
  assert.equal(d.querySelector('.ven-cant').value,'3');
  d.getElementById('formVenta').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();await tick();
  assert.equal(calls.at(-1).p_action,'sale_create');assert.ok(tables.store_quotes.find(c=>c.id!=='ANTERIOR').data.convertedAt);
  assert.deepEqual(errors,[]);assert.equal(alerts.length,1,'solo se rechaza la cantidad negativa');
  dom.window.close();
});
