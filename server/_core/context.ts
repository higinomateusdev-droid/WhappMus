import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { getAuthenticatedSupabaseUser, type AuthenticatedSupabaseUser } from "../supabase";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: AuthenticatedSupabaseUser | null;
};

function bearerToken(req: CreateExpressContextOptions["req"]) {
  const value = req.headers.authorization;
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice("Bearer ".length).trim() || null;
}

export async function createContext(opts: CreateExpressContextOptions): Promise<TrpcContext> {
  let user: AuthenticatedSupabaseUser | null = null;
  const token = bearerToken(opts.req);
  if (token) {
    try {
      user = await getAuthenticatedSupabaseUser(token);
    } catch {
      user = null;
    }
  }
  return { req: opts.req, res: opts.res, user };
}
