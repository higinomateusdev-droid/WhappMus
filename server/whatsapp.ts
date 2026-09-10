import { and, desc, eq } from "drizzle-orm";
import { invokeLLM } from "./_core/llm";
import { addSystemLog, aiAgents, aiLogs, aiSettings, contacts, conversations, ensureWorkspace, getDb, messages, systemLogs, whatsappSessions } from "./db";

export type WhatsAppConfig = {
  apiUrl: string;
  apiKey: string;
  instanceName: string;
  webhookSecret: string;
  provider: string;
  webhookUrl: string;
};

const QR_TTL_MS = 60_000;

export function getWhatsAppConfig(): WhatsAppConfig {
  const appUrl = process.env.PUBLIC_APP_URL || "";
  return {
    apiUrl: process.env.WHATSAPP_API_URL ?? "",
    apiKey: process.env.WHATSAPP_API_KEY ?? "",
    instanceName: process.env.WHATSAPP_INSTANCE_NAME ?? "",
    webhookSecret: process.env.WHATSAPP_WEBHOOK_SECRET ?? "",
    provider: "evolution",
    webhookUrl: appUrl ? `${appUrl.replace(/\/$/, "")}/api/whatsapp/webhook` : "",
  };
}

export function getMissingWhatsAppConfig() {
  const config = getWhatsAppConfig();
  const required: Array<[keyof WhatsAppConfig, string]> = [
    ["apiUrl", "WHATSAPP_API_URL"],
    ["apiKey", "WHATSAPP_API_KEY"],
    ["instanceName", "WHATSAPP_INSTANCE_NAME"],
    ["webhookUrl", "PUBLIC_APP_URL"],
    ["webhookSecret", "WHATSAPP_WEBHOOK_SECRET"],
  ];
  return required.filter(([key]) => !config[key]).map(([, envName]) => envName);
}

function normalizeBaseUrl(url: string) { return url.replace(/\/$/, ""); }

async function evolutionRequest(path: string, init: RequestInit = {}) {
  const config = getWhatsAppConfig();
  if (!config.apiUrl || !config.apiKey) throw new Error("Evolution API URL ou API Key ausente no ambiente do servidor.");
  const response = await fetch(`${normalizeBaseUrl(config.apiUrl)}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", apikey: config.apiKey, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(body?.message || body?.error || `Evolution API retornou HTTP ${response.status}`);
  return body;
}

function extractQrCode(payload: any): string | null {
  const value = payload?.base64 || payload?.qrcode?.base64 || payload?.qrcode || payload?.qr || payload?.code;
  if (!value || typeof value !== "string") return null;
  return value.startsWith("data:") ? value : value.length > 100 ? `data:image/png;base64,${value}` : null;
}

function extractOwner(payload: any) {
  return payload?.instance?.ownerJid || payload?.ownerJid || payload?.data?.ownerJid || payload?.jid || null;
}

function extractProfileName(payload: any) {
  return payload?.instance?.profileName || payload?.profileName || payload?.data?.profileName || payload?.instance?.profile?.name || null;
}

function stateFromPayload(payload: any) {
  return String(payload?.instance?.state || payload?.state || payload?.instance?.status || payload?.status || "").toLowerCase();
}

async function configureWebhook(instanceName: string) {
  const config = getWhatsAppConfig();
  if (!config.webhookUrl || !config.webhookSecret) throw new Error("Webhook público ou segredo ausente; configure PUBLIC_APP_URL e WHATSAPP_WEBHOOK_SECRET.");
  return evolutionRequest(`/webhook/set/${encodeURIComponent(instanceName)}`, {
    method: "POST",
    body: JSON.stringify({
      webhook: {
        enabled: true,
        url: config.webhookUrl,
        byEvents: false,
        base64: true,
        events: ["QRCODE_UPDATED", "CONNECTION_UPDATE", "MESSAGES_UPSERT", "MESSAGES_UPDATE", "SEND_MESSAGE"],
        headers: { "x-webhook-secret": config.webhookSecret },
      },
    }),
  });
}

export async function probeEvolutionApi() {
  const config = getWhatsAppConfig();
  if (!config.apiUrl || !config.apiKey) return { available: false, detail: "WHATSAPP_API_URL e/ou WHATSAPP_API_KEY ausente." };
  try {
    await evolutionRequest("/instance/fetchInstances");
    return { available: true, detail: "API respondeu ao endpoint de instâncias." };
  } catch (error) {
    return { available: false, detail: error instanceof Error ? error.message : "Não foi possível consultar a Evolution API." };
  }
}

export async function getConnectionDiagnostics(userId: number) {
  const db = await getDb();
  const config = getWhatsAppConfig();
  const api = await probeEvolutionApi();
  if (!db) return { api, apiKey: Boolean(config.apiKey), instance: false, webhook: Boolean(config.webhookUrl && config.webhookSecret), session: "disconnected", webhookReceiving: false, ia: Boolean(process.env.BUILT_IN_FORGE_API_KEY), details: ["Banco de dados indisponível."] };
  await ensureWorkspace(userId);
  const [session] = await db.select().from(whatsappSessions).where(eq(whatsappSessions.userId, userId)).limit(1);
  let instance = false;
  let instanceDetail = "Instância não consultada.";
  if (api.available && session) {
    try {
      const instances = await evolutionRequest("/instance/fetchInstances");
      const rows = Array.isArray(instances) ? instances : instances?.instances || instances?.data || [];
      instance = rows.some((item: any) => (item?.name || item?.instance?.instanceName || item?.instanceName) === session.instanceName);
      instanceDetail = instance ? "Instância encontrada na Evolution API." : "Instância ainda não encontrada.";
    } catch (error) { instanceDetail = error instanceof Error ? error.message : "Falha ao consultar instância."; }
  }
  const recentLogs = await db.select().from(systemLogs).where(and(eq(systemLogs.userId, userId), eq(systemLogs.event, "message.received"))).orderBy(desc(systemLogs.createdAt)).limit(1);
  return {
    api,
    apiKey: Boolean(config.apiKey),
    instance,
    instanceDetail,
    webhook: Boolean(config.webhookUrl && config.webhookSecret),
    webhookUrl: config.webhookUrl || null,
    session: session?.status || "disconnected",
    webhookReceiving: recentLogs.length > 0,
    ia: Boolean(process.env.BUILT_IN_FORGE_API_KEY),
    qrExpiresAt: session?.qrExpiresAt || null,
  };
}

export async function connectWhatsApp(userId: number) {
  const db = await getDb();
  if (!db) return { status: "error" as const, message: "Banco de dados indisponível." };
  await ensureWorkspace(userId);
  const [session] = await db.select().from(whatsappSessions).where(eq(whatsappSessions.userId, userId)).limit(1);
  const config = getWhatsAppConfig();
  const missing = getMissingWhatsAppConfig();
  if (missing.length) {
    const message = `Dependência ausente no backend: ${missing.join(", ")}. O QR só pode ser produzido por uma sessão real da Evolution API.`;
    await db.update(whatsappSessions).set({ status: "error", errorMessage: message, qrCode: null, qrExpiresAt: null }).where(eq(whatsappSessions.userId, userId));
    await addSystemLog(userId, "whatsapp.configuration_missing", message, "warning");
    return { status: "needs_configuration" as const, missing, message };
  }
  const instance = config.instanceName || session?.instanceName;
  try {
    await db.update(whatsappSessions).set({ status: "connecting", errorMessage: null, qrCode: null, qrExpiresAt: null }).where(eq(whatsappSessions.userId, userId));
    try {
      await evolutionRequest(`/instance/create`, { method: "POST", body: JSON.stringify({ instanceName: instance, integration: "WHATSAPP-BAILEYS", qrcode: true, webhook: config.webhookUrl ? { url: config.webhookUrl, enabled: true } : undefined }) });
    } catch (error) {
      const text = String(error).toLowerCase();
      if (!text.includes("already") && !text.includes("409") && !text.includes("exists")) throw error;
    }
    await configureWebhook(instance);
    let payload: any;
    try {
      payload = await evolutionRequest(`/instance/connect/${encodeURIComponent(instance)}`, { method: "POST" });
    } catch (error) {
      const text = String(error).toLowerCase();
      if (!text.includes("405") && !text.includes("method not allowed")) throw error;
      payload = await evolutionRequest(`/instance/connect/${encodeURIComponent(instance)}`);
    }
    const qrCode = extractQrCode(payload);
    const state = stateFromPayload(payload);
    const owner = extractOwner(payload);
    const connected = state === "open" || state === "connected";
    const now = new Date();
    if (connected) {
      await db.update(whatsappSessions).set({ status: "connected", phoneNumber: owner ? owner.split("@")[0] : null, profileName: extractProfileName(payload), connectedAt: now, lastSyncAt: now, qrCode: null, qrExpiresAt: null }).where(eq(whatsappSessions.userId, userId));
      await addSystemLog(userId, "whatsapp.connected", "Sessão autenticada pela Evolution API.");
      return { status: "connected" as const, qrCode: null, qrExpiresAt: null };
    }
    const expiresAt = new Date(Date.now() + QR_TTL_MS);
    await db.update(whatsappSessions).set({ status: "connecting", qrCode, qrExpiresAt: qrCode ? expiresAt : null }).where(eq(whatsappSessions.userId, userId));
    await addSystemLog(userId, "whatsapp.qr_requested", qrCode ? "QR Code real recebido da Evolution API." : "Evolution API não retornou QR Code.", qrCode ? "info" : "warning");
    return { status: "connecting" as const, qrCode, qrExpiresAt: expiresAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha ao conectar à Evolution API.";
    await db.update(whatsappSessions).set({ status: "error", errorMessage: message, qrCode: null, qrExpiresAt: null }).where(eq(whatsappSessions.userId, userId));
    await addSystemLog(userId, "whatsapp.connection_error", message, "error");
    return { status: "error" as const, message };
  }
}

export async function refreshWhatsAppStatus(userId: number) {
  const db = await getDb();
  if (!db) return { status: "error" as const, message: "Banco de dados indisponível." };
  const [session] = await db.select().from(whatsappSessions).where(eq(whatsappSessions.userId, userId)).limit(1);
  if (!session || getMissingWhatsAppConfig().some(item => item.includes("WHATSAPP_API"))) return { status: session?.status || "disconnected" };
  try {
    const payload = await evolutionRequest(`/instance/connectionState/${encodeURIComponent(session.instanceName)}`);
    const state = stateFromPayload(payload);
    const connected = state === "open" || state === "connected";
    const expired = Boolean(session.qrExpiresAt && session.qrExpiresAt.getTime() <= Date.now());
    const status = connected ? "connected" : expired ? "error" : state.includes("close") || state.includes("disconnect") ? "disconnected" : "connecting";
    await db.update(whatsappSessions).set({ status, lastSyncAt: new Date(), qrCode: expired ? null : session.qrCode, qrExpiresAt: expired ? null : session.qrExpiresAt, errorMessage: expired ? "QR Code expirado. Gere um novo QR Code." : null }).where(eq(whatsappSessions.id, session.id));
    if (connected && session.status !== "connected") await addSystemLog(userId, "whatsapp.connected", "Conexão detectada por consulta de estado.");
    if (expired && session.status === "connecting") await addSystemLog(userId, "whatsapp.qr_expired", "QR Code expirou antes do pareamento.", "warning");
    return { status, expired };
  } catch (error) { return { status: session.status, error: error instanceof Error ? error.message : "Falha ao consultar estado." }; }
}

export async function disconnectWhatsApp(userId: number) {
  const db = await getDb();
  if (!db) return { success: false, message: "Banco de dados indisponível." };
  const [session] = await db.select().from(whatsappSessions).where(eq(whatsappSessions.userId, userId)).limit(1);
  try { if (session && getMissingWhatsAppConfig().filter(item => item.includes("WHATSAPP_API")).length === 0) await evolutionRequest(`/instance/logout/${encodeURIComponent(session.instanceName)}`, { method: "DELETE" }); }
  catch (error) { await addSystemLog(userId, "whatsapp.disconnect_error", String(error), "warning"); }
  await db.update(whatsappSessions).set({ status: "disconnected", qrCode: null, qrExpiresAt: null, phoneNumber: null, profileName: null, connectedAt: null, errorMessage: null }).where(eq(whatsappSessions.userId, userId));
  await addSystemLog(userId, "whatsapp.disconnected", "Sessão encerrada pelo painel.");
  return { success: true };
}

export async function sendWhatsAppMessage(userId: number, to: string, text: string) {
  const config = getWhatsAppConfig();
  if (getMissingWhatsAppConfig().filter(item => item.includes("WHATSAPP_API")).length) return { sent: false, reason: "configuration_missing" as const };
  const db = await getDb();
  if (!db) return { sent: false, reason: "database_unavailable" as const };
  const [session] = await db.select().from(whatsappSessions).where(eq(whatsappSessions.userId, userId)).limit(1);
  if (!session || session.status !== "connected") return { sent: false, reason: "not_connected" as const };
  await evolutionRequest(`/message/sendText/${encodeURIComponent(config.instanceName || session.instanceName)}`, { method: "POST", body: JSON.stringify({ number: to.replace(/\D/g, ""), text }) });
  return { sent: true as const };
}

function messageTextFromPayload(payload: any) { return payload?.message?.conversation || payload?.message?.extendedTextMessage?.text || payload?.message?.imageMessage?.caption || payload?.text || ""; }

export async function handleWhatsAppWebhook(payload: any) {
  const db = await getDb();
  if (!db) return { accepted: false, reason: "database_unavailable" };
  const event = String(payload?.event || payload?.type || "").toLowerCase();
  const data = payload?.data || payload;
  const instanceName = payload?.instance || payload?.instanceName || data?.instance || data?.key?.remoteJid?.split("@")[0];
  if (event.includes("connection") || event.includes("qrcode") || event.includes("qr_code")) {
    const [session] = await db.select().from(whatsappSessions).where(eq(whatsappSessions.instanceName, instanceName)).limit(1);
    if (session) {
      const state = stateFromPayload(data);
      const connected = state === "open" || state === "connected";
      const qrCode = extractQrCode(data);
      await db.update(whatsappSessions).set({ status: connected ? "connected" : qrCode ? "connecting" : session.status, connectedAt: connected ? new Date() : null, lastSyncAt: new Date(), phoneNumber: extractOwner(data)?.split("@")[0] || session.phoneNumber, profileName: extractProfileName(data) || session.profileName, qrCode: connected ? null : qrCode, qrExpiresAt: connected || !qrCode ? null : new Date(Date.now() + QR_TTL_MS), errorMessage: null }).where(eq(whatsappSessions.id, session.id));
      await addSystemLog(session.userId, connected ? "whatsapp.connected" : qrCode ? "whatsapp.qr_updated" : "whatsapp.connection_update", state || "Evento de sessão recebido.");
    }
    return { accepted: true, kind: "connection" };
  }
  if (!event.includes("message")) return { accepted: true, kind: "ignored" };
  const key = data?.key || {};
  if (key.fromMe || data?.fromMe) return { accepted: true, kind: "self_message_ignored" };
  const waId = key.remoteJid || data?.sender || data?.from || payload?.from;
  const text = messageTextFromPayload(data);
  const externalId = key.id || data?.id || payload?.id;
  if (!instanceName || !waId || !text) return { accepted: true, kind: "empty_message" };
  const [session] = await db.select().from(whatsappSessions).where(eq(whatsappSessions.instanceName, instanceName)).limit(1);
  if (!session) return { accepted: false, reason: "unknown_instance" };
  if (externalId) { const [duplicate] = await db.select().from(messages).where(and(eq(messages.userId, session.userId), eq(messages.externalId, externalId))).limit(1); if (duplicate) return { accepted: true, kind: "duplicate_ignored" }; }
  let [contact] = await db.select().from(contacts).where(and(eq(contacts.userId, session.userId), eq(contacts.waId, waId))).limit(1);
  if (!contact) { const result = await db.insert(contacts).values({ userId: session.userId, waId, phoneNumber: waId.split("@")[0], name: data?.pushName || data?.notifyName || null }); [contact] = await db.select().from(contacts).where(eq(contacts.id, Number(result[0]?.insertId))).limit(1); }
  if (!contact) return { accepted: false, reason: "contact_persist_failed" };
  let [conversation] = await db.select().from(conversations).where(and(eq(conversations.userId, session.userId), eq(conversations.contactId, contact.id), eq(conversations.status, "active"))).limit(1);
  if (!conversation) { const result = await db.insert(conversations).values({ userId: session.userId, contactId: contact.id, lastMessageAt: new Date() }); [conversation] = await db.select().from(conversations).where(eq(conversations.id, Number(result[0]?.insertId))).limit(1); }
  if (!conversation) return { accepted: false, reason: "conversation_persist_failed" };
  await db.insert(messages).values({ userId: session.userId, conversationId: conversation.id, externalId, direction: "inbound", sender: waId, text, status: "received" });
  await db.update(conversations).set({ lastMessageAt: new Date(), unreadCount: conversation.unreadCount + 1 }).where(eq(conversations.id, conversation.id));
  await addSystemLog(session.userId, "message.received", `${waId}: ${text}`);
  const [settings] = await db.select().from(aiSettings).where(eq(aiSettings.userId, session.userId)).limit(1);
  const [agent] = await db.select().from(aiAgents).where(eq(aiAgents.userId, session.userId)).limit(1);
  if (!settings?.autoReplyEnabled || settings.globalPaused || !agent?.enabled) return { accepted: true, kind: "stored_without_reply" };
  const context = await db.select().from(messages).where(and(eq(messages.userId, session.userId), eq(messages.conversationId, conversation.id))).orderBy(desc(messages.createdAt)).limit(12);
  const started = Date.now();
  try {
    const completion = await invokeLLM({ messages: [{ role: "system", content: `${agent.name} é um agente de WhatsApp. Personalidade: ${agent.personality}. Tom: ${agent.tone}. Formalidade: ${agent.formality}. Instruções: ${agent.instructions}. Regras: ${agent.guardrails}. Nunca envie: ${agent.blockedPhrases || "nada especificado"}. Responda apenas com a mensagem final, sem prefácio.` }, ...context.reverse().map(item => ({ role: item.direction === "inbound" ? "user" as const : "assistant" as const, content: item.text }))] });
    const responseText = typeof completion.choices[0]?.message.content === "string" ? completion.choices[0].message.content : "Não consegui gerar uma resposta agora.";
    const sendResult = await sendWhatsAppMessage(session.userId, waId, responseText);
    const inserted = await db.insert(messages).values({ userId: session.userId, conversationId: conversation.id, direction: "outbound", sender: "ai", text: responseText, aiGenerated: true, status: sendResult.sent ? "sent" : "failed" });
    await db.insert(aiLogs).values({ userId: session.userId, conversationId: conversation.id, messageId: Number(inserted[0]?.insertId), model: completion.model, response: responseText, latencyMs: Date.now() - started, status: sendResult.sent ? "success" : "error" });
    await addSystemLog(session.userId, sendResult.sent ? "response.sent" : "ai.response_created", responseText, sendResult.sent ? "info" : "warning");
    return { accepted: true, kind: sendResult.sent ? "replied" : "reply_saved_not_sent" };
  } catch (error) { await db.insert(aiLogs).values({ userId: session.userId, conversationId: conversation.id, model: agent.model, response: String(error), latencyMs: Date.now() - started, status: "error" }); await addSystemLog(session.userId, "ai.error", String(error), "error"); return { accepted: true, kind: "ai_error" }; }
}

export function verifyWebhookToken(token: string | undefined) { const configured = getWhatsAppConfig().webhookSecret; return Boolean(configured && token && configured === token); }
export const isWhatsAppConfigured = () => getMissingWhatsAppConfig().length === 0;
