import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import { ArrowLeft, ArrowRight, FlaskConical, Loader2, LockKeyhole } from "lucide-react";
import { FormEvent, useState } from "react";
import { Link, useLocation } from "wouter";
import { toast } from "sonner";

export default function Auth() {
  const [, navigate] = useLocation();
  const [mode, setMode] = useState<"login" | "signup">("signup");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email: email.trim(), password, options: { data: { full_name: name.trim() } } });
        if (error) throw error;
        if (!data.session) {
          toast.success("Conta criada. Verifique o seu email para confirmar o acesso.");
          setMode("login");
        } else {
          toast.success("Conta criada com sucesso.");
          navigate("/lab");
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
        toast.success("Sessão iniciada.");
        navigate("/lab");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Não foi possível concluir a autenticação.");
    } finally { setBusy(false); }
  }

  return <main className="min-h-screen bg-[#080b10] text-white lab-grid grid place-items-center p-6"><div className="w-full max-w-md"><Link href="/" className="mb-8 inline-flex items-center gap-2 text-xs text-slate-500 transition hover:text-slate-200"><ArrowLeft className="h-3.5 w-3.5" />Voltar à página inicial</Link><div className="panel-card p-7 sm:p-9"><div className="mb-8 flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-cyan-400 text-[#081016]"><FlaskConical className="h-5 w-5" /></div><div><p className="text-[10px] font-bold tracking-[0.28em] text-cyan-300">TURNSTARK LAB</p><h1 className="text-xl font-semibold">{mode === "signup" ? "Criar conta" : "Entrar"}</h1></div></div><div className="mb-7 flex rounded-xl border border-white/10 bg-white/[0.03] p-1"><button onClick={() => setMode("signup")} className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition ${mode === "signup" ? "bg-cyan-400 text-[#071116]" : "text-slate-500 hover:text-slate-200"}`}>Criar conta</button><button onClick={() => setMode("login")} className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition ${mode === "login" ? "bg-cyan-400 text-[#071116]" : "text-slate-500 hover:text-slate-200"}`}>Entrar</button></div><form onSubmit={submit} className="space-y-5">{mode === "signup" && <div className="space-y-2"><Label htmlFor="name">Nome</Label><Input id="name" value={name} onChange={event => setName(event.target.value)} required placeholder="O seu nome" className="border-white/10 bg-white/[0.03]" /></div>}<div className="space-y-2"><Label htmlFor="email">Email</Label><Input id="email" type="email" value={email} onChange={event => setEmail(event.target.value)} required placeholder="voce@empresa.com" className="border-white/10 bg-white/[0.03]" /></div><div className="space-y-2"><Label htmlFor="password">Palavra-passe</Label><Input id="password" type="password" minLength={6} value={password} onChange={event => setPassword(event.target.value)} required placeholder="Mínimo de 6 caracteres" className="border-white/10 bg-white/[0.03]" /></div><Button type="submit" disabled={busy} className="h-11 w-full bg-cyan-400 font-semibold text-[#071116] hover:bg-cyan-300">{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <LockKeyhole className="mr-2 h-4 w-4" />}{mode === "signup" ? "Criar conta" : "Entrar no laboratório"}<ArrowRight className="ml-auto h-4 w-4" /></Button></form><p className="mt-6 text-center text-[11px] leading-5 text-slate-600">A sessão é mantida pelo Supabase Auth e enviada ao backend apenas como token de acesso.</p></div></div></main>;
}
