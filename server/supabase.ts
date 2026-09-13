import { createClient, type SupabaseClient, type User as SupabaseUser } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

let adminClient: SupabaseClient | null = null;

export function getSupabaseAdmin() {
  if (!url || !serviceRoleKey) throw new Error("Supabase server configuration is missing.");
  if (!adminClient) {
    adminClient = createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return adminClient;
}

export type AuthenticatedSupabaseUser = SupabaseUser;

export async function getAuthenticatedSupabaseUser(accessToken: string) {
  const { data, error } = await getSupabaseAdmin().auth.getUser(accessToken);
  if (error || !data.user) return null;
  return data.user;
}

export async function getOrganizationForUser(userId: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("memberships")
    .select("organization_id, role, organizations(*)")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const organization = Array.isArray(data.organizations) ? data.organizations[0] : data.organizations;
  return { organization, organizationId: data.organization_id as string, role: data.role as string };
}

export async function requireOrganizationForUser(userId: string) {
  const result = await getOrganizationForUser(userId);
  if (!result?.organizationId) throw new Error("Organização não configurada. Conclua o onboarding.");
  return result;
}

export function supabaseErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
