/* Solo se modifica información creada por esta ejecución, identificada TEST-AUTO.
   No elimina registros. Comprueba hashes de TODAS las filas anteriores al finalizar. */
const fs=require('node:fs'),assert=require('node:assert/strict'),{randomUUID,createHash}=require('node:crypto');
const source=fs.readFileSync('modules/access.js','utf8');
const url=source.match(/const URL='([^']+)'/)[1],key=source.match(/const KEY='([^']+)'/)[1];
if(url!=='https://tgggakuinkbibqvvuvob.supabase.co')throw Error('Pruebas permitidas únicamente en el clon autorizado.');
const token=process.env.SUPABASE_TEST_ACCESS_TOKEN;
if(!token)throw Error('Falta SUPABASE_TEST_ACCESS_TOKEN de una cuenta de pruebas autorizada. Use test:security para verificación sin sesión y sin escrituras.');
if(JSON.parse(Buffer.from(token.split('.')[1],'base64url')).role!=='authenticated')throw Error('Se requiere una sesión de usuario, no una clave de servidor.');
async function request(route,body){const r=await fetch(url+'/rest/v1/'+route,{method:body?'POST':'GET',headers:{apikey:key,Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});const data=await r.json();if(!r.ok)throw Error(data.message||'HTTP '+r.status);return data;}
async function all(table){const out=[];for(let offset=0;;offset+=500){const rows=await request(table+'?select=*&order=id&limit=500&offset='+offset);out.push(...rows);if(rows.length<500)return out;}}
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
async function main(){
  const health=await request('rpc/store_health',{});assert.equal(health.version,1);
  const tables=['products','sales','sales_items','movements'],baseline={};
  for(const name of tables)baseline[name]=new Map((await all(name)).map(r=>[r.id,hash(r)]));
  const tag='TEST-AUTO-'+Date.now();
  const call=(action,payload,id=randomUUID())=>request('rpc/store_commit',{p_key:id,p_action:action,p_payload:payload});
  const product=async()=> (await request('products?select=*&item=eq.'+tag))[0];
  const snapshot=async id=>({sale_id:id,expected_sale:(await request('sales?select=*&id=eq.'+id))[0],expected_items:await request('sales_items?select=*&order=id&sale_id=eq.'+id)});
  try {
    await call('products_save',{products:[{id:null,changes:{item:tag,nombre:'PRUEBA AUTOMÁTICA · conservar',ceja:10,senkata:20,precio:5,categoria:'PRUEBAS'}}]});
    const p=await product(),fecha=new Intl.DateTimeFormat('en-CA',{timeZone:'America/La_Paz',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const payload={numero:tag,fecha,cliente:'PRUEBA AUTOMÁTICA',descuento_pct:10,items:[{product_id:p.id,cantidad:3,precio:5}]},id=randomUUID();
    const sale=await call('sale_create',payload,id);await call('sale_create',payload,id);assert.equal((await product()).ceja,7);
    await assert.rejects(call('sale_create',{...payload,numero:tag+'-INVALIDA',items:[{product_id:p.id,cantidad:9999,precio:5}]}));assert.equal((await product()).ceja,7);
    await call('sale_edit',{...await snapshot(sale.sale_id),items:[{product_id:p.id,cantidad:2,precio:5}],descuento_pct:0});assert.equal((await product()).ceja,8);
    await call('sale_cancel',{...await snapshot(sale.sale_id),reason:'Anulación de prueba controlada'});assert.equal((await product()).ceja,10);
    await call('transfer',{fecha,items:[{product_id:p.id,cantidad:4}]});assert.equal((await product()).ceja,14);assert.equal((await product()).senkata,16);
    const mov=(await request('movements?select=*&item=eq.'+tag+'&tipo=eq.transfer&order=id.desc'))[0];
    await call('transfer_reverse',{movement_id:mov.id,reason:'Reversión de prueba controlada'});assert.equal((await product()).ceja,10);assert.equal((await product()).senkata,20);
    await call('receipt',{numero:tag+'-I',fecha,proveedor:'PRUEBA AUTOMÁTICA',items:[{item:tag,nombre:'PRUEBA AUTOMÁTICA',cantidad:2,precioCompra:3,precioVenta:5}]});assert.equal((await product()).senkata,22);
    await call('products_save',{products:[{id:null,changes:{item:tag+'-LAST',nombre:'PRUEBA ÚLTIMA UNIDAD · conservar',ceja:1,senkata:0,precio:5,categoria:'PRUEBAS'}}]});
    const last=(await request('products?select=*&item=eq.'+tag+'-LAST'))[0];
    const competing=await Promise.allSettled(['A','B'].map(suffix=>call('sale_create',{
      numero:tag+'-LAST-'+suffix,fecha,cliente:'PRUEBA CONCURRENCIA',descuento_pct:0,items:[{product_id:last.id,cantidad:1,precio:5}]
    })));
    assert.equal(competing.filter(r=>r.status==='fulfilled').length,1,'Solo una solicitud debe comprar la última unidad');
    assert.match(competing.find(r=>r.status==='rejected').reason.message,/Stock CEJA insuficiente/);
    assert.equal((await request('products?select=*&id=eq.'+last.id))[0].ceja,0);
    const winner=competing.find(r=>r.status==='fulfilled').value;
    await call('sale_cancel',{...await snapshot(winner.sale_id),reason:'Anulación de prueba controlada'});
    assert.equal((await request('products?select=*&id=eq.'+last.id))[0].ceja,1);
    console.log('Concurrencia real: una sola venta de la última unidad; anulación devuelve exactamente una unidad.');
    console.log('Pruebas remotas correctas. Registros nuevos conservados con prefijo '+tag);
  } finally {
    for(const name of tables){const after=new Map((await all(name)).map(r=>[r.id,hash(r)]));for(const [id,h] of baseline[name])assert.equal(after.get(id),h,'Una fila anterior cambió: '+name+' id '+id);}
    console.log('Verificado: todas las filas anteriores mantienen su contenido.');
  }
}
main().catch(e=>{console.error('No se completó la verificación: '+e.message);process.exitCode=1;});
