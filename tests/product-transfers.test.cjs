const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

test('consulta de movimientos: páginas completas, filtro exacto y errores explícitos', async t => {
  const dom = new JSDOM('<div id="connectionStatus"></div>', { url: 'http://localhost', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window, requests = [];
  const rows = Array.from({ length: 1205 }, (_, id) => ({ id, item: 'TEST-HISTORY', tipo: 'transfer' }));
  let failure = null;
  w.supabase = {
    rpc(name, args) {
      if (name === 'store_health') return Promise.resolve({ data: { version: 1 } });
      requests.push({ name, args });
      return {
        order() { return this; },
        range(a, b) { return Promise.resolve(failure ? { error: failure } : { data: rows.slice(a, b + 1) }); }
      };
    },
    from(table) {
      assert.equal(table, 'movements');
      let selected = [...rows, { id: 2000, item: 'OTHER', tipo: 'transfer' }, { id: 2001, item: 'TEST-HISTORY', tipo: 'venta' }];
      return {
        select() { return this; },
        eq(k, v) { selected = selected.filter(r => r[k] === v); return this; },
        order() { return this; },
        range(a, b) { return Promise.resolve({ data: selected.slice(a, b + 1) }); }
      };
    }
  };
  require('./access-fixture.cjs')(w);
  vm.runInContext(fs.readFileSync('modules/store.js', 'utf8'), dom.getInternalVMContext());
  const result = await w.Store.productTransfers('TEST-HISTORY');
  assert.equal(result.rows.length, 1205);
  assert.equal(result.timestampAvailable, true);
  assert.ok(requests.every(r => r.name === 'store_product_transfers' && r.args.p_item === 'TEST-HISTORY'));
  failure = { code: 'PGRST202', message: 'Missing function' };
  const legacy = await w.Store.productTransfers('TEST-HISTORY');
  assert.equal(legacy.timestampAvailable, false);
  assert.equal(legacy.rows.length, 1205);
  failure = { code: '42501', message: 'Permission denied' };
  await assert.rejects(w.Store.productTransfers('TEST-HISTORY'), /Permission denied/);
  failure = { code: '', message: 'Failed to fetch' };
  await assert.rejects(w.Store.productTransfers('TEST-HISTORY'), /Failed to fetch/);
});
