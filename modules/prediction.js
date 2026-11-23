/**
 * Predicción del dólar en Bolivia: paralelo (USDT/BOB) y oficial (BCB). Corre 100% en el navegador.
 * Fuentes: api.dolarbluebolivia.click (histórico horario de 6 meses + oficial BCB),
 * bo.dolarapi.com (respaldo) y las cotizaciones P2P en vivo que registra el widget de app.js.
 */
(function () {
  const API = 'https://api.dolarbluebolivia.click';
  const FALLBACK_API = 'https://bo.dolarapi.com/v1/dolares';
  const STORE = { market: 'fxp_market_v2', official: 'fxp_official_v2', samples: 'fxp_samples_v2' };
  const LEGACY_KEYS = ['fxp_history_v1', 'fxp_official_v1'];
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const HISTORY_TTL = HOUR;
  const OFFICIAL_TTL = 30 * MIN;
  const LIVE_STALE = 15 * MIN;
  const SAMPLE_GAP = 20 * MIN;
  const SAMPLE_RETENTION = 30 * DAY;
  const MAX_DAYS = 180;
  const HORIZON = 7;
  const BACKTEST_ORIGINS = 60;
  const MIN_TRAIN = 21;
  const MIN_BAND_SAMPLES = 10;
  const CHART_DAYS = 60;
  // El BCB fija un valor nuevo de martes a sábado; domingo y lunes repiten el del sábado.
  const OFFICIAL_CHANGE_DOW = new Set([2, 3, 4, 5, 6]);

  // ===== Utilidades =====
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const round4 = (n) => Math.round(n * 10000) / 10000;
  const isValidRate = (n) => Number.isFinite(n) && n > 1 && n < 100;

  function stdev(a) {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
  }

  function quantile(values, q) {
    const s = [...values].sort((a, b) => a - b);
    if (!s.length) return 0;
    const pos = (s.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }

  function normCdf(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp((-x * x) / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  }

  function ols(xs, ys) {
    let sxy = 0;
    let sxx = 0;
    xs.forEach((x, i) => { sxy += x * ys[i]; sxx += x * x; });
    return sxx > 0 ? sxy / sxx : 0;
  }

  function dampSum(phi, h) {
    let s = 0;
    for (let i = 1; i <= h; i++) s += phi ** i;
    return s;
  }

  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function keyToDate(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function addDays(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
  }

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  async function fetchJson(url, timeoutMs = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function changeSteps(startDow, h) {
    let steps = 0;
    for (let s = 1; s <= h; s++) if (OFFICIAL_CHANGE_DOW.has((startDow + s) % 7)) steps++;
    return steps;
  }

  // ===== Modelos: fit(ctx, t, opts) devuelve h => valor estimado para el día t + h =====
  function fitHolt(series, t) {
    const from = Math.max(0, t - 89);
    let best = null;
    for (const alpha of [0.2, 0.4, 0.6, 0.8, 0.95]) {
      for (const beta of [0.05, 0.1, 0.2]) {
        let level = series[from];
        let trend = 0;
        let sse = 0;
        for (let i = from + 1; i <= t; i++) {
          const pred = level + 0.85 * trend;
          sse += (series[i] - pred) ** 2;
          const next = alpha * series[i] + (1 - alpha) * pred;
          trend = beta * (next - level) + (1 - beta) * 0.85 * trend;
          level = next;
        }
        if (!best || sse < best.sse) best = { sse, level, trend };
      }
    }
    return (h) => best.level + best.trend * dampSum(0.85, h);
  }

  function fitSes(series, t) {
    const from = Math.max(0, t - 89);
    let best = null;
    for (const alpha of [0.3, 0.5, 0.8]) {
      let level = series[from];
      let sse = 0;
      for (let i = from + 1; i <= t; i++) {
        sse += (series[i] - level) ** 2;
        level = alpha * series[i] + (1 - alpha) * level;
      }
      if (!best || sse < best.sse) best = { sse, level };
    }
    return () => best.level;
  }

  function fitDrift(series, t, window) {
    const ys = series.slice(Math.max(0, t - window + 1), t + 1);
    const mx = (ys.length - 1) / 2;
    const my = mean(ys);
    const slope = ols(ys.map((_, i) => i - mx), ys.map(y => y - my));
    return (h) => series[t] + slope * dampSum(0.8, h);
  }

  function fitAr1(series, t) {
    const xs = [];
    const ys = [];
    for (let i = Math.max(2, t - 60); i <= t; i++) {
      xs.push(series[i - 1] - series[i - 2]);
      ys.push(series[i] - series[i - 1]);
    }
    const b = clamp(ols(xs, ys), -0.9, 0.9);
    const d0 = t >= 1 ? series[t] - series[t - 1] : 0;
    return (h) => {
      let v = series[t];
      let d = d0;
      for (let s = 1; s <= h; s++) { d *= b; v += d; }
      return v;
    };
  }

  // El oficial se acerca al paralelo en cada día de cambio: o' = o + k (paralelo - o).
  function fitFollow(ctx, t, window, opts = {}) {
    let k = 0;
    if (window > 0) {
      const xs = [];
      const ys = [];
      for (let i = Math.max(1, t - window); i <= t; i++) {
        if (!OFFICIAL_CHANGE_DOW.has(ctx.dow[i])) continue;
        xs.push(ctx.blue[i - 1] - ctx.off[i - 1]);
        ys.push(ctx.off[i] - ctx.off[i - 1]);
      }
      k = clamp(ols(xs, ys), 0, 1);
    }
    const bluePath = opts.bluePath || (() => ctx.blue[t]);
    const known = opts.known;
    return (h) => {
      let o = ctx.off[t];
      for (let s = 1; s <= h; s++) {
        if (known && s === known.day) { o = known.value; continue; }
        if (OFFICIAL_CHANGE_DOW.has((ctx.dow[t] + s) % 7)) o += k * (bluePath(s - 1) - o);
      }
      return o;
    };
  }

  const BLUE_MODELS = {
    naive: { label: 'Sin cambio (paseo aleatorio)', fit: (ctx, t) => () => ctx.blue[t] },
    holt: { label: 'Holt con tendencia amortiguada', fit: (ctx, t) => fitHolt(ctx.blue, t) },
    ses: { label: 'Suavizado exponencial', fit: (ctx, t) => fitSes(ctx.blue, t) },
    drift: { label: 'Tendencia de 14 días', fit: (ctx, t) => fitDrift(ctx.blue, t, 14) },
    ar1: { label: 'Inercia de cambios diarios', fit: (ctx, t) => fitAr1(ctx.blue, t) }
  };

  const OFFICIAL_MODELS = {
    naive: { label: 'Sin cambio', fit: (ctx, t, opts) => fitFollow(ctx, t, 0, opts) },
    follow30: { label: 'Converge al paralelo (ajuste 30 días)', fit: (ctx, t, opts) => fitFollow(ctx, t, 30, opts) },
    follow60: { label: 'Converge al paralelo (ajuste 60 días)', fit: (ctx, t, opts) => fitFollow(ctx, t, 60, opts) }
  };

  // Validación "walk-forward": cada modelo predice el pasado usando solo los datos previos a cada día.
  function backtest(models, ctx, key, bucketOf) {
    const series = ctx[key];
    const n = series.length;
    const first = Math.max(MIN_TRAIN, n - 1 - BACKTEST_ORIGINS);
    if (n - 1 - first < 10) return null;
    const out = {};
    for (const [name, model] of Object.entries(models)) {
      const byH = Array.from({ length: HORIZON }, () => []);
      const byBucket = Array.from({ length: HORIZON + 1 }, () => []);
      let hits = 0;
      let total = 0;
      for (let t = first; t < n - 1; t++) {
        const f = model.fit(ctx, t, {});
        for (let h = 1; h <= HORIZON && t + h < n; h++) {
          const pred = f(h);
          const err = series[t + h] - pred;
          byH[h - 1].push(err);
          byBucket[bucketOf(t, h)].push(err);
          if (h === 1) {
            const real = series[t + 1] - series[t];
            const expected = pred - series[t];
            if (Math.abs(real) > 1e-6 && Math.abs(expected) > 1e-6) {
              total++;
              if (Math.sign(real) === Math.sign(expected)) hits++;
            }
          }
        }
      }
      out[name] = {
        name,
        label: model.label,
        byH,
        byBucket,
        mae: byH.map(e => mean(e.map(Math.abs))),
        direction: total >= 5 ? (hits / total) * 100 : null
      };
    }
    const naiveMae = out.naive.mae;
    let chosen = out.naive;
    for (const r of Object.values(out)) {
      const ratios = r.mae.map((v, i) => v / naiveMae[i]).filter(Number.isFinite);
      r.score = ratios.length ? mean(ratios) : 1;
      if (r.score < chosen.score - 0.02) chosen = r;
    }
    return { chosen: chosen.name, models: out, origins: n - 1 - first };
  }

  class DollarPredictionModule extends EventTarget {
    constructor() {
      super();
      // Las cachés anteriores se conservan; abrir la aplicación no borra datos locales.
      this.market = readJson(STORE.market, null);
      this.official = readJson(STORE.official, null);
      const samples = readJson(STORE.samples, []);
      this.samples = Array.isArray(samples) ? samples.filter(s => Array.isArray(s) && s.length === 3) : [];
      this.status = { history: this.market ? 'cache' : 'pending', official: this.official ? 'cache' : 'pending' };
      this.selection = null;
      this.selectionKey = null;
      this.latest = null;
      const last = this.samples[this.samples.length - 1];
      if (last) this.latest = { ts: last[0], buy: last[1], sell: last[2], mid: (last[1] + last[2]) / 2, source: 'Último dato guardado', live: false };
      this.result = this.compute();
    }

    /** Registra una cotización P2P real. buy = precio para comprar USDT, sell = precio de venta. */
    recordSample(buy, sell, source) {
      const hi = Math.max(Number(buy), Number(sell));
      const lo = Math.min(Number(buy), Number(sell));
      if (!isValidRate(hi) || !isValidRate(lo)) return;
      const now = Date.now();
      this.latest = { ts: now, buy: hi, sell: lo, mid: (hi + lo) / 2, source, live: true };
      const last = this.samples[this.samples.length - 1];
      if (!last || now - last[0] >= SAMPLE_GAP) {
        this.samples.push([now, round4(hi), round4(lo)]);
        const cutoff = now - SAMPLE_RETENTION;
        while (this.samples.length && this.samples[0][0] < cutoff) this.samples.shift();
        writeJson(STORE.samples, this.samples);
      }
      this.recompute();
    }

    async refreshAll(force = false) {
      await Promise.all([this.refreshHistory(force), this.refreshOfficial(force)]);
      if (!this.latest?.live || Date.now() - this.latest.ts > LIVE_STALE) await this.refreshParallelFallback();
      this.recompute();
    }

    async refreshHistory(force) {
      if (!force && this.market && Date.now() - this.market.fetchedAt < HISTORY_TTL) {
        this.status.history = 'ok';
        return;
      }
      try {
        const json = await fetchJson(`${API}/v1/chart/6m`, 20000);
        const pts = (json?.data || []).filter(p => Number.isFinite(p?.t) && isValidRate(p.bb) && isValidRate(p.bs));
        if (pts.length < 48) throw new Error('histórico insuficiente');
        const byDay = new Map();
        for (const p of pts) {
          const key = dayKey(p.t * 1000);
          byDay.set(key, [key, round4((p.bb + p.bs) / 2), isValidRate(p.os) ? p.os : null]);
        }
        const cutoff = Date.now() - 7 * DAY;
        this.market = {
          fetchedAt: Date.now(),
          days: [...byDay.values()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
          hourly: pts.filter(p => p.t * 1000 >= cutoff).map(p => [p.t * 1000, round4((p.bb + p.bs) / 2)])
        };
        writeJson(STORE.market, this.market);
        this.status.history = 'ok';
      } catch (e) {
        console.warn('Histórico del dólar no disponible:', e.message);
        this.status.history = this.market ? 'cache' : 'error';
      }
    }

    async refreshOfficial(force) {
      if (!force && this.official && Date.now() - this.official.fetchedAt < OFFICIAL_TTL) {
        this.status.official = 'ok';
        return;
      }
      try {
        const json = await fetchJson(`${API}/v1/official-unificado`);
        const d = json?.data;
        const rate = Number(d?.venta ?? d?.valor);
        if (!isValidRate(rate)) throw new Error('oficial inválido');
        const nextRate = Number(d?.siguiente?.venta ?? d?.siguiente?.valor);
        this.official = {
          rate,
          date: d.effective_date || dayKey(Date.now()),
          label: d.date_label || d.fecha || '',
          next: isValidRate(nextRate) ? { rate: nextRate, label: d.siguiente?.fecha || d.siguiente?.date_label || '' } : null,
          source: 'Banco Central de Bolivia',
          fetchedAt: Date.now()
        };
        writeJson(STORE.official, this.official);
        this.status.official = 'ok';
        return;
      } catch (e) {
        console.warn('Oficial (dolarbluebolivia) no disponible:', e.message);
      }
      try {
        const json = await fetchJson(`${FALLBACK_API}/oficial`);
        const rate = Number(json?.venta);
        if (!isValidRate(rate)) throw new Error('oficial inválido');
        this.official = {
          rate,
          date: String(json.fechaActualizacion || '').slice(0, 10) || dayKey(Date.now()),
          label: '',
          next: null,
          source: 'Banco Central de Bolivia (vía DolarApi)',
          fetchedAt: Date.now()
        };
        writeJson(STORE.official, this.official);
        this.status.official = 'ok';
      } catch (e) {
        console.warn('Oficial (dolarapi) no disponible:', e.message);
        this.status.official = this.official ? 'cache' : 'error';
      }
    }

    async refreshParallelFallback() {
      try {
        const json = await fetchJson(`${API}/v1/officialRate`);
        const blue = json?.data?.blue;
        if (isValidRate(Number(blue?.buy)) && isValidRate(Number(blue?.sell))) {
          this.recordSample(blue.buy, blue.sell, 'Paralelo P2P (Dólar Blue Bolivia)');
          return;
        }
      } catch {}
      try {
        const json = await fetchJson(`${FALLBACK_API}/binance`);
        if (isValidRate(Number(json?.compra)) && isValidRate(Number(json?.venta))) {
          this.recordSample(json.compra, json.venta, 'Paralelo P2P (DolarApi / Binance)');
        }
      } catch {}
    }

    recompute() {
      this.result = this.compute();
      this.dispatchEvent(new Event('change'));
    }

    buildContext() {
      const map = new Map();
      for (const [key, blue, off] of this.market?.days || []) map.set(key, { blue, off, real: true });
      for (const [ts, buy, sell] of this.samples) {
        const key = dayKey(ts);
        const e = map.get(key);
        if (!e) map.set(key, { blue: (buy + sell) / 2, off: null, real: true, local: true });
        else if (e.local) e.blue = (buy + sell) / 2;
      }
      const todayKey = dayKey(Date.now());
      if (this.latest?.live) {
        const e = map.get(todayKey) || { off: null, real: true };
        e.blue = this.latest.mid;
        map.set(todayKey, e);
      }
      if (this.official && this.official.date <= todayKey) {
        const e = map.get(todayKey);
        if (e) e.off = this.official.rate;
      }

      const keys = [...map.keys()].sort().slice(-MAX_DAYS);
      if (!keys.length) return null;
      const dates = [];
      const blue = [];
      const off = [];
      const real = [];
      for (let i = 0; i < keys.length; i++) {
        const cur = map.get(keys[i]);
        const date = keyToDate(keys[i]);
        dates.push(date);
        blue.push(cur.blue);
        off.push(cur.off);
        real.push(true);
        const nextKey = keys[i + 1];
        if (!nextKey) break;
        const next = map.get(nextKey);
        const gap = Math.round((keyToDate(nextKey) - date) / DAY);
        for (let g = 1; g < gap; g++) {
          dates.push(addDays(date, g));
          blue.push(cur.blue + (next.blue - cur.blue) * (g / gap));
          off.push(cur.off);
          real.push(false);
        }
      }
      let lastOff = off.find(isValidRate) ?? null;
      for (let i = 0; i < off.length; i++) {
        if (isValidRate(off[i])) lastOff = off[i];
        else off[i] = lastOff;
      }
      return { dates, blue, off, real, dow: dates.map(d => d.getDay()), hasOfficial: isValidRate(lastOff) };
    }

    compute() {
      const ctx = this.buildContext();
      if (!ctx || !isValidRate(ctx.blue[ctx.blue.length - 1])) return { status: 'empty' };
      const n = ctx.blue.length;
      const t = n - 1;
      const today = keyToDate(dayKey(Date.now()));

      const selKey = `${this.market?.fetchedAt || 0}|${n}|${dayKey(ctx.dates[0])}|${ctx.hasOfficial}`;
      if (selKey !== this.selectionKey) {
        this.selection = {
          blue: backtest(BLUE_MODELS, ctx, 'blue', (_, h) => h),
          official: ctx.hasOfficial ? backtest(OFFICIAL_MODELS, ctx, 'off', (o, h) => changeSteps(ctx.dow[o], h)) : null
        };
        this.selectionKey = selKey;
      }
      const sel = this.selection;

      const currentBlue = ctx.blue[t];
      const currentOff = ctx.hasOfficial ? ctx.off[t] : null;
      const blueModelName = sel.blue?.chosen || 'naive';
      const blueFit = BLUE_MODELS[blueModelName].fit(ctx, t, {});
      const blueErrors = sel.blue?.models[blueModelName].byH;
      const fallbackSigma = this.fallbackSigma(ctx);

      let known = null;
      if (ctx.hasOfficial && this.official?.next) {
        for (let s = 1; s <= HORIZON; s++) {
          if (OFFICIAL_CHANGE_DOW.has((ctx.dow[t] + s) % 7)) { known = { day: s, value: this.official.next.rate }; break; }
        }
      }
      const offModelName = sel.official?.chosen || 'naive';
      const offFit = ctx.hasOfficial
        ? OFFICIAL_MODELS[offModelName].fit(ctx, t, { bluePath: h => (h === 0 ? currentBlue : blueFit(h)), known })
        : null;
      const offBuckets = sel.official?.models[offModelName].byBucket;

      const forecast = [];
      for (let h = 1; forecast.length < HORIZON && h <= HORIZON + 30; h++) {
        const date = addDays(ctx.dates[t], h);
        if (date <= today) continue;

        const bluePoint = blueFit(h);
        const errs = blueErrors?.[h - 1] || [];
        let blueLow;
        let blueHigh;
        let blueUp;
        if (errs.length >= MIN_BAND_SAMPLES && h <= HORIZON) {
          blueLow = bluePoint + quantile(errs, 0.05);
          blueHigh = bluePoint + quantile(errs, 0.95);
          blueUp = (errs.reduce((s, e) => s + (bluePoint + e > currentBlue ? 1 : bluePoint + e === currentBlue ? 0.5 : 0), 0) / errs.length) * 100;
        } else {
          const sd = fallbackSigma * Math.sqrt(h);
          blueLow = bluePoint - 1.645 * sd;
          blueHigh = bluePoint + 1.645 * sd;
          blueUp = normCdf((bluePoint - currentBlue) / sd) * 100;
        }

        let off = null;
        if (offFit) {
          const point = offFit(h);
          let steps = changeSteps(ctx.dow[t], h);
          if (known && h >= known.day) steps -= 1;
          let low = point;
          let high = point;
          if (steps > 0) {
            const bucket = offBuckets?.[Math.min(steps, HORIZON)] || [];
            if (bucket.length >= MIN_BAND_SAMPLES) {
              low = point + quantile(bucket, 0.05);
              high = point + quantile(bucket, 0.95);
            } else {
              const sd = fallbackSigma * Math.sqrt(steps);
              low = point - 1.645 * sd;
              high = point + 1.645 * sd;
            }
          }
          off = { point, low, high, fixed: steps === 0, known: !!known && h === known.day };
        }

        forecast.push({
          day: forecast.length + 1,
          date,
          blue: { point: bluePoint, low: blueLow, high: blueHigh, upProb: blueUp, changePct: ((bluePoint - currentBlue) / currentBlue) * 100 },
          off
        });
      }

      const valueDaysAgo = (arr, d) => (t - d >= 0 ? arr[t - d] : null);
      const pct = (cur, ref) => (isValidRate(ref) ? ((cur - ref) / ref) * 100 : null);
      const win30 = Math.max(0, t - 30);
      const dailyReturns = [];
      for (let i = win30 + 1; i <= t; i++) dailyReturns.push((ctx.blue[i] - ctx.blue[i - 1]) / ctx.blue[i - 1]);
      const hourly = this.market?.hourly || [];
      const dayAgo = Date.now() - DAY;
      const ref24 = [...hourly].reverse().find(p => p[0] <= dayAgo);
      let prevOff = null;
      if (ctx.hasOfficial) {
        for (let i = t - 1; i >= 0; i--) if (ctx.off[i] !== currentOff) { prevOff = ctx.off[i]; break; }
      }

      const chartFrom = Math.max(0, n - CHART_DAYS);
      const summarize = (bt) => bt && {
        chosen: bt.chosen,
        label: bt.models[bt.chosen].label,
        origins: bt.origins,
        mae1: bt.models[bt.chosen].mae[0],
        mae7: bt.models[bt.chosen].mae[HORIZON - 1],
        naiveMae7: bt.models.naive.mae[HORIZON - 1],
        direction: bt.models[bt.chosen].direction,
        table: Object.values(bt.models).map(m => ({ name: m.name, label: m.label, mae1: m.mae[0], mae3: m.mae[2], mae7: m.mae[HORIZON - 1] }))
      };

      return {
        status: 'ok',
        today,
        currentBlue,
        currentOff,
        gapPct: ctx.hasOfficial ? ((currentBlue - currentOff) / currentOff) * 100 : null,
        forecast,
        accuracy: { blue: summarize(sel.blue), official: summarize(sel.official) },
        stats: {
          blue24h: ref24 ? pct(currentBlue, ref24[1]) : null,
          blue7d: pct(currentBlue, valueDaysAgo(ctx.blue, 7)),
          blue30d: pct(currentBlue, valueDaysAgo(ctx.blue, 30)),
          blueHigh30: Math.max(...ctx.blue.slice(win30)),
          blueLow30: Math.min(...ctx.blue.slice(win30)),
          blueVol: dailyReturns.length >= 5 ? stdev(dailyReturns) * 100 : null,
          offPrev: prevOff,
          offChange: ctx.hasOfficial && isValidRate(prevOff) ? currentOff - prevOff : null,
          off30d: ctx.hasOfficial ? pct(currentOff, valueDaysAgo(ctx.off, 30)) : null,
          days: n
        },
        chart: {
          dates: ctx.dates.slice(chartFrom),
          blue: ctx.blue.slice(chartFrom).map((v, i) => (ctx.real[chartFrom + i] ? v : null)),
          off: ctx.hasOfficial ? ctx.off.slice(chartFrom) : null
        }
      };
    }

    fallbackSigma(ctx) {
      const r = [];
      for (let i = Math.max(1, ctx.blue.length - 30); i < ctx.blue.length; i++) {
        if (ctx.real[i] && ctx.real[i - 1]) r.push(ctx.blue[i] - ctx.blue[i - 1]);
      }
      const last = ctx.blue[ctx.blue.length - 1];
      return Math.max(r.length >= 3 ? stdev(r) : 0, last * 0.006);
    }
  }

  window.DollarPredictionModule = DollarPredictionModule;
})();
