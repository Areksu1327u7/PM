/**
 * Interfaz de la sección "Predecir Dólar".
 */
(function () {
  const fmt = (n, d = 2) => (Number.isFinite(n) ? n.toFixed(d) : '--');
  const fmtSigned = (n, d = 2) => (Number.isFinite(n) ? `${n > 0 ? '+' : ''}${n.toFixed(d)}` : '--');
  const fmtPct = (n, d = 2) => (Number.isFinite(n) ? `${fmtSigned(n, d)}%` : '--');
  const dirClass = (n, eps = 0.005) => (!Number.isFinite(n) || Math.abs(n) < eps ? 'flat' : n > 0 ? 'up' : 'down');
  const arrow = (n, eps) => ({ up: '▲', down: '▼', flat: '●' })[dirClass(n, eps)];
  const shortDate = (d) => d.toLocaleDateString('es-BO', { day: '2-digit', month: '2-digit' });
  const longDate = (d) => d.toLocaleDateString('es-BO', { weekday: 'short', day: '2-digit', month: '2-digit' });
  const time = (ts) => new Date(ts).toLocaleTimeString('es-BO', { hour: '2-digit', minute: '2-digit' });
  const sentenceCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '');

  class DollarPredictionUI {
    constructor(module) {
      this.module = module;
      this.chart = null;
      this.anchor = 0;
      this.section = document.getElementById('predictionSection');
      module.addEventListener('change', () => this.render());
      this.$('fxpCalcUsd')?.addEventListener('input', () => this.renderCalculator());
    }

    $(id) {
      return document.getElementById(id);
    }

    setText(id, text, className) {
      const el = this.$(id);
      if (!el) return;
      el.textContent = text;
      if (className !== undefined) el.className = className;
    }

    isVisible() {
      return !!this.section && !this.section.hidden;
    }

    onShow() {
      this.render();
    }

    nextOfficial(r) {
      return r.forecast?.find(f => f.off && !f.off.fixed) || null;
    }

    render() {
      const r = this.module.result;
      this.renderKpis(r);
      this.renderSignal(r);
      this.renderTable(r);
      this.renderAccuracy(r);
      this.renderStats(r);
      this.renderModels(r);
      this.renderCalculator();
      this.renderStatus();
      if (this.isVisible()) this.renderChart(r);
    }

    renderKpis(r) {
      const latest = this.module.latest;
      const official = this.module.official;
      const s = r.stats || {};

      this.setText('fxpBlue', fmt(r.currentBlue));
      this.setText('fxpBlueChange', Number.isFinite(s.blue24h) ? `${arrow(s.blue24h, 0.05)} ${fmtPct(s.blue24h)} en 24 h` : '--', `fxp-delta ${dirClass(s.blue24h, 0.05)}`);
      this.setText('fxpBlueBuySell', latest ? `Compra ${fmt(latest.buy)} · Venta ${fmt(latest.sell)}` : '--');

      this.setText('fxpOff', fmt(r.currentOff));
      this.setText('fxpOffChange', Number.isFinite(s.offChange) ? `${arrow(s.offChange)} ${fmtSigned(s.offChange)} vs anterior (${fmt(s.offPrev)})` : '--', `fxp-delta ${dirClass(s.offChange)}`);
      this.setText('fxpOffLabel', official?.label ? sentenceCase(official.label) : (official ? `Vigente desde ${new Date(`${official.date}T12:00:00`).toLocaleDateString('es-BO')}` : 'Sin datos del BCB'));

      this.setText('fxpGap', fmtPct(r.gapPct, 1));
      this.setText('fxpGapBs', Number.isFinite(r.gapPct) ? `${fmtSigned(r.currentBlue - r.currentOff)} Bs por dólar` : '--');

      const next = this.nextOfficial(r);
      this.setText('fxpOffNext', fmt(next?.off.point));
      this.setText('fxpOffNextNote', next
        ? (next.off.known ? `Publicado por el BCB para ${longDate(next.date)}` : `Estimado para ${longDate(next.date)} · rango ${fmt(next.off.low)} – ${fmt(next.off.high)}`)
        : '--');
    }

    renderSignal(r) {
      const box = this.$('fxpSignal');
      if (!box) return;
      if (r.status !== 'ok' || !r.forecast.length) {
        box.className = 'card fxp-signal learning';
        this.setText('fxpSignalTitle', 'Cargando datos del mercado...');
        this.setText('fxpSignalText', 'Descargando el histórico y las cotizaciones actuales. Si no hay internet se usarán los últimos datos guardados.');
        this.setText('fxpSignalOfficial', '');
        return;
      }
      const f7 = r.forecast[r.forecast.length - 1].blue;
      const p = f7.upProb;
      let kind = 'stable';
      let title = 'El paralelo no muestra una dirección clara';
      let advice = 'El riesgo de esperar es parejo en ambas direcciones: compra según tu necesidad.';
      if (p >= 60) {
        kind = 'up';
        title = 'Es más probable que el paralelo suba';
        advice = 'Si necesitas comprar dólares para importar, adelantar la compra puede convenir.';
      } else if (p <= 40) {
        kind = 'down';
        title = 'Es más probable que el paralelo baje';
        advice = 'Si tu compra puede esperar, podrías conseguir un mejor precio.';
      }
      box.className = `card fxp-signal ${r.accuracy.blue ? kind : 'learning'}`;
      this.setText('fxpSignalTitle', r.accuracy.blue ? title : 'Proyección preliminar: no se pudo descargar el histórico');
      this.setText('fxpSignalText', `En 7 días se estima ${fmt(f7.point)} Bs (rango probable ${fmt(f7.low)} – ${fmt(f7.high)}). Probabilidad de que esté más alto que hoy: ${p.toFixed(0)}%. ${advice}`);

      const next = this.nextOfficial(r);
      const offModel = r.accuracy.official?.chosen;
      let offText = '';
      if (next) {
        const diff = next.off.point - r.currentOff;
        if (next.off.known) {
          offText = `Oficial: el BCB ya publicó ${fmt(next.off.point)} Bs para ${longDate(next.date)} (${fmtSigned(diff)}).`;
        } else if (offModel && offModel !== 'naive' && Math.abs(diff) >= 0.01) {
          offText = `Oficial: tiende a acercarse al paralelo. Para ${longDate(next.date)} se estima ${fmt(next.off.point)} Bs (${fmtSigned(diff)}), en un rango de ${fmt(next.off.low)} – ${fmt(next.off.high)}.`;
        } else {
          offText = `Oficial: sin un cambio esperado relevante; para ${longDate(next.date)} se estima ${fmt(next.off.point)} Bs.`;
        }
      }
      this.setText('fxpSignalOfficial', offText);
    }

    renderTable(r) {
      const tbody = this.$('fxpTableBody');
      if (!tbody) return;
      if (r.status !== 'ok' || !r.forecast.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="note">Sin datos todavía.</td></tr>';
        return;
      }
      tbody.innerHTML = r.forecast.map(f => {
        const b = f.blue;
        const o = f.off;
        let offRange = '--';
        if (o) offRange = o.known ? '<span class="fxp-tag">Publicado BCB</span>' : o.fixed ? '<span class="fxp-tag">Sin cambio (dom/lun)</span>' : `${fmt(o.low)} – ${fmt(o.high)}`;
        return `
          <tr>
            <td>${longDate(f.date)}</td>
            <td class="fxp-num"><strong>${fmt(b.point)}</strong></td>
            <td class="fxp-num fxp-muted">${fmt(b.low)} – ${fmt(b.high)}</td>
            <td class="fxp-num"><span class="fxp-delta ${b.upProb >= 60 ? 'up' : b.upProb <= 40 ? 'down' : 'flat'}">${b.upProb.toFixed(0)}%</span></td>
            <td class="fxp-num"><strong>${fmt(o?.point)}</strong></td>
            <td class="fxp-num fxp-muted">${offRange}</td>
          </tr>`;
      }).join('');
    }

    renderAccuracy(r) {
      const el = this.$('fxpAccuracy');
      if (!el) return;
      const rows = [];
      const add = (name, a) => {
        if (!a) {
          rows.push([name, 'Faltan datos para validar']);
          return;
        }
        const gain = a.naiveMae7 > 0 ? (1 - a.mae7 / a.naiveMae7) * 100 : 0;
        rows.push([`${name}: método`, a.label]);
        rows.push([`${name}: error típico 1 día`, `±${fmt(a.mae1, 3)} Bs`]);
        rows.push([`${name}: error típico 7 días`, `±${fmt(a.mae7, 3)} Bs`]);
        rows.push([`${name}: vs. "no cambia"`, gain >= 1 ? `${gain.toFixed(0)}% más preciso` : 'Igual (es el mejor estimado)']);
        if (Number.isFinite(a.direction)) rows.push([`${name}: acierta la dirección`, `${a.direction.toFixed(0)}% de las veces`]);
      };
      add('Paralelo', r.accuracy?.blue);
      add('Oficial', r.accuracy?.official);
      const days = r.accuracy?.blue?.origins;
      if (days) rows.push(['Validado con', `${days} días reales`]);
      el.innerHTML = rows.map(([k, v]) => `<div class="fxp-stat"><span>${k}</span><strong>${v}</strong></div>`).join('');
    }

    renderStats(r) {
      const el = this.$('fxpStats');
      if (!el) return;
      const s = r.stats || {};
      const delta = (v) => `<span class="fxp-delta ${dirClass(v, 0.05)}">${fmtPct(v)}</span>`;
      const rows = [
        ['Paralelo 7 días', delta(s.blue7d)],
        ['Paralelo 30 días', delta(s.blue30d)],
        ['Paralelo máx. / mín. 30 días', `${fmt(s.blueHigh30)} / ${fmt(s.blueLow30)}`],
        ['Volatilidad diaria del paralelo', Number.isFinite(s.blueVol) ? `${s.blueVol.toFixed(2)}%` : '--'],
        ['Oficial 30 días', delta(s.off30d)]
      ];
      el.innerHTML = rows.map(([k, v]) => `<div class="fxp-stat"><span>${k}</span><strong>${v}</strong></div>`).join('');
    }

    renderModels(r) {
      const tbody = this.$('fxpModels');
      if (!tbody) return;
      const rows = [];
      for (const [serie, a] of [['Paralelo', r.accuracy?.blue], ['Oficial', r.accuracy?.official]]) {
        if (!a) continue;
        for (const m of a.table) {
          const used = m.name === a.chosen;
          rows.push(`<tr class="${used ? 'fxp-model-used' : ''}"><td>${serie}</td><td>${m.label}${used ? ' <span class="fxp-tag">en uso</span>' : ''}</td><td class="fxp-num">±${fmt(m.mae1, 3)}</td><td class="fxp-num">±${fmt(m.mae3, 3)}</td><td class="fxp-num">±${fmt(m.mae7, 3)}</td></tr>`);
        }
      }
      tbody.innerHTML = rows.join('') || '<tr><td colspan="5" class="note">Sin datos suficientes.</td></tr>';
    }

    renderCalculator() {
      const r = this.module.result;
      const latest = this.module.latest;
      const usd = Number(this.$('fxpCalcUsd')?.value);
      const f7 = r.forecast?.[r.forecast.length - 1]?.blue;
      const ok = usd > 0 && latest;
      // Se asume que la diferencia actual entre precio de compra y promedio se mantiene.
      const premium = latest ? latest.buy - latest.mid : 0;
      this.setText('fxpCalcToday', ok ? `${fmt(usd * latest.buy)} Bs` : '--');
      this.setText('fxpCalcOfficial', usd > 0 && Number.isFinite(r.currentOff) ? `${fmt(usd * r.currentOff)} Bs` : '--');
      this.setText('fxpCalcDay7', ok && f7 ? `${fmt(usd * (f7.point + premium))} Bs` : '--');
      this.setText('fxpCalcRange', ok && f7 ? `${fmt(usd * (f7.low + premium))} – ${fmt(usd * (f7.high + premium))} Bs` : '--');
    }

    renderStatus() {
      const m = this.module;
      const parts = [];
      if (m.latest) parts.push(`Paralelo: ${m.latest.live ? 'en vivo' : 'último dato'} ${time(m.latest.ts)}`);
      if (m.official) parts.push(`Oficial: ${m.status.official === 'ok' ? 'BCB' : 'guardado'} ${time(m.official.fetchedAt)}`);
      if (m.market) parts.push(`Histórico: ${time(m.market.fetchedAt)}`);
      this.setText('fxpUpdated', parts.join(' · ') || 'Cargando...');

      const statusText = {
        ok: 'descargado',
        cache: 'sin conexión, usando la última copia guardada',
        error: 'no disponible',
        pending: 'cargando'
      };
      const r = m.result;
      this.setText('fxpDataStatus', [
        `Histórico: ${statusText[m.status.history]}${r.stats ? ` (${r.stats.days} días)` : ''}.`,
        `Oficial: ${statusText[m.status.official]}${m.official ? ` · fuente ${m.official.source}` : ''}.`,
        `Paralelo en vivo: ${m.latest ? m.latest.source : 'esperando cotización'}.`,
        'Fuentes: api.dolarbluebolivia.click, bo.dolarapi.com, Binance P2P, CriptoYa, Bitget.'
      ].join(' '));
    }

    renderChart(r) {
      const canvas = this.$('fxpChart');
      if (!canvas || typeof Chart === 'undefined') return;
      if (r.status !== 'ok') {
        this.chart?.destroy();
        this.chart = null;
        return;
      }

      const c = r.chart;
      const anchor = c.dates.length - 1;
      this.anchor = anchor;
      const pad = r.forecast.map(() => null);
      const lead = (value) => c.dates.map((_, i) => (i === anchor ? value : null));
      const hasOff = !!c.off && r.forecast.every(f => f.off);

      const labels = [...c.dates.map(shortDate), ...r.forecast.map(f => shortDate(f.date))];
      const data = [
        [...lead(r.currentBlue), ...r.forecast.map(f => f.blue.high)],
        [...lead(r.currentBlue), ...r.forecast.map(f => f.blue.low)],
        hasOff ? [...lead(r.currentOff), ...r.forecast.map(f => f.off.high)] : [],
        hasOff ? [...lead(r.currentOff), ...r.forecast.map(f => f.off.low)] : [],
        [...c.blue, ...pad],
        [...lead(r.currentBlue), ...r.forecast.map(f => f.blue.point)],
        hasOff ? [...c.off, ...pad] : [],
        hasOff ? [...lead(r.currentOff), ...r.forecast.map(f => f.off.point)] : []
      ];

      if (this.chart) {
        this.chart.data.labels = labels;
        data.forEach((d, i) => { this.chart.data.datasets[i].data = d; });
        this.chart.update('none');
        return;
      }

      const blue = '#0f63d6';
      const green = '#16a34a';
      const band = (color) => ({ borderWidth: 0, pointRadius: 0, backgroundColor: color, tension: 0.2 });
      this.chart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels,
          datasets: [
            { label: 'Paralelo máx.', data: data[0], fill: false, ...band('rgba(15, 99, 214, 0.12)') },
            { label: 'Paralelo mín.', data: data[1], fill: '-1', ...band('rgba(15, 99, 214, 0.12)') },
            { label: 'Oficial máx.', data: data[2], fill: false, ...band('rgba(22, 163, 74, 0.12)') },
            { label: 'Oficial mín.', data: data[3], fill: '-1', ...band('rgba(22, 163, 74, 0.12)') },
            { label: 'Paralelo', data: data[4], borderColor: blue, backgroundColor: blue, borderWidth: 2.5, pointRadius: 0, tension: 0.2, spanGaps: true },
            { label: 'Paralelo (proyección)', data: data[5], borderColor: blue, backgroundColor: blue, borderWidth: 2.5, borderDash: [6, 4], pointRadius: 2.5, tension: 0.2 },
            { label: 'Oficial BCB', data: data[6], borderColor: green, backgroundColor: green, borderWidth: 2.5, pointRadius: 0, stepped: true },
            { label: 'Oficial (proyección)', data: data[7], borderColor: green, backgroundColor: green, borderWidth: 2.5, borderDash: [6, 4], pointRadius: 2.5, stepped: true }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { labels: { usePointStyle: true, filter: (item) => item.datasetIndex >= 4 } },
            tooltip: {
              filter: (item) => item.raw != null && item.datasetIndex >= 4 && (item.dataIndex !== this.anchor || item.datasetIndex % 2 === 0),
              callbacks: { label: (ctx) => `${ctx.dataset.label}: ${Number(ctx.raw).toFixed(2)} Bs` }
            }
          },
          scales: {
            y: { beginAtZero: false, ticks: { callback: (v) => Number(v).toFixed(2) } },
            x: { grid: { display: false }, ticks: { maxTicksLimit: 12 } }
          }
        }
      });
    }
  }

  window.DollarPredictionUI = DollarPredictionUI;
})();
