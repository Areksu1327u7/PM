/* Ingreso rápido con código de 4 dígitos en equipos recordados.
   El equipo guarda un identificador y un secreto aleatorio (256 bits) y la lista de personas que
   ingresaron. El código se verifica en el servidor (Edge Function pin-login), con 5 intentos como máximo.
   Nunca se guarda en el navegador la contraseña, el código ni una sesión reutilizable. */
window.QuickAccess=(()=>{
  const $=id=>document.getElementById(id);
  const STORE='mb_quick_access_v1',SKIP='mb_quick_skip_v1',PICK='mb_quick_pick';
  const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let selected=null,busy=false,session=null;

  // ----- Almacenamiento del equipo -----
  function load(){
    try{
      const d=JSON.parse(localStorage.getItem(STORE)||'null');
      if(d&&UUID.test(d.device_id)&&/^[0-9a-f]{64}$/.test(d.secret)&&Array.isArray(d.accounts))
        return {...d,accounts:d.accounts.filter(a=>a&&UUID.test(a.user_id)&&typeof a.email==='string')};
    }catch{}
    return null;
  }
  function save(d){try{localStorage.setItem(STORE,JSON.stringify(d));return true;}catch{return false;}}
  function device(){
    let d=load();
    if(!d){
      const bytes=crypto.getRandomValues(new Uint8Array(32));
      d={device_id:crypto.randomUUID(),secret:Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join(''),accounts:[]};
      if(!save(d))throw Error('Este navegador no permite recordar el equipo (modo privado o almacenamiento bloqueado).');
    }
    return d;
  }
  const accounts=()=>[...(load()?.accounts||[])].sort((a,b)=>(b.last_used||0)-(a.last_used||0));
  const isRemembered=id=>accounts().some(a=>a.user_id===id);
  function remember(account){
    const d=device();
    const previous=d.accounts.find(a=>a.user_id===account.user_id)||{};
    d.accounts=[{...previous,...account,last_used:Date.now()},...d.accounts.filter(a=>a.user_id!==account.user_id)].slice(0,12);
    if(!save(d))throw Error('No se pudo guardar la cuenta en este equipo.');
  }
  function forgetLocal(id){const d=load();if(!d)return;d.accounts=d.accounts.filter(a=>a.user_id!==id);save(d);}
  function skipped(id){try{return JSON.parse(localStorage.getItem(SKIP)||'[]').includes(id);}catch{return false;}}
  function setSkipped(id,value){
    try{const list=JSON.parse(localStorage.getItem(SKIP)||'[]').filter(x=>x!==id);if(value)list.push(id);localStorage.setItem(SKIP,JSON.stringify(list.slice(-30)));}catch{}
  }
  const nameOf=a=>a.alias||a.email;
  const initial=a=>(nameOf(a).trim()[0]||'?').toUpperCase();

  // ----- Panel de ingreso -----
  const inRecovery=()=>$('authNewPasswordForm')&&!$('authNewPasswordForm').hidden;
  function render(){
    $('quickAccounts').innerHTML=accounts().map(a=>`<div class="quick-account">
      <button type="button" class="quick-person" data-user="${esc(a.user_id)}"><span class="quick-avatar" aria-hidden="true">${esc(initial(a))}</span><span class="quick-person-text"><strong>${esc(nameOf(a))}</strong>${a.alias?`<small>${esc(a.email)}</small>`:''}</span></button>
      <button type="button" class="quick-forget" data-forget="${esc(a.user_id)}" aria-label="Quitar a ${esc(nameOf(a))} de este equipo" title="Quitar de este equipo">✕</button>
    </div>`).join('');
  }
  function mode(next){
    if(inRecovery())return;
    const has=accounts().length>0;
    if(!has&&next!=='password')next='password';
    $('quickPanel').hidden=next==='password';
    $('quickPick').hidden=next!=='pick';
    $('quickPinForm').hidden=next!=='pin';
    $('authForm').hidden=next!=='password';
    $('quickBackToList').hidden=!(has&&next==='password');
    $('authTitle').textContent=next==='pick'?'¿Quién va a ingresar?':'Iniciar sesión';
    if(next==='pick'){render();requestAnimationFrame(()=>document.querySelector('.quick-person')?.focus());}
    if(next==='pin'){$('quickPin').value='';status('');requestAnimationFrame(()=>$('quickPin').focus());}
  }
  function status(text,error=false){const el=$('quickPinStatus');el.textContent=text;el.classList.toggle('quick-error',error);}
  function choose(id){
    selected=accounts().find(a=>a.user_id===id);if(!selected)return mode('pick');
    $('quickAvatar').textContent=initial(selected);$('quickName').textContent=nameOf(selected);
    mode('pin');
  }
  function toPassword(email){mode('password');if(email)$('authEmail').value=email;requestAnimationFrame(()=>(email?$('authPassword'):$('authEmail')).focus());}
  function lockKeypad(value){busy=value;$('quickPinForm').querySelectorAll('button,input').forEach(el=>{el.disabled=value;});}

  async function invokeError(error){
    const code=error?.context?.status;
    if(code===404)return 'El ingreso con código todavía no está habilitado en el servidor (falta publicar la función pin-login). Ingrese con correo y contraseña.';
    if(code===401||code===403)return 'La función pin-login tiene activada la verificación JWT. Desactívela en Supabase para habilitar el ingreso con código.';
    if(error?.name==='FunctionsFetchError')return 'Sin conexión con el servidor. Revise internet e intente otra vez.';
    return 'No se pudo verificar el código. Intente otra vez en unos segundos.';
  }
  async function submitPin(){
    const pin=$('quickPin').value;
    if(busy||!selected||!/^[0-9]{4}$/.test(pin))return;
    const d=load();if(!d){mode('password');return;}
    lockKeypad(true);status('Verificando…');
    try{
      const {data,error}=await window.supabase.functions.invoke('pin-login',{body:{user_id:selected.user_id,device_id:d.device_id,secret:d.secret,pin}});
      if(error){status(await invokeError(error),true);return;}
      if(!data?.ok){
        const who=selected;
        if(data?.reason==='pin'){status(`Código incorrecto. ${data.remaining===1?'Queda 1 intento':`Quedan ${data.remaining} intentos`} antes de pedir la contraseña.`,true);return;}
        if(data?.reason==='inactive'||data?.reason==='blocked'){status('Esta cuenta no está autorizada en este momento. Consulte con el administrador.',true);return;}
        // locked / no_pin / unknown: se requiere la contraseña para volver a habilitar el código aquí.
        forgetLocal(who.user_id);
        toPassword(who.email);
        $('authStatus').textContent=data?.reason==='locked'
          ?'Demasiados códigos incorrectos. Por seguridad el código se desactivó en todos los equipos. Ingrese con su contraseña y vuelva a crearlo (puede ser el mismo).'
          :data?.reason==='no_pin'
          ?'Esta cuenta todavía no tiene código. Ingrese con su contraseña y créelo.'
          :'Este equipo ya no está habilitado para su código. Ingrese con su contraseña una vez para habilitarlo.';
        return;
      }
      let result=await window.supabase.auth.verifyOtp({token_hash:data.token_hash,type:'magiclink'});
      if(result.error)result=await window.supabase.auth.verifyOtp({token_hash:data.token_hash,type:'email'});
      if(result.error){status('No se pudo abrir la sesión. Intente otra vez.',true);return;}
      remember({user_id:selected.user_id,email:selected.email,alias:selected.alias||''});
      status('Ingresando…');
      // Access recibe SIGNED_IN y abre el área privada.
    }catch(e){status(e?.message||'No se pudo verificar el código.',true);}
    finally{lockKeypad(false);$('quickPin').value='';if(!$('quickPinForm').hidden&&!$('quickPinStatus').textContent.startsWith('Ingresando'))$('quickPin').focus();}
  }
  async function forget(id){
    const a=accounts().find(x=>x.user_id===id);if(!a)return;
    if(!confirm(`¿Quitar a ${nameOf(a)} de este equipo? La próxima vez deberá ingresar con correo y contraseña.`))return;
    const d=load();
    try{await window.supabase.rpc('store_pin_forget',{p_user:id,p_device:d.device_id,p_secret:d.secret});}catch{}
    forgetLocal(id);setSkipped(id,true);
    mode(accounts().length?'pick':'password');
  }

  // ----- Crear o cambiar código -----
  function openSetup(){
    if(!session)return;
    $('pinSetupPin').value='';$('pinSetupConfirm').value='';$('pinSetupStatus').textContent='';
    $('pinSetupTitle').textContent=isRemembered(session.user_id)?'Cambia tu código de 4 números':'Crea tu código de 4 números';
    const dialog=$('pinSetupDialog');if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');
    $('pinSetupPin').focus();
  }
  function closeSetup(){const dialog=$('pinSetupDialog');if(dialog.close)dialog.close();else dialog.removeAttribute('open');}
  async function saveSetup(){
    const pin=$('pinSetupPin').value,again=$('pinSetupConfirm').value,out=$('pinSetupStatus');
    if(!/^[0-9]{4}$/.test(pin)){out.textContent='El código debe tener exactamente 4 números.';return;}
    if(pin!==again){out.textContent='Los dos códigos no coinciden.';return;}
    $('pinSetupSave').disabled=true;out.textContent='Guardando…';
    try{
      const d=device();
      const result=await Access.rpc('store_pin_register',{p_device:d.device_id,p_secret:d.secret,p_pin:pin});
      if(result?.trusted)remember({user_id:session.user_id,email:session.email,alias:$('sessionAlias')?.textContent?.trim()||''});
      setSkipped(session.user_id,false);closeSetup();updateProfile();
      window.Store?.notice(result?.trusted
        ?'Listo. En este equipo y en cualquier otro donde haya ingresado con su contraseña, elija su nombre y escriba su código.'
        :'Código guardado. Para usarlo en este equipo, ingrese aquí una vez con su contraseña.');
    }catch(e){out.textContent=e.message||'No se pudo guardar el código.';}
    finally{$('pinSetupSave').disabled=false;}
  }
  function updateProfile(){
    const card=$('quickProfileCard');if(!card)return;
    card.hidden=!session||Access.health?.quick_access_v2!==true;
    if(card.hidden)return;
    const on=isRemembered(session.user_id);
    $('quickProfileStatus').textContent=on?'Activo en este equipo: puede ingresar eligiendo su nombre y escribiendo su código.':'Este equipo no tiene su código activo. Puede crear o cambiar su código aquí.';
    $('quickProfileSet').textContent=on?'Cambiar código':'Crear código';
    $('quickProfileRemove').hidden=!on;
  }
  async function removeHere(){
    if(!session||!confirm('¿Quitar el ingreso con código de este equipo? Podrá crearlo de nuevo cuando quiera.'))return;
    const d=load();
    try{if(d)await Access.rpc('store_pin_remove',{p_device:d.device_id});forgetLocal(session.user_id);setSkipped(session.user_id,true);updateProfile();window.Store?.notice('Se quitó el ingreso con código de este equipo.');}
    catch(e){window.Store?.notice(e.message,true);}
  }
  function switchUser(){
    if(window.Store?.busy.size||window.Store?.hasPending()){
      window.Store?.notice('Hay una operación sin confirmar. Termínela o use «Reintentar operación pendiente» antes de cambiar de usuario.',true);return;
    }
    try{sessionStorage.setItem(PICK,'1');}catch{}
    Access.logout();
  }

  // ----- Integración con Access -----
  function onLocked(){
    let requested=false;try{requested=sessionStorage.getItem(PICK)==='1';sessionStorage.removeItem(PICK);}catch{}
    if(inRecovery())return;
    if(accounts().length){mode('pick');Access.showAuth();}
    else if(requested){mode('password');Access.showAuth();}
  }
  async function afterEnter(context,viaPassword){
    session=context;
    if(Access.health?.quick_access_v2!==true){updateProfile();return;}
    if(viaPassword){
      // Ingresar con contraseña habilita este equipo para el código de la persona.
      let info=null;
      try{const d=device();info=await Access.rpc('store_device_trust',{p_device:d.device_id,p_secret:d.secret});}catch{}
      if(info?.trusted&&info.has_pin){try{remember({user_id:context.user_id,email:context.email});}catch{}}
      else if(info?.trusted){forgetLocal(context.user_id);if(!skipped(context.user_id))openSetup();}
    }else if(isRemembered(context.user_id)){
      try{remember({user_id:context.user_id,email:context.email});}catch{}
      // Si el código se desactivó o el equipo se quitó desde otro lugar, se retira de la lista local.
      const d=load();
      try{if(d&&await Access.rpc('store_pin_status',{p_device:d.device_id,p_secret:d.secret})===false)forgetLocal(context.user_id);}catch{}
    }
    updateProfile();
  }
  function updateAlias(alias){
    if(!session||!isRemembered(session.user_id))return;
    try{remember({user_id:session.user_id,email:session.email,alias:String(alias||'')});}catch{}
  }

  document.addEventListener('DOMContentLoaded',()=>{
    $('quickAccounts').addEventListener('click',e=>{
      const f=e.target.closest('[data-forget]');if(f)return void forget(f.dataset.forget);
      const p=e.target.closest('[data-user]');if(p)choose(p.dataset.user);
    });
    $('quickUsePassword').addEventListener('click',()=>toPassword(''));
    $('quickBackToList').addEventListener('click',()=>{$('authStatus').textContent='';mode('pick');});
    $('quickBack').addEventListener('click',()=>{selected=null;mode('pick');});
    $('quickPin').addEventListener('input',()=>{
      const el=$('quickPin'),clean=el.value.replace(/\D/g,'').slice(0,4);if(el.value!==clean)el.value=clean;
      if(clean.length===4)void submitPin();
    });
    $('quickPinForm').addEventListener('submit',e=>{e.preventDefault();void submitPin();});
    $('quickPinForm').addEventListener('click',e=>{
      const key=e.target.closest('[data-key]');if(!key||busy)return;
      const el=$('quickPin'),k=key.dataset.key;
      if(k==='del')el.value=el.value.slice(0,-1);else if(k==='clear')el.value='';else if(el.value.length<4)el.value+=k;
      status('');el.dispatchEvent(new Event('input'));
    });
    $('publicLogin').addEventListener('click',()=>mode(accounts().length?'pick':'password'));
    $('authDialog').addEventListener('close',()=>{$('quickPin').value='';status('');});
    $('pinSetupForm').addEventListener('submit',e=>{e.preventDefault();void saveSetup();});
    $('pinSetupSkip').addEventListener('click',()=>{if(session)setSkipped(session.user_id,true);closeSetup();updateProfile();});
    for(const id of ['pinSetupPin','pinSetupConfirm'])$(id).addEventListener('input',e=>{e.target.value=e.target.value.replace(/\D/g,'').slice(0,4);});
    $('quickProfileSet').addEventListener('click',openSetup);
    $('quickProfileRemove').addEventListener('click',()=>void removeHere());
    $('authSwitch').addEventListener('click',switchUser);
  });
  return {onLocked,afterEnter,updateAlias,accounts};
})();
