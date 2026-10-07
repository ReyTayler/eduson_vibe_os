import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import Fastify from "fastify";
import {
  createChatNames,
  migrateChatNames,
  localChatName,
  normalizeChatName,
  redactTitleContext,
  modelChatName,
  registerTitleSuggestion,
} from "../api/chat-names.mjs";
import { requestChatTitle } from "../../../services/workspace-broker/chat-title.mjs";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,user_id TEXT); CREATE TABLE chats(id TEXT PRIMARY KEY,project_id TEXT,name TEXT,cursor INTEGER,reasoning_mode TEXT,created INTEGER,updated INTEGER); CREATE TABLE messages(id TEXT PRIMARY KEY,chat_id TEXT,role TEXT,text TEXT,created INTEGER);",
  );
  db.prepare(
    "INSERT INTO projects VALUES('p','Космическая игра','student1')",
  ).run();
  db.prepare("INSERT INTO chats VALUES(?,?,?,7,'high',1,2)").run(
    "c",
    "p",
    "Первый разговор",
  );
  return db;
}
const add = (db, id = "m", text = "Создай космическую игру на Python") =>
  db.prepare("INSERT INTO messages VALUES(?,'c','user',?,1)").run(id, text);
const chat = (db) =>
  db
    .prepare(
      "SELECT c.*,p.name project_name FROM chats c JOIN projects p ON p.id=c.project_id WHERE c.id='c'",
    )
    .get();
const tick = (ms = 8) => new Promise((r) => setTimeout(r, ms));
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail("Background title did not finish");
}
test("Additive migration preserves user data, custom names, reasoning and cursors; idempotent", () => {
  const db = fixture();
  add(db);
  db.prepare(
    "INSERT INTO chats VALUES('manual','p','🎮 Моя игра',21,'off',3,4)",
  ).run();
  db.prepare(
    "INSERT INTO chats VALUES('empty','p','Новый разговор',0,'max',5,6)",
  ).run();
  const before = db.prepare("SELECT * FROM messages").all();
  migrateChatNames(db);
  assert.equal(chat(db).name_source, "auto");
  assert.equal(chat(db).name_status, "queued");
  assert.equal(chat(db).cursor, 7);
  assert.equal(chat(db).reasoning_mode, "high");
  assert.equal(chat(db).updated, 2);
  assert.equal(
    db.prepare("SELECT * FROM chats WHERE id='manual'").get().name,
    "🎮 Моя игра",
  );
  assert.equal(
    db.prepare("SELECT * FROM chats WHERE id='manual'").get().name_source,
    "manual",
  );
  assert.equal(
    db.prepare("SELECT * FROM chats WHERE id='empty'").get().name,
    "Космическая игра",
  );
  const names = db.prepare("SELECT * FROM chats ORDER BY id").all();
  migrateChatNames(db);
  assert.deepEqual(db.prepare("SELECT * FROM chats ORDER BY id").all(), names);
  assert.deepEqual(db.prepare("SELECT * FROM messages").all(), before);
  db.close();
});
test("First request creates title immediately; later messages cannot change a manual name", () => {
  const db = fixture(),
    names = createChatNames({
      db,
      callBroker: async () => {
        throw new Error("unavailable");
      },
    });
  add(db);
  names.onMessage("c");
  assert.equal(chat(db).name, "Создай космическую игру на Python");
  names.manualName(
    chat(db),
    "🚀 Создаём космический платформер",
    chat(db).name_revision,
  );
  add(db, "m2", "Исправь ошибки прыжка");
  names.onMessage("c");
  assert.equal(chat(db).name, "🚀 Создаём космический платформер");
  assert.equal(chat(db).name_status, "ready");
  names.close();
  db.close();
});
test("Background generation waits for main Harness queue and preserves all messages", async () => {
  const db = fixture();
  add(db);
  let busy = true,
    calls = 0;
  const names = createChatNames({
    db,
    isBusy: () => busy,
    retryMs: 5,
    callBroker: async (p) => {
      calls++;
      assert.equal(p.op, "chat-title");
      assert.equal(p.project, "p");
      return { title: "Создаём игру про космос" };
    },
  });
  const before = db.prepare("SELECT * FROM messages").all();
  names.schedule();
  await tick(25);
  assert.equal(calls, 0);
  assert.equal(chat(db).name_status, "queued");
  busy = false;
  await until(() => chat(db).name_status === "ready");
  assert.equal(calls, 1);
  assert.equal(chat(db).name, "Создаём игру про космос");
  assert.deepEqual(db.prepare("SELECT * FROM messages").all(), before);
  names.close();
  db.close();
});
test("A late model response cannot overwrite a manual title", async () => {
  const db = fixture();
  add(db);
  let resolve;
  const names = createChatNames({
    db,
    retryMs: 5,
    callBroker: () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  names.schedule();
  await until(() => !!resolve);
  assert.equal(chat(db).name_status, "generating");
  names.manualName(chat(db), "🐍 Учимся Python вместе", chat(db).name_revision);
  resolve({ title: "Создаём космическую игру" });
  await until(() => names.pending() === 0);
  assert.equal(chat(db).name, "🐍 Учимся Python вместе");
  assert.equal(chat(db).name_source, "manual");
  assert.equal(chat(db).name_status, "ready");
  names.close();
  db.close();
});
test("Suggestions are read-only and simultaneous requests share one billed call", async () => {
  const db = fixture();
  add(db);
  let resolve,
    calls = 0;
  const names = createChatNames({
    db,
    callBroker: () => {
      calls++;
      return new Promise((r) => {
        resolve = r;
      });
    },
  });
  const before = chat(db),
    messages = db.prepare("SELECT * FROM messages").all();
  const a = names.suggest(chat(db)),
    b = names.suggest(chat(db));
  assert.equal(calls, 1);
  resolve({ title: "Создаём космическую игру" });
  assert.deepEqual(await a, await b);
  assert.deepEqual(chat(db), before);
  assert.deepEqual(db.prepare("SELECT * FROM messages").all(), messages);
  names.close();
  db.close();
});
test("Empty, busy and exhausted-budget suggestions use local names without altering chats", async () => {
  const db = fixture();
  let calls = 0,
    busy = false;
  const names = createChatNames({
    db,
    isBusy: () => busy,
    callBroker: async () => {
      calls++;
      throw new Error("AI_BUDGET_EXHAUSTED");
    },
  });
  let suggestion = await names.suggest(chat(db));
  assert.equal(suggestion.reason, "empty");
  assert.equal(calls, 0);
  add(db);
  busy = true;
  suggestion = await names.suggest(chat(db));
  assert.equal(suggestion.reason, "busy");
  assert.equal(calls, 0);
  busy = false;
  suggestion = await names.suggest(chat(db));
  assert.equal(suggestion.reason, "budget");
  assert.equal(calls, 1);
  assert.equal(suggestion.source, "local");
  assert.equal(chat(db).name_status, "idle");
  names.close();
  db.close();
});
test("Title suggestions cannot leak secrets or unlimited history; malformed model output falls back", async () => {
  const db = fixture();
  add(
    db,
    "m",
    "Создай игру.\napi_key=sk-abcdefghijklmnopqrstuvwxyz1234567890\n" +
      "🐧".repeat(3000),
  );
  let seen;
  const names = createChatNames({
    db,
    callBroker: async (p) => {
      seen = p.context;
      return { title: "Ответ:\nСекретное название" };
    },
  });
  const result = await names.suggest(chat(db));
  assert.equal(result.source, "local");
  assert.ok(Buffer.byteLength(seen) <= 12000);
  assert.ok(!seen.includes("sk-"));
  assert.ok(!seen.includes("api_key"));
  assert.equal(
    modelChatName("Создаём игру про космос\n"),
    "Создаём игру про космос",
  );
  assert.equal(modelChatName("<script>alert(1)</script>"), null);
  assert.ok(
    !redactTitleContext("API key: abc\npassword: xyz\nРисуем космос").includes(
      "abc",
    ),
  );
  names.close();
  db.close();
});
test("Optimistic rename detects conflicts, permits emoji, and rejects invalid titles", () => {
  const db = fixture(),
    names = createChatNames({
      db,
      callBroker: async () => ({ title: "Название для чата" }),
    });
  const old = chat(db);
  names.manualName(old, "🎨 Рисуем своё созвездие", old.name_revision);
  assert.throws(
    () => names.manualName(old, "Другое название", old.name_revision),
    { message: "CHAT_NAME_CHANGED" },
  );
  assert.equal(chat(db).name, "🎨 Рисуем своё созвездие");
  assert.throws(() => normalizeChatName(" \n "), { message: "INVALID_INPUT" });
  assert.throws(() => normalizeChatName("a".repeat(81)), {
    message: "INVALID_INPUT",
  });
  assert.ok(localChatName("🐧 Шаги Python").length <= 65);
  names.close();
  db.close();
});
test("Interrupted automatic requests are not retried after startup", () => {
  const db = fixture();
  add(db);
  migrateChatNames(db);
  db.exec("UPDATE chats SET name_status='generating'");
  let calls = 0;
  const names = createChatNames({
    db,
    callBroker: async () => {
      calls++;
      return { title: "Новый вариант названия" };
    },
  });
  names.schedule();
  assert.equal(chat(db).name_status, "fallback");
  assert.equal(calls, 0);
  names.close();
  db.close();
});
test("Suggestion route checks ownership, rejects injected fields, and never accepts a billing student", async (t) => {
  const db = fixture();
  add(db);
  let calls = 0;
  const names = createChatNames({
    db,
    callBroker: async () => {
      calls++;
      return { title: "Создаём игру про космос" };
    },
  });
  const app = Fastify();
  app.setErrorHandler((e, q, r) =>
    r.code(e.statusCode ?? 500).send({ error: e.message }),
  );
  app.addHook("onRequest", async (req) => {
    req.student = { user_id: req.headers["x-user"] ?? "student1" };
  });
  registerTitleSuggestion({
    app,
    names,
    ownChat: (u, id) => {
      const c = chat(db);
      if (id !== c.id || u.user_id !== "student1")
        throw Object.assign(new Error("NOT_FOUND"), { statusCode: 404 });
      return c;
    },
    fields: (v, allowed) => {
      if (
        !v ||
        Array.isArray(v) ||
        Object.keys(v).some((k) => !allowed.includes(k))
      )
        throw Object.assign(new Error("INVALID_INPUT"), { statusCode: 400 });
    },
    rate: () => {},
  });
  t.after(async () => {
    await app.close();
    names.close();
    db.close();
  });
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/chats/c/title-suggestion",
        payload: {},
        headers: { "x-user": "student2" },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/chats/c/title-suggestion",
        payload: { student: 2 },
      })
    ).statusCode,
    400,
  );
  assert.equal(calls, 0);
  const result = await app.inject({
    method: "POST",
    url: "/api/chats/c/title-suggestion",
    payload: {},
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().source, "model");
  assert.equal(calls, 1);
});
async function mockGateway(t, handler) {
  const dir = await mkdtemp(path.join(tmpdir(), "chat-title-")),
    socketPath = path.join(dir, "gateway.sock"),
    server = http.createServer(handler);
  await new Promise((r) => server.listen(socketPath, r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  return socketPath;
}
const event = (v) => "data: " + JSON.stringify(v) + "\r\n\r\n";
const params = (socketPath) => ({
  student: 1,
  capability: "a".repeat(64),
  context: '{"firstRequest":"Создай игру"}',
  socketPath,
  timeoutMs: 300,
});
test("Private gateway client uses student credentials, disabled reasoning and a tiny naming call; fragmented SSE works", async (t) => {
  let request;
  const socketPath = await mockGateway(t, (req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      request = { headers: req.headers, body: JSON.parse(body), url: req.url };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const wire = Buffer.from(
        event({ type: "message_start" }) +
          event({
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Создаём " },
          }) +
          event({
            type: "content_block_delta",
            delta: { type: "text_delta", text: "космическую игру" },
          }) +
          event({ type: "message_stop" }),
      );
      for (let i = 0; i < wire.length; i += 5)
        res.write(wire.subarray(i, i + 5));
      res.end();
    });
  });
  assert.equal(
    await requestChatTitle(params(socketPath)),
    "Создаём космическую игру",
  );
  assert.equal(request.headers["x-vibe-credential"], "20");
  assert.equal(request.headers.authorization, "Bearer " + "a".repeat(64));
  assert.match(request.headers["x-vibe-request-id"], /^[a-f0-9-]{36}$/);
  assert.equal(request.body.max_tokens, 128);
  assert.deepEqual(request.body.thinking, { type: "disabled" });
  assert.equal(request.url, "/v1/messages");
  assert.equal(request.body.model, "deepseek-flash");
  assert.equal(request.body.messages.length, 1);
  assert.ok(!request.body.tools);
});
for (const [name, handler] of [
  [
    "provider rejection",
    (q, r) => {
      r.writeHead(429, { "Content-Type": "application/json" });
      r.end('{"error":"redacted"}');
    },
  ],
  [
    "incomplete stream",
    (q, r) => {
      r.writeHead(200, { "Content-Type": "text/event-stream" });
      r.end(
        event({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Название" },
        }),
      );
    },
  ],
  [
    "truncated title",
    (q, r) => {
      r.writeHead(200, { "Content-Type": "text/event-stream" });
      r.end(
        event({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Название" },
        }) +
          event({
            type: "message_delta",
            delta: { stop_reason: "max_tokens" },
          }) +
          event({ type: "message_stop" }),
      );
    },
  ],
  [
    "provider SSE error",
    (q, r) => {
      r.writeHead(200, { "Content-Type": "text/event-stream" });
      r.end(event({ type: "error", error: { message: "private" } }));
    },
  ],
  ["timeout", (q, r) => {}],
  [
    "oversized stream",
    (q, r) => {
      r.writeHead(200, { "Content-Type": "text/event-stream" });
      r.end("x".repeat(65537));
    },
  ],
])
  test("Private gateway safely rejects " + name, async (t) => {
    const socketPath = await mockGateway(t, handler);
    await assert.rejects(
      requestChatTitle({ ...params(socketPath), timeoutMs: 60 }),
      { message: "TITLE_MODEL_UNAVAILABLE" },
    );
  });
test("Invalid naming credentials or oversized input never reach gateway", async () => {
  await assert.rejects(
    requestChatTitle({ ...params("/nonexistent"), student: 6 }),
    { message: "TITLE_INPUT_INVALID" },
  );
  await assert.rejects(
    requestChatTitle({ ...params("/nonexistent"), context: "x".repeat(12001) }),
    { message: "TITLE_INPUT_INVALID" },
  );
});
