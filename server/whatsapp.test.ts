import { describe, expect, it } from "vitest";
import { getMissingWhatsAppConfig, isWhatsAppConfigured } from "./whatsapp";

describe("direct Baileys WhatsApp Web runtime", () => {
  it("does not require Evolution, Meta, or webhook credentials", () => {
    expect(getMissingWhatsAppConfig()).toEqual([]);
    expect(isWhatsAppConfigured()).toBe(true);
  });
});
