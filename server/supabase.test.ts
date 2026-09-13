import { describe, expect, it } from "vitest";
import { extractBearerToken } from "./supabase";

describe("Supabase bearer authentication", () => {
  it("extracts only a valid bearer token and handles array headers", () => {
    expect(extractBearerToken("Bearer user-access-token")).toBe("user-access-token");
    expect(extractBearerToken(["Bearer array-token"])).toBe("array-token");
    expect(extractBearerToken("Basic credentials")).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
  });
});

describe("Supabase external project credentials", () => {
  it("accepts the configured server-only service role key", async () => {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(url).toMatch(/^https:\/\/[^/]+\.supabase\.co$/);
    expect(key).toBeTruthy();
    const response = await fetch(`${url}/rest/v1/`, {
      headers: {
        apikey: key!,
        Authorization: `Bearer ${key}`,
      },
    });
    expect([200, 204]).toContain(response.status);
  }, 15_000);
});
