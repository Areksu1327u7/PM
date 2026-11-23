/* Conexión administrativa local. Nunca usa ni imprime claves del frontend. */
const fs=require('node:fs'),path=require('node:path');
async function main(){
  const migration=process.argv[2]||'006_inventory_integrity.sql';
  if(!/^00[1-6]_[a-z_]+\.sql$/.test(migration))throw Error('Nombre de migración no permitido.');
  let connection=process.env.SUPABASE_DB_URL;
  const local=path.join(__dirname,'../.env.local');
  if(!connection&&fs.existsSync(local))connection=fs.readFileSync(local,'utf8').match(/^SUPABASE_DB_URL\s*=\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g,'');
  if(!connection)throw Error('Falta SUPABASE_DB_URL. Configure la conexión PostgreSQL del clon en .env.local o ejecute migrations/'+migration+' desde el panel. Una API key no es una conexión PostgreSQL.');
  const u=new URL(connection),ref='tgggakuinkbibqvvuvob';
  if(!['postgres:','postgresql:'].includes(u.protocol)||!(u.hostname==='db.'+ref+'.supabase.co'||(u.hostname.endsWith('.pooler.supabase.com')&&decodeURIComponent(u.username)==='postgres.'+ref)))throw Error('La conexión no identifica el clon autorizado. No se ejecutó SQL.');
  const {Client}=require('pg');const client=new Client({connectionString:connection,ssl:{rejectUnauthorized:true}});
  await client.connect();
  try {await client.query(fs.readFileSync(path.join(__dirname,'../migrations',migration),'utf8'));console.log('Migración instalada en el clon: '+migration+'; registros comerciales conservados.');}
  finally {await client.end();}
}
main().catch(e=>{console.error(e.message.replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[conexión omitida]'));process.exitCode=1;});
