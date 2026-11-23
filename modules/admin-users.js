/* Administración de cuentas: solicitudes de acceso, crear cuentas y cambiar contraseñas.
   Las acciones las ejecuta la Edge Function admin-users, que comprueba access.manage en la base. */
window.AdminUsers=(()=>{
  const $=id=>document.getElementById(id);
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const dateFormat=new Intl.DateTimeFormat('es-BO',{timeZone:'America/La_Paz',dateStyle:'medium',timeStyle:'short'});
  let roles=[];
  const notice=(message,error=false)=>window.Store?.notice(message,error);

  async function call(body){
    const {data,error}=await window.supabase.functions.invoke('admin-users',{body});
    if(error){
      const status=error.context?.status;
      if(status===404)throw Error('Falta publicar la función admin-users en Supabase. Vea el README.');
      if(status===401||status===403)throw Error('La función admin-users tiene activada la verificación JWT. Desactívela en Supabase.');
      if(error.name==='FunctionsFetchError')throw Error('Sin conexión con el servidor. Revise internet e intente de nuevo.');
      let message='No se pudo completar la acción.';
      try{const detail=await error.context?.json?.();if(detail?.message)message=detail.message;}catch{}
      throw Error(message);
    }
    if(!data?.ok)throw Error(data?.message||'No se pudo completar la acción.');
    return data;
  }
  const roleOptions=(selected='Vendedor')=>roles.map(r=>`<option value="${esc(r.name)}" ${r.name===selected?'selected':''}>${esc(r.name)}</option>`).join('');
  async function busy(button,task){
    button.disabled=true;button.classList.add('is-busy');
    try{await task();}catch(e){notice(e.message||'No se pudo completar la acción.',true);}
    finally{button.disabled=false;button.classList.remove('is-busy');}
  }

  async function render(roleList){
    roles=Array.isArray(roleList)?roleList:[];
    const select=$('accountRole');
    if(select){const current=select.value;select.innerHTML=roleOptions(current||'Vendedor');}
    const body=$('requestsBody');if(!body)return;
    try{
      const list=await Access.rpc('store_access_requests');
      body.innerHTML=list.length?list.map(r=>`<tr>
        <td>${esc(r.email)}</td>
        <td>${esc(dateFormat.format(new Date(r.requested_at)))}</td>
        <td>${r.confirmed?'Confirmado':'<span class="badge badge-alert">Sin confirmar</span>'}</td>
        <td><select aria-label="Rol para ${esc(r.email)}">${roleOptions()}</select></td>
        <td><button type="button" class="primary" data-approve="${esc(r.user_id)}" data-email="${esc(r.email)}">Aprobar</button></td>
      </tr>`).join(''):'<tr><td colspan="5">No hay solicitudes pendientes.</td></tr>';
    }catch(e){
      body.innerHTML=`<tr><td colspan="5">${esc(/function|schema cache/i.test(e.message)?'Falta aplicar migrations/010_admin_accounts.sql en Supabase.':'No se pudieron cargar las solicitudes. '+e.message)}</td></tr>`;
    }
  }

  function generatePassword(){
    const chars='abcdefghjkmnpqrstuvwxyz23456789',bytes=crypto.getRandomValues(new Uint8Array(12));
    const raw=Array.from(bytes,b=>chars[b%chars.length]).join('');
    return raw.slice(0,4)+'-'+raw.slice(4,8)+'-'+raw.slice(8);
  }

  document.addEventListener('DOMContentLoaded',()=>{
    $('requestsBody')?.addEventListener('click',e=>{
      const b=e.target.closest('[data-approve]');if(!b)return;
      const role=b.closest('tr').querySelector('select').value;
      if(!confirm(`¿Dar acceso a ${b.dataset.email} con el rol «${role}»?`))return;
      void busy(b,async()=>{await call({action:'approve',user_id:b.dataset.approve,role});notice('Acceso aprobado. La persona ya puede ingresar con su correo y contraseña.');await Access.renderAdmin();});
    });
    $('accountGenerate')?.addEventListener('click',()=>{$('accountPassword').value=generatePassword();});
    $('accountCreateForm')?.addEventListener('submit',e=>{
      e.preventDefault();
      const form=e.currentTarget,email=$('accountEmail').value.trim(),password=$('accountPassword').value,role=$('accountRole').value;
      if(!form.reportValidity())return;
      if(password.length<12){notice('La contraseña debe tener al menos 12 caracteres.',true);return;}
      void busy($('accountCreate'),async()=>{
        await call({action:'create',email,password,role});
        $('accountStatus').textContent=`Cuenta creada: ${email} · contraseña: ${password}. Entréguela a la persona; al ingresar podrá crear su código de 4 números.`;
        form.reset();notice('Cuenta creada con acceso activo.');await Access.renderAdmin();
      });
    });
    $('membersBody')?.addEventListener('click',e=>{
      const b=e.target.closest('[data-password]');if(!b)return;
      const password=prompt(`Nueva contraseña para ${b.dataset.email} (mínimo 12 caracteres):`,generatePassword());
      if(password===null)return;
      if(password.length<12||password.length>72){notice('La contraseña debe tener entre 12 y 72 caracteres.',true);return;}
      void busy(b,async()=>{await call({action:'password',user_id:b.dataset.password,password});notice(`Contraseña actualizada para ${b.dataset.email}. Entréguela a la persona.`);});
    });
  });
  return {render,call};
})();
