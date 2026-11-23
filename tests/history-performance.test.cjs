const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {JSDOM}=require('jsdom');
function setup(t,tables,{cap=1000}={}){
  const dom=new JSDOM('<div id="connectionStatus"></div>',{url:'http://localhost',runScripts:'outside-only'});
  t.after(()=>dom.window.close());const w=dom.window,requests=[];
  require('./access-fixture.cjs')(w);
  w.supabase={rpc:async()=>({data:{version:1}}),from(table){
    const filters=[],orders=[];let columns='*';
    const q={select(value){columns=value;return q;},eq(k,v){filters.push([k,'eq',v]);return q;},gte(k,v){filters.push([k,'gte',v]);return q;},lte(k,v){filters.push([k,'lte',v]);return q;},lt(k,v){filters.push([k,'lt',v]);return q;},ilike(k,v){filters.push([k,'ilike',v]);return q;},order(k,{ascending=true}={}){orders.push([k,ascending]);return q;},async range(from,to){
      const rows=(tables[table]||[]).filter(row=>filters.every(([key,op,value])=>{
        if(op==='eq')return row[key]===value;if(op==='gte')return row[key]>=value;if(op==='lte')return row[key]<=value;if(op==='lt')return row[key]<value;
        let pattern='';for(let i=0;i<value.length;i++){let c=value[i];if(c==='\\'&&i+1<value.length)c=value[++i];else if(c==='%'){pattern+='.*';continue;}else if(c==='_'){pattern+='.';continue;}pattern+=c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
        return new RegExp('^'+pattern+'$','i').test(String(row[key]??''));
      })).sort((a,b)=>{for(const [k,asc] of orders){const order=a[k]<b[k]?-1:a[k]>b[k]?1:0;if(order)return asc?order:-order;}return 0;});
      const result=rows.slice(from,Math.min(to+1,from+cap));requests.push({table,columns,filters,from,to,returned:result.length});
      return {count:rows.length,data:structuredClone(result.map(row=>columns==='*'?row:Object.fromEntries(columns.split(',').map(k=>[k,row[k]]))))};
    }};return q;
  }};
  vm.runInContext(fs.readFileSync('modules/store.js','utf8'),dom.getInternalVMContext());return {w,requests};
}
test('10.000 ventas: primera página de 50, anulaciones y filtros se consultan en el servidor',async t=>{
  const tables={sales:Array.from({length:10000},(_,i)=>({id:i+1,fecha:'2026-11-01',numero:'V-'+(i+1),cliente:i%2?'Cliente A':'Cliente B',total:10})),movements:[{id:1,tipo:'venta',fecha:'2026-11-03',detalle:'Anulación comprobante V-10000'},...Array.from({length:5000},(_,i)=>({id:i+2,tipo:'ingreso',fecha:'2026-11-02',detalle:'Ingreso'}))]};
  const {w,requests}=setup(t,tables),before=JSON.stringify(tables);
  const page=await w.Store.salesHistory({desde:'2026-11-01',hasta:'2026-11-01',cliente:'Cliente A'},{size:50});
  assert.equal(page.count,5000);assert.equal(page.rows.length,50);assert.equal(page.rows[0].numero,'V-10000');assert.equal(page.rows[0].cancelled,true);
  assert.equal(requests.length,2);assert.equal(requests.reduce((n,r)=>n+r.returned,0),51);
  assert.ok(requests.filter(r=>r.table==='movements').every(r=>r.filters.some(f=>f[0]==='tipo'&&f[2]==='venta')));
  const second=await w.Store.salesHistory({cliente:'Cliente A'},{from:50,size:50});
  assert.equal(second.rows.length,50);assert.ok(!second.rows.some(r=>page.rows.some(p=>p.id===r.id)));
  assert.equal(JSON.stringify(tables),before);
});
test('total del periodo incluye páginas restantes y excluye anulaciones posteriores al rango',async t=>{
  const sales=Array.from({length:125},(_,i)=>({id:i+1,fecha:'2026-11-01',numero:'V-'+(i+1),cliente:'A',total:10,...(i===0?{estado:'anulada'}:{})}));
  const {w,requests}=setup(t,{sales,movements:[{id:1,tipo:'venta',fecha:'2026-11-03',detalle:'Anulación comprobante V-125'}]},{cap:37});
  assert.equal(await w.Store.salesHistoryTotal({hasta:'2026-11-01'}),1230);
  const page=await w.Store.salesHistory({}, {size:50});assert.equal(page.rows.length,50);assert.equal(page.count,125);
  requests.length=0;assert.equal(await w.Store.salesHistoryTotal({hasta:'2026-11-01'}),1230);assert.equal(requests.length,0,'el total reciente se reutiliza al paginar');
  sales[1].total=20;w.Store.invalidateReads();assert.equal(await w.Store.salesHistoryTotal({hasta:'2026-11-01'}),1240,'un guardado invalida el total anterior');
});
test('movimientos: días completos, paginación sin duplicados y reversión fuera del rango',async t=>{
  const movements=[];let id=0;
  for(let day=1;day<=30;day++)for(let i=0;i<(day===11?410:4);i++)movements.push({id:++id,tipo:'transfer',fecha:'2026-10-'+String(day).padStart(2,'0'),item:'SKU',nombre:'Producto',cantidad:2,total:0,detalle:'Transferencia'});
  const reversedId=movements.find(r=>r.fecha==='2026-10-12').id;
  movements.push({id:++id,tipo:'transfer',fecha:'2026-11-03',item:'SKU',cantidad:2,detalle:`Reversión movimiento ${reversedId} [MOV:abc]`});
  movements.push({id:++id,tipo:'ingreso',fecha:'2026-10-30',item:'SKU',cantidad:90,detalle:'Ingreso'});
  const {w,requests}=setup(t,{movements},{cap:37});
  const first=await w.Store.transferHistory({hasta:'2026-10-30'});
  assert.equal(new Set(first.rows.map(r=>r.fecha)).size,20);assert.equal(first.more,true);assert.equal(first.before,'2026-10-11');
  assert.equal(first.rows.filter(r=>r.fecha==='2026-10-11').length,410,'no se corta un día en el límite de descarga');
  const second=await w.Store.transferHistory({hasta:'2026-10-30',before:first.before});
  assert.equal(new Set(second.rows.map(r=>r.fecha)).size,10);assert.equal(second.more,false);
  assert.ok(!second.rows.some(r=>first.rows.some(p=>p.id===r.id)));
  assert.ok((await w.Store.transferReversals()).has(String(reversedId)));
  assert.ok(requests.every(r=>r.table==='movements'&&r.filters.some(f=>f[0]==='tipo'&&f[2]==='transfer')));
});
test('búsqueda literal de SKU y consultas sin permisos no acceden al servidor',async t=>{
  const {w,requests}=setup(t,{movements:[{id:1,tipo:'transfer',fecha:'2026-11-01',item:'A_1',detalle:''},{id:2,tipo:'transfer',fecha:'2026-11-01',item:'AX1',detalle:''}]});
  assert.equal((await w.Store.transferHistory({item:'A_1'})).rows.length,1);
  w.Access.require=()=>{throw Error('Sin permiso');};requests.length=0;
  await assert.rejects(w.Store.salesHistory({},{}),/Sin permiso/);await assert.rejects(w.Store.transferHistory(),/Sin permiso/);assert.equal(requests.length,0);
});
