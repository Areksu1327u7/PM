// DOM aislado y API real del clon. Ningún localStorage del usuario se abre.
// El adaptador impide escribir sobre productos o ventas no creados por esta prueba.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {createHash}=require('node:crypto'),{JSDOM,VirtualConsole}=require('jsdom');
const source=fs.readFileSync('modules/access.js','utf8'),url=source.match(/const URL='([^']+)'/)[1],key=source.match(/const KEY='([^']+)'/)[1];
if(url!=='https://tgggakuinkbibqvvuvob.supabase.co')throw Error('Solo se permite el clon autorizado');
const tag='TEST-FORM-'+Date.now(),createdProducts=new Set(),createdSales=new Set(),createdQuotes=new Set(),alerts=[],errors=[];
const token=process.env.SUPABASE_TEST_ACCESS_TOKEN;
if(!token)throw Error('Falta SUPABASE_TEST_ACCESS_TOKEN de una cuenta de pruebas autorizada. Use test:security para verificación sin sesión y sin escrituras.');
if(JSON.parse(Buffer.from(token.split('.')[1],'base64url')).role!=='authenticated')throw Error('Se requiere una sesión de usuario, no una clave de servidor.');
async function rest(route,body){const r=await fetch(url+'/rest/v1/'+route,{method:body?'POST':'GET',headers:{apikey:key,Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});const data=await r.json();if(!r.ok)throw Error(data.message||String(r.status));return data;}
async function all(table){const out=[];for(;;){const rows=await rest(table+'?select=*&order=id&limit=500&offset='+out.length);if(!rows.length)return out;out.push(...rows);}}
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function query(table){
  const params=new URLSearchParams({select:'*'});let single=false;
  const q={select(){return q},eq(k,v){params.set(k,'eq.'+v);return q},ilike(k,v){params.set(k,'ilike.'+v);return q},gte(k,v){params.append(k,'gte.'+v);return q},lte(k,v){params.append(k,'lte.'+v);return q},in(k,values){params.set(k,'in.('+values.map(v=>'"'+String(v).replace(/"/g,'\\"')+'"').join(',')+')');return q},order(k,o={}){const v=k+(o.ascending===false?'.desc':'.asc');params.set('order',params.has('order')?params.get('order')+','+v:v);return q},limit(n){params.set('limit',n);return q},range(a,b){params.set('offset',a);params.set('limit',b-a+1);return q},maybeSingle(){single=true;return q},then(resolve,reject){return rest(table+'?'+params).then(rows=>({data:single?rows[0]||null:rows,error:null})).then(resolve,reject)}};
  return q;
}
const client={from:query,channel:()=>({on(){return this},subscribe(){return this}}),rpc:async(name,args)=>{
  if(name==='store_health')return {data:await rest('rpc/store_health',{}),error:null};
  if(name==='store_quote_save'){
    assert.ok(args.p_version===0||createdQuotes.has(args.p_id));
    const data=await rest('rpc/store_quote_save',args);createdQuotes.add(args.p_id);return {data};
  }
  assert.equal(name,'store_commit');const p=args.p_payload;
  if(args.p_action==='receipt')assert.ok(p.items.every(i=>i.item===tag));
  else if(['transfer','sale_create'].includes(args.p_action))assert.ok(p.items.every(i=>createdProducts.has(i.product_id)));
  else if(['sale_edit','sale_cancel'].includes(args.p_action)){assert.ok(createdSales.has(p.sale_id));if(p.items)assert.ok(p.items.every(i=>createdProducts.has(i.product_id)));}
  else throw Error('Escritura no autorizada por esta prueba: '+args.p_action);
  try{const data=await rest('rpc/store_commit',args);if(data.sale_id)createdSales.add(data.sale_id);return {data,error:null};}
  catch(e){return {data:null,error:{code:'P0001',message:e.message}};}
}};
async function main(){
  const health=await rest('rpc/store_health',{});assert.ok(health.revision>=2,'Instalar 002_movement_compatibility.sql');
  const tables=['products','sales','sales_items','movements','store_quotes'],baseline={};
  for(const t of tables)baseline[t]=new Map((await all(t)).map(r=>[r.id,hash(r)]));
  console.log('Snapshot de datos anteriores completo. Prueba: '+tag);
  const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
  const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'http://localhost:4173',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
  const w=dom.window,d=w.document;w.alert=x=>alerts.push(x);w.confirm=()=>true;w.setInterval=()=>1;w.supabase=client;require('../tests/access-fixture.cjs')(w);
  w.fetch=async()=>({ok:false,status:503,json:async()=>({})});w.HTMLCanvasElement.prototype.getContext=()=>({});w.Chart=class{destroy(){}constructor(_,c){this.data=c.data;}};w.HTMLElement.prototype.scrollIntoView=()=>{};
  const wait=async(predicate,label)=>{const end=Date.now()+60000;while(!predicate()){if(Date.now()>end)throw Error('Espera agotada: '+label+' '+alerts.join('; '));await new Promise(r=>setTimeout(r,100));}};
  const evaluate=code=>vm.runInContext(code,dom.getInternalVMContext());
  const set=(selector,value)=>{d.querySelector(selector).value=String(value);};
  const submit=async(id,scope)=>{d.getElementById(id).dispatchEvent(new w.Event('submit',{cancelable:true}));await wait(()=>!w.Store.busy.has(scope),id);if(alerts.length)throw Error(alerts.join('; '));};
  const getProduct=async()=> (await rest('products?select=*&item=eq.'+tag))[0];
  try{
    for(const file of ['modules/store.js','modules/dashboard.js','app.js','modules/cotizaciones.js'])evaluate(fs.readFileSync(file,'utf8'));
    await wait(()=>d.querySelector('.mov-item')&&d.querySelector('.ven-sku'),'inicio');
    set('#ingNum',tag+'-I');set('#ingFecha',w.Store.date());set('#ingProveedor','PRUEBA DE FORMULARIOS');
    for(const [selector,value] of Object.entries({'.ing-sku':tag,'.ing-nombre':'PRUEBA FORMULARIOS · conservar','.ing-cant':20,'.ing-pcomp':3,'.ing-pvent':5}))set(selector,value);
    await submit('formIngreso','receipt');let p=await getProduct();createdProducts.add(p.id);assert.equal(p.senkata,20);assert.equal(p.ceja,0);console.log('OK formulario: ingreso crea producto');
    set('#movFecha',w.Store.date());set('.mov-item',tag);set('.mov-cant',10);await submit('formMov','transfer');assert.equal((await getProduct()).ceja,10);console.log('OK formulario: transferencia');
    set('#venNum',tag+'-V');set('#venCliente','PRUEBA FORMULARIOS');set('#venFecha',w.Store.date());set('.ven-sku',tag);set('.ven-cant',2);set('.ven-pvent',5);set('#venDescPct',10);
    await submit('formVenta','sale');assert.equal((await getProduct()).ceja,8);console.log('OK formulario: venta con descuento');
    let sale=(await rest('sales?select=*&numero=eq.'+tag+'-V'))[0];assert.equal(Number(sale.total),9);
    await evaluate(`onVerDetallesVenta({currentTarget:{dataset:{saleId:${sale.id}}}})`);
    d.getElementById('ventaDetallesEditar').click();set('.edit-cant',1);d.getElementById('ventaDetallesGuardar').click();await wait(()=>!w.Store.busy.has('edit-sale'),'editar');assert.equal((await getProduct()).ceja,9);console.log('OK formulario: edición de venta');
    await evaluate(`onVerDetallesVenta({currentTarget:{dataset:{saleId:${sale.id}}}})`);
    d.getElementById('ventaDetallesAnular').click();await wait(()=>!w.Store.busy.has('cancel-sale'),'anular');assert.equal((await getProduct()).ceja,10);console.log('OK formulario: anulación');
    d.querySelector('[data-target=cotizacionSection]').click();await wait(()=>[...d.querySelectorAll('#cotDatalist option')].some(o=>o.value===tag),'catálogo cotizaciones');
    set('#cotCliente','PRUEBA COTIZACIÓN');set('.cot-item',tag);d.querySelector('.cot-item').dispatchEvent(new w.Event('change',{bubbles:true}));set('.cot-cant',3);set('.cot-precio',5);set('#cotDescPct',10);
    let printed=null;w.descargarComprobantePDF=async(tipo,options)=>{printed={tipo,options};};
    d.getElementById('cotImprimir').click();await wait(()=>printed,'impresión de cotización');assert.equal(printed.tipo,'cotizacion');assert.equal(printed.options.payload.total,13.5);assert.equal((await getProduct()).ceja,10);console.log('OK formulario: cotización imprimible sin afectar stock');
    d.getElementById('cotConvertir').click();await wait(()=>d.querySelector('.ven-sku')?.value===tag&&d.querySelector('.ven-cant')?.value==='3','convertir');
    await submit('formVenta','sale');assert.equal((await getProduct()).ceja,7);assert.ok((await all('store_quotes')).some(q=>createdQuotes.has(q.id)&&q.data.convertedAt));console.log('OK formulario: cotización convertida en venta');
    await evaluate('refreshVentasHistorial()');await evaluate('refreshMovimientosTable()');await evaluate('refreshDashboard()');
    assert.deepEqual(errors,[]);assert.deepEqual(alerts,[]);
    console.log('OK historial y dashboard. Registros de prueba conservados: '+tag);
  }finally{
    w.close();
    for(const t of tables){const after=new Map((await all(t)).map(r=>[r.id,hash(r)]));for(const [id,h] of baseline[t])assert.equal(after.get(id),h,'Cambió una fila anterior: '+t+' '+id);}
    console.log('Todas las filas anteriores permanecen intactas.');
  }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
