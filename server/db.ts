import { and, desc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  aiAgents,
  aiLogs,
  aiSettings,
  contacts,
  conversations,
  InsertUser,
  messages,
  systemLogs,
  users,
  whatsappSessions,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try { _db = drizzle(process.env.DATABASE_URL); } catch (error) { console.warn("[Database] Failed to connect:", error); _db = null; }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;
  const values: InsertUser = { openId: user.openId };
  const updateSet: Record<string, unknown> = {};
  for (const field of ["name", "email", "loginMethod"] as const) {
    if (user[field] !== undefined) { values[field] = user[field] ?? null; updateSet[field] = user[field] ?? null; }
  }
  values.lastSignedIn = user.lastSignedIn ?? new Date();
  updateSet.lastSignedIn = values.lastSignedIn;
  if (user.role !== undefined) { values.role = user.role; updateSet.role = user.role; }
  else if (user.openId === ENV.ownerOpenId) { values.role = "admin"; updateSet.role = "admin"; }
  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

export async function ensureWorkspace(userId: number) {
  const db = await getDb();
  if (!db) return null;
  const [agent] = await db.select().from(aiAgents).where(eq(aiAgents.userId, userId)).limit(1);
  if (!agent) {
    await db.insert(aiAgents).values({
      userId,
      name: "Nova",
      personality: "Amigável, natural, prestativa e conversacional.",
      tone: "Calmo e acolhedor",
      formality: "Equilibrada",
      instructions: "Responda com clareza, mantenha o contexto e peça esclarecimentos quando necessário.",
      guardrails: "Nunca invente informações. Encaminhe para atendimento humano quando necessário.",
      blockedPhrases: "",
      model: "platform-default",
      enabled: true,
    });
  }
  const [settings] = await db.select().from(aiSettings).where(eq(aiSettings.userId, userId)).limit(1);
  if (!settings) await db.insert(aiSettings).values({ userId });
  const [session] = await db.select().from(whatsappSessions).where(eq(whatsappSessions.userId, userId)).limit(1);
  if (!session) await db.insert(whatsappSessions).values({ userId, instanceName: `turnstark-${userId}`, provider: "baileys" });
  else if (session.provider !== "baileys") await db.update(whatsappSessions).set({ provider: "baileys" }).where(eq(whatsappSessions.id, session.id));
  return true;
}

export async function getWorkspace(userId: number) {
  const db = await getDb();
  if (!db) return null;
  await ensureWorkspace(userId);
  const [session] = await db.select().from(whatsappSessions).where(eq(whatsappSessions.userId, userId)).limit(1);
  const [agent] = await db.select().from(aiAgents).where(eq(aiAgents.userId, userId)).limit(1);
  const [settings] = await db.select().from(aiSettings).where(eq(aiSettings.userId, userId)).limit(1);
  return { session, agent, settings };
}

export async function getConversations(userId: number) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select().from(conversations).where(eq(conversations.userId, userId)).orderBy(desc(conversations.lastMessageAt), desc(conversations.updatedAt));
  if (!rows.length) return [];
  const contactIds = rows.map(row => row.contactId);
  const people = await db.select().from(contacts).where(and(eq(contacts.userId, userId), inArray(contacts.id, contactIds)));
  return Promise.all(rows.map(async row => {
    const [message] = await db.select().from(messages).where(and(eq(messages.userId, userId), eq(messages.conversationId, row.id))).orderBy(desc(messages.createdAt)).limit(1);
    return { ...row, contact: people.find(person => person.id === row.contactId) ?? null, lastMessage: message ?? null };
  }));
}

export async function getConversationMessages(userId: number, conversationId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(messages).where(and(eq(messages.userId, userId), eq(messages.conversationId, conversationId))).orderBy(messages.createdAt);
}

export async function getRecentLogs(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(systemLogs).where(eq(systemLogs.userId, userId)).orderBy(desc(systemLogs.createdAt)).limit(40);
}

export async function addSystemLog(userId: number, event: string, detail?: string, level: "info" | "warning" | "error" = "info") {
  const db = await getDb();
  if (!db) return;
  await db.insert(systemLogs).values({ userId, event, detail, level });
}

export async function getCounts(userId: number) {
  const db = await getDb();
  if (!db) return { received: 0, aiReplies: 0, activeConversations: 0 };
  const allMessages = await db.select().from(messages).where(eq(messages.userId, userId));
  const active = await db.select().from(conversations).where(and(eq(conversations.userId, userId), eq(conversations.status, "active")));
  return { received: allMessages.filter(message => message.direction === "inbound").length, aiReplies: allMessages.filter(message => message.aiGenerated).length, activeConversations: active.length };
}

export { aiAgents, aiLogs, aiSettings, contacts, conversations, messages, systemLogs, users, whatsappSessions };
