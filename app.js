// Conexión Supabase
const SUPABASE_URL = 'https://qmaftwvpbzzzdmuevelh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFtYWZ0d3ZwYnp6emRtdWV2ZWxoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ5NjA2NTYsImV4cCI6MjA4MDUzNjY1Nn0.dEQkkAWdwAEGDhqSPcQuuBKSwMlmVQk9J2ws6eU7ti4';
supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Tablas esperadas:
// products: { id, item, nombre, ceja, senkata, unidad, precio, categoria }
// movements: { id, tipo ('ingreso'|'venta'|'transfer'), fecha, item, nombre, cantidad, detalle, total, descuento }
// roles_matrix: { id, data_json declarado para forzar una modificacion externa }

// Datos iniciales de ejemplo
async function seedIfEmpty() {
  const { data: products, error } = await supabase.from('products').select('id');
  if (error) { console.error('Error consultando productos', error); return; }
  if (!products || products.length === 0) {
    const seed = [
      { item: 'SKU-001', nombre: 'Teclado', categoria: 'Periféricos', ceja: 10, senkata: 15, unidad: 'PCS', precio: 29.9 },
      { item: 'SKU-002', nombre: 'Mouse', categoria: 'Periféricos', ceja: 20, senkata: 20, unidad: 'PCS', precio: 12.5 },
      { item: 'SKU-003', nombre: 'Monitor 24"', categoria: 'Monitores', ceja: 5, senkata: 5, unidad: 'PCS', precio: 140.0 },
      { item: 'SKU-004', nombre: 'Laptop 14"', categoria: 'Computadoras', ceja: 2, senkata: 3, unidad: 'PCS', precio: 590.0 }
    ];
    await supabase.from('products').insert(seed);
  }
  const { data: rolesRow } = await supabase.from('roles_matrix').select('id').limit(1).maybeSingle();
  if (!rolesRow) {
    const modules = ['Ingreso', 'Movimientos', 'Ventas', 'Inventario', 'Dashboard', 'Administrador'];
    const rolesList = ['Admin', 'Vendedor', 'Almacenero'];
    const matrix = {};
    rolesList.forEach(r => { matrix[r] = {}; modules.forEach(m => matrix[r][m] = true); });
    await supabase.from('roles_matrix').insert({ data_json: { roles: rolesList, modules, matrix } });
  }
}
seedIfEmpty();

// Navegación
const navButtons = document.querySelectorAll('.nav-btn');
navButtons.forEach(btn => btn.addEventListener('click', () => showSection(btn.dataset.target)));
function showSection(id) {
  document.querySelectorAll('.page-section').forEach(s => s.hidden = s.id !== id);
}
// Ventas subview toggles and auto-number
function genSaleNumber() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  const hh = String(d.getHours()).padStart(2,'0');
  const mm = String(d.getMinutes()).padStart(2,'0');
  const ss = String(d.getSeconds()).padStart(2,'0');
  return `V-${y}${m}${day}-${hh}${mm}${ss}`;
}
function setAutoSaleNumber() {
  const inp = document.getElementById('venNum');
  if (inp) inp.value = genSaleNumber();
}

// Mostrar sección por defecto
showSection('ingresoSection');

// Referencias ingreso
const ingItemsDiv = document.getElementById('ingItems');
const ingAddItemBtn = document.getElementById('ingAddItem');
const formIngreso = document.getElementById('formIngreso');
const ingLimpiarBtn = document.getElementById('ingLimpiar');
const ingImprimirBtn = document.getElementById('ingImprimir');
const ingresoComprobante = document.getElementById('ingresoComprobante');
const ingresoComprobanteBody = document.getElementById('ingresoComprobanteBody');
// CSV elements
const csvFileInput = document.getElementById('csvFile');
const csvPreviewBtn = document.getElementById('csvPreviewBtn');
const csvUploadBtn = document.getElementById('csvUploadBtn');
const csvPreviewWrap = document.getElementById('csvPreview');
const csvPreviewBody = csvPreviewWrap ? csvPreviewWrap.querySelector('tbody') : null;

// Referencias ventas
const venItemsDiv = document.getElementById('venItems');
const venAddItemBtn = document.getElementById('venAddItem');
const formVenta = document.getElementById('formVenta');
const venLimpiarBtn = document.getElementById('venLimpiar');
const venImprimirBtn = document.getElementById('venImprimir');
const venGuardarBtn = document.getElementById('venGuardar');
const ventaComprobante = document.getElementById('ventaComprobante');
const ventaComprobanteBody = document.getElementById('ventaComprobanteBody');

// Inventario
const invBuscar = document.getElementById('invBuscar');
const invCategoria = document.getElementById('invCategoria');
const invStockMin = document.getElementById('invStockMin');
const invStockMax = document.getElementById('invStockMax');
const invAplicar = document.getElementById('invAplicar');
const invReiniciar = document.getElementById('invReiniciar');
const invExportExcel = document.getElementById('invExportExcel');
const invTabla = document.getElementById('invTabla').querySelector('tbody');

// Admin
const adminNuevoRol = document.getElementById('adminNuevoRol');
const adminAgregarRol = document.getElementById('adminAgregarRol');
const adminGuardar = document.getElementById('adminGuardar');
const adminTabla = document.getElementById('adminTabla');

// Utilidades de productos (Supabase)
async function allProducts() {
  const { data, error } = await supabase.from('products').select('*').order('nombre', { ascending: true });
  if (error) { console.error(error); return []; }
  return data || [];
}
async function findProductByITEM(item) {
  const { data, error } = await supabase.from('products').select('*').ilike('item', item);
  if (error) { console.error(error); return null; }
  return data?.[0] || null;
}
async function upsertProduct(p) {
  try {
    if (p.id) {
      const { error } = await supabase.from('products').update({
        item: p.item,
        nombre: p.nombre,
        categoria: p.categoria,
        ceja: p.ceja,
        senkata: p.senkata,
        unidad: p.unidad,
        precio: p.precio
      }).eq('id', p.id);
      if (error) console.error('update product error', error);
    } else {
      // Check if a product with same item+nombre exists to update instead of insert
      const { data: existing, error: selErr } = await supabase
        .from('products').select('id')
        .eq('item', p.item).eq('nombre', p.nombre).limit(1);
      if (!selErr && existing && existing.length) {
        const id = existing[0].id;
        const { error } = await supabase.from('products').update({
          categoria: p.categoria,
          ceja: p.ceja,
          senkata: p.senkata,
          unidad: p.unidad,
          precio: p.precio
        }).eq('id', id);
        if (error) console.error('update product error', error);
      } else {
        const { error } = await supabase.from('products').insert(p);
        if (error) console.error('insert product error', error);
      }
    }
  } catch (e) {
    console.error('upsertProduct exception', e);
  }
}

// Movimientos (Supabase)
async function addMovement(mov) {
  const { error } = await supabase.from('movements').insert(mov);
  if (error) console.error('addMovement', error);
}
async function allMovements() {
  const { data, error } = await supabase.from('movements').select('*').order('fecha', { ascending: false });
  if (error) { console.error(error); return []; }
  return data || [];
}

// Componentes dinámicos: fila de ingreso
function newIngresoRow() {
  const row = document.createElement('div');
  row.className = 'item-row';
  row.innerHTML = `
    <input type="text" placeholder="SKU" class="ing-sku" required />
    <input type="text" placeholder="Nombre" class="ing-nombre" required />
    <input type="text" placeholder="Categoría" class="ing-cat" />
    <input type="number" placeholder="Cantidad" class="ing-cant" min="1" required />
    <input type="number" placeholder="Precio Compra" class="ing-pcomp" min="0" step="0.01" required />
    <input type="number" placeholder="Precio Venta" class="ing-pvent" min="0" step="0.01" />
    <button type="button" class="remove">Eliminar</button>
  `;
  const removeBtn = row.querySelector('.remove');
  removeBtn.addEventListener('click', () => row.remove());
  return row;
}

async function newVentaRow() {
  const row = document.createElement('tr');
  const list = await allProducts();
  const datalistId = 'datalistProductos';
  let dl = document.getElementById(datalistId);
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = datalistId;
    document.body.appendChild(dl);
  }
  dl.innerHTML = list.map(p => `<option value="${p.item}">${p.nombre}</option>`).join('');
  row.innerHTML = `
    <td><input type="text" placeholder="ITEM" class="ven-sku" list="${datalistId}" required /></td>
    <td><input type="text" placeholder="Nombre (auto)" class="ven-nombre" disabled /></td>
    <td><input type="text" placeholder="CEJA disponible" class="ven-ceja" disabled /></td>
    <td><input type="number" placeholder="Cantidad" class="ven-cant" min="1" required /></td>
    <td><input type="number" placeholder="Precio Venta (Bs)" class="ven-pvent" min="0" step="0.01" required /></td>
    <td class="ven-subtotal">Bs 0.00</td>
    <td><button type="button" class="remove">Eliminar</button></td>
  `;
  const skuInput = row.querySelector('.ven-sku');
  skuInput.addEventListener('change', async () => {
    const p = await findProductByITEM(skuInput.value);
    const nombreInput = row.querySelector('.ven-nombre');
    const cejaInput = row.querySelector('.ven-ceja');
    const precioInput = row.querySelector('.ven-pvent');
    if (p) { nombreInput.value = p.nombre; cejaInput.value = (p.ceja ?? 0); precioInput.value = p.precio ?? 0; }
    else { nombreInput.value = ''; cejaInput.value = ''; precioInput.value = ''; }
    recalcVentaTotals();
  });
  const removeBtn = row.querySelector('.remove');
  removeBtn.addEventListener('click', () => { row.remove(); recalcVentaTotals(); });
  return row;
}

// Agregar filas iniciales
ingAddItemBtn.addEventListener('click', () => ingItemsDiv.appendChild(newIngresoRow()));
venAddItemBtn.addEventListener('click', async () => { venItemsDiv.appendChild(await newVentaRow()); recalcVentaTotals(); });
ingItemsDiv.appendChild(newIngresoRow());
(async () => { venItemsDiv.appendChild(await newVentaRow()); recalcVentaTotals(); })();

// Guardar ingreso
formIngreso.addEventListener('submit', async (e) => {
  e.preventDefault();
  const num = document.getElementById('ingNum').value.trim();
  const fecha = document.getElementById('ingFecha').value;
  const proveedor = document.getElementById('ingProveedor').value.trim();
  const filas = Array.from(ingItemsDiv.querySelectorAll('.item-row'));
  const items = filas.map(r => ({
    sku: r.querySelector('.ing-sku').value.trim(),
    nombre: r.querySelector('.ing-nombre').value.trim(),
    categoria: (r.querySelector('.ing-cat').value || 'General').trim(),
    cantidad: parseInt(r.querySelector('.ing-cant').value || '0', 10),
    precioCompra: parseFloat(r.querySelector('.ing-pcomp').value || '0'),
    precioVenta: parseFloat(r.querySelector('.ing-pvent').value || '0')
  })).filter(it => it.sku && it.nombre && it.cantidad > 0);
  if (!num || !fecha || !proveedor || items.length === 0) {
    alert('Complete datos del comprobante y al menos una línea válida.');
    return;
  }
  // Actualizar inventario en SENKATA (se considera ingreso al depósito SENKATA)
  for (const it of items) {
    const p = await findProductByITEM(it.sku);
    if (p) {
      await upsertProduct({ id: p.id, item: p.item, nombre: p.nombre, categoria: p.categoria, unidad: p.unidad || 'PCS', precio: p.precio || it.precioVenta || 0, ceja: p.ceja || 0, senkata: (p.senkata || 0) + it.cantidad });
    } else {
      await upsertProduct({ item: it.sku, nombre: it.nombre, categoria: it.categoria, unidad: 'PCS', precio: it.precioVenta || 0, ceja: 0, senkata: it.cantidad });
    }
  }
  const total = items.reduce((acc, it) => acc + (it.precioCompra || 0) * it.cantidad, 0);
  await addMovement({ tipo: 'ingreso', fecha, item: '-', nombre: proveedor, cantidad: items.reduce((a,i)=>a+i.cantidad,0), detalle: `Ingreso comprobante ${num}`, total, descuento: 0 });
  renderComprobante('ingreso', { comprobante: { numero: num, fecha, entidad: proveedor }, items, total }, ingresoComprobanteBody, ingresoComprobante);
  ingImprimirBtn.disabled = false;
  alert('Ingreso guardado. Inventario actualizado.');
});

ingLimpiarBtn.addEventListener('click', () => {
  formIngreso.reset();
  ingItemsDiv.innerHTML = '';
  ingItemsDiv.appendChild(newIngresoRow());
  ingresoComprobante.hidden = true;
  ingImprimirBtn.disabled = true;
});

// Guardar venta (solo desde CEJA) con descuento
formVenta.addEventListener('submit', async (e) => {
  e.preventDefault();
  const num = document.getElementById('venNum').value.trim();
  const fecha = document.getElementById('venFecha').value;
  const cliente = document.getElementById('venCliente').value.trim();
  let descuentoPct = parseFloat((document.getElementById('venDescPct').value || '0')); 
  if (isNaN(descuentoPct) || descuentoPct < 0) descuentoPct = 0;
  const filas = Array.from(venItemsDiv.querySelectorAll('tr'));
  const items = filas.map(r => ({
    item: r.querySelector('.ven-sku')?.value.trim() || '',
    cantidad: parseInt(r.querySelector('.ven-cant')?.value || '0', 10),
    precioVenta: parseFloat(r.querySelector('.ven-pvent')?.value || '0'),
  })).filter(it => it.item && it.cantidad > 0);
  if (!num || !fecha || !cliente || items.length === 0) {
    alert('Complete datos del comprobante y al menos una línea válida.');
    return;
  }
  // Validar stock y actualizar inventario
  const products = await allProducts();
  for (const it of items) {
    const p = products.find(x => x.item.trim().toLowerCase() === it.item.trim().toLowerCase());
    if (!p) { alert(`Producto ${it.item} no existe.`); return; }
    if ((p.ceja ?? 0) < it.cantidad) { alert(`Stock CEJA insuficiente para ${p.nombre} (Disponible: ${p.ceja}).`); return; }
  }
  // Actualizar CEJA
  for (const it of items) {
    const p = products.find(x => x.item.trim().toLowerCase() === it.item.trim().toLowerCase());
    await upsertProduct({ id: p.id, item: p.item, nombre: p.nombre, categoria: p.categoria, unidad: p.unidad, precio: p.precio || it.precioVenta, ceja: (p.ceja || 0) - it.cantidad, senkata: p.senkata || 0 });
  }
  const detailedItems = items.map(it => {
    const p = products.find(x => x.item.trim().toLowerCase() === it.item.trim().toLowerCase());
    return { item: it.item, nombre: p?.nombre ?? it.item, cantidad: it.cantidad, precioVenta: it.precioVenta };
  });
  let total = detailedItems.reduce((acc, it) => acc + it.precioVenta * it.cantidad, 0);
  const descuento = (total * descuentoPct) / 100;
  const totalConDesc = total - descuento;
  // update totals UI
  setVentaTotals(total, descuento, totalConDesc);
  await addMovement({ tipo: 'venta', fecha, item: '-', nombre: cliente, cantidad: detailedItems.reduce((a,i)=>a+i.cantidad,0), detalle: `Venta comprobante ${num}`, total: totalConDesc, descuento });
  // Persist sale into sales tables (if present)
  try {
    const { data: saleRow, error: saleErr } = await supabase
      .from('sales')
      .insert({ numero: num, fecha, cliente, subtotal: total, descuento_pct: descuentoPct, descuento, total: totalConDesc })
      .select('id').single();
    if (!saleErr && saleRow?.id) {
      const itemsRows = detailedItems.map(di => ({ sale_id: saleRow.id, item: di.item, nombre: di.nombre, cantidad: di.cantidad, precio: di.precioVenta, subtotal: di.precioVenta * di.cantidad }));
      await supabase.from('sales_items').insert(itemsRows);
    }
  } catch (se) { console.error('save sale error', se); }
  renderComprobante('venta', { comprobante: { numero: num, fecha, entidad: cliente }, items: detailedItems, total: totalConDesc }, ventaComprobanteBody, ventaComprobante);
  venImprimirBtn.disabled = false;
  if (venGuardarBtn) {
    venGuardarBtn.disabled = true;
    venGuardarBtn.setAttribute('data-hint', 'Guardado. Usa «Limpiar» para habilitar.');
    venGuardarBtn.title = 'Guardado. Usa «Limpiar» para habilitar.';
  }
  alert('Venta guardada. Inventario actualizado.');
  await refreshVentasHistorial();
  setAutoSaleNumber();
});

venLimpiarBtn.addEventListener('click', async () => {
  formVenta.reset();
  venItemsDiv.innerHTML = '';
  venItemsDiv.appendChild(await newVentaRow());
  ventaComprobante.hidden = true;
  venImprimirBtn.disabled = true;
  if (venGuardarBtn) {
    venGuardarBtn.disabled = false;
    venGuardarBtn.removeAttribute('data-hint');
    venGuardarBtn.removeAttribute('title');
  }
  setAutoSaleNumber();
  recalcVentaTotals();
});

// Imprimir (redirigido a PDF para evitar URL del navegador)
ingImprimirBtn.addEventListener('click', async () => {
  try { await descargarComprobantePDF('ingreso', { autoPrint: true }); } catch (e) { console.error(e); alert('No se pudo imprimir el comprobante.'); }
});
venImprimirBtn.addEventListener('click', async () => {
  try { await descargarComprobantePDF('venta', { autoPrint: true }); } catch (e) { console.error(e); alert('No se pudo imprimir el comprobante.'); }
});

// Compatibilidad: impresión HTML (ya no utilizada por defecto)
function printComprobante(sourceEl) {
  const printArea = document.getElementById('printArea');
  printArea.innerHTML = sourceEl.innerHTML;
  printArea.hidden = false;
  window.print();
  printArea.hidden = true;
}

// Render comprobante
function renderComprobante(tipo, mov, targetBody, container) {
  const esIngreso = tipo === 'ingreso';
  const cols = esIngreso ? '<th>SKU</th><th>Nombre</th><th>Categoría</th><th>Cantidad</th><th>Precio Compra</th><th>Subtotal</th>'
                         : '<th>SKU</th><th>Nombre</th><th>Cantidad</th><th>Precio Venta</th><th>Subtotal</th>';
  const rows = mov.items.map(it => {
    if (esIngreso) {
      const subtotal = (it.precioCompra || 0) * it.cantidad;
      return `<tr><td>${it.sku}</td><td>${it.nombre}</td><td>${it.categoria ?? ''}</td><td>${it.cantidad}</td><td>${fmt(it.precioCompra)}</td><td>${fmt(subtotal)}</td></tr>`;
    } else {
      const subtotal = (it.precioVenta || 0) * it.cantidad;
      return `<tr><td>${it.item ?? it.sku ?? ''}</td><td>${it.nombre}</td><td>${it.cantidad}</td><td>${fmt(it.precioVenta)}</td><td>${fmt(subtotal)}</td></tr>`;
    }
  }).join('');

  const tipoLabel = esIngreso ? 'Comprobante de Ingreso' : 'Comprobante de Venta';
  const entidadLabel = esIngreso ? 'Proveedor' : 'Cliente';

  targetBody.innerHTML = `
    <div class="comprobante-doc ${esIngreso ? 'comprobante-ingreso' : 'comprobante-venta'}">
      <div class="comp-brand">
        <div class="brand-left">
          <div class="brand-title">IMPORTACIONES MB</div>
          <div class="brand-sub">${tipoLabel}</div>
        </div>
        <div class="brand-right">
          <div><strong>N°:</strong> ${mov.comprobante.numero}</div>
          <div><strong>Fecha:</strong> ${mov.comprobante.fecha}</div>
        </div>
      </div>

      <div class="comp-meta">
        <div><strong>${entidadLabel}:</strong> ${mov.comprobante.entidad}</div>
        <div><strong>Tipo:</strong> ${esIngreso ? 'Ingreso' : 'Venta'}</div>
      </div>

      <table class="comp-table">
        <thead><tr>${cols}</tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr>
            <td colspan="${esIngreso ? 5 : 4}" class="comp-total-label">Total</td>
            <td class="comp-total-value">${fmt(mov.total)}</td>
          </tr>
        </tfoot>
      </table>

      <div class="comp-footer">
        <div class="comp-note">Gracias por su preferencia.</div>
      </div>
    </div>
  `;
  container.hidden = false;
  try { setLastComprobante(tipo, mov); } catch {}
}
function fmt(n) { return `Bs ${Number(n).toFixed(2)}`; }

// Totals helpers
const ventaSubtotalEl = document.getElementById('ventaSubtotal');
const ventaDescuentoEl = document.getElementById('ventaDescuento');
const ventaTotalEl = document.getElementById('ventaTotal');
function setVentaTotals(sub, desc, tot) {
  if (ventaSubtotalEl) ventaSubtotalEl.textContent = fmt(sub);
  if (ventaDescuentoEl) ventaDescuentoEl.textContent = fmt(desc);
  if (ventaTotalEl) ventaTotalEl.textContent = fmt(tot);
}

// ===== PDF helpers (jsPDF) =====
let lastComprobante = null;
function setLastComprobante(tipo, mov) {
  lastComprobante = { tipo, mov };
}

async function descargarComprobantePDF(tipo, options = {}) {
  try {
    const payload = lastComprobante && lastComprobante.tipo === tipo ? lastComprobante.mov : null;
    if (!payload) { alert('No hay comprobante disponible para exportar.'); return; }
    const esIngreso = tipo === 'ingreso';
    const jspdfNS = window.jspdf || {};
    const jsPDF = jspdfNS.jsPDF;
    if (!jsPDF || !window.jspdf) { alert('Generador PDF no disponible.'); return; }
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    let y = 40;
    // Marca
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    if (!esIngreso) { doc.setTextColor(59, 130, 246); }
    doc.text('IMPORTACIONES MB', 40, y);
    doc.setTextColor(0, 0, 0);
    y += 18;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.text(esIngreso ? 'Comprobante de Ingreso' : 'Comprobante de Venta', 40, y);
    // Meta
    const metaRight = [
      `N°: ${payload.comprobante.numero}`,
      `Fecha: ${payload.comprobante.fecha}`
    ];
    metaRight.forEach((t, i) => {
      doc.text(t, pageWidth - 40, 40 + (i * 14), { align: 'right' });
    });
    y += 18;
    // Entidad
    doc.setFont('helvetica', 'bold'); doc.text(esIngreso ? 'Proveedor:' : 'Cliente:', 40, y);
    doc.setFont('helvetica', 'normal'); doc.text(String(payload.comprobante.entidad || '-'), 110, y); y += 12;
    doc.setFont('helvetica', 'bold'); doc.text('Tipo:', 40, y);
    doc.setFont('helvetica', 'normal'); doc.text(esIngreso ? 'Ingreso' : 'Venta', 80, y); y += 10;

    // Tabla
    const head = esIngreso
      ? [[ 'SKU','Nombre','Categoría','Cantidad','Precio Compra','Subtotal' ]]
      : [[ 'SKU','Nombre','Cantidad','Precio Venta','Subtotal' ]];
    const body = payload.items.map(it => {
      if (esIngreso) {
        const subtotal = (it.precioCompra || 0) * (it.cantidad || 0);
        return [ it.sku || '', it.nombre || '', it.categoria || '', it.cantidad || 0, (it.precioCompra || 0).toFixed(2), subtotal.toFixed(2) ];
      } else {
        const subtotal = (it.precioVenta || 0) * (it.cantidad || 0);
        return [ it.item || it.sku || '', it.nombre || '', it.cantidad || 0, (it.precioVenta || 0).toFixed(2), subtotal.toFixed(2) ];
      }
    });
    const autoTableAvailable = typeof doc.autoTable === 'function';
    if (!autoTableAvailable) { alert('Módulo AutoTable no disponible.'); return; }
    doc.autoTable({
      head,
      body,
      startY: y + 10,
      styles: { font: 'helvetica', fontSize: 10, cellPadding: 6 },
      headStyles: { fillColor: [238,245,255], textColor: [11,58,119] },
      theme: 'grid',
      margin: { left: 40, right: 40 }
    });
    const afterTableY = doc.lastAutoTable.finalY || (y + 40);
    doc.setFont('helvetica', 'bold');
    if (!esIngreso) { doc.setTextColor(59, 130, 246); }
    doc.text(`Total: ${fmt(payload.total)}`, pageWidth - 40, afterTableY + 24, { align: 'right' });
    doc.setTextColor(0, 0, 0);

    const fileName = `${esIngreso ? 'Ingreso' : 'Venta'}_${payload.comprobante.numero}.pdf`;
    if (options.autoPrint) {
      // Abrir nueva pestaña e invocar impresión nativa del visor PDF
      if (doc.autoPrint) doc.autoPrint();
      const blobUrl = doc.output('bloburl');
      window.open(blobUrl, '_blank');
    } else if (options.open) {
      const url = doc.output('bloburl');
      window.open(url, '_blank');
    } else {
      doc.save(fileName);
    }
  } catch (err) {
    console.error('descargarComprobantePDF error', err);
    alert('No se pudo generar el PDF del comprobante.');
  }
}
function recalcVentaTotals() {
  const descuentoPct = parseFloat((document.getElementById('venDescPct')?.value || '0')) || 0;
  const filas = Array.from(venItemsDiv.querySelectorAll('tr'));
  const items = filas.map(r => ({
    cantidad: parseFloat(r.querySelector('.ven-cant')?.value || '0') || 0,
    precio: parseFloat(r.querySelector('.ven-pvent')?.value || '0') || 0
  }));
  // Update per-row subtotal
  filas.forEach((r, i) => {
    const sub = (items[i].cantidad * items[i].precio) || 0;
    const cell = r.querySelector('.ven-subtotal');
    if (cell) cell.textContent = fmt(sub);
  });
  const subtotal = items.reduce((a,i)=>a+(i.cantidad*i.precio),0);
  const descuento = subtotal * (descuentoPct/100);
  const total = subtotal - descuento;
  setVentaTotals(subtotal, descuento, total);
}

// Recalculate totals on input changes
document.getElementById('venDescPct')?.addEventListener('input', recalcVentaTotals);
// Delegate: whenever an input in venItems changes, recalc
document.getElementById('venItems')?.addEventListener('input', (e) => {
  if (e.target.matches('.ven-cant, .ven-pvent')) recalcVentaTotals();
});

// ===== CSV Upload Logic =====
function parseCSV(text) {
  // Robust-ish CSV parser: commas and semicolons; supports quotes
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  const rows = [];
  for (const line of lines) {
    const delimiter = line.includes(';') && !line.includes(',') ? ';' : ',';
    const cells = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === delimiter && !inQuotes) { cells.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    cells.push(cur.trim());
    rows.push(cells.map(c => c.replace(/^"|"$/g, '').trim()));
  }
  return rows;
}

function normalizeProductRow(row, headerMap) {
  // Map CSV columns to DB fields using headerMap
  const get = (key) => {
    const idx = headerMap[key];
    return idx !== undefined ? row[idx] : undefined;
  };
  const item = get('item');
  const nombre = get('nombre');
  const cejaStr = get('ceja');
  const senkataStr = get('senkata');
  const unidadRaw = get('unidad');
  const precioStr = get('precio');
  const categoriaRaw = get('categoria');
  const itemNorm = (item || '').trim();
  const nombreNorm = (nombre || '').trim();
  const ceja = Number(cejaStr || '0');
  const senkata = Number(senkataStr || '0');
  let unidad = (unidadRaw || 'PCS').trim().toUpperCase();
  if (!['PCS','DOC'].includes(unidad)) unidad = 'PCS';
  const precio = Number(precioStr || '0');
  const categoria = (categoriaRaw || 'General').trim() || 'General';
  const errors = [];
  if (!itemNorm) errors.push('ITEM vacío');
  if (!nombreNorm) errors.push('Nombre vacío');
  if (Number.isNaN(ceja) || ceja < 0) errors.push('CEJA inválido');
  if (Number.isNaN(senkata) || senkata < 0) errors.push('SENKATA inválido');
  if (Number.isNaN(precio) || precio < 0) errors.push('Precio inválido');
  return { item: itemNorm, nombre: nombreNorm, ceja: ceja || 0, senkata: senkata || 0, unidad, precio: precio || 0, categoria, errors };
}

let csvPreparedRows = [];

csvPreviewBtn?.addEventListener('click', async () => {
  if (!csvFileInput?.files?.[0]) { alert('Seleccione un archivo CSV'); return; }
  const file = csvFileInput.files[0];
  const text = await file.text();
  const rows = parseCSV(text);
  // Build header map (normalize names)
  let headerMap = { item: 0, nombre: 1, ceja: 2, senkata: 3, unidad: 4, precio: 5, categoria: 6 };
  const headerRow = rows[0].map(h => h.toLowerCase());
  const known = {
    item: ['item','sku','codigo','cod','producto'],
    nombre: ['nombre','name','descripcion','desc'],
    ceja: ['ceja','tienda','store','stock_tienda'],
    senkata: ['senkata','deposito','warehouse','stock_deposito'],
    unidad: ['unidad','unit','u'],
    precio: ['precio','price','pvp','venta'],
    categoria: ['categoria','category','cat']
  };
  const map = {};
  headerRow.forEach((h, i) => {
    for (const key of Object.keys(known)) {
      if (known[key].includes(h)) { map[key] = i; break; }
    }
  });
  // If we mapped at least item/nombre, use map, else assume fixed order
  if (map.item !== undefined && map.nombre !== undefined) {
    headerMap = map;
  }
  const looksHeader = Object.values(map).length > 0;
  const dataRows = looksHeader ? rows.slice(1) : rows;
  csvPreparedRows = dataRows.map(r => normalizeProductRow(r, headerMap));
  if (!csvPreviewWrap || !csvPreviewBody) return;
  csvPreviewWrap.hidden = false;
  csvPreviewBody.innerHTML = csvPreparedRows.map(r => `
    <tr>
      <td>${r.item}</td>
      <td>${r.nombre}</td>
      <td>${r.ceja}</td>
      <td>${r.senkata}</td>
      <td>${r.unidad}</td>
      <td>${fmt(r.precio)}</td>
      <td>${r.categoria}</td>
      <td>${r.errors.length ? `<span style="color:#b00">${r.errors.join('; ')}</span>` : '<span style="color:#0a6cff">OK</span>'}</td>
    </tr>
  `).join('');
});

csvUploadBtn?.addEventListener('click', async () => {
  if (!csvPreparedRows || csvPreparedRows.length === 0) { alert('Primero previsualice el CSV'); return; }
  const validRows = csvPreparedRows.filter(r => r.errors.length === 0);
  if (validRows.length === 0) { alert('No hay filas válidas para subir'); return; }
  // Strip non-DB fields before upsert
  const payload = validRows.map(r => ({
    item: r.item,
    nombre: r.nombre,
    ceja: r.ceja,
    senkata: r.senkata,
    unidad: r.unidad,
    precio: r.precio,
    categoria: r.categoria
  }));
  // Fallback-safe insert/update per row to avoid server 500s when constraints differ
  const chunkSize = 200; // smaller chunks to reduce load
  for (let i=0; i<payload.length; i+=chunkSize) {
    const chunk = payload.slice(i, i+chunkSize);
    for (const r of chunk) {
      try {
        // Try to find existing by (item,nombre)
        const { data: exists, error: selErr } = await supabase
          .from('products')
          .select('id')
          .eq('item', r.item)
          .eq('nombre', r.nombre)
          .limit(1);
        if (selErr) { console.error('CSV select error', selErr); continue; }
        if (exists && exists.length) {
          const id = exists[0].id;
          const { error: updErr } = await supabase
            .from('products')
            .update({ categoria: r.categoria, ceja: r.ceja, senkata: r.senkata, unidad: r.unidad, precio: r.precio })
            .eq('id', id);
          if (updErr) { console.error('CSV update error', updErr); }
        } else {
          const { error: insErr } = await supabase
            .from('products')
            .insert(r);
          if (insErr) { console.error('CSV insert error', insErr); }
        }
      } catch (rowErr) {
        console.error('CSV row exception', rowErr);
      }
    }
  }
  await refreshInventoryUI();
  alert(`Subida completada. Filas válidas: ${validRows.length}.`);
});

// Inventario UI
async function refreshCategoryFilter() {
  const list = await allProducts();
  const cats = Array.from(new Set(list.map(p => (p.categoria || 'General')))).sort();
  invCategoria.innerHTML = '<option value="">Todas</option>' + cats.map(c => `<option value="${c}">${c}</option>`).join('');
}

async function refreshInventoryUI() {
  await refreshCategoryFilter();
  const list = await allProducts();
  renderInventoryTable(list);
}

function renderInventoryTable(list) {
  invTabla.innerHTML = list.map(p => `
    <tr data-item="${p.item}">
      <td>${p.item}</td>
      <td>${p.nombre}</td>
      <td>${p.categoria || ''}</td>
      <td>${p.ceja ?? 0}</td>
      <td>${p.senkata ?? 0}</td>
      <td>${p.unidad || ''}</td>
      <td>${fmt(p.precio ?? 0)}</td>
      <td>
        <button class="secondary btn-edit">Editar</button>
        <button class="btn-delete">Eliminar</button>
        <button class="secondary btn-ver-ventas" title="Ver ventas de este producto">🔎</button>
      </td>
    </tr>
  `).join('');
  // Wire acciones
  invTabla.querySelectorAll('.btn-edit').forEach(btn => btn.addEventListener('click', onEditProduct));
  invTabla.querySelectorAll('.btn-delete').forEach(btn => btn.addEventListener('click', onDeleteProduct));
  invTabla.querySelectorAll('.btn-ver-ventas').forEach(btn => btn.addEventListener('click', onVerVentasProducto));
}

async function onVerVentasProducto(e) {
  const tr = e.target.closest('tr');
  const item = tr?.dataset?.item;
  if (!item) return;
  await showProductoVentasModal(item);
}

async function showProductoVentasModal(item) {
  try {
    // Get product for title context
    const prod = await findProductByITEM(item);
    const titulo = document.getElementById('productoVentasTitulo');
    if (titulo) titulo.textContent = `Ventas del producto: ${prod?.nombre || item} (${item})`;

    // Fetch all sales_items entries for this item
    const { data: si, error: siErr } = await supabase
      .from('sales_items')
      .select('*')
      .ilike('item', item)
      .order('id', { ascending: true });
    const body = document.getElementById('productoVentasBody');
    if (siErr) { console.error(siErr); body.innerHTML = '<p>Error al cargar ventas del producto.</p>'; return openProductoVentasModal(); }
    if (!si || si.length === 0) { body.innerHTML = '<p>No hay ventas registradas para este producto.</p>'; return openProductoVentasModal(); }

    // Fetch related sales rows
    const saleIds = Array.from(new Set(si.map(r => r.sale_id))).filter(Boolean);
    const { data: sales, error: sErr } = await supabase
      .from('sales')
      .select('*')
      .in('id', saleIds)
      .order('fecha', { ascending: false });
    if (sErr) { console.error(sErr); body.innerHTML = '<p>Error al cargar ventas del producto.</p>'; return openProductoVentasModal(); }
    const salesMap = new Map((sales || []).map(s => [s.id, s]));

    // Build rows combining sale info and quantities/prices per occurrence
    const rows = si
      .map(r => ({ r, s: salesMap.get(r.sale_id) }))
      .filter(x => !!x.s)
      .sort((a, b) => (new Date(b.s.fecha) - new Date(a.s.fecha)) || (b.s.id - a.s.id));

    if (rows.length === 0) { body.innerHTML = '<p>No hay ventas válidas encontradas para este producto.</p>'; return openProductoVentasModal(); }

    // Detect anuladas: by sales.estado and movements "Anulación comprobante <numero>"
    const anuladasSet = new Set((sales || []).filter(s => s.estado === 'anulada').map(s => String(s.numero)));
    try {
      const saleNumbers = Array.from(new Set((sales || []).map(s => String(s.numero))));
      if (saleNumbers.length) {
        const detalles = saleNumbers.map(n => `Anulación comprobante ${n}`);
        const { data: annMovs } = await supabase.from('movements').select('detalle').in('detalle', detalles);
        if (Array.isArray(annMovs)) {
          annMovs.forEach(m => {
            const n = String(m.detalle || '').replace('Anulación comprobante ', '');
            if (n) anuladasSet.add(n);
          });
        }
      }
    } catch (annErr) { console.warn('annul detect warn', annErr); }

    const nonAnuladasRows = rows.filter(({ s }) => !anuladasSet.has(String(s.numero)) && s.estado !== 'anulada');
    const totalCantidad = nonAnuladasRows.reduce((acc, x) => acc + (x.r.cantidad || 0), 0);
    const totalMonto = nonAnuladasRows.reduce((acc, x) => acc + (x.r.subtotal || (x.r.cantidad * x.r.precio) || 0), 0);

    body.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>N°</th>
              <th>Cliente</th>
              <th>Cantidad</th>
              <th>Precio</th>
              <th>Subtotal</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(({ r, s }) => {
              const isAnulada = anuladasSet.has(String(s.numero)) || s.estado === 'anulada';
              const cls = isAnulada ? 'venta-anulada' : '';
              return `
              <tr class="${cls}">
                <td>${s.fecha || ''}</td>
                <td>${s.numero || ''}</td>
                <td>${s.cliente || ''}</td>
                <td>${r.cantidad ?? ''}</td>
                <td>${fmt(r.precio ?? 0)}</td>
                <td>${fmt((r.subtotal ?? (r.cantidad * r.precio)) || 0)}</td>
              </tr>`;
            }).join('')}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="3" style="text-align:right"><strong>Totales:</strong></td>
              <td><strong>${totalCantidad}</strong></td>
              <td></td>
              <td><strong>${fmt(totalMonto)}</strong></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p class="note">Las filas en rojo pertenecen a ventas anuladas y no se suman a los totales.</p>
    `;

    openProductoVentasModal();
  } catch (e) {
    console.error('producto ventas modal error', e);
    const body = document.getElementById('productoVentasBody');
    if (body) body.innerHTML = '<p>Error inesperado al cargar las ventas del producto.</p>';
    openProductoVentasModal();
  }
}

function openProductoVentasModal() {
  const modal = document.getElementById('productoVentasModal');
  if (!modal) return;
  modal.hidden = false;
  // Wire close buttons
  modal.querySelectorAll('.modal-close').forEach(btn => btn.onclick = () => { modal.hidden = true; });
}

async function applyFilters() {
  const q = invBuscar.value.trim().toLowerCase();
  const cat = invCategoria.value;
  const smin = invStockMin.value ? parseInt(invStockMin.value, 10) : null;
  const smax = invStockMax.value ? parseInt(invStockMax.value, 10) : null;
  let list = await allProducts();
  if (q) list = list.filter(p => (p.item||'').toLowerCase().includes(q) || (p.nombre||'').toLowerCase().includes(q));
  if (cat) list = list.filter(p => (p.categoria || '') === cat);
  if (smin !== null) list = list.filter(p => ((p.ceja ?? 0) + (p.senkata ?? 0)) >= smin);
  if (smax !== null) list = list.filter(p => ((p.ceja ?? 0) + (p.senkata ?? 0)) <= smax);
  renderInventoryTable(list);
}

invAplicar.addEventListener('click', (e) => { e.preventDefault(); applyFilters(); });
invReiniciar.addEventListener('click', (e) => { e.preventDefault(); invBuscar.value=''; invCategoria.value=''; invStockMin.value=''; invStockMax.value=''; refreshInventoryUI(); });

// Exportar inventario a Excel (xlsx)
invExportExcel?.addEventListener('click', async () => {
  try {
    if (!window.XLSX) { alert('Exportador Excel no disponible.'); return; }
    const list = await allProducts();
    if (!list || list.length === 0) { alert('No hay datos de inventario para exportar.'); return; }
    const data = list.map(p => ({
      'ITEM': p.item,
      'Nombre': p.nombre,
      'Categoría': p.categoria || 'General',
      'CEJA': p.ceja ?? 0,
      'SENKATA': p.senkata ?? 0,
      'Unidad': p.unidad || 'PCS',
      'Precio (Bs)': Number(p.precio ?? 0)
    }));
    const ws = XLSX.utils.json_to_sheet(data, { header: ['ITEM','Nombre','Categoría','CEJA','SENKATA','Unidad','Precio (Bs)'] });
    ws['!cols'] = [
      { wch: 16 }, // ITEM
      { wch: 28 }, // Nombre
      { wch: 16 }, // Categoría
      { wch: 10 }, // CEJA
      { wch: 12 }, // SENKATA
      { wch: 10 }, // Unidad
      { wch: 12 }  // Precio
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Inventario');
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth()+1).padStart(2,'0');
    const d = String(today.getDate()).padStart(2,'0');
    const fileName = `Inventario_${y}-${m}-${d}.xlsx`;
    XLSX.writeFile(wb, fileName);
  } catch (e) {
    console.error('excel export error', e);
    alert('No se pudo generar el archivo Excel.');
  }
});

async function onEditProduct(e) {
  const tr = e.target.closest('tr');
  const item = tr.dataset.item;
  const list = await allProducts();
  const p = list.find(x => x.item === item);
  tr.innerHTML = `
    <td>${p.item}</td>
    <td><input type="text" value="${p.nombre}" class="edit-nombre" /></td>
    <td><input type="text" value="${p.categoria || ''}" class="edit-cat" /></td>
    <td><input type="number" value="${p.ceja || 0}" min="0" class="edit-ceja" /></td>
    <td><input type="number" value="${p.senkata || 0}" min="0" class="edit-senkata" /></td>
    <td><input type="text" value="${p.unidad || ''}" class="edit-unidad" /></td>
    <td><input type="number" value="${p.precio || 0}" min="0" step="0.01" class="edit-precio" /></td>
    <td>
      <button class="primary btn-save">Guardar</button>
      <button class="btn-cancel">Cancelar</button>
    </td>
  `;
  tr.querySelector('.btn-save').addEventListener('click', async () => {
    const updated = {
      id: p.id,
      item: p.item,
      nombre: tr.querySelector('.edit-nombre').value.trim(),
      categoria: tr.querySelector('.edit-cat').value.trim() || 'General',
      ceja: parseInt(tr.querySelector('.edit-ceja').value || '0', 10),
      senkata: parseInt(tr.querySelector('.edit-senkata').value || '0', 10),
      unidad: tr.querySelector('.edit-unidad').value.trim() || 'PCS',
      precio: parseFloat(tr.querySelector('.edit-precio').value || '0')
    };
    await upsertProduct(updated);
    await refreshInventoryUI();
  });
  tr.querySelector('.btn-cancel').addEventListener('click', () => refreshInventoryUI());
}
// Ventas: historial
const ventasHistTablaBody = document.getElementById('ventasHistTabla')?.querySelector('tbody');
const ventasFiltroRango = document.getElementById('ventasFiltroRango');
const ventasFiltroDesde = document.getElementById('ventasFiltroDesde');
const ventasFiltroHasta = document.getElementById('ventasFiltroHasta');
const ventasFiltroCliente = document.getElementById('ventasFiltroCliente');
const ventasFiltroAplicar = document.getElementById('ventasFiltroAplicar');
const ventasFiltroLimpiar = document.getElementById('ventasFiltroLimpiar');
const ventasTotalFooter = document.getElementById('ventasTotalFooter');

function getDateRange() {
  const today = new Date();
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let desde = ventasFiltroDesde?.value ? new Date(ventasFiltroDesde.value) : null;
  let hasta = ventasFiltroHasta?.value ? new Date(ventasFiltroHasta.value) : null;
  const rango = ventasFiltroRango?.value || 'todo';
  if (!desde && !hasta) {
    if (rango === 'hoy') {
      desde = startOfDay;
      hasta = new Date(startOfDay.getTime() + 24*60*60*1000 - 1);
    } else if (rango === 'semana') {
      desde = new Date(today.getTime() - 7*24*60*60*1000);
      hasta = today;
    } else if (rango === 'mes') {
      desde = new Date(today.getTime() - 30*24*60*60*1000);
      hasta = today;
    }
  }
  // Format as YYYY-MM-DD for SQL
  const fmtDate = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  return {
    desde: desde ? fmtDate(desde) : null,
    hasta: hasta ? fmtDate(hasta) : null,
    rango
  };
}

async function refreshVentasHistorial() {
  if (!ventasHistTablaBody) return;
  try {
    const range = getDateRange();
    let query = supabase.from('sales').select('*');
    if (range.desde) query = query.gte('fecha', range.desde);
    if (range.hasta) query = query.lte('fecha', range.hasta);
    const clienteQ = ventasFiltroCliente?.value?.trim();
    if (clienteQ) query = query.ilike('cliente', `%${clienteQ}%`);
    const { data, error } = await query.order('fecha', { ascending: false }).limit(500);
    if (error) { console.error('sales fetch error', error); ventasHistTablaBody.innerHTML = `<tr><td colspan="7">Error al cargar ventas.</td></tr>`; return; }
    if (!data || data.length === 0) {
      ventasHistTablaBody.innerHTML = `<tr><td colspan="7">No hay ventas para el rango seleccionado.</td></tr>`;
      if (ventasTotalFooter) ventasTotalFooter.innerHTML = '<strong>Total ventas (sin anuladas):</strong> Bs 0.00';
      return;
    }
    // Build set of annulled sales based on movements
    let anuladasSet = new Set();
    try {
      const annDetailStrings = data.map(s => `Anulación comprobante ${s.numero}`);
      let annMovs = [];
      const chunkSize = 100;
      for (let i = 0; i < annDetailStrings.length; i += chunkSize) {
        const chunk = annDetailStrings.slice(i, i + chunkSize);
        const { data: annChunk, error: annErr } = await supabase
          .from('movements')
          .select('detalle')
          .in('detalle', chunk);
        if (!annErr && annChunk) annMovs = annMovs.concat(annChunk);
      }
      anuladasSet = new Set(annMovs.map(m => String(m.detalle || '').replace('Anulación comprobante ', '')));
    } catch {}

    ventasHistTablaBody.innerHTML = data.map(s => {
      const isAnuladaRow = (s.estado === 'anulada') || anuladasSet.has(String(s.numero));
      const cls = isAnuladaRow ? 'venta-anulada' : '';
      return `
      <tr class="${cls}">
        <td>${s.fecha}</td>
        <td>${s.numero}</td>
        <td>${s.cliente}</td>
        <td>${fmt(s.subtotal)}</td>
        <td>${Number(s.descuento_pct || 0).toFixed(2)}%</td>
        <td>${fmt(s.descuento || 0)}</td>
        <td>${fmt(s.total || 0)}</td>
        <td><button type="button" class="secondary btn-ver-detalles" data-sale-id="${s.id}">Ver detalles</button></td>
      </tr>`;
    }).join('');
    // wire details buttons
    document.querySelectorAll('.btn-ver-detalles').forEach(btn => btn.addEventListener('click', onVerDetallesVenta));

    // Compute totals excluding annulled using precomputed set
    try {
      const nonAnuladas = (data || []).filter(s => (s.estado !== 'anulada') && !anuladasSet.has(String(s.numero)));
      const totalPeriodo = nonAnuladas.reduce((a, s) => a + (s.total || 0), 0);
      if (ventasTotalFooter) {
        const singleDay = range.rango === 'hoy' || (range.desde && range.hasta && range.desde === range.hasta);
        ventasTotalFooter.innerHTML = singleDay
          ? `<strong>Total del día (sin anuladas):</strong> ${fmt(totalPeriodo)}`
          : `<strong>Total del periodo (sin anuladas):</strong> ${fmt(totalPeriodo)}`;
      }
    } catch (totErr) {
      console.error('error computing totals', totErr);
      if (ventasTotalFooter) ventasTotalFooter.innerHTML = '<strong>Total ventas (sin anuladas):</strong> Bs 0.00';
    }
  } catch (e) { console.error('ventas historial exception', e); ventasHistTablaBody.innerHTML = `<tr><td colspan="7">Error inesperado cargando ventas.</td></tr>`; }
}

async function onVerDetallesVenta(e) {
  const saleId = e.currentTarget.dataset.saleId;
  try {
    const { data: sale, error: saleErr } = await supabase.from('sales').select('*').eq('id', saleId).maybeSingle();
    const { data, error } = await supabase.from('sales_items').select('*').eq('sale_id', saleId).order('id', { ascending: true });
    if (saleErr || error) { alert('Error cargando detalles'); return; }
    // Detect if already annulled via movements record
    let isAnulada = false;
    try {
      const { data: ann } = await supabase.from('movements').select('id').eq('detalle', `Anulación comprobante ${sale?.numero || ''}`).limit(1);
      isAnulada = Array.isArray(ann) && ann.length > 0;
    } catch {}

    const modal = document.getElementById('ventaDetallesModal');
    const body = document.getElementById('ventaDetallesBody');
    const rows = (data||[]).map(it => `
      <tr data-item-id="${it.id}" data-item-sku="${it.item}">
        <td>${it.item}</td>
        <td>${it.nombre}</td>
        <td class="cell-cant" style="text-align:right">${it.cantidad}</td>
        <td class="cell-precio" style="text-align:right">${fmt(it.precio)}</td>
        <td class="cell-subtotal" style="text-align:right">${fmt(it.subtotal)}</td>
        <td class="cell-actions" style="text-align:right"></td>
      </tr>
    `).join('');
    const subtotal = sale?.subtotal ?? (data||[]).reduce((a,i)=>a+(i.subtotal||0),0);
    const descuentoPct = sale?.descuento_pct || 0;
    const descuentoBs = sale?.descuento || (subtotal * descuentoPct/100);
    const total = sale?.total ?? (subtotal - descuentoBs);

    body.innerHTML = `
      <div class="sale-meta">
        <div><strong>N°:</strong> ${sale?.numero || '-'}</div>
        <div><strong>Fecha:</strong> ${sale?.fecha || '-'}</div>
        <div><strong>Cliente:</strong> ${sale?.cliente || '-'}</div>
        <div style="grid-column: 1 / -1"><strong>Estado:</strong> ${isAnulada ? '<span style="color:#991b1b;font-weight:700">ANULADA</span>' : '<span style="color:#0b3a77;font-weight:700">VIGENTE</span>'}</div>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr><th>ITEM</th><th>Nombre</th><th>Cant.</th><th>Precio</th><th>Subtotal</th></tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="5">Sin items</td></tr>'}</tbody>
        </table>
      </div>
      <div class="sale-totals">
        <div>Subtotal: ${fmt(subtotal)}</div>
        <div>Descuento: ${Number(descuentoPct).toFixed(2)}% (${fmt(descuentoBs)})</div>
        <div>Total: ${fmt(total)}</div>
      </div>
    `;
    // open modal
    modal.hidden = false;
    const closes = modal.querySelectorAll('.modal-close');
    closes.forEach(btn => btn.onclick = () => { modal.hidden = true; });
    // center and enable dragging
    const card = modal.querySelector('.modal-card');
    const header = modal.querySelector('.modal-header');
    card.style.left = '50%';
    card.style.top = '50%';
    card.style.transform = 'translate(-50%, -50%)';
    let isDragging = false;
    let offsetX = 0, offsetY = 0;
    function onMouseMove(ev) {
      if (!isDragging) return;
      card.style.left = `${ev.clientX - offsetX}px`;
      card.style.top = `${ev.clientY - offsetY}px`;
      card.style.transform = 'none';
    }
    function onMouseUp() {
      if (!isDragging) return;
      isDragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }
    header.onmousedown = (ev) => {
      const rect = card.getBoundingClientRect();
      isDragging = true;
      offsetX = ev.clientX - rect.left;
      offsetY = ev.clientY - rect.top;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      ev.preventDefault();
    };
    // actions
    const reimpBtn = document.getElementById('ventaDetallesReimprimir');
    const pdfBtn = document.getElementById('ventaDetallesPDF');
    const anularBtn = document.getElementById('ventaDetallesAnular');
    const editBtn = document.getElementById('ventaDetallesEditar');
    const saveBtn = document.getElementById('ventaDetallesGuardar');
    const cancelBtn = document.getElementById('ventaDetallesCancelar');
    const addItemBtn = document.getElementById('ventaDetallesAgregarItem');
    // Reset button states each time modal opens
    if (reimpBtn) reimpBtn.disabled = false;
    if (pdfBtn) pdfBtn.disabled = false;
    if (anularBtn) { anularBtn.disabled = false; anularBtn.textContent = 'Anular venta'; }
    if (editBtn) editBtn.disabled = false;
    if (saveBtn) saveBtn.disabled = true;
    if (addItemBtn) addItemBtn.disabled = true;
    if (cancelBtn) cancelBtn.hidden = true;
    if (isAnulada) {
      if (reimpBtn) reimpBtn.disabled = true;
      if (pdfBtn) pdfBtn.disabled = true;
      if (anularBtn) { anularBtn.disabled = true; anularBtn.textContent = 'Venta anulada'; }
      if (editBtn) editBtn.disabled = true;
      if (saveBtn) saveBtn.disabled = true;
      if (addItemBtn) addItemBtn.disabled = true;
    }

    let isEditing = false;
    function recalcModalTotals() {
      // Compute subtotal from table rows
      const tbody = body.querySelector('tbody');
      let subtotalLive = 0;
      Array.from(tbody.querySelectorAll('tr')).forEach(tr => {
        if (tr.dataset.removed === '1') return;
        const subTextEl = tr.querySelector('.cell-subtotal');
        let subNum = 0;
        if (isEditing) {
          const cant = parseFloat(tr.querySelector('.edit-cant')?.value || '0') || 0;
          const precio = parseFloat(tr.querySelector('.edit-precio')?.value || '0') || 0;
          subNum = cant * precio;
          if (subTextEl) subTextEl.textContent = fmt(subNum);
        } else {
          // parse formatted text
          subNum = parseFloat(String(subTextEl?.textContent || '').replace(/[^0-9.]/g,'')) || 0;
        }
        subtotalLive += subNum;
      });
      const descPctInput = document.getElementById('editDescPct');
      const descPct = descPctInput ? (parseFloat(descPctInput.value || '0') || 0) : (sale?.descuento_pct || 0);
      const descuentoBs = subtotalLive * (descPct/100);
      const totalLive = subtotalLive - descuentoBs;
      const totalsEl = body.querySelector('.sale-totals');
      if (totalsEl) {
        totalsEl.innerHTML = `
          <div>Subtotal: ${fmt(subtotalLive)}</div>
          <div>Descuento: ${Number(descPct).toFixed(2)}% (${fmt(descuentoBs)}) ${isEditing ? '<button type="button" id="editDescClear" class="secondary" style="margin-left:8px">Quitar</button>' : ''}</div>
          <div>Total: ${fmt(totalLive)}</div>
        `;
        if (isEditing) {
          const clearBtn = document.getElementById('editDescClear');
          clearBtn.onclick = () => { const inp = document.getElementById('editDescPct'); if (inp) { inp.value = '0'; recalcModalTotals(); } };
        }
      }
    }

    function enterEditMode() {
      if (isEditing) return;
      isEditing = true;
      // Disable actions while editing
      reimpBtn.disabled = true; pdfBtn.disabled = true; anularBtn.disabled = true; editBtn.disabled = true; addItemBtn.disabled = false;
      saveBtn.disabled = false; cancelBtn.hidden = true; // keep cancel hidden until a change? show it:
      cancelBtn.hidden = false;
      // Turn cantidad/precio cells into inputs
      const tbody = body.querySelector('tbody');
      Array.from(tbody.querySelectorAll('tr')).forEach(tr => {
        const cantCell = tr.querySelector('.cell-cant');
        const precioCell = tr.querySelector('.cell-precio');
        const subtotalCell = tr.querySelector('.cell-subtotal');
        const actionsCell = tr.querySelector('.cell-actions');
        const cantVal = parseFloat(cantCell.textContent || '0') || 0;
        const precioVal = parseFloat(String(precioCell.textContent || '').replace(/[^0-9.]/g,'')) || 0;
        cantCell.innerHTML = `<input type="number" class="edit-cant" min="0" value="${cantVal}">`;
        precioCell.innerHTML = `<input type="number" class="edit-precio" min="0" step="0.01" value="${precioVal.toFixed(2)}">`;
        subtotalCell.innerHTML = fmt(cantVal * precioVal);
        if (actionsCell) actionsCell.innerHTML = `<button type="button" class="row-remove btn-danger">Quitar</button>`;
      });
      // Listen for changes to update subtotal live
      tbody.addEventListener('input', (ev) => {
        if (!isEditing) return;
        const tr = ev.target.closest('tr');
        const cant = parseFloat(tr.querySelector('.edit-cant')?.value || '0') || 0;
        const precio = parseFloat(tr.querySelector('.edit-precio')?.value || '0') || 0;
        tr.querySelector('.cell-subtotal').textContent = fmt(cant * precio);
        recalcModalTotals();
      });
      // Row remove
      tbody.addEventListener('click', (ev) => {
        if (!isEditing) return;
        const btn = ev.target.closest('.row-remove');
        if (btn) {
          const tr = btn.closest('tr');
          tr.dataset.removed = '1';
          // visually dim
          tr.style.opacity = '0.6';
          // disable inputs
          tr.querySelectorAll('input').forEach(inp => inp.disabled = true);
          recalcModalTotals();
        }
      });
      // Discount editor
      const totalsEl = body.querySelector('.sale-totals');
      if (totalsEl) {
        totalsEl.insertAdjacentHTML('afterbegin', `<div style="grid-column: 1 / -1">Descuento (%): <input type="number" id="editDescPct" min="0" max="100" step="0.01" value="${Number(sale?.descuento_pct||0).toFixed(2)}"></div>`);
        const descInp = document.getElementById('editDescPct');
        descInp.addEventListener('input', () => recalcModalTotals());
      }
      recalcModalTotals();
    }
    function exitEditMode(refresh = false) {
      isEditing = false;
      reimpBtn.disabled = false; pdfBtn.disabled = false; anularBtn.disabled = false; editBtn.disabled = false; addItemBtn.disabled = true;
      saveBtn.disabled = true; cancelBtn.hidden = true;
      if (refresh) onVerDetallesVenta({ currentTarget: { dataset: { saleId } } });
    }
    editBtn.onclick = () => enterEditMode();
    cancelBtn.onclick = () => exitEditMode(true);

    saveBtn.onclick = async () => {
      if (!isEditing) return;
      try {
        // Collect edits
        const tbody = body.querySelector('tbody');
        const rows = Array.from(tbody.querySelectorAll('tr'));
        const edits = rows.filter(tr => !tr.classList.contains('row-new') && tr.dataset.itemId).map(tr => {
          const id = tr.dataset.itemId;
          const sku = tr.dataset.itemSku;
          const old = data.find(d => String(d.id) === String(id));
          const newCant = parseInt(tr.querySelector('.edit-cant')?.value || String(old.cantidad || 0), 10);
          const newPrecio = parseFloat(tr.querySelector('.edit-precio')?.value || String(old.precio || 0));
          return { id, sku, oldCant: old.cantidad || 0, newCant, oldPrecio: old.precio || 0, newPrecio };
        });
        const removedIds = rows.filter(tr => tr.dataset.itemId && tr.dataset.removed === '1').map(tr => tr.dataset.itemId);
        const newRows = rows.filter(tr => tr.classList.contains('row-new'));
        // Validate inventory deltas
        const products = await allProducts();
        for (const ed of edits) {
          const p = products.find(x => (x.item||'').toLowerCase() === (ed.sku||'').toLowerCase());
          if (!p) { alert(`Producto no encontrado: ${ed.sku}`); return; }
          const delta = ed.newCant - ed.oldCant;
          if (delta > 0 && (p.ceja || 0) < delta) { alert(`CEJA insuficiente para ${p.item}. Disponible: ${p.ceja}, requiere adicional: ${delta}`); return; }
        }
        for (const tr of newRows) {
          const sku = tr.querySelector('.edit-sku')?.value.trim();
          const cant = parseInt(tr.querySelector('.edit-cant')?.value || '0', 10);
          const precio = parseFloat(tr.querySelector('.edit-precio')?.value || '0');
          if (!sku || cant <= 0 || precio < 0) { alert('Complete SKU, cantidad y precio en el nuevo ítem'); return; }
          const p = products.find(x => (x.item||'').toLowerCase() === sku.toLowerCase());
          if (!p) { alert(`Producto no encontrado: ${sku}`); return; }
          if ((p.ceja || 0) < cant) { alert(`CEJA insuficiente para ${p.item}. Disponible: ${p.ceja}, requiere: ${cant}`); return; }
        }
        // Apply inventory updates and persist sales_items
        for (const ed of edits) {
          const p = products.find(x => (x.item||'').toLowerCase() === (ed.sku||'').toLowerCase());
          const delta = ed.newCant - ed.oldCant;
          if (delta !== 0) {
            await upsertProduct({ id: p.id, item: p.item, nombre: p.nombre, categoria: p.categoria, unidad: p.unidad, precio: p.precio, ceja: (p.ceja || 0) - delta, senkata: p.senkata || 0 });
          }
          await supabase.from('sales_items').update({ cantidad: ed.newCant, precio: ed.newPrecio, subtotal: ed.newCant * ed.newPrecio }).eq('id', ed.id);
        }
        // Removed rows: inventory rollback and delete
        for (const rid of removedIds) {
          const old = data.find(d => String(d.id) === String(rid));
          const p = products.find(x => (x.item||'').toLowerCase() === (old.item||'').toLowerCase());
          if (p) {
            await upsertProduct({ id: p.id, item: p.item, nombre: p.nombre, categoria: p.categoria, unidad: p.unidad, precio: p.precio, ceja: (p.ceja || 0) + (old.cantidad || 0), senkata: p.senkata || 0 });
          }
          await supabase.from('sales_items').delete().eq('id', rid);
        }
        // New rows: inventory apply and insert
        for (const tr of newRows) {
          const sku = tr.querySelector('.edit-sku')?.value.trim();
          const cant = parseInt(tr.querySelector('.edit-cant')?.value || '0', 10);
          const precio = parseFloat(tr.querySelector('.edit-precio')?.value || '0');
          const p = products.find(x => (x.item||'').toLowerCase() === sku.toLowerCase());
          await upsertProduct({ id: p.id, item: p.item, nombre: p.nombre, categoria: p.categoria, unidad: p.unidad, precio: p.precio, ceja: (p.ceja || 0) - cant, senkata: p.senkata || 0 });
          await supabase.from('sales_items').insert({ sale_id: saleId, item: p.item, nombre: p.nombre, cantidad: cant, precio, subtotal: cant * precio });
        }
        // Recompute totals and update sale
        const { data: newItems } = await supabase.from('sales_items').select('*').eq('sale_id', saleId);
        const newSubtotal = (newItems || []).reduce((a,i)=>a+(i.subtotal||0),0);
        const descPctInput = document.getElementById('editDescPct');
        const descPct = descPctInput ? (parseFloat(descPctInput.value || '0') || 0) : (sale?.descuento_pct || 0);
        const newDescuento = newSubtotal * (descPct/100);
        const newTotal = newSubtotal - newDescuento;
        await supabase.from('sales').update({ subtotal: newSubtotal, descuento: newDescuento, descuento_pct: descPct, total: newTotal }).eq('id', saleId);
        // Log adjustment movement
        const totalDelta = (newTotal - (sale?.total || 0));
        const qtyDelta = edits.reduce((a,ed)=>a + (ed.newCant - ed.oldCant), 0);
        const addQty = newRows.reduce((a,tr)=>a + (parseInt(tr.querySelector('.edit-cant')?.value || '0', 10) || 0), 0);
        const remQty = removedIds.reduce((a,rid)=>{ const old = data.find(d => String(d.id)===String(rid)); return a + (old?.cantidad || 0); }, 0);
        const totalQtyDelta = qtyDelta + addQty - remQty;
        await addMovement({ tipo: 'venta', fecha: sale.fecha, item: '-', nombre: sale.cliente + ' (AJUSTE)', cantidad: totalQtyDelta, detalle: `Ajuste comprobante ${sale.numero}`, total: totalDelta, descuento: 0 });
        alert('Cambios guardados. Inventario y comprobante actualizados.');
        exitEditMode(true);
        await refreshInventoryUI();
        await refreshVentasHistorial();
      } catch (err) {
        console.error('guardar edicion error', err);
        alert('No se pudieron guardar los cambios.');
      }
    };

    // Add item flow (edit mode only)
    addItemBtn.onclick = async () => {
      if (!isEditing) return;
      const tbody = body.querySelector('tbody');
      const tr = document.createElement('tr');
      tr.classList.add('row-new');
      tr.innerHTML = `
        <td><input type="text" class="edit-sku" list="datalistProductos" placeholder="ITEM" /></td>
        <td class="cell-nombre">-</td>
        <td class="cell-cant" style="text-align:right"><input type="number" class="edit-cant" min="0" value="0"></td>
        <td class="cell-precio" style="text-align:right"><input type="number" class="edit-precio" min="0" step="0.01" value="0.00"></td>
        <td class="cell-subtotal" style="text-align:right">${fmt(0)}</td>
        <td class="cell-actions" style="text-align:right"><button type="button" class="row-remove btn-danger">Quitar</button></td>
      `;
      tbody.appendChild(tr);
      const skuInput = tr.querySelector('.edit-sku');
      skuInput.addEventListener('change', async () => {
        const val = skuInput.value.trim();
        const p = await findProductByITEM(val);
        const nombreCell = tr.querySelector('.cell-nombre');
        const precioInput = tr.querySelector('.edit-precio');
        if (p) { nombreCell.textContent = p.nombre || '-'; precioInput.value = (p.precio || 0).toFixed(2); }
        else { nombreCell.textContent = 'No encontrado'; precioInput.value = '0.00'; }
        recalcModalTotals();
      });
      tr.addEventListener('input', () => recalcModalTotals());
    };
    reimpBtn.onclick = async () => {
      try {
        const mov = { comprobante: { numero: sale.numero, fecha: sale.fecha, entidad: sale.cliente }, items: data.map(di => ({ item: di.item, nombre: di.nombre, cantidad: di.cantidad, precioVenta: di.precio })), total: total };
        setLastComprobante('venta', mov);
        await descargarComprobantePDF('venta', { autoPrint: true });
      } catch (e) { console.error('reimprimir error', e); alert('No se pudo reimprimir.'); }
    };
    pdfBtn.onclick = async () => {
      try {
        const mov = { comprobante: { numero: sale.numero, fecha: sale.fecha, entidad: sale.cliente }, items: data.map(di => ({ item: di.item, nombre: di.nombre, cantidad: di.cantidad, precioVenta: di.precio })), total: total };
        setLastComprobante('venta', mov);
        await descargarComprobantePDF('venta');
      } catch (e) { console.error('pdf error', e); alert('No se pudo generar el PDF.'); }
    };
    anularBtn.onclick = async () => {
      if (!confirm('¿Seguro que desea anular esta venta? Se revertirá el stock.')) return;
      try {
        const products = await allProducts();
        for (const it of data) {
          const p = products.find(x => (x.item||'').toLowerCase() === (it.item||'').toLowerCase());
          if (p) {
            await upsertProduct({ id: p.id, item: p.item, nombre: p.nombre, categoria: p.categoria, unidad: p.unidad, precio: p.precio, ceja: (p.ceja||0) + (it.cantidad||0), senkata: p.senkata||0 });
          }
        }
        try { await supabase.from('sales').update({ estado: 'anulada' }).eq('id', saleId); } catch {}
        await addMovement({ tipo: 'venta', fecha: sale.fecha, item: '-', nombre: sale.cliente + ' (ANULADA)', cantidad: data.reduce((a,i)=>a+(i.cantidad||0),0), detalle: `Anulación comprobante ${sale.numero}`, total: 0, descuento: 0 });
        modal.hidden = true;
        await refreshInventoryUI();
        await refreshVentasHistorial();
        alert('Venta anulada y stock revertido.');
      } catch (e) { console.error('anular error', e); alert('No se pudo anular la venta.'); }
    };
    // backdrop and esc
    modal.onclick = (ev) => { if (ev.target === modal) modal.hidden = true; };
    document.addEventListener('keydown', function escClose(ev){ if (ev.key==='Escape'){ modal.hidden=true; document.removeEventListener('keydown', escClose); } });
  } catch (err) { console.error('ver detalles error', err); }
}

ventasFiltroAplicar?.addEventListener('click', async () => { await refreshVentasHistorial(); });
ventasFiltroLimpiar?.addEventListener('click', async () => {
  if (ventasFiltroRango) ventasFiltroRango.value = 'todo';
  if (ventasFiltroDesde) ventasFiltroDesde.value = '';
  if (ventasFiltroHasta) ventasFiltroHasta.value = '';
  if (ventasFiltroCliente) ventasFiltroCliente.value = '';
  await refreshVentasHistorial();
});

async function onDeleteProduct(e) {
  const tr = e.target.closest('tr');
  const item = tr.dataset.item;
  if (!confirm(`¿Eliminar producto ${item}?`)) return;
  const { error } = await supabase.from('products').delete().eq('item', item);
  if (error) console.error(error);
  await refreshInventoryUI();
}

// Admin: roles y accesos
async function getRolesData() {
  const { data } = await supabase.from('roles_matrix').select('data_json').limit(1).maybeSingle();
  return data?.data_json || { roles: [], modules: [], matrix: {} };
}
async function saveRolesData(d) { await supabase.from('roles_matrix').update({ data_json: d }).neq('id', 0); }

async function renderAdminMatrix() {
  const d = await getRolesData();
  const thead = adminTabla.querySelector('thead');
  const tbody = adminTabla.querySelector('tbody');
  thead.innerHTML = `<tr><th>Módulo</th>${d.roles.map(r => `<th>${r}</th>`).join('')}</tr>`;
  tbody.innerHTML = d.modules.map(m => {
    const cells = d.roles.map(r => {
      const checked = d.matrix[r]?.[m] ? 'checked' : '';
      return `<td><input type="checkbox" data-role="${r}" data-mod="${m}" ${checked}></td>`;
    }).join('');
    return `<tr><td>${m}</td>${cells}</tr>`;
  }).join('');
}

adminAgregarRol.addEventListener('click', async () => {
  const name = adminNuevoRol.value.trim();
  if (!name) { alert('Ingrese nombre de rol'); return; }
  const d = await getRolesData();
  if (d.roles.includes(name)) { alert('El rol ya existe'); return; }
  d.roles.push(name);
  d.matrix[name] = {};
  d.modules.forEach(m => d.matrix[name][m] = true);
  await saveRolesData(d);
  adminNuevoRol.value = '';
  renderAdminMatrix();
});

adminGuardar.addEventListener('click', async () => {
  const d = await getRolesData();
  adminTabla.querySelectorAll('input[type="checkbox"]').forEach(chk => {
    const r = chk.dataset.role; const m = chk.dataset.mod;
    d.matrix[r][m] = chk.checked;
  });
  await saveRolesData(d);
  alert('Matriz de roles guardada');
});

// Dashboard
let chartStockPorCategoria, chartMovimientos, chartTopProductos,
    chartValorInventarioPorCategoria, chartDepositosPorCategoria,
    chartDescuentoPorDia, chartVentasAcumuladas;
async function refreshDashboard() {
  const products = await allProducts();
  const movements = await allMovements();
  // Try to load sales for discount chart
  let sales = [];
  try {
    const today = new Date();
    const desde = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()-30).padStart(2,'0')}`; // approx last 30 days
    const { data } = await supabase.from('sales').select('*').order('fecha', { ascending: true }).limit(1000);
    sales = data || [];
  } catch {}
  // Stock por categoría
  const byCat = {};
  const byCatValue = {};
  const byCatCeja = {};
  const byCatSenkata = {};
  products.forEach(p => {
    const c = p.categoria || 'General';
    const stock = ((p.ceja||0)+(p.senkata||0));
    byCat[c] = (byCat[c] || 0) + stock;
    byCatValue[c] = (byCatValue[c] || 0) + stock * (p.precio || 0);
    byCatCeja[c] = (byCatCeja[c] || 0) + (p.ceja || 0);
    byCatSenkata[c] = (byCatSenkata[c] || 0) + (p.senkata || 0);
  });
  const catLabels = Object.keys(byCat);
  const catData = Object.values(byCat);
  const catValueData = catLabels.map(c => byCatValue[c] || 0);
  const catCejaData = catLabels.map(c => byCatCeja[c] || 0);
  const catSenkData = catLabels.map(c => byCatSenkata[c] || 0);
  // Movimientos por día
  const byDay = {};
  movements.forEach(m => {
    const d = m.fecha;
    if (!byDay[d]) byDay[d] = { ingreso: 0, venta: 0 };
    if (m.tipo === 'ingreso') byDay[d].ingreso += m.total; else if (m.tipo === 'venta') byDay[d].venta += m.total;
  });
  const dayLabels = Object.keys(byDay).sort();
  const dayIng = dayLabels.map(d => byDay[d].ingreso);
  const dayVen = dayLabels.map(d => byDay[d].venta);
  const dayVenCumulative = dayVen.reduce((acc, v, i) => { acc.push((acc[i-1] || 0) + v); return acc; }, []);
  // Top productos por stock
  const top = [...products].sort((a,b) => (((b.ceja||0)+(b.senkata||0))-(((a.ceja||0)+(a.senkata||0))))).slice(0,10);
  const topLabels = top.map(p => p.nombre);
  const topData = top.map(p => ((p.ceja||0)+(p.senkata||0)));

  // Render charts
  const c1 = document.getElementById('chartStockPorCategoria').getContext('2d');
  const c2 = document.getElementById('chartMovimientos').getContext('2d');
  const c3 = document.getElementById('chartTopProductos').getContext('2d');
  const c4 = document.getElementById('chartValorInventarioPorCategoria').getContext('2d');
  const c5 = document.getElementById('chartDepositosPorCategoria').getContext('2d');
  const c6 = document.getElementById('chartDescuentoPorDia')?.getContext('2d');
  const c7 = document.getElementById('chartVentasAcumuladas').getContext('2d');
  if (chartStockPorCategoria) chartStockPorCategoria.destroy();
  if (chartMovimientos) chartMovimientos.destroy();
  if (chartTopProductos) chartTopProductos.destroy();
  if (chartValorInventarioPorCategoria) chartValorInventarioPorCategoria.destroy();
  if (chartDepositosPorCategoria) chartDepositosPorCategoria.destroy();
  if (chartDescuentoPorDia) chartDescuentoPorDia.destroy();
  if (chartVentasAcumuladas) chartVentasAcumuladas.destroy();
  chartStockPorCategoria = new Chart(c1, {
    type: 'bar', data: { labels: catLabels, datasets: [{ label: 'Stock', data: catData, backgroundColor: '#0a6cff' }] }, options: { responsive: true }
  });
  chartMovimientos = new Chart(c2, {
    type: 'line', data: { labels: dayLabels, datasets: [
      { label: 'Ingresos', data: dayIng, borderColor: '#0a6cff', backgroundColor: 'rgba(10,108,255,0.15)', tension: 0.3 },
      { label: 'Ventas', data: dayVen, borderColor: '#06f', backgroundColor: 'rgba(0,102,255,0.15)', tension: 0.3 }
    ] }, options: { responsive: true }
  });
  chartTopProductos = new Chart(c3, {
    type: 'pie', data: { labels: topLabels, datasets: [{ data: topData, backgroundColor: ['#0a6cff','#3b82f6','#7aa7e1','#0f63d6','#eef5ff','#dbe7ff','#93c5fd','#60a5fa','#2563eb','#1d4ed8'] }] }, options: { responsive: true }
  });
  chartValorInventarioPorCategoria = new Chart(c4, {
    type: 'bar', data: { labels: catLabels, datasets: [{ label: 'Valor Inventario (Bs)', data: catValueData, backgroundColor: '#2563eb' }] }, options: { responsive: true, scales: { y: { beginAtZero: true } } }
  });
  chartDepositosPorCategoria = new Chart(c5, {
    type: 'bar', data: { labels: catLabels, datasets: [
      { label: 'CEJA', data: catCejaData, backgroundColor: '#60a5fa' },
      { label: 'SENKATA', data: catSenkData, backgroundColor: '#93c5fd' }
    ] }, options: { responsive: true, scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true } } }
  });
  // Descuento promedio por día (si hay tabla sales)
  const cardDesc = document.getElementById('cardDescuentoPorDia');
  if (c6 && sales && sales.length) {
    const byDayDesc = {};
    sales.forEach(s => {
      const d = s.fecha;
      if (!byDayDesc[d]) byDayDesc[d] = { sum: 0, count: 0 };
      byDayDesc[d].sum += (s.descuento_pct || 0);
      byDayDesc[d].count += 1;
    });
    const descLabels = Object.keys(byDayDesc).sort();
    const descAvg = descLabels.map(d => byDayDesc[d].count ? (byDayDesc[d].sum / byDayDesc[d].count) : 0);
    chartDescuentoPorDia = new Chart(c6, {
      type: 'line', data: { labels: descLabels, datasets: [ { label: 'Descuento promedio (%)', data: descAvg, borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.15)', tension: 0.3 } ] }, options: { responsive: true }
    });
    if (cardDesc) cardDesc.hidden = false;
  } else {
    if (cardDesc) cardDesc.hidden = true;
  }
  chartVentasAcumuladas = new Chart(c7, {
    type: 'line', data: { labels: dayLabels, datasets: [ { label: 'Ventas acumuladas', data: dayVenCumulative, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.15)', tension: 0.3 } ] }, options: { responsive: true }
  });

  // KPIs
  const kpiTotalProductos = document.getElementById('kpiTotalProductos');
  const kpiStockTotal = document.getElementById('kpiStockTotal');
  const kpiValorInventario = document.getElementById('kpiValorInventario');
  const kpiVentasHoy = document.getElementById('kpiVentasHoy');
  const kpiIngresosHoy = document.getElementById('kpiIngresosHoy');
  const totalProductos = products.length;
  const totalStock = products.reduce((a,p)=>a+((p.ceja||0)+(p.senkata||0)),0);
  const valorInventario = products.reduce((a,p)=>a+(((p.ceja||0)+(p.senkata||0))*(p.precio||0)),0);
  const todayStr = new Date().toISOString().slice(0,10);
  const ventasHoy = movements.filter(m => m.tipo==='venta' && String(m.fecha)===todayStr).reduce((a,m)=>a+(m.total||0),0);
  const ingresosHoy = movements.filter(m => m.tipo==='ingreso' && String(m.fecha)===todayStr).reduce((a,m)=>a+(m.total||0),0);
  if (kpiTotalProductos) kpiTotalProductos.textContent = String(totalProductos);
  if (kpiStockTotal) kpiStockTotal.textContent = String(totalStock);
  if (kpiValorInventario) kpiValorInventario.textContent = fmt(valorInventario);
  if (kpiVentasHoy) kpiVentasHoy.textContent = fmt(ventasHoy);
  if (kpiIngresosHoy) kpiIngresosHoy.textContent = fmt(ingresosHoy);
}

// Movimientos UI
const formMov = document.getElementById('formMov');
const movFecha = document.getElementById('movFecha');
const movAddItemBtn = document.getElementById('movAddItem');
const movItemsTbody = document.getElementById('movItems');
const movLimpiar = document.getElementById('movLimpiar');
const movTablaBody = document.getElementById('movTabla')?.querySelector('tbody');

function newMovRow() {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="text" class="mov-item" list="datalistMovItems" placeholder="SKU o nombre" /></td>
    <td class="mov-nombre">-</td>
    <td class="mov-senk">0</td>
    <td><input type="number" class="mov-cant" min="1" value="" /></td>
    <td><button type="button" class="remove">✕</button></td>
  `;
  const itemInput = tr.querySelector('.mov-item');
  const nombreCell = tr.querySelector('.mov-nombre');
  const senkCell = tr.querySelector('.mov-senk');
  const cantInput = tr.querySelector('.mov-cant');
  const removeBtn = tr.querySelector('.remove');

  async function resolveProduct() {
    const val = (itemInput.value || '').trim();
    if (!val) { nombreCell.textContent = '-'; senkCell.textContent = '0'; cantInput.value = ''; cantInput.removeAttribute('max'); tr.dataset.item = ''; return; }
    let p = await findProductByITEM(val);
    if (!p) {
      const all = await allProducts();
      const byName = all.filter(x => (x.nombre || '').toLowerCase() === val.toLowerCase());
      if (byName.length === 1) p = byName[0];
    }
    if (p) {
      tr.dataset.item = p.item;
      nombreCell.textContent = p.nombre || '';
      senkCell.textContent = String(p.senkata || 0);
      cantInput.value = '';
      cantInput.setAttribute('max', String(p.senkata || 0));
    } else {
      tr.dataset.item = '';
      nombreCell.textContent = 'No encontrado';
      senkCell.textContent = '0';
      cantInput.value = '';
      cantInput.removeAttribute('max');
    }
  }
  itemInput.addEventListener('change', resolveProduct);
  itemInput.addEventListener('blur', resolveProduct);
  itemInput.addEventListener('input', () => { nombreCell.textContent = '-'; senkCell.textContent = '0'; tr.dataset.item=''; });
  cantInput.addEventListener('input', () => {
    const max = parseInt(cantInput.getAttribute('max') || '0', 10);
    let v = parseInt(cantInput.value || '0', 10);
    if (max && v > max) { cantInput.value = String(max); }
    if (v < 0) { cantInput.value = '0'; }
  });
  removeBtn.addEventListener('click', () => {
    tr.remove();
    if (movItemsTbody && movItemsTbody.children.length === 0) {
      movItemsTbody.appendChild(newMovRow());
    }
  });
  return tr;
}

async function refreshMovDatalist() {
  const list = await allProducts();
  const dl = document.getElementById('datalistMovItems');
  dl.innerHTML = list.map(p => `<option value="${p.item}">${p.nombre}</option>`).join('');
}
async function refreshMovimientosTable() {
  const data = await allMovements();
  if (!movTablaBody) return;
  const transfers = (data || []).filter(m => m.tipo === 'transfer');
  movTablaBody.innerHTML = transfers.length ? transfers.map(m => `
    <tr>
      <td>${m.fecha}</td>
      <td>${m.tipo}</td>
      <td>${m.item || ''}</td>
      <td>${m.nombre || ''}</td>
      <td>${m.cantidad || 0}</td>
      <td>${m.detalle || ''}</td>
      <td>${fmt(m.total || 0)}</td>
    </tr>
  `).join('') : `<tr><td colspan="7">No hay movimientos SENKATA → CEJA registrados.</td></tr>`;
}

formMov?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fecha = movFecha.value;
  if (!fecha) { alert('Seleccione la fecha'); return; }
  const rows = Array.from(movItemsTbody?.querySelectorAll('tr') || []);
  if (!rows.length) { alert('Agregue al menos una línea'); return; }
  let processed = 0;
  for (const tr of rows) {
    const item = tr.dataset.item || (tr.querySelector('.mov-item')?.value || '').trim();
    const cant = parseInt(tr.querySelector('.mov-cant')?.value || '0', 10);
    if (!item || cant <= 0) continue;
    const p = await findProductByITEM(item);
    if (!p) { alert(`Producto no encontrado: ${item}`); continue; }
    if ((p.senkata || 0) < cant) { alert(`SENKATA insuficiente para ${p.item} (${p.nombre}). Disp: ${p.senkata}`); continue; }
    await upsertProduct({ id: p.id, item: p.item, nombre: p.nombre, categoria: p.categoria, unidad: p.unidad || 'PCS', precio: p.precio || 0, ceja: (p.ceja || 0) + cant, senkata: (p.senkata || 0) - cant });
    await addMovement({ tipo: 'transfer', fecha, item: p.item, nombre: p.nombre, cantidad: cant, detalle: 'SENKATA → CEJA', total: 0, descuento: 0 });
    processed++;
  }
  await refreshInventoryUI();
  await refreshMovimientosTable();
  if (processed > 0) {
    alert(`Movimientos registrados: ${processed}`);
    movItemsTbody.innerHTML = '';
    movItemsTbody.appendChild(newMovRow());
  } else {
    alert('No se registró ningún movimiento.');
  }
});

movLimpiar?.addEventListener('click', () => { formMov.reset(); if (movItemsTbody){ movItemsTbody.innerHTML=''; movItemsTbody.appendChild(newMovRow()); } });

// Inicialización
(async () => {
  await refreshInventoryUI();
  await renderAdminMatrix();
  await refreshDashboard();
  await refreshMovDatalist();
  await refreshMovimientosTable();
  await refreshVentasHistorial();
  if (movItemsTbody && movItemsTbody.children.length === 0) {
    movItemsTbody.appendChild(newMovRow());
  }
  movAddItemBtn?.addEventListener('click', () => {
    movItemsTbody.appendChild(newMovRow());
  });
})();

