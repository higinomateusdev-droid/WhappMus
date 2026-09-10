import { z } from "zod";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { invokeLLM } from "./_core/llm";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { addSystemLog, aiAgents, aiSettings, conversations, getConversationMessages, getConversations, getCounts, getKnowledgeItems, getRecentLogs, getWorkspace, ensureWorkspace, getDb, knowledgeItems, messages, whatsappSessions } from "./db";
import { connectWhatsApp, disconnectWhatsApp, getConnectionDiagnostics, getMissingWhatsAppConfig, isWhatsAppConfigured, refreshWhatsAppStatus, sendWhatsAppMessage } from "./whatsapp";
import { storagePut } from "./storage";
import { and, eq } from "drizzle-orm";

const configResponse = () => ({ configured: isWhatsAppConfigured(), missing: getMissingWhatsAppConfig(), provider: "baileys", runtime: "direct-whatsapp-web" });

function currentUserId(ctx: { user: { id: number } }) { return ctx.user.id; }

function knowledgeContext(items: Array<{ title: string; question?: string | null; content: string }>) {
  const text = items.map(item => `### ${item.title}${item.question ? `\nPergunta: ${item.question}` : ""}\n${item.content}`).join("\n\n");
  return text ? `\n\nBASE DE CONHECIMENTO DO NEGÓCIO:\n${text}` : "";
}

async function testReply(userId: number, input: string, history: Array<{ role: "user" | "assistant"; content: string }> = []) {
  const workspace = await getWorkspace(userId);
  const agent = workspace?.agent;
  const db = await getDb();
  const knowledge = db ? await db.select().from(knowledgeItems).where(and(eq(knowledgeItems.userId, userId), eq(knowledgeItems.enabled, true))) : [];
  const started = Date.now();
  const response = await invokeLLM({
    model: agent?.model === "platform-default" ? undefined : agent?.model,
    messages: [
      { role: "system", content: `${agent?.name ?? "Nova"} é um agente de WhatsApp. Personalidade: ${agent?.personality ?? "Amigável e conversacional."}. Tom: ${agent?.tone ?? "Calmo"}. Formalidade: ${agent?.formality ?? "Equilibrada"}. Instruções: ${agent?.instructions ?? "Responda com clareza."}. Regras: ${agent?.guardrails ?? "Nunca invente informações."}. Nunca envie: ${agent?.blockedPhrases || "nada especificado"}.${knowledgeContext(knowledge)} Responda apenas com a mensagem final.` },
      ...history,
      { role: "user", content: input },
    ],
  });
  const content = response.choices[0]?.message.content;
  return { text: typeof content === "string" ? content : "Não consegui gerar uma resposta agora.", model: response.model, latencyMs: Date.now() - started };
}

const personalityPresets = [
  { id: "sales", name: "Vendas consultivas", description: "Conduz descoberta, apresenta valor e encaminha para fechamento.", values: { name: "Luna Vendas", personality: "Uma consultora comercial confiante, humana e atenta. Entende o contexto antes de recomendar qualquer solução e conduz a conversa com energia positiva.", tone: "Consultivo, claro e persuasivo", formality: "Profissional e próxima", instructions: "Faça perguntas de descoberta antes de oferecer. Conecte benefícios às necessidades informadas. Apresente uma próxima ação objetiva e nunca pressione de forma agressiva.", guardrails: "Nunca invente preços, prazos ou funcionalidades. Quando faltar informação comercial, diga que vai confirmar com a equipe humana. Respeite o tempo e o orçamento do cliente.", blockedPhrases: "Você não pode garantir aprovação, desconto ou resultado sem confirmação.\nNão use pressão, culpa ou urgência falsa.", enabled: true } },
  { id: "support", name: "Suporte acolhedor", description: "Resolve dúvidas com clareza, paciência e encaminhamento humano.", values: { name: "Nina Suporte", personality: "Uma especialista de suporte paciente, empática e organizada. Explica assuntos complexos em passos simples e confirma se a pessoa conseguiu avançar.", tone: "Acolhedor, paciente e objetivo", formality: "Clara e profissional", instructions: "Cumprimente, entenda o problema, faça uma pergunta por vez e ofereça passos numerados. Ao final, confirme se a solução funcionou e registre qualquer pendência.", guardrails: "Nunca culpe o cliente ou invente uma solução. Se houver risco, cobrança, cancelamento ou acesso sensível, encaminhe para atendimento humano.", blockedPhrases: "Não diga que o problema é culpa do cliente.\nNão prometa prazo sem confirmação da equipe.", enabled: true } },
  { id: "scheduling", name: "Agendamento inteligente", description: "Organiza horários, confirma dados e reduz faltas.", values: { name: "Clara Agenda", personality: "Uma assistente de agendamento organizada, cordial e objetiva. Facilita escolhas de horário e deixa cada compromisso confirmado com clareza.", tone: "Prático, cordial e organizado", formality: "Equilibrada", instructions: "Colete nome, serviço, data e preferência de horário. Confirme o fuso quando necessário. Recapitule todos os dados antes de concluir e ofereça alternativas quando o horário não estiver disponível.", guardrails: "Nunca confirme um horário que não foi validado pelo sistema ou pela equipe. Não invente disponibilidade. Para alterações sensíveis, peça confirmação explícita.", blockedPhrases: "Não diga que está agendado sem confirmação.\nNão revele dados de outros clientes.", enabled: true } },
];

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
    presets: protectedProcedure.query(() => personalityPresets),
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
  knowledge: router({
    list: protectedProcedure.query(({ ctx }) => getKnowledgeItems(currentUserId(ctx))),
    createFaq: protectedProcedure.input(z.object({ title: z.string().min(1), question: z.string().min(1), content: z.string() })).mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Banco de dados indisponível.");
      const userId = currentUserId(ctx);
      const [result] = await db.insert(knowledgeItems).values({ userId, kind: "faq", title: input.title, question: input.question, content: input.content, enabled: true });
      await addSystemLog(userId, "knowledge.faq_created", input.title);
      return { id: Number(result.insertId), ...input, kind: "faq" as const, enabled: true };
    }),
    uploadDocument: protectedProcedure.input(z.object({ fileName: z.string().min(1), mimeType: z.string().min(1), fileSize: z.number().int().nonnegative(), data: z.string(), content: z.string().default("") })).mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Banco de dados indisponível.");
      const userId = currentUserId(ctx);
      const bytes = Buffer.from(input.data, "base64");
      const stored = await storagePut(`${userId}-knowledge/${input.fileName}`, bytes, input.mimeType);
      const [result] = await db.insert(knowledgeItems).values({ userId, kind: "document", title: input.fileName, content: input.content || `Documento anexado: ${input.fileName}.`, storageKey: stored.key, storageUrl: stored.url, mimeType: input.mimeType, fileName: input.fileName, fileSize: input.fileSize, enabled: true });
      await addSystemLog(userId, "knowledge.document_uploaded", input.fileName);
      return { id: Number(result.insertId), title: input.fileName, kind: "document" as const, storageUrl: stored.url, enabled: true };
    }),
    toggle: protectedProcedure.input(z.object({ id: z.number().int(), enabled: z.boolean() })).mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Banco de dados indisponível.");
      await db.update(knowledgeItems).set({ enabled: input.enabled }).where(and(eq(knowledgeItems.id, input.id), eq(knowledgeItems.userId, currentUserId(ctx))));
      return input;
    }),
    remove: protectedProcedure.input(z.object({ id: z.number().int() })).mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new Error("Banco de dados indisponível.");
      await db.delete(knowledgeItems).where(and(eq(knowledgeItems.id, input.id), eq(knowledgeItems.userId, currentUserId(ctx))));
      return { success: true } as const;
    }),
  }),
});

export type AppRouter = typeof appRouter;
