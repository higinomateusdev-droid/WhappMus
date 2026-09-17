import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const backend = "https://turnlab-cpdvt4bt.manus.space";

describe("Netlify frontend-to-backend routing", () => {
  it("does not load unresolved placeholder scripts as JavaScript", () => {
    const html = readFileSync("client/index.html", "utf8");
    expect(html).not.toContain("...manus...js");
    expect(html).not.toContain('id="manus-badge" ...');
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("keeps _redirects limited to the frontend SPA fallback", () => {
    const redirects = readFileSync("client/public/_redirects", "utf8").trim().split(/\r?\n/);
    expect(redirects).toEqual(["/* /index.html 200"]);
  });

  it("configures the public backend URL at Netlify build time", () => {
    const config = readFileSync("netlify.toml", "utf8");
    expect(config).toContain("[build.environment]");
    expect(config).toContain(`VITE_API_BASE_URL = "${backend}"`);
    expect(config).not.toContain('from = "/api/*"');
  });
});
