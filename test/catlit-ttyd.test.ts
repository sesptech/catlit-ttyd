// Smoke tests for the catlit-ttyd component.
//
// These run under jsdom-style happy-dom which has no WebSocket or
// canvas; we exercise registration, property defaults, and the URL
// resolver. Full integration coverage (real WebSocket round-trip)
// belongs in a browser-mode test that points at a live ttyd, and is
// out of scope for the unit suite.

import { describe, it, expect, beforeAll } from "vitest";
import { CatlitTtyd, defineCatlitTtyd } from "../src/catlit-ttyd.js";

beforeAll(() => {
  defineCatlitTtyd();
});

describe("catlit-ttyd registration", () => {
  it("registers the default tag", () => {
    expect(customElements.get("catlit-ttyd")).toBeDefined();
  });

  it("is idempotent", () => {
    defineCatlitTtyd();
    defineCatlitTtyd();
    expect(customElements.get("catlit-ttyd")).toBeDefined();
  });

  it("accepts a custom tag name", () => {
    defineCatlitTtyd("my-test-terminal");
    expect(customElements.get("my-test-terminal")).toBeDefined();
  });
});

describe("catlit-ttyd property defaults", () => {
  it("exposes documented defaults", () => {
    const el = document.createElement("catlit-ttyd") as CatlitTtyd;
    expect(el.wsUrl).toBe("/ws");
    expect(el.tokenUrl).toBe("/token");
    expect(el.reconnect).toBe(true);
    expect(el.reconnectDelayMs).toBe(1000);
    expect(el.fontSize).toBe(14);
    expect(el.scrollback).toBe(5000);
    expect(el.fontLoadTimeoutMs).toBe(1500);
    expect(el.cursorBlink).toBe(true);
    expect(el.acceptServerPreferences).toBe(false);
    expect(el.state).toBe("idle");
  });
});

describe("catlit-ttyd attribute reflection", () => {
  it("reads ws-url and token-url from attributes", async () => {
    const el = document.createElement("catlit-ttyd") as CatlitTtyd;
    el.setAttribute("ws-url", "/my/ws");
    el.setAttribute("token-url", "/my/token");
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.wsUrl).toBe("/my/ws");
    expect(el.tokenUrl).toBe("/my/token");
    document.body.removeChild(el);
  });

  it("reflects font-load-timeout-ms attribute", async () => {
    const el = document.createElement("catlit-ttyd") as CatlitTtyd;
    el.setAttribute("font-load-timeout-ms", "500");
    document.body.appendChild(el);
    await el.updateComplete;
    expect(el.fontLoadTimeoutMs).toBe(500);
    document.body.removeChild(el);
  });
});
