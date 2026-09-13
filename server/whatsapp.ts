import { and, desc, eq } from "drizzle-orm";
import makeWASocket, { Browsers, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState, type WASocket } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import pino from "pino";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { invokeLLM } from "./_core/llm";
import { addSystemLog, ensureWorkspace, getConnection, getDb, getWorkspace, updateConnection } from "./db";
import { getOrganizationForUser, getSupabaseAdmin, requireOrganizationForUser } from "./supabase";
import { storageGetSignedUrl, storagePut } from "./storage";

const QR_TTL_MS = 120_000;
const authRoot = process.env.BAILEYS_AUTH_DIR || ".data/baileys-auth";
const sockets = new Map<string, WASocket>();
const startingSockets = new Map<string, Promise<WASocket>>();
const reconnectTimers = new Map<string, NodeJS.Timeout>();
const reconnectAttempts = new Map<string, number>();
const authSnapshotTimers = new Map<string, NodeJS.Timeout>();
const authSnapshotInFlight = new Map<string, Promise<void>>();
const intentionalDisconnects = new Set<string>();
const authSnapshotDisabled = new Set<string>();
const outboundQueues = new Map<string, Promise<void>>();
const lastOutboundAt = new Map<string, number>();
const dailyOutbound = new Map<string, { day: string; count: number }>();
const consecutiveSendFailures = new Map<string, number>();
const logger = pino({ level: process.env.NODE_ENV === "production" ? "warn" : "info" });

const MIN_OUTBOUND_INTERVAL_MS = 5_000;
const DAILY_OUTBOUND_LIMIT = 100;
const FAILURE_PAUSE_THRESHOLD = 3;
const MAX_AUTOMATIC_RECONNECTS = 6;

export function outboundPolicy(to: string, text: string, dailyCount: number) {
  if (!text.trim()) return "empty_message" as const;
  if (to.endsWith("@g.us")) return "group_messages_disabled" as const;
  if (dailyCount >= DAILY_OUTBOUND_LIMIT) return "daily_safety_limit" as const;
  return "allowed" as const;
}

export type DirectWhatsAppDiagnostics = {
  provider: "baileys";
  runtime: "direct-whatsapp-web";
  session: string;
  socket: boolean;
  authPersistence: string;
  qr: string;
  ai: boolean;
};

export function shouldRequestNewQr(status: string | undefined, hasSavedCredentials: boolean, hasValidQr: boolean) {
  return !hasSavedCredentials && status !== "connected" && !hasValidQr;
}

export function shouldAutoReconnect(code: number | undefined, intentional: boolean, attempts: number) {
  return !intentional && code !== 401 && code !== 440 && attempts < MAX_AUTOMATIC_RECONNECTS;
}

function authPath(userId: string) { return `${authRoot}/user-${userId}`; }
function authSnapshotPath(userId: string) { return `${userId}-whatsapp-auth/session.json`; }
async function hasLocalAuth(userId: string) { try { await stat(path.join(authPath(userId), "creds.json")); return true; } catch { return false; } }
async function persistSession(userId: string, values: Record<string, unknown>) { await updateConnection(userId, values); }

async function restoreAuthSnapshot(userId: string, storageKey?: string | null) {
  if (!storageKey || await hasLocalAuth(userId)) return;
  const signedUrl = await storageGetSignedUrl(storageKey);
  const response = await fetch(signedUrl);
  if (!response.ok) throw new Error(`Falha ao restaurar credenciais persistidas (${response.status}).`);
  const snapshot = await response.json() as { files?: Record<string, string> };
  if (!snapshot.files || typeof snapshot.files !== "object") throw new Error("Snapshot de autenticação inválido.");
  const directory = authPath(userId);
  await mkdir(directory, { recursive: true });
  await Promise.all(Object.entries(snapshot.files).map(([name, value]) => writeFile(path.join(directory, name), Buffer.from(value, "base64"))));
  await addSystemLog(userId, "whatsapp.auth_restored", "Credenciais Baileys restauradas do storage persistente.");
}

async function saveAuthSnapshot(userId: string) {
  if (authSnapshotDisabled.has(userId)) return;
  if (authSnapshotInFlight.has(userId)) return authSnapshotInFlight.get(userId);
  const task = (async () => {
    const directory = authPath(userId);
    const names = await readdir(directory).catch(() => [] as string[]);
    const files: Record<string, string> = {};
    for (const name of names) {
      const filePath = path.join(directory, name);
      if ((await stat(filePath)).isFile()) files[name] = (await readFile(filePath)).toString("base64");
    }
    if (!files["creds.json"] || authSnapshotDisabled.has(userId)) return;
    const stored = await storagePut(authSnapshotPath(userId), JSON.stringify({ version: 1, savedAt: new Date().toISOString(), files }), "application/json");
    if (!authSnapshotDisabled.has(userId)) await persistSession(userId, { auth_storage_key: stored.key });
  })().catch(async error => { await addSystemLog(userId, "whatsapp.auth_snapshot_failed", String(error), "warning"); });
  authSnapshotInFlight.set(userId, task);
  await task.finally(() => authSnapshotInFlight.delete(userId));
}

function scheduleAuthSnapshot(userId: string) {
  const existing = authSnapshotTimers.get(userId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => { authSnapshotTimers.delete(userId); void saveAuthSnapshot(userId); }, 3_000);
  authSnapshotTimers.set(userId, timer);
}

function asPhone(jid?: string | null) { return jid ? jid.split("@")[0].split(":")[0] : null; }
function messageText(message: any) { return message?.conversation || message?.extendedTextMessage?.text || message?.imageMessage?.caption || message?.videoMessage?.caption || ""; }
function knowledgeContext(items: Array<{ title: string; question?: string | null; content: string }>) { const text = items.map(item => `### ${item.title}${item.question ? `\nPergunta: ${item.question}` : ""}\n${item.content}`).join("\n\n"); return text ? `\n\nBASE DE CONHECIMENTO DO NEGÓCIO:\n${text}` : ""; }
function todayKey() { return new Date().toISOString().slice(0, 10); }

async function safeOutboundSend(userId: string, to: string, text: string) {
  const initialPolicy = outboundPolicy(to, text, dailyOutbound.get(userId)?.count || 0);
  if (initialPolicy !== "allowed") return { sent: false as const, reason: initialPolicy };
  const previous = outboundQueues.get(userId) || Promise.resolve();
  let result: { sent: boolean; reason?: string } = { sent: false, reason: "not_connected" };
  const next = previous.then(async () => {
    const socket = sockets.get(userId);
    if (!socket?.user) return;
    const day = todayKey();
    const usage = dailyOutbound.get(userId);
    const current = usage?.day === day ? usage : { day, count: 0 };
    if (current.count >= DAILY_OUTBOUND_LIMIT) { result = { sent: false, reason: "daily_safety_limit" }; await addSystemLog(userId, "outbound.rate_limited", `Limite diário atingido (${DAILY_OUTBOUND_LIMIT}).`, "warning"); return; }
    const wait = Math.max(0, MIN_OUTBOUND_INTERVAL_MS - (Date.now() - (lastOutboundAt.get(userId) || 0)));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    try {
      await socket.sendMessage(to.includes("@") ? to : `${to.replace(/\D/g, "")}@s.whatsapp.net`, { text });
      lastOutboundAt.set(userId, Date.now());
      dailyOutbound.set(userId, { day, count: current.count + 1 });
      consecutiveSendFailures.delete(userId);
      result = { sent: true };
    } catch (error) {
      const failures = (consecutiveSendFailures.get(userId) || 0) + 1;
      consecutiveSendFailures.set(userId, failures);
      result = { sent: false, reason: "send_failed" };
      await addSystemLog(userId, "outbound.send_failed", String(error), "warning");
      if (failures >= FAILURE_PAUSE_THRESHOLD) {
        const { organizationId } = await requireOrganizationForUser(userId);
        await getSupabaseAdmin().from("ai_settings").update({ global_paused: true }).eq("organization_id", organizationId);
        await addSystemLog(userId, "ai.paused_safety", `IA pausada após ${failures} falhas consecutivas.`, "error");
      }
    }
  }).catch(async error => { result = { sent: false, reason: "queue_failed" }; await addSystemLog(userId, "outbound.queue_failed", String(error), "error"); });
  outboundQueues.set(userId, next);
  await next;
  if (outboundQueues.get(userId) === next) outboundQueues.delete(userId);
  return result;
}

async function recordInbound(userId: string, msg: any) {
  const scope = await getOrganizationForUser(userId);
  const db = getSupabaseAdmin();
  const key = msg?.key;
  const waId = key?.remoteJid;
  const text = messageText(msg?.message);
  if (!scope || !waId || !text || key?.fromMe || waId === "status@broadcast" || waId.endsWith("@g.us")) return;
  const session = await getConnection(userId);
  if (!session) return;
  const externalId = key.id || null;
  if (externalId) {
    const { data: duplicate } = await db.from("messages").select("id").eq("organization_id", scope.organizationId).eq("external_id", externalId).limit(1).maybeSingle();
    if (duplicate) return;
  }
  let { data: contact } = await db.from("contacts").select("*").eq("organization_id", scope.organizationId).eq("wa_id", waId).limit(1).maybeSingle();
  if (!contact) {
    const { data, error } = await db.from("contacts").insert({ organization_id: scope.organizationId, whatsapp_connection_id: session.id, wa_id: waId, phone_number: asPhone(waId), name: msg.pushName || null }).select("*").single();
    if (error) throw error;
    contact = data;
  } else if (msg.pushName && contact.name !== msg.pushName) {
    await db.from("contacts").update({ name: msg.pushName, phone_number: asPhone(waId) }).eq("id", contact.id).eq("organization_id", scope.organizationId);
  }
  let { data: conversation } = await db.from("conversations").select("*").eq("organization_id", scope.organizationId).eq("contact_id", contact.id).eq("status", "active").limit(1).maybeSingle();
  if (!conversation) {
    const { data, error } = await db.from("conversations").insert({ organization_id: scope.organizationId, whatsapp_connection_id: session.id, contact_id: contact.id, last_message_at: new Date().toISOString() }).select("*").single();
    if (error) throw error;
    conversation = data;
  }
  const { error: messageError } = await db.from("messages").insert({ organization_id: scope.organizationId, whatsapp_connection_id: session.id, conversation_id: conversation.id, external_id: externalId, direction: "inbound", sender: waId, recipient: session.phoneNumber, content: text, status: "received" });
  if (messageError) throw messageError;
  await db.from("conversations").update({ last_message_at: new Date().toISOString(), unread_count: (conversation.unread_count || 0) + 1 }).eq("id", conversation.id).eq("organization_id", scope.organizationId);
  await addSystemLog(userId, "message.received", `${waId}: ${text}`);

  const [{ data: settings }, { data: agent }, { data: knowledge }, { data: context }] = await Promise.all([
    db.from("ai_settings").select("*").eq("organization_id", scope.organizationId).limit(1).maybeSingle(),
    db.from("ai_agents").select("*").eq("organization_id", scope.organizationId).limit(1).maybeSingle(),
    db.from("knowledge_items").select("title, question, content").eq("organization_id", scope.organizationId).eq("enabled", true),
    db.from("messages").select("direction, content").eq("organization_id", scope.organizationId).eq("conversation_id", conversation.id).order("created_at", { ascending: false }).limit(12),
  ]);
  if (!settings?.auto_reply_enabled || settings.global_paused || !agent?.enabled) return;
  const started = Date.now();
  try {
    const completion = await invokeLLM({ messages: [{ role: "system", content: `${agent.name} é um agente de WhatsApp Web. Personalidade: ${agent.personality}. Tom: ${agent.tone}. Formalidade: ${agent.formality}. Instruções: ${agent.instructions}. Regras: ${agent.guardrails}. Nunca envie: ${agent.blocked_phrases || "nada especificado"}.${knowledgeContext(knowledge ?? [])} Responda apenas com a mensagem final.` }, ...(context ?? []).reverse().map(item => ({ role: item.direction === "inbound" ? "user" as const : "assistant" as const, content: item.content }))] });
    const responseText = typeof completion.choices[0]?.message.content === "string" ? completion.choices[0].message.content : "Não consegui gerar uma resposta agora.";
    const sentResult = await safeOutboundSend(userId, waId, responseText);
    const sent = sentResult.sent;
    const { data: inserted } = await db.from("messages").insert({ organization_id: scope.organizationId, whatsapp_connection_id: session.id, conversation_id: conversation.id, direction: "outbound", sender: "ai", recipient: waId, content: responseText, ai_generated: true, status: sent ? "sent" : "failed" }).select("id").single();
    await db.from("ai_logs").insert({ organization_id: scope.organizationId, conversation_id: conversation.id, message_id: inserted?.id ?? null, model: completion.model, response: responseText, latency_ms: Date.now() - started, status: sent ? "success" : "error" });
    await addSystemLog(userId, sent ? "response.sent" : "ai.response_created", responseText, sent ? "info" : "warning");
  } catch (error) {
    await db.from("ai_logs").insert({ organization_id: scope.organizationId, conversation_id: conversation.id, model: agent.model, response: String(error), latency_ms: Date.now() - started, status: "error" });
    await addSystemLog(userId, "ai.error", String(error), "error");
  }
}

async function startSocket(userId: string) {
  const existing = sockets.get(userId);
  if (existing) return existing;
  const pending = startingSockets.get(userId);
  if (pending) return pending;
  const promise = createSocket(userId);
  startingSockets.set(userId, promise);
  try { return await promise; } finally { if (startingSockets.get(userId) === promise) startingSockets.delete(userId); }
}

async function createSocket(userId: string) {
  if (sockets.has(userId)) return sockets.get(userId)!;
  authSnapshotDisabled.delete(userId);
  await ensureWorkspace(userId);
  const session = await getConnection(userId);
  await restoreAuthSnapshot(userId, session?.authStorageKey);
  const { state, saveCreds } = await useMultiFileAuthState(authPath(userId));
  let version: [number, number, number] | undefined;
  try { version = (await fetchLatestBaileysVersion()).version; } catch (error) { await addSystemLog(userId, "whatsapp.version_lookup_failed", String(error), "warning"); }
  const socket = makeWASocket({ auth: state, ...(version ? { version } : {}), browser: Browsers.ubuntu("Turnstark Lab"), logger, markOnlineOnConnect: false, printQRInTerminal: false, connectTimeoutMs: 60_000, keepAliveIntervalMs: 25_000 });
  sockets.set(userId, socket);
  socket.ev.on("creds.update", async () => { await saveCreds(); scheduleAuthSnapshot(userId); });
  socket.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (sockets.get(userId) !== socket) return;
    if (qr) {
      const qrCode = await QRCode.toDataURL(qr, { margin: 2, width: 560 });
      await persistSession(userId, { status: "connecting", qr_code: qrCode, qr_expires_at: new Date(Date.now() + QR_TTL_MS).toISOString(), error_message: null, last_sync_at: new Date().toISOString() });
      await addSystemLog(userId, "whatsapp.qr_requested", "QR real recebido diretamente do WhatsApp Web via Baileys.");
    }
    if (connection === "open") {
      reconnectAttempts.delete(userId);
      const phoneNumber = asPhone(socket.user?.id);
      await persistSession(userId, { status: "connected", phone_number: phoneNumber, profile_name: socket.user?.name || null, connected_at: new Date().toISOString(), last_sync_at: new Date().toISOString(), qr_code: null, qr_expires_at: null, error_message: null, provider: "baileys" });
      scheduleAuthSnapshot(userId);
      await addSystemLog(userId, "whatsapp.connected", "Sessão WhatsApp Web conectada diretamente via Baileys.");
    }
    if (connection === "close") {
      if (sockets.get(userId) !== socket) return;
      sockets.delete(userId);
      const intentional = intentionalDisconnects.delete(userId);
      const disconnectError = lastDisconnect?.error as Boom | Error | undefined;
      const code = (disconnectError as Boom)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      const terminalConflict = code === 401 || code === 440;
      const reason = disconnectError instanceof Error ? disconnectError.message : "motivo desconhecido";
      const detail = `Código ${code ?? "n/d"}: ${reason}`;
      if (loggedOut) await rm(authPath(userId), { recursive: true, force: true });
      const attempt = reconnectAttempts.get(userId) || 0;
      const canRetry = !loggedOut && shouldAutoReconnect(code, intentional, attempt);
      if (canRetry) reconnectAttempts.set(userId, attempt + 1);
      const conflictMessage = terminalConflict ? `Sessão substituída ou dispositivo removido (${detail}). O retry automático foi bloqueado; reconecte manualmente.` : null;
      await persistSession(userId, { status: loggedOut || intentional || !canRetry ? "disconnected" : "connecting", ...(loggedOut || intentional ? { auth_storage_key: null } : {}), qr_code: null, qr_expires_at: null, error_message: loggedOut ? "Sessão encerrada pelo WhatsApp. Será necessário escanear um novo QR." : intentional ? null : conflictMessage || (!canRetry ? `Reconexão automática pausada após ${MAX_AUTOMATIC_RECONNECTS} tentativas (${detail}).` : `Reconectando com backoff (${detail}). As credenciais salvas serão reutilizadas.`) });
      await addSystemLog(userId, loggedOut || intentional || !canRetry ? "whatsapp.disconnected" : "whatsapp.reconnecting", detail, loggedOut || intentional || !canRetry ? "warning" : "info");
      if (canRetry && !reconnectTimers.has(userId)) {
        const delay = Math.min(60_000, 2_000 * (2 ** attempt));
        const timer = setTimeout(() => { reconnectTimers.delete(userId); void startSocket(userId); }, delay);
        reconnectTimers.set(userId, timer);
      }
    }
  });
  socket.ev.on("messages.upsert", async ({ messages: incoming, type }) => { if (type !== "notify") return; for (const msg of incoming) await recordInbound(userId, msg); });
  return socket;
}

export async function connectWhatsApp(userId: string) {
  try {
    const session = await getConnection(userId);
    const hasValidQr = Boolean(session?.qrCode && session.qrExpiresAt && session.qrExpiresAt.getTime() > Date.now());
    const hasSavedCredentials = Boolean(session?.authStorageKey) || await hasLocalAuth(userId);
    if (shouldRequestNewQr(session?.status, hasSavedCredentials, hasValidQr)) {
      const existing = sockets.get(userId);
      if (existing) { try { existing.end(undefined); } catch {} sockets.delete(userId); }
      await persistSession(userId, { status: "disconnected", qr_code: null, qr_expires_at: null, error_message: null });
    }
    const socket = await startSocket(userId);
    const latest = await getConnection(userId);
    if (socket.user || latest?.status === "connected") return { status: "connected" as const, qrCode: null, qrExpiresAt: null, provider: "baileys" as const };
    if (latest?.qrCode && latest.qrExpiresAt && latest.qrExpiresAt.getTime() > Date.now()) return { status: "connecting" as const, qrCode: latest.qrCode, qrExpiresAt: latest.qrExpiresAt, provider: "baileys" as const };
    return { status: "connecting" as const, qrCode: latest?.qrCode || null, qrExpiresAt: latest?.qrExpiresAt || null, provider: "baileys" as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha ao iniciar sessão direta WhatsApp Web.";
    await persistSession(userId, { status: "error", error_message: message });
    return { status: "error" as const, message };
  }
}

export async function refreshWhatsAppStatus(userId: string) {
  const session = await getConnection(userId);
  const expired = Boolean(session?.qrExpiresAt && session.qrExpiresAt.getTime() <= Date.now());
  if (expired && session?.status === "connecting") await persistSession(userId, { status: "error", qr_code: null, qr_expires_at: null, error_message: "QR Code expirado. Clique em Gerar novo QR." });
  return { status: expired ? "error" : session?.status || "disconnected", expired };
}

export async function disconnectWhatsApp(userId: string) {
  authSnapshotDisabled.add(userId);
  const snapshotTimer = authSnapshotTimers.get(userId);
  if (snapshotTimer) { clearTimeout(snapshotTimer); authSnapshotTimers.delete(userId); }
  intentionalDisconnects.add(userId);
  const timer = reconnectTimers.get(userId);
  if (timer) { clearTimeout(timer); reconnectTimers.delete(userId); }
  const socket = sockets.get(userId);
  if (!socket) intentionalDisconnects.delete(userId);
  if (socket) { try { await socket.logout(); } catch { socket.end(undefined); } sockets.delete(userId); }
  await rm(authPath(userId), { recursive: true, force: true });
  await persistSession(userId, { status: "disconnected", qr_code: null, qr_expires_at: null, phone_number: null, profile_name: null, connected_at: null, auth_storage_key: null, error_message: null, provider: "baileys" });
  await addSystemLog(userId, "whatsapp.disconnected", "Sessão WhatsApp Web encerrada pelo painel.");
  return { success: true } as const;
}

export async function sendWhatsAppMessage(userId: string, to: string, text: string) { return safeOutboundSend(userId, to, text); }

export async function getConnectionDiagnostics(userId: string): Promise<DirectWhatsAppDiagnostics> {
  const session = await getConnection(userId);
  const qr = session?.qrExpiresAt && session.qrExpiresAt.getTime() > Date.now() ? "Aguardando leitura" : session?.status === "connected" ? "Não necessário" : "Inativo";
  return { provider: "baileys", runtime: "direct-whatsapp-web", session: session?.status || "disconnected", socket: Boolean(sockets.get(userId)?.user), authPersistence: `Credenciais persistidas em ${authPath(userId)}`, qr, ai: Boolean(process.env.BUILT_IN_FORGE_API_KEY) };
}

export async function resumeWhatsAppSessions() {
  const db = getSupabaseAdmin();
  const { data: sessions } = await db.from("whatsapp_connections").select("organization_id, status, auth_storage_key").in("status", ["connected", "connecting", "error"]);
  for (const session of sessions ?? []) {
    const { data: membership } = await db.from("memberships").select("user_id").eq("organization_id", session.organization_id).order("created_at", { ascending: true }).limit(1).maybeSingle();
    if (membership?.user_id) void startSocket(membership.user_id);
  }
}

export const isWhatsAppConfigured = () => true;
export const getMissingWhatsAppConfig = () => [] as string[];
