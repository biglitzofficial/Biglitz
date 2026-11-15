import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";
import { createMemoryNotifier } from "./services/notifier.js";
import type { AppContext } from "./context.js";

// Smoke test with no Firestore access (health + 404 do not touch the database).
const ctx = {
  env: loadEnv({ NODE_ENV: "test" }),
  db: {} as AppContext["db"],
  tokens: { mint: async () => "t", verify: async () => "x" },
  files: { uploadUrl: async () => "", exists: async () => true, downloadUrl: async () => "", save: async () => {} },
  notifier: createMemoryNotifier(),
  clock: () => new Date(),
  bcryptCost: 4,
} satisfies AppContext;
const app = buildApp(ctx);

describe("api skeleton", () => {
  it("GET /health", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it("unknown routes return { code, message }", async () => {
    const res = await app.inject({ method: "GET", url: "/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ code: "NOT_FOUND", message: expect.any(String) });
  });

  it("protected routes reject missing tokens with { code, message }", async () => {
    const res = await app.inject({ method: "GET", url: "/api/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ code: "UNAUTHORIZED", message: expect.any(String) });
  });
});
