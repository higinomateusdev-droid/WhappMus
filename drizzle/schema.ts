import {
  boolean,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const whatsappSessions = mysqlTable("whatsapp_sessions", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  provider: varchar("provider", { length: 32 }).default("evolution").notNull(),
  instanceName: varchar("instanceName", { length: 120 }).notNull(),
  status: mysqlEnum("status", ["disconnected", "connecting", "connected", "error"]).default("disconnected").notNull(),
  phoneNumber: varchar("phoneNumber", { length: 64 }),
  qrCode: text("qrCode"),
  errorMessage: text("errorMessage"),
  lastSyncAt: timestamp("lastSyncAt"),
  connectedAt: timestamp("connectedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const contacts = mysqlTable("contacts", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  waId: varchar("waId", { length: 128 }).notNull(),
  name: varchar("name", { length: 180 }),
  phoneNumber: varchar("phoneNumber", { length: 64 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const conversations = mysqlTable("conversations", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  contactId: int("contactId").notNull(),
  status: mysqlEnum("status", ["active", "closed"]).default("active").notNull(),
  unreadCount: int("unreadCount").default(0).notNull(),
  lastMessageAt: timestamp("lastMessageAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const messages = mysqlTable("messages", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  conversationId: int("conversationId").notNull(),
  externalId: varchar("externalId", { length: 180 }),
  direction: mysqlEnum("direction", ["inbound", "outbound"]).notNull(),
  sender: varchar("sender", { length: 180 }),
  text: text("text").notNull(),
  aiGenerated: boolean("aiGenerated").default(false).notNull(),
  status: mysqlEnum("status", ["received", "sent", "failed"]).default("received").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const aiAgents = mysqlTable("ai_agents", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  name: varchar("name", { length: 120 }).default("Nova").notNull(),
  personality: text("personality").notNull(),
  tone: varchar("tone", { length: 80 }).default("Calmo e acolhedor").notNull(),
  formality: varchar("formality", { length: 40 }).default("Equilibrada").notNull(),
  instructions: text("instructions").notNull(),
  guardrails: text("guardrails").notNull(),
  blockedPhrases: text("blockedPhrases").notNull(),
  model: varchar("model", { length: 120 }).default("platform-default").notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const aiSettings = mysqlTable("ai_settings", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  autoReplyEnabled: boolean("autoReplyEnabled").default(true).notNull(),
  globalPaused: boolean("globalPaused").default(false).notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const aiLogs = mysqlTable("ai_logs", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  conversationId: int("conversationId"),
  messageId: int("messageId"),
  model: varchar("model", { length: 120 }),
  response: text("response"),
  latencyMs: int("latencyMs"),
  status: mysqlEnum("status", ["success", "error"]).default("success").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const systemLogs = mysqlTable("system_logs", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  level: mysqlEnum("level", ["info", "warning", "error"]).default("info").notNull(),
  event: varchar("event", { length: 120 }).notNull(),
  detail: text("detail"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type WhatsappSession = typeof whatsappSessions.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type AiAgent = typeof aiAgents.$inferSelect;
export type AiSetting = typeof aiSettings.$inferSelect;
export type SystemLog = typeof systemLogs.$inferSelect;
