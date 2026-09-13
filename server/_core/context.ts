import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { extractBearerToken, getAuthenticatedSupabaseUser, type AuthenticatedSupabaseUser } from "../supabase";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: AuthenticatedSupabaseUser | null;
};

export async function createContext(opts: CreateExpressContextOptions): Promise<TrpcContext> {
  let user: AuthenticatedSupabaseUser | null = null;
  const token = extractBearerToken(opts.req.headers.authorization);
  if (token) {
    try {
      user = await getAuthenticatedSupabaseUser(token);
    } catch {
      user = null;
    }
  }
  return { req: opts.req, res: opts.res, user };
}
