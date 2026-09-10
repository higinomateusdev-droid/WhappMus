import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { invokeLLM } from "./_core/llm";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { addSystemLog, aiAgents, aiSettings, conversations, getConversationMessages, getConversations, getCounts, getRecentLogs, getWorkspace, ensureWorkspace, getDb, messages, whatsappSessions } from "./db";
import { connectWhatsApp, disconnectWhatsApp, getConnectionDiagnostics, getMissingWhatsAppConfig, isWhatsAppConfigured, refreshWhatsAppStatus, sendWhatsAppMessage } from "./whatsapp";
import { and, eq } from "drizzle-orm";

const configResponse = () => ({ configured: isWhatsAppConfigured(), missing: getMissingWhatsAppConfig(), provider: process.env.WHATSAPP_PROVIDER ?? "evolution" });

function currentUserId(ctx: { user: { id: number } }) { return ctx.user.id; }

async function testReply(userId: number, input: string, history: Array<{ role: "user" | "assistant"; content: string }> = []) {
  const workspace = await getWorkspace(userId);
  const agent = workspace?.agent;
  const started = Date.now();
  const response = await invokeLLM({
    model: agent?.model === "platform-default" ? undefined : agent?.model,
    messages: [
      { role: "system", content: `${agent?.name ?? "Nova"} é um agente de WhatsApp. Personalidade: ${agent?.personality ?? "Amigável e conversacional."}. Tom: ${agent?.tone ?? "Calmo"}. Formalidade: ${agent?.formality ?? "Equilibrada"}. Instruções: ${agent?.instructions ?? "Responda com clareza."}. Regras: ${agent?.guardrails ?? "Nunca invente informações."}. Nunca envie: ${agent?.blockedPhrases || "nada especificado"}. Responda apenas com a mensagem final.` },
      ...history,
      { role: "user", content: input },
    ],
  });
  const content = response.choices[0]?.message.content;
  return { text: typeof content === "string" ? content : "Não consegui gerar uma resposta agora.", model: response.model, latencyMs: Date.now() - started };
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  workspace: router({
    overview: protectedProcedure.query(async ({ ctx }) => {
      const userId = currentUserId(ctx);
      await ensureWorkspace(userId);
      const [workspace, counts, logs] = await Promise.all([getWorkspace(userId), getCounts(userId), getRecentLogs(userId)]);
      return { ...workspace, counts, logs, config: configResponse() };
    }),
    config: protectedProcedure.query(() => configResponse()),
    pauseAi: protectedProcedure.input(z.object({ paused: z.boolean() })).mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Banco de dados indisponível.");
      await ensureWorkspace(currentUserId(ctx));
      await db.update(aiSettings).set({ globalPaused: input.paused }).where(eq(aiSettings.userId, currentUserId(ctx)));
      await addSystemLog(currentUserId(ctx), input.paused ? "ai.paused" : "ai.resumed", input.paused ? "Pausa global ativada." : "Respostas automáticas reativadas.");
      return { paused: input.paused };
    }),
  }),
  whatsapp: router({
    connect: protectedProcedure.mutation(({ ctx }) => connectWhatsApp(currentUserId(ctx))),
    reconnect: protectedProcedure.mutation(({ ctx }) => connectWhatsApp(currentUserId(ctx))),
    disconnect: protectedProcedure.mutation(({ ctx }) => disconnectWhatsApp(currentUserId(ctx))),
    refresh: protectedProcedure.mutation(({ ctx }) => refreshWhatsAppStatus(currentUserId(ctx))),
    diagnostics: protectedProcedure.query(({ ctx }) => getConnectionDiagnostics(currentUserId(ctx))),
  }),
  conversations: router({
    list: protectedProcedure.query(({ ctx }) => getConversations(currentUserId(ctx))),
    messages: protectedProcedure.input(z.object({ conversationId: z.number() })).query(({ ctx, input }) => getConversationMessages(currentUserId(ctx), input.conversationId)),
    send: protectedProcedure.input(z.object({ conversationId: z.number(), to: z.string(), text: z.string().min(1).max(4000) })).mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Banco de dados indisponível.");
      const userId = currentUserId(ctx);
      const [conversation] = await db.select().from(conversations).where(and(eq(conversations.id, input.conversationId), eq(conversations.userId, userId))).limit(1);
      if (!conversation) throw new Error("Conversa não encontrada.");
      const sent = await sendWhatsAppMessage(userId, input.to, input.text);
      await db.insert(messages).values({ userId, conversationId: input.conversationId, direction: "outbound", sender: "operator", text: input.text, status: sent.sent ? "sent" : "failed" });
      await db.update(conversations).set({ lastMessageAt: new Date() }).where(eq(conversations.id, input.conversationId));
      await addSystemLog(userId, sent.sent ? "response.sent" : "response.failed", input.text, sent.sent ? "info" : "warning");
      return { ...sent, text: input.text };
    }),
  }),
  ai: router({
    update: protectedProcedure.input(z.object({ name: z.string().min(1), personality: z.string(), tone: z.string(), formality: z.string(), instructions: z.string(), guardrails: z.string(), blockedPhrases: z.string(), enabled: z.boolean() })).mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Banco de dados indisponível.");
      const userId = currentUserId(ctx);
      await ensureWorkspace(userId);
      await db.update(aiAgents).set(input).where(eq(aiAgents.userId, userId));
      await addSystemLog(userId, input.enabled ? "ai.updated" : "ai.disabled", `Agente ${input.name} atualizado.`);
      return input;
    }),
    toggle: protectedProcedure.input(z.object({ enabled: z.boolean() })).mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Banco de dados indisponível.");
      const userId = currentUserId(ctx);
      await ensureWorkspace(userId);
      await db.update(aiAgents).set({ enabled: input.enabled }).where(eq(aiAgents.userId, userId));
      await db.update(aiSettings).set({ autoReplyEnabled: input.enabled }).where(eq(aiSettings.userId, userId));
      await addSystemLog(userId, input.enabled ? "ai.enabled" : "ai.paused", input.enabled ? "IA ativada." : "IA pausada.");
      return { enabled: input.enabled };
    }),
    test: protectedProcedure.input(z.object({ input: z.string().min(1).max(4000), history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).default([]) })).mutation(async ({ ctx, input }) => testReply(currentUserId(ctx), input.input, input.history)),
  }),
});

export type AppRouter = typeof appRouter;
