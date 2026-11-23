/**
 * Cotizaciones locales: vencen a los 3 días y se conservan para consulta.
 * Usa utilidades globales de app.js (allProducts, newVentaRow, showSection, etc.).
 */
(function () {
  const STORAGE_KEY = 'cotizaciones_v1';
  const TTL_MS = 3 * 24 * 60 * 60 * 1000;

  const form = document.getElementById('formCotizacion');
  if (!form) return;
  const itemsBody = document.getElementById('cotItems');
  const numInput = document.getElementById('cotNum');
  const clienteInput = document.getElementById('cotCliente');
  const descInput = document.getElementById('cotDescPct');
  const modoEl = document.getElementById('cotModo');
  const datalist = document.getElementById('cotDatalist');
  const histBody = document.querySelector('#cotHistTabla tbody');
  const subtotalEl = document.getElementById('cotSubtotal');
  const descuentoEl = document.getElementById('cotDescuento');
  const totalEl = document.getElementById('cotTotal');

  let productsByKey = new Map();
  let editingId = null;
  let editingVersion = 0, saving = null;
  let pendingVentaCotId = null;
  let dirty = false;

  // ===== Almacenamiento =====
  let cache=[],versions=new Map();
  function load(){ return Access.can('quotes.manage') ? structuredClone(cache) : []; }
  async function refreshQuotes(){
    Access.require('quotes.manage');
    const rows=await Store.all('store_quotes');
    cache=rows.map(r=>r.data);versions=new Map(rows.map(r=>[r.id,r.version]));
  }
  async function persist(list,expectedVersions=new Map()){
    try{
      Access.require('quotes.manage');
      for(const cot of list){
        const original=cache.find(c=>c.id===cot.id);
        if(JSON.stringify(original)===JSON.stringify(cot))continue;
        const version=await Access.rpc('store_quote_save',{p_id:cot.id,p_data:cot,p_version:expectedVersions.has(cot.id)?expectedVersions.get(cot.id):versions.get(cot.id)||0});
        versions.set(cot.id,version);
        cache=cache.filter(c=>c.id!==cot.id).concat(structuredClone(cot));
      }
      return true;
    }catch(e){Store.notice(e.message,true);return false;}
  }

  // Leer nunca elimina cotizaciones, aunque hayan vencido.
  function getAll() {
    const now = Date.now();
    const list = load();
    const alive = list;
    if (editingId && !alive.some(c => c.id === editingId)) editingId = null;
    return alive.sort((a, b) => b.createdAt - a.createdAt);
  }

  function findById(id) {
    return getAll().find(c => c.id === id) || null;
  }

  // ===== Utilidades =====
  function genNumero() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `C-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${genId().slice(0,8)}`;
  }

  function genId() {
    return window.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function todayISO() {
    return Store.date();
  }

  function formatRemaining(ms) {
    if (ms <= 0) return 'Expirada';
    const totalMin = Math.floor(ms / 60000);
    const d = Math.floor(totalMin / 1440);
    const h = Math.floor((totalMin % 1440) / 60);
    const m = totalMin % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  function cotExpiry(c) { return c.expiresAt || Number(c.createdAt) + TTL_MS; }

  function computeTotals(items, descuentoPct) {
    const subtotal = Store.money(items.reduce((acc, it) => acc + Store.money(it.cantidad * it.precio), 0));
    const pct = Math.min(100, Math.max(0, Number(descuentoPct) || 0));
    const descuento = Store.money((subtotal * pct) / 100);
    return { subtotal, descuento, total: Store.money(subtotal - descuento) };
  }

  // ===== Productos =====
  async function refreshProducts() {
    const products = await Store.catalog();
    productsByKey = new Map(products.map(p => [normalizeItemKey(p.item), p]));
    datalist.innerHTML = products
      .map(p => `<option value="${escapeHtml(p.item)}">${escapeHtml(p.nombre)}</option>`)
      .join('');
    itemsBody.querySelectorAll('tr').forEach(tr => updateRowInfo(tr, false));
    recalc();
  }

  function updateRowInfo(tr, setPrice) {
    const raw = tr.querySelector('.cot-item').value.trim();
    const p = productsByKey.get(normalizeItemKey(raw));
    tr.querySelector('.cot-nombre').textContent = p ? p.nombre : (raw ? 'Producto no encontrado' : '—');
    tr.querySelector('.cot-stock').textContent = p ? String(p.ceja ?? 0) : '—';
    if (setPrice && p) tr.querySelector('.cot-precio').value = p.precio ?? 0;
  }

  // ===== Formulario =====
  function newRow(data = {}) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" class="cot-item" list="cotDatalist" placeholder="ITEM" autocomplete="off" /></td>
      <td class="cot-nombre">—</td>
      <td class="cot-stock">—</td>
      <td><input type="number" class="cot-cant" min="1" step="1" placeholder="Cantidad" /></td>
      <td><input type="number" class="cot-precio" min="0" step="0.01" placeholder="Precio (Bs)" /></td>
      <td class="cot-subtotal">Bs 0.00</td>
      <td><button type="button" class="remove">Eliminar</button></td>
    `;
    tr.querySelector('.cot-item').value = data.item ?? '';
    tr.querySelector('.cot-cant').value = data.cantidad ?? '';
    tr.querySelector('.cot-precio').value = data.precio ?? '';
    itemsBody.appendChild(tr);
    updateRowInfo(tr, false);
    return tr;
  }

  function readRows() {
    return Array.from(itemsBody.querySelectorAll('tr')).map(tr => {
      const raw = tr.querySelector('.cot-item').value.trim();
      const p = productsByKey.get(normalizeItemKey(raw));
      return {
        tr,
        product: p,
        item: p ? p.item : raw,
        nombre: p ? p.nombre : '',
        cantidad: Number(tr.querySelector('.cot-cant').value || '0'),
        precio: Number(tr.querySelector('.cot-precio').value || '0')
      };
    });
  }

  function recalc() {
    const rows = readRows();
    rows.forEach(r => {
      r.tr.querySelector('.cot-subtotal').textContent = fmt(r.cantidad * r.precio);
      const sinStock = r.product && r.cantidad > Number(r.product.ceja ?? 0);
      const noExiste = r.item && !r.product && productsByKey.size > 0;
      r.tr.classList.toggle('cot-warn', !!(sinStock || noExiste));
    });
    const totals = computeTotals(rows, descInput.value);
    subtotalEl.textContent = fmt(totals.subtotal);
    descuentoEl.textContent = fmt(totals.descuento);
    totalEl.textContent = fmt(totals.total);
  }

  function updateModo() {
    const cot = editingId ? findById(editingId) : null;
    if (cot) {
      modoEl.textContent = `Editando ${cot.numero}`;
      modoEl.className = 'badge badge-alert';
    } else {
      modoEl.textContent = 'Nueva cotización';
      modoEl.className = 'badge badge-ok';
    }
  }

  function resetForm() {
    editingId = null;
    editingVersion = 0;
    clienteInput.value = '';
    descInput.value = '';
    numInput.value = genNumero();
    itemsBody.innerHTML = '';
    newRow();
    recalc();
    updateModo();
    renderHistory();
    dirty = false;
  }

  function loadIntoForm(cot) {
    editingId = cot.id;
    editingVersion = versions.get(cot.id)||0;
    numInput.value = cot.numero;
    clienteInput.value = cot.cliente || '';
    descInput.value = cot.descuentoPct || '';
    itemsBody.innerHTML = '';
    cot.items.forEach(it => newRow(it));
    if (!cot.items.length) newRow();
    recalc();
    updateModo();
    renderHistory();
    dirty = false;
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function save() {
    if(!saving) saving=saveDraft().finally(()=>{saving=null;});
    return saving;
  }
  async function saveDraft() {
    Access.require('quotes.manage');
    const rows = readRows();
    if (!rows.length) {
      alert('Agrega al menos un producto con cantidad mayor a 0.');
      return null;
    }
    if(rows.some(r=>!r.item || !Number.isSafeInteger(r.cantidad) || r.cantidad<=0 || !Number.isFinite(r.precio) || r.precio<0)){
      alert('Complete todas las líneas: producto, cantidad entera mayor a cero y precio válido.');return null;
    }
    const rawDiscount=Number(descInput.value||0);
    if(!Number.isFinite(rawDiscount)||rawDiscount<0||rawDiscount>100){alert('El descuento debe estar entre 0 y 100%.');return null;}
    const desconocidos = rows.filter(r => !r.product).map(r => r.item);
    if (desconocidos.length) {
      alert(`Estos productos no existen en el inventario:\n${desconocidos.join('\n')}`);
      return null;
    }
    const items = rows.map(({ item, nombre, cantidad, precio }) => ({ item, nombre, cantidad, precio:Store.money(precio) }));
    const descuentoPct = Math.min(100, Math.max(0, parseFloat(descInput.value || '0') || 0));
    const data = { cliente: clienteInput.value.trim(), descuentoPct, items, ...computeTotals(items, descuentoPct) };

    const list = getAll();
    const now = Date.now();
    let cot = editingId ? list.find(c => c.id === editingId) : null;
    if (cot) {
      Object.assign(cot, data, { updatedAt: now, expiresAt: now + TTL_MS });
    } else {
      cot = { id: genId(), numero: numInput.value || genNumero(), createdAt: now, updatedAt: now, ...data };
      list.push(cot);
    }
    if (!await persist(list,new Map([[cot.id,editingId?editingVersion:0]]))) return null;
    editingId = cot.id;
    editingVersion = versions.get(cot.id)||0;
    dirty = false;
    updateModo();
    renderHistory();
    return cot;
  }

  // ===== Convertir en venta =====
  function printQuote(cot, autoPrint) {
    const fecha = new Intl.DateTimeFormat('en-CA',{timeZone:'America/La_Paz',year:'numeric',month:'2-digit',day:'2-digit'});
    return descargarComprobantePDF('cotizacion',{
      autoPrint,
      payload:{
        comprobante:{numero:cot.numero,fecha:fecha.format(new Date(cot.updatedAt || cot.createdAt)),entidad:cot.cliente || 'Cliente no especificado'},
        items:cot.items.map(i=>({...i,precioVenta:i.precio})),
        subtotal:cot.subtotal,descuento:cot.descuento,total:cot.total,
        validaHasta:fecha.format(new Date(cotExpiry(cot))) + (Date.now()>=cotExpiry(cot) ? ' (VENCIDA)' : '')
      }
    });
  }

  for(const [id,autoPrint] of [['cotImprimir',true],['cotPDF',false]]){
    document.getElementById(id)?.addEventListener('click',async()=>{
      const cot=editingId&&!dirty ? findById(editingId) : await save();
      if(cot) printQuote(cot,autoPrint);
    });
  }

  async function convertToVenta(cot) {
    Access.require('sales.create');
    if (Date.now() >= (cot.expiresAt || Number(cot.createdAt) + TTL_MS)) { alert('La cotización venció. Cárguela, revise sus precios y guárdela para renovar su vigencia.'); return; }
    if (cot.convertedAt && !confirm(`Esta cotización ya se convirtió en la venta ${cot.ventaNumero}. ¿Convertir de nuevo?`)) return;
    const ventaEnCurso = !venGuardarBtn?.disabled &&
      Array.from(venItemsDiv.querySelectorAll('.ven-sku')).some(i => i.value.trim());
    if (ventaEnCurso && !confirm('Hay una venta en curso sin guardar. ¿Reemplazarla con esta cotización?')) return;

    await refreshProducts();
    formVenta.reset();
    venItemsDiv.innerHTML = '';
    ventaComprobante.hidden = true;
    venImprimirBtn.disabled = true;
    if (venGuardarBtn) {
      venGuardarBtn.disabled = false;
      venGuardarBtn.removeAttribute('data-hint');
      venGuardarBtn.removeAttribute('title');
    }
    setAutoSaleNumber();
    document.getElementById('venFecha').value = todayISO();
    document.getElementById('venCliente').value = cot.cliente || '';
    document.getElementById('venDescPct').value = cot.descuentoPct || '';

    const rows = await Promise.all(cot.items.map(() => newVentaRow()));
    const avisos = [];
    cot.items.forEach((it, i) => {
      const row = rows[i];
      const p = productsByKey.get(normalizeItemKey(it.item));
      row.querySelector('.ven-sku').value = p ? p.item : it.item;
      row.querySelector('.ven-nombre').value = p ? p.nombre : it.nombre;
      row.querySelector('.ven-ceja').value = p ? (p.ceja ?? 0) : '';
      row.querySelector('.ven-cant').value = it.cantidad;
      row.querySelector('.ven-pvent').value = it.precio;
      venItemsDiv.appendChild(row);
      if (!p) avisos.push(`${it.item}: ya no existe en el inventario`);
      else if (Number(p.ceja ?? 0) < it.cantidad) avisos.push(`${p.item}: se piden ${it.cantidad}, CEJA tiene ${p.ceja ?? 0}`);
    });
    if (!rows.length) venItemsDiv.appendChild(await newVentaRow());
    recalcVentaTotals();

    pendingVentaCotId = cot.id;
    showSection('realizarVentaSection');
    if (avisos.length) alert(`Atención, revisa el stock antes de guardar la venta:\n${avisos.join('\n')}`);
  }

  // ===== Historial =====
  function renderHistory() {
    const list = getAll();
    if (!list.length) {
      histBody.innerHTML = '<tr><td colspan="8" class="note">No hay cotizaciones guardadas.</td></tr>';
      return;
    }
    const now = Date.now();
    histBody.innerHTML = list.map(c => {
      const id = escapeHtml(c.id);
      const unidades = c.items.reduce((a, it) => a + it.cantidad, 0);
      const estado = c.convertedAt
        ? `<span class="badge badge-ok">Vendida · ${escapeHtml(c.ventaNumero || '')}</span>`
        : '<span class="badge badge-alert">Pendiente</span>';
      return `
        <tr class="${c.id === editingId ? 'cot-row-active' : ''}">
          <td>${new Date(c.createdAt).toLocaleString('es-BO', { dateStyle: 'short', timeStyle: 'short' })}</td>
          <td>${escapeHtml(c.numero)}</td>
          <td>${escapeHtml(c.cliente || '—')}</td>
          <td>${c.items.length} (${unidades} u.)</td>
          <td><strong>${Number(c.total).toFixed(2)}</strong></td>
          <td>${formatRemaining((cotExpiry(c)) - now)}</td>
          <td>${estado}</td>
          <td class="cot-actions">
            <button type="button" class="secondary" data-action="load" data-id="${id}">Cargar</button>
            <button type="button" class="secondary" data-action="print" data-id="${id}">Imprimir cotización</button>
            <button type="button" class="secondary" data-action="pdf" data-id="${id}">PDF</button>
            <button type="button" class="primary" data-action="convert" data-id="${id}">Convertir en venta</button>

          </td>
        </tr>`;
    }).join('');
  }

  // ===== Eventos =====
  form.addEventListener('input', () => { dirty = true; });
  descInput.addEventListener('input', recalc);
  itemsBody.addEventListener('input', (e) => {
    if (e.target.matches('.cot-cant, .cot-precio')) recalc();
  });
  itemsBody.addEventListener('change', (e) => {
    if (!e.target.matches('.cot-item')) return;
    updateRowInfo(e.target.closest('tr'), true);
    recalc();
  });
  itemsBody.addEventListener('click', (e) => {
    if (!e.target.matches('.remove')) return;
    e.target.closest('tr').remove();
    if (!itemsBody.children.length) newRow();
    dirty = true;
    recalc();
  });

  document.getElementById('cotAddItem').addEventListener('click', () => {
    newRow().querySelector('.cot-item').focus();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const cot = await save();
    if (cot) alert(`Cotización ${cot.numero} guardada. Vigente durante 3 días; se conservará en el historial.`);
  });

  document.getElementById('cotConvertir').addEventListener('click', async () => {
    const cot = await save();
    if (cot) await convertToVenta(cot);
  });

  document.getElementById('cotNueva').addEventListener('click', () => {
    if (dirty && !confirm('Hay cambios sin guardar en la cotización. ¿Descartarlos?')) return;
    resetForm();
  });

  histBody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const cot = findById(btn.dataset.id);
    if (!cot) {
      alert('La cotización ya no existe (pudo haber expirado).');
      renderHistory();
      return;
    }
    if (btn.dataset.action === 'print' || btn.dataset.action === 'pdf') {
      await printQuote(cot,btn.dataset.action==='print');
    } else if (btn.dataset.action === 'load') {
      if (dirty && !confirm('Hay cambios sin guardar en la cotización actual. ¿Descartarlos?')) return;
      loadIntoForm(cot);
    } else if (btn.dataset.action === 'convert') {
      await convertToVenta(cot);
    } else if (btn.dataset.action === 'delete') {
      if (!confirm(`¿Eliminar la cotización ${cot.numero}?`)) return;
      return; // Las cotizaciones se conservan en el historial.
      if (editingId === cot.id) resetForm();
      else renderHistory();
    }
  });

  window.addEventListener('venta:guardada', async (e) => {
    if (!pendingVentaCotId) return;
    const list = getAll();
    const cot = list.find(c => c.id === pendingVentaCotId);
    pendingVentaCotId = null;
    if (!cot) return;
    cot.convertedAt = Date.now();
    cot.ventaNumero = e.detail?.numero || '';
    await persist(list);
    updateModo();
    renderHistory();
  });

  venLimpiarBtn?.addEventListener('click', () => { pendingVentaCotId = null; });

  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) renderHistory();
  });

  setInterval(() => {
    renderHistory();
    updateModo();
  }, 60 * 1000);

  resetForm();
  // Los datos se solicitan al abrir Cotización.

  window.cotizaciones = {
    async onShow() {
      if(!Access.can('quotes.manage')) return;
      try { await Promise.all([refreshQuotes(),refreshProducts()]);renderHistory();updateModo(); } catch(e){Store.notice(e.message,true);}
    }
  };
})();
