import { describe, expect, it } from "vitest";
import { getMissingWhatsAppConfig, isWhatsAppConfigured, shouldRequestNewQr } from "./whatsapp";

describe("direct Baileys WhatsApp Web runtime", () => {
  it("does not require Evolution, Meta, or webhook credentials", () => {
    expect(getMissingWhatsAppConfig()).toEqual([]);
    expect(isWhatsAppConfigured()).toBe(true);
  });

  it("reuses saved credentials without requesting a new QR", () => {
    expect(shouldRequestNewQr("connecting", true, false)).toBe(false);
    expect(shouldRequestNewQr("error", true, false)).toBe(false);
  });

  it("requests a QR only when there is no saved session or valid QR", () => {
    expect(shouldRequestNewQr("disconnected", false, false)).toBe(true);
    expect(shouldRequestNewQr("connecting", false, true)).toBe(false);
    expect(shouldRequestNewQr("connected", false, false)).toBe(false);
  });
});
