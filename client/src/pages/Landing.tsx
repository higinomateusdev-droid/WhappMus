import { Link } from "wouter";
import { ArrowRight, Bot, FlaskConical, MessageCircle, ShieldCheck } from "lucide-react";

export default function Landing() {
  return <main className="min-h-screen bg-[#080b10] text-white lab-grid">
    <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6 lg:px-8">
      <div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-2xl bg-cyan-400 text-[#081016]"><FlaskConical className="h-5 w-5" /></div><div><p className="text-[10px] font-bold tracking-[0.28em] text-cyan-300">PRIVATE AI LAB</p><p className="font-semibold tracking-tight">TURNSTARK</p></div></div>
      <Link href="/auth" className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-xs font-semibold text-slate-200 transition hover:bg-white/[0.08]">Entrar</Link>
    </header>
    <section className="mx-auto grid max-w-6xl gap-14 px-6 pb-20 pt-16 lg:grid-cols-[1.1fr_0.9fr] lg:items-center lg:px-8 lg:pt-24">
      <div><p className="mb-5 inline-flex items-center gap-2 rounded-full border border-cyan-300/20 bg-cyan-300/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-200"><ShieldCheck className="h-3.5 w-3.5" />Workspace privado por organização</p><h1 className="max-w-3xl text-5xl font-semibold leading-[1.02] tracking-[-0.04em] sm:text-6xl">Conversas mais inteligentes, com contexto e controlo.</h1><p className="mt-7 max-w-xl text-base leading-8 text-slate-400">Ligue o seu WhatsApp Web por QR Code, configure a personalidade da IA e mantenha mensagens, contactos e conhecimento organizados num único laboratório.</p><Link href="/auth" className="mt-9 inline-flex items-center rounded-xl bg-cyan-400 px-5 py-3.5 text-sm font-semibold text-[#071116] transition hover:bg-cyan-300">Criar conta <ArrowRight className="ml-2 h-4 w-4" /></Link></div>
      <div className="panel-card relative overflow-hidden p-6"><div className="absolute -right-20 -top-20 h-56 w-56 rounded-full bg-cyan-400/10 blur-3xl" /><p className="eyebrow">CONTROL ROOM</p><h2 className="section-title mt-2">Do QR Code à resposta.</h2><div className="mt-8 space-y-4">{[[MessageCircle,"WhatsApp Web","Sessão Baileys persistente"],[Bot,"IA contextual","Personalidade e base de conhecimento"],[ShieldCheck,"Dados isolados","Cada organização vê apenas os seus dados"]].map(([Icon,label,detail]) => { const Component = Icon as typeof MessageCircle; return <div key={String(label)} className="flex items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-4"><div className="grid h-10 w-10 place-items-center rounded-xl bg-cyan-300/10 text-cyan-200"><Component className="h-4 w-4" /></div><div><p className="text-sm font-semibold text-slate-200">{String(label)}</p><p className="mt-1 text-xs text-slate-500">{String(detail)}</p></div></div>; })}</div></div>
    </section>
  </main>;
}
