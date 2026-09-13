import { getSupabaseAdmin } from "./supabase";
import { ENV } from "./_core/env";

function getForgeConfig() {
  const forgeUrl = ENV.forgeApiUrl;
  const forgeKey = ENV.forgeApiKey;
  if (!forgeUrl || !forgeKey) throw new Error("Storage config missing: set BUILT_IN_FORGE_API_URL and BUILT_IN_FORGE_API_KEY");
  return { forgeUrl: forgeUrl.replace(/\/+$/, ""), forgeKey };
}

function normalizeKey(relKey: string): string { return relKey.replace(/^\/+/, ""); }
function appendHashSuffix(relKey: string): string {
  const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const lastDot = relKey.lastIndexOf(".");
  if (lastDot === -1) return `${relKey}_${hash}`;
  return `${relKey.slice(0, lastDot)}_${hash}${relKey.slice(lastDot)}`;
}

/** Existing private Manus storage retained for Baileys credential snapshots. */
export async function storagePut(relKey: string, data: Buffer | Uint8Array | string, contentType = "application/octet-stream"): Promise<{ key: string; url: string }> {
  const { forgeUrl, forgeKey } = getForgeConfig();
  const key = appendHashSuffix(normalizeKey(relKey));
  const presignUrl = new URL("v1/storage/presign/put", forgeUrl + "/");
  presignUrl.searchParams.set("path", key);
  const presignResp = await fetch(presignUrl, { headers: { Authorization: `Bearer ${forgeKey}` } });
  if (!presignResp.ok) throw new Error(`Storage presign failed (${presignResp.status}): ${await presignResp.text().catch(() => presignResp.statusText)}`);
  const { url: s3Url } = (await presignResp.json()) as { url: string };
  const blob = typeof data === "string" ? new Blob([data], { type: contentType }) : new Blob([data as any], { type: contentType });
  const uploadResp = await fetch(s3Url, { method: "PUT", headers: { "Content-Type": contentType }, body: blob });
  if (!uploadResp.ok) throw new Error(`Storage upload to S3 failed (${uploadResp.status})`);
  return { key, url: `/manus-storage/${key}` };
}

export async function storageGet(relKey: string) { const key = normalizeKey(relKey); return { key, url: `/manus-storage/${key}` }; }

export async function storageGetSignedUrl(relKey: string) {
  const { forgeUrl, forgeKey } = getForgeConfig();
  const getUrl = new URL("v1/storage/presign/get", forgeUrl + "/");
  getUrl.searchParams.set("path", normalizeKey(relKey));
  const response = await fetch(getUrl, { headers: { Authorization: `Bearer ${forgeKey}` } });
  if (!response.ok) throw new Error(`Storage signed URL failed (${response.status})`);
  const { url } = (await response.json()) as { url: string };
  return url;
}

/** New business documents live in the external Supabase private bucket. */
export async function knowledgeStoragePut(organizationId: string, fileName: string, data: Buffer, contentType: string) {
  const path = `${organizationId}/${crypto.randomUUID()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
  const { error } = await getSupabaseAdmin().storage.from("knowledge-documents").upload(path, data, { contentType, upsert: false });
  if (error) throw error;
  return { key: path };
}
