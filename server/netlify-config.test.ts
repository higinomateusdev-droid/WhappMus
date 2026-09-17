import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const backend = "https://turnlab-cpdvt4bt.manus.space/api/:splat";

describe("Netlify frontend-to-backend routing", () => {
  it("places the API proxy before the SPA fallback in _redirects", () => {
    const redirects = readFileSync("client/public/_redirects", "utf8").trim().split(/\r?\n/);
    expect(redirects).toEqual([
      `/api/* ${backend} 200`,
      "/* /index.html 200",
    ]);
  });

  it("declares the API proxy before the SPA fallback in netlify.toml", () => {
    const config = readFileSync("netlify.toml", "utf8");
    const apiProxy = config.indexOf('from = "/api/*"');
    const spaFallback = config.indexOf('from = "/*"');
    expect(apiProxy).toBeGreaterThanOrEqual(0);
    expect(spaFallback).toBeGreaterThan(apiProxy);
    expect(config).toContain(`to = "${backend}"`);
  });
});
