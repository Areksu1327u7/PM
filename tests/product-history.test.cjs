const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');

test('lupa: ventas, movimientos, reversiones, horas y cambio rápido de producto', async t => {
  const dom = new JSDOM(fs.readFileSync('index.html', 'utf8'), {
    url: 'http://localhost:4173', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole()
  });
  t.after(() => dom.window.close());
  const w = dom.window, d = w.document;
  w.alert = message => assert.fail(message);
  w.setInterval = () => 1;
  w.fetch = async () => ({ ok: false });
  w.HTMLCanvasElement.prototype.getContext = () => ({});
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const tables = {
    products: [{ id: 1, item: 'TEST-A', nombre: 'Producto <b>A</b>', ceja: 10, senkata: 20 }, { id: 2, item: 'TEST-B', nombre: 'Segundo', ceja: 1, senkata: 2 }],
    sales: [{ id: 1, numero: 'V-1', fecha: '2026-10-30', cliente: '<img src=x onerror=alert(1)>' }, { id: 2, numero: 'V-2', fecha: '2026-10-29', cliente: 'Anulada', estado: 'anulada' }],
    sales_items: [{ id: 1, sale_id: 1, item: 'TEST-A', cantidad: 2, precio: 5, subtotal: 10 }, { id: 2, sale_id: 2, item: 'TEST-A', cantidad: 3, precio: 5, subtotal: 15 }],
    movements: [
      { id: 5, item: 'TEST-A', tipo: 'transfer', fecha: '2026-10-30', cantidad: 4, detalle: 'SENKATA → CEJA [MOV:abc]', created_at: '2026-10-31T02:34:56Z' },
      { id: 6, item: 'TEST-A', tipo: 'transfer', fecha: '2026-10-30', cantidad: 4, detalle: 'Reversión movimiento 5 [MOV:def]', created_at: '2026-10-31T02:35:56Z' },
      { id: 7, item: 'TEST-A', tipo: 'transfer', fecha: '2026-10-29', cantidad: 1, detalle: '<b>Detalle antiguo</b>' }
    ], roles_matrix: []
  };
  const before = JSON.stringify(tables);
  w.supabase = { createClient: () => ({ from(table) {
    let rows = structuredClone(tables[table] || []), single = false;
    const q = {
      select() { return q; }, eq(k, v) { rows = rows.filter(r => r[k] === v); return q; },
      ilike(k,v) { rows=rows.filter(r=>String(r[k]).toLowerCase().includes(v.replaceAll('%','').toLowerCase()));return q; },
      gte() { return q; }, lte() { return q; }, in() { return q; }, order() { return q; }, limit() { return q; },
      range(a, b) { rows = rows.slice(a, b + 1); return q; }, maybeSingle() { single = true; return q; },
      then(resolve) { return Promise.resolve({ data: single ? rows[0] : rows }).then(resolve); }
    };
    return q;
  }, channel: () => ({ on() { return this; }, subscribe() { return this; } }) }) };
  w.supabase=w.supabase.createClient();require('./access-fixture.cjs')(w);
  const context = dom.getInternalVMContext(), evaluate = code => vm.runInContext(code, context);
  evaluate(fs.readFileSync('modules/store.js', 'utf8'));
  evaluate(fs.readFileSync('app.js', 'utf8'));
  let release;
  w.Store.productTransfers = async item => ({ rows: tables.movements.filter(m => m.item === item), timestampAvailable: true });
  await evaluate("showProductoVentasModal('TEST-A')");
  assert.equal(d.getElementById('productoVentasModal').hidden, false);
  assert.equal(d.querySelector('#productoVentasBody img'), null);
  assert.match(d.getElementById('productoVentasBody').textContent, /<img src=x/);
  assert.equal(d.querySelectorAll('#productoVentasBody tr.venta-anulada').length, 1);
  assert.match(d.querySelector('#productoVentasBody tfoot').textContent, /10\.00/);
  await evaluate("showProductoVentasModal('TEST-A', 'movements')");
  assert.equal(d.getElementById('productoHistMovimientos').getAttribute('aria-pressed'), 'true');
  const text = d.getElementById('productoVentasBody').textContent;
  assert.match(text, /22:34:56/);
  assert.match(text, /Hora no registrada/);
  assert.match(text, /Revertido/);
  assert.match(text, /Reversión/);
  assert.equal(d.querySelector('#productoVentasBody b'), null);
  const first = d.querySelector('#productoVentasBody tbody tr');
  assert.equal(first.children[2].textContent, 'CEJA');
  assert.equal(first.children[3].textContent, 'SENKATA');
  await evaluate('refreshMovimientosTable()');
  assert.equal(evaluate("movHistFilteredData.find(g => g.fecha === '2026-10-30').cantidadTotal"), 0);
  w.Store.productTransfers = () => new Promise(resolve => { release = resolve; });
  const slow = evaluate("showProductoVentasModal('TEST-A', 'movements')");
  await new Promise(resolve => setTimeout(resolve, 10));
  await evaluate("showProductoVentasModal('TEST-B')");
  release({ rows: tables.movements, timestampAvailable: true });
  await slow;
  assert.match(d.getElementById('productoVentasTitulo').textContent, /Segundo/);
  assert.match(d.getElementById('productoVentasBody').textContent, /No hay ventas/);
  w.Store.productTransfers = async () => { throw Error('Consulta denegada'); };
  await evaluate("showProductoVentasModal('TEST-A', 'movements')");
  assert.match(d.getElementById('productoVentasBody').textContent, /Consulta denegada/);
  assert.equal(JSON.stringify(tables), before, 'las vistas no modifican datos');

  const movementRow = evaluate('newMovRow()'), movementItem = movementRow.querySelector('.mov-item'), quantity = movementRow.querySelector('.mov-cant');
  movementItem.value = 'TEST-A';
  movementItem.dispatchEvent(new w.Event('input'));
  movementItem.dispatchEvent(new w.Event('change'));
  movementItem.dispatchEvent(new w.Event('blur'));
  quantity.value = '4';
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(quantity.value, '4', 'resolver el producto no borra la cantidad escrita mientras cargaba');
  assert.equal(movementRow.dataset.item, 'TEST-A');
  movementItem.value = 'TEST-B';
  movementItem.dispatchEvent(new w.Event('input'));
  assert.equal(quantity.value, '', 'cambiar de producto limpia la cantidad anterior');
  assert.equal(quantity.hasAttribute('max'), false, 'el maximo anterior no afecta al nuevo producto');
  movementItem.dispatchEvent(new w.Event('change'));
  movementItem.value = 'TEST-A';
  movementItem.dispatchEvent(new w.Event('input'));
  movementItem.dispatchEvent(new w.Event('change'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(movementRow.dataset.item, 'TEST-A', 'las respuestas anteriores no seleccionan otro producto');
  const originalQuery = w.supabase.from;
  w.supabase.from = table => table === 'movements'
    ? { select() { return this; }, eq() { return this; }, limit() { return Promise.resolve({ error: { message: 'Sin permisos para confirmar anulaciones' } }); } }
    : originalQuery(table);
  await evaluate('onVerDetallesVenta({currentTarget:{dataset:{saleId:1}}})');
  assert.equal(d.getElementById('ventaDetallesModal').hidden, true, 'no permite operar con un estado de venta desconocido');
  assert.match(d.getElementById('appNotice').textContent, /Sin permisos/);
});
