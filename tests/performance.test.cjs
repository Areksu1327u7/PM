const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {JSDOM}=require('jsdom');
function setup(t){
 const dom=new JSDOM('<div id="connectionStatus"></div><div id="pendingOperations"></div>',{url:'http://localhost',runScripts:'outside-only'});t.after(()=>dom.window.close());
 const w=dom.window;require('./access-fixture.cjs')(w);return {w,dom};
}
test('lecturas concurrentes comparten una descarga, pero no objetos editables ni caché permanente',async t=>{
 const {w,dom}=setup(t);let reads=0;
 w.supabase={rpc:async()=>({data:{version:1}}),from:()=>({select(){return this;},order(){return this;},async range(start){reads++;await new Promise(r=>setTimeout(r,10));return {data:start?[]:[{id:1,ceja:4}]};}})};
 vm.runInContext(fs.readFileSync('modules/store.js','utf8'),dom.getInternalVMContext());
 const [a,b,c]=await Promise.all([w.Store.all('products'),w.Store.all('products'),w.Store.all('products')]);
 assert.equal(reads,2,'una página de datos y verificación del final para los tres consumidores');
 a[0].ceja=999;assert.equal(b[0].ceja,4);assert.equal(c[0].ceja,4);
 await w.Store.all('products');assert.equal(reads,4,'la próxima consulta vuelve a leer al servidor');
});
test('una respuesta anterior a un guardado no se reutiliza después de invalidar lecturas',async t=>{
 const {w,dom}=setup(t);let release,first=true,stock=5;
 w.supabase={rpc:async()=>({data:{version:1}}),from:()=>({select(){return this;},order(){return this;},range(start){if(start)return Promise.resolve({data:[]});if(first){first=false;return new Promise(r=>{release=()=>r({data:[{id:1,ceja:5}]});});}return Promise.resolve({data:[{id:1,ceja:stock}]});}})};
 vm.runInContext(fs.readFileSync('modules/store.js','utf8'),dom.getInternalVMContext());
 const before=w.Store.all('products');stock=3;w.Store.invalidateReads();
 const after=await w.Store.all('products');release();assert.equal(after[0].ceja,3);assert.equal((await before)[0].ceja,3);
});
test('archivos estáticos comprimidos y revalidados; HTML y secretos no se cachean',async t=>{
 const {createServer}=require('../scripts/serve.cjs');const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 const root='http://127.0.0.1:'+server.address().port;
 const first=await fetch(root+'/vendor/supabase.js');assert.equal(first.headers.get('content-encoding'),'gzip');
 const source=fs.readFileSync('vendor/supabase.js','utf8');assert.equal(await first.text(),source);assert.ok(Number(first.headers.get('content-length'))<Buffer.byteLength(source)*.5);
 const repeat=await fetch(root+'/vendor/supabase.js',{headers:{'If-None-Match':first.headers.get('etag')}});assert.equal(repeat.status,304);
 const html=await fetch(root+'/');assert.equal(html.headers.get('cache-control'),'no-store');await html.text();
 assert.equal((await fetch(root+'/.env.local')).status,403);assert.equal((await fetch(root+'/migrations/005_reasons_profiles.sql')).status,403);
 const plain=await fetch(root+'/interface.css',{headers:{'Accept-Encoding':'gzip;q=0'}});assert.equal(plain.headers.get('content-encoding'),null);await plain.text();
});
test('lectura completa con total: páginas en paralelo, sin huecos ni duplicados',async t=>{
 const {w,dom}=setup(t);const table=Array.from({length:1234},(_,i)=>({id:i+1,ceja:i}));let calls=0,inFlight=0,maxInFlight=0;
 w.supabase={rpc:async()=>({data:{version:1}}),from:()=>{let counted=false;return {select(_c,o){counted=!!o?.count;return this;},order(){return this;},async range(a,b){calls++;inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);await new Promise(r=>setTimeout(r,5));inFlight--;return {data:table.slice(a,b+1),count:counted?table.length:null};}};}};
 vm.runInContext(fs.readFileSync('modules/store.js','utf8'),dom.getInternalVMContext());
 const rows=await w.Store.all('products');
 assert.equal(rows.length,1234);assert.deepEqual(rows.map(r=>r.id),table.map(r=>r.id));
 assert.equal(calls,3,'primera página con total y dos más, sin consulta vacía final');assert.ok(maxInFlight>=2,'las páginas restantes se piden en paralelo');
});
test('catálogo de búsqueda se reutiliza brevemente y se descarta al guardar',async t=>{
 const {w,dom}=setup(t);let reads=0,stock=5;
 w.supabase={rpc:async()=>({data:{version:1}}),from:()=>({select(){return this;},order(){return this;},async range(start){if(!start)reads++;return {data:start?[]:[{id:1,item:'A',ceja:stock}]};}})};
 vm.runInContext(fs.readFileSync('modules/store.js','utf8'),dom.getInternalVMContext());
 assert.equal((await w.Store.catalog())[0].ceja,5);
 const copy=await w.Store.catalog();copy[0].ceja=999;
 assert.equal((await w.Store.catalog())[0].ceja,5,'cada consumidor recibe su copia');assert.equal(reads,1);
 stock=2;w.Store.invalidateReads();
 assert.equal((await w.Store.catalog())[0].ceja,2);assert.equal(reads,2);
 await w.Store.all('products');assert.equal(reads,3,'el inventario sigue leyendo siempre del servidor');
});
