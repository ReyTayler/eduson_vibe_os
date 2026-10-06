/** Monetary accounting and actual gateway SSE; all providers here are offline fixtures. */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import http from "node:http";
import { Ledger, weekWindow } from "../services/model-gateway/ledger.mjs";
import { CreditLedger } from "../services/model-gateway/credit-ledger.mjs";
import { createGateway } from "../services/model-gateway/server.mjs";
import {
  ratesAt,
  ratesForWindow,
  nanoCost,
  PEAK,
  OFF_PEAK,
  PRICING_VERSION,
} from "../services/model-gateway/pricing.mjs";
import { classifyRunFailure } from "../services/workspace-broker/run-errors.mjs";
const now = Date.parse("2026-10-07T09:00:00Z"),
  actor = "a".repeat(32);
const grant = (l, over = {}) => ({
  id: randomUUID(),
  student: 1,
  credits: 2000,
  actor,
  note: "Owner request +$2",
  periodStart: weekWindow(l.clock()).start,
  ...over,
});
const usage = (input = 10, cacheRead = 0, output = 20, cacheWrite = 0) => ({
  input,
  cacheRead,
  cacheWrite,
  output,
  total: input + cacheRead + cacheWrite + output,
});
function admitted(l, student = 1, input = 100000, output = 393216) {
  const id = randomUUID(),
    reserve = l.reserveOutput(
      id,
      19 + student,
      "fixture",
      input,
      output,
      student,
    );
  return { id, reserve };
}
function memory(t) {
  const l = new CreditLedger(":memory:", { clock: () => now });
  t.after(() => l.close());
  return l;
}
test("The 503326-token run costs 0.006332484 USD; cache is billed independently", () => {
  assert.equal(nanoCost(usage(3078, 492928, 7320), OFF_PEAK), 6332484);
  assert.equal(nanoCost(usage(3078, 492928, 7320), PEAK), 12664968);
  assert.equal(nanoCost(usage(100, 100, 100, 100), OFF_PEAK), 90300);
});
test("UTC peak boundaries map to 04-07/09-13 Moscow; holidays and weekends are off peak", () => {
  for (const [at, band] of [
    ["2026-10-08T00:59:59.999Z", "off_peak"],
    ["2026-10-08T01:00:00Z", "peak"],
    ["2026-10-08T03:59:59.999Z", "peak"],
    ["2026-10-08T04:00:00Z", "off_peak"],
    ["2026-10-08T05:59:59.999Z", "off_peak"],
    ["2026-10-08T06:00:00Z", "peak"],
    ["2026-10-08T09:59:59.999Z", "peak"],
    ["2026-10-08T10:00:00Z", "off_peak"],
    ["2026-10-07T09:00:00Z", "off_peak"],
    ["2026-10-10T02:00:00Z", "off_peak"],
    ["2026-05-04T02:00:00Z", "off_peak"],
    ["2026-02-16T09:00:00Z", "off_peak"],
    ["2026-06-19T02:00:00Z", "off_peak"],
    ["2026-09-25T09:00:00Z", "off_peak"],
  ])
    assert.equal(ratesAt(Date.parse(at)).band, band, at);
  assert.equal(ratesAt(Date.parse("2027-01-04T02:00:00Z")).band, "peak");
  assert.equal(
    ratesAt(Date.parse("2027-01-04T02:00:00Z")).calendarVerified,
    false,
  );
});
test("Tariff crossing settles conservatively at the highest rate encountered", () => {
  const from = Date.parse("2026-10-08T00:59:00Z"),
    to = Date.parse("2026-10-08T01:00:01Z");
  assert.equal(ratesForWindow(from, to).band, "peak");
  assert.equal(
    ratesForWindow(
      Date.parse("2026-10-08T03:59:59Z"),
      Date.parse("2026-10-08T04:00:01Z"),
    ).band,
    "peak",
  );
  assert.equal(ratesForWindow(now, now + 3600000).band, "off_peak");
  assert.throws(() => ratesForWindow(to, from), /PRICING_CLOCK_INVALID/);
});
test("Reserve is peak-priced; settlement refunds the unused envelope, with exact integer nano-USD", (t) => {
  const l = memory(t),
    { id, reserve } = admitted(l, 1, 500000, 10000);
  assert.equal(reserve.reservedCredits, 162);
  assert.equal(l.status(1).remainingCredits, 838);
  l.finish(id, "settled", usage(3078, 492928, 7320), 200);
  const b = l.status(1);
  assert.equal(b.spentCredits, 6.332484);
  assert.equal(b.costUsd, 0.006332484);
  assert.equal(b.reservedCredits, 0);
  assert.equal(b.remainingCredits, 993.667516);
  assert.equal(b.usage.totalTokens, 503326);
  assert.equal(b.usage.inputCredits, 0.4617);
  assert.equal(b.usage.cacheCredits, 1.478784);
  assert.equal(b.usage.outputCredits, 4.392);
});
test("Four cheap cached calls may exceed 1m raw tokens without exhausting the monetary budget", (t) => {
  const l = memory(t);
  for (let i = 0; i < 4; i++) {
    const { id } = admitted(l, 1, 400000);
    l.finish(id, "settled", usage(100, 399000, 10), 200);
  }
  assert.equal(l.status(1).confirmed_tokens, 1596440);
  assert.equal(l.status(1).remainingAuthorizationTokens, 0);
  assert.equal(l.status(1).remainingCredits, 995.128);
  assert.ok(l.status(1).maxRemainingCalls > 0);
  assert.ok(admitted(l).reserve.maxTokens === 393216);
});
test("Weekly dollar cap includes concurrent holds; output shrinks to the remaining money", (t) => {
  const l = memory(t),
    ids = [];
  while (l.status(1).maxRemainingCalls > 0) {
    const { id, reserve } = admitted(l, 1, 32768);
    assert.ok(reserve.maxTokens >= 1 && reserve.maxTokens <= 393216);
    ids.push(id);
  }
  assert.equal(ids.length, 3);
  assert.ok(l.status(1).reservedCredits <= 1000);
  assert.throws(() => admitted(l, 1, 32768), /CREDIT_BUDGET_EXHAUSTED/);
  assert.equal(l.status(2).remainingCredits, 1000);
  assert.throws(
    () => l.reserve(randomUUID(), 20, "fixture", 131072, 1),
    /CREDIT_ENVELOPE_REQUIRED/,
  );
});
test("Two connections cannot reserve or double-settle money concurrently", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-money-parallel-")),
    file = join(dir, "db.sqlite");
  const a = new CreditLedger(file, { clock: () => now }),
    b = new CreditLedger(file, { clock: () => now });
  t.after(() => {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const x = admitted(a, 1, 32768),
    y = admitted(b, 1, 32768),
    z = admitted(a, 1, 32768);
  assert.ok(z.reserve.maxTokens < 393216);
  assert.throws(() => admitted(b, 1, 32768), /CREDIT_BUDGET_EXHAUSTED/);
  a.finish(x.id, "settled", usage(), 200);
  assert.throws(
    () => b.finish(x.id, "settled", usage(), 200),
    /REQUEST_SETTLEMENT_CAS/,
  );
  assert.ok(b.status(1).reservedCredits < 600);
  assert.ok(y.reserve.maxTokens === 393216);
});
test("Unknown outcome retains the full money hold across restart", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-money-restart-")),
    file = join(dir, "db.sqlite");
  let l = new CreditLedger(file, { clock: () => now });
  const { id, reserve } = admitted(l);
  l.close();
  l = new CreditLedger(file, { clock: () => now });
  t.after(() => {
    l.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(
    l.db.prepare("SELECT state FROM model_requests WHERE id=?").get(id).state,
    "uncertain",
  );
  assert.equal(l.status(1).reservedCredits, reserve.reservedCredits);
  assert.equal(l.status(1).spentCredits, 0);
});
test("Pre-inference provider rejections release money; stream and 5xx outcomes remain held", (t) => {
  const l = memory(t);
  for (const status of [400, 401, 402, 403, 404, 413, 422, 429]) {
    const { id } = admitted(l);
    l.finish(id, "failed", undefined, status);
    assert.equal(l.status(1).reservedCredits, 0);
    assert.equal(l.records(1)[0].spentCredits, 0);
  }
  const { id, reserve } = admitted(l);
  l.finish(id, "failed", undefined, 503);
  assert.equal(l.status(1).reservedCredits, reserve.reservedCredits);
});
test("Provider over-reporting is accounted and disables admission globally", (t) => {
  const l = memory(t),
    { id } = admitted(l, 1, 1, 10);
  l.finish(id, "settled", usage(1, 0, 11), 200);
  assert.equal(l.status(1).enabled, false);
  assert.equal(l.status().enabled, false);
  assert.throws(() => admitted(l), /TOKEN_BUDGET_EXHAUSTED/);
});
test("Malformed usage cannot release a held envelope", (t) => {
  const l = memory(t),
    { id, reserve } = admitted(l);
  for (const bad of [
    { ...usage(), total: NaN },
    { ...usage(), total: 1 },
    { ...usage(), output: -1, total: 9 },
    { ...usage(), extra: 1 },
    { ...usage(), input: "10" },
  ])
    assert.throws(() => l.finish(id, "settled", bad, 200), /INVALID_USAGE/);
  assert.equal(l.status(1).reservedCredits, reserve.reservedCredits);
});
test("Migration prices historical usage once and preserves token grants and original journal rows", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-money-migration-")),
    file = join(dir, "db.sqlite");
  let old = new Ledger(file, { clock: () => now });
  const gid = randomUUID(),
    rid = randomUUID(),
    periodStart = weekWindow(now).start;
  old.grant({
    id: gid,
    student: 1,
    tokens: 2000000,
    actor,
    note: "Legacy",
    periodStart,
  });
  old.reserveOutput(rid, 20, "fixture", 500000, 10000, 1);
  old.finish(rid, "settled", usage(3078, 492928, 7320), 200);
  const rows = old.db.prepare("SELECT * FROM model_requests").all();
  old.close();
  let l = new CreditLedger(file, { clock: () => now });
  assert.deepEqual(l.db.prepare("SELECT * FROM model_requests").all(), rows);
  assert.equal(l.status(1).limitCredits, 1000);
  assert.equal(l.status(1).spentCredits, 6.332484);
  assert.equal(l.grants(1)[0].tokens, 2000000);
  assert.equal(l.grants(1)[0].archived, true);
  l.close();
  l = new CreditLedger(file, { clock: () => now + 604800000 });
  t.after(() => {
    l.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(
    l.db
      .prepare("SELECT actual_nanos FROM credit_requests WHERE request_id=?")
      .get(rid).actual_nanos,
    6332484,
  );
  assert.equal(
    l.db.prepare("SELECT count(*) n FROM credit_requests").get().n,
    1,
  );
  assert.equal(l.status(1).spentCredits, 0);
  assert.throws(() => l.grant(grant(l, { id: gid })), /GRANT_REQUEST_CONFLICT/);
});
test("Only student01 gets +2000 credits; idempotency and append-only history survive restart", (t) => {
  const l = memory(t),
    body = grant(l),
    r = l.grant(body);
  assert.equal(r.budget.limitCredits, 3000);
  assert.equal(r.budget.extraLimitCredits, 2000);
  for (let i = 2; i <= 5; i++) assert.equal(l.status(i).limitCredits, 1000);
  assert.equal(l.status().unit, "tokens");
  assert.equal(l.grant(body).replayed, true);
  for (const over of [
    { credits: 1000 },
    { student: 2 },
    { actor: "b".repeat(32) },
    { note: "changed" },
    { periodStart: body.periodStart - 604800 },
  ])
    assert.throws(
      () => l.grant({ ...body, ...over }),
      /GRANT_REQUEST_CONFLICT/,
    );
  assert.equal(l.grants(1).length, 1);
  assert.throws(
    () =>
      l.db
        .prepare("UPDATE weekly_credit_grants SET nanos=1 WHERE id=?")
        .run(body.id),
    /GRANTS_APPEND_ONLY/,
  );
  assert.throws(
    () =>
      l.db.prepare("DELETE FROM weekly_credit_grants WHERE id=?").run(body.id),
    /GRANTS_APPEND_ONLY/,
  );
});
test("Bonus expires exactly Sunday 23:59 Moscow; late settlement stays in the original week", (t) => {
  let clock = Date.parse("2026-10-11T20:58:59Z");
  const l = new CreditLedger(":memory:", { clock: () => clock });
  t.after(() => l.close());
  const body = grant(l),
    r = l.grant(body),
    { id } = admitted(l);
  assert.equal(r.grant.expiresAt, "2026-10-11T20:59:00.000Z");
  clock += 1000;
  assert.equal(l.status(1).limitCredits, 1000);
  l.finish(id, "settled", usage(), 200);
  assert.equal(l.status(1).spentCredits, 0);
  assert.equal(l.status(1).reservedCredits, 0);
  assert.equal(l.grant(body).replayed, true);
  assert.equal(l.status(1).limitCredits, 1000);
  assert.equal(l.moneyTotals(1, body.periodStart).spent, 13500);
  assert.throws(
    () => l.grant({ ...body, id: randomUUID() }),
    /GRANT_WINDOW_CHANGED/,
  );
});
test("Money grants reject invalid amounts and clock rollback without changing balances", (t) => {
  let clock = now;
  const l = new CreditLedger(":memory:", { clock: () => clock });
  t.after(() => l.close());
  for (const value of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER, "2000"])
    assert.throws(
      () => l.grant(grant(l, { credits: value })),
      /GRANT_INPUT_INVALID/,
    );
  for (const student of [null, 0, 6, "1"])
    assert.throws(() => l.grant(grant(l, { student })));
  clock += 604800000;
  l.grant(grant(l));
  clock = now;
  assert.equal(l.status(1).enabled, false);
  assert.throws(() => l.grant(grant(l)), /BUDGET_CLOCK_ROLLBACK/);
});
test("Peak-priced settlement does not exceed the reserve if a call crosses a tariff boundary", (t) => {
  let clock = Date.parse("2026-10-08T00:59:59Z");
  const l = new CreditLedger(":memory:", { clock: () => clock });
  t.after(() => l.close());
  const { id, reserve } = admitted(l, 1, 100000, 10000);
  clock += 2000;
  l.finish(id, "settled", usage(100, 99000, 1000), 200);
  assert.equal(l.records(1)[0].band, "peak");
  assert.equal(l.status(1).spentCredits, 1.824);
  assert.ok(l.status(1).spentCredits < reserve.reservedCredits);
  assert.equal(l.status(1).enabled, true);
});
test("Status uses one wall-clock snapshot at the weekly boundary", (t) => {
  let ticks = 0;
  const at = Date.parse("2026-10-11T20:58:59Z"),
    l = new CreditLedger(":memory:", { clock: () => at });
  t.after(() => l.close());
  l.grant(grant(l));
  l.clock = () => at + (ticks++ === 0 ? 0 : 1000);
  const b = l.status(1);
  assert.equal(ticks, 1);
  assert.equal(b.limitCredits, 3000);
  assert.equal(b.resetsAt, "2026-10-11T20:59:00.000Z");
});
test("Credit failures retain their safe classification through the native broker", () => {
  assert.deepEqual(
    classifyRunFailure("School gateway: CREDIT_BUDGET_EXHAUSTED"),
    { code: "AI_WEEKLY_CREDITS_EXHAUSTED", reason: "CREDIT_BUDGET_EXHAUSTED" },
  );
});
test("Actual gateway SSE settles cached input/output; only root operator may read usage and grant credits", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-money-gateway-")),
    socket = join(dir, "gw.sock");
  const ledger = new CreditLedger(":memory:", { clock: () => now }),
    cap = "b".repeat(64),
    operator = "c".repeat(64);
  let calls = 0,
    mode = "success";
  const server = createGateway({
    ledger,
    capability: operator,
    studentCapabilities: [{ student: 1, capability: cap }],
    vault: { get: () => "offline-fixture-no-api-key", metadata: () => [] },
    fetchImpl: async (_url, options) => {
      calls++;
      const body = JSON.parse(options.body);
      assert.equal(body.metadata.user_id, "vibe-student-1");
      if (mode === "reject")
        return Response.json({ error: "fixture" }, { status: 429 });
      if (mode === "partial")
        return new Response(
          'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        );
      const events = [
        {
          type: "message_start",
          message: {
            usage: {
              input_tokens: 100,
              cache_read_input_tokens: 10000,
              cache_creation_input_tokens: 0,
              output_tokens: 0,
            },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 200 },
        },
        { type: "message_stop" },
      ];
      return new Response(
        events
          .map(
            (e) => "event: " + e.type + "\ndata: " + JSON.stringify(e) + "\n\n",
          )
          .join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      );
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
  const request = (path, capability, body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: socket,
          path,
          method: body ? "POST" : "GET",
          headers: {
            Authorization: "Bearer " + capability,
            "Content-Type": "application/json",
            "X-Vibe-Credential": "20",
            "X-Vibe-Request-Id": randomUUID(),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("error", reject);
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              text: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body ? JSON.stringify(body) : "");
    });
  const body = {
    model: "deepseek-flash",
    stream: true,
    max_tokens: 393216,
    thinking: { type: "disabled" },
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };
  const success = await request("/v1/messages", cap, body);
  assert.equal(success.status, 200);
  assert.match(success.text, /message_stop/);
  assert.equal(ledger.status(1).spentCredits, 0.165);
  assert.equal(ledger.status(1).usage.cacheReadTokens, 10000);
  assert.equal(ledger.status(1).reservedCredits, 0);
  for (const path of [
    "/v1/admin/overview",
    "/v1/admin/usage?student=1",
    "/v1/admin/grants?student=1",
    "/v1/admin/grants",
  ])
    assert.equal(
      (
        await request(
          path,
          cap,
          path.endsWith("/grants") ? grant(ledger) : undefined,
        )
      ).status,
      403,
    );
  const credited = await request("/v1/admin/grants", operator, grant(ledger));
  assert.equal(credited.status, 200);
  assert.equal(JSON.parse(credited.text).budget.limitCredits, 3000);
  assert.equal(
    (
      await request("/v1/admin/grants", operator, {
        ...grant(ledger),
        tokens: 2000,
      })
    ).status,
    400,
  );
  const records = await request("/v1/admin/usage?student=1", operator);
  assert.equal(JSON.parse(records.text)[0].spentCredits, 0.165);
  mode = "reject";
  await request("/v1/messages", cap, body);
  assert.equal(ledger.status(1).reservedCredits, 0);
  mode = "partial";
  const partial = await request("/v1/messages", cap, body);
  assert.match(partial.text, /PROVIDER_STREAM_INCOMPLETE/);
  assert.ok(ledger.status(1).reservedCredits > 470);
  assert.equal(calls, 3);
});

test("Credit grants and snapshots survive restart with idempotency and pricing mismatch fails closed", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-credit-grants-")),
    file = join(dir, "db.sqlite");
  let l = new CreditLedger(file, { clock: () => now });
  const body = grant(l);
  l.grant(body);
  const { id } = admitted(l);
  l.finish(id, "settled", usage(), 200);
  l.close();
  l = new CreditLedger(file, { clock: () => now });
  assert.equal(l.status(1).limitCredits, 3000);
  assert.equal(l.status(1).spentCredits, 0.0135);
  assert.equal(l.grant(body).replayed, true);
  assert.equal(l.grants(1).length, 1);
  l.db
    .prepare("UPDATE credit_policy SET pricing_version='invalid' WHERE id=1")
    .run();
  l.close();
  assert.throws(
    () => new CreditLedger(file, { clock: () => now }),
    /CREDIT_PRICING_VERSION_MISMATCH/,
  );
  rmSync(dir, { recursive: true, force: true });
});
