import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import { Vault } from "../packages/credentials/vault.mjs";
import { createGateway } from "../services/model-gateway/server.mjs";
import { CreditLedger } from "../services/model-gateway/credit-ledger.mjs";
import { classifyRpcFailure } from "../services/workspace-broker/run-errors.mjs";
import { apply } from "../dist/profiles/deepseek-model.js";

test("Explicit credential rotation is atomic, stays encrypted and preserves accidental-overwrite protection", () => {
  const dir = mkdtempSync(join(tmpdir(), "credential-rotation-"));
  try {
    const vault = new Vault(randomBytes(32), dir),
      old = "sk-" + "old_fixture_key_".repeat(3),
      fresh = "sk-" + "new_fixture_key_".repeat(3);
    vault.put(20, old, process.getgid());
    const prior = readFileSync(vault.file(20));
    assert.throws(() => vault.put(20, fresh, process.getgid()), {
      message: "CREDENTIAL_ALREADY_DIFFERENT",
    });
    assert.deepEqual(readFileSync(vault.file(20)), prior);
    const result = vault.put(20, fresh, process.getgid(), { replace: true });
    assert.equal(result.rotated, true);
    assert.equal(vault.get(20), fresh);
    assert.ok(!readFileSync(vault.file(20), "utf8").includes(fresh));
    assert.equal(JSON.parse(readFileSync(vault.file(20), "utf8")).id, 20);
    assert.equal(
      vault.put(20, fresh, process.getgid(), { replace: true }).existing,
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
const caps = [
  { student: 2, capability: "b".repeat(64) },
  { student: 3, capability: "c".repeat(64) },
];
const modelMeta = {
  data: [
    {
      id: "deepseek-flash",
      context_window: 1048576,
      max_output_tokens: 393216,
    },
  ],
};
function responseStream() {
  const frames = [
    {
      type: "message_start",
      message: { usage: { input_tokens: 10, output_tokens: 0 } },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "OK" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ];
  return new Response(
    frames
      .map((v) => "event: " + v.type + "\ndata: " + JSON.stringify(v) + "\n\n")
      .join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
test("Shared upstream key keeps logical student credentials, ownership and weekly budgets separate", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "provider-alias-")),
    socket = join(dir, "gateway.sock"),
    ledger = new CreditLedger(":memory:"),
    used = [];
  const key = "sk-" + "shared_fixture_".repeat(3);
  const server = createGateway({
    ledger,
    capability: "a".repeat(64),
    studentCapabilities: caps,
    providerCredentialId: 20,
    vault: {
      get(id) {
        used.push(id);
        assert.equal(id, 20);
        return key;
      },
      metadata() {
        return [];
      },
    },
    fetchImpl: async (url, options) => {
      assert.equal(
        options.headers.Authorization ?? options.headers["x-api-key"],
        url.endsWith("/models") ? "Bearer " + key : key,
      );
      return url.endsWith("/models")
        ? new Response(JSON.stringify(modelMeta), {
            headers: { "Content-Type": "application/json" },
          })
        : responseStream();
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
  const call = (student, credential, path, body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: socket,
          path,
          method: body ? "POST" : "GET",
          headers: {
            Authorization:
              "Bearer " + caps.find((v) => v.student === student).capability,
            "X-Vibe-Credential": String(credential),
            "Content-Type": "application/json",
            "X-Vibe-Request-Id": randomUUID(),
          },
        },
        (res) => {
          const parts = [];
          res.on("data", (p) => parts.push(p));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              text: Buffer.concat(parts).toString(),
            }),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  assert.equal((await call(3, 21, "/v1/models")).status, 403);
  assert.equal(used.length, 0);
  const metadata = await call(2, 21, "/v1/models");
  assert.equal(metadata.status, 200);
  assert.equal(JSON.parse(metadata.text).credentialId, 21);
  const body = {
    model: "deepseek-flash",
    stream: true,
    max_tokens: 16,
    thinking: { type: "disabled" },
    messages: [{ role: "user", content: [{ type: "text", text: "Reply OK" }] }],
  };
  assert.equal((await call(2, 21, "/v1/messages", body)).status, 200);
  assert.equal((await call(3, 22, "/v1/messages", body)).status, 200);
  assert.equal(ledger.status(2).confirmed_tokens, 12);
  assert.equal(ledger.status(3).confirmed_tokens, 12);
  assert.equal(ledger.status().confirmed_tokens, 0);
  const records = ledger.db
    .prepare(
      "SELECT m.credential_id,s.student FROM model_requests m JOIN request_scopes s ON s.request_id=m.id ORDER BY s.student",
    )
    .all();
  assert.deepEqual(
    records.map((v) => [v.credential_id, v.student]),
    [
      [21, 2],
      [22, 3],
    ],
  );
  assert.deepEqual(used, [20, 20, 20]);
});
test("Invalid shared provider selection is rejected before server startup", () => {
  for (const value of [19, 28, "20", NaN])
    assert.throws(() => createGateway({ providerCredentialId: value }), {
      message: "INVALID_PROVIDER_CREDENTIAL",
    });
});
test("RPC authentication errors stay precise; arbitrary native messages stay private", () => {
  assert.deepEqual(
    classifyRpcFailure({ message: "School gateway: PROVIDER_HTTP_401" }),
    { code: "AI_UNAVAILABLE", reason: "PROVIDER_HTTP_401" },
  );
  assert.deepEqual(
    classifyRpcFailure({ message: "Provider model discovery unavailable" }),
    { code: "MODEL_CONNECTION_FAILED", reason: "MODEL_TRANSPORT" },
  );
  assert.deepEqual(
    classifyRpcFailure({ message: "secret sk-hidden_fixture_value" }),
    { code: "HARNESS_REQUEST_FAILED", reason: "UNCLASSIFIED_RPC" },
  );
  assert.equal(classifyRpcFailure(null).code, "HARNESS_REQUEST_FAILED");
});
async function adapterFixture(t, handler) {
  const dir = mkdtempSync(join(tmpdir(), "discovery-errors-")),
    socket = join(dir, "gateway.sock"),
    capFile = join(dir, "cap");
  writeFileSync(capFile, "a".repeat(64), { mode: 0o600 });
  const server = http.createServer(handler);
  server.listen(socket);
  await once(server, "listening");
  let adapter;
  apply(
    {
      llm: {
        registerAdapter(names, value) {
          adapter = value;
        },
      },
    },
    { credentialId: 20, socketPath: socket, capabilityFile: capFile },
  );
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });
  return adapter;
}
test("Provider discovery preserves safe 401 and permits retry after credential recovery", async (t) => {
  let calls = 0;
  const adapter = await adapterFixture(t, (req, res) => {
    calls++;
    res.setHeader("Content-Type", "application/json");
    if (calls === 1) {
      res.statusCode = 502;
      res.end(
        JSON.stringify({
          error: "PROVIDER_HTTP_401",
          private: "hidden provider body",
        }),
      );
    } else
      res.end(
        JSON.stringify({
          models: [
            {
              id: "deepseek-flash",
              contextWindow: 1048576,
              maxOutputTokens: 393216,
            },
          ],
        }),
      );
  });
  await assert.rejects(
    adapter.resolveModel("school-deepseek", "deepseek-flash"),
    { message: "School gateway: PROVIDER_HTTP_401" },
  );
  const model = await adapter.resolveModel("school-deepseek", "deepseek-flash");
  assert.equal(model.defaultMaxTokens, 393216);
  assert.equal(calls, 2);
  await adapter.resolveModel("school-deepseek", "deepseek-flash");
  assert.equal(calls, 2);
});
test("Provider discovery never forwards free-form upstream errors", async (t) => {
  const adapter = await adapterFixture(t, (req, res) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Api key rejected: sk-private_fixture" }));
  });
  await assert.rejects(
    adapter.resolveModel("school-deepseek", "deepseek-flash"),
    { message: "School gateway: MODEL_DISCOVERY_REJECTED" },
  );
});
