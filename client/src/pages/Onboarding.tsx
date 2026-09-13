import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { ArrowRight, Building2, Loader2 } from "lucide-react";
import { FormEvent, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

export default function Onboarding({ onComplete }: { onComplete: () => void }) {
  const [, navigate] = useLocation();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const create = trpc.onboarding.createOrganization.useMutation({ onSuccess: () => { toast.success("Workspace criado."); onComplete(); navigate("/lab"); }, onError: error => toast.error(error.message) });
  function submit(event: FormEvent) { event.preventDefault(); create.mutate({ name: name.trim(), slug: slug.trim().toLowerCase() }); }
  return <main className="min-h-screen bg-[#080b10] text-white lab-grid grid place-items-center p-6"><div className="w-full max-w-lg panel-card p-8 sm:p-10"><div className="mb-8 flex items-center gap-3"><div className="grid h-12 w-12 place-items-center rounded-2xl bg-cyan-400 text-[#081016]"><Building2 className="h-5 w-5" /></div><div><p className="eyebrow">PRIMEIRO PASSO</p><h1 className="text-2xl font-semibold">Crie o seu workspace</h1></div></div><p className="mb-8 text-sm leading-6 text-slate-400">O workspace mantém a sua sessão WhatsApp, agente, mensagens e base de conhecimento isolados dos restantes utilizadores.</p><form onSubmit={submit} className="space-y-5"><div className="space-y-2"><Label htmlFor="org-name">Nome da organização</Label><Input id="org-name" value={name} onChange={event => { setName(event.target.value); if (!slug) setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")); }} placeholder="Minha empresa" required className="border-white/10 bg-white/[0.03]" /></div><div className="space-y-2"><Label htmlFor="org-slug">Identificador</Label><Input id="org-slug" value={slug} onChange={event => setSlug(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} placeholder="minha-empresa" required pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]" className="border-white/10 bg-white/[0.03]" /><p className="text-[11px] text-slate-600">Apenas letras minúsculas, números e hífens.</p></div><Button disabled={create.isPending} className="h-11 w-full bg-cyan-400 font-semibold text-[#071116] hover:bg-cyan-300">{create.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowRight className="mr-2 h-4 w-4" />}Continuar para o laboratório</Button></form></div></main>;
}
