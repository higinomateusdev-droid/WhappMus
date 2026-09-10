import { afterEach, describe, expect, it } from "vitest";
import { getMissingWhatsAppConfig, isWhatsAppConfigured, verifyWebhookToken } from "./whatsapp";

const original = {
  apiUrl: process.env.WHATSAPP_API_URL,
  apiKey: process.env.WHATSAPP_API_KEY,
  instanceName: process.env.WHATSAPP_INSTANCE_NAME,
  webhookSecret: process.env.WHATSAPP_WEBHOOK_SECRET,
};

afterEach(() => {
  for (const [key, value] of Object.entries({
    WHATSAPP_API_URL: original.apiUrl,
    WHATSAPP_API_KEY: original.apiKey,
    WHATSAPP_INSTANCE_NAME: original.instanceName,
    WHATSAPP_WEBHOOK_SECRET: original.webhookSecret,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("WhatsApp adapter configuration", () => {
  it("reports the required server-side variables when the connector is not configured", () => {
    delete process.env.WHATSAPP_API_URL;
    delete process.env.WHATSAPP_API_KEY;
    delete process.env.WHATSAPP_INSTANCE_NAME;

    expect(getMissingWhatsAppConfig()).toEqual([
      "WHATSAPP_API_URL",
      "WHATSAPP_API_KEY",
      "WHATSAPP_INSTANCE_NAME",
    ]);
    expect(isWhatsAppConfigured()).toBe(false);
  });

  it("treats a complete connector configuration as ready", () => {
    process.env.WHATSAPP_API_URL = "https://provider.example.test";
    process.env.WHATSAPP_API_KEY = "server-only-key";
    process.env.WHATSAPP_INSTANCE_NAME = "turnstark-main";

    expect(getMissingWhatsAppConfig()).toEqual([]);
    expect(isWhatsAppConfigured()).toBe(true);
  });
});

describe("WhatsApp webhook verification", () => {
  it("accepts only the configured verification token", () => {
    process.env.WHATSAPP_WEBHOOK_SECRET = "turnstark-secret";
    expect(verifyWebhookToken("turnstark-secret")).toBe(true);
    expect(verifyWebhookToken("wrong-secret")).toBe(false);
    expect(verifyWebhookToken(undefined)).toBe(false);
  });
});
