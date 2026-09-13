import { describe, expect, it } from "vitest";

describe("Supabase public browser configuration", () => {
  it("can reach the external project with the anon key", async () => {
    const url = process.env.VITE_SUPABASE_URL;
    const key = process.env.VITE_SUPABASE_ANON_KEY;
    expect(url).toMatch(/^https:\/\/[^/]+\.supabase\.co$/);
    expect(key).toBeTruthy();
    const response = await fetch(`${url}/auth/v1/settings`, {
      headers: { apikey: key!, Authorization: `Bearer ${key}` },
    });
    expect([200, 204]).toContain(response.status);
  }, 15_000);
});
