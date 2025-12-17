// Conexión Supabase
const SUPABASE_URL = 'https://qmaftwvpbzzzdmuevelh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFtYWZ0d3ZwYnp6emRtdWV2ZWxoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjQ5NjA2NTYsImV4cCI6MjA4MDUzNjY1Nn0.dEQkkAWdwAEGDhqSPcQuuBKSwMlmVQk9J2ws6eU7ti4';
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
const ventaComprobante = document.getElementById('ventaComprobante');
const ventaComprobanteBody = document.getElementById('ventaComprobanteBody');

// Inventario
const invBuscar = document.getElementById('invBuscar');
const invCategoria = document.getElementById('invCategoria');
const invStockMin = document.getElementById('invStockMin');
const invStockMax = document.getElementById('invStockMax');
const invAplicar = document.getElementById('invAplicar');
const invReiniciar = document.getElementById('invReiniciar');
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
    <td><input type="text" placeholder="Categoría" class="ven-cat" disabled /></td>
    <td><input type="text" placeholder="CEJA disponible" class="ven-ceja" disabled /></td>
    <td><input type="number" placeholder="Cantidad" class="ven-cant" min="1" required /></td>
    <td><input type="number" placeholder="Precio Venta (Bs)" class="ven-pvent" min="0" step="0.01" required /></td>
    <td><button type="button" class="remove">Eliminar</button></td>
  `;
  const skuInput = row.querySelector('.ven-sku');
  skuInput.addEventListener('change', async () => {
    const p = await findProductByITEM(skuInput.value);
    const nombreInput = row.querySelector('.ven-nombre');
    const catInput = row.querySelector('.ven-cat');
    const cejaInput = row.querySelector('.ven-ceja');
    const precioInput = row.querySelector('.ven-pvent');
    if (p) { nombreInput.value = p.nombre; catInput.value = p.categoria; cejaInput.value = (p.ceja ?? 0); precioInput.value = p.precio ?? 0; }
    else { nombreInput.value = ''; catInput.value = ''; cejaInput.value = ''; precioInput.value = ''; }
  });
  const removeBtn = row.querySelector('.remove');
  removeBtn.addEventListener('click', () => row.remove());
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
  setAutoSaleNumber();
  recalcVentaTotals();
});

// Imprimir
ingImprimirBtn.addEventListener('click', () => printComprobante(ingresoComprobanteBody));
venImprimirBtn.addEventListener('click', () => printComprobante(ventaComprobanteBody));
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
  targetBody.innerHTML = `
    <div class="header">
      <div>
        <div><strong>N°:</strong> ${mov.comprobante.numero}</div>
        <div><strong>Fecha:</strong> ${mov.comprobante.fecha}</div>
      </div>
      <div>
        <div><strong>${esIngreso ? 'Proveedor' : 'Cliente'}:</strong> ${mov.comprobante.entidad}</div>
        <div><strong>Tipo:</strong> ${esIngreso ? 'Ingreso' : 'Venta'}</div>
      </div>
    </div>
    <table>
      <thead><tr>${cols}</tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="${esIngreso ? 5 : 4}" style="text-align:right"><strong>Total</strong></td><td>${fmt(mov.total)}</td></tr></tfoot>
    </table>
  `;
  container.hidden = false;
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
function recalcVentaTotals() {
  const descuentoPct = parseFloat((document.getElementById('venDescPct')?.value || '0')) || 0;
  const filas = Array.from(venItemsDiv.querySelectorAll('tr'));
  const items = filas.map(r => ({
    cantidad: parseFloat(r.querySelector('.ven-cant')?.value || '0') || 0,
    precio: parseFloat(r.querySelector('.ven-pvent')?.value || '0') || 0
  }));
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
      </td>
    </tr>
  `).join('');
  // Wire acciones
  invTabla.querySelectorAll('.btn-edit').forEach(btn => btn.addEventListener('click', onEditProduct));
  invTabla.querySelectorAll('.btn-delete').forEach(btn => btn.addEventListener('click', onDeleteProduct));
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
const ventasFiltroAplicar = document.getElementById('ventasFiltroAplicar');
const ventasFiltroLimpiar = document.getElementById('ventasFiltroLimpiar');

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
    hasta: hasta ? fmtDate(hasta) : null
  };
}

async function refreshVentasHistorial() {
  if (!ventasHistTablaBody) return;
  try {
    const range = getDateRange();
    let query = supabase.from('sales').select('*');
    if (range.desde) query = query.gte('fecha', range.desde);
    if (range.hasta) query = query.lte('fecha', range.hasta);
    const { data, error } = await query.order('fecha', { ascending: false }).limit(500);
    if (error) { console.error('sales fetch error', error); ventasHistTablaBody.innerHTML = `<tr><td colspan="7">Error al cargar ventas.</td></tr>`; return; }
    if (!data || data.length === 0) {
      ventasHistTablaBody.innerHTML = `<tr><td colspan="7">No hay ventas para el rango seleccionado.</td></tr>`;
      return;
    }
    ventasHistTablaBody.innerHTML = data.map(s => `
      <tr>
        <td>${s.fecha}</td>
        <td>${s.numero}</td>
        <td>${s.cliente}</td>
        <td>${fmt(s.subtotal)}</td>
        <td>${Number(s.descuento_pct || 0).toFixed(2)}%</td>
        <td>${fmt(s.descuento || 0)}</td>
        <td>${fmt(s.total || 0)}</td>
        <td><button type="button" class="secondary btn-ver-detalles" data-sale-id="${s.id}">Ver detalles</button></td>
      </tr>
    `).join('');
    // wire details buttons
    document.querySelectorAll('.btn-ver-detalles').forEach(btn => btn.addEventListener('click', onVerDetallesVenta));
  } catch (e) { console.error('ventas historial exception', e); ventasHistTablaBody.innerHTML = `<tr><td colspan="7">Error inesperado cargando ventas.</td></tr>`; }
}

async function onVerDetallesVenta(e) {
  const saleId = e.currentTarget.dataset.saleId;
  try {
    const { data, error } = await supabase.from('sales_items').select('*').eq('sale_id', saleId).order('id', { ascending: true });
    if (error) { alert('Error cargando detalles'); return; }
    const lines = (data||[]).map(it => `${it.item} - ${it.nombre} | Cant: ${it.cantidad} | Precio: ${fmt(it.precio)} | Subtotal: ${fmt(it.subtotal)}`).join('\n');
    alert(lines || 'Sin items');
  } catch (err) { console.error('ver detalles error', err); }
}

ventasFiltroAplicar?.addEventListener('click', async () => { await refreshVentasHistorial(); });
ventasFiltroLimpiar?.addEventListener('click', async () => {
  if (ventasFiltroRango) ventasFiltroRango.value = 'todo';
  if (ventasFiltroDesde) ventasFiltroDesde.value = '';
  if (ventasFiltroHasta) ventasFiltroHasta.value = '';
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
let chartStockPorCategoria, chartMovimientos, chartTopProductos;
async function refreshDashboard() {
  const products = await allProducts();
  const movements = await allMovements();
  // Stock por categoría
  const byCat = {};
  products.forEach(p => { const c = p.categoria || 'General'; byCat[c] = (byCat[c] || 0) + ((p.ceja||0)+(p.senkata||0)); });
  const catLabels = Object.keys(byCat);
  const catData = Object.values(byCat);
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
  // Top productos por stock
  const top = [...products].sort((a,b) => (b.stock||0)-(a.stock||0)).slice(0,10);
  const topLabels = top.map(p => p.nombre);
  const topData = top.map(p => p.stock || 0);

  // Render charts
  const c1 = document.getElementById('chartStockPorCategoria').getContext('2d');
  const c2 = document.getElementById('chartMovimientos').getContext('2d');
  const c3 = document.getElementById('chartTopProductos').getContext('2d');
  if (chartStockPorCategoria) chartStockPorCategoria.destroy();
  if (chartMovimientos) chartMovimientos.destroy();
  if (chartTopProductos) chartTopProductos.destroy();
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
//modificacion que debe verse por favor, este es mi intento final
