// Edge Function admin-users: administración de cuentas desde Configuración → Usuarios.
// Publicar en Supabase → Edge Functions con el nombre exacto "admin-users" y con
// "Enforce JWT verification" DESACTIVADO (la función valida la sesión por su cuenta).
// No requiere configurar secretos: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY ya existen en Supabase.
//
// Acciones (todas exigen una sesión con permiso access.manage, comprobado en la base de datos):
//  * create   {email, password, role}  crea la cuenta con el correo ya confirmado y le da acceso.
//  * approve  {user_id, role}          confirma el correo de una solicitud y le da acceso.
//  * password {user_id, password}      cambia la contraseña de otra cuenta.
// Nadie puede modificarse a sí mismo ni al administrador principal.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const fail = (message: string) => json({ ok: false, message });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const validPassword = (p: unknown): p is string => typeof p === 'string' && p.length >= 12 && p.length <= 72;
const validRole = (r: unknown): r is string => typeof r === 'string' && r.trim().length >= 2 && r.length <= 50;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail('Método no permitido.');
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return json({ ok: false, message: 'Configuración del servidor incompleta.' }, 500);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // Quién llama: se valida el token de su sesión con Supabase Auth.
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: caller, error: callerError } = await admin.auth.getUser(token);
  if (callerError || !caller?.user) return fail('Sesión no válida. Cierre sesión y vuelva a ingresar.');
  const actor = caller.user.id;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return fail('Solicitud inválida.'); }
  const action = body?.action;

  const authorize = async (target: string | null, role: string | null) => {
    const { data, error } = await admin.rpc('store_admin_authorize', { p_actor: actor, p_target: target, p_role: role });
    if (error) throw new Error(error.message);
    return data as { ok: boolean; message?: string };
  };
  const provision = async (user: string, role: string) => {
    const { data, error } = await admin.rpc('store_admin_provision', { p_actor: actor, p_user: user, p_role: role });
    if (error) throw new Error(error.message);
    return data as { ok: boolean; message?: string };
  };
  const audit = (kind: string, details: Record<string, unknown>) =>
    admin.rpc('store_admin_audit', { p_actor: actor, p_action: kind, p_details: details });

  try {
    if (action === 'create') {
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (!EMAIL.test(email)) return fail('Escriba un correo válido.');
      if (!validPassword(body.password)) return fail('La contraseña debe tener entre 12 y 72 caracteres.');
      if (!validRole(body.role)) return fail('Seleccione un rol.');
      const allowed = await authorize(null, body.role);
      if (!allowed.ok) return json(allowed);
      const { data: created, error } = await admin.auth.admin.createUser({ email, password: body.password, email_confirm: true });
      if (error || !created?.user) {
        const msg = error?.message ?? '';
        if (/already|registered|exists/i.test(msg)) return fail('Ya existe una cuenta con ese correo. Búsquela en Solicitudes de acceso o en Usuarios.');
        if (/password/i.test(msg)) return fail('Supabase rechazó la contraseña: ' + msg);
        return fail('No se pudo crear la cuenta: ' + msg);
      }
      const granted = await provision(created.user.id, body.role).catch((e) => ({ ok: false, message: String(e?.message ?? e) }));
      if (!granted.ok) {
        // Cuenta recién creada y sin uso: se elimina para no dejarla a medias.
        await admin.auth.admin.deleteUser(created.user.id);
        return json(granted);
      }
      await audit('member.create', { user: created.user.id, email, role: body.role });
      return json({ ok: true, user_id: created.user.id });
    }

    if (action === 'approve') {
      if (typeof body.user_id !== 'string' || !UUID.test(body.user_id)) return fail('Solicitud inválida.');
      if (!validRole(body.role)) return fail('Seleccione un rol.');
      const allowed = await authorize(body.user_id, body.role);
      if (!allowed.ok) return json(allowed);
      const { data: target, error } = await admin.auth.admin.getUserById(body.user_id);
      if (error || !target?.user) return fail('La cuenta ya no existe. Actualice la lista.');
      if (!target.user.email_confirmed_at) {
        const { error: confirmError } = await admin.auth.admin.updateUserById(body.user_id, { email_confirm: true });
        if (confirmError) return fail('No se pudo confirmar el correo: ' + confirmError.message);
      }
      return json(await provision(body.user_id, body.role));
    }

    if (action === 'password') {
      if (typeof body.user_id !== 'string' || !UUID.test(body.user_id)) return fail('Solicitud inválida.');
      if (!validPassword(body.password)) return fail('La contraseña debe tener entre 12 y 72 caracteres.');
      const allowed = await authorize(body.user_id, null);
      if (!allowed.ok) return json(allowed);
      const { error } = await admin.auth.admin.updateUserById(body.user_id, { password: body.password });
      if (error) return fail('No se pudo cambiar la contraseña: ' + error.message);
      await audit('member.password', { user: body.user_id });
      return json({ ok: true });
    }

    return fail('Acción no admitida.');
  } catch (e) {
    console.error('admin-users', e);
    return json({ ok: false, message: 'Error del servidor. Intente de nuevo.' }, 500);
  }
});
