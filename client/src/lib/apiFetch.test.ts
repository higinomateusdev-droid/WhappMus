import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./apiFetch";

describe("apiFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns real JSON API responses and includes credentials", async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiFetch("/api/trpc/system.health")).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/trpc/system.health",
      expect.objectContaining({ credentials: "include" })
    );
  });

  it("rejects an HTML SPA fallback before tRPC attempts JSON parsing", async () => {
    const response = new Response("<!doctype html><html><body>SPA</body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=UTF-8" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(apiFetch("/api/trpc/whatsapp.connect")).rejects.toThrow(
      "resposta inválida do backend"
    );
  });
});
