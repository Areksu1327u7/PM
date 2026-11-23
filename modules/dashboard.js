/* Dashboard de solo lectura. Los periodos incluyen hoy, en horario de Bolivia. */
(function () {
  const colors=['#2563eb','#14b8a6','#8b5cf6','#f59e0b','#ec4899','#64748b','#38bdf8','#94a3b8'];
  const charts=new Map(); let snapshot=null, sequence=0, days=30;
  const number=new Intl.NumberFormat('es-BO',{maximumFractionDigits:0});
  const money=n=>'Bs '+new Intl.NumberFormat('es-BO',{minimumFractionDigits:2,maximumFractionDigits:2}).format(n);
  const compact=n=>new Intl.NumberFormat('es-BO',{notation:'compact',maximumFractionDigits:1}).format(n);
  const sum=(rows,key)=>rows.reduce((a,r)=>a+Number(r[key]||0),0);
  function shift(date,offset){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+offset);return d.toISOString().slice(0,10);}
  function model(products,movements,sales,today,period){
    const cancelled=new Set(movements.filter(m=>String(m.detalle).startsWith('Anulación comprobante ')).map(m=>m.detalle.slice('Anulación comprobante '.length)));
    const valid=sales.filter(s=>s.estado!=='anulada'&&!cancelled.has(String(s.numero)));
    const start=shift(today,1-period), previousStart=shift(start,-period);
    const selected=valid.filter(s=>s.fecha>=start&&s.fecha<=today), previous=valid.filter(s=>s.fecha>=previousStart&&s.fecha<start);
    const dates=Array.from({length:period},(_,i)=>shift(start,i)), buckets=new Map(dates.map(d=>[d,{sales:0,receipts:0,discount:0,count:0}]));
    selected.forEach(s=>{const b=buckets.get(s.fecha);b.sales+=Number(s.total||0);b.discount+=Number(s.descuento_pct||0);b.count++;});
    movements.filter(m=>m.tipo==='ingreso'&&buckets.has(m.fecha)).forEach(m=>buckets.get(m.fecha).receipts+=Number(m.total||0));
    const categories=new Map();
    products.forEach(p=>{const name=p.categoria||'General',c=categories.get(name)||{name,stock:0,value:0,ceja:0,senkata:0};c.ceja+=Number(p.ceja||0);c.senkata+=Number(p.senkata||0);c.stock+=Number(p.ceja||0)+Number(p.senkata||0);c.value+=(Number(p.ceja||0)+Number(p.senkata||0))*Number(p.precio||0);categories.set(name,c);});
    const total=sum(selected,'total'),before=sum(previous,'total');
    return {today,start,dates,valid,selected,buckets,categories:[...categories.values()].sort((a,b)=>b.stock-a.stock),total,before,change:before>0?(total-before)/before*100:null,ticket:selected.length?total/selected.length:0,stock:products.reduce((a,p)=>a+Number(p.ceja||0)+Number(p.senkata||0),0),value:[...categories.values()].reduce((a,c)=>a+c.value,0),emptyCeja:products.filter(p=>Number(p.ceja||0)<=0).length,todaySales:sum(valid.filter(s=>s.fecha===today),'total'),todayReceipts:sum(movements.filter(m=>m.tipo==='ingreso'&&m.fecha===today),'total')};
  }
  window.DashboardModel={model,shift};
  const text=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=value;};
  function grouped(categories,key){
    const sorted=[...categories].sort((a,b)=>b[key]-a[key]),top=sorted.slice(0,6);
    if(sorted.length>6)top.push({name:'Otras categorías',stock:sum(sorted.slice(6),'stock'),value:sum(sorted.slice(6),'value'),ceja:sum(sorted.slice(6),'ceja'),senkata:sum(sorted.slice(6),'senkata')});
    return top;
  }
  function plot(id,type,labels,datasets,{horizontal=false,stacked=false,currency=false,percent=false,empty=false}={}){
    const canvas=document.getElementById(id);if(!canvas)return;
    const container=canvas.parentElement;
    let message=container.querySelector('.chart-empty');
    if(!message){message=document.createElement('p');message.className='chart-empty';message.textContent='Sin datos para mostrar en este período';container.append(message);}
    message.hidden=!empty; canvas.style.opacity=empty?'.2':'1';
    canvas.setAttribute('role','img');canvas.setAttribute('aria-label',container.closest('.card')?.querySelector('h3')?.textContent||'Gráfico');
    canvas.textContent=labels.map((l,i)=>l+': '+datasets.map(d=>d.label+' '+d.data[i]).join(', ')).join('; ');
    if(typeof Chart==='undefined') {message.hidden=false;message.textContent='El gráfico no está disponible. Los indicadores siguen visibles.';return;}
    const doughnut=type==='doughnut';
    const axis={border:{display:false},grid:{color:'#eef2f7',drawTicks:false},ticks:{color:'#768399',font:{size:11},padding:10,callback:v=>currency?'Bs '+compact(v):percent?v+'%':compact(v)},beginAtZero:true,stacked};
    const labelAxis={border:{display:false},grid:{display:false},ticks:{color:'#64748b',font:{size:11},maxRotation:0,autoSkip:true,maxTicksLimit:8},stacked};
    const options={responsive:true,maintainAspectRatio:false,animation:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?false:{duration:350},interaction:{intersect:false,mode:doughnut?'nearest':'index'},layout:{padding:{top:8,right:10}},plugins:{legend:{display:doughnut||datasets.length>1,position:'bottom',labels:{usePointStyle:true,pointStyle:'circle',boxWidth:7,boxHeight:7,padding:18,color:'#526078',font:{size:11}}},tooltip:{backgroundColor:'#14253f',titleColor:'#fff',bodyColor:'#e3ecfb',padding:12,cornerRadius:10,displayColors:true,callbacks:{label:c=>{const v=Number(doughnut?c.parsed:horizontal?c.parsed.x:c.parsed.y);return (c.dataset.label?c.dataset.label+': ':'')+(currency?money(v):percent?v.toFixed(1)+'%':number.format(v));}}}},...(doughnut?{cutout:'72%'}:{indexAxis:horizontal?'y':'x',scales:horizontal?{x:axis,y:labelAxis}:{x:labelAxis,y:axis}})};
    const prior=charts.get(id);
    if(prior&&prior.config?.type===type){prior.data={labels,datasets};prior.options=options;prior.update('none');}
    else {prior?.destroy();charts.set(id,new Chart(canvas.getContext('2d'),{type,data:{labels,datasets},options}));}
  }
  function line(label,data,color,fill=false){return {label,data,borderColor:color,backgroundColor:color+'14',fill,tension:.25,borderWidth:2.5,pointRadius:0,pointHoverRadius:5,pointHitRadius:18};}
  function bar(label,data,color){return {label,data,backgroundColor:color,borderRadius:5,maxBarThickness:24,borderSkipped:false};}
  function render(){
    if(!snapshot)return;
    const {products,movements,sales,items}=snapshot,m=model(products,movements,sales,Store.date(),days);
    text('dashSalesTotal',money(m.total));text('dashTicket',money(m.ticket));text('dashSaleCount',number.format(m.selected.length)+' ventas vigentes');text('kpiStockTotal',number.format(m.stock));text('dashCritical',number.format(m.emptyCeja));
    text('kpiTotalProductos',number.format(products.length));text('kpiValorInventario',money(m.value));text('kpiVentasHoy',money(m.todaySales));text('kpiIngresosHoy',money(m.todayReceipts));
    text('dashRange',`${m.start.split('-').reverse().join('/')} — ${m.today.split('-').reverse().join('/')}`);
    const change=document.getElementById('dashChange');
    if(change){change.textContent=m.change===null?'Sin base de comparación':`${m.change>=0?'+':''}${m.change.toFixed(1)}% vs. ${days} días anteriores`;change.className='metric-note '+(m.change===null?'':m.change>=0?'positive':'negative');}
    const labels=m.dates.map(d=>d.slice(8)+'/'+d.slice(5,7)),salesDaily=m.dates.map(d=>m.buckets.get(d).sales),receipts=m.dates.map(d=>m.buckets.get(d).receipts);
    let accrued=0;
    plot('chartMovimientos','line',labels,[line('Ventas netas',salesDaily,'#2563eb',true),line('Ingresos de mercadería al costo',receipts,'#14b8a6')],{currency:true,empty:!salesDaily.some(Boolean)&&!receipts.some(Boolean)});
    const cats=grouped(m.categories,'stock');
    plot('chartStockPorCategoria','doughnut',cats.map(c=>c.name),[{label:'Unidades',data:cats.map(c=>c.stock),backgroundColor:colors,borderWidth:3,borderColor:'#fff',hoverOffset:6}],{empty:m.stock===0});
    const top=[...products].sort((a,b)=>(Number(b.ceja)+Number(b.senkata))-(Number(a.ceja)+Number(a.senkata))).slice(0,8);
    plot('chartTopProductos','bar',top.map(p=>p.nombre.length>34?p.nombre.slice(0,31)+'…':p.nombre),[bar('Unidades',top.map(p=>Number(p.ceja||0)+Number(p.senkata||0)),'#2563eb')],{horizontal:true,empty:!top.length||!m.stock});
    plot('chartDepositosPorCategoria','bar',cats.map(c=>c.name),[bar('CEJA',cats.map(c=>c.ceja),'#2563eb'),bar('SENKATA',cats.map(c=>c.senkata),'#2dd4bf')],{stacked:true,empty:!m.stock});
    plot('chartVentasAcumuladas','line',labels,[line('Ventas acumuladas',salesDaily.map(v=>accrued+=v),'#14b8a6',true)],{currency:true,empty:!m.selected.length});
    const values=grouped(m.categories,'value');
    plot('chartValorInventarioPorCategoria','bar',values.map(c=>c.name),[bar('Valor a precio de venta',values.map(c=>c.value),'#8b5cf6')],{horizontal:true,currency:true,empty:!m.value});
    plot('chartDescuentoPorDia','line',labels,[line('Descuento medio por venta',m.dates.map(d=>{const b=m.buckets.get(d);return b.count?b.discount/b.count:null;}),'#f59e0b')],{percent:true,empty:!m.selected.length});
    // Reposición: ventana fija de 30 días, independiente del filtro de gráficos.
    const recent=new Set(m.valid.filter(s=>s.fecha>=shift(m.today,-29)&&s.fecha<=m.today).map(s=>s.id)),qty=new Map();
    items.filter(i=>recent.has(i.sale_id)&&Number(i.cantidad)>0).forEach(i=>qty.set(i.item,(qty.get(i.item)||0)+Number(i.cantidad)));
    const coverage=Number(getSettings().coverageDays)||14;
    text('dashCoverage',`Cobertura objetivo: ${coverage} días · demanda de los últimos 30 días`);
    const alerts=products.map(p=>{const rate=(qty.get(p.item)||0)/30,stock=Number(p.ceja||0)+Number(p.senkata||0);return {p,rate,stock,left:rate?stock/rate:Infinity,suggested:Math.max(0,Math.ceil(rate*coverage-stock))};}).filter(a=>a.left<=7).sort((a,b)=>a.left-b.left);
    const tbody=document.querySelector('#reabastTabla tbody');
    if(tbody)tbody.innerHTML=alerts.length?alerts.map(a=>`<tr><td><strong>${escapeHtml(a.p.item)}</strong></td><td>${escapeHtml(a.p.nombre)}</td><td>${number.format(a.stock)}</td><td>${a.rate.toFixed(2)}</td><td><span class="badge ${a.left<=2?'badge-critical':'badge-alert'}">${a.left.toFixed(1)} días</span></td><td>${number.format(a.suggested)}</td><td><button type="button" class="secondary" data-product="${escapeAttr(a.p.item)}">Ver ventas</button></td></tr>`).join(''):`<tr><td colspan="7" class="dashboard-empty">${recent.size?'Sin alertas de cobertura según las ventas de los últimos 30 días.':'No hay ventas recientes suficientes para estimar la reposición.'}</td></tr>`;
    tbody?.querySelectorAll('[data-product]').forEach(b=>b.addEventListener('click',()=>showProductoVentasModal(b.dataset.product)));
    text('dashUpdated','Actualizado '+new Intl.DateTimeFormat('es-BO',{timeZone:'America/La_Paz',hour:'2-digit',minute:'2-digit'}).format(snapshot.at));
    document.querySelectorAll('[data-dash-days]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.dashDays)===days)));
  }
  async function refresh(){
    const current=++sequence,section=document.getElementById('dashboardSection');section?.setAttribute('aria-busy','true');
    try{
      const today=Store.date();
      // Hasta 90 días seleccionados y 90 de comparación. Las anulaciones se
      // consultan sin límite de fecha para respetar también correcciones tardías.
      const [products,receipts,cancellations,sales]=await Promise.all([
        allProducts(),
        Store.all('movements',q=>q.eq('tipo','ingreso').gte('fecha',shift(today,-89)).lte('fecha',today)),
        Store.all('movements',q=>q.eq('tipo','venta').ilike('detalle','Anulación comprobante %')),
        Store.all('sales',q=>q.gte('fecha',shift(today,-179)).lte('fecha',today))
      ]);
      const movements=[...receipts,...cancellations],recent=model(products,movements,sales,today,30).selected.map(s=>s.id),items=[];
      const chunks=[];for(let i=0;i<recent.length;i+=200)chunks.push(recent.slice(i,i+200));
      for(let i=0;i<chunks.length;i+=4)for(const rows of await Promise.all(chunks.slice(i,i+4).map(ids=>Store.all('sales_items',q=>q.in('sale_id',ids)))))items.push(...rows);
      if(current!==sequence)return;
      snapshot={products,movements,sales,items,at:new Date()};render();
      text('dashError','');document.getElementById('dashError').hidden=true;
    }catch(e){if(current===sequence){const error=document.getElementById('dashError');error.hidden=false;error.textContent='No se pudo actualizar el panel. '+(snapshot?'Se conservan los últimos datos cargados.':'Revise la conexión e intente nuevamente.');}throw e;}
    finally{if(current===sequence)section?.removeAttribute('aria-busy');}
  }
  function resize(){charts.forEach(c=>c.resize?.());}
  function initialize(){
    document.querySelectorAll('[data-dash-days]').forEach(b=>b.addEventListener('click',()=>{days=Number(b.dataset.dashDays);render();}));
    document.getElementById('dashRefresh')?.addEventListener('click',e=>Store.run('dashboard',e.currentTarget,refresh));
    document.getElementById('dashAdvanced')?.addEventListener('toggle',()=>requestAnimationFrame(resize));
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',initialize); else queueMicrotask(initialize);
  window.Dashboard={refresh,onShow(){requestAnimationFrame(resize);},render};
})();
