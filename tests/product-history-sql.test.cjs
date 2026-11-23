const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');

test('SQL de historial: solo lectura, hora del diario y registros históricos intactos', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    create role anon; create role authenticated;
    create table movements(id bigint primary key,fecha date,item text,nombre text,cantidad integer,detalle text,tipo text);
    create table store_operations(operation_key uuid primary key,action text,created_at timestamptz,payload jsonb);
    insert into movements values
      (1,'2026-10-30','TEST-A','Prueba',4,'SENKATA → CEJA [MOV:11111111-1111-4111-8111-111111111111]','transfer'),
      (2,'2026-10-30','TEST-A','Prueba',4,'Reversión movimiento 1 [MOV:22222222-2222-4222-8222-222222222222]','transfer'),
      (3,'2026-10-29','TEST-A','Anterior',1,'SENKATA → CEJA','transfer'),
      (4,'2026-10-29','OTHER','Otro',1,'SENKATA → CEJA','transfer'),
      (5,'2026-10-29','TEST-A','Venta',1,'Venta comprobante V1','venta');
    insert into store_operations values
      ('11111111-1111-4111-8111-111111111111','transfer','2026-10-31T02:34:56Z','{"private":"no exponer"}'),
      ('22222222-2222-4222-8222-222222222222','transfer_reverse','2026-10-31T02:35:56Z','{}');
    revoke all on store_operations from public,anon,authenticated;
  `);
  const before = (await db.query('select * from movements order by id')).rows;
  const sql = fs.readFileSync('migrations/003_product_movement_history.sql', 'utf8');
  await db.exec(sql);
  await db.exec(sql);
  await db.exec('set role anon');
  const rows = (await db.query("select * from store_product_transfers('TEST-A')")).rows;
  assert.deepEqual(rows.map(r => r.id), [2, 1, 3]);
  assert.equal(rows[1].created_at.toISOString(), '2026-10-31T02:34:56.000Z');
  assert.equal(rows[2].created_at, null);
  assert.equal(Object.hasOwn(rows[0], 'payload'), false);
  await assert.rejects(db.query('select * from store_operations'), /permission denied/);
  assert.deepEqual((await db.query("select * from store_product_transfers('UNKNOWN')")).rows, []);
  await db.exec('reset role');
  assert.deepEqual((await db.query('select * from movements order by id')).rows, before);
});
