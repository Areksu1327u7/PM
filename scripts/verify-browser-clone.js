/* Ejecutar con una pagina Playwright del servidor local. Solo conserva datos nuevos TEST-BROWSER.
   No restaura ni elimina registros y compara hashes de todas las filas anteriores. */
async function runCloneBrowserChecks(page) {
  page.setDefaultTimeout(90000);
  const check = (condition, message) => { if (!condition) throw Error(message); };
  const tag = 'TEST-BROWSER-' + Date.now(), passed = [], dialogs = [], pageErrors = [];
  const onDialog = async dialog => { dialogs.push(dialog.message()); await dialog.accept(); };
  const onError = error => pageErrors.push(error.message);
  page.on('dialog', onDialog);
  page.on('pageerror', onError);
  await page.waitForFunction(() => typeof Store !== 'undefined' && document.querySelector('.mov-item') && document.querySelector('.ven-sku'));
  await page.evaluate(async tag => {
    if (supabase.supabaseUrl !== 'https://tgggakuinkbibqvvuvob.supabase.co') throw Error('Clon incorrecto. No se permiten escrituras.');
    const originalRpc = supabase.rpc.bind(supabase), products = new Set(), sales = new Set(), movements = new Set();
    const digest = async row => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(row))))].map(x => x.toString(16).padStart(2, '0')).join('');
    const baseline = {};
    for (const table of ['products', 'sales', 'sales_items', 'movements', 'roles_matrix']) {
      baseline[table] = new Map(await Promise.all((await Store.all(table)).map(async row => [row.id, await digest(row)])));
    }
    const allowed = condition => { if (!condition) throw Error('Escritura fuera de los datos propios de esta prueba.'); };
    supabase.rpc = (name, args) => {
      if (name !== 'store_commit') return originalRpc(name, args);
      return (async () => {
        const p = args.p_payload;
        if (args.p_action === 'receipt') allowed(p.numero.startsWith(tag) && p.items.every(i => i.item.startsWith(tag)));
        else if (args.p_action === 'products_save') allowed(p.products.every(i => products.has(i.id)));
        else if (args.p_action === 'transfer') allowed(p.items.every(i => products.has(i.product_id)));
        else if (args.p_action === 'sale_create') allowed(p.numero.startsWith(tag) && p.items.every(i => products.has(i.product_id)));
        else if (['sale_edit', 'sale_cancel'].includes(args.p_action)) allowed(sales.has(p.sale_id) && (!p.items || p.items.every(i => products.has(i.product_id))));
        else if (args.p_action === 'transfer_reverse') allowed(movements.has(p.movement_id));
        else throw Error('Accion de escritura no autorizada: ' + args.p_action);
        const response = await originalRpc(name, args);
        if (!response.error && response.data.sale_id) sales.add(response.data.sale_id);
        return response;
      })();
    };
    window.__cloneReview = { tag, baseline, digest, products, movements, originalRpc };
  }, tag);
  const waitIdle = async () => page.waitForFunction(() => Store.busy.size === 0);
  const nav = async section => {
    await page.locator(`.nav-btn[data-target="${section}"]`).click();
    await page.locator('#' + section).waitFor({ state: 'visible' });
  };
  const products = async () => page.evaluate(async tag => (await Store.all('products')).filter(p => p.item.startsWith(tag)), tag);
  const stock = async (aCeja, aSenkata, bCeja, bSenkata) => {
    const rows = await products(), a = rows.find(p => p.item === tag + '-A'), b = rows.find(p => p.item === tag + '-B');
    check(a.ceja === aCeja && a.senkata === aSenkata && b.ceja === bCeja && b.senkata === bSenkata, 'Existencias incorrectas');
  };
  const openSale = async () => {
    await page.evaluate(async tag => {
      document.getElementById('ventasFiltroRango').value = 'todo';
      document.getElementById('ventasFiltroCliente').value = tag;
      await refreshVentasHistorial();
    }, tag);
    await nav('ventasHistSection');
    await page.locator('#ventasFiltroRango').selectOption('todo');
    await page.locator('#ventasFiltroCliente').fill(tag);
    const date = await page.evaluate(() => Store.date());
    await page.locator('#ventasFiltroDesde').fill(date);
    await page.locator('#ventasFiltroHasta').fill(date);
    await page.locator('#ventasFiltroAplicar').click();
    await page.waitForFunction(() => !document.getElementById('ventasHistTabla').hasAttribute('aria-busy'));
    const range = await page.evaluate(() => getDateRange());
    check(range.desde === date && range.hasta === date, 'El filtro desplaza la fecha seleccionada');
    if (!passed.includes('Filtro por fecha exacta sin desfase')) passed.push('Filtro por fecha exacta sin desfase');
    const row = page.locator('#ventasHistTabla tbody tr').filter({ hasText: tag + '-V' });
    await row.locator('button').click();
    await page.locator('#ventaDetallesModal').waitFor({ state: 'visible' });
  };
  const waitNotice = async text => {
    await waitIdle();
    check((await page.locator('#appNotice').textContent()).includes(text), 'Falta confirmacion: ' + text);
  };
  let preserved, completed = false;
  try {
    const rejected = await page.evaluate(async () => {
      const r = await fetch(supabase.supabaseUrl + '/rest/v1/products?select=id&limit=1', { headers: { apikey: 'invalid-test-key' } });
      return r.status;
    });
    check(rejected === 401, 'La API debe rechazar una clave invalida');
    passed.push('API rechaza credenciales invalidas');
    await nav('ingresoSection');
    await page.locator('#ingNum').fill(tag + '-I');
    await page.locator('#ingProveedor').fill(tag);
    await page.locator('#ingAddItem').click();
    for (const [index, suffix, quantity, cost, price] of [[0, 'A', 20, 3, 5], [1, 'B', 12, 4, 7]]) {
      const row = page.locator('#ingItems .item-row').nth(index);
      await row.locator('.ing-sku').fill(tag + '-' + suffix);
      await row.locator('.ing-nombre').fill('PRUEBA NAVEGADOR ' + suffix + ' - conservar');
      await row.locator('.ing-cat').fill('PRUEBAS');
      await row.locator('.ing-cant').fill(String(quantity));
      await row.locator('.ing-pcomp').fill(String(cost));
      await row.locator('.ing-pvent').fill(String(price));
    }
    await page.locator('#formIngreso [type=submit]').click();
    await waitNotice('Ingreso guardado');
    await stock(0, 20, 0, 12);
    check((await page.locator('#ingresoComprobanteBody').textContent()).includes('108.00'), 'Importe del ingreso');
    await page.evaluate(async tag => {
      for (const p of await Store.all('products')) if (p.item.startsWith(tag)) __cloneReview.products.add(p.id);
    }, tag);
    passed.push('Ingreso y creacion de dos productos');
    await nav('movSection');
    await page.locator('#movAddItem').click();
    for (const [index, suffix, quantity] of [[0, 'A', 10], [1, 'B', 5]]) {
      const row = page.locator('#movItems tr').nth(index);
      await row.locator('.mov-item').fill(tag + '-' + suffix);
      await row.locator('.mov-item').press('Tab');
      await page.waitForFunction(({ index, tag, suffix }) => document.querySelectorAll('#movItems tr')[index]?.dataset.item === tag + '-' + suffix, { index, tag, suffix });
      await row.locator('.mov-cant').fill(String(quantity));
    }
    await page.locator('#formMov [type=submit]').click();
    await waitNotice('Transferencia completa');
    await stock(10, 10, 5, 7);
    await page.evaluate(async tag => {
      for (const m of await Store.all('movements')) if (m.item.startsWith(tag)) __cloneReview.movements.add(m.id);
    }, tag);
    passed.push('Transferencia de dos productos SENKATA a CEJA');
    const invalidTransfer = await page.evaluate(async tag => {
      const product = (await Store.all('products')).find(p => p.item === tag + '-A');
      try { await Store.commit('transfer', { fecha: Store.date(), items: [{ product_id: product.id, cantidad: 99999 }] }); }
      catch (error) { return error.message; }
      throw Error('Transferencia excesiva aceptada');
    }, tag);
    check(invalidTransfer.includes('Stock SENKATA insuficiente'), 'Transferencia excesiva no rechazada');
    await stock(10, 10, 5, 7);
    passed.push('API: transferencia sin stock rechazada sin cambios');
    await nav('realizarVentaSection');
    await page.locator('#venNum').fill(tag + '-V');
    await page.locator('#venCliente').fill(tag);
    await page.locator('#venDescPct').fill('10');
    await page.locator('#venAddItem').click();
    for (const [index, suffix, price] of [[0, 'A', 5], [1, 'B', 7]]) {
      const row = page.locator('#venItems tr').nth(index);
      await row.locator('.ven-sku').fill(tag + '-' + suffix);
      await row.locator('.ven-cant').fill('2');
      await row.locator('.ven-pvent').fill(String(price));
    }
    await page.locator('#venGuardar').click();
    await waitNotice('guardada correctamente');
    await stock(8, 10, 3, 7);
    check((await page.locator('#ventaComprobanteBody').textContent()).includes('21.60'), 'Total con descuento');
    passed.push('Venta multilinea con descuento y comprobante');
    await page.locator('#venNum').fill(tag + '-INVALIDA');
    await page.locator('#venCliente').fill(tag);
    await page.locator('#venItems .ven-sku').fill(tag + '-A');
    await page.locator('#venItems .ven-cant').fill('99999');
    await page.locator('#venItems .ven-pvent').fill('5');
    await page.locator('#venGuardar').click();
    await waitIdle();
    check(dialogs.some(m => m.includes('Stock CEJA insuficiente')), 'Venta excesiva no rechazada');
    await stock(8, 10, 3, 7);
    passed.push('Venta sin stock rechazada sin cambios');
    await openSale();
    await page.locator('#ventaDetallesEditar').click();
    await page.locator('#ventaDetallesBody .edit-cant').first().fill('1');
    await page.locator('#ventaDetallesBody .edit-precio').first().fill('6');
    await page.locator('#editDescPct').fill('0');
    await page.locator('#ventaDetallesBody .row-remove').nth(1).click();
    await page.locator('#ventaDetallesGuardar').click();
    await waitNotice('Venta actualizada');
    await stock(9, 10, 5, 7);
    passed.push('Edicion de precio y cantidad, retiro de linea devuelve stock');
    await openSale();
    await page.locator('#ventaDetallesAnular').click();
    await waitNotice('Venta anulada');
    await stock(10, 10, 5, 7);
    await openSale();
    check(await page.locator('#ventaDetallesAnular').isDisabled(), 'La anulacion repetida debe estar deshabilitada');
    await page.locator('#ventaDetallesModal .modal-close').last().click();
    passed.push('Anulacion conserva venta y bloquea doble devolucion');
    await nav('movSection');
    await page.locator('[data-mov-view=movHistView]').click();
    await page.locator('#movHistItem').fill(tag + '-B');
    await page.locator('#movHistFiltrar').click();
    await page.waitForFunction(tag => {
      const rows = document.querySelectorAll('#movTabla .mov-line-item');
      return rows.length === 1 && rows[0].querySelector('.mov-col-item').textContent === tag + '-B';
    }, tag);
    const movementId = await page.evaluate(async tag => {
      return (await Store.all('movements')).find(m => m.item === tag + '-B' && m.tipo === 'transfer').id;
    }, tag);
    const group = page.locator('#movTabla tbody tr').filter({ hasText: tag + '-B' });
    await group.locator('summary').click();
    await group.locator('.btn-mov-edit').click();
    await group.locator(`.btn-delete-mov-line[data-mov-id="${movementId}"]`).click();
    await waitNotice('Transferencia revertida');
    await stock(10, 10, 0, 12);
    passed.push('Reversion CEJA a SENKATA conserva transferencia original');
    await nav('inventarioSection');
    const aRow = page.locator('#invTabla tbody tr').filter({ hasText: tag + '-A' });
    await aRow.locator('.btn-edit').click();
    const editRow = page.locator(`#invTabla tbody tr[data-item="${tag}-A"]`);
    await editRow.locator('.edit-nombre').fill('PRUEBA NAVEGADOR A editada - conservar');
    await editRow.locator('.edit-precio').fill('8');
    await page.locator('#invSaveAllBtn').click();
    await waitNotice('Todos los cambios');
    await stock(10, 10, 0, 12);
    passed.push('Edicion de producto propio conserva existencias');
    await page.locator('#invBuscar').fill(tag);
    await page.locator('#invAplicar').click();
    await page.waitForFunction(() => document.querySelectorAll('#invTabla tbody tr').length === 2);
    await page.locator('#invTabla tbody tr').filter({ hasText: tag + '-A' }).locator('.btn-ver-ventas').click();
    await page.locator('#productoVentasBody tr.venta-anulada').waitFor();
    check((await page.locator('#productoVentasBody tfoot').textContent()).includes('0.00'), 'Venta anulada incluida en totales');
    await page.locator('#productoVentasModal .modal-close').last().click();
    await page.locator('#invTabla tbody tr').filter({ hasText: tag + '-B' }).locator('.btn-ver-ventas').click();
    await page.locator('#productoHistMovimientos').click();
    await page.locator('#productoVentasBody tbody tr').nth(1).waitFor();
    check(await page.locator('#productoVentasBody tbody tr').count() === 2, 'Faltan movimientos o hay registros de otro producto');
    const history = await page.locator('#productoVentasBody').textContent();
    check(history.includes('Reversión') && history.includes('Revertido') && !history.includes('Hora no registrada'), 'Falta hora o estado');
    const destinations = await page.locator('#productoVentasBody tbody tr').first().locator('td').allTextContents();
    check(destinations[2] === 'CEJA' && destinations[3] === 'SENKATA', 'Direccion de la reversion');
    passed.push('Lupa: ventas anuladas y transferencias con hora, estado y direccion');
    const recovered = await page.evaluate(async tag => {
      const product = (await Store.all('products')).find(p => p.item === tag + '-A');
      const payload = { fecha: Store.date(), items: [{ product_id: product.id, cantidad: 1 }] };
      const scope = 'review-uncertain-' + tag, slot = 'mb_pending_v1:' + scope;
      const guardedRpc = supabase.rpc.bind(supabase);
      let loseResponse = true;
      supabase.rpc = (name, args) => {
        const response = guardedRpc(name, args);
        if (name !== 'store_commit') return response;
        return response.then(result => {
          if (!result.error && loseResponse) {
            loseResponse = false;
            return { data: null, error: { code: '', message: 'Respuesta de prueba perdida' } };
          }
          return result;
        });
      };
      try {
        let rejected = false;
        try { await Store.commit('transfer', payload, scope); }
        catch { rejected = true; }
        const pending = JSON.parse(sessionStorage.getItem(slot));
        if (!rejected || !pending?.key) throw Error('La respuesta perdida debe conservar el UUID');
        const first = (await Store.all('products')).find(p => p.id === product.id);
        await Store.commit('transfer', payload, scope);
        const final = (await Store.all('products')).find(p => p.id === product.id);
        if (final.ceja !== first.ceja || final.senkata !== first.senkata || sessionStorage.getItem(slot) !== null) {
          throw Error('El reintento duplico la transferencia o no confirmo el diario');
        }
        return { recovered: true };
      } finally { supabase.rpc = guardedRpc; }
    }, tag);
    check(recovered.recovered, 'Fallo al recuperar una confirmacion perdida');
    await stock(11, 9, 0, 12);
    passed.push('Respuesta perdida despues de guardar: reintento sin duplicar stock');
    await page.locator('#productoVentasModal .modal-footer button').click();
    const viewport = page.viewportSize();
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      for (const section of ['homeSection', 'ingresoSection', 'realizarVentaSection']) {
        await nav(section);
        const dimensions = await page.evaluate(section => ({
          width: document.documentElement.scrollWidth,
          viewport: innerWidth,
          receipt: [...document.querySelectorAll('#' + section + ' .comprobante-doc')].map(el => ({
            width: el.clientWidth, content: el.scrollWidth, overflow: getComputedStyle(el).overflowX
          }))
        }), section);
        check(dimensions.width <= dimensions.viewport, 'Desborde movil en ' + section);
        check(dimensions.receipt.every(el => el.content <= el.width || el.overflow === 'auto'), 'Comprobante recortado en ' + section);
      }
    } finally { if (viewport) await page.setViewportSize(viewport); }
    passed.push('Movil: formularios y comprobantes sin desborde ni columnas recortadas');
    check(pageErrors.length === 0, pageErrors.join('; '));
    completed = true;
  } finally {
    preserved = await page.evaluate(async () => {
      const counts = {}, changed = [];
      try {
        for (const [table, baseline] of Object.entries(__cloneReview.baseline)) {
          const after = new Map(await Promise.all((await Store.all(table)).map(async row => [row.id, await __cloneReview.digest(row)])));
          counts[table] = baseline.size;
          for (const [id, hash] of baseline) if (after.get(id) !== hash) changed.push({ table, id });
        }
        return { counts, changed };
      } finally { supabase.rpc = __cloneReview.originalRpc; delete window.__cloneReview; }
    });
    page.off('dialog', onDialog);
    page.off('pageerror', onError);
    await page.evaluate(report => { window.__lastCloneReviewReport = report; }, {
      tag, passed, preserved, pageErrors, overall: completed && preserved.changed.length === 0 ? 'PASS' : 'FAIL',
      exit_code: completed && preserved.changed.length === 0 ? 0 : 1
    });
    check(preserved.changed.length === 0, 'Cambios en filas anteriores: ' + JSON.stringify(preserved.changed));
  }
  return { tag, passed, preserved, pageErrors, overall: 'PASS', exit_code: 0 };
}

if (typeof module !== 'undefined') module.exports = runCloneBrowserChecks;
