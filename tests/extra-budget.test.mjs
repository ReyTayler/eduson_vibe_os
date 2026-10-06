import test from "node:test";
import assert from "node:assert/strict";
import {
  Ledger,
  CALL_DEBIT,
  weekWindow,
} from "../services/model-gateway/ledger.mjs";
import { createGateway } from "../services/model-gateway/server.mjs";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import http from "node:http";
const actor = "a".repeat(32),
  now = Date.parse("2026-10-06T20:00:00Z");
function grant(l, overrides = {}) {
  return {
    id: randomUUID(),
    student: 1,
    tokens: 2000000,
    actor,
    note: "Extra project work",
    periodStart: weekWindow(l.clock()).start,
    ...overrides,
  };
}
test("An additional 2m applies only to the selected student and leaves usage intact", () => {
  const l = new Ledger(":memory:", { clock: () => now });
  const run = randomUUID();
  l.reserve(run, 20, "fixture", CALL_DEBIT, 1);
  l.finish(
    run,
    "settled",
    { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, total: 150 },
    200,
  );
  const r = l.grant(grant(l));
  assert.equal(r.replayed, false);
  assert.equal(r.budget.baseLimitTokens, 1000000);
  assert.equal(r.budget.extraLimitTokens, 2000000);
  assert.equal(r.budget.limitTokens, 3000000);
  assert.equal(r.budget.confirmed_tokens, 150);
  assert.equal(r.budget.remainingAuthorizationTokens, 2999850);
  for (let i = 2; i <= 5; i++) assert.equal(l.status(i).limitTokens, 1000000);
  assert.equal(l.status().limitTokens, 1000000);
  l.close();
});
test("Extra allowance is enforced by model admission after the base budget is exhausted", () => {
  const l = new Ledger(":memory:", { clock: () => now });
  for (let i = 0; i < 7; i++) {
    const id = randomUUID();
    l.reserve(id, 20, "fixture", CALL_DEBIT, 1);
    l.finish(id, "uncertain");
  }
  assert.throws(
    () => l.reserve(randomUUID(), 20, "fixture", CALL_DEBIT, 1),
    /TOKEN_BUDGET_EXHAUSTED/,
  );
  l.grant(grant(l));
  const id = randomUUID(),
    r = l.reserveOutput(id, 20, "fixture", 40000, 393216, 1);
  assert.equal(r.maxTokens, 393216);
  l.finish(
    id,
    "settled",
    { input: 10000, output: 100, cacheRead: 0, cacheWrite: 0, total: 10100 },
    200,
  );
  assert.equal(l.status(1).confirmed_tokens, 10100);
  l.close();
});
test("Double-click and retry cannot create a duplicate grant; conflicts fail atomically", () => {
  const l = new Ledger(":memory:", { clock: () => now }),
    body = grant(l);
  l.grant(body);
  assert.equal(l.grant(body).replayed, true);
  for (const overrides of [
    { tokens: 1 },
    { student: 2 },
    { actor: "b".repeat(32) },
    { note: "changed" },
    { periodStart: body.periodStart - 604800 },
  ])
    assert.throws(
      () => l.grant({ ...body, ...overrides }),
      /GRANT_REQUEST_CONFLICT/,
    );
  assert.equal(l.grants(1).length, 1);
  assert.equal(l.status(1).limitTokens, 3000000);
  l.close();
});
test("Current-week extras expire exactly on Sunday 23:59 Moscow and remain in the audit history", () => {
  let clock = Date.parse("2026-10-11T20:58:59Z");
  const l = new Ledger(":memory:", { clock: () => clock }),
    body = grant(l);
  const issued = l.grant(body);
  assert.equal(issued.grant.expiresAt, "2026-10-11T20:59:00.000Z");
  clock += 1000;
  assert.equal(l.status(1).limitTokens, 1000000);
  assert.equal(l.status(1).extraLimitTokens, 0);
  assert.equal(l.grants(1).length, 1);
  assert.equal(l.grant(body).replayed, true);
  assert.equal(l.status(1).limitTokens, 1000000);
  l.close();
});
test("A stale browser week is rejected instead of crediting a different week", () => {
  let clock = Date.parse("2026-10-11T20:58:59Z");
  const l = new Ledger(":memory:", { clock: () => clock }),
    body = grant(l);
  clock += 1000;
  assert.throws(() => l.grant(body), /GRANT_WINDOW_CHANGED/);
  assert.equal(l.grants(1).length, 0);
  l.grant(grant(l));
  assert.equal(l.status(1).limitTokens, 3000000);
  l.close();
});
test("Late settlement belongs to the original week with its original grant", () => {
  let clock = Date.parse("2026-10-11T20:58:59Z");
  const l = new Ledger(":memory:", { clock: () => clock });
  l.grant(grant(l));
  const id = randomUUID();
  l.reserveOutput(id, 20, "fixture", 40000, 393216, 1);
  clock += 1000;
  l.finish(
    id,
    "settled",
    { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, total: 110 },
    200,
  );
  assert.equal(l.status(1).confirmed_tokens, 0);
  assert.equal(l.status(1).remainingAuthorizationTokens, 1000000);
  assert.equal(
    l.totals(1, weekWindow(clock - 1000).start).confirmed_tokens,
    110,
  );
  l.close();
});
test("Invalid amounts, actor, account and unsafe total cannot alter the ledger", () => {
  const l = new Ledger(":memory:", { clock: () => now });
  for (const value of [0, -1, 1.2, NaN, Number.MAX_SAFE_INTEGER, "2000000"])
    assert.throws(
      () => l.grant(grant(l, { tokens: value })),
      /GRANT_INPUT_INVALID/,
    );
  for (const value of [0, 6, null, "1"])
    assert.throws(() => l.grant(grant(l, { student: value })));
  assert.throws(
    () => l.grant(grant(l, { actor: "browser" })),
    /GRANT_INPUT_INVALID/,
  );
  assert.throws(
    () => l.grant(grant(l, { note: "x".repeat(513) })),
    /GRANT_INPUT_INVALID/,
  );
  assert.equal(l.grants(1).length, 0);
  l.grant(grant(l));
  assert.equal(l.status(1).limitTokens, 3000000);
  l.close();
});
test("Grant records are append-only and restart preserves accounting and idempotency", () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-extra-")),
    file = join(dir, "budget.sqlite");
  let l = new Ledger(file, { clock: () => now });
  const body = grant(l);
  l.grant(body);
  assert.throws(
    () =>
      l.db.prepare("UPDATE weekly_grants SET tokens=1 WHERE id=?").run(body.id),
    /GRANTS_APPEND_ONLY/,
  );
  assert.throws(
    () => l.db.prepare("DELETE FROM weekly_grants WHERE id=?").run(body.id),
    /GRANTS_APPEND_ONLY/,
  );
  l.close();
  l = new Ledger(file, { clock: () => now });
  assert.equal(l.status(1).limitTokens, 3000000);
  assert.equal(l.grant(body).replayed, true);
  l.close();
  rmSync(dir, { recursive: true, force: true });
});
test("Grant advances the clock watermark; clock rollback cannot reopen a previous week", () => {
  let clock = now;
  const l = new Ledger(":memory:", { clock: () => clock });
  const body = grant(l);
  clock += 604800000;
  l.grant(grant(l));
  clock = now;
  assert.throws(() => l.grant(body), /BUDGET_CLOCK_ROLLBACK/);
  assert.equal(l.status(1).enabled, false);
  l.close();
});
test("Only the private operator can read all budgets and grant extra tokens; no provider is invoked", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-grant-gateway-")),
    socket = join(dir, "gateway.sock");
  const ledger = new Ledger(":memory:", { clock: () => now }),
    operator = "a".repeat(64),
    student = "b".repeat(64);
  let calls = 0;
  const server = createGateway({
    ledger,
    capability: operator,
    studentCapabilities: [{ student: 1, capability: student }],
    vault: {
      get() {
        throw new Error("Provider key must not be read");
      },
      metadata: () => [],
    },
    fetchImpl: async () => {
      calls++;
      throw new Error("No provider request allowed");
    },
  });
  server.listen(socket);
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const request = (path, cap, body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: socket,
          path,
          method: body ? "POST" : "GET",
          headers: {
            Authorization: "Bearer " + cap,
            "Content-Type": "application/json",
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("error", reject);
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              body: JSON.parse(Buffer.concat(chunks)),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body ? JSON.stringify(body) : "");
    });
  for (const path of [
    "/v1/admin/overview",
    "/v1/admin/grants?student=1",
    "/v1/admin/grants",
  ])
    assert.equal(
      (
        await request(
          path,
          student,
          path.endsWith("/grants") ? grant(ledger) : undefined,
        )
      ).status,
      403,
    );
  const body = grant(ledger),
    issued = await request("/v1/admin/grants", operator, body);
  assert.equal(issued.status, 200);
  assert.equal(issued.body.budget.limitTokens, 3000000);
  assert.equal(
    (await request("/v1/admin/grants", operator, body)).body.replayed,
    true,
  );
  assert.equal(
    (await request("/v1/admin/grants", operator, { ...body, tokens: 5 }))
      .status,
    409,
  );
  const own = await request("/v1/status", student);
  assert.equal(own.body.budget.limitTokens, 3000000);
  assert.equal(own.body.overview, undefined);
  assert.equal(
    (await request("/v1/admin/grants?student=1", operator)).body.length,
    1,
  );
  assert.equal(calls, 0);
});
