/* Solo lecturas. Nunca crea cuentas, ventas, productos ni movimientos. */
const fs=require('node:fs'),assert=require('node:assert/strict');
const source=fs.readFileSync('modules/access.js','utf8');
const url=source.match(/const URL='([^']+)'/)[1],key=source.match(/const KEY='([^']+)'/)[1];
if(url!=='https://tgggakuinkbibqvvuvob.supabase.co')throw Error('Solo se permite verificar el clon autorizado.');
async function request(path,body){const res=await fetch(url+'/rest/v1/'+path,{method:body?'POST':'GET',headers:{apikey:key,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});return {status:res.status,data:await res.json()};}
(async()=>{
 const health=await request('rpc/store_health',{});assert.equal(health.data.reversal_reasons,true,'Falta instalar 005_reasons_profiles.sql.');assert.equal(health.data.profiles,true);assert.equal(health.data.auth,true,'Falta instalar 004_auth_roles.sql. La base de datos todavía no confirma protección por roles.');
 assert.equal(health.data.inventory_integrity,true,'Falta instalar 006_inventory_integrity.sql. Las correcciones de inventario todavía no están confirmadas en Supabase.');
 for(const table of ['products','sales','sales_items','movements','roles_matrix','store_operations','store_roles','store_members','store_quotes']){
  const r=await request(table+'?select=*&limit=1');assert.ok([401,403].includes(r.status),'La tabla '+table+' no rechazó al visitante');
 }
 for(const rpc of ['store_access_list','store_legacy_archives','store_session','store_profile_read','store_reversal_history']){const r=await request('rpc/'+rpc,{});assert.ok([401,403].includes(r.status),'La función '+rpc+' no rechazó al visitante');}
 const catalog=await request('rpc/store_public_catalog',{});assert.equal(catalog.status,200);assert.ok(catalog.data.length<=12);for(const row of catalog.data)assert.deepEqual(Object.keys(row).sort(),['categoria','nombre','precio']);
 console.log('OK: tablas y funciones privadas inaccesibles sin sesión; catálogo público limitado. No se modificó ningún dato.');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
