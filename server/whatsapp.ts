import { and, desc, eq } from "drizzle-orm";
import { invokeLLM } from "./_core/llm";
import { ENV } from "./_core/env";
import { addSystemLog, aiAgents, aiLogs, aiSettings, contacts, conversations, ensureWorkspace, getDb, messages, whatsappSessions } from "./db";

export type WhatsAppConfig = {
  apiUrl: string;
  apiKey: string;
  instanceName: string;
  webhookSecret: string;
  provider: string;
};

export function getWhatsAppConfig(): WhatsAppConfig {
  return {
    apiUrl: process.env.WHATSAPP_API_URL ?? "",
    apiKey: process.env.WHATSAPP_API_KEY ?? "",
    instanceName: process.env.WHATSAPP_INSTANCE_NAME ?? "",
    webhookSecret: process.env.WHATSAPP_WEBHOOK_SECRET ?? "",
    provider: process.env.WHATSAPP_PROVIDER ?? "evolution",
  };
}

export function getMissingWhatsAppConfig() {
  const config = getWhatsAppConfig();
  const required: Array<[keyof WhatsAppConfig, string]> = [
    ["apiUrl", "WHATSAPP_API_URL"],
    ["apiKey", "WHATSAPP_API_KEY"],
    ["instanceName", "WHATSAPP_INSTANCE_NAME"],
  ];
  return required.filter(([key]) => !config[key]).map(([, envName]) => envName);
}

function normalizeBaseUrl(url: string) {
  return url.replace(/\/$/, "");
}

async function evolutionRequest(path: string, init: RequestInit = {}) {
  const config = getWhatsAppConfig();
  if (!config.apiUrl || !config.apiKey) throw new Error("WhatsApp provider is not configured");
  const response = await fetch(`${normalizeBaseUrl(config.apiUrl)}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      apikey: config.apiKey,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(body?.message || body?.error || `WhatsApp provider returned ${response.status}`);
  return body;
}

function extractQrCode(payload: any): string | null {
  const value = payload?.base64 || payload?.qrcode?.base64 || payload?.qrcode || payload?.qr || payload?.code;
  if (!value || typeof value !== "string") return null;
  return value.startsWith("data:") ? value : value.length > 100 ? `data:image/png;base64,${value}` : null;
}

export async function connectWhatsApp(userId: number) {
  const db = await getDb();
  const missing = getMissingWhatsAppConfig();
  if (!db) return { status: "error" as const, message: "Banco de dados indisponível." };
  await ensureWorkspace(userId);
  const [session] = await db.select().from(whatsappSessions).where(eq(whatsappSessions.userId, userId)).limit(1);
  if (missing.length) {
    await db.update(whatsappSessions).set({ status: "error", errorMessage: `Configuração pendente: ${missing.join(", ")}`, qrCode: null }).where(eq(whatsappSessions.userId, userId));
    await addSystemLog(userId, "whatsapp.configuration_missing", missing.join(", "), "warning");
    return { status: "needs_configuration" as const, missing };
  }
  const instance = getWhatsAppConfig().instanceName || session?.instanceName;
  try {
    await db.update(whatsappSessions).set({ status: "connecting", errorMessage: null, qrCode: null }).where(eq(whatsappSessions.userId, userId));
    // Evolution-compatible adapter. A different connector can implement the same contract without changing the UI or DB.
    try {
      await evolutionRequest(`/instance/create`, { method: "POST", body: JSON.stringify({ instanceName: instance, integration: "WHATSAPP-BAILEYS", qrcode: true }) });
    } catch (error) {
      // Existing instances return a conflict; the next connect request is still valid.
      if (!String(error).toLowerCase().includes("already") && !String(error).includes("409")) throw error;
    }
    const payload = await evolutionRequest(`/instance/connect/${encodeURIComponent(instance)}`);
    const qrCode = extractQrCode(payload);
    const state = String(payload?.instance?.state || payload?.state || "connecting").toLowerCase();
    if (state === "open" || state === "connected") {
      await db.update(whatsappSessions).set({ status: "connected", phoneNumber: payload?.instance?.ownerJid?.split("@")[0] ?? null, connectedAt: new Date(), lastSyncAt: new Date(), qrCode: null }).where(eq(whatsappSessions.userId, userId));
      await addSystemLog(userId, "whatsapp.connected", "Sessão já estava autenticada.");
      return { status: "connected" as const, qrCode: null };
    }
    await db.update(whatsappSessions).set({ status: "connecting", qrCode }).where(eq(whatsappSessions.userId, userId));
    await addSystemLog(userId, "whatsapp.qr_requested", qrCode ? "QR recebido do conector." : "Conector não retornou QR Code.", qrCode ? "info" : "warning");
    return { status: "connecting" as const, qrCode };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha ao conectar ao provedor.";
    await db.update(whatsappSessions).set({ status: "error", errorMessage: message }).where(eq(whatsappSessions.userId, userId));
    await addSystemLog(userId, "whatsapp.connection_error", message, "error");
    return { status: "error" as const, message };
  }
}

export async function disconnectWhatsApp(userId: number) {
  const db = await getDb();
  if (!db) return { success: false, message: "Banco de dados indisponível." };
  const [session] = await db.select().from(whatsappSessions).where(eq(whatsappSessions.userId, userId)).limit(1);
  try {
    if (session && getMissingWhatsAppConfig().length === 0) {
      await evolutionRequest(`/instance/logout/${encodeURIComponent(session.instanceName)}`, { method: "DELETE" });
    }
  } catch (error) {
    await addSystemLog(userId, "whatsapp.disconnect_error", String(error), "warning");
  }
  await db.update(whatsappSessions).set({ status: "disconnected", qrCode: null, phoneNumber: null, connectedAt: null, errorMessage: null }).where(eq(whatsappSessions.userId, userId));
  await addSystemLog(userId, "whatsapp.disconnected", "Sessão encerrada pelo painel.");
  return { success: true };
}

export async function sendWhatsAppMessage(userId: number, to: string, text: string) {
  const config = getWhatsAppConfig();
  if (getMissingWhatsAppConfig().length) return { sent: false, reason: "configuration_missing" as const };
  const [session] = await (await getDb())!.select().from(whatsappSessions).where(eq(whatsappSessions.userId, userId)).limit(1);
  if (!session || session.status !== "connected") return { sent: false, reason: "not_connected" as const };
  await evolutionRequest(`/message/sendText/${encodeURIComponent(config.instanceName || session.instanceName)}`, { method: "POST", body: JSON.stringify({ number: to.replace(/\D/g, ""), text }) });
  return { sent: true as const };
}

function messageTextFromPayload(payload: any) {
  return payload?.message?.conversation || payload?.message?.extendedTextMessage?.text || payload?.message?.imageMessage?.caption || payload?.text || "";
}

export async function handleWhatsAppWebhook(payload: any) {
  const db = await getDb();
  if (!db) return { accepted: false, reason: "database_unavailable" };
  const event = String(payload?.event || payload?.type || "").toLowerCase();
  const instanceName = payload?.instance || payload?.instanceName || payload?.data?.instance || payload?.data?.key?.remoteJid?.split("@")[0];
  if (event.includes("connection") || event.includes("qrcode")) {
    const [session] = await db.select().from(whatsappSessions).where(eq(whatsappSessions.instanceName, instanceName)).limit(1);
    if (session) {
      const state = String(payload?.data?.state || payload?.state || payload?.data?.instance?.state || "").toLowerCase();
      const connected = state === "open" || state === "connected";
      await db.update(whatsappSessions).set({ status: connected ? "connected" : "connecting", connectedAt: connected ? new Date() : null, lastSyncAt: new Date(), qrCode: extractQrCode(payload?.data || payload) }).where(eq(whatsappSessions.id, session.id));
      await addSystemLog(session.userId, connected ? "whatsapp.connected" : "whatsapp.connection_update", state || "Evento de sessão recebido.");
    }
    return { accepted: true, kind: "connection" };
  }
  if (!event.includes("message")) return { accepted: true, kind: "ignored" };
  const data = payload?.data || payload;
  const key = data?.key || {};
  if (key.fromMe || data?.fromMe) return { accepted: true, kind: "self_message_ignored" };
  const waId = key.remoteJid || data?.sender || data?.from || payload?.from;
  const text = messageTextFromPayload(data);
  const externalId = key.id || data?.id || payload?.id;
  if (!instanceName || !waId || !text) return { accepted: true, kind: "empty_message" };
  const [session] = await db.select().from(whatsappSessions).where(eq(whatsappSessions.instanceName, instanceName)).limit(1);
  if (!session) return { accepted: false, reason: "unknown_instance" };
  if (externalId) {
    const [duplicate] = await db.select().from(messages).where(and(eq(messages.userId, session.userId), eq(messages.externalId, externalId))).limit(1);
    if (duplicate) return { accepted: true, kind: "duplicate_ignored" };
  }
  let [contact] = await db.select().from(contacts).where(and(eq(contacts.userId, session.userId), eq(contacts.waId, waId))).limit(1);
  if (!contact) {
    const result = await db.insert(contacts).values({ userId: session.userId, waId, phoneNumber: waId.split("@")[0], name: data?.pushName || data?.notifyName || null });
    [contact] = await db.select().from(contacts).where(eq(contacts.id, Number(result[0]?.insertId))).limit(1);
  }
  if (!contact) return { accepted: false, reason: "contact_persist_failed" };
  let [conversation] = await db.select().from(conversations).where(and(eq(conversations.userId, session.userId), eq(conversations.contactId, contact.id), eq(conversations.status, "active"))).limit(1);
  if (!conversation) {
    const result = await db.insert(conversations).values({ userId: session.userId, contactId: contact.id, lastMessageAt: new Date() });
    [conversation] = await db.select().from(conversations).where(eq(conversations.id, Number(result[0]?.insertId))).limit(1);
  }
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
    const completion = await invokeLLM({
      messages: [
        { role: "system", content: `${agent.name} é um agente de WhatsApp. Personalidade: ${agent.personality}. Tom: ${agent.tone}. Formalidade: ${agent.formality}. Instruções: ${agent.instructions}. Regras: ${agent.guardrails}. Nunca envie: ${agent.blockedPhrases || "nada especificado"}. Responda apenas com a mensagem final, sem prefácio.` },
        ...context.reverse().map(item => ({ role: item.direction === "inbound" ? "user" as const : "assistant" as const, content: item.text })),
      ],
    });
    const responseText = typeof completion.choices[0]?.message.content === "string" ? completion.choices[0].message.content : "Não consegui gerar uma resposta agora.";
    const sendResult = await sendWhatsAppMessage(session.userId, waId, responseText);
    const inserted = await db.insert(messages).values({ userId: session.userId, conversationId: conversation.id, direction: "outbound", sender: "ai", text: responseText, aiGenerated: true, status: sendResult.sent ? "sent" : "failed" });
    await db.insert(aiLogs).values({ userId: session.userId, conversationId: conversation.id, messageId: Number(inserted[0]?.insertId), model: completion.model, response: responseText, latencyMs: Date.now() - started, status: sendResult.sent ? "success" : "error" });
    await addSystemLog(session.userId, sendResult.sent ? "response.sent" : "ai.response_created", responseText, sendResult.sent ? "info" : "warning");
    return { accepted: true, kind: sendResult.sent ? "replied" : "reply_saved_not_sent" };
  } catch (error) {
    await db.insert(aiLogs).values({ userId: session.userId, conversationId: conversation.id, model: agent.model, response: String(error), latencyMs: Date.now() - started, status: "error" });
    await addSystemLog(session.userId, "ai.error", String(error), "error");
    return { accepted: true, kind: "ai_error" };
  }
}

export function verifyWebhookToken(token: string | undefined) {
  const configured = getWhatsAppConfig().webhookSecret;
  return Boolean(configured && token && configured === token);
}

export const isWhatsAppConfigured = () => getMissingWhatsAppConfig().length === 0;

void ENV;
