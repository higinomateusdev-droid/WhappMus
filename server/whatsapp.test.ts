import { describe, expect, it } from "vitest";
import { getMissingWhatsAppConfig, isWhatsAppConfigured, outboundPolicy, shouldAutoReconnect, shouldRequestNewQr } from "./whatsapp";

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

  it("uses compliant outbound guardrails instead of human-mimicry", () => {
    expect(outboundPolicy("123@s.whatsapp.net", "Olá", 0)).toBe("allowed");
    expect(outboundPolicy("123@g.us", "Olá", 0)).toBe("group_messages_disabled");
    expect(outboundPolicy("123@s.whatsapp.net", "  ", 0)).toBe("empty_message");
    expect(outboundPolicy("123@s.whatsapp.net", "Olá", 100)).toBe("daily_safety_limit");
  });

  it("does not loop after a replaced or removed WhatsApp Web session", () => {
    expect(shouldAutoReconnect(440, false, 0)).toBe(false);
    expect(shouldAutoReconnect(401, false, 0)).toBe(false);
    expect(shouldAutoReconnect(428, false, 0)).toBe(true);
    expect(shouldAutoReconnect(undefined, false, 6)).toBe(false);
  });
});
