import { getOrganizationForUser, getSupabaseAdmin, requireOrganizationForUser, supabaseErrorMessage } from "./supabase";

// Legacy Manus OAuth modules remain in the repository for rollback compatibility,
// but the active request context no longer calls them. These no-op shims prevent
// an unused legacy import from becoming an authentication path again.
export async function upsertUser(_user: { openId: string; [key: string]: unknown }): Promise<void> {}
export async function getUserByOpenId(_openId: string): Promise<any> { return undefined; }

export type WorkspaceSession = {
  id: string;
  organizationId: string;
  provider: string;
  instanceName: string;
  status: "disconnected" | "connecting" | "connected" | "error";
  phoneNumber: string | null;
  profileName: string | null;
  authStorageKey: string | null;
  qrCode: string | null;
  qrExpiresAt: Date | null;
  errorMessage: string | null;
  lastSyncAt: Date | null;
  connectedAt: Date | null;
};

export type WorkspaceAgent = {
  id: string;
  organizationId: string;
  name: string;
  personality: string;
  tone: string;
  formality: string;
  instructions: string;
  guardrails: string;
  blockedPhrases: string;
  model: string;
  enabled: boolean;
};

function date(value: string | null | undefined) { return value ? new Date(value) : null; }

function mapSession(row: any): WorkspaceSession {
  return {
    id: row.id,
    organizationId: row.organization_id,
    provider: row.provider,
    instanceName: row.instance_name,
    status: row.status,
    phoneNumber: row.phone_number ?? null,
    profileName: row.profile_name ?? null,
    authStorageKey: row.auth_storage_key ?? null,
    qrCode: row.qr_code ?? null,
    qrExpiresAt: date(row.qr_expires_at),
    errorMessage: row.error_message ?? null,
    lastSyncAt: date(row.last_sync_at),
    connectedAt: date(row.connected_at),
  };
}

function mapAgent(row: any): WorkspaceAgent {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    personality: row.personality,
    tone: row.tone,
    formality: row.formality,
    instructions: row.instructions,
    guardrails: row.guardrails,
    blockedPhrases: row.blocked_phrases,
    model: row.model,
    enabled: row.enabled,
  };
}

function mapSettings(row: any) {
  return row ? {
    id: row.id,
    organizationId: row.organization_id,
    autoReplyEnabled: row.auto_reply_enabled,
    globalPaused: row.global_paused,
    dailyOutboundLimit: row.daily_outbound_limit,
    minOutboundIntervalSeconds: row.min_outbound_interval_seconds,
    requireContactOptIn: row.require_contact_opt_in,
  } : null;
}

export async function getDb() { return getSupabaseAdmin(); }

export async function ensureWorkspace(userId: string) {
  const scope = await getOrganizationForUser(userId);
  if (!scope) return null;
  const supabase = getSupabaseAdmin();
  const organizationId = scope.organizationId;

  const { data: agent } = await supabase.from("ai_agents").select("*").eq("organization_id", organizationId).limit(1).maybeSingle();
  if (!agent) {
    const { error } = await supabase.from("ai_agents").insert({ organization_id: organizationId });
    if (error) throw error;
  }
  const { data: settings } = await supabase.from("ai_settings").select("*").eq("organization_id", organizationId).limit(1).maybeSingle();
  if (!settings) {
    const { error } = await supabase.from("ai_settings").insert({ organization_id: organizationId });
    if (error) throw error;
  }
  const { data: session } = await supabase.from("whatsapp_connections").select("*").eq("organization_id", organizationId).limit(1).maybeSingle();
  if (!session) {
    const { error } = await supabase.from("whatsapp_connections").insert({ organization_id: organizationId, instance_name: `turnstark-${organizationId.slice(0, 8)}`, provider: "baileys" });
    if (error) throw error;
  }
  return { organizationId, role: scope.role };
}

export async function getWorkspace(userId: string) {
  const scope = await getOrganizationForUser(userId);
  if (!scope) return null;
  await ensureWorkspace(userId);
  const supabase = getSupabaseAdmin();
  const [{ data: session }, { data: agent }, { data: settings }] = await Promise.all([
    supabase.from("whatsapp_connections").select("*").eq("organization_id", scope.organizationId).limit(1).maybeSingle(),
    supabase.from("ai_agents").select("*").eq("organization_id", scope.organizationId).limit(1).maybeSingle(),
    supabase.from("ai_settings").select("*").eq("organization_id", scope.organizationId).limit(1).maybeSingle(),
  ]);
  return {
    organization: scope.organization,
    organizationId: scope.organizationId,
    role: scope.role,
    session: session ? mapSession(session) : null,
    agent: agent ? mapAgent(agent) : null,
    settings: mapSettings(settings),
  };
}

export async function getConversations(userId: string) {
  const { organizationId } = await requireOrganizationForUser(userId);
  const supabase = getSupabaseAdmin();
  const { data: rows, error } = await supabase.from("conversations").select("*").eq("organization_id", organizationId).order("last_message_at", { ascending: false, nullsFirst: false }).order("updated_at", { ascending: false });
  if (error) throw error;
  const contactIds = (rows ?? []).map(row => row.contact_id);
  const { data: contacts } = contactIds.length ? await supabase.from("contacts").select("*").eq("organization_id", organizationId).in("id", contactIds) : { data: [] };
  const result = [];
  for (const row of rows ?? []) {
    const { data: lastMessage } = await supabase.from("messages").select("*").eq("organization_id", organizationId).eq("conversation_id", row.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    result.push({
      id: row.id,
      organizationId: row.organization_id,
      contactId: row.contact_id,
      status: row.status,
      unreadCount: row.unread_count,
      lastMessageAt: date(row.last_message_at),
      updatedAt: date(row.updated_at),
      contact: (contacts ?? []).find(contact => contact.id === row.contact_id) ?? null,
      lastMessage: lastMessage ? { ...lastMessage, text: lastMessage.content, createdAt: date(lastMessage.created_at) } : null,
    });
  }
  return result;
}

export async function getConversationMessages(userId: string, conversationId: string) {
  const { organizationId } = await requireOrganizationForUser(userId);
  const { data: rows, error } = await getSupabaseAdmin().from("messages").select("*").eq("organization_id", organizationId).eq("conversation_id", conversationId).order("created_at");
  if (error) throw error;
  return (rows ?? []).map(row => ({ ...row, text: row.content, createdAt: date(row.created_at), externalId: row.external_id, aiGenerated: row.ai_generated }));
}

export async function getRecentLogs(userId: string) {
  const { organizationId } = await requireOrganizationForUser(userId);
  const { data, error } = await getSupabaseAdmin().from("system_logs").select("*").eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(40);
  if (error) throw error;
  return data ?? [];
}

export async function getKnowledgeItems(userId: string) {
  const { organizationId } = await requireOrganizationForUser(userId);
  const { data, error } = await getSupabaseAdmin().from("knowledge_items").select("*").eq("organization_id", organizationId).order("updated_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map(item => ({ ...item, organizationId: item.organization_id, storageKey: item.storage_path, storageUrl: item.storage_path, mimeType: item.mime_type, fileName: item.file_name, fileSize: item.file_size }));
}

export async function addSystemLog(userId: string, event: string, detail?: string, level: "info" | "warning" | "error" = "info") {
  const { organizationId } = await requireOrganizationForUser(userId);
  const { error } = await getSupabaseAdmin().from("system_logs").insert({ organization_id: organizationId, event, detail: detail ?? null, level });
  if (error) throw error;
}

export async function getCounts(userId: string) {
  const { organizationId } = await requireOrganizationForUser(userId);
  const supabase = getSupabaseAdmin();
  const [{ data: allMessages }, { data: active }] = await Promise.all([
    supabase.from("messages").select("direction, ai_generated").eq("organization_id", organizationId),
    supabase.from("conversations").select("id").eq("organization_id", organizationId).eq("status", "active"),
  ]);
  return {
    received: (allMessages ?? []).filter(message => message.direction === "inbound").length,
    aiReplies: (allMessages ?? []).filter(message => message.ai_generated).length,
    activeConversations: (active ?? []).length,
  };
}

export async function updateConnection(userId: string, values: Record<string, unknown>) {
  const { organizationId } = await requireOrganizationForUser(userId);
  const { data, error } = await getSupabaseAdmin().from("whatsapp_connections").update(values).eq("organization_id", organizationId).select("*").single();
  if (error) throw new Error(supabaseErrorMessage(error));
  return mapSession(data);
}

export async function getConnection(userId: string) {
  const { organizationId } = await requireOrganizationForUser(userId);
  const { data, error } = await getSupabaseAdmin().from("whatsapp_connections").select("*").eq("organization_id", organizationId).limit(1).maybeSingle();
  if (error) throw error;
  return data ? mapSession(data) : null;
}

export { mapSession, mapAgent, mapSettings };
export { requireOrganizationForUser };
