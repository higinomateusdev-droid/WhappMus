import { supabase } from "@/lib/supabase";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Session, User as SupabaseUser } from "@supabase/supabase-js";

type UseAuthOptions = {
  redirectOnUnauthenticated?: boolean;
  redirectPath?: string;
};

function appUser(user: SupabaseUser | null) {
  if (!user) return null;
  const metadata = user.user_metadata ?? {};
  return {
    id: user.id,
    name: String(metadata.full_name ?? metadata.name ?? user.email?.split("@")[0] ?? "Operador"),
    email: user.email ?? "",
    role: "user" as const,
    openId: user.id,
  };
}

export function useAuth(options?: UseAuthOptions) {
  const { redirectOnUnauthenticated = false, redirectPath } = options ?? {};
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data, error: sessionError }) => {
      if (!active) return;
      if (sessionError) setError(sessionError);
      setSession(data.session);
      setLoading(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return;
      setSession(nextSession);
      setLoading(false);
    });
    return () => { active = false; listener.subscription.unsubscribe(); };
  }, []);

  const logout = useCallback(async () => {
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) throw signOutError;
    setSession(null);
    if (typeof window !== "undefined") window.location.assign("/");
  }, []);

  const user = useMemo(() => appUser(session?.user ?? null), [session?.user]);
  useEffect(() => {
    if (!redirectOnUnauthenticated || loading || user || typeof window === "undefined") return;
    window.location.assign(redirectPath || "/");
  }, [loading, redirectOnUnauthenticated, redirectPath, user]);

  return { user, loading, error, isAuthenticated: Boolean(user), logout, refresh: async () => { const result = await supabase.auth.getSession(); setSession(result.data.session); return result; } };
}
