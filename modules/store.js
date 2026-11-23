/* Persistencia transaccional. No escribe al iniciar. */
window.Store = (() => {
  const busy = new Set();
  const reads = new Map();
  let historyTotal=null;
  let readEpoch = 0;
  // Memoria breve para consultas auxiliares. Cualquier guardado o cambio en tiempo real la borra.
  let catalogCache=null;
  const memo=new Map();
  const CATALOG_TTL=30000,MEMO_TTL=15000;
  function invalidateReads(){readEpoch++;reads.clear();historyTotal=null;catalogCache=null;memo.clear();}
  function remember(key,ttl,load){
    const hit=memo.get(key);
    if(hit&&hit.epoch===readEpoch&&hit.expires>Date.now())return hit.promise;
    const entry={epoch:readEpoch,expires:Date.now()+ttl,promise:load()};
    memo.set(key,entry);
    entry.promise.catch(()=>{if(memo.get(key)===entry)memo.delete(key);});
    return entry.promise;
  }
  const prefix = 'mb_pending_v2:' + Access.userId + ':';
  const money = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const date = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/La_Paz', year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date());
  function number(value, label, { integer = false, min = 0, max = Infinity } = {}) {
    const n = Number(value);
    if (value === '' || value == null || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isSafeInteger(n))) throw new Error(`${label}: valor inválido.`);
    return n;
  }
  async function all(table, configure) {
    const permission={products:'inventory.read',sales:'sales.read',sales_items:'sales.read',movements:Access.can('movements.read')?'movements.read':'sales.read',store_quotes:'quotes.manage'}[table];
    if(!permission) throw new Error('Consulta no admitida.');
    Access.require(permission);
    // Comparte únicamente lecturas idénticas en curso. No conserva stock en caché.
    if(configure) return readAll(table,configure);
    const epoch=readEpoch;
    let request=reads.get(table);
    if(!request){
      request=readAll(table,q=>q).finally(()=>{if(reads.get(table)===request)reads.delete(table);});
      reads.set(table,request);
    }
    const data=await request;
    Access.require(permission);
    if(epoch!==readEpoch)return all(table);
    // Una lectura completa y vigente del inventario también sirve para las búsquedas de ITEM.
    if(table==='products')catalogCache={epoch,expires:Date.now()+CATALOG_TTL,promise:Promise.resolve(data)};
    return structuredClone(data);
  }
  // Catálogo para búsquedas de ITEM, listas y resolución de IDs. Puede tener hasta 30 s;
  // el servidor vuelve a validar existencias y precios en cada guardado.
  async function catalog(){
    Access.require('inventory.read');
    if(!catalogCache||catalogCache.epoch!==readEpoch||catalogCache.expires<=Date.now()){
      const entry={epoch:readEpoch,expires:Date.now()+CATALOG_TTL,promise:all('products')};
      catalogCache=entry;
      entry.promise.catch(()=>{if(catalogCache===entry)catalogCache=null;});
    }
    return structuredClone(await catalogCache.promise);
  }
  const PAGE=500;
  async function readPage(table,configure,from,size,count){
    const {data,error,count:total}=await configure(window.supabase.from(table).select('*',count?{count:'exact'}:undefined)).order('id').range(from,from+size-1);
    if (error) throw new Error(`No se pudo cargar ${table}: ${error.message}`);
    if (!Array.isArray(data)) throw new Error(`Respuesta inválida al cargar ${table}. No se pueden confirmar los datos.`);
    return {data,total};
  }
  async function readAll(table,configure){
    // La primera página informa el total; las restantes se piden en paralelo.
    const first=await readPage(table,configure,0,PAGE,true);
    const rows=[...first.data];
    if(!rows.length)return rows;
    if(Number.isSafeInteger(first.total)&&rows.length<first.total){
      const stride=rows.length,starts=[];
      for(let from=stride;from<first.total;from+=stride)starts.push(from);
      for(let i=0;i<starts.length;i+=4){
        const pages=await Promise.all(starts.slice(i,i+4).map(from=>readPage(table,configure,from,stride)));
        for(const page of pages)rows.push(...page.data);
      }
    }
    if(Number.isSafeInteger(first.total)&&rows.length===first.total)return rows;
    // Sin total confiable se continúa secuencialmente hasta una página vacía.
    for (let from = rows.length; ;) {
      const {data}=await readPage(table,configure,from,PAGE);
      if (data.length === 0) break;
      rows.push(...data);
      from += data.length;
    }
    // Si la tabla cambió entre páginas, nunca se devuelve una fila dos veces.
    const seen=new Set();
    return rows.filter(r=>r?.id==null||(!seen.has(r.id)&&seen.add(r.id)));
  }
  async function productTransfers(item) {
    Access.require('movements.read');
    const rows = [];
    for (let from = 0; ;) {
      const { data, error } = await window.supabase.rpc('store_product_transfers', { p_item: item })
        .order('fecha', { ascending: false }).order('id', { ascending: false }).range(from, from + 499);
      if (error) {
        if (error.code === 'PGRST202') {
          return {
            rows: await all('movements', q => q.eq('item', item).eq('tipo', 'transfer')),
            timestampAvailable: false
          };
        }
        throw new Error(`No se pudieron cargar los movimientos: ${error.message}`);
      }
      if (!Array.isArray(data)) throw new Error('Respuesta inválida al cargar los movimientos.');
      if (data.length === 0) return { rows, timestampAvailable: true };
      rows.push(...data);
      from += data.length;
    }
  }
  // Historial: páginas del servidor y columnas mínimas, sin descargar inventario.
  async function historyRows(table, columns, configure, {from=0,size=50,complete=false}={}) {
    const permission=table==='sales'?'sales.read':Access.can('movements.read')?'movements.read':'sales.read';
    Access.require(permission);
    const epoch=readEpoch,rows=[];let count=null;
    do {
      const start=from+rows.length,limit=complete?500:Math.min(500,size-rows.length);
      const result=await configure(window.supabase.from(table).select(columns,{count:'exact'}))
        .order('fecha',{ascending:false}).order('id',{ascending:false}).range(start,start+limit-1);
      if(result.error)throw new Error('No se pudo cargar el historial: '+result.error.message);
      if(!Array.isArray(result.data))throw new Error('Respuesta inválida al cargar el historial.');
      if(Number.isSafeInteger(result.count))count=result.count;
      rows.push(...result.data);
      if(!result.data.length||(count!==null&&from+rows.length>=count))break;
    }while(complete||rows.length<size);
    Access.require(permission);
    if(epoch!==readEpoch)return historyRows(table,columns,configure,{from,size,complete});
    return {rows,count};
  }
  const salesFilter=({desde,hasta,cliente}={})=>q=>{
    if(desde)q=q.gte('fecha',desde);if(hasta)q=q.lte('fecha',hasta);
    if(cliente)q=q.ilike('cliente','%'+cliente.replace(/[\\%_]/g,'\\$&')+'%');return q;
  };
  async function cancellationNumbers(){
    const numbers=await remember('cancellations',MEMO_TTL,async()=>{
      const {rows}=await historyRows('movements','id,fecha,detalle',q=>q.eq('tipo','venta').ilike('detalle','Anulación comprobante %'),{complete:true});
      return rows.map(m=>m.detalle.slice('Anulación comprobante '.length));
    });
    return new Set(numbers);
  }
  async function salesHistory(filters,options){
    Access.require('sales.read');
    const epoch=readEpoch;
    const [page,cancelled]=await Promise.all([historyRows('sales','*',salesFilter(filters),options),cancellationNumbers()]);
    if(epoch!==readEpoch)return salesHistory(filters,options);
    return {...page,rows:page.rows.map(s=>({...s,cancelled:s.estado==='anulada'||cancelled.has(String(s.numero))}))};
  }
  async function salesHistoryTotal(filters){
    Access.require('sales.read');
    const signature=JSON.stringify(filters);
    if(historyTotal?.signature===signature&&historyTotal.expires>Date.now())return historyTotal.value;
    const epoch=readEpoch;
    // estado puede no existir en esquemas antiguos; no se inventa una columna.
    const [page,cancelled]=await Promise.all([historyRows('sales','*',salesFilter(filters),{complete:true}),cancellationNumbers()]);
    if(epoch!==readEpoch)return salesHistoryTotal(filters);
    const total=page.rows.reduce((total,s)=>total+(s.estado==='anulada'||cancelled.has(String(s.numero))?0:Number(s.total||0)),0);
    historyTotal={signature,value:total,expires:Date.now()+15000};
    return total;
  }
  async function transferHistory({desde,hasta,item,before,days=20,complete=false}={}){
    Access.require('movements.read');
    const epoch=readEpoch,rows=[];let from=0,more=false;
    const configure=q=>{
      q=q.eq('tipo','transfer');if(desde)q=q.gte('fecha',desde);if(hasta)q=q.lte('fecha',hasta);
      if(before)q=q.lt('fecha',before);if(item)q=q.ilike('item','%'+item.replace(/[\\%_]/g,'\\$&')+'%');return q;
    };
    while(true){
      const page=await historyRows('movements','id,tipo,fecha,item,nombre,cantidad,total,detalle',configure,{from,size:300});
      rows.push(...page.rows);from+=page.rows.length;
      const dates=[...new Set(rows.map(r=>r.fecha))];
      if(!complete&&dates.length>days){const cutoff=dates[days-1];rows.splice(rows.findIndex(r=>r.fecha<cutoff));more=true;break;}
      if(!page.rows.length||(page.count!==null&&from>=page.count))break;
    }
    Access.require('movements.read');
    if(epoch!==readEpoch)return transferHistory({desde,hasta,item,before,days,complete});
    return {rows,more,before:rows.at(-1)?.fecha??null};
  }
  async function transferReversals(){
    Access.require('movements.read');
    const ids=await remember('reversals',MEMO_TTL,async()=>{
      const {rows}=await historyRows('movements','id,fecha,detalle',q=>q.eq('tipo','transfer').ilike('detalle','Reversión movimiento %'),{complete:true});
      return rows.map(m=>String(m.detalle).match(/^Reversión movimiento (\d+)/)?.[1]).filter(Boolean);
    });
    return new Set(ids);
  }
  async function readPending(slot) {
    let raw;
    try { raw = sessionStorage.getItem(slot); }
    catch { throw new Error('No se pudo acceder al registro de operaciones. No se envió ningún cambio. Revise el almacenamiento del navegador.'); }
    if (raw === null) return null;
    let pending;
    try { pending = JSON.parse(await Access.open(raw)); }
    catch { throw new Error('El registro de una operación pendiente está dañado. No se envió ningún cambio; conserve esta pestaña y revise el comprobante antes de reintentar.'); }
    if (!pending || typeof pending.action !== 'string' ||
        typeof pending.key !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pending.key) ||
        !pending.payload || typeof pending.payload !== 'object' || Array.isArray(pending.payload)) {
      throw new Error('El registro de una operación pendiente está dañado. No se envió ningún cambio; conserve esta pestaña y revise el comprobante antes de reintentar.');
    }
    return pending;
  }
  function confirmed(action, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    if (action === 'sale_create' || action === 'sale_edit' || action === 'sale_cancel') {
      return Number.isSafeInteger(data.sale_id) && data.sale_id > 0 &&
        (action !== 'sale_cancel' || data.cancelled === true);
    }
    if (action === 'receipt' || action === 'transfer') {
      return Number.isSafeInteger(data.cantidad) && data.cantidad > 0 &&
        Number.isFinite(data.total) && data.total >= 0;
    }
    if (action === 'transfer_reverse') return Number.isSafeInteger(data.reversed) && data.reversed > 0;
    if (action === 'products_save') return Number.isSafeInteger(data.updated) && data.updated > 0;
    return false;
  }
  async function commit(action, payload, scope = action) {
    if(!Access.actions[action]) throw new Error('Operación no admitida.');
    Access.require(Access.actions[action]);
    if(Access.inventoryIntegrity!==true)throw new Error('El guardado está bloqueado hasta instalar migrations/006_inventory_integrity.sql. Puede seguir consultando; recargue después de aplicar la actualización.');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Datos de operación inválidos. No se envió ningún cambio.');
    payload=JSON.parse(JSON.stringify(payload));
    const identifier=(value,label)=>{
      if((typeof value==='number'&&!Number.isSafeInteger(value))||!['number','string'].includes(typeof value)||!/^\+?\d+$/.test(String(value).trim()))throw new Error(label+': identificador inválido.');
      const id=BigInt(String(value).trim());if(id<=0n||id>BigInt(Number.MAX_SAFE_INTEGER))throw new Error(label+': identificador fuera de rango.');return id.toString();
    };
    if(payload.movement_id!=null)identifier(payload.movement_id,'Movimiento');
    if(payload.sale_id!=null)identifier(payload.sale_id,'Venta');
    if(Array.isArray(payload.items)){
      const seen=new Set();
      for(const item of payload.items){
        if(item.product_id!=null)identifier(item.product_id,'Producto');
        if(item.line_id!=null){const id=identifier(item.line_id,'Línea');if(seen.has(id))throw new Error('Línea repetida: cada identificador debe aparecer una sola vez.');seen.add(id);}
      }
    }
    if(['sale_cancel','transfer_reverse'].includes(action)) {
      if(!Access.reversalReasons) throw new Error('Instale la migración 005 para guardar el motivo de esta operación.');
      const reason=typeof payload.reason==='string'?payload.reason.replace(/\s+/g,' ').trim():'';
      if(reason.length<5||reason.length>500) throw new Error('El motivo debe tener entre 5 y 500 caracteres.');
    }
    const slot = prefix + scope;
    let pending = await readPending(slot);
    if (pending && (pending.action !== action || JSON.stringify(pending.payload) !== JSON.stringify(payload))) {
      throw new Error('Hay una operación pendiente de confirmar. Use «Reintentar operación pendiente» antes de cambiar sus datos.');
    }
    const serialized = JSON.stringify(pending || { key: crypto.randomUUID(), action, payload });
    pending = JSON.parse(serialized);
    try { sessionStorage.setItem(slot, await Access.seal(serialized)); }
    catch { throw new Error('No se envió ningún cambio: no se pudo conservar el identificador de la operación. Revise el almacenamiento del navegador.'); }
    updatePending();
    let response;
    invalidateReads();
    try { response = await window.supabase.rpc('store_commit', { p_key: pending.key, p_action: pending.action, p_payload: pending.payload }); }
    catch { throw new Error('Se perdió la conexión. La operación puede haberse guardado. Reintente con los mismos datos; no se duplicará.'); }
    finally { invalidateReads(); }
    if (!response || (!response.error && !confirmed(action, response.data))) {
      throw new Error('No se recibió una confirmación válida. La operación puede haberse guardado. Mantenga esta pestaña abierta y reintente la operación pendiente; no se duplicará.');
    }
    if (response.error) {
      // Errores de conexión o confirmación del servidor también pueden ocultar un commit.
      const code = response.error.code || '';
      const rolledBack = (/^(22|23|40|42|P0)[0-9A-Z]{3}$/.test(code) && code !== '40003') ||
        ['PGRST202','PGRST301','PGRST302','PGRST303'].includes(code);
      if (rolledBack) sessionStorage.removeItem(slot);
      updatePending();
      if (code === 'PGRST202') throw new Error('Falta instalar migrations/001_atomic_store.sql en el clon de Supabase. No se guardó la operación.');
      throw new Error(response.error.message || 'No se pudo confirmar la operación. Reintente.');
    }
    try { sessionStorage.removeItem(slot); }
    catch { throw new Error('La operación ya se confirmó en la base de datos, pero no se pudo limpiar el registro local. No la repita con otros datos; conserve esta pestaña y use el reintento pendiente.'); }
    updatePending();
    return response.data;
  }
  async function run(scope, button, task) {
    if (busy.has(scope)) return;
    busy.add(scope);
    const form = button?.closest('form, .modal-card, .page-section');
    if (button) { button.disabled = true; button.classList.add('is-busy'); button.setAttribute('aria-busy','true'); }
    if (form) form.inert = true;
    try { return await task(); }
    catch (e) { alert(e.message || 'No se completó la operación.'); }
    finally { busy.delete(scope); if (form) form.inert = false; if (button) { button.disabled = false; button.classList.remove('is-busy'); button.removeAttribute('aria-busy'); } }
  }
  async function refresh(tasks) {
    const results = await Promise.allSettled(tasks.map(fn => fn()));
    if (results.some(r => r.status === 'rejected')) notice('No se pudo actualizar alguna vista. Revise la conexión y vuelva a cargar; no repita operaciones ya confirmadas.', true);
  }
  function notice(message, error = false) {
    let el = document.getElementById('appNotice');
    if (!el) { el = document.createElement('div'); el.id = 'appNotice'; el.setAttribute('role','status'); document.body.append(el); }
    el.textContent = message; el.className = error ? 'notice-error' : ''; el.hidden = false;
    clearTimeout(notice.timer); notice.timer = setTimeout(() => el.hidden = true, 8000);
  }
  function hasPending() {
    return Object.keys(sessionStorage).some(k => k.startsWith(prefix));
  }
  function updatePending() {
    const el = document.getElementById('pendingOperations');
    if (el) el.hidden = !hasPending();
  }
  async function retryPending() {
    for (const k of Object.keys(sessionStorage).filter(k => k.startsWith(prefix))) {
      const p = await readPending(k);
      await commit(p.action, p.payload, k.slice(prefix.length));
    }
    location.reload();
  }
  function initialize() {
    updatePending();
    document.getElementById('retryPending')?.addEventListener('click', e => run('retry',e.currentTarget,retryPending));
    (async () => {
      const el = document.getElementById('connectionStatus');
      const {data,error} = Access.health ? {data:Access.health,error:null} : await window.supabase.rpc('store_health');
      if(error || data?.version !== 1) {
        el.textContent=error?.code === 'PGRST202'
          ? 'Consultas disponibles · falta instalar la actualización SQL para habilitar el guardado seguro.'
          : 'No se pudo verificar el motor de guardado. Revise la conexión y la actualización SQL antes de operar.';
        el.dataset.state='error';
        el.classList.add('error');
      } else if(Access.inventoryIntegrity!==true){
        el.textContent='Consultas disponibles · guardado bloqueado: falta instalar 006_inventory_integrity.sql y recargar.';
        el.dataset.state='error';el.classList.add('error');
      } else {
        el.textContent='Conectado · guardado transaccional activo · horario de Bolivia';
        el.dataset.state='ready';
      }
    })().catch(() => {
      const el=document.getElementById('connectionStatus'); el.textContent='No se pudo verificar la conexión. Compruebe internet y vuelva a cargar.'; el.dataset.state='error'; el.classList.add('error');
    });
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',initialize); else queueMicrotask(initialize);
  return { money, date, number, all, catalog, cancellationNumbers, productTransfers, salesHistory, salesHistoryTotal, transferHistory, transferReversals, commit, run, refresh, notice, hasPending, busy, invalidateReads };
})();
