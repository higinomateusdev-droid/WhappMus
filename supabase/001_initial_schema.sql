-- Turnstark Lab / Supabase external schema
-- Safe to run on an empty project and safe to re-run.
-- This migration does not drop or alter existing tables.

create extension if not exists pgcrypto;

do $$ begin create type public.member_role as enum ('owner', 'admin', 'supervisor', 'agent'); exception when duplicate_object then null; end $$;
do $$ begin create type public.whatsapp_connection_status as enum ('disconnected', 'connecting', 'connected', 'error'); exception when duplicate_object then null; end $$;
do $$ begin create type public.conversation_status as enum ('active', 'closed'); exception when duplicate_object then null; end $$;
do $$ begin create type public.message_direction as enum ('inbound', 'outbound'); exception when duplicate_object then null; end $$;
do $$ begin create type public.message_status as enum ('received', 'sent', 'failed'); exception when duplicate_object then null; end $$;
do $$ begin create type public.knowledge_kind as enum ('document', 'faq'); exception when duplicate_object then null; end $$;
do $$ begin create type public.automation_status as enum ('draft', 'active', 'paused'); exception when duplicate_object then null; end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  owner_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.member_role not null default 'agent',
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create table if not exists public.whatsapp_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  label text not null default 'WhatsApp principal',
  provider text not null default 'baileys',
  instance_name text not null,
  status public.whatsapp_connection_status not null default 'disconnected',
  phone_number text,
  profile_name text,
  auth_storage_key text,
  qr_code text,
  qr_expires_at timestamptz,
  error_message text,
  last_sync_at timestamptz,
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, instance_name)
);

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  whatsapp_connection_id uuid references public.whatsapp_connections(id) on delete set null,
  wa_id text not null,
  name text,
  phone_number text,
  opted_in_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, wa_id)
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  whatsapp_connection_id uuid references public.whatsapp_connections(id) on delete set null,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  status public.conversation_status not null default 'active',
  unread_count integer not null default 0 check (unread_count >= 0),
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  whatsapp_connection_id uuid references public.whatsapp_connections(id) on delete set null,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  external_id text,
  direction public.message_direction not null,
  sender text,
  recipient text,
  content text not null,
  ai_generated boolean not null default false,
  status public.message_status not null default 'received',
  created_at timestamptz not null default now(),
  unique (organization_id, external_id)
);

create table if not exists public.ai_agents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null default 'Nova',
  personality text not null default 'Amigável, natural, prestativa e conversacional.',
  tone text not null default 'Calmo e acolhedor',
  formality text not null default 'Equilibrada',
  instructions text not null default 'Responda com clareza, mantenha o contexto e peça esclarecimentos quando necessário.',
  guardrails text not null default 'Nunca invente informações. Encaminhe para atendimento humano quando necessário.',
  blocked_phrases text not null default '',
  model text not null default 'platform-default',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  auto_reply_enabled boolean not null default true,
  global_paused boolean not null default false,
  daily_outbound_limit integer not null default 100 check (daily_outbound_limit between 1 and 10000),
  min_outbound_interval_seconds integer not null default 5 check (min_outbound_interval_seconds between 1 and 3600),
  quiet_hours_start time,
  quiet_hours_end time,
  require_contact_opt_in boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.knowledge_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  kind public.knowledge_kind not null,
  title text not null,
  question text,
  content text not null,
  storage_path text,
  mime_type text,
  file_name text,
  file_size bigint,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  message_id uuid references public.messages(id) on delete set null,
  model text,
  response text,
  latency_ms integer,
  status text not null default 'success',
  created_at timestamptz not null default now()
);

create table if not exists public.system_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  level text not null default 'info' check (level in ('info', 'warning', 'error')),
  event text not null,
  detail text,
  created_at timestamptz not null default now()
);

create table if not exists public.automation_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  description text,
  status public.automation_status not null default 'draft',
  trigger_config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.automation_steps (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  automation_rule_id uuid not null references public.automation_rules(id) on delete cascade,
  position integer not null check (position >= 0),
  action text not null,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (automation_rule_id, position)
);

create index if not exists memberships_user_idx on public.memberships(user_id);
create index if not exists contacts_org_idx on public.contacts(organization_id);
create index if not exists conversations_org_last_message_idx on public.conversations(organization_id, last_message_at desc);
create index if not exists messages_conversation_created_idx on public.messages(conversation_id, created_at);
create index if not exists messages_org_created_idx on public.messages(organization_id, created_at desc);
create index if not exists knowledge_org_enabled_idx on public.knowledge_items(organization_id, enabled);
create index if not exists system_logs_org_created_idx on public.system_logs(organization_id, created_at desc);
create index if not exists automation_steps_rule_position_idx on public.automation_steps(automation_rule_id, position);

create or replace function public.set_updated_at()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
drop trigger if exists organizations_set_updated_at on public.organizations;
create trigger organizations_set_updated_at before update on public.organizations for each row execute function public.set_updated_at();
drop trigger if exists whatsapp_connections_set_updated_at on public.whatsapp_connections;
create trigger whatsapp_connections_set_updated_at before update on public.whatsapp_connections for each row execute function public.set_updated_at();
drop trigger if exists contacts_set_updated_at on public.contacts;
create trigger contacts_set_updated_at before update on public.contacts for each row execute function public.set_updated_at();
drop trigger if exists conversations_set_updated_at on public.conversations;
create trigger conversations_set_updated_at before update on public.conversations for each row execute function public.set_updated_at();
drop trigger if exists ai_agents_set_updated_at on public.ai_agents;
create trigger ai_agents_set_updated_at before update on public.ai_agents for each row execute function public.set_updated_at();
drop trigger if exists ai_settings_set_updated_at on public.ai_settings;
create trigger ai_settings_set_updated_at before update on public.ai_settings for each row execute function public.set_updated_at();
drop trigger if exists knowledge_items_set_updated_at on public.knowledge_items;
create trigger knowledge_items_set_updated_at before update on public.knowledge_items for each row execute function public.set_updated_at();
drop trigger if exists automation_rules_set_updated_at on public.automation_rules;
create trigger automation_rules_set_updated_at before update on public.automation_rules for each row execute function public.set_updated_at();

create or replace function public.is_org_member(v_organization_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    where m.organization_id = v_organization_id and m.user_id = auth.uid()
  );
$$;

create or replace function public.has_org_role(v_organization_id uuid, v_roles public.member_role[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    where m.organization_id = v_organization_id and m.user_id = auth.uid() and m.role = any(v_roles)
  );
$$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name) values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.email)) on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create or replace function public.create_organization(v_name text, v_slug text)
returns public.organizations language plpgsql security definer set search_path = public as $$
declare
  v_org public.organizations;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  insert into public.profiles (id) values (auth.uid()) on conflict (id) do nothing;
  insert into public.organizations (name, slug, owner_id) values (trim(v_name), lower(trim(v_slug)), auth.uid()) returning * into v_org;
  insert into public.memberships (organization_id, user_id, role) values (v_org.id, auth.uid(), 'owner');
  insert into public.ai_agents (organization_id) values (v_org.id);
  insert into public.ai_settings (organization_id) values (v_org.id);
  return v_org;
end;
$$;

grant execute on function public.create_organization(text, text) to authenticated;

alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.whatsapp_connections enable row level security;
alter table public.contacts enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.ai_agents enable row level security;
alter table public.ai_settings enable row level security;
alter table public.knowledge_items enable row level security;
alter table public.ai_logs enable row level security;
alter table public.system_logs enable row level security;
alter table public.automation_rules enable row level security;
alter table public.automation_steps enable row level security;

-- User-owned profile policies.
drop policy if exists profiles_self_select on public.profiles;
drop policy if exists profiles_self_select on public.profiles;
create policy profiles_self_select on public.profiles for select to authenticated using (id = auth.uid());
drop policy if exists profiles_self_update on public.profiles;
drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- Organization and membership policies.
drop policy if exists organizations_member_select on public.organizations;
drop policy if exists organizations_member_select on public.organizations;
create policy organizations_member_select on public.organizations for select to authenticated using (public.is_org_member(id));
drop policy if exists organizations_owner_update on public.organizations;
drop policy if exists organizations_owner_update on public.organizations;
create policy organizations_owner_update on public.organizations for update to authenticated using (public.has_org_role(id, array['owner','admin']::public.member_role[])) with check (public.has_org_role(id, array['owner','admin']::public.member_role[]));
drop policy if exists memberships_member_select on public.memberships;
drop policy if exists memberships_member_select on public.memberships;
create policy memberships_member_select on public.memberships for select to authenticated using (public.is_org_member(organization_id));
drop policy if exists memberships_admin_manage on public.memberships;
drop policy if exists memberships_admin_manage on public.memberships;
create policy memberships_admin_manage on public.memberships for all to authenticated using (public.has_org_role(organization_id, array['owner','admin']::public.member_role[])) with check (public.has_org_role(organization_id, array['owner','admin']::public.member_role[]));

-- Organization-scoped data policies.
drop policy if exists whatsapp_connections_member_all on public.whatsapp_connections;
create policy whatsapp_connections_member_all on public.whatsapp_connections for all to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
drop policy if exists contacts_member_all on public.contacts;
create policy contacts_member_all on public.contacts for all to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
drop policy if exists conversations_member_all on public.conversations;
create policy conversations_member_all on public.conversations for all to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
drop policy if exists messages_member_all on public.messages;
create policy messages_member_all on public.messages for all to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
drop policy if exists ai_agents_member_all on public.ai_agents;
create policy ai_agents_member_all on public.ai_agents for all to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
drop policy if exists ai_settings_member_all on public.ai_settings;
create policy ai_settings_member_all on public.ai_settings for all to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
drop policy if exists knowledge_items_member_all on public.knowledge_items;
create policy knowledge_items_member_all on public.knowledge_items for all to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
drop policy if exists ai_logs_member_all on public.ai_logs;
create policy ai_logs_member_all on public.ai_logs for all to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
drop policy if exists system_logs_member_all on public.system_logs;
create policy system_logs_member_all on public.system_logs for all to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
drop policy if exists automation_rules_member_all on public.automation_rules;
create policy automation_rules_member_all on public.automation_rules for all to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));
drop policy if exists automation_steps_member_all on public.automation_steps;
create policy automation_steps_member_all on public.automation_steps for all to authenticated using (public.is_org_member(organization_id)) with check (public.is_org_member(organization_id));

insert into storage.buckets (id, name, public) values ('knowledge-documents', 'knowledge-documents', false) on conflict (id) do nothing;

drop policy if exists knowledge_documents_member_read on storage.objects;
drop policy if exists knowledge_documents_member_read on storage.objects;
create policy knowledge_documents_member_read on storage.objects for select to authenticated using (bucket_id = 'knowledge-documents' and public.is_org_member((storage.foldername(name))[1]::uuid));
drop policy if exists knowledge_documents_member_insert on storage.objects;
drop policy if exists knowledge_documents_member_insert on storage.objects;
create policy knowledge_documents_member_insert on storage.objects for insert to authenticated with check (bucket_id = 'knowledge-documents' and public.is_org_member((storage.foldername(name))[1]::uuid));
drop policy if exists knowledge_documents_member_update on storage.objects;
drop policy if exists knowledge_documents_member_update on storage.objects;
create policy knowledge_documents_member_update on storage.objects for update to authenticated using (bucket_id = 'knowledge-documents' and public.is_org_member((storage.foldername(name))[1]::uuid)) with check (bucket_id = 'knowledge-documents' and public.is_org_member((storage.foldername(name))[1]::uuid));
drop policy if exists knowledge_documents_member_delete on storage.objects;
drop policy if exists knowledge_documents_member_delete on storage.objects;
create policy knowledge_documents_member_delete on storage.objects for delete to authenticated using (bucket_id = 'knowledge-documents' and public.is_org_member((storage.foldername(name))[1]::uuid));
