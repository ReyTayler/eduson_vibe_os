import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { DatabaseSync } from "node:sqlite";
import { hash, verify } from "@node-rs/argon2";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { registerAdmin } from "../api/admin.mjs";
import { weekWindow } from "../../../services/model-gateway/ledger.mjs";
import { CreditLedger } from "../../../services/model-gateway/credit-ledger.mjs";
const origin = "https://80.249.145.94",
  id = "a".repeat(32),
  student = "b".repeat(32),
  password = "offline-admin-password",
  now = Date.parse("2026-10-06T20:00:00Z");
test("Admin authentication, CSRF, target ownership, grants and password revocation", async (t) => {
  const app = Fastify(),
    db = new DatabaseSync(":memory:"),
    ledger = new CreditLedger(":memory:", { clock: () => now });
  db.exec(
    "PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY,login TEXT,name TEXT,student INTEGER);CREATE TABLE projects(id TEXT,user_id TEXT);",
  );
  db.prepare("INSERT INTO users VALUES(?,?,?,1)").run(
    student,
    "student01",
    "Ученик 01",
  );
  const sha = (value) => createHash("sha256").update(value).digest("hex"),
    fail = (code, statusCode = 400) =>
      Object.assign(new Error(code), { statusCode });
  const fields = (value, allowed, required = []) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((k) => !allowed.includes(k)) ||
      required.some((k) => !Object.hasOwn(value, k))
    )
      throw fail("INVALID_INPUT");
    return value;
  };
  app.setErrorHandler((error, _req, reply) =>
    reply.code(error.statusCode ?? 500).send({ error: error.message }),
  );
  const callBroker = async (p) => {
    if (p.op === "admin-budgets") return ledger.overview();
    if (p.op === "admin-usage") return ledger.records(p.student);
    if (p.op === "admin-grants") return ledger.grants(p.student);
    if (p.op === "admin-grant") {
      try {
        return ledger.grant(p.grant);
      } catch (e) {
        throw fail(e.message, e.message === "GRANT_INPUT_INVALID" ? 400 : 409);
      }
    }
    throw new Error("Unexpected operation");
  };
  registerAdmin({
    app,
    db,
    sha,
    rid: () => randomBytes(16).toString("hex"),
    fields,
    str: (s) => {
      if (typeof s !== "string") throw fail("INVALID_INPUT");
      return s;
    },
    fail,
    callBroker,
    rate: () => {},
    hash,
    verify,
    csrfSecret: Buffer.alloc(32, 1),
    origin,
  });
  db.prepare("INSERT INTO administrators VALUES(?,?,?,?,1,?)").run(
    id,
    "admin",
    "Администратор",
    await hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 }),
    now,
  );
  await app.ready();
  t.after(async () => {
    await app.close();
    db.close();
    ledger.close();
  });
  const call = (method, url, body, headers = {}) =>
    app.inject({
      method,
      url: "/api/admin" + url,
      payload: body,
      headers: { origin, ...headers },
    });
  assert.equal((await call("GET", "/students")).statusCode, 401);
  assert.equal(
    (
      await call("GET", "/students", undefined, {
        cookie: "__Host-vibe_session=" + "c".repeat(64),
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (await call("POST", "/auth/login", { login: "student01", password }))
      .statusCode,
    401,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/auth/login",
        { login: "admin", password },
        { origin: "https://evil.test" },
      )
    ).statusCode,
    403,
  );
  const login = await call("POST", "/auth/login", { login: "admin", password });
  assert.equal(login.statusCode, 200);
  const set = login.headers["set-cookie"];
  assert.match(set, /HttpOnly; Secure; SameSite=Strict/);
  const cookie = set.split(";")[0],
    me = await call("GET", "/me", undefined, { cookie });
  assert.equal(me.statusCode, 200);
  const csrf = me.json().csrf;
  const headers = { cookie, "x-csrf-token": csrf };
  const accounts = await call("GET", "/students", undefined, headers);
  assert.equal(accounts.json()[0].budget.limitCredits, 1000);
  assert.equal(
    (await call("GET", "/students/" + student + "/usage", undefined, headers))
      .statusCode,
    200,
  );
  assert.equal(
    (await call("GET", "/students/" + student + "/usage")).statusCode,
    401,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/students/" + student + "/grants",
        {
          requestId: randomUUID(),
          tokens: 2000000,
          periodStartsAt: new Date(weekWindow(now).start * 1000).toISOString(),
        },
        headers,
      )
    ).statusCode,
    400,
  );
  const body = {
    credits: 2000,
    requestId: randomUUID(),
    periodStartsAt: new Date(weekWindow(now).start * 1000).toISOString(),
    note: "Requested bonus",
  };
  assert.equal(
    (await call("POST", "/students/" + student + "/grants", body, { cookie }))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await call("POST", "/students/" + student + "/grants", body, {
        ...headers,
        origin: "https://evil.test",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/students/" + "d".repeat(32) + "/grants",
        body,
        headers,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/students/" + student + "/grants",
        { ...body, student: 2 },
        headers,
      )
    ).statusCode,
    400,
  );
  const result = await call(
    "POST",
    "/students/" + student + "/grants",
    body,
    headers,
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().budget.limitCredits, 3000);
  assert.equal(
    (
      await call("POST", "/students/" + student + "/grants", body, headers)
    ).json().replayed,
    true,
  );
  assert.equal(
    (
      await call(
        "POST",
        "/students/" + student + "/grants",
        { ...body, credits: 1000 },
        headers,
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await call("GET", "/students/" + student + "/grants", undefined, headers)
    ).json()[0].adminName,
    "Администратор",
  );
  assert.equal(
    (await call("GET", "/students", undefined, headers)).json()[0].budget
      .extraLimitCredits,
    2000,
  );
  assert.equal(
    (
      await call(
        "PATCH",
        "/me",
        { oldPassword: password, password: "new-offline-password" },
        headers,
      )
    ).statusCode,
    200,
  );
  assert.equal((await call("GET", "/me", undefined, headers)).statusCode, 401);
  assert.equal(
    (await call("POST", "/auth/login", { login: "admin", password }))
      .statusCode,
    401,
  );
  const relogin = await call("POST", "/auth/login", {
    login: "admin",
    password: "new-offline-password",
  });
  assert.equal(relogin.statusCode, 200);
  const newCookie = relogin.headers["set-cookie"].split(";")[0],
    newCsrf = (
      await call("GET", "/me", undefined, { cookie: newCookie })
    ).json().csrf;
  assert.equal(
    (
      await call(
        "POST",
        "/auth/logout",
        {},
        { cookie: newCookie, "x-csrf-token": newCsrf },
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (await call("GET", "/me", undefined, { cookie: newCookie })).statusCode,
    401,
  );
});
