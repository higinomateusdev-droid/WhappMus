# Supabase external migration

The external project was audited through its REST OpenAPI surface and currently contains **zero public tables**. No existing Supabase tables, functions, triggers, RLS policies, or storage buckets needed preservation.

The current application remains backed by the internal MySQL/Drizzle database and Manus OAuth. The existing Baileys WhatsApp Web session, QR flow, AI agent, conversations, messages, knowledge base, logs, and storage integration were not removed or redirected during this phase.

## Prepared migration

`001_initial_schema.sql` is an idempotent schema-first migration for the external Supabase project. It creates:

- `profiles`, `organizations`, and `memberships` for account and tenant isolation;
- `whatsapp_connections` for multiple Baileys WhatsApp Web sessions per organization;
- `contacts`, `conversations`, and `messages` with organization and connection ownership;
- `ai_agents`, `ai_settings`, `knowledge_items`, and `ai_logs`;
- `system_logs`, `automation_rules`, and `automation_steps`;
- indexes, timestamp triggers, onboarding RPC `create_organization`, helper functions, RLS policies, and a private `knowledge-documents` storage bucket.

All organization-owned tables require membership through RLS. The service-role key is stored only as a server secret and is not included in this repository.

## Application boundary

This migration is intentionally non-destructive. The internal database remains the source of truth until a later phase migrates data and switches backend queries one feature at a time. The Baileys auth snapshot should remain in private server-side storage during the transition; it must not be exposed through Supabase client-side queries.

## Applying the SQL

Run `001_initial_schema.sql` in the Supabase Dashboard SQL Editor while logged into the project. The migration is safe to re-run because tables use `if not exists`, enum creation is guarded, triggers are replaced, and policies are dropped and recreated by name.

After applying it, validate that the Supabase project reports the expected tables and RLS policies before beginning the authentication or backend cutover.
