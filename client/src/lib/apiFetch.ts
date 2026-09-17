export async function apiFetch(input: RequestInfo | URL, init?: RequestInit) {
  const response = await globalThis.fetch(input, { ...(init ?? {}), credentials: "include" });
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";

  if (!contentType.includes("application/json")) {
    const bodyPrefix = (await response.clone().text().catch(() => ""))
      .slice(0, 80)
      .replace(/\s+/g, " ");

    console.error("[API] Resposta não JSON", {
      url: typeof input === "string" ? input : input.toString(),
      status: response.status,
      contentType: contentType || "ausente",
      bodyPrefix,
    });

    throw new Error(
      `O frontend recebeu uma resposta inválida do backend (${response.status}, ${contentType || "sem Content-Type"}). Verifique o proxy /api do ambiente publicado.`
    );
  }

  return response;
}
