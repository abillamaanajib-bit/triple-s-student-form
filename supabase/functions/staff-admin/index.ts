// Staff account management for the TRIPLE S dashboard (admin/ -> Team).
// Deploy from the Supabase dashboard: Edge Functions -> Deploy a new function ->
// Via Editor, name it "staff-admin", paste this whole file, Deploy function.
//
// Creating or removing accounts needs the project's secret key, which must
// never reach a web page, so it only lives here. Every request is checked:
// the caller must be signed in and listed in public.dashboard_admins
// (supabase/team-admins.sql), and new accounts must be @triple-s.me addresses.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const STAFF_DOMAIN = "@triple-s.me";
const MIN_PASSWORD = 8;
const ALLOWED_ORIGINS = ["https://abillamaanajib-bit.github.io", "http://localhost:8123"];

// Supabase provides these to every function. Prefer the new secret keys; fall
// back to the legacy service_role key on older projects.
const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
const secretKey = secretKeys.default ?? Object.values(secretKeys)[0] ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const admin = createClient(Deno.env.get("SUPABASE_URL")!, secretKey as string, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// An error whose message is safe to show to the person using the dashboard.
class Problem extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const isStaffEmail = (email: string) => email.toLowerCase().endsWith(STAFF_DOMAIN);

function corsHeaders(req: Request) {
  const origin = req.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

async function requireAdmin(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user?.email) throw new Problem(401, "Your session has expired. Please sign in again.");
  const email = data.user.email.toLowerCase();
  const { data: row } = await admin.from("dashboard_admins").select("email").eq("email", email).maybeSingle();
  if (!isStaffEmail(email) || !row) throw new Problem(403, "Only team admins can manage staff accounts.");
  return data.user;
}

function checkPassword(password: unknown) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) {
    throw new Problem(400, `Passwords need at least ${MIN_PASSWORD} characters.`);
  }
  return password;
}

async function emailOf(userId: unknown) {
  const { data, error } = await admin.auth.admin.getUserById(String(userId));
  if (error || !data.user?.email) throw new Problem(404, "That account no longer exists.");
  return data.user.email.toLowerCase();
}

async function setAdmin(email: string, isAdmin: boolean) {
  const { error } = isAdmin
    ? await admin.from("dashboard_admins").upsert({ email })
    : await admin.from("dashboard_admins").delete().eq("email", email);
  if (error) throw error;
}

async function listTeam() {
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  const { data: admins } = await admin.from("dashboard_admins").select("email");
  const adminEmails = new Set((admins ?? []).map((row) => row.email));
  return data.users
    .map((user) => ({
      id: user.id,
      email: user.email ?? "",
      created_at: user.created_at,
      last_sign_in_at: user.last_sign_in_at ?? null,
      is_admin: adminEmails.has((user.email ?? "").toLowerCase()),
    }))
    .sort((a, b) => a.email.localeCompare(b.email));
}

async function handle(action: string, body: Record<string, unknown>, me: { id: string }) {
  switch (action) {
    case "list":
      return { users: await listTeam() };

    case "create": {
      const email = String(body.email ?? "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+$/.test(email) || !isStaffEmail(email)) {
        throw new Problem(400, `Use an ${STAFF_DOMAIN} email address.`);
      }
      const { error } = await admin.auth.admin.createUser({ email, password: checkPassword(body.password), email_confirm: true });
      if (error) {
        throw new Problem(400, /already/i.test(error.message) ? "An account with that email already exists." : error.message);
      }
      if (body.is_admin === true) await setAdmin(email, true);
      return { ok: true };
    }

    case "set_password": {
      const { error } = await admin.auth.admin.updateUserById(String(body.user_id), { password: checkPassword(body.password) });
      if (error) throw new Problem(400, error.message);
      return { ok: true };
    }

    case "set_admin": {
      if (body.user_id === me.id && body.is_admin !== true) throw new Problem(400, "You can’t remove your own admin access.");
      await setAdmin(await emailOf(body.user_id), body.is_admin === true);
      return { ok: true };
    }

    case "delete": {
      if (body.user_id === me.id) throw new Problem(400, "You can’t remove your own account.");
      const email = await emailOf(body.user_id);
      const { error } = await admin.auth.admin.deleteUser(String(body.user_id));
      if (error) throw new Problem(400, error.message);
      await setAdmin(email, false);
      return { ok: true };
    }

    default:
      throw new Problem(400, "Unknown action.");
  }
}

Deno.serve(async (req) => {
  const headers = { ...corsHeaders(req), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  try {
    if (req.method !== "POST") throw new Problem(405, "Use POST.");
    const me = await requireAdmin(req);
    const body = await req.json().catch(() => ({}));
    return new Response(JSON.stringify(await handle(String(body.action), body, me)), { headers });
  } catch (error) {
    const status = error instanceof Problem ? error.status : 500;
    if (status === 500) console.error(error);
    const message = error instanceof Problem ? error.message : "Something went wrong. Please try again.";
    return new Response(JSON.stringify({ error: message }), { status, headers });
  }
});
