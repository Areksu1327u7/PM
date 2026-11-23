const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {JSDOM}=require('jsdom');
const tick=()=>new Promise(r=>setTimeout(r,20));
function setup(t,admin=true){
 const dom=new JSDOM(fs.readFileSync('index.html','utf8'),{url:'http://localhost:4173/',runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());
 const w=dom.window,calls=[];
 w.Access={reversalReasons:true,can:()=>admin,rpc:async(name,args)=>{calls.push({name,args});if(name==='store_profile_read')return {alias:'Inicial',version:1};if(name==='store_profile_save')return {alias:args.p_alias.trim(),version:2};if(name==='store_reversal_history')return [{id:1,created_at:'2026-11-03T16:30:00Z',action:'sale_cancel',reference:'V1',products:[{item:'A',nombre:'<img src=x>',cantidad:2,destino:'CEJA'}],reason:'<script>privado</script>',actor_alias:'Alex',actor_email:'alex@example.test',actor_id:'uid'}];throw Error(name);}};
 w.Store={notice:()=>{}};vm.runInContext(fs.readFileSync('modules/experience.js','utf8'),dom.getInternalVMContext());
 return {w,d:w.document,calls};
}
test('carrusel navegable con teclado, sin temporizadores ni HTML de productos ejecutable',async t=>{
 const {w,d}=setup(t);await tick();w.Experience.catalog([{nombre:'<img src=x onerror=alert(1)>',categoria:'A',precio:5},{nombre:'Segundo',categoria:'B',precio:8}]);
 assert.equal(d.querySelector('#publicProducts img'),null);assert.equal(d.getElementById('catalogPosition').textContent,'1 / 2');
 d.getElementById('catalogNext').click();assert.match(d.getElementById('featuredProducts').textContent,/Segundo/);
 d.getElementById('featuredProducts').dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));assert.equal(d.getElementById('catalogPosition').textContent,'1 / 2');
 w.Experience.catalog([]);assert.equal(d.getElementById('catalogNext').disabled,true);
});
test('motivo obligatorio: valida espacios, permite cancelar y nunca envía una venta',async t=>{
 const {w,d,calls}=setup(t);await tick();const pending=w.Experience.requestReason('Anular V1','Devolver stock');
 d.getElementById('operationReason').value='     ';d.getElementById('operationReasonForm').dispatchEvent(new w.Event('submit',{cancelable:true}));
 assert.ok(d.getElementById('operationReasonDialog').hasAttribute('open'));
 d.getElementById('operationReason').value=' Cliente  solicita cancelar ';d.getElementById('operationReasonForm').dispatchEvent(new w.Event('submit',{cancelable:true}));
 assert.equal(await pending,'Cliente solicita cancelar');assert.equal(calls.length,0);
 const cancel=w.Experience.requestReason('Revertir','Devolver');d.getElementById('reasonCancel').click();assert.equal(await cancel,null);
 w.Access.reversalReasons=false;assert.equal(await w.Experience.requestReason('Revertir','Devolver'),null);
});
test('perfil conserva versión y auditoría muestra cuentas, motivos y productos como texto',async t=>{
 const {w,d,calls}=setup(t);await tick();await w.Experience.onSession();
 d.getElementById('profileAlias').value='Alex nuevo';d.getElementById('profileForm').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();
 assert.equal(calls.at(-1).args.p_version,1);assert.equal(d.getElementById('sessionAlias').textContent,'Alex nuevo');
 w.Experience.onSection('adminSection');await tick();assert.equal(d.querySelector('#auditBody script'),null);assert.equal(d.querySelector('#auditBody img'),null);
 assert.match(d.getElementById('auditBody').textContent,/alex@example.test/);assert.match(d.getElementById('auditBody').textContent,/2 unidades/);assert.match(d.getElementById('auditBody').textContent,/12:30/);
});
test('un vendedor no solicita el historial administrativo',async t=>{
 const {w,calls}=setup(t,false);await tick();w.Experience.onSection('adminSection');await tick();assert.equal(calls.length,0);
});
