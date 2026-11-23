/* Arranque cerrado: únicamente el catálogo público se carga sin sesión verificada. */
window.Access = (() => {
  const recoveryFromUrl=new URLSearchParams(location.hash.slice(1)).get('type')==='recovery';
  const URL='https://tgggakuinkbibqvvuvob.supabase.co';
  // Cambiar en cada despliegue (también en index.html) para evitar mezclar versiones en caché.
  const BUILD='?v=20261121d';
  const KEY='sb_publishable_E0P2S9d5NsPWi8MM1IEE3A_Wgt5nKID';
  const client=window.supabase.createClient(URL,KEY,{auth:{storage:sessionStorage,persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  window.supabase=client;
  const labels={'inventory.read':'Consultar inventario (incluye stock y precios)','inventory.write':'Crear y editar productos','sales.read':'Consultar ventas, clientes y comprobantes','sales.create':'Registrar ventas','sales.edit':'Editar ventas','sales.cancel':'Anular ventas','movements.read':'Consultar movimientos y costos de ingreso','movements.create':'Transferir productos','movements.reverse':'Revertir transferencias','receipts.create':'Registrar ingresos de mercadería','quotes.manage':'Crear y consultar cotizaciones','dashboard.read':'Ver dashboard','settings.manage':'Modificar configuración comercial','access.manage':'Administrar usuarios y roles','exports.read':'Exportar los datos que puede consultar'};
  const sections={homeSection:null,ingresoSection:'receipts.create',movSection:'movements.read',realizarVentaSection:'sales.create',cotizacionSection:'quotes.manage',ventasHistSection:'sales.read',inventarioSection:'inventory.read',dashboardSection:'dashboard.read',predictionSection:null,adminSection:null,profileSection:null};
  const actions={sale_create:'sales.create',sale_edit:'sales.edit',sale_cancel:'sales.cancel',receipt:'receipts.create',transfer:'movements.create',transfer_reverse:'movements.reverse',products_save:'inventory.write'};
  let passwordLogin=false,context=null,loaded=false,loading=false,key=null,roles=[],features={},recovery=recoveryFromUrl,settings={data:{},version:1};
  const $=id=>document.getElementById(id);
  const can=p=>!!context?.active&&(!p||context.permissions.includes(p));
  function requirePermission(p){if(!can(p))throw Error('No tiene permiso para realizar esta acción.');}
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  async function rpc(name,args){const {data,error}=await client.rpc(name,args);if(error)throw Error(error.message);return data;}
  function showAuth(){const dialog=$('authDialog');dialog.hidden=false;if(!dialog.open){if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');}($('authForm').hidden?$('authNewPassword'):$('authEmail')).focus();}
  function closeAuth(){const dialog=$('authDialog');if(dialog.close)dialog.close();else dialog.removeAttribute('open');dialog.hidden=true;$('authPassword').value='';$('authNewPassword').value='';$('publicLogin').focus();}
  function status(message){$('authStatus').textContent=message;if(message&&document.documentElement.dataset.access==='public')showAuth();}
  function lock(){context=null;key=null;document.documentElement.dataset.access='public';$('publicView').hidden=false;document.querySelectorAll('.modal-overlay').forEach(el=>{el.hidden=true;});}
  function apply(){
    closeAuth();
    document.documentElement.dataset.access='private';$('publicView').hidden=true;
    $('sessionEmail').textContent=context.email+' · '+(context.owner?'Administrador principal':context.role||'Sin rol');
    document.querySelectorAll('[data-target],[data-go-section]').forEach(b=>{const id=b.dataset.target||b.dataset.goSection;b.disabled=!can(sections[id]);b.title=b.disabled?'Su rol no tiene este permiso':'';});
    const controls={invEditModeToggle:'inventory.write',bulkApply:'inventory.write',ventaDetallesEditar:'sales.edit',ventaDetallesAnular:'sales.cancel',ventaDetallesGuardar:'sales.edit',movAddItem:'movements.create',cfgBrandName:'settings.manage',cfgCoverageDays:'settings.manage'};
    for(const [id,p] of Object.entries(controls)){if($(id))$(id).disabled=!can(p);}
    $('accessManagement').hidden=!can('access.manage');$('adminExportCard').hidden=!can('exports.read');
    $('formMov').hidden=!can('movements.create');$('adminBulkPriceCard').hidden=!can('inventory.write');
    document.querySelector('[data-mov-view=movNewView]').hidden=!can('movements.create');
    if(!can('movements.create')&&can('movements.read'))document.querySelector('[data-mov-view=movHistView]').click();
    document.querySelectorAll('[data-permission]').forEach(el=>{el.hidden=!can(el.dataset.permission);});
  }
  async function seal(value){if(!key)throw Error('Sesión no disponible.');const iv=crypto.getRandomValues(new Uint8Array(12));const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(value));return JSON.stringify({v:2,iv:Array.from(iv),data:Array.from(new Uint8Array(data))});}
  async function open(raw){if(!key)throw Error('Inicie sesión para recuperar la operación pendiente.');const obj=JSON.parse(raw);return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(obj.iv)},key,new Uint8Array(obj.data)));}
  async function loadScript(src){await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.onload=resolve;s.onerror=()=>reject(Error('No se pudo cargar '+src));document.body.append(s);});}
  async function protectLegacy(){
    if(!can('access.manage'))return;
    const raw=localStorage.getItem('cotizaciones_v1');
    if(raw!==null){
      const list=JSON.parse(raw);if(!Array.isArray(list))throw Error('Cotizaciones locales inválidas: la copia original se conserva.');
      await rpc('store_archive_legacy',{p_name:'cotizaciones_v1',p_content:raw});
      for(const q of list) await rpc('store_quote_import',{p_data:q});
      // Solo se retira la copia local tras confirmar el archivo y todas las cotizaciones.
      localStorage.removeItem('cotizaciones_v1');
    }
    for(const name of Object.keys(sessionStorage).filter(k=>k.startsWith('mb_pending_v1:'))){await rpc('store_archive_legacy',{p_name:name,p_content:sessionStorage.getItem(name)});sessionStorage.removeItem(name);}
  }
  async function enter(){
    if(loading||loaded||recovery)return;loading=true;
    try{
      const viaPassword=passwordLogin;passwordLogin=false;
      const {data:{user},error}=await client.auth.getUser();if(error||!user){lock();status('');window.QuickAccess?.onLocked();return;}
      if(recovery)return;const [health,session,configuration]=await Promise.all([rpc('store_health'),rpc('store_session'),rpc('store_settings_read')]);features=health;if(health.auth!==true)throw Error('Falta aplicar la migración 004 de seguridad en Supabase. El área interna permanece bloqueada.');
      context=session;
      if(!context.active){status('Su correo está verificado. Su cuenta está pendiente de autorización por el administrador.');$('authLogoutPublic').hidden=false;return;}
      const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(context.cache_key));key=await crypto.subtle.importKey('raw',hash,'AES-GCM',false,['encrypt','decrypt']);
      settings=configuration;
      await Promise.all(['modules/store.js','modules/dashboard.js'].map(src=>loadScript(src+BUILD)));
      await protectLegacy();
      for(const src of ['app.js','modules/cotizaciones.js'])await loadScript(src+BUILD);
      loaded=true;apply();status('');void window.Experience?.onSession();void window.QuickAccess?.afterEnter(context,viaPassword);
    }catch(e){lock();status(e.message);$('authLogoutPublic').hidden=false;}finally{loading=false;}
  }
  async function catalog(){try{const data=await rpc('store_public_catalog');window.Experience?.catalog(data);$('catalogStatus').textContent=data.length?'Una selección de nuestros productos más vendidos.':'El catálogo estará disponible próximamente.';}catch{$('catalogStatus').textContent='El catálogo no está disponible en este momento.';}}
  async function renderAdmin(){
    if(!can('access.manage'))return;
    const data=await rpc('store_access_list');roles=data.roles;
    $('adminTabla').innerHTML=`<thead><tr><th>Permiso</th>${roles.map(r=>`<th>${esc(r.name)}</th>`).join('')}</tr></thead><tbody>${Object.entries(labels).map(([p,label])=>`<tr><td>${esc(label)}</td>${roles.map((r,i)=>`<td><input type="checkbox" aria-label="${esc(r.name+': '+label)}" data-role-index="${i}" data-perm="${p}" ${r.permissions.includes(p)?'checked':''}></td>`).join('')}</tr>`).join('')}</tbody>`;
    $('membersBody').innerHTML=data.members.filter(m=>m.owner||m.active||m.role).map(m=>`<tr><td>${esc(m.email)}${m.owner?' · Principal':''}</td><td><select aria-label="Rol de ${esc(m.email)}" ${m.owner||m.user_id===context.user_id?'disabled':''}><option value="">Pendiente</option>${roles.map(r=>`<option value="${esc(r.name)}" ${r.name===m.role?'selected':''}>${esc(r.name)}</option>`).join('')}</select></td><td><input type="checkbox" aria-label="Acceso activo para ${esc(m.email)}" ${m.active?'checked':''} ${m.owner||m.user_id===context.user_id?'disabled':''}></td><td><button type="button" data-member="${m.user_id}" data-version="${m.version}" ${m.owner||m.user_id===context.user_id?'disabled':''}>Guardar acceso</button>${m.owner||m.user_id===context.user_id?'':`<button type="button" class="secondary" data-password="${m.user_id}" data-email="${esc(m.email)}">Cambiar contraseña</button>`}</td></tr>`).join('');
    await window.AdminUsers?.render(roles);
  }
  async function task(button,fn){button.disabled=true;try{await fn();}catch(e){(loaded?window.Store.notice:status)(e.message,true);}finally{button.disabled=false;}}
  async function logout(){
    if(window.Store?.busy.size){window.Store.notice('Espere a que termine la operación antes de salir.',true);return;}
    lock();const {error}=await client.auth.signOut({scope:'local'});if(error){status('No se pudo cerrar la sesión: '+error.message);return;}location.reload();
  }
  document.addEventListener('DOMContentLoaded',()=>{
    $('publicLogin').addEventListener('click',showAuth);
    $('authClose').addEventListener('click',closeAuth);
    $('authDialog').addEventListener('cancel',e=>{e.preventDefault();closeAuth();});
    $('authDialog').addEventListener('click',e=>{if(e.target===$('authDialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeAuth();}});
    if(recovery){$('authNewPasswordForm').hidden=false;$('authForm').hidden=true;status('Elija su nueva contraseña.');}
    $('authForm').addEventListener('submit',e=>{e.preventDefault();task($('authLogin'),async()=>{passwordLogin=true;const {error}=await client.auth.signInWithPassword({email:$('authEmail').value.trim(),password:$('authPassword').value});if(error){passwordLogin=false;throw Error('No se pudo iniciar sesión. Revise correo, contraseña y confirmación del correo.');}$('authPassword').value='';await enter();});});
    $('authRegister').addEventListener('click',e=>task(e.currentTarget,async()=>{if(!$('authForm').reportValidity())return;const {error}=await client.auth.signUp({email:$('authEmail').value.trim(),password:$('authPassword').value,options:{emailRedirectTo:location.origin+location.pathname}});if(error)throw Error(error.message);$('authPassword').value='';status('Revise su correo para confirmar la cuenta. Después, el administrador deberá autorizar su acceso.');await enter();}));
    $('authReset').addEventListener('click',e=>task(e.currentTarget,async()=>{if(!$('authEmail').reportValidity())return;const {error}=await client.auth.resetPasswordForEmail($('authEmail').value.trim(),{redirectTo:location.origin+location.pathname});if(error)throw Error(error.message);status('Si el correo corresponde a una cuenta, recibirá instrucciones de recuperación.');}));
    $('authNewPasswordForm').addEventListener('submit',e=>{e.preventDefault();task($('authSavePassword'),async()=>{const {error}=await client.auth.updateUser({password:$('authNewPassword').value});if(error)throw Error(error.message);$('authNewPassword').value='';recovery=false;await logout();});});
    for(const id of ['authLogout','authLogoutPublic'])$(id).addEventListener('click',logout);
    $('adminAgregarRol').addEventListener('click',e=>task(e.currentTarget,async()=>{await rpc('store_role_save',{p_name:$('adminNuevoRol').value.trim(),p_permissions:[],p_version:0});$('adminNuevoRol').value='';await renderAdmin();}));
    $('adminGuardar').addEventListener('click',e=>task(e.currentTarget,async()=>{const changes=[];for(let i=0;i<roles.length;i++){const permissions=[...document.querySelectorAll(`[data-role-index="${i}"]:checked`)].map(c=>c.dataset.perm);if(JSON.stringify([...permissions].sort())!==JSON.stringify([...roles[i].permissions].sort()))changes.push({name:roles[i].name,permissions,version:roles[i].version});}await rpc('store_roles_save',{p_roles:changes});await renderAdmin();window.Store.notice('Permisos guardados. Los cambios se aplican en cada consulta.');}));
    $('membersRefresh').addEventListener('click',e=>task(e.currentTarget,renderAdmin));
    $('membersBody').addEventListener('click',e=>{const b=e.target.closest('[data-member]');if(b)task(b,async()=>{const row=b.closest('tr');await rpc('store_member_save',{p_user:b.dataset.member,p_role:row.querySelector('select').value||null,p_active:row.querySelector('input').checked,p_version:Number(b.dataset.version)});await renderAdmin();window.Store.notice('Acceso actualizado.');});});
    $('legacyExport').addEventListener('click',e=>task(e.currentTarget,async()=>{const data=await rpc('store_legacy_archives');const url=window.URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='archivo-local-conservado.json';a.click();setTimeout(()=>window.URL.revokeObjectURL(url),1000);}));
    client.auth.onAuthStateChange((event)=>{if(event==='PASSWORD_RECOVERY'){recovery=true;lock();$('authNewPasswordForm').hidden=false;$('authForm').hidden=true;showAuth();}else if(event==='SIGNED_OUT'){lock();if(loaded)location.reload();}else if(event==='SIGNED_IN')setTimeout(enter,0);});
    catalog();enter();
    setInterval(async()=>{if(!loaded||!context)return;try{const next=await rpc('store_session');if(JSON.stringify(next)!==JSON.stringify(context)){lock();location.reload();}}catch{lock();location.reload();}},15000);
  });
  return {get inventoryIntegrity(){return features.inventory_integrity===true;},get health(){return features;},get reversalReasons(){return features.reversal_reasons===true;},can,require:requirePermission,sections,actions,apply,showAuth,logout,renderAdmin,rpc,seal,open,get settings(){return settings.data;},async saveSettings(data){await rpc('store_settings_save',{p_data:data,p_version:settings.version});settings=await rpc('store_settings_read');},get userId(){return context?.user_id;},get context(){return context;}};
})();
