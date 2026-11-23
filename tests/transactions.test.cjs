const {test}=require('node:test');
const assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const fs=require('node:fs');
const {randomUUID}=require('node:crypto');
test('motor transaccional: existencias, historial, conflictos y rollback',async t=>{
  const db=new PGlite();
  await db.exec(`create role anon; create role authenticated;
    create table products(id bigint generated always as identity primary key,item text unique not null,nombre text not null,categoria text,ceja integer not null default 0,senkata integer not null default 0,unidad text not null default 'PCS',precio numeric(12,2) not null default 0);
    create table sales(id bigint generated always as identity primary key,numero text not null,fecha date not null,cliente text not null,subtotal numeric(14,2),descuento_pct numeric(12,2),descuento numeric(14,2),total numeric(14,2));
    create table sales_items(id bigint generated always as identity primary key,sale_id bigint references sales(id),item text,nombre text,cantidad integer,precio numeric(12,2),subtotal numeric(14,2));
    create table movements(id bigint generated always as identity primary key,tipo text check(tipo in ('ingreso','venta','transfer')),fecha date,item text,nombre text,cantidad integer check(cantidad>=0),detalle text,total numeric(14,2) check(total>=0),descuento numeric(12,2));
    insert into products(item,nombre,ceja,senkata,precio) values('ANTERIOR','No modificar',77,88,99);
  `);
  const original=(await db.query('select * from products')).rows;
  await db.exec(fs.readFileSync('migrations/001_atomic_store.sql','utf8'));
  const call=async(action,payload,key=randomUUID())=>(await db.query('select store_commit($1,$2,$3) result',[key,action,JSON.stringify(payload)])).rows[0].result;
  const stock=async id=>(await db.query('select * from products where id=$1',[id])).rows[0];
  const sale=async id=>(await db.query('select to_jsonb(s) x from sales s where id=$1',[id])).rows[0]?.x;
  const items=async id=>(await db.query('select to_jsonb(s) x from sales_items s where sale_id=$1 order by id',[id])).rows.map(r=>r.x);
  const before=async()=>JSON.stringify((await db.query(`select jsonb_build_object('p',(select jsonb_agg(p) from products p),'s',(select jsonb_agg(s) from sales s),'i',(select jsonb_agg(i) from sales_items i),'m',(select jsonb_agg(m) from movements m),'o',(select jsonb_agg(o) from store_operations o)) x`)).rows[0].x);
  let pid,pid2,sid;
  await t.test('la migración conserva registros anteriores',async()=>assert.deepEqual((await db.query('select * from products')).rows,original));
  await call('products_save',{products:[{id:null,changes:{item:'TEST-A',nombre:'Prueba A',ceja:10,senkata:20,precio:5}},{id:null,changes:{item:'TEST-B',nombre:'Prueba B',ceja:1,senkata:2,precio:7}}]});
  [pid,pid2]=(await db.query("select id from products where item like 'TEST-%' order by id")).rows.map(r=>r.id);
  await t.test('venta, descuento y reintento no duplicado',async()=>{
    const key=randomUUID(),payload={numero:'TEST-V1',fecha:'2026-10-29',cliente:'Prueba',descuento_pct:10,items:[{product_id:pid,cantidad:3,precio:5}]};
    const r=await call('sale_create',payload,key); sid=r.sale_id;
    assert.equal(r.total,13.5); assert.equal((await stock(pid)).ceja,7);
    assert.deepEqual(await call('sale_create',payload,key),r);assert.equal((await stock(pid)).ceja,7);
    await assert.rejects(call('sale_create',{...payload,cliente:'Otro'},key));
  });
  await t.test('falta de stock en segunda línea revierte la operación entera',async()=>{
    const b=await before();await assert.rejects(call('sale_create',{numero:'TEST-V2',fecha:'2026-10-29',cliente:'Prueba',items:[{product_id:pid,cantidad:2,precio:5},{product_id:pid2,cantidad:100,precio:7}]}));assert.equal(await before(),b);
  });
  await t.test('editar y retirar líneas devuelve exactamente lo vendido',async()=>{
    await call('sale_edit',{sale_id:sid,expected_sale:await sale(sid),expected_items:await items(sid),items:[{product_id:pid2,cantidad:1,precio:7}],descuento_pct:0});
    assert.equal((await stock(pid)).ceja,10);assert.equal((await stock(pid2)).ceja,0);assert.equal((await sale(sid)).total,7);
  });
  await t.test('anulación única y conservación de cabecera y detalle',async()=>{
    const payload={sale_id:sid,expected_sale:await sale(sid),expected_items:await items(sid)},key=randomUUID();
    await call('sale_cancel',payload,key);await call('sale_cancel',payload,key);
    assert.equal((await stock(pid2)).ceja,1);await assert.rejects(call('sale_cancel',payload));assert.ok(await sale(sid));assert.equal((await items(sid)).length,2);
  });
  await t.test('transferencia inválida no aplica líneas parciales',async()=>{
    const b=await before();await assert.rejects(call('transfer',{fecha:'2026-10-29',items:[{product_id:pid,cantidad:2},{product_id:pid2,cantidad:10}]}));assert.equal(await before(),b);
  });
  await t.test('transferencia y reversión conservan unidades y registro',async()=>{
    await call('transfer',{fecha:'2026-10-29',items:[{product_id:pid,cantidad:2}]});
    assert.equal((await stock(pid)).ceja,12); assert.equal((await stock(pid)).senkata,18);
    const mid=(await db.query("select id from movements where tipo='transfer' order by id desc limit 1")).rows[0].id;
    await call('transfer_reverse',{movement_id:mid});await assert.rejects(call('transfer_reverse',{movement_id:mid}));
    assert.equal((await stock(pid)).ceja,10);assert.equal((await stock(pid)).senkata,20);
    assert.equal((await db.query('select count(*) n from movements where id=$1',[mid])).rows[0].n,1);
  });
  await t.test('conflicto de edición no pisa stock reciente',async()=>{
    const p=await stock(pid);await call('transfer',{fecha:'2026-10-29',items:[{product_id:pid,cantidad:1}]});
    await assert.rejects(call('products_save',{products:[{id:pid,expected:p,changes:{nombre:'nuevo'}}]}));
    assert.equal((await stock(pid)).ceja,11);
  });
  await t.test('ingreso idempotente y costos conservados',async()=>{
    const payload={numero:'TEST-I',fecha:'2026-10-29',proveedor:'Prueba',items:[{item:'TEST-A',nombre:'Prueba A',cantidad:4,precioCompra:2,precioVenta:5}]},key=randomUUID();
    await call('receipt',payload,key);await call('receipt',payload,key);assert.equal((await stock(pid)).senkata,23);
    await assert.rejects(call('receipt',payload));
  });
  await t.test('validaciones y errores SQL no cambian registros',async()=>{
    for(const q of [-1,0,1.5]){const b=await before();await assert.rejects(call('sale_create',{numero:'BAD',fecha:'2026-10-29',cliente:'Prueba',items:[{product_id:pid,cantidad:q,precio:2}]}));assert.equal(await before(),b);}
    const b=await before();await assert.rejects(call('sale_create',{numero:'BAD',fecha:'2026-10-29',cliente:'Prueba',descuento_pct:101,items:[{product_id:pid,cantidad:1,precio:2}]}));assert.equal(await before(),b);
  });
  await t.test('datos anteriores permanecen intactos tras todas las pruebas',async()=>assert.deepEqual(await stock(1),original[0]));
  await t.test('edición válida de catálogo no altera existencias',async()=>{
    const p=(await db.query('select to_jsonb(p) x from products p where id=$1',[pid])).rows[0].x;
    await call('products_save',{products:[{id:pid,expected:p,changes:{nombre:'Prueba actualizada',precio:6}}]});
    assert.equal((await stock(pid)).ceja,p.ceja);assert.equal((await stock(pid)).senkata,p.senkata);
  });
  await t.test('no se renombra un ITEM con historial',async()=>{
    const p=(await db.query('select to_jsonb(p) x from products p where id=$1',[pid])).rows[0].x;
    await assert.rejects(call('products_save',{products:[{id:pid,expected:p,changes:{item:'RENOMBRADO'}}]}));
  });
  await t.test('solicitudes vacías y precios con precisión incompatible se rechazan',async()=>{
    await assert.rejects(call('sale_create',{numero:'EMPTY',fecha:'2026-10-29',cliente:'Prueba'}));
    await assert.rejects(call('products_save',{}));
    await assert.rejects(call('sale_create',{numero:'PRECISION',fecha:'2026-10-29',cliente:'Prueba',items:[{product_id:pid,cantidad:2,precio:1.005}]}));
  });
  await t.test('dos solicitudes compiten por la última unidad: solo una venta',async()=>{
    const results=await Promise.allSettled(['LAST-A','LAST-B'].map(numero=>call('sale_create',{numero,fecha:'2026-10-29',cliente:'Prueba',items:[{product_id:pid2,cantidad:1,precio:7}]})));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await stock(pid2)).ceja,0);
  });
  await t.test('una venta anulada no se edita aunque se obtenga un snapshot reciente',async()=>{
    const state=await before();
    await assert.rejects(call('sale_edit',{sale_id:sid,expected_sale:await sale(sid),expected_items:await items(sid),items:[{product_id:pid,cantidad:1,precio:5}],descuento_pct:0}),/anulada/);
    assert.equal(await before(),state);
  });
  await t.test('ingreso con error en la segunda linea no suma stock de la primera',async()=>{
    const state=await before();
    await assert.rejects(call('receipt',{numero:'TEST-INVALID-I',fecha:'2026-10-30',proveedor:'Prueba',items:[
      {item:'TEST-A',nombre:'Prueba A',cantidad:2,precioCompra:3,precioVenta:6},
      {item:'TEST-B',nombre:'Prueba B',cantidad:2,precioCompra:-1,precioVenta:7}
    ]}));
    assert.equal(await before(),state);
  });
  await t.test('duplicados dentro de un guardado nuevo revierten todo el catalogo',async()=>{
    const state=await before();
    await assert.rejects(call('products_save',{products:[
      {id:null,changes:{item:'TEST-DUPLICATE',nombre:'Uno',ceja:1,senkata:0,precio:1}},
      {id:null,changes:{item:'test-duplicate',nombre:'Dos',ceja:2,senkata:0,precio:2}}
    ]}),/duplicado/);
    assert.equal(await before(),state);
  });
  await db.close();
});
