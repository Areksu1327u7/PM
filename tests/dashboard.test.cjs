const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {JSDOM}=require('jsdom');
function setup(){const dom=new JSDOM('<html></html>',{runScripts:'outside-only'});vm.runInContext(fs.readFileSync('modules/dashboard.js','utf8'),dom.getInternalVMContext());return dom;}
test('dashboard: períodos completos, comparación exacta y anulaciones',()=>{
  const dom=setup(),{model}=dom.window.DashboardModel;
  const sales=[{numero:'1',fecha:'2026-10-30',total:90,descuento_pct:10},{numero:'2',fecha:'2026-10-24',total:30},{numero:'3',fecha:'2026-10-23',total:60},{numero:'4',fecha:'2026-10-17',total:20},{numero:'5',fecha:'2026-10-16',total:999},{numero:'6',fecha:'2026-10-31',total:999},{numero:'7',fecha:'2026-10-30',total:999,estado:'anulada'},{numero:'8',fecha:'2026-10-30',total:999}];
  const movements=[{detalle:'Anulación comprobante 8'},{tipo:'ingreso',fecha:'2026-10-30',total:40}];
  const m=model([{categoria:'A',ceja:0,senkata:3,precio:5}],movements,sales,'2026-10-30',7);
  assert.equal(m.total,120);assert.equal(m.before,80);assert.equal(m.change,50);assert.equal(m.ticket,60);
  assert.equal(m.dates.length,7);assert.equal(m.dates[0],'2026-10-24');assert.equal(m.buckets.get('2026-10-25').sales,0);
  assert.equal(m.todayReceipts,40);assert.equal(m.todaySales,90);assert.equal(m.stock,3);assert.equal(m.value,15);assert.equal(m.emptyCeja,1);
  dom.window.close();
});
test('dashboard: inicio de año y ausencia de base no inventan porcentajes',()=>{
  const dom=setup(),{model}=dom.window.DashboardModel;
  const m=model([],[],[{fecha:'2026-01-01',total:20}],'2026-01-01',90);
  assert.equal(m.dates.length,90);assert.equal(m.start,'2025-10-04');assert.equal(m.change,null);
  const empty=model([],[],[],'2026-10-30',30);assert.equal(empty.ticket,0);assert.equal(empty.total,0);assert.equal(empty.stock,0);
  dom.window.close();
});
test('documento: identificadores únicos y panel dentro del contenido principal',()=>{
  const dom=new JSDOM(fs.readFileSync('index.html','utf8')),d=dom.window.document;
  const ids=[...d.querySelectorAll('[id]')].map(n=>n.id);
  assert.equal(new Set(ids).size,ids.length,'no debe haber IDs duplicados');
  assert.ok(d.querySelector('main #dashboardSection'));
  assert.equal(d.querySelectorAll('#dashboardSection canvas').length,7);
  assert.equal(d.querySelectorAll('[data-dash-days]').length,3);
  assert.ok(!d.querySelector('#dashboardSection').textContent.includes('?'));
  dom.window.close();
});
