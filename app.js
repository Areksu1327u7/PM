// Cliente autenticado creado por modules/access.js.
let liveRefreshTimer = null;
let productsRealtimeChannel = null;
let currentSectionId = 'homeSection';
let inventoryAutoRefreshTimer = null;
let inventoryEditingItems = new Set();
let inventoryPendingSync = false;
let dollarPrediction = null;
let dollarPredictionUI = null;
const invLiveTextEl = document.getElementById('invLiveText');
const invLiveTimeEl = document.getElementById('invLiveTime');
const invLiveDotEl = document.getElementById('invLiveDot');

function setInventoryLiveStatus(text, state = 'ok') {
  if (invLiveTextEl) invLiveTextEl.textContent = text;
  if (invLiveDotEl) {
    invLiveDotEl.style.background = state === 'error' ? '#ef4444' : (state === 'syncing' ? '#f59e0b' : '#22c55e');
  }
}

function markInventoryLiveSyncTime() {
  if (!invLiveTimeEl) return;
  const now = new Date();
  invLiveTimeEl.textContent = `Última sync: ${now.toLocaleTimeString('es-BO')}`;
}

function startInventoryEditItem(item) {
  inventoryEditingItems.add(item);
  setInventoryLiveStatus('Modo Edición activo — sync pausada', 'syncing');
  updateEditModeUI();
}

async function endInventoryEditItem(item) {
  inventoryEditingItems.delete(item);
  updateEditModeUI();
  if (inventoryEditingItems.size === 0) {
    if (inventoryPendingSync) {
      inventoryPendingSync = false;
      await refreshInventoryLiveView();
    } else {
      setInventoryLiveStatus('Actualización en vivo activa', 'ok');
      markInventoryLiveSyncTime();
    }
  }
}

let inventoryEditMode = false;
let inventoryOriginalData = new Map(); // item -> original product data

function updateEditModeUI() {
  const banner = document.getElementById('invEditBanner');
  const floatingBar = document.getElementById('invFloatingBar');
  const toggleBtn = document.getElementById('invEditModeToggle');
  const table = document.getElementById('invTabla');
  const changeCount = document.getElementById('invChangeCount');

  if (inventoryEditMode) {
    banner?.classList.add('visible');
    toggleBtn?.classList.add('active');
    toggleBtn && (toggleBtn.textContent = '✏️ Editando...');
    table?.classList.add('inv-editable');

    // Count changes
    const count = countInventoryChanges();
    if (changeCount) changeCount.textContent = count === 1 ? '1 cambio' : `${count} cambios`;
    if (floatingBar) floatingBar.classList.toggle('visible', true);
  } else {
    banner?.classList.remove('visible');
    floatingBar?.classList.remove('visible');
    toggleBtn?.classList.remove('active');
    toggleBtn && (toggleBtn.textContent = '✏️ Modo Edición');
    table?.classList.remove('inv-editable');
  }
}

function countInventoryChanges() {
  let count = 0;
  document.querySelectorAll('#invTabla tbody tr').forEach(tr => {
    if (tr.classList.contains('inv-row-changed')) count++;
  });
  return count;
}

function updateChangeCounter() {
  const changeCount = document.getElementById('invChangeCount');
  const count = countInventoryChanges();
  if (changeCount) changeCount.textContent = count === 1 ? '1 cambio' : `${count} cambios`;
}

async function saveAllInventoryEdits() {
  return Store.run('inventory', document.getElementById('invSaveAllBtn'), async () => {
    const rows = [...invTabla.querySelectorAll('tr.inv-row-changed')];
    if (!rows.length) return;
    const products = rows.map(tr => {
      const orig = inventoryOriginalData.get(tr.dataset.item);
      const changes = {};
      const fields = {item:'item',nombre:'nombre',cat:'categoria',ceja:'ceja',senkata:'senkata',unidad:'unidad',precio:'precio'};
      for (const [css, field] of Object.entries(fields)) {
        const input = tr.querySelector('.edit-'+css);
        if (!input.classList.contains('inv-field-changed')) continue;
        changes[field] = ['ceja','senkata','precio'].includes(field) ? Store.number(input.value,field,{integer:field!=='precio'}) : input.value.trim();
        if (changes[field] === '') throw new Error(field+' no puede estar vacío.');
      }
      return { id:orig.id, expected:orig, changes };
    });
    await Store.commit('products_save',{products},'inventory');
    inventoryEditMode=false; inventoryEditingItems.clear(); inventoryOriginalData.clear(); updateEditModeUI();
    Store.notice('Todos los cambios se guardaron correctamente.');
    refreshAfterWrite();
  });
}

function discardAllInventoryEdits() {
  inventoryEditMode = false;
  inventoryEditingItems.clear();
  inventoryOriginalData.clear();
  updateEditModeUI();
  refreshInventoryUI();
  setInventoryLiveStatus('Actualización en vivo activa', 'ok');
  markInventoryLiveSyncTime();
}

async function toggleInventoryEditMode() {
  if (inventoryEditMode) {
    // If there are unsaved changes, confirm
    const changes = countInventoryChanges();
    if (changes > 0) {
      if (!confirm(`Tienes ${changes} cambio(s) sin guardar. ¿Descartar?`)) return;
    }
    discardAllInventoryEdits();
  } else {
    inventoryEditMode = true;
    setInventoryLiveStatus('Modo Edición activo — sync pausada', 'syncing');
    // Store original data and render editable table
    let list;
    try { list = await allProducts(); }
    catch (e) {
      // Sin datos vigentes no se permite editar: se vuelve al modo consulta.
      inventoryEditMode = false; inventoryEditingItems.clear(); updateEditModeUI();
      setInventoryLiveStatus('Sincronización con retraso', 'error');
      Store.notice('No se pudo cargar el inventario para editar. ' + e.message, true);
      return;
    }
    if (!inventoryEditMode) return;
    inventoryOriginalData.clear();
    list.forEach(p => inventoryOriginalData.set(p.item, { ...p }));
    inventoryEditingItems.add('__edit_mode__');
    renderInventoryTableEditable(list);
    updateEditModeUI();
  }
}

function renderInventoryTableEditable(list) {
  invTabla.innerHTML = list.map((p, idx) => `
    <tr data-item="${escapeAttr(p.item)}">
      <td class="col-rownum">${idx + 1}</td>
      <td><input type="text" value="${escapeAttr(p.item)}" class="edit-item" data-orig="${escapeAttr(p.item || '')}" /></td>
      <td><input type="text" value="${escapeAttr(p.nombre)}" class="edit-nombre" data-orig="${escapeAttr(p.nombre || '')}" /></td>
      <td><input type="text" value="${escapeAttr(p.categoria || '')}" class="edit-cat" data-orig="${escapeAttr(p.categoria || '')}" /></td>
      <td><input type="number" value="${p.ceja || 0}" min="0" class="edit-ceja" data-orig="${p.ceja || 0}" /></td>
      <td><input type="number" value="${p.senkata || 0}" min="0" class="edit-senkata" data-orig="${p.senkata || 0}" /></td>
      <td><input type="text" value="${escapeAttr(p.unidad || '')}" class="edit-unidad" data-orig="${escapeAttr(p.unidad || '')}" /></td>
      <td><input type="number" value="${p.precio || 0}" min="0" step="0.01" class="edit-precio" data-orig="${p.precio || 0}" /></td>
      <td class="col-actions"></td>
    </tr>
  `).join('');
  // Wire change detection on all inputs
  invTabla.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', onEditableInputChange);
  });
}

function onEditableInputChange(e) {
  const inp = e.target;
  const tr = inp.closest('tr');
  if (!tr) return;
  const orig = inp.dataset.orig ?? '';
  const current = inp.value;
  if (current !== String(orig)) {
    inp.classList.add('inv-field-changed');
    tr.classList.add('inv-row-changed');
  } else {
    inp.classList.remove('inv-field-changed');
    const anyChanged = Array.from(tr.querySelectorAll('input')).some(i => i.classList.contains('inv-field-changed'));
    if (!anyChanged) tr.classList.remove('inv-row-changed');
  }
  updateChangeCounter();
}

async function refreshInventoryLiveView() {
  if(!Access.can('inventory.read')) return;
  if (currentSectionId !== 'inventarioSection') return;
  if (inventoryEditMode || inventoryEditingItems.size > 0) {
    inventoryPendingSync = true;
    setInventoryLiveStatus(`Edición en curso (${inventoryEditingItems.size} fila(s)) — sync pausada`, 'syncing');
    return;
  }
  setInventoryLiveStatus('Sincronizando inventario...', 'syncing');
  const hasFilters =
    !!(invBuscar?.value || '').trim() ||
    !!(invCategoria?.value || '') ||
    !!(invStockMin?.value || '') ||
    !!(invStockMax?.value || '');
  try {
    if (hasFilters) await applyFilters();
    else await refreshInventoryUI();
    setInventoryLiveStatus('Actualización en vivo activa', 'ok');
    markInventoryLiveSyncTime();
  } catch (e) {
    setInventoryLiveStatus('Sincronización con retraso', 'error');
    throw e;
  }
}

function initInventoryAutoRefresh() {
  if (inventoryAutoRefreshTimer) return;
  inventoryAutoRefreshTimer = setInterval(async () => {
    try {
      if(document.hidden||currentSectionId!=='inventarioSection'||Store.busy.size||visibleRefreshRunning.has(currentSectionId))return;
      await refreshVisibleViews();
    } catch (e) {
      console.warn('inventory auto-refresh warn', e);
    }
  }, 15000);
}

const visibleRefreshRunning=new Map();
async function refreshVisibleViews(){
  if(document.hidden)return;
  const section=currentSectionId;
  const previous=visibleRefreshRunning.get(section);
  if(previous){previous.again=true;return previous.promise;}
  const tasks=section==='inventarioSection'?[refreshInventoryLiveView]:section==='dashboardSection'?[refreshDashboard]:section==='ventasHistSection'?[refreshVentasHistorial]:section==='movSection'?(document.getElementById('movHistView')?.hidden===false?[refreshMovimientosTable]:[refreshMovDatalist,refreshRecentMovimientos]):section==='realizarVentaSection'?[refreshMovDatalist]:section==='adminSection'?[renderAdminMatrix,...(Access.can('inventory.write')?[populateBulkCategories]:[])]:[];
  const target=document.getElementById(section);target?.setAttribute('aria-busy','true');
  const state={again:false,promise:Store.refresh(tasks)};
  visibleRefreshRunning.set(section,state);
  try{await state.promise;}finally{target?.removeAttribute('aria-busy');visibleRefreshRunning.delete(section);if(state.again&&currentSectionId===section)scheduleLiveRefresh();}
}
function refreshAfterWrite(){
  Store.invalidateReads();
  // La confirmación ya se recibió; las vistas no bloquean la siguiente operación.
  scheduleLiveRefresh();
}
function scheduleLiveRefresh(){
  if(liveRefreshTimer)clearTimeout(liveRefreshTimer);
  liveRefreshTimer=setTimeout(()=>{liveRefreshTimer=null;void refreshVisibleViews();},150);
}

function initProductsRealtime() {
  if (productsRealtimeChannel) return;
  productsRealtimeChannel = supabase
    .channel('realtime-products')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => {
      Store.invalidateReads();
      if (currentSectionId === 'inventarioSection') setInventoryLiveStatus('Cambio detectado. Actualizando...', 'syncing');
      scheduleLiveRefresh();
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') console.log('Realtime products: ON');
    });
}

// Tablas esperadas:
// products: { id, item, nombre, ceja, senkata, unidad, precio, categoria }
// movements: { id, tipo ('ingreso'|'venta'|'transfer'), fecha, item, nombre, cantidad, detalle, total, descuento }
// roles_matrix: { id, data_json declarado para forzar una modificacion externa }

// Datos iniciales de ejemplo

// No se crean datos de ejemplo al iniciar.

// Widget de tipo de cambio (USDT / BOB)
const fxParallelBuyEl = document.getElementById('fxParallelBuy');
const fxParallelSellEl = document.getElementById('fxParallelSell');
const fxParallelMidEl = document.getElementById('fxParallelMid');
const fxStatusEl = document.getElementById('fxStatus');
const fxUpdatedAtEl = document.getElementById('fxUpdatedAt');
const fxRefreshBtn = document.getElementById('fxRefreshBtn');
const homeCurrentTimeEl = document.getElementById('homeCurrentTime');
const homeCurrentDateEl = document.getElementById('homeCurrentDate');
const homeWeatherStatusEl = document.getElementById('homeWeatherStatus');
const homeWeatherTempEl = document.getElementById('homeWeatherTemp');
const homeWeatherTextEl = document.getElementById('homeWeatherText');
const homeWeatherUpdatedEl = document.getElementById('homeWeatherUpdated');
const homeMatchesNextEl = document.getElementById('homeMatchesNext');
const homeMatchesTodayEl = document.getElementById('homeMatchesToday');
const homeMatchesNextStatusEl = document.getElementById('homeMatchesNextStatus');
const homeMatchesTodayStatusEl = document.getElementById('homeMatchesTodayStatus');

function fxFmt(n, decimals = 4) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '--';
  return v.toFixed(decimals);
}

function fxSetStatus(msg) {
  if (fxStatusEl) fxStatusEl.textContent = msg;
}

function fxSetUpdatedNow() {
  if (!fxUpdatedAtEl) return;
  const now = new Date();
  fxUpdatedAtEl.textContent = `Actualizado: ${now.toLocaleTimeString('es-BO')}`;
}

const FX_CACHE_KEY = 'fx_last_parallel_quote';

function fxSaveCache(buyPrice, sellPrice, sourceLabel) {
  try {
    localStorage.setItem(FX_CACHE_KEY, JSON.stringify({
      buyPrice,
      sellPrice,
      sourceLabel,
      ts: Date.now()
    }));
  } catch {}
}

function fxLoadCache() {
  try {
    const raw = localStorage.getItem(FX_CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!Number.isFinite(Number(obj?.buyPrice)) || !Number.isFinite(Number(obj?.sellPrice))) return null;
    return obj;
  } catch { return null; }
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function median(list) {
  if (!list.length) return NaN;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

function extractP2PPrices(data) {
  return (data || [])
    .map(x => Number(x?.adv?.price))
    .filter(x => Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);
}

async function fetchParallelFromBinance() {
  // Direct endpoints (work locally, blocked by CORS on GitHub Pages)
  const directEndpoints = [
    'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search',
    'https://www.binance.com/bapi/c2c/v2/friendly/c2c/adv/search'
  ];
  // CORS proxy endpoints (for static hosting like GitHub Pages)
  const proxyEndpoints = [
    'https://corsproxy.io/?' + encodeURIComponent('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search'),
    'https://api.allorigins.win/raw?url=' + encodeURIComponent('https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search')
  ];
  const allEndpoints = [...directEndpoints, ...proxyEndpoints];

  const buildBody = (tradeType) => ({
    proMerchantAds: false,
    page: 1,
    rows: 20,
    payTypes: [],
    countries: [],
    publisherType: null,
    fiat: 'BOB',
    tradeType,
    asset: 'USDT'
  });

  for (const p2pUrl of allEndpoints) {
    try {
      const [buyRes, sellRes] = await Promise.all([
        fetchJsonWithTimeout(p2pUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildBody('BUY'))
        }),
        fetchJsonWithTimeout(p2pUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildBody('SELL'))
        })
      ]);
      if (!buyRes.ok || !sellRes.ok) continue;

      const buyData = await buyRes.json();
      const sellData = await sellRes.json();
      const buyPrices = extractP2PPrices(buyData?.data);
      const sellPrices = extractP2PPrices(sellData?.data);
      const buyPrice = median(buyPrices);
      const sellPrice = median(sellPrices);
      if (Number.isFinite(buyPrice) && Number.isFinite(sellPrice) && buyPrice > 7) {
        return { buyPrice, sellPrice, source: 'Paralelo P2P (Binance)' };
      }
    } catch {
      // try next endpoint
    }
  }
  return null;
}

// CriptoYa: aggregated P2P USDT/BOB rates for Latin America (CORS-friendly)
async function fetchParallelFromCriptoYa() {
  const urls = [
    'https://criptoya.com/api/usdt/bob/1',
    'https://criptoya.com/api/usdt/bob'
  ];
  for (const url of urls) {
    try {
      const res = await fetchJsonWithTimeout(url);
      if (!res.ok) continue;
      const data = await res.json();
      // CriptoYa returns an object with exchange names as keys, each with ask/bid/totalAsk/totalBid
      const exchanges = Object.values(data).filter(ex => ex && typeof ex === 'object' && Number.isFinite(Number(ex.totalAsk || ex.ask)));
      if (!exchanges.length) continue;
      const asks = exchanges.map(ex => Number(ex.totalAsk || ex.ask)).filter(x => Number.isFinite(x) && x > 7).sort((a, b) => a - b);
      const bids = exchanges.map(ex => Number(ex.totalBid || ex.bid)).filter(x => Number.isFinite(x) && x > 7).sort((a, b) => a - b);
      const buyPrice = median(asks);
      const sellPrice = median(bids);
      if (Number.isFinite(buyPrice) && Number.isFinite(sellPrice)) {
        return { buyPrice, sellPrice, source: 'Paralelo P2P (CriptoYa)' };
      }
    } catch {
      // try next URL
    }
  }
  return null;
}

// Bitget P2P as another CORS-friendly alternative
async function fetchParallelFromBitget() {
  try {
    const res = await fetchJsonWithTimeout('https://www.bitget.com/v1/p2p/pub/adv/queryAdvList', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        coinId: 'USDT',
        fiatId: 'BOB',
        side: 1, // buy
        page: 1,
        size: 10
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    const prices = (data?.data?.dataList || [])
      .map(x => Number(x?.price))
      .filter(x => Number.isFinite(x) && x > 7)
      .sort((a, b) => a - b);
    if (!prices.length) return null;
    const buyPrice = median(prices);

    const res2 = await fetchJsonWithTimeout('https://www.bitget.com/v1/p2p/pub/adv/queryAdvList', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coinId: 'USDT', fiatId: 'BOB', side: 2, page: 1, size: 10 })
    });
    let sellPrice = buyPrice;
    if (res2.ok) {
      const data2 = await res2.json();
      const sellPrices = (data2?.data?.dataList || [])
        .map(x => Number(x?.price))
        .filter(x => Number.isFinite(x) && x > 7)
        .sort((a, b) => a - b);
      if (sellPrices.length) sellPrice = median(sellPrices);
    }
    return { buyPrice, sellPrice, source: 'Paralelo P2P (Bitget)' };
  } catch {
    return null;
  }
}

async function fetchFallbackMarket() {
  // This only returns the OFFICIAL rate — clearly marked so the user knows
  try {
    const res = await fetchJsonWithTimeout('https://open.er-api.com/v6/latest/USD');
    if (res.ok) {
      const data = await res.json();
      const p = Number(data?.rates?.BOB);
      if (Number.isFinite(p) && p > 0) {
        return { buyPrice: p, sellPrice: p, source: '⚠️ Tasa OFICIAL (no paralelo)' };
      }
    }
  } catch {}
  return null;
}

async function refreshFxWidget() {
  if (!fxParallelBuyEl || !fxParallelSellEl || !fxParallelMidEl) return;
  try {
    fxSetStatus('Actualizando...');
    if (fxRefreshBtn) fxRefreshBtn.disabled = true;

    // Try P2P sources in order (all return the parallel rate)
    let result = await fetchParallelFromBinance();
    if (!result) result = await fetchParallelFromCriptoYa();
    if (!result) result = await fetchParallelFromBitget();
    const isLiveParallel = !!result;

    // If all P2P sources fail, try cache first (it has a recent parallel rate)
    if (!result) {
      const cached = fxLoadCache();
      if (cached && Number(cached.buyPrice) > 7) {
        const ageMin = Math.round((Date.now() - (cached.ts || 0)) / 60000);
        result = {
          buyPrice: Number(cached.buyPrice),
          sellPrice: Number(cached.sellPrice),
          source: `Último dato paralelo (hace ${ageMin} min)`
        };
      }
    }

    // Last resort: official rate (clearly marked as NOT parallel)
    if (!result) result = await fetchFallbackMarket();

    if (!result) throw new Error('Sin datos disponibles de tipo de cambio');

    const { buyPrice, sellPrice, source } = result;
    fxSetStatus(source);
    // Only cache if it's a real parallel rate (> 7 BOB/USD)
    if (buyPrice > 7) fxSaveCache(buyPrice, sellPrice, source);
    if (isLiveParallel) dollarPrediction?.recordSample(buyPrice, sellPrice, source);

    const midPrice = (buyPrice + sellPrice) / 2;
    fxParallelBuyEl.textContent = fxFmt(buyPrice, 4);
    fxParallelSellEl.textContent = fxFmt(sellPrice, 4);
    fxParallelMidEl.textContent = fxFmt(midPrice, 4);
    fxSetUpdatedNow();
  } catch (err) {
    console.error('FX widget error', err);
    fxSetStatus('Sin conexión (reintentando)');
  } finally {
    if (fxRefreshBtn) fxRefreshBtn.disabled = false;
  }
}

fxRefreshBtn?.addEventListener('click', refreshFxWidget);

function initDollarPrediction() {
  if (typeof DollarPredictionModule === 'undefined' || typeof DollarPredictionUI === 'undefined') return;
  dollarPrediction = new DollarPredictionModule();
  dollarPredictionUI = new DollarPredictionUI(dollarPrediction);
  dollarPredictionUI.render();
  dollarPrediction.refreshAll();
  setInterval(() => dollarPrediction.refreshAll(), 5 * 60 * 1000);
  const btn = document.getElementById('fxpRefreshBtn');
  btn?.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await Promise.all([refreshFxWidget(), dollarPrediction.refreshAll(true)]);
    } finally {
      btn.disabled = false;
    }
  });
}

function updateHomeClock() {
  const now = new Date();
  if (homeCurrentTimeEl) homeCurrentTimeEl.textContent = now.toLocaleTimeString('es-BO', { hour12: false });
  if (homeCurrentDateEl) {
    homeCurrentDateEl.textContent = now.toLocaleDateString('es-BO', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  }
}

function weatherCodeToText(code) {
  const map = {
    0: 'Despejado',
    1: 'Mayormente despejado',
    2: 'Parcialmente nublado',
    3: 'Nublado',
    45: 'Niebla',
    48: 'Niebla con escarcha',
    51: 'Llovizna ligera',
    53: 'Llovizna moderada',
    55: 'Llovizna intensa',
    61: 'Lluvia ligera',
    63: 'Lluvia moderada',
    65: 'Lluvia intensa',
    71: 'Nieve ligera',
    73: 'Nieve moderada',
    75: 'Nieve intensa',
    80: 'Chubascos ligeros',
    81: 'Chubascos moderados',
    82: 'Chubascos intensos',
    95: 'Tormenta',
    96: 'Tormenta con granizo',
    99: 'Tormenta fuerte con granizo'
  };
  return map[Number(code)] || 'Sin dato';
}

async function refreshHomeWeather() {
  if (!homeWeatherTempEl || !homeWeatherTextEl) return;
  try {
    if (homeWeatherStatusEl) homeWeatherStatusEl.textContent = 'Actualizando...';
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=-16.5&longitude=-68.15&current=temperature_2m,weather_code&timezone=auto';
    const res = await fetchJsonWithTimeout(url, {}, 9000);
    if (!res.ok) throw new Error('weather http error');
    const data = await res.json();
    const temp = Number(data?.current?.temperature_2m);
    const code = Number(data?.current?.weather_code);
    homeWeatherTempEl.textContent = Number.isFinite(temp) ? `${temp.toFixed(1)}°C` : '--°C';
    homeWeatherTextEl.textContent = weatherCodeToText(code);
    if (homeWeatherStatusEl) homeWeatherStatusEl.textContent = 'La Paz';
    if (homeWeatherUpdatedEl) {
      homeWeatherUpdatedEl.textContent = `Actualizado: ${new Date().toLocaleTimeString('es-BO')}`;
    }
  } catch (e) {
    console.warn('weather error', e);
    if (homeWeatherStatusEl) homeWeatherStatusEl.textContent = 'Sin conexión';
    homeWeatherTextEl.textContent = 'No se pudo cargar el clima';
  }
}

function toDateYmd(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isWorldCupEvent(ev) {
  const text = `${ev?.strLeague || ''} ${ev?.strEvent || ''}`.toLowerCase();
  return text.includes('world cup') || text.includes('mundial');
}

function formatEventDateTimeBo(ev) {
  const boTimeZone = 'America/La_Paz';
  const dateRaw = String(ev?.dateEvent || '').trim();
  const timeRaw = String(ev?.strTime || '').trim();
  const tsRaw = String(ev?.strTimestamp || '').trim();

  let parsed = null;
  if (tsRaw) {
    const hasTimeZone = /Z$|[+-]\d{2}:?\d{2}$/.test(tsRaw);
    const fromTs = new Date(hasTimeZone ? tsRaw : `${tsRaw}Z`);
    if (!Number.isNaN(fromTs.getTime())) parsed = fromTs;
  }
  if (!parsed && dateRaw && timeRaw) {
    // TheSportsDB usually returns UTC time. We force UTC to display correct BO local time.
    const isoUtc = `${dateRaw}T${timeRaw.replace(' ', '')}Z`;
    const fromParts = new Date(isoUtc);
    if (!Number.isNaN(fromParts.getTime())) parsed = fromParts;
  }
  if (!parsed && dateRaw) {
    const fromDate = new Date(`${dateRaw}T00:00:00Z`);
    if (!Number.isNaN(fromDate.getTime())) parsed = fromDate;
  }

  if (!parsed) return [dateRaw, timeRaw].filter(Boolean).join(' ').trim();

  const dateBo = parsed.toLocaleDateString('es-BO', {
    timeZone: boTimeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
  const timeBo = parsed.toLocaleTimeString('es-BO', {
    timeZone: boTimeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  return `${dateBo} ${timeBo} (BO)`;
}

function renderMatchesList(container, list, opts = {}) {
  if (!container) return;
  if (!list?.length) {
    container.innerHTML = `<div class="home-empty">${opts.emptyText || 'Sin datos disponibles por ahora.'}</div>`;
    return;
  }
  container.innerHTML = list.map(ev => {
    const hasScore = ev.intHomeScore !== null && ev.intHomeScore !== undefined;
    const home = ev.strHomeTeam || 'Local';
    const away = ev.strAwayTeam || 'Visitante';
    const dateText = formatEventDateTimeBo(ev);
    const score = hasScore
      ? `${ev.intHomeScore ?? 0} - ${ev.intAwayScore ?? 0}`
      : 'vs';
    return `
      <div class="home-match-row">
        <div class="home-match-teams">${home} <strong>${score}</strong> ${away}</div>
        <div class="home-match-meta">${dateText || 'Horario por confirmar'}${ev.strLeague ? ` • ${ev.strLeague}` : ''}</div>
      </div>
    `;
  }).join('');
}

async function refreshWorldCupCards() {
  if (homeMatchesNextStatusEl) homeMatchesNextStatusEl.textContent = 'Actualizando...';
  if (homeMatchesTodayStatusEl) homeMatchesTodayStatusEl.textContent = 'Actualizando...';

  let nextEvents = [];
  let todayEvents = [];
  try {
    const [nextRes, dayRes] = await Promise.all([
      fetchJsonWithTimeout('https://www.thesportsdb.com/api/v1/json/3/eventsnextleague.php?id=4429', {}, 10000),
      fetchJsonWithTimeout(`https://www.thesportsdb.com/api/v1/json/3/eventsday.php?d=${toDateYmd()}&s=Soccer`, {}, 10000)
    ]);

    if (nextRes.ok) {
      const nextData = await nextRes.json();
      nextEvents = (nextData?.events || []).slice(0, 8);
    }

    if (dayRes.ok) {
      const dayData = await dayRes.json();
      const allDay = dayData?.events || [];
      todayEvents = allDay.filter(isWorldCupEvent).slice(0, 8);
    }

    if (!todayEvents.length && nextEvents.length) {
      const today = toDateYmd();
      todayEvents = nextEvents.filter(ev => String(ev.dateEvent || '') === today && ev.intHomeScore !== null).slice(0, 8);
    }

    renderMatchesList(homeMatchesNextEl, nextEvents, { emptyText: 'No se encontraron próximos partidos del Mundial.' });
    renderMatchesList(homeMatchesTodayEl, todayEvents, { emptyText: 'No hay resultados del Mundial para hoy.' });

    if (homeMatchesNextStatusEl) homeMatchesNextStatusEl.textContent = nextEvents.length ? `${nextEvents.length} partidos` : 'Sin datos';
    if (homeMatchesTodayStatusEl) homeMatchesTodayStatusEl.textContent = todayEvents.length ? `${todayEvents.length} partidos` : 'Sin resultados';
  } catch (e) {
    console.warn('world cup cards error', e);
    renderMatchesList(homeMatchesNextEl, [], { emptyText: 'No fue posible cargar próximos partidos en este momento.' });
    renderMatchesList(homeMatchesTodayEl, [], { emptyText: 'No fue posible cargar resultados del día en este momento.' });
    if (homeMatchesNextStatusEl) homeMatchesNextStatusEl.textContent = 'Sin conexión';
    if (homeMatchesTodayStatusEl) homeMatchesTodayStatusEl.textContent = 'Sin conexión';
  }
}

// Navegación
const navButtons = document.querySelectorAll('.nav-btn[data-target]');
navButtons.forEach(btn => btn.addEventListener('click', () => showSection(btn.dataset.target)));
const homeShortcutButtons = document.querySelectorAll('.home-shortcut-btn[data-go-section]');
homeShortcutButtons.forEach(btn => btn.addEventListener('click', () => showSection(btn.dataset.goSection)));
function showSection(id) {
  if(!Access.can(Access.sections[id])) { Store.notice("Su rol no tiene acceso a este apartado.",true); return; }
  currentSectionId = id;
  window.Experience?.onSection(id);
  document.querySelectorAll('.nav-btn').forEach(btn=>{btn.classList.toggle('active',btn.dataset.target===id);if(btn.dataset.target===id)btn.setAttribute('aria-current','page');else btn.removeAttribute('aria-current');});
  document.querySelectorAll('.page-section').forEach(s => s.hidden = s.id !== id);
  if (id === 'realizarVentaSection') {
    const saleNumInput = document.getElementById('venNum');
    if (saleNumInput && !String(saleNumInput.value || '').trim()) {
      setAutoSaleNumber();
    }
  }
  void refreshVisibleViews();
  if (id === 'dashboardSection') window.Dashboard?.onShow();
  if (id === 'predictionSection') {
    if(!dollarPredictionUI)initDollarPrediction();
    dollarPredictionUI?.onShow();
  }
  if (id === 'cotizacionSection') {
    window.cotizaciones?.onShow();
  }
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
  return `V-${y}${m}${day}-${hh}${mm}${ss}-${crypto.randomUUID().slice(0,8)}`;
}
function setAutoSaleNumber() {
  const inp = document.getElementById('venNum');
  if (inp) inp.value = genSaleNumber();
}

// Mostrar sección por defecto
showSection('homeSection');

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
let ventaSubmitInProgress = false;
let ventaEditSaveInProgress = false;

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

// Admin configs & tools
const cfgBrandName = document.getElementById('cfgBrandName');
const cfgCoverageDays = document.getElementById('cfgCoverageDays');
const cfgNavigation = document.getElementById('cfgNavigation');
const cfgGuardar = document.getElementById('cfgGuardar');
const exportProductosBtn = document.getElementById('exportProductos');
const exportMovimientosBtn = document.getElementById('exportMovimientos');
const exportVentasBtn = document.getElementById('exportVentas');
const exportVentasItemsBtn = document.getElementById('exportVentasItems');
const bulkCatSelect = document.getElementById('bulkCatSelect');
const bulkPercentInput = document.getElementById('bulkPercent');
const bulkApplyBtn = document.getElementById('bulkApply');

// Global Settings
const SETTINGS_KEY = 'appSettings';
function getSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const s = {...(raw ? JSON.parse(raw) : {}),...Access.settings};
    return {
      brandName: s.brandName || 'IMPORTACIONES MB',
      coverageDays: Number(s.coverageDays || 14),
      navigation: s.navigation === 'horizontal' ? 'horizontal' : 'lateral'
    };
  } catch { return { brandName: 'IMPORTACIONES MB', coverageDays: 14 }; }
}
function saveSettings(s) {
  const cur = getSettings();
  const merged = { ...cur, ...s };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
}
function initAdminSettingsUI() {
  const s = getSettings();
  if (cfgBrandName) cfgBrandName.value = s.brandName || '';
  if (cfgCoverageDays) cfgCoverageDays.value = String(s.coverageDays || 14);
  if (cfgNavigation) cfgNavigation.value = s.navigation || 'lateral';
  document.documentElement.dataset.navigation = s.navigation || 'lateral';
}
cfgGuardar?.addEventListener('click', () => Store.run('settings',cfgGuardar,async () => {
  const brand = (cfgBrandName?.value || '').trim() || 'IMPORTACIONES MB';
  let cov = parseInt(cfgCoverageDays?.value || '14', 10);
  if (!Number.isFinite(cov) || cov <= 0) cov = 14;
  if(Access.can('settings.manage')) await Access.saveSettings({brandName:brand,coverageDays:cov});
  saveSettings({ navigation: cfgNavigation?.value === 'horizontal' ? 'horizontal' : 'lateral' });
  initAdminSettingsUI();
  window.Dashboard?.onShow();
  alert('Configuraciones guardadas.');
  refreshDashboard();
}));

async function populateBulkCategories() {
  try {
    const list = await allProducts();
    const cats = Array.from(new Set(list.map(p => (p.categoria || 'General')))).sort();
    if (bulkCatSelect) {
      bulkCatSelect.innerHTML = '<option value="">Seleccione</option>' + cats.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('');
    }
  } catch (e) { console.warn('bulk cats warn', e); }
}
bulkApplyBtn?.addEventListener('click',()=>Store.run('prices',bulkApplyBtn,async()=>{
  const cat=bulkCatSelect.value,pct=Store.number(bulkPercentInput.value,'Porcentaje',{min:-100});
  if(!cat) throw new Error('Seleccione una categoría.');
  const list=(await allProducts()).filter(p=>(p.categoria||'General')===cat);
  if(!list.length) throw new Error('La categoría no tiene productos.');
  if(!confirm('Se cambiarán los precios de '+list.length+' productos en '+pct+'%. ¿Continuar?')) return;
  await Store.commit('products_save',{products:list.map(p=>({id:p.id,expected:p,changes:{precio:Store.money(p.precio*(1+pct/100))}}))},'prices');
  Store.notice('Todos los precios se actualizaron.');
  refreshAfterWrite();
}));


// Admin Exports
exportProductosBtn?.addEventListener('click', async () => {
  if(!Access.can('exports.read')) return Store.notice('No tiene permiso para exportar.',true);
  try {
    if (!(await loadVendor('xlsx'))) { alert('Exportador Excel no disponible. Revise la conexión.'); return; }
    const list = await allProducts();
    if (!list || !list.length) { alert('No hay productos para exportar.'); return; }
    const data = list.map(p => ({
      'ITEM': p.item,
      'Nombre': p.nombre,
      'Categoría': p.categoria || 'General',
      'CEJA': p.ceja ?? 0,
      'SENKATA': p.senkata ?? 0,
      'Unidad': p.unidad || 'PCS',
      'Precio (Bs)': Number(p.precio ?? 0)
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Productos');
    XLSX.writeFile(wb, `Productos_${Store.date()}.xlsx`);
  } catch (e) { console.error('export productos', e); alert('No se pudo exportar productos.'); }
});
exportMovimientosBtn?.addEventListener('click', async () => {
  if(!Access.can('exports.read')) return Store.notice('No tiene permiso para exportar.',true);
  try {
    if (!(await loadVendor('xlsx'))) { alert('Exportador Excel no disponible. Revise la conexión.'); return; }
    const list = await allMovements();
    if (!list || !list.length) { alert('No hay movimientos para exportar.'); return; }
    const data = list.map(m => ({
      'Fecha': m.fecha,
      'Tipo': m.tipo,
      'ITEM': m.item || '',
      'Nombre': m.nombre || '',
      'Cantidad': m.cantidad || 0,
      'Detalle': m.detalle || '',
      'Total (Bs)': Number(m.total || 0),
      'Descuento (Bs)': Number(m.descuento || 0)
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Movimientos');
    XLSX.writeFile(wb, `Movimientos_${Store.date()}.xlsx`);
  } catch (e) { console.error('export movs', e); alert('No se pudo exportar movimientos.'); }
});
exportVentasBtn?.addEventListener('click', async () => {
  if(!Access.can('exports.read')) return Store.notice('No tiene permiso para exportar.',true);
  try {
    if (!(await loadVendor('xlsx'))) { alert('Exportador Excel no disponible. Revise la conexión.'); return; }
    const data = await Store.all('sales');
    const activeIds=new Set((await activeSales(null,data)).map(s=>s.id));
    const list = data || [];
    if (!list.length) { alert('No hay ventas para exportar.'); return; }
    const sheetData = list.map(s => ({
      'Fecha': s.fecha,
      'N°': s.numero,
      'Cliente': s.cliente,
      'Subtotal (Bs)': Number(s.subtotal || 0),
      'Descuento (%)': Number(s.descuento_pct || 0),
      'Descuento (Bs)': Number(s.descuento || 0),
      'Total (Bs)': Number(s.total || 0),
      'Estado': activeIds.has(s.id) ? 'vigente' : 'anulada',
      'Total vigente (Bs)': activeIds.has(s.id) ? Number(s.total || 0) : 0
    }));
    const ws = XLSX.utils.json_to_sheet(sheetData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Ventas');
    XLSX.writeFile(wb, `Ventas_${Store.date()}.xlsx`);
  } catch (e) { console.error('export ventas', e); alert('No se pudo exportar ventas.'); }
});
exportVentasItemsBtn?.addEventListener('click', async () => {
  if(!Access.can('exports.read')) return Store.notice('No tiene permiso para exportar.',true);
  try {
    if (!(await loadVendor('xlsx'))) { alert('Exportador Excel no disponible. Revise la conexión.'); return; }
    const [data,active] = await Promise.all([Store.all('sales_items'),activeSales()]);
    const activeIds=new Set(active.map(s=>s.id));
    const list = data || [];
    if (!list.length) { alert('No hay items de ventas para exportar.'); return; }
    const sheetData = list.map(r => ({
      'Venta ID': r.sale_id,
      'ITEM': r.item,
      'Nombre': r.nombre,
      'Cantidad': r.cantidad || 0,
      'Precio (Bs)': Number(r.precio || 0),
      'Subtotal (Bs)': Number(r.subtotal || 0),
      'Estado': !activeIds.has(r.sale_id) ? 'Venta anulada' : r.cantidad === 0 ? 'Línea retirada' : 'Vigente'
    }));
    const ws = XLSX.utils.json_to_sheet(sheetData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'VentasItems');
    XLSX.writeFile(wb, `VentasItems_${Store.date()}.xlsx`);
  } catch (e) { console.error('export ventas items', e); alert('No se pudo exportar los ítems de ventas.'); }
});

// Utilidades de productos (Supabase)
async function allProducts() { return Store.all('products'); }
function resolveProductFromList(rows,item) {
  const exact=rows.find(p=>p.item===String(item).trim());
  if(exact)return exact;
  const matches=rows.filter(p=>normalizeItemKey(p.item)===normalizeItemKey(item));
  if(matches.length>1)throw new Error('Hay varios productos con ese código. Escriba el ITEM exacto: '+item);
  return matches[0]||null;
}
async function findProductByITEM(item) {
  // Consulta solo ese ITEM (sin distinguir mayúsculas) para mostrar existencias al día
  // sin descargar el catálogo completo en cada búsqueda.
  const key = String(item || '').trim();
  if (!key) return null;
  const rows = await Store.all('products', q => q.ilike('item', key.replace(/[\\%_]/g, '\\$&')));
  return resolveProductFromList(rows, key) || resolveProductFromList(await Store.catalog(), key);
}
// Resuelve IDs con el catálogo breve; si falta algún ITEM (p. ej. recién creado en otro equipo)
// se consulta el inventario completo antes de informar que no existe.
async function productsFor(keys) {
  const cached = await Store.catalog();
  if (keys.every(k => !String(k || '').trim() || resolveProductFromList(cached, k))) return cached;
  return allProducts();
}
async function upsertProduct() { throw new Error('Use el guardado transaccional de productos.'); }


function normalizeItemKey(item) {
  return String(item || '').trim().toLowerCase();
}

function aggregateSaleItems(rawItems) {
  const map = new Map();
  for (const it of rawItems) {
    const key = normalizeItemKey(it.item);
    if (!key || !Number.isFinite(it.cantidad) || it.cantidad <= 0) continue;
    const qty = Number(it.cantidad || 0);
    const price = Number(it.precioVenta || 0);
    const subtotal = qty * price;
    if (!map.has(key)) {
      map.set(key, { item: String(it.item || '').trim(), cantidad: qty, subtotal, lastPrice: price });
    } else {
      const prev = map.get(key);
      prev.cantidad += qty;
      prev.subtotal += subtotal;
      prev.lastPrice = price;
    }
  }
  return Array.from(map.values()).map(it => ({
    item: it.item,
    cantidad: it.cantidad,
    precioVenta: it.cantidad > 0 ? Number((it.subtotal / it.cantidad).toFixed(4)) : Number(it.lastPrice || 0)
  }));
}

// Movimientos (Supabase)
async function allMovements() { return Store.all('movements'); }
async function activeSales(configure, preloaded) {
  // Las anulaciones se consultan filtradas; no se descarga toda la tabla de movimientos.
  const [sales, cancelled] = await Promise.all([preloaded || Store.all('sales', configure), Store.cancellationNumbers()]);
  return sales.filter(s => s.estado !== 'anulada' && !cancelled.has(String(s.numero)));
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
  const datalistId = 'datalistProductos';
  let dl = document.getElementById(datalistId);
  if (!dl) {
    dl = document.createElement('datalist');
    dl.id = datalistId;
    document.body.appendChild(dl);
  }
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
  let lookup = 0;
  skuInput.addEventListener('change', async () => {
    const request = ++lookup;
    const typed = skuInput.value;
    const nombreInput = row.querySelector('.ven-nombre');
    const cejaInput = row.querySelector('.ven-ceja');
    const precioInput = row.querySelector('.ven-pvent');
    let p = null;
    try { p = await findProductByITEM(typed); }
    catch (e) { if (request === lookup) Store.notice(e.message || 'No se pudo buscar el producto.', true); }
    // Ignora respuestas viejas si el usuario cambió el ITEM mientras se buscaba.
    if (request !== lookup || skuInput.value !== typed) return;
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
(async () => { if(Access.can('sales.create')) { venItemsDiv.appendChild(await newVentaRow()); recalcVentaTotals(); } })().catch(e=>Store.notice(e.message,true));

// Guardar ingreso
formIngreso.addEventListener('submit', e => {
  e.preventDefault();
  Store.run('receipt',formIngreso.querySelector('[type=submit]'),async () => {
    const num=document.getElementById('ingNum').value.trim(), fecha=document.getElementById('ingFecha').value, proveedor=document.getElementById('ingProveedor').value.trim();
    const items=[...ingItemsDiv.querySelectorAll('.item-row')].map(r=>({
      sku:r.querySelector('.ing-sku').value.trim(), nombre:r.querySelector('.ing-nombre').value.trim(),categoria:r.querySelector('.ing-cat').value.trim()||'General',
      cantidad:Store.number(r.querySelector('.ing-cant').value,'Cantidad',{integer:true,min:1}),
      precioCompra:Store.money(Store.number(r.querySelector('.ing-pcomp').value,'Costo')),
      precioVenta:Store.money(Store.number(r.querySelector('.ing-pvent').value||'0','Precio'))
    }));
    if (!num||!fecha||!proveedor||!items.length||items.some(i=>!i.sku||!i.nombre)) throw new Error('Complete todos los datos del ingreso.');
    const result=await Store.commit('receipt',{numero:num,fecha,proveedor,items:items.map(i=>({...i,item:i.sku}))});
    Store.notice('Ingreso guardado. Existencias actualizadas.');
    try {
      renderComprobante('ingreso',{comprobante:{numero:num,fecha,entidad:proveedor},items,total:result.total},ingresoComprobanteBody,ingresoComprobante);
      ingImprimirBtn.disabled=false;
      formIngreso.reset(); ingItemsDiv.replaceChildren(newIngresoRow()); document.getElementById('ingFecha').value=Store.date();
    } catch (uiError) {
      console.error(uiError);
      Store.notice('Ingreso '+num+' guardado. No se pudo preparar el formulario siguiente; recargue la página.', true);
    }
    refreshAfterWrite();
  });
});


ingLimpiarBtn.addEventListener('click', () => {
  formIngreso.reset();
  document.getElementById('ingFecha').value=Store.date();
  ingItemsDiv.innerHTML = '';
  ingItemsDiv.appendChild(newIngresoRow());
  ingresoComprobante.hidden = true;
  ingImprimirBtn.disabled = true;
});

// Guardar venta (solo desde CEJA) con descuento
formVenta.addEventListener('submit', e => {
  e.preventDefault();
  Store.run('sale',venGuardarBtn,async () => {
    const num=document.getElementById('venNum').value.trim(),fecha=document.getElementById('venFecha').value,cliente=document.getElementById('venCliente').value.trim();
    const pct=Store.money(Store.number(document.getElementById('venDescPct').value||0,'Descuento',{max:100}));
    const products=await productsFor([...venItemsDiv.querySelectorAll('.ven-sku')].map(i=>i.value));
    const items=[...venItemsDiv.querySelectorAll('tr')].map(r=>{
      const item=r.querySelector('.ven-sku').value.trim(); const p=resolveProductFromList(products,item);
      if(!p) throw new Error('Producto no encontrado: '+item);
      return {product_id:p.id,item:p.item,nombre:p.nombre,cantidad:Store.number(r.querySelector('.ven-cant').value,'Cantidad',{integer:true,min:1}),precio:Store.money(Store.number(r.querySelector('.ven-pvent').value,'Precio'))};
    });
    if(!num||!fecha||!cliente||!items.length) throw new Error('Complete cliente, fecha y productos.');
    const result=await Store.commit('sale_create',{numero:num,fecha,cliente,descuento_pct:pct,items});
    Store.notice('Venta '+num+' guardada correctamente.');
    // Desde aquí los fallos visuales jamás revierten stock.
    try {
      window.dispatchEvent(new CustomEvent('venta:guardada',{detail:{numero:num}}));
      renderComprobante('venta',{comprobante:{numero:num,fecha,entidad:cliente},items:items.map(i=>({...i,precioVenta:i.precio})),...result},ventaComprobanteBody,ventaComprobante);
      venImprimirBtn.disabled=false;
      formVenta.reset(); venItemsDiv.replaceChildren(await newVentaRow()); setAutoSaleNumber(); document.getElementById('venFecha').value=Store.date(); recalcVentaTotals();
    } catch (uiError) {
      console.error(uiError);
      Store.notice('Venta '+num+' guardada. No se pudo preparar el formulario siguiente; recargue la página antes de otra venta.', true);
    }
    refreshAfterWrite();
  });
});


venLimpiarBtn.addEventListener('click', async () => {
  formVenta.reset();
  document.getElementById('venFecha').value=Store.date();
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
  const brand = getSettings().brandName || 'IMPORTACIONES MB';
  const cols = esIngreso ? '<th>SKU</th><th>Nombre</th><th>Categoría</th><th>Cantidad</th><th>Precio Compra</th><th>Subtotal</th>'
                         : '<th>SKU</th><th>Nombre</th><th>Cantidad</th><th>Precio Venta</th><th>Subtotal</th>';
  const rows = mov.items.map(it => {
    if (esIngreso) {
      const subtotal = (it.precioCompra || 0) * it.cantidad;
      return `<tr><td>${escapeHtml(it.sku)}</td><td>${escapeHtml(it.nombre)}</td><td>${escapeHtml(it.categoria ?? '')}</td><td>${it.cantidad}</td><td>${fmt(it.precioCompra)}</td><td>${fmt(subtotal)}</td></tr>`;
    } else {
      const subtotal = (it.precioVenta || 0) * it.cantidad;
      return `<tr><td>${escapeHtml(it.item ?? it.sku ?? '')}</td><td>${escapeHtml(it.nombre)}</td><td>${it.cantidad}</td><td>${fmt(it.precioVenta)}</td><td>${fmt(subtotal)}</td></tr>`;
    }
  }).join('');

  const tipoLabel = esIngreso ? 'Comprobante de Ingreso' : 'Comprobante de Venta';
  const entidadLabel = esIngreso ? 'Proveedor' : 'Cliente';

  targetBody.innerHTML = `
    <div class="comprobante-doc ${esIngreso ? 'comprobante-ingreso' : 'comprobante-venta'}">
      <div class="comp-brand">
        <div class="brand-left">
          <div class="brand-title">${escapeHtml(brand)}</div>
          <div class="brand-sub">${tipoLabel}</div>
        </div>
        <div class="brand-right">
          <div><strong>N°:</strong> ${escapeHtml(mov.comprobante.numero)}</div>
          <div><strong>Fecha:</strong> ${escapeHtml(mov.comprobante.fecha)}</div>
        </div>
      </div>

      <div class="comp-meta">
        <div><strong>${entidadLabel}:</strong> ${escapeHtml(mov.comprobante.entidad)}</div>
        <div><strong>Tipo:</strong> ${esIngreso ? 'Ingreso' : 'Venta'}</div>
      </div>

      <table class="comp-table">
        <thead><tr>${cols}</tr></thead>
        <tbody>${rows}</tbody>
        <tfoot>
          ${!esIngreso && mov.descuento ? '<tr><td colspan="4">Subtotal</td><td>'+fmt(mov.subtotal)+'</td></tr><tr><td colspan="4">Descuento</td><td>'+fmt(mov.descuento)+'</td></tr>' : ''}
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
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttr(value) {
  return escapeHtml(value);
}

// Totals helpers
const ventaSubtotalEl = document.getElementById('ventaSubtotal');
const ventaDescuentoEl = document.getElementById('ventaDescuento');
const ventaTotalEl = document.getElementById('ventaTotal');
function setVentaTotals(sub, desc, tot) {
  if (ventaSubtotalEl) ventaSubtotalEl.textContent = fmt(sub);
  if (ventaDescuentoEl) ventaDescuentoEl.textContent = fmt(desc);
  if (ventaTotalEl) ventaTotalEl.textContent = fmt(tot);
}

// Librerías pesadas (Excel ≈880 KB, PDF ≈400 KB) se descargan solo al usarlas.
const VENDOR_SCRIPTS={xlsx:['vendor/xlsx.full.min.js'],pdf:['vendor/jspdf.umd.min.js','vendor/jspdf.autotable.min.js']};
const VENDOR_READY={xlsx:()=>!!window.XLSX,pdf:()=>!!window.jspdf?.jsPDF?.API?.autoTable};
const vendorLoads={};
function loadVendor(name){
  if(VENDOR_READY[name]())return Promise.resolve(true);
  vendorLoads[name]??=(async()=>{
    for(const src of VENDOR_SCRIPTS[name]){
      await new Promise((resolve,reject)=>{
        const el=document.createElement('script');el.src=src;el.async=false;
        const timer=setTimeout(()=>reject(new Error('Tiempo agotado al cargar '+src)),30000);
        el.onload=()=>{clearTimeout(timer);resolve();};el.onerror=()=>{clearTimeout(timer);reject(new Error('No se pudo cargar '+src));};
        document.head.append(el);
      });
    }
    return VENDOR_READY[name]();
  })().catch(e=>{delete vendorLoads[name];console.warn(e);return false;});
  return vendorLoads[name];
}
// La impresión de comprobantes es frecuente: el PDF se precarga cuando el navegador está libre.
(window.requestIdleCallback||(fn=>setTimeout(fn,4000)))(()=>void loadVendor('pdf'),{timeout:8000});

// ===== PDF helpers (jsPDF) =====
const lastComprobantes = {};
function setLastComprobante(tipo, mov) {
  lastComprobantes[tipo] = mov;
}

async function descargarComprobantePDF(tipo, options = {}) {
  try {
    const payload = options.payload || lastComprobantes[tipo] || null;
    if (!payload) { alert('No hay comprobante disponible para exportar.'); return; }
    const esIngreso = tipo === 'ingreso';
    const esCotizacion = tipo === 'cotizacion';
    const tituloDocumento = esCotizacion ? 'COTIZACIÓN' : esIngreso ? 'Comprobante de Ingreso' : 'Comprobante de Venta';
    const brand = getSettings().brandName || 'IMPORTACIONES MB';
    await loadVendor('pdf');
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
    const brandLines=doc.splitTextToSize(String(brand || 'IMPORTACIONES MB'),pageWidth-80);
    doc.text(brandLines, 40, y);
    doc.setTextColor(0, 0, 0);
    y += brandLines.length*18;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.text(tituloDocumento, 40, y);
    // Meta
    const metaRight = [
      `N°: ${payload.comprobante.numero}`,
      `Fecha: ${payload.comprobante.fecha}`
    ];
    y += 18;
    for(const text of metaRight){const lines=doc.splitTextToSize(text,pageWidth-80);doc.text(lines,40,y);y+=lines.length*14;}
    if(esCotizacion){
      doc.setTextColor(110,75,15);
      doc.text('Documento informativo. No es una venta ni un comprobante de pago.',40,y);y+=16;
      doc.setTextColor(0,0,0);
      doc.text(`Válida hasta: ${payload.validaHasta || '-'}`,40,y);y+=18;
    }
    // Entidad
    doc.setFont('helvetica', 'bold'); doc.text(esIngreso ? 'Proveedor:' : 'Cliente:', 40, y);
    doc.setFont('helvetica', 'normal');
    const entityLines=doc.splitTextToSize(String(payload.comprobante.entidad || '-'),pageWidth-150);
    doc.text(entityLines,110,y); y+=entityLines.length*14;
    doc.setFont('helvetica', 'bold'); doc.text('Tipo:', 40, y);
    doc.setFont('helvetica', 'normal'); doc.text(esCotizacion ? 'Cotización' : esIngreso ? 'Ingreso' : 'Venta', 80, y); y += 10;

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
      margin: { left: 40, right: 40, top: 50, bottom: 65 }
    });
    let afterTableY = doc.lastAutoTable.finalY || (y + 40);
    if(afterTableY + 85 > doc.internal.pageSize.getHeight()-65){doc.addPage();afterTableY=40;}
    if(!esIngreso && payload.descuento){
      doc.text(`Subtotal: ${fmt(payload.subtotal)}`,pageWidth-40,afterTableY+18,{align:'right'});
      doc.text(`Descuento: ${fmt(payload.descuento)}`,pageWidth-40,afterTableY+34,{align:'right'});
      afterTableY+=40;
    }
    doc.setFont('helvetica', 'bold');
    if (!esIngreso) { doc.setTextColor(59, 130, 246); }
    doc.text(`Total: ${fmt(payload.total)}`, pageWidth - 40, afterTableY + 24, { align: 'right' });
    doc.setTextColor(0, 0, 0);

    if(esCotizacion){
      const pageCount=doc.getNumberOfPages();
      for(let page=1;page<=pageCount;page++){
        doc.setPage(page);doc.setFont('helvetica','normal');doc.setFontSize(9);doc.setTextColor(90,100,115);
        const bottom=doc.internal.pageSize.getHeight()-40;
        doc.text('COTIZACIÓN - No reserva existencias. Disponibilidad a confirmar al realizar la venta.',40,bottom);
        doc.text(`${page} / ${pageCount}`,pageWidth-40,bottom+13,{align:'right'});
      }
    }
    if(options.returnDocument) return doc;
    const fileName = `${esCotizacion ? 'Cotizacion' : esIngreso ? 'Ingreso' : 'Venta'}_${payload.comprobante.numero}.pdf`;
    if (options.autoPrint) {
      // Abrir nueva pestaña e invocar impresión nativa del visor PDF
      if (doc.autoPrint) doc.autoPrint();
      const blobUrl = doc.output('bloburl');
      const opened=window.open(blobUrl, '_blank');
      if(!opened){doc.save(fileName);Store.notice('El navegador bloqueó la ventana de impresión. Se descargó el PDF para imprimirlo.');}
      else {opened.opener=null;setTimeout(()=>URL.revokeObjectURL(blobUrl),60000);}
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
  const descuentoPct = Store.money(parseFloat((document.getElementById('venDescPct')?.value || '0')) || 0);
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
  const subtotal = Store.money(items.reduce((a,i)=>a+Store.money(i.cantidad*i.precio),0));
  const descuento = Store.money(subtotal * (descuentoPct/100));
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
  text=String(text).replace(/^\uFEFF/,'');
  const header=text.split(/\r?\n/)[0], delimiter=header.includes(';')?';':',';
  const rows=[]; let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(ch==='"'){
      if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;
    }else if(ch===delimiter&&!quoted){row.push(cell.trim());cell='';}
    else if((ch==='\n'||ch==='\r')&&!quoted){
      if(ch==='\r'&&text[i+1]==='\n')i++;
      row.push(cell.trim());if(row.some(Boolean))rows.push(row);row=[];cell='';
    }else cell+=ch;
  }
  if(quoted)throw new Error('CSV inválido: falta cerrar una comilla.');
  row.push(cell.trim());if(row.some(Boolean))rows.push(row);
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
  if (!Number.isSafeInteger(ceja) || ceja < 0) errors.push('CEJA inválido');
  if (!Number.isSafeInteger(senkata) || senkata < 0) errors.push('SENKATA inválido');
  if (!Number.isFinite(precio) || precio < 0) errors.push('Precio inválido');
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
      <td>${escapeHtml(r.item)}</td>
      <td>${escapeHtml(r.nombre)}</td>
      <td>${r.ceja}</td>
      <td>${r.senkata}</td>
      <td>${r.unidad}</td>
      <td>${fmt(r.precio)}</td>
      <td>${escapeHtml(r.categoria)}</td>
      <td>${r.errors.length ? `<span style="color:#b00">${r.errors.join('; ')}</span>` : '<span style="color:#0a6cff">OK</span>'}</td>
    </tr>
  `).join('');
});

csvUploadBtn?.addEventListener('click',()=>Store.run('csv',csvUploadBtn,async()=>{
  if(!csvPreparedRows.length) throw new Error('Primero previsualice el CSV.');
  if(csvPreparedRows.some(r=>r.errors.length)) throw new Error('Corrija todas las filas inválidas antes de importar.');
  const list=await allProducts(), seen=new Set();
  const products=csvPreparedRows.map(r=>{
    const key=normalizeItemKey(r.item); if(seen.has(key)) throw new Error('ITEM repetido en el archivo: '+r.item); seen.add(key);
    const p=list.find(p=>normalizeItemKey(p.item)===key);
    const changes={item:r.item,nombre:r.nombre,categoria:r.categoria,unidad:r.unidad,precio:Store.number(r.precio,'Precio'),ceja:Store.number(r.ceja,'CEJA',{integer:true}),senkata:Store.number(r.senkata,'SENKATA',{integer:true})};
    // Un CSV de catálogo nunca reemplaza existencias de productos anteriores.
    if(p){ delete changes.ceja; delete changes.senkata; delete changes.item; }
    return {id:p?.id||null,...(p?{expected:p}:{}),changes};
  });
  if(!confirm('Importar '+products.length+' productos. En los existentes solo se actualizará el catálogo y precio; sus existencias se conservarán.')) return;
  await Store.commit('products_save',{products},'csv');
  csvPreparedRows=[]; csvPreviewWrap.hidden=true; Store.notice('Importación completa guardada.');
  refreshAfterWrite();
}));


async function refreshCategoryFilter(list) {
  const cats = Array.from(new Set(list.map(p => (p.categoria || 'General')))).sort();
  invCategoria.innerHTML = '<option value="">Todas</option>' + cats.map(c => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('');
}

async function refreshInventoryUI() {
  if(!Access.can('inventory.read')) return;
  if(inventoryEditMode){inventoryPendingSync=true;return;}
  const list = await allProducts();
  const selectedCategory=invCategoria.value;
  await refreshCategoryFilter(list);
  invCategoria.value=selectedCategory;
  if(inventoryEditMode){inventoryPendingSync=true;return;}
  renderInventoryTable(list);
}

function renderInventoryTable(list) {
  invTabla.innerHTML = list.map((p, idx) => `
    <tr data-item="${escapeAttr(p.item)}">
      <td class="col-rownum">${idx + 1}</td>
      <td>${escapeHtml(p.item)}</td>
      <td>${escapeHtml(p.nombre)}</td>
      <td>${escapeHtml(p.categoria || '')}</td>
      <td>${p.ceja ?? 0}</td>
      <td>${p.senkata ?? 0}</td>
      <td>${escapeHtml(p.unidad || '')}</td>
      <td>${fmt(p.precio ?? 0)}</td>
      <td class="col-actions">
        <button class="secondary btn-edit">Editar</button>

        <button class="secondary btn-ver-ventas" title="Ver ventas y movimientos de este producto" aria-label="Ver historial de ${escapeAttr(p.item)}">🔎</button>
      </td>
    </tr>
  `).join('');
  // Wire acciones
  invTabla.querySelectorAll('.btn-edit').forEach(btn => btn.addEventListener('click', () => toggleInventoryEditMode()));
  invTabla.querySelectorAll('.btn-delete').forEach(btn => btn.addEventListener('click', onDeleteProduct));
  invTabla.querySelectorAll('.btn-ver-ventas').forEach(btn => btn.addEventListener('click', onVerVentasProducto));
}

async function onVerVentasProducto(e) {
  const tr = e.target.closest('tr');
  const item = tr?.dataset?.item;
  if (!item) return;
  await showProductoVentasModal(item);
}

let productoHistoryRequest = 0;

function renderProductoMovimientos(rows, timestampAvailable) {
  const sorted = [...rows].sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')) || b.id - a.id);
  const reversed = new Set(rows.map(m => String(m.detalle).match(/^Reversión movimiento (\d+)/)?.[1]).filter(Boolean));
  const timeFormat = new Intl.DateTimeFormat('es-BO', {
    timeZone: 'America/La_Paz', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  const warning = timestampAvailable ? '' : '<p class="note">Para consultar la hora de registro, instale migrations/003_product_movement_history.sql en el clon. Las fechas y transferencias siguen disponibles.</p>';
  if (!sorted.length) return warning + '<p>No hay movimientos registrados para este producto.</p>';
  return `${warning}
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>Fecha del movimiento</th><th>Registro (hora de Bolivia)</th><th>Origen</th><th>Destino</th><th>Cantidad</th><th>Estado</th><th>Detalle</th></tr></thead>
        <tbody>${sorted.map(m => {
          const reversal = String(m.detalle).startsWith('Reversión movimiento ');
          const registered = m.created_at ? timeFormat.format(new Date(m.created_at)) : 'Hora no registrada';
          return `<tr>
            <td>${escapeHtml(m.fecha)}</td><td>${escapeHtml(registered)}</td>
            <td>${reversal ? 'CEJA' : 'SENKATA'}</td><td>${reversal ? 'SENKATA' : 'CEJA'}</td>
            <td>${Math.abs(Number(m.cantidad))}</td>
            <td>${reversal ? 'Reversión' : reversed.has(String(m.id)) ? 'Revertido' : 'Transferencia'}</td>
            <td>${escapeHtml(cleanMovementDetalle(m.detalle))}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>
    <p class="note">Se muestran transferencias entre depósitos y sus reversiones, sin borrar el movimiento original. La fecha del movimiento es la fecha comercial; el registro indica cuándo se confirmó. Los registros antiguos sin hora se identifican explícitamente.</p>`;
}

async function showProductoVentasModal(item, view = 'sales') {
  const request = ++productoHistoryRequest;
  const body = document.getElementById('productoVentasBody');
  const titulo = document.getElementById('productoVentasTitulo');
  titulo.textContent = `Historial del producto: ${item}`;
  body.textContent = 'Cargando historial...';
  body.setAttribute('aria-busy', 'true');
  for (const [id, tabView] of [['productoHistVentas', 'sales'], ['productoHistMovimientos', 'movements']]) {
    const button = document.getElementById(id);
    button.classList.toggle('active', tabView === view);
    button.setAttribute('aria-pressed', String(tabView === view));
    button.onclick = () => showProductoVentasModal(item, tabView);
  }
  openProductoVentasModal();
  try {
    const prod = await findProductByITEM(item);
    if (request !== productoHistoryRequest) return;
    titulo.textContent = `Historial del producto: ${prod?.nombre || item} (${item})`;
    if (view === 'movements') {
      if(!Access.can('movements.read')) {body.textContent='Su rol no tiene permiso para consultar movimientos.';return;}
      const { rows, timestampAvailable } = await Store.productTransfers(item);
      if (request !== productoHistoryRequest) return;
      body.innerHTML = renderProductoMovimientos(rows, timestampAvailable);
      return;
    }

    if(!Access.can('sales.read')) {body.textContent='Su rol no tiene permiso para consultar ventas.';return;}
    // Solo las líneas del producto, sus ventas por ID y la lista de anulaciones (en paralelo).
    const annulmentsRequest=Store.cancellationNumbers();
    annulmentsRequest.catch(()=>{});
    const si=(await Store.all('sales_items',q=>q.eq('item',item))).filter(i=>i.cantidad>0);
    if (request !== productoHistoryRequest) return;
    if(!si.length){body.textContent='No hay ventas registradas para este producto.';return;}
    const saleIds=[...new Set(si.map(i=>i.sale_id))];
    const chunks=[];for(let i=0;i<saleIds.length;i+=150)chunks.push(saleIds.slice(i,i+150));
    const [salesChunks,anuladasSet]=await Promise.all([Promise.all(chunks.map(ids=>Store.all('sales',q=>q.in('id',ids)))),annulmentsRequest]);
    const sales=salesChunks.flat();
    if (request !== productoHistoryRequest) return;

    const salesMap = new Map((sales || []).map(s => [s.id, s]));

    // Build rows combining sale info and quantities/prices per occurrence
    const rows = si
      .map(r => ({ r, s: salesMap.get(r.sale_id) }))
      .filter(x => !!x.s)
      .sort((a, b) => (new Date(b.s.fecha) - new Date(a.s.fecha)) || (b.s.id - a.s.id));

    if (rows.length === 0) { body.innerHTML = '<p>No hay ventas válidas encontradas para este producto.</p>'; return; }

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
                <td>${escapeHtml(s.fecha)}</td>
                <td>${escapeHtml(s.numero)}</td>
                <td>${escapeHtml(s.cliente)}</td>
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

  } catch (e) {
    if (request !== productoHistoryRequest) return;
    console.error('producto historial modal error', e);
    body.textContent = `No se pudo cargar el historial: ${e.message}`;
    Store.notice(body.textContent, true);
  } finally {
    if (request === productoHistoryRequest) body.removeAttribute('aria-busy');
  }
}

function openProductoVentasModal() {
  const modal = document.getElementById('productoVentasModal');
  if (!modal) return;
  modal.hidden = false;
  // Wire close buttons
  modal.querySelectorAll('.modal-close').forEach(btn => btn.onclick = () => {
    ++productoHistoryRequest;
    document.getElementById('productoVentasBody').removeAttribute('aria-busy');
    modal.hidden = true;
  });
}

async function applyFilters() {
  if(inventoryEditMode){Store.notice("Guarde o descarte la edición antes de filtrar.");return;}
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
    if (!(await loadVendor('xlsx'))) { alert('Exportador Excel no disponible. Revise la conexión.'); return; }
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

// Wire edit mode buttons
document.getElementById('invEditModeToggle')?.addEventListener('click', toggleInventoryEditMode);
document.getElementById('invSaveAllBtn')?.addEventListener('click', saveAllInventoryEdits);
document.getElementById('invDiscardAll')?.addEventListener('click', discardAllInventoryEdits);

// Ventas: historial
const ventasHistTablaBody = document.getElementById('ventasHistTabla')?.querySelector('tbody');
const ventasFiltroRango = document.getElementById('ventasFiltroRango');
const ventasFiltroDesde = document.getElementById('ventasFiltroDesde');
const ventasFiltroHasta = document.getElementById('ventasFiltroHasta');
const ventasFiltroCliente = document.getElementById('ventasFiltroCliente');
const ventasFiltroAplicar = document.getElementById('ventasFiltroAplicar');
const ventasFiltroLimpiar = document.getElementById('ventasFiltroLimpiar');
const ventasVerHistoricoBtn = document.getElementById('ventasVerHistorico');
const ventasTotalFooter = document.getElementById('ventasTotalFooter');
let ventasMostrarHistoricoCompleto = false;
let ventasHistoryRequest = 0;
let ventasHistoryPage = 1;
let ventasHistoryFilterKey = '';
const SALES_PAGE_SIZE = 50;

function getDateRange() {
  const today = Store.date();
  let desde = ventasFiltroDesde?.value || null;
  let hasta = ventasFiltroHasta?.value || null;
  const rango = ventasFiltroRango?.value || 'todo';
  if (!desde && !hasta) {
    if (rango === 'hoy') {
      desde = today;
      hasta = today;
    } else if (rango === 'semana') {
      desde = DashboardModel.shift(today, -6);
      hasta = today;
    } else if (rango === 'mes') {
      desde = DashboardModel.shift(today, -29);
      hasta = today;
    }
  }
  if (desde && hasta && desde > hasta) throw new Error('La fecha Desde no puede ser posterior a Hasta.');
  return { desde, hasta, rango };
}

async function refreshVentasHistorial() {
  if(!Access.can('sales.read')) return;
  if (!ventasHistTablaBody) return;
  const request = ++ventasHistoryRequest;
  document.getElementById('ventasHistTabla').setAttribute('aria-busy', 'true');
  try {
    const range = getDateRange();
    const clienteQ = ventasFiltroCliente?.value?.trim();

    if(ventasTotalFooter)ventasTotalFooter.textContent='Calculando total del periodo…';
    const filters={...range,cliente:clienteQ};
    const filterKey=JSON.stringify([filters,ventasMostrarHistoricoCompleto]);
    if(filterKey!==ventasHistoryFilterKey){ventasHistoryFilterKey=filterKey;ventasHistoryPage=1;}
    const page=await Store.salesHistory(filters,{from:ventasMostrarHistoricoCompleto?0:(ventasHistoryPage-1)*SALES_PAGE_SIZE,size:SALES_PAGE_SIZE,complete:ventasMostrarHistoricoCompleto});
    const data=page.rows;
    if (request !== ventasHistoryRequest) return;
    renderSalesPagination(page.count,data.length);
    if (!data || data.length === 0) {
      ventasHistTablaBody.innerHTML = `<tr><td colspan="8">No hay ventas para el rango seleccionado.</td></tr>`;
      if (ventasTotalFooter) ventasTotalFooter.innerHTML = '<strong>Total ventas (sin anuladas):</strong> Bs 0.00';
      return;
    }
    ventasHistTablaBody.innerHTML = data.map(s => {
      const isAnuladaRow = s.cancelled;
      const cls = isAnuladaRow ? 'venta-anulada' : '';
      return `
      <tr class="${cls}">
        <td>${s.fecha}</td>
        <td>${escapeHtml(s.numero)}</td>
        <td>${escapeHtml(s.cliente)}</td>
        <td>${fmt(s.subtotal)}</td>
        <td>${Number(s.descuento_pct || 0).toFixed(2)}%</td>
        <td>${fmt(s.descuento || 0)}</td>
        <td>${fmt(s.total || 0)}</td>
        <td><button type="button" class="secondary btn-ver-detalles" data-sale-id="${s.id}">Ver detalles</button></td>
      </tr>`;
    }).join('');
    // wire details buttons
    document.querySelectorAll('.btn-ver-detalles').forEach(btn => btn.addEventListener('click', onVerDetallesVenta));

    const nonAnuladas = data.filter(s => !s.cancelled);
    const totalPeriodo = nonAnuladas.reduce((a, s) => a + Number(s.total || 0), 0);
    const showTotal=total=>{if (ventasTotalFooter && request===ventasHistoryRequest) {
      const singleDay = range.rango === 'hoy' || (range.desde && range.hasta && range.desde === range.hasta);
      ventasTotalFooter.innerHTML = singleDay
        ? `<strong>Total del día (sin anuladas):</strong> ${fmt(total)}`
        : `<strong>Total del periodo (sin anuladas):</strong> ${fmt(total)}`;
    }};
    if(ventasMostrarHistoricoCompleto||(ventasHistoryPage===1&&page.count===data.length))showTotal(totalPeriodo);
    else void Store.salesHistoryTotal(filters).then(showTotal).catch(()=>{if(request===ventasHistoryRequest&&ventasTotalFooter)ventasTotalFooter.textContent='Total no disponible. Actualice la consulta.';});
  } catch (e) {
    if (request !== ventasHistoryRequest) return;
    console.error('ventas historial exception', e);
    ventasHistTablaBody.innerHTML = `<tr><td colspan="8">${escapeHtml(e.message)}</td></tr>`;
    const pagination=document.getElementById('ventasHistPagination');if(pagination)pagination.innerHTML='';
    if (ventasTotalFooter) ventasTotalFooter.textContent = 'Total no disponible: no se pudo confirmar la consulta.';
    Store.notice('No se pudo cargar el historial de ventas. ' + e.message, true);
  } finally {
    if (request === ventasHistoryRequest) document.getElementById('ventasHistTabla').removeAttribute('aria-busy');
  }
}

function renderSalesPagination(count,length){
  const root=document.getElementById('ventasHistPagination');if(!root)return;
  const more=count===null?length===SALES_PAGE_SIZE:ventasHistoryPage*SALES_PAGE_SIZE<count;
  root.innerHTML=ventasMostrarHistoricoCompleto?`<span>${length} ventas · historial completo</span>`:`<button type="button" class="secondary" data-step="-1" ${ventasHistoryPage===1?'disabled':''}>← Anterior</button><span>Página ${ventasHistoryPage}${count===null?'':` · ${count} ventas`}</span><button type="button" class="secondary" data-step="1" ${more?'':'disabled'}>Siguiente →</button>`;
  root.querySelectorAll('[data-step]').forEach(b=>b.addEventListener('click',()=>{ventasHistoryPage+=Number(b.dataset.step);void refreshVentasHistorial();}));
}

async function onVerDetallesVenta(e) {
  const saleId = e.currentTarget.dataset.saleId;
  try {
    // Cabecera y detalle en paralelo.
    const [{ data: sale, error: saleErr }, data] = await Promise.all([
      supabase.from('sales').select('*').eq('id', saleId).maybeSingle(),
      Store.all('sales_items',q=>q.eq('sale_id',saleId))
    ]);
    if (saleErr) throw new Error('No se pudo cargar la venta: ' + saleErr.message);
    if (!sale) throw new Error('La venta no existe o no está disponible. Actualice el historial.');
    // Detect if already annulled via movements record
    let isAnulada = sale?.estado === 'anulada';
    const { data: ann, error: annError } = await supabase.from('movements').select('id').eq('detalle', `Anulación comprobante ${sale.numero}`).limit(1);
    if (annError) throw new Error('No se pudo confirmar el estado de la venta: ' + annError.message);
    if (!Array.isArray(ann)) throw new Error('Respuesta inválida al confirmar el estado de la venta.');
    isAnulada ||= ann.length > 0;

    const modal = document.getElementById('ventaDetallesModal');
    const body = document.getElementById('ventaDetallesBody');
    const rows = (data||[]).filter(it=>it.cantidad>0).map(it => `
      <tr data-item-id="${it.id}" data-item-sku="${escapeHtml(it.item)}">
        <td>${escapeHtml(it.item)}</td>
        <td>${escapeHtml(it.nombre)}</td>
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
        <div><strong>N°:</strong> ${escapeHtml(sale?.numero || '-')}</div>
        <div><strong>Fecha:</strong> ${sale?.fecha || '-'}</div>
        <div><strong>Cliente:</strong> ${escapeHtml(sale?.cliente || '-')}</div>
        <div style="grid-column: 1 / -1"><strong>Estado:</strong> ${isAnulada ? '<span style="color:#991b1b;font-weight:700">ANULADA</span>' : '<span style="color:#0b3a77;font-weight:700">VIGENTE</span>'}</div>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr><th>ITEM</th><th>Nombre</th><th>Cant.</th><th>Precio</th><th>Subtotal</th><th>Acciones</th></tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="5">Sin items</td></tr>'}</tbody>
        </table>
      </div>
      <div class="sale-totals"><div class="sale-totals-values">
        <div>Subtotal: ${fmt(subtotal)}</div>
        <div>Descuento: ${Number(descuentoPct).toFixed(2)}% (${fmt(descuentoBs)})</div>
        <div>Total: ${fmt(total)}</div>
      </div></div>
    `;
    // open modal
    modal.hidden = false;
    const closes = modal.querySelectorAll('.modal-close');
    closes.forEach(btn => btn.onclick = () => { modal.hidden = true; });


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
      const descPct = Store.money(descPctInput ? (parseFloat(descPctInput.value || '0') || 0) : (sale?.descuento_pct || 0));
      const descuentoBs = Store.money(subtotalLive * (descPct/100));
      const totalLive = subtotalLive - descuentoBs;
      const totalsEl = body.querySelector('.sale-totals-values');
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
    editBtn.hidden=!Access.can('sales.edit'); anularBtn.hidden=!Access.can('sales.cancel');
    editBtn.onclick = () => { Access.require('sales.edit'); enterEditMode(); };
    cancelBtn.onclick = () => exitEditMode(true);

    saveBtn.onclick = () => Store.run('edit-sale',saveBtn,async () => {
      const activeRows=[...body.querySelectorAll('tbody tr')].filter(tr=>tr.dataset.removed!=='1');
      const products=await productsFor(activeRows.map(tr=>data.find(i=>String(i.id)===tr.dataset.itemId)?.item||tr.querySelector('.edit-sku')?.value));
      const items=activeRows.map(tr=>{
        const original=data.find(i=>String(i.id)===tr.dataset.itemId);
        const sku=original?.item||tr.querySelector('.edit-sku')?.value.trim();
        const p=resolveProductFromList(products,sku);
        if(!p) throw new Error('Producto no encontrado: '+sku);
        return {product_id:p.id,...(original?{line_id:original.id}:{}),cantidad:Store.number(tr.querySelector('.edit-cant').value,'Cantidad',{integer:true,min:1}),precio:Store.money(Store.number(tr.querySelector('.edit-precio').value,'Precio'))};
      });
      if(!items.length) throw new Error('Use Anular venta para retirar todos los productos.');
      const descuento_pct=Store.money(Store.number(document.getElementById('editDescPct')?.value||0,'Descuento',{max:100}));
      await Store.commit('sale_edit',{sale_id:sale.id,expected_sale:sale,expected_items:data,descuento_pct,items},'edit-'+sale.id);
      modal.hidden=true; Store.notice('Venta actualizada correctamente.');
      refreshAfterWrite();
    });



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
        const mov = { comprobante: { numero: sale.numero, fecha: sale.fecha, entidad: sale.cliente }, items: data.filter(di=>di.cantidad>0).map(di => ({ item: di.item, nombre: di.nombre, cantidad: di.cantidad, precioVenta: di.precio })), total: total, subtotal: sale.subtotal, descuento: sale.descuento };
        setLastComprobante('venta', mov);
        await descargarComprobantePDF('venta', { autoPrint: true });
      } catch (e) { console.error('reimprimir error', e); alert('No se pudo reimprimir.'); }
    };
    pdfBtn.onclick = async () => {
      try {
        const mov = { comprobante: { numero: sale.numero, fecha: sale.fecha, entidad: sale.cliente }, items: data.filter(di=>di.cantidad>0).map(di => ({ item: di.item, nombre: di.nombre, cantidad: di.cantidad, precioVenta: di.precio })), total: total, subtotal: sale.subtotal, descuento: sale.descuento };
        setLastComprobante('venta', mov);
        await descargarComprobantePDF('venta');
      } catch (e) { console.error('pdf error', e); alert('No se pudo generar el PDF.'); }
    };
    anularBtn.onclick = () => {
      return Store.run('cancel-sale',anularBtn,async () => {
        const reason=await Experience.requestReason('Anular venta '+sale.numero,'Se devolverán los productos a CEJA. El comprobante se conservará y la anulación quedará registrada con tu cuenta.');
        if(reason===null)return;
        await Store.commit('sale_cancel',{reason,sale_id:sale.id,expected_sale:sale,expected_items:data},'cancel-'+sale.id);
        modal.hidden=true; Store.notice('Venta anulada. Stock devuelto una sola vez.');
        refreshAfterWrite();
      });
    };


    // backdrop and esc
    modal.onclick = (ev) => { if (ev.target === modal) modal.hidden = true; };
    document.addEventListener('keydown', function escClose(ev){ if (ev.key==='Escape'){ modal.hidden=true; document.removeEventListener('keydown', escClose); } });
  } catch (err) { console.error('ver detalles error', err); Store.notice(err.message, true); }
}

ventasFiltroAplicar?.addEventListener('click', async () => { ventasHistoryPage=1;await refreshVentasHistorial(); });
ventasFiltroLimpiar?.addEventListener('click', async () => {
  ventasHistoryPage=1;
  if (ventasFiltroRango) ventasFiltroRango.value = 'todo';
  if (ventasFiltroDesde) ventasFiltroDesde.value = '';
  if (ventasFiltroHasta) ventasFiltroHasta.value = '';
  if (ventasFiltroCliente) ventasFiltroCliente.value = '';
  await refreshVentasHistorial();
});
ventasVerHistoricoBtn?.addEventListener('click', async () => {
  ventasHistoryPage=1;
  ventasMostrarHistoricoCompleto = !ventasMostrarHistoricoCompleto;
  ventasVerHistoricoBtn.textContent = ventasMostrarHistoricoCompleto ? 'Volver a vista resumida' : 'Ver historico completo';
  await refreshVentasHistorial();
});

async function onDeleteProduct() { alert('Los productos se conservan para proteger el historial. Puede editar su información desde Modo edición.'); }


async function renderAdminMatrix() { return Access.renderAdmin(); }

// Dashboard de solo lectura
async function refreshDashboard() { if(Access.can('dashboard.read')) return Dashboard.refresh(); }

// Movimientos UI
const formMov = document.getElementById('formMov');
const movFecha = document.getElementById('movFecha');
const movAddItemBtn = document.getElementById('movAddItem');
const movItemsTbody = document.getElementById('movItems');
const movLimpiar = document.getElementById('movLimpiar');
const movTablaBody = document.getElementById('movTabla')?.querySelector('tbody');
const movRecentList = document.getElementById('movRecentList');
const movHistItem = document.getElementById('movHistItem');

let movHistPage = 1;
const MOV_HIST_PER_PAGE = 20;
let movHistFilteredData = [];
let movHistMostrarCompleto = false;
let movHistoryRequest = 0;
let movHistoryCursors = [null],movHistoryMore=false,movHistoryFilterKey='';

function renumberMovRows() {
  if (!movItemsTbody) return;
  Array.from(movItemsTbody.querySelectorAll('tr')).forEach((tr, i) => {
    const numCell = tr.querySelector('.mov-row-num');
    if (numCell) numCell.textContent = String(i + 1);
  });
}

function newMovRow() {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="mov-row-num">1</td>
    <td><input type="text" class="mov-item" list="datalistMovItems" placeholder="SKU o nombre" /></td>
    <td class="mov-nombre">-</td>
    <td class="mov-senk-cell">-</td>
    <td><input type="number" class="mov-cant" min="1" value="" placeholder="0" /></td>
    <td><button type="button" class="remove" title="Quitar línea">✕</button></td>
  `;
  const itemInput = tr.querySelector('.mov-item');
  const nombreCell = tr.querySelector('.mov-nombre');
  const senkCell = tr.querySelector('.mov-senk-cell');
  const cantInput = tr.querySelector('.mov-cant');
  const removeBtn = tr.querySelector('.remove');
  let productLookup = 0;

  async function resolveProduct() {
    const lookup = ++productLookup;
    const val = (itemInput.value || '').trim();
    if (!val) { nombreCell.textContent = '-'; senkCell.textContent = '-'; senkCell.className = 'mov-senk-cell'; cantInput.value = ''; cantInput.removeAttribute('max'); tr.dataset.item = ''; return; }
    let p = await findProductByITEM(val);
    if (!p) {
      const all = await Store.catalog();
      const byName = all.filter(x => (x.nombre || '').toLowerCase() === val.toLowerCase());
      if (byName.length === 1) p = byName[0];
    }
    if (lookup !== productLookup || val !== itemInput.value.trim()) return;
    if (p) {
      tr.dataset.item = p.item;
      nombreCell.textContent = p.nombre || '';
      const senk = p.senkata || 0;
      senkCell.textContent = String(senk);
      senkCell.className = 'mov-senk-cell ' + (senk <= 5 ? 'senk-low' : 'senk-ok');
      cantInput.setAttribute('max', String(senk));
    } else {
      tr.dataset.item = '';
      nombreCell.textContent = 'No encontrado';
      senkCell.textContent = '-';
      senkCell.className = 'mov-senk-cell';
      cantInput.value = '';
      cantInput.removeAttribute('max');
    }
  }
  itemInput.addEventListener('change', resolveProduct);
  itemInput.addEventListener('blur', resolveProduct);
  itemInput.addEventListener('input', () => {
    ++productLookup;
    nombreCell.textContent = '-'; senkCell.textContent = '-'; senkCell.className = 'mov-senk-cell'; tr.dataset.item='';
    cantInput.value = ''; cantInput.removeAttribute('max');
  });
  cantInput.addEventListener('input', () => {
    const max = parseInt(cantInput.getAttribute('max') || '0', 10);
    let v = parseInt(cantInput.value || '0', 10);
    if (max && v > max) { cantInput.value = String(max); }
    if (v < 0) { cantInput.value = '0'; }
  });
  removeBtn.addEventListener('click', () => {
    tr.remove();
    renumberMovRows();
    if (movItemsTbody && movItemsTbody.children.length === 0) {
      movItemsTbody.appendChild(newMovRow());
    }
  });
  return tr;
}

async function refreshMovDatalist() {
  if(!Access.can('inventory.read')) return;
  const list = await Store.catalog();
  const dl = document.getElementById('datalistMovItems');
  const options=list.map(p => `<option value="${escapeHtml(p.item)}">${escapeHtml(p.nombre)}</option>`).join('');
  dl.innerHTML=options;
  const saleList=document.getElementById('datalistProductos');if(saleList)saleList.innerHTML=options;
}

function createMovementBatchId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rnd = String(Math.floor(100 + Math.random() * 900));
  return `MOV-${ts}-${rnd}`;
}

function extractMovementBatchId(detalle = '') {
  const m = String(detalle).match(/\[MOV:([A-Z0-9-]+)\]/i);
  return m?.[1] || '';
}

function cleanMovementDetalle(detalle = '') {
  return String(detalle).replace(/\s*\[MOV:[A-Z0-9-]+\]/i, '').trim();
}

function buildGroupedTransfers(data, filterDesde, filterHasta, filterItem = '') {
  const transfers = (data || []).filter(m => m.tipo === 'transfer');
  let filtered = transfers;
  if (filterDesde) filtered = filtered.filter(m => String(m.fecha || '') >= filterDesde);
  if (filterHasta) filtered = filtered.filter(m => String(m.fecha || '') <= filterHasta);
  const itemQ = String(filterItem || '').trim().toLowerCase();
  if (itemQ) filtered = filtered.filter(m => String(m.item || '').toLowerCase().includes(itemQ));

  const groups = new Map();
  for (const m of filtered) {
    const key = String(m.fecha || '');
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        fecha: m.fecha || '',
        tipo: 'transfer',
        cantidadTotal: 0,
        total: 0,
        rows: [],
        maxId: Number(m.id || 0)
      });
    }
    const group = groups.get(key);
    const batchId = extractMovementBatchId(m.detalle);
    group.cantidadTotal += Number(m.cantidad || 0);
    group.total += Number(m.total || 0);
    group.rows.push({
      id: Number(m.id || 0),
      item: m.item || '',
      nombre: m.nombre || '',
      cantidad: Number(m.cantidad || 0),
      batchId,
      detalle: cleanMovementDetalle(m.detalle)
    });
    group.maxId = Math.max(group.maxId, Number(m.id || 0));
  }

  return Array.from(groups.values()).sort((a, b) => {
    const dateCompare = String(b.fecha || '').localeCompare(String(a.fecha || ''));
    if (dateCompare !== 0) return dateCompare;
    return (b.maxId || 0) - (a.maxId || 0);
  });
}

function renderRecentMovimientos(groups) {
  if (!movRecentList) return;
  const recentGroups = (groups || []).slice(0, 5);
  if (!recentGroups.length) {
    movRecentList.innerHTML = `
      <div class="mov-empty-state">
        <div class="mov-empty-icon">📦</div>
        <p><strong>Aun no hay movimientos recientes</strong></p>
        <p>Los ultimos 5 dias con transferencias apareceran aqui</p>
      </div>
    `;
    return;
  }

  movRecentList.innerHTML = recentGroups.map(group => {
    const preview = group.rows.slice(0, 4).map(row => `
      <div class="mov-recent-line">
        <div>
          <strong>${escapeHtml(row.item)}</strong>
          <span> ${escapeHtml(row.nombre || '')}</span>
        </div>
        <span class="mov-line-qty">Cantidad: ${row.cantidad}</span>
      </div>
    `).join('');
    const remaining = group.rows.length - 4;
    return `
      <div class="mov-recent-item">
        <div class="mov-recent-top">
          <div class="mov-recent-date">${escapeHtml(group.fecha)}</div>
          <div class="mov-recent-meta">
            <span class="mov-stat-pill">${group.rows.length} producto${group.rows.length !== 1 ? 's' : ''}</span>
            <span class="mov-stat-pill">${group.cantidadTotal} unidad${group.cantidadTotal !== 1 ? 'es' : ''}</span>
          </div>
        </div>
        <div class="mov-recent-lines">${preview}</div>
        ${remaining > 0 ? `<div class="mov-recent-more">y ${remaining} linea${remaining !== 1 ? 's' : ''} mas...</div>` : ''}
      </div>
    `;
  }).join('');
}

async function refreshRecentMovimientos(){
  if(!Access.can('movements.read'))return;
  try{const page=await Store.transferHistory({days:5});renderRecentMovimientos(buildGroupedTransfers(normalizeTransfers(page.rows)));}
  catch(e){if(movRecentList)movRecentList.textContent='No se pudieron cargar los movimientos recientes.';Store.notice(e.message,true);}
}
function normalizeTransfers(rows){return rows.map(m=>String(m.detalle).startsWith('Reversión movimiento ')?{...m,cantidad:-Math.abs(m.cantidad)}:m);}
async function refreshMovimientosTable(filterDesde, filterHasta, filterItem) {
  if(!Access.can('movements.read')||!movTablaBody) return;
  filterDesde ??= document.getElementById('movHistDesde')?.value;
  filterHasta ??= document.getElementById('movHistHasta')?.value;
  filterItem ??= movHistItem?.value;
  const request = ++movHistoryRequest,table=document.getElementById('movTabla');
  table?.setAttribute('aria-busy','true');
  try{
  if(filterDesde&&filterHasta&&filterDesde>filterHasta)throw Error('La fecha Desde no puede ser posterior a Hasta.');
  const filterKey=JSON.stringify([filterDesde||'',filterHasta||'',filterItem||'',movHistMostrarCompleto]);
  if(filterKey!==movHistoryFilterKey){movHistoryFilterKey=filterKey;movHistPage=1;movHistoryCursors=[null];}
  const [page,reversed]=await Promise.all([
    Store.transferHistory({desde:filterDesde,hasta:filterHasta,item:filterItem,before:movHistoryCursors[movHistPage-1],days:MOV_HIST_PER_PAGE,complete:movHistMostrarCompleto}),
    Store.transferReversals()
  ]);
  if(request!==movHistoryRequest)return;
  const pageItems=buildGroupedTransfers(normalizeTransfers(page.rows));
  movHistFilteredData=pageItems;movHistoryMore=page.more;
  movHistoryCursors[movHistPage]=page.before;
  if(!pageItems.length){movTablaBody.innerHTML='<tr><td colspan="6">No hay movimientos para los filtros seleccionados.</td></tr>';renderMovHistPagination();return;}

  movTablaBody.innerHTML = pageItems.map((group, idx) => {
    const detailRows = [...group.rows]
      .sort((a, b) => String(a.item || '').localeCompare(String(b.item || '')))
      .map(row => `
        <div class="mov-line-item">
          <div class="mov-col-item">${escapeHtml(row.item)}</div>
          <div class="mov-col-name">${escapeHtml(row.nombre)}</div>
          <div class="mov-col-qty">${row.cantidad}</div>
          <button type="button" class="btn-delete-mov-line" data-group-index="${idx}" data-mov-id="${row.id}" title="Revertir conservando el registro original" ${row.cantidad<=0 || reversed.has(String(row.id)) ? 'disabled' : ''} hidden>${reversed.has(String(row.id)) ? 'Revertido' : row.cantidad<=0 ? 'Reversión' : 'Revertir'}</button>
        </div>
      `).join('');
    return `
      <tr class="mov-hist-row">
        <td>${escapeHtml(group.fecha || '')}</td>
        <td><span class="mov-badge mov-badge-transfer">Transfer</span></td>
        <td>
          <div class="mov-day-summary">
            <strong>${group.rows.length} producto${group.rows.length !== 1 ? 's' : ''}</strong>
            <span>${group.rows.map(row => escapeHtml(row.item)).slice(0, 3).join(', ')}${group.rows.length > 3 ? '...' : ''}</span>
          </div>
        </td>
        <td style="text-align:center;font-weight:600;">${group.cantidadTotal}</td>
        <td>
          <details>
            <summary>Ver detalle del dia (${group.rows.length})</summary>
            <div class="mov-group-detail" data-group-index="${idx}">
              <div class="mov-group-toolbar">
                <button type="button" class="secondary btn-mov-edit" data-group-index="${idx}">Revertir productos</button>
                <button type="button" class="btn-mov-done" data-group-index="${idx}" hidden>Listo</button>
              </div>
              <div class="mov-detail-head">
                <span>ITEM</span>
                <span>Nombre</span>
                <span>Cantidad</span>
              </div>
              <div class="mov-lines-list">${detailRows}</div>
            </div>
          </details>
        </td>
        <td>${fmt(group.total || 0)}</td>
      </tr>
    `;
  }).join('');

  function setGroupEditMode(groupIndex, editing) {
    const root = movTablaBody.querySelector(`.mov-group-detail[data-group-index="${groupIndex}"]`);
    if (!root) return;
    root.classList.toggle('editing', editing);
    root.querySelectorAll('.btn-delete-mov-line').forEach(btn => { btn.hidden = !editing; });
    const editBtn = root.querySelector('.btn-mov-edit');
    const doneBtn = root.querySelector('.btn-mov-done');
    if (editBtn) editBtn.hidden = editing;
    if (doneBtn) doneBtn.hidden = !editing;
  }

  movTablaBody.querySelectorAll('.btn-mov-edit').forEach(btn => {
    btn.hidden=!Access.can('movements.reverse');
    btn.addEventListener('click', (ev) => {
      if(!Access.can('movements.reverse'))return;
      const idx = ev.currentTarget.dataset.groupIndex;
      setGroupEditMode(idx, true);
    });
  });

  movTablaBody.querySelectorAll('.btn-mov-done').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      const idx = ev.currentTarget.dataset.groupIndex;
      setGroupEditMode(idx, false);
    });
  });

  movTablaBody.querySelectorAll('.btn-delete-mov-line').forEach(btn => {
    btn.addEventListener('click', async (ev) => {
      const id = Number(ev.currentTarget.dataset.movId || 0);
      if (!id) return;
      await deleteMovimientoLinea(id);
    });
  });

  renderMovHistPagination();
  }catch(e){
    if(request!==movHistoryRequest)return;
    movTablaBody.innerHTML=`<tr><td colspan="6">${escapeHtml(e.message)}</td></tr>`;
    const pagination=document.getElementById('movHistPagination');if(pagination)pagination.innerHTML='';
    Store.notice('No se pudo cargar el historial de movimientos. '+e.message,true);
  }finally{if(request===movHistoryRequest)table?.removeAttribute('aria-busy');}
}

function renderMovHistPagination() {
  const pag = document.getElementById('movHistPagination');
  if (!pag) return;
  if (movHistMostrarCompleto) {
    const totalAll = movHistFilteredData.length;
    pag.innerHTML = totalAll > 0 ? `<span class="mov-page-info">Mostrando historial completo: ${totalAll} dia${totalAll !== 1 ? 's' : ''} con movimientos</span>` : '';
    return;
  }
  pag.innerHTML=`<button type="button" class="mov-page-prev" ${movHistPage<=1?'disabled':''}>← Anterior</button><span class="mov-page-info">Página ${movHistPage} · ${movHistFilteredData.length} días con movimientos</span><button type="button" class="mov-page-next" ${movHistoryMore?'':'disabled'}>Siguiente →</button>`;
  pag.querySelector('.mov-page-prev').addEventListener('click',()=>{movHistPage--;void refreshMovimientosTable();});
  pag.querySelector('.mov-page-next').addEventListener('click',()=>{movHistPage++;void refreshMovimientosTable();});
}

// Tabs for movimientos
function initMovTabs() {
  const tabs = document.querySelectorAll('.mov-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.mov-view').forEach(v => v.hidden = true);
      const target = document.getElementById(tab.dataset.movView);
      if (target) target.hidden = false;
      // Refresh historial when switching to it
      if (tab.dataset.movView === 'movHistView') {
        movHistPage = 1;
        refreshMovimientosTable(document.getElementById('movHistDesde')?.value, document.getElementById('movHistHasta')?.value, movHistItem?.value);
      } else { void Store.refresh([refreshMovDatalist,refreshRecentMovimientos]); }
    });
  });
  // Historial filter buttons
  document.getElementById('movHistFiltrar')?.addEventListener('click', () => {
    movHistPage = 1;
    refreshMovimientosTable(document.getElementById('movHistDesde')?.value, document.getElementById('movHistHasta')?.value, movHistItem?.value);
  });
  document.getElementById('movHistLimpiar')?.addEventListener('click', () => {
    const desde = document.getElementById('movHistDesde');
    const hasta = document.getElementById('movHistHasta');
    if (desde) desde.value = '';
    if (hasta) hasta.value = '';
    if (movHistItem) movHistItem.value = '';
    movHistPage = 1;
    refreshMovimientosTable();
  });

  const movHistVerCompletoBtn = document.getElementById('movHistVerCompleto');
  movHistVerCompletoBtn?.addEventListener('click', () => {
    movHistMostrarCompleto = !movHistMostrarCompleto;
    movHistPage = 1;
    movHistVerCompletoBtn.textContent = movHistMostrarCompleto ? 'Volver a vista paginada' : 'Ver historico completo';
    if (movHistMostrarCompleto) {
      const desde = document.getElementById('movHistDesde');
      const hasta = document.getElementById('movHistHasta');
      if (desde) desde.value = '';
      if (hasta) hasta.value = '';
    }
    refreshMovimientosTable(document.getElementById('movHistDesde')?.value, document.getElementById('movHistHasta')?.value, movHistItem?.value);
  });

  movHistItem?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      movHistPage = 1;
      refreshMovimientosTable(document.getElementById('movHistDesde')?.value, document.getElementById('movHistHasta')?.value, movHistItem?.value);
    }
  });
}

async function deleteMovimientoLinea(movId) {
  return Store.run('reverse-'+movId,null,async()=>{
    const reason=await Experience.requestReason('Revertir movimiento #'+movId,'Se devolverán las unidades a SENKATA y se conservará el movimiento original. La reversión quedará registrada con tu cuenta.');
    if(reason===null)return;
    await Store.commit('transfer_reverse',{reason,movement_id:Number(movId)},'reverse-'+movId);
    Store.notice('Transferencia revertida. El registro original se conserva.');
    refreshAfterWrite();
  });
}
formMov?.addEventListener('submit',e=>{
  e.preventDefault();
  Store.run('transfer',formMov.querySelector('[type=submit]'),async()=>{
    const products=await productsFor([...movItemsTbody.querySelectorAll('tr')].map(tr=>tr.dataset.item||tr.querySelector('.mov-item').value));
    const items=[...movItemsTbody.querySelectorAll('tr')].map(tr=>{
      const item=tr.dataset.item||tr.querySelector('.mov-item').value.trim();
      const p=resolveProductFromList(products,item);
      if(!p) throw new Error('Seleccione un producto válido: '+item);
      return {product_id:p.id,cantidad:Store.number(tr.querySelector('.mov-cant').value,'Cantidad',{integer:true,min:1})};
    });
    if(!movFecha.value||!items.length) throw new Error('Complete fecha y productos.');
    await Store.commit('transfer',{fecha:movFecha.value,items});
    movItemsTbody.replaceChildren(newMovRow()); renumberMovRows(); Store.notice('Transferencia completa guardada.');
    refreshAfterWrite();
  });
});


movLimpiar?.addEventListener('click', () => { formMov.reset(); movFecha.value=Store.date(); if (movItemsTbody){ movItemsTbody.innerHTML=''; movItemsTbody.appendChild(newMovRow()); renumberMovRows(); } });

// Inicialización
(async () => {

  if(Access.can('inventory.read')) initProductsRealtime();
  if(Access.can('inventory.read')) initInventoryAutoRefresh();
  initAdminSettingsUI();

  initMovTabs();
  Access.apply();
  if (movItemsTbody && movItemsTbody.children.length === 0) {
    movItemsTbody.appendChild(newMovRow());
    renumberMovRows();
  }
  movAddItemBtn?.addEventListener('click', () => {
    movItemsTbody.appendChild(newMovRow());
    renumberMovRows();
  });
  updateHomeClock();
  setInterval(updateHomeClock, 1000);
  void refreshHomeWeather();
  setInterval(refreshHomeWeather, 10 * 60 * 1000);
  void refreshFxWidget();
  setInterval(refreshFxWidget, 30000);
})().catch(e=>Store.notice(e.message,true));

for(const id of ['ingFecha','venFecha','movFecha']){const el=document.getElementById(id);if(el&&!el.value)el.value=Store.date();}
window.addEventListener('unhandledrejection',e=>{console.error(e.reason);Store.notice(e.reason?.message||'No se pudo cargar la información. Intente nuevamente.',true);});

// Advertir sobre cambios que todavía no se guardaron.
window.addEventListener('beforeunload',e=>{if(Access.can(null) && (Store.busy.size || Store.hasPending() || countInventoryChanges()>0)){e.preventDefault();e.returnValue='';}});
