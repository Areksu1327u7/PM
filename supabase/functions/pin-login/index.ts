// Edge Function pin-login: ingreso con código de 4 dígitos en un equipo recordado.
// Publicar en Supabase → Edge Functions con el nombre exacto "pin-login" y con
// "Enforce JWT verification" DESACTIVADO (la función hace su propia verificación).
// No requiere configurar secretos: SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY ya existen en Supabase.
//
// Flujo: verifica equipo + código con store_pin_check (intentos limitados en la base) y, si es correcto,
// genera un enlace de un solo uso que el navegador canjea con verifyOtp. Cada ingreso crea una sesión
// nueva e independiente. Nunca devuelve el correo ni datos de la cuenta al navegador.
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, reason: 'invalid' }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, reason: 'invalid' }, 400); }
  const { user_id, device_id, secret, pin } = body ?? {};
  if (typeof user_id !== 'string' || !UUID.test(user_id) || typeof device_id !== 'string' || !UUID.test(device_id) ||
      typeof secret !== 'string' || !/^[0-9a-f]{64}$/.test(secret) || typeof pin !== 'string' || !/^[0-9]{4}$/.test(pin)) {
    return json({ ok: false, reason: 'invalid' }, 400);
  }
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return json({ ok: false, reason: 'server' }, 500);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data, error } = await admin.rpc('store_pin_check', { p_user: user_id, p_device: device_id, p_secret: secret, p_pin: pin });
  if (error) { console.error('store_pin_check', error.message); return json({ ok: false, reason: 'server' }, 500); }
  if (!data?.ok) return json({ ok: false, reason: data?.reason ?? 'unknown', remaining: data?.remaining ?? null });

  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: 'magiclink', email: data.email });
  const tokenHash = link?.properties?.hashed_token;
  if (linkError || !tokenHash) { console.error('generateLink', linkError?.message); return json({ ok: false, reason: 'server' }, 500); }
  return json({ ok: true, token_hash: tokenHash });
});
