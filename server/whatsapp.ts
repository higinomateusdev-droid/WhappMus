import { and, desc, eq, inArray } from "drizzle-orm";
import makeWASocket, { Browsers, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState, type WASocket } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import pino from "pino";
import { invokeLLM } from "./_core/llm";
import { addSystemLog, aiAgents, aiLogs, aiSettings, contacts, conversations, ensureWorkspace, getDb, messages, whatsappSessions } from "./db";

const QR_TTL_MS = 120_000;
const authRoot = process.env.BAILEYS_AUTH_DIR || ".data/baileys-auth";
const sockets = new Map<number, WASocket>();
const reconnectTimers = new Map<number, NodeJS.Timeout>();
const qrWaiters = new Map<number, { resolve: (value: { qrCode: string; qrExpiresAt: Date }) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
const logger = pino({ level: process.env.NODE_ENV === "production" ? "warn" : "info" });

export type DirectWhatsAppDiagnostics = {
  provider: "baileys";
  runtime: "direct-whatsapp-web";
  session: string;
  socket: boolean;
  authPersistence: string;
  qr: string;
  ai: boolean;
};

function authPath(userId: number) { return `${authRoot}/user-${userId}`; }
function asPhone(jid?: string | null) { return jid ? jid.split("@")[0].split(":")[0] : null; }
function messageText(message: any) { return message?.conversation || message?.extendedTextMessage?.text || message?.imageMessage?.caption || message?.videoMessage?.caption || ""; }

async function persistSession(userId: number, values: Record<string, unknown>) {
  const db = await getDb();
  if (!db) return;
  await db.update(whatsappSessions).set(values).where(eq(whatsappSessions.userId, userId));
}

async function recordInbound(userId: number, msg: any) {
  const db = await getDb();
  const key = msg?.key;
  const waId = key?.remoteJid;
  const text = messageText(msg?.message);
  if (!db || !waId || !text || key?.fromMe || waId === "status@broadcast" || waId.endsWith("@g.us")) return;
  const externalId = key.id || null;
  if (externalId) {
    const [duplicate] = await db.select().from(messages).where(and(eq(messages.userId, userId), eq(messages.externalId, externalId))).limit(1);
    if (duplicate) return;
  }
  let [contact] = await db.select().from(contacts).where(and(eq(contacts.userId, userId), eq(contacts.waId, waId))).limit(1);
  if (!contact) {
    const result = await db.insert(contacts).values({ userId, waId, phoneNumber: asPhone(waId), name: msg.pushName || null });
    [contact] = await db.select().from(contacts).where(eq(contacts.id, Number(result[0]?.insertId))).limit(1);
  }
  if (!contact) return;
  let [conversation] = await db.select().from(conversations).where(and(eq(conversations.userId, userId), eq(conversations.contactId, contact.id), eq(conversations.status, "active"))).limit(1);
  if (!conversation) {
    const result = await db.insert(conversations).values({ userId, contactId: contact.id, lastMessageAt: new Date() });
    [conversation] = await db.select().from(conversations).where(eq(conversations.id, Number(result[0]?.insertId))).limit(1);
  }
  if (!conversation) return;
  await db.insert(messages).values({ userId, conversationId: conversation.id, externalId, direction: "inbound", sender: waId, text, status: "received" });
  await db.update(conversations).set({ lastMessageAt: new Date(), unreadCount: conversation.unreadCount + 1 }).where(eq(conversations.id, conversation.id));
  await addSystemLog(userId, "message.received", `${waId}: ${text}`);
  const [settings] = await db.select().from(aiSettings).where(eq(aiSettings.userId, userId)).limit(1);
  const [agent] = await db.select().from(aiAgents).where(eq(aiAgents.userId, userId)).limit(1);
  if (!settings?.autoReplyEnabled || settings.globalPaused || !agent?.enabled) return;
  const context = await db.select().from(messages).where(and(eq(messages.userId, userId), eq(messages.conversationId, conversation.id))).orderBy(desc(messages.createdAt)).limit(12);
  const started = Date.now();
  try {
    const completion = await invokeLLM({ messages: [{ role: "system", content: `${agent.name} é um agente de WhatsApp Web. Personalidade: ${agent.personality}. Tom: ${agent.tone}. Formalidade: ${agent.formality}. Instruções: ${agent.instructions}. Regras: ${agent.guardrails}. Nunca envie: ${agent.blockedPhrases || "nada especificado"}. Responda apenas com a mensagem final.` }, ...context.reverse().map(item => ({ role: item.direction === "inbound" ? "user" as const : "assistant" as const, content: item.text }))] });
    const responseText = typeof completion.choices[0]?.message.content === "string" ? completion.choices[0].message.content : "Não consegui gerar uma resposta agora.";
    const socket = sockets.get(userId);
    const sent = Boolean(socket && socket.user);
    if (sent) await socket!.sendMessage(waId, { text: responseText });
    const inserted = await db.insert(messages).values({ userId, conversationId: conversation.id, direction: "outbound", sender: "ai", text: responseText, aiGenerated: true, status: sent ? "sent" : "failed" });
    await db.insert(aiLogs).values({ userId, conversationId: conversation.id, messageId: Number(inserted[0]?.insertId), model: completion.model, response: responseText, latencyMs: Date.now() - started, status: sent ? "success" : "error" });
    await addSystemLog(userId, sent ? "response.sent" : "ai.response_created", responseText, sent ? "info" : "warning");
  } catch (error) {
    await db.insert(aiLogs).values({ userId, conversationId: conversation.id, model: agent.model, response: String(error), latencyMs: Date.now() - started, status: "error" });
    await addSystemLog(userId, "ai.error", String(error), "error");
  }
}

async function startSocket(userId: number) {
  if (sockets.has(userId)) return sockets.get(userId)!;
  await ensureWorkspace(userId);
  const { state, saveCreds } = await useMultiFileAuthState(authPath(userId));
  let version: [number, number, number] | undefined;
  try {
    const latest = await fetchLatestBaileysVersion();
    version = latest.version;
  } catch (error) {
    await addSystemLog(userId, "whatsapp.version_lookup_failed", String(error), "warning");
  }
  const socket = makeWASocket({ auth: state, ...(version ? { version } : {}), browser: Browsers.ubuntu("Turnstark Lab"), logger, markOnlineOnConnect: false, printQRInTerminal: false, connectTimeoutMs: 60_000, keepAliveIntervalMs: 25_000 });
  sockets.set(userId, socket);
  socket.ev.on("creds.update", saveCreds);
  socket.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      const qrCode = await QRCode.toDataURL(qr, { margin: 2, width: 560 });
      const qrExpiresAt = new Date(Date.now() + QR_TTL_MS);
      await persistSession(userId, { status: "connecting", qrCode, qrExpiresAt, errorMessage: null, lastSyncAt: new Date() });
      await addSystemLog(userId, "whatsapp.qr_requested", "QR real recebido diretamente do WhatsApp Web via Baileys.");
      const waiter = qrWaiters.get(userId);
      if (waiter) {
        clearTimeout(waiter.timer);
        qrWaiters.delete(userId);
        waiter.resolve({ qrCode, qrExpiresAt });
      }
    }
    if (connection === "open") {
      const phoneNumber = asPhone(socket.user?.id);
      await persistSession(userId, { status: "connected", phoneNumber, profileName: socket.user?.name || null, connectedAt: new Date(), lastSyncAt: new Date(), qrCode: null, qrExpiresAt: null, errorMessage: null, provider: "baileys" });
      await addSystemLog(userId, "whatsapp.connected", "Sessão WhatsApp Web conectada diretamente via Baileys.");
    }
    if (connection === "close") {
      sockets.delete(userId);
      const disconnectError = lastDisconnect?.error as Boom | Error | undefined;
      const code = (disconnectError as Boom)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      const reason = disconnectError instanceof Error ? disconnectError.message : "motivo desconhecido";
      const detail = `Código ${code ?? "n/d"}: ${reason}`;
      await persistSession(userId, { status: loggedOut ? "disconnected" : "error", qrCode: null, qrExpiresAt: null, errorMessage: loggedOut ? "Sessão encerrada pelo WhatsApp." : `Conexão encerrada (${detail}). Clique em Gerar novo QR.` });
      await addSystemLog(userId, loggedOut ? "whatsapp.disconnected" : "whatsapp.reconnecting", detail, loggedOut ? "warning" : "error");
      const waiter = qrWaiters.get(userId);
      if (waiter) {
        clearTimeout(waiter.timer);
        qrWaiters.delete(userId);
        waiter.reject(new Error(loggedOut ? "O WhatsApp encerrou esta sessão. Gere um novo QR." : `A conexão foi encerrada antes do QR (${detail}).`));
      }
      if (!loggedOut && !reconnectTimers.has(userId)) {
        const timer = setTimeout(() => { reconnectTimers.delete(userId); void startSocket(userId); }, 2000);
        reconnectTimers.set(userId, timer);
      }
    }
  });
  socket.ev.on("messages.upsert", async ({ messages: incoming, type }) => {
    if (type !== "notify") return;
    for (const msg of incoming) await recordInbound(userId, msg);
  });
  return socket;
}

export async function connectWhatsApp(userId: number) {
  try {
    const db = await getDb();
    const [session] = db ? await db.select().from(whatsappSessions).where(eq(whatsappSessions.userId, userId)).limit(1) : [];
    const hasValidQr = Boolean(session?.qrCode && session.qrExpiresAt && session.qrExpiresAt.getTime() > Date.now());
    const shouldRenewQr = Boolean(session?.status !== "connected" && !hasValidQr);
    if (shouldRenewQr) {
      const existing = sockets.get(userId);
      if (existing) {
        try { existing.end(undefined); } catch { /* socket already closed */ }
        sockets.delete(userId);
      }
      await persistSession(userId, { status: "disconnected", qrCode: null, qrExpiresAt: null, errorMessage: null });
    }
    const socket = await startSocket(userId);
    const current = await getDb();
    const [latest] = current ? await current.select().from(whatsappSessions).where(eq(whatsappSessions.userId, userId)).limit(1) : [];
    if (socket.user || latest?.status === "connected") return { status: "connected" as const, qrCode: null, qrExpiresAt: null, provider: "baileys" as const };
    if (latest?.qrCode && latest.qrExpiresAt && latest.qrExpiresAt.getTime() > Date.now()) return { status: "connecting" as const, qrCode: latest.qrCode, qrExpiresAt: latest.qrExpiresAt, provider: "baileys" as const };
    const qr = await new Promise<{ qrCode: string; qrExpiresAt: Date }>((resolve, reject) => {
      const timer = setTimeout(() => { qrWaiters.delete(userId); reject(new Error("O WhatsApp não entregou o QR Code em 15 segundos. Clique em Gerar novo QR e tente novamente.")); }, 15_000);
      qrWaiters.set(userId, { resolve, reject, timer });
    });
    return { status: "connecting" as const, qrCode: qr.qrCode, qrExpiresAt: qr.qrExpiresAt, provider: "baileys" as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha ao iniciar sessão direta WhatsApp Web.";
    await persistSession(userId, { status: "error", errorMessage: message });
    return { status: "error" as const, message };
  }
}

export async function refreshWhatsAppStatus(userId: number) {
  const db = await getDb();
  const [session] = db ? await db.select().from(whatsappSessions).where(eq(whatsappSessions.userId, userId)).limit(1) : [];
  const expired = Boolean(session?.qrExpiresAt && session.qrExpiresAt.getTime() <= Date.now());
  if (expired && session?.status === "connecting") await persistSession(userId, { status: "error", qrCode: null, qrExpiresAt: null, errorMessage: "QR Code expirado. Clique em Gerar novo QR." });
  return { status: expired ? "error" : session?.status || "disconnected", expired };
}

export async function disconnectWhatsApp(userId: number) {
  const socket = sockets.get(userId);
  if (socket) { try { await socket.logout(); } catch { socket.end(undefined); } sockets.delete(userId); }
  await persistSession(userId, { status: "disconnected", qrCode: null, qrExpiresAt: null, phoneNumber: null, profileName: null, connectedAt: null, errorMessage: null, provider: "baileys" });
  await addSystemLog(userId, "whatsapp.disconnected", "Sessão WhatsApp Web encerrada pelo painel.");
  return { success: true };
}

export async function sendWhatsAppMessage(userId: number, to: string, text: string) {
  const socket = sockets.get(userId);
  if (!socket?.user) return { sent: false, reason: "not_connected" as const };
  await socket.sendMessage(to.includes("@") ? to : `${to.replace(/\D/g, "")}@s.whatsapp.net`, { text });
  return { sent: true as const };
}

export async function getConnectionDiagnostics(userId: number): Promise<DirectWhatsAppDiagnostics> {
  const db = await getDb();
  const [session] = db ? await db.select().from(whatsappSessions).where(eq(whatsappSessions.userId, userId)).limit(1) : [];
  const qr = session?.qrExpiresAt && session.qrExpiresAt.getTime() > Date.now() ? "Aguardando leitura" : session?.status === "connected" ? "Não necessário" : "Inativo";
  return { provider: "baileys", runtime: "direct-whatsapp-web", session: session?.status || "disconnected", socket: Boolean(sockets.get(userId)?.user), authPersistence: `Credenciais persistidas em ${authPath(userId)}`, qr, ai: Boolean(process.env.BUILT_IN_FORGE_API_KEY) };
}

export async function resumeWhatsAppSessions() {
  const db = await getDb();
  if (!db) return;
  const sessions = await db.select().from(whatsappSessions).where(inArray(whatsappSessions.status, ["connected", "connecting"]));
  for (const session of sessions) void startSocket(session.userId);
}

export const isWhatsAppConfigured = () => true;
export const getMissingWhatsAppConfig = () => [] as string[];
