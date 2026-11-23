/* Presentación pública, perfil propio y consulta administrativa. */
window.Experience=(()=>{
  const $=id=>document.getElementById(id);
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let featured=[],index=0,profile={alias:'',version:0},auditCursor=null,auditRequest=0,reasonResolve=null;
  const money=n=>'Bs '+new Intl.NumberFormat('es-BO',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(n));
  let revealObserver;
  function reveal(elements){
    if(!window.IntersectionObserver||window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;
    revealObserver??=new IntersectionObserver(entries=>entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.add('is-visible');revealObserver.unobserve(entry.target);}}),{threshold:0.08});
    elements.forEach((el,i)=>{el.style.setProperty('--reveal-delay',`${Math.min(i%4,3)*65}ms`);el.classList.add('catalog-reveal');revealObserver.observe(el);});
  }
  function catalog(data){
    featured=data;index=0;
    $('publicProducts').innerHTML=data.map((p,i)=>`<article class="public-product card"><div class="product-mark" aria-hidden="true"><span>${String(i+1).padStart(2,'0')}</span><span class="product-spark">✦</span></div><span class="eyebrow">${esc(p.categoria||'Selección MB')}</span><h3>${esc(p.nombre)}</h3><strong>${money(p.precio)}</strong><p>Consulta disponibilidad en tienda</p></article>`).join('');
    drawFeatured();
    reveal(document.querySelectorAll('.public-product'));
  }
  function drawFeatured(){
    const p=featured[index];
    $('catalogPrev').disabled=$('catalogNext').disabled=featured.length<2;
    $('catalogPosition').textContent=p?`${index+1} / ${featured.length}`:'';
    $('featuredProducts').innerHTML=p?`<article class="featured-product"><div class="featured-art" aria-hidden="true"><span class="featured-orbit"></span><span class="featured-number">${String(index+1).padStart(2,'0')}</span><span class="featured-stamp">SELECCIÓN MB</span></div><div class="featured-copy"><p class="eyebrow">${esc(p.categoria||'PRODUCTO DESTACADO')}</p><h3>${esc(p.nombre)}</h3><strong>${money(p.precio)}</strong><p>Descubre este producto en nuestra tienda.<br>Consulta disponibilidad con nuestro equipo.</p></div></article>`:'<p class="catalog-empty">Pronto encontrarás aquí nuestros productos destacados.</p>';
  }
  function move(step){if(featured.length){index=(index+step+featured.length)%featured.length;drawFeatured();}}
  async function loadProfile(){
    try{profile=await Access.rpc('store_profile_read');$('profileAlias').value=profile.alias;$('sessionAlias').textContent=profile.alias;window.QuickAccess?.updateAlias(profile.alias);$('profileStatus').textContent='';}
    catch(e){$('profileStatus').textContent='No se pudo cargar el perfil. '+e.message;}
  }
  async function loadAudit(more=false){
    if(!Access.can('access.manage'))return;
    const request=++auditRequest,cursor=more?auditCursor:null;
    $('auditStatus').textContent='Cargando operaciones…';$('auditMore').disabled=true;
    try{
      const rows=await Access.rpc('store_reversal_history',{p_before:cursor});
      if(request!==auditRequest)return;
      const page=rows.slice(0,50),format=new Intl.DateTimeFormat('es-BO',{timeZone:'America/La_Paz',dateStyle:'medium',timeStyle:'short'});
      const html=page.map(r=>`<tr><td>${esc(format.format(new Date(r.created_at)))}</td><td><span class="badge ${r.action==='sale_cancel'?'badge-critical':'badge-alert'}">${r.action==='sale_cancel'?'Venta anulada':'Movimiento revertido'}</span><br><strong>${esc(r.reference)}</strong></td><td><ul class="audit-products">${r.products.map(p=>`<li><strong>${esc(p.item)}</strong> · ${esc(p.nombre)}<br>${esc(p.cantidad)} unidades → ${esc(p.destino)}</li>`).join('')}</ul></td><td class="audit-reason">${esc(r.reason)}</td><td><strong>${esc(r.actor_alias||'Sin alias')}</strong><br>${esc(r.actor_email)}<small class="audit-identity">ID: ${esc(r.actor_id)}</small></td></tr>`).join('');
      if(more)$('auditBody').insertAdjacentHTML('beforeend',html);else $('auditBody').innerHTML=html;
      auditCursor=page.at(-1)?.id??null;$('auditMore').hidden=rows.length<=50;
      $('auditStatus').textContent=page.length?'Los registros se conservan y no se pueden editar desde la aplicación.':'No hay anulaciones o reversiones registradas desde esta actualización.';
    }catch(e){if(request===auditRequest)$('auditStatus').textContent='No se pudo actualizar el historial. '+e.message;}
    finally{if(request===auditRequest)$('auditMore').disabled=false;}
  }
  function requestReason(title,description){
    if(!Access.reversalReasons){Store.notice('Instale la migración 005 para registrar motivos antes de anular o revertir.',true);return Promise.resolve(null);}
    if(reasonResolve)return Promise.resolve(null);
    $('reasonTitle').textContent=title;$('reasonDescription').textContent=description;
    $('operationReason').value='';$('operationReason').setCustomValidity('');
    const dialog=$('operationReasonDialog');
    if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');
    $('operationReason').focus();
    return new Promise(resolve=>{reasonResolve=resolve;});
  }
  function finishReason(value){const resolve=reasonResolve;reasonResolve=null;const dialog=$('operationReasonDialog');if(dialog.close)dialog.close();else dialog.removeAttribute('open');resolve?.(value);}
  document.addEventListener('DOMContentLoaded',()=>{
    reveal(document.querySelectorAll('.public-hero,.featured-section,.storefront > .catalog-heading'));
    $('catalogPrev').addEventListener('click',()=>move(-1));$('catalogNext').addEventListener('click',()=>move(1));
    $('featuredProducts').addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();move(e.key==='ArrowRight'?1:-1);}});
    let touchX=null;
    $('featuredProducts').addEventListener('touchstart',e=>{touchX=e.touches[0]?.clientX??null;},{passive:true});
    $('featuredProducts').addEventListener('touchend',e=>{const dx=(e.changedTouches[0]?.clientX??touchX)-touchX;if(touchX!==null&&Math.abs(dx)>55)move(dx<0?1:-1);touchX=null;},{passive:true});
    $('operationReasonForm').addEventListener('submit',e=>{e.preventDefault();const reason=$('operationReason').value.replace(/\s+/g,' ').trim();if(reason.length<5||reason.length>500){$('operationReason').setCustomValidity('Explica el motivo con entre 5 y 500 caracteres.');$('operationReason').reportValidity();return;}finishReason(reason);});
    $('operationReason').addEventListener('input',()=> $('operationReason').setCustomValidity(''));
    $('reasonCancel').addEventListener('click',()=>finishReason(null));$('operationReasonDialog').addEventListener('cancel',e=>{e.preventDefault();finishReason(null);});
    $('operationReasonDialog').addEventListener('keydown',e=>{if(e.key==='Escape')e.stopPropagation();});
    $('profileForm').addEventListener('submit',async e=>{
      e.preventDefault();const button=$('profileSave');if(button.disabled)return;button.disabled=true;
      try{profile=await Access.rpc('store_profile_save',{p_alias:$('profileAlias').value,p_version:profile.version});$('profileAlias').value=profile.alias;$('sessionAlias').textContent=profile.alias;window.QuickAccess?.updateAlias(profile.alias);$('profileStatus').textContent='Alias guardado. Tu cuenta y tus permisos no cambiaron.';}
      catch(error){$('profileStatus').textContent=error.message;}finally{button.disabled=false;}
    });
    $('profileRefresh').addEventListener('click',loadProfile);
    $('auditRefresh').addEventListener('click',()=>loadAudit());$('auditMore').addEventListener('click',()=>loadAudit(true));
  });
  return {catalog,requestReason,onSession:loadProfile,onSection(id){if(id==='adminSection')loadAudit();}};
})();
