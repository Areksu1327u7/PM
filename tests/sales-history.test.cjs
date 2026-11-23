const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

function setup(t) {
  const dom = new JSDOM(`
    <table id="ventasHistTabla"><tbody></tbody></table>
    <select id="ventasFiltroRango"><option>todo</option><option>hoy</option><option>semana</option><option>mes</option></select>
    <input type="date" id="ventasFiltroDesde"><input type="date" id="ventasFiltroHasta">
    <input id="ventasFiltroCliente"><div id="ventasTotalFooter"></div><div id="ventasHistPagination"></div>
  `, { url: 'http://localhost', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window, messages = [];
  w.Store = { date: () => '2026-01-01', salesHistory: async () => ({rows:[],count:0}), notice: message => messages.push(message) };
  w.allMovements = async () => [];
  w.onVerDetallesVenta = () => {};
  w.fmt = n => `Bs ${Number(n).toFixed(2)}`;
  w.escapeHtml = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  require('./access-fixture.cjs')(w);
  vm.runInContext(fs.readFileSync('modules/dashboard.js', 'utf8'), dom.getInternalVMContext());
  const app = fs.readFileSync('app.js', 'utf8');
  vm.runInContext(app.slice(app.indexOf('// Ventas: historial'), app.indexOf('async function onVerDetallesVenta')), dom.getInternalVMContext());
  return { w, d: w.document, messages };
}

test('fechas de ventas: fecha exacta, Bolivia, siete y treinta dias incluidos', async t => {
  const { w, d } = setup(t);
  d.getElementById('ventasFiltroDesde').value = '2026-10-30';
  d.getElementById('ventasFiltroHasta').value = '2026-10-30';
  assert.equal(w.getDateRange().desde, '2026-10-30');
  assert.equal(w.getDateRange().hasta, '2026-10-30');
  d.getElementById('ventasFiltroDesde').value = '';
  d.getElementById('ventasFiltroHasta').value = '';
  for (const [period, from] of [['hoy', '2026-01-01'], ['semana', '2025-12-26'], ['mes', '2025-12-03']]) {
    d.getElementById('ventasFiltroRango').value = period;
    const result = w.getDateRange();
    assert.equal(result.desde, from);
    assert.equal(result.hasta, '2026-01-01');
  }
  d.getElementById('ventasFiltroRango').value = 'todo';
  assert.equal(w.getDateRange().desde, null);
  d.getElementById('ventasFiltroDesde').value = '2026-02-01';
  d.getElementById('ventasFiltroHasta').value = '2026-01-01';
  await w.refreshVentasHistorial();
  assert.match(d.querySelector('tbody').textContent, /Desde.*Hasta/);
  assert.match(d.getElementById('ventasTotalFooter').textContent, /no disponible/i);
});

test('historial: una respuesta atrasada no sustituye el filtro mas reciente', async t => {
  const { w, d } = setup(t);
  let release, calls = 0;
  w.Store.salesHistory = () => ++calls === 1 ? new Promise(resolve => { release = rows=>resolve({rows,count:rows.length}); }) : Promise.resolve({count:1,rows:[
    { id: 2, numero: 'LATEST', fecha: '2026-01-01', cliente: 'Nuevo', total: 8 }
  ]});
  const old = w.refreshVentasHistorial();
  await w.refreshVentasHistorial();
  release([{ id: 1, numero: 'OLD', fecha: '2026-01-01', cliente: 'Anterior', total: 999 }]);
  await old;
  assert.match(d.querySelector('tbody').textContent, /LATEST/);
  assert.doesNotMatch(d.querySelector('tbody').textContent, /OLD/);
  assert.match(d.getElementById('ventasTotalFooter').textContent, /8.00/);
});

test('historial: errores de lectura no dejan un total anterior como vigente', async t => {
  const { w, d, messages } = setup(t);
  d.getElementById('ventasTotalFooter').textContent = 'Bs 900.00';
  w.Store.salesHistory = async () => { throw Error('Sin conexion'); };
  await w.refreshVentasHistorial();
  assert.match(d.querySelector('tbody').textContent, /Sin conexion/);
  assert.match(d.getElementById('ventasTotalFooter').textContent, /no disponible/i);
  assert.ok(messages.length > 0);
  assert.equal(d.getElementById('ventasHistTabla').hasAttribute('aria-busy'), false);
});

test('ventas visibles antes del total y navegación solicita solo la página siguiente',async t=>{
 const {w,d}=setup(t);const calls=[];let resolveTotal;
 w.Store.salesHistory=async(filters,options)=>{calls.push(options);return {count:120,rows:Array.from({length:50},(_,i)=>({id:options.from+i+1,numero:'V-'+(options.from+i+1),fecha:'2026-01-01',cliente:'Cliente',total:10,cancelled:i===0}))};};
 w.Store.salesHistoryTotal=()=>new Promise(r=>{resolveTotal=r;});
 await w.refreshVentasHistorial();assert.equal(d.querySelectorAll('tbody tr').length,50);
 assert.equal(d.querySelectorAll('.venta-anulada').length,1);assert.match(d.getElementById('ventasTotalFooter').textContent,/Calculando/);
 assert.equal(d.getElementById('ventasHistTabla').hasAttribute('aria-busy'),false);
 resolveTotal(1190);await Promise.resolve();assert.match(d.getElementById('ventasTotalFooter').textContent,/1190.00/);
 d.querySelector('[data-step="1"]').click();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls.at(-1).from,50);assert.equal(calls.at(-1).size,50);
 assert.match(d.querySelector('tbody').textContent,/V-51/);
});
