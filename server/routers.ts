import { z } from "zod";
import { systemRouter } from "./_core/systemRouter";
import { invokeLLM } from "./_core/llm";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { addSystemLog, ensureWorkspace, getConnection, getConversationMessages, getConversations, getCounts, getDb, getKnowledgeItems, getRecentLogs, getWorkspace, requireOrganizationForUser, updateConnection } from "./db";
import { connectWhatsApp, disconnectWhatsApp, getConnectionDiagnostics, getMissingWhatsAppConfig, isWhatsAppConfigured, refreshWhatsAppStatus, sendWhatsAppMessage } from "./whatsapp";
import { extractBearerToken, getOrganizationForUser, getSupabaseAdmin, getSupabaseUserClient } from "./supabase";
import { knowledgeStoragePut } from "./storage";
import { COOKIE_NAME } from "@shared/const";

const configResponse = () => ({ configured: isWhatsAppConfigured(), missing: getMissingWhatsAppConfig(), provider: "baileys", runtime: "direct-whatsapp-web" });
const currentUserId = (ctx: { user: { id: string } }) => ctx.user.id;

function knowledgeContext(items: Array<{ title: string; question?: string | null; content: string }>) {
  const text = items.map(item => `### ${item.title}${item.question ? `\nPergunta: ${item.question}` : ""}\n${item.content}`).join("\n\n");
  return text ? `\n\nBASE DE CONHECIMENTO DO NEGÓCIO:\n${text}` : "";
}

async function testReply(userId: string, input: string, history: Array<{ role: "user" | "assistant"; content: string }> = []) {
  const workspace = await getWorkspace(userId);
  if (!workspace?.organizationId) throw new Error("Crie uma organização antes de testar a IA.");
  const db = getSupabaseAdmin();
  const { data: knowledge } = await db.from("knowledge_items").select("title, question, content").eq("organization_id", workspace.organizationId).eq("enabled", true);
  const agent = workspace.agent;
  const started = Date.now();
  const response = await invokeLLM({ model: agent?.model === "platform-default" ? undefined : agent?.model, messages: [{ role: "system", content: `${agent?.name ?? "Nova"} é um agente de WhatsApp. Personalidade: ${agent?.personality ?? "Amigável e conversacional."}. Tom: ${agent?.tone ?? "Calmo"}. Formalidade: ${agent?.formality ?? "Equilibrada"}. Instruções: ${agent?.instructions ?? "Responda com clareza."}. Regras: ${agent?.guardrails ?? "Nunca invente informações."}. Nunca envie: ${agent?.blockedPhrases || "nada especificado"}.${knowledgeContext(knowledge ?? [])} Responda apenas com a mensagem final.` }, ...history, { role: "user", content: input }] });
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
    me: protectedProcedure.query(async ({ ctx }) => ({ user: ctx.user, organization: await getOrganizationForUser(ctx.user.id) })),
    logout: publicProcedure.mutation(({ ctx }) => {
      const clearCookie = (ctx.res as any).clearCookie;
      if (typeof clearCookie === "function") clearCookie(COOKIE_NAME, { maxAge: -1, path: "/", secure: true, httpOnly: true, sameSite: "none" });
      return { success: true as const };
    }),
  }),
  onboarding: router({
    status: protectedProcedure.query(({ ctx }) => getOrganizationForUser(ctx.user.id)),
    createOrganization: protectedProcedure.input(z.object({ name: z.string().trim().min(2).max(120), slug: z.string().trim().min(3).max(64).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/) })).mutation(async ({ ctx, input }) => {
      const db = getSupabaseAdmin();
      const { data: existing } = await db.from("memberships").select("organization_id").eq("user_id", ctx.user.id).limit(1).maybeSingle();
      if (existing) throw new Error("Este utilizador já possui uma organização.");
      const accessToken = extractBearerToken(ctx.req.headers.authorization);
      if (!accessToken) throw new Error("Sessão Supabase ausente. Atualize a página e tente novamente.");
      // This RPC uses auth.uid(), so it must run with the user's JWT rather than the service-role client.
      const { data, error } = await getSupabaseUserClient(accessToken).rpc("create_organization", { v_name: input.name, v_slug: input.slug });
      if (error) throw error;
      return data;
    }),
  }),
  workspace: router({
    overview: protectedProcedure.query(async ({ ctx }) => {
      const userId = currentUserId(ctx);
      const ensured = await ensureWorkspace(userId);
      if (!ensured) return { workspaceReady: false, organization: null, organizationId: null, role: null, session: null, agent: null, settings: null, counts: { received: 0, aiReplies: 0, activeConversations: 0 }, logs: [], config: configResponse() };
      const [workspace, counts, logs] = await Promise.all([getWorkspace(userId), getCounts(userId), getRecentLogs(userId)]);
      return { ...workspace, workspaceReady: true, counts, logs, config: configResponse() };
    }),
    config: protectedProcedure.query(() => configResponse()),
    pauseAi: protectedProcedure.input(z.object({ paused: z.boolean() })).mutation(async ({ ctx, input }) => {
      const { organizationId } = await requireOrganizationForUser(currentUserId(ctx));
      const { error } = await getSupabaseAdmin().from("ai_settings").update({ global_paused: input.paused }).eq("organization_id", organizationId);
      if (error) throw error;
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
    messages: protectedProcedure.input(z.object({ conversationId: z.string().uuid() })).query(({ ctx, input }) => getConversationMessages(currentUserId(ctx), input.conversationId)),
    send: protectedProcedure.input(z.object({ conversationId: z.string().uuid(), to: z.string().min(3), text: z.string().min(1).max(4000) })).mutation(async ({ ctx, input }) => {
      const userId = currentUserId(ctx);
      const { organizationId } = await requireOrganizationForUser(userId);
      const db = getSupabaseAdmin();
      const { data: conversation } = await db.from("conversations").select("*").eq("id", input.conversationId).eq("organization_id", organizationId).limit(1).maybeSingle();
      if (!conversation) throw new Error("Conversa não encontrada.");
      const sent = await sendWhatsAppMessage(userId, input.to, input.text);
      await db.from("messages").insert({ organization_id: organizationId, whatsapp_connection_id: conversation.whatsapp_connection_id, conversation_id: input.conversationId, direction: "outbound", sender: "operator", recipient: input.to, content: input.text, status: sent.sent ? "sent" : "failed" });
      await db.from("conversations").update({ last_message_at: new Date().toISOString() }).eq("id", input.conversationId).eq("organization_id", organizationId);
      await addSystemLog(userId, sent.sent ? "response.sent" : "response.failed", input.text, sent.sent ? "info" : "warning");
      return { ...sent, text: input.text };
    }),
  }),
  ai: router({
    presets: protectedProcedure.query(() => personalityPresets),
    update: protectedProcedure.input(z.object({ name: z.string().min(1), personality: z.string(), tone: z.string(), formality: z.string(), instructions: z.string(), guardrails: z.string(), blockedPhrases: z.string(), enabled: z.boolean() })).mutation(async ({ ctx, input }) => {
      const { organizationId } = await requireOrganizationForUser(currentUserId(ctx));
      const { data, error } = await getSupabaseAdmin().from("ai_agents").upsert({ organization_id: organizationId, name: input.name, personality: input.personality, tone: input.tone, formality: input.formality, instructions: input.instructions, guardrails: input.guardrails, blocked_phrases: input.blockedPhrases, enabled: input.enabled }, { onConflict: "organization_id" }).select("*").single();
      if (error) throw error;
      await addSystemLog(currentUserId(ctx), input.enabled ? "ai.updated" : "ai.disabled", `Agente ${input.name} atualizado.`);
      return data;
    }),
    toggle: protectedProcedure.input(z.object({ enabled: z.boolean() })).mutation(async ({ ctx, input }) => {
      const { organizationId } = await requireOrganizationForUser(currentUserId(ctx));
      const db = getSupabaseAdmin();
      const { error } = await db.from("ai_agents").update({ enabled: input.enabled }).eq("organization_id", organizationId);
      if (error) throw error;
      await db.from("ai_settings").update({ auto_reply_enabled: input.enabled }).eq("organization_id", organizationId);
      await addSystemLog(currentUserId(ctx), input.enabled ? "ai.enabled" : "ai.paused", input.enabled ? "IA ativada." : "IA pausada.");
      return { enabled: input.enabled };
    }),
    test: protectedProcedure.input(z.object({ input: z.string().min(1).max(4000), history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).default([]) })).mutation(({ ctx, input }) => testReply(currentUserId(ctx), input.input, input.history)),
  }),
  knowledge: router({
    list: protectedProcedure.query(({ ctx }) => getKnowledgeItems(currentUserId(ctx))),
    createFaq: protectedProcedure.input(z.object({ title: z.string().min(1), question: z.string().min(1), content: z.string() })).mutation(async ({ ctx, input }) => {
      const { organizationId } = await requireOrganizationForUser(currentUserId(ctx));
      const { data, error } = await getSupabaseAdmin().from("knowledge_items").insert({ organization_id: organizationId, kind: "faq", title: input.title, question: input.question, content: input.content, enabled: true }).select("*").single();
      if (error) throw error;
      await addSystemLog(currentUserId(ctx), "knowledge.faq_created", input.title);
      return { id: data.id, ...input, kind: "faq" as const, enabled: true };
    }),
    uploadDocument: protectedProcedure.input(z.object({ fileName: z.string().min(1), mimeType: z.string().min(1), fileSize: z.number().int().nonnegative(), data: z.string(), content: z.string().default("") })).mutation(async ({ ctx, input }) => {
      const { organizationId } = await requireOrganizationForUser(currentUserId(ctx));
      const stored = await knowledgeStoragePut(organizationId, input.fileName, Buffer.from(input.data, "base64"), input.mimeType);
      const { data, error } = await getSupabaseAdmin().from("knowledge_items").insert({ organization_id: organizationId, kind: "document", title: input.fileName, content: input.content || `Documento anexado: ${input.fileName}.`, storage_path: stored.key, mime_type: input.mimeType, file_name: input.fileName, file_size: input.fileSize, enabled: true }).select("*").single();
      if (error) throw error;
      await addSystemLog(currentUserId(ctx), "knowledge.document_uploaded", input.fileName);
      return { id: data.id, title: input.fileName, kind: "document" as const, storageUrl: stored.key, enabled: true };
    }),
    toggle: protectedProcedure.input(z.object({ id: z.string().uuid(), enabled: z.boolean() })).mutation(async ({ ctx, input }) => {
      const { organizationId } = await requireOrganizationForUser(currentUserId(ctx));
      const { error } = await getSupabaseAdmin().from("knowledge_items").update({ enabled: input.enabled }).eq("id", input.id).eq("organization_id", organizationId);
      if (error) throw error;
      return input;
    }),
    remove: protectedProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
      const { organizationId } = await requireOrganizationForUser(currentUserId(ctx));
      const { error } = await getSupabaseAdmin().from("knowledge_items").delete().eq("id", input.id).eq("organization_id", organizationId);
      if (error) throw error;
      return { success: true } as const;
    }),
  }),
});

export type AppRouter = typeof appRouter;
