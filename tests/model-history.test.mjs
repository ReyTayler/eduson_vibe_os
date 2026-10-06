/** Regression for ordinary tool histories and safe, useful model failures. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  createGateway,
  validateBody,
  MAX_BODY,
} from "../services/model-gateway/server.mjs";
import { Ledger } from "../services/model-gateway/ledger.mjs";
import { classifyRunFailure } from "../services/workspace-broker/run-errors.mjs";
const base = {
  model: "deepseek-flash",
  stream: true,
  max_tokens: 393216,
  thinking: { type: "enabled" },
  output_config: { effort: "high" },
};
function toolHistory(rounds, toolsPerRound = 2) {
  const messages = [
    { role: "user", content: [{ type: "text", text: "Continue the project" }] },
  ];
  for (let n = 0; n < rounds; n++) {
    const tools = Array.from({ length: toolsPerRound }, (_, k) => ({
      type: "tool_use",
      id: "call_" + n + "_" + k,
      name: "read_file",
      input: { path: "main.py" },
    }));
    messages.push({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Checking", signature: "fixture" },
        { type: "text", text: "Read files" },
        ...tools,
      ],
    });
    messages.push({
      role: "user",
      content: tools.map((t) => ({
        type: "tool_result",
        tool_use_id: t.id,
        content: [{ type: "text", text: "file contents" }],
      })),
    });
  }
  return { ...base, messages };
}
test("72+ content blocks in a normal tool history are valid", () => {
  const request = toolHistory(12);
  assert.equal(validateBody(request), request);
});
test("More than 32 messages remain valid within the byte budget", () => {
  const request = toolHistory(40);
  assert.equal(request.messages.length, 81);
  assert.equal(validateBody(request), request);
});
test("A batch with more than 16 calls and results is valid", () => {
  const request = toolHistory(1, 20);
  assert.equal(request.messages[1].content.length, 22);
  assert.equal(request.messages[2].content.length, 20);
  assert.equal(validateBody(request), request);
});
test("Malformed and unsupported content still fail validation", () => {
  for (const content of [
    null,
    {},
    [{ type: "image", source: { type: "url", url: "https://example.test" } }],
  ]) {
    assert.throws(() =>
      validateBody({ ...base, messages: [{ role: "user", content }] }),
    );
  }
  assert.throws(
    () => validateBody({ ...base, messages: [] }),
    /MESSAGE_FORMAT/,
  );
  assert.throws(
    () =>
      validateBody({ ...base, messages: [{ role: "system", content: [] }] }),
    /MESSAGE_FORMAT/,
  );
  assert.throws(
    () =>
      validateBody({
        ...base,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "hello", extra: 1 }],
          },
        ],
      }),
    /TEXT_ONLY/,
  );
});
test("Long history reaches the upstream fixture; byte guard and weekly admission still apply", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-history-test-")),
    socket = join(dir, "gateway.sock");
  const ledger = new Ledger(":memory:"),
    cap = "a".repeat(64),
    calls = [];
  const server = createGateway({
    ledger,
    capability: "b".repeat(64),
    studentCapabilities: [{ student: 5, capability: cap }],
    vault: { get: () => "offline-fixture", metadata: () => [] },
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      const events = [
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
  const request = (body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: socket,
          path: "/v1/messages",
          method: "POST",
          headers: {
            Authorization: "Bearer " + cap,
            "Content-Type": "application/json",
            "X-Vibe-Credential": "24",
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
      req.end(JSON.stringify(body));
    });
  let response = await request(toolHistory(40));
  assert.equal(response.status, 200);
  assert.equal(calls[0].messages.length, 81);
  assert.equal(calls[0].metadata.user_id, "vibe-student-5");
  assert.equal(ledger.status(5).confirmed_tokens, 12);
  assert.equal(ledger.status(5).uncertain_ceiling, 0);
  response = await request({
    ...base,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "x".repeat(MAX_BODY + 1) }],
      },
    ],
  });
  assert.equal(response.status, 413);
  assert.match(response.text, /REQUEST_BYTES_LIMIT/);
  assert.equal(calls.length, 1);
  const held = randomUUID();
  ledger.reserve(held, 24, "fixture", 999988, 5);
  ledger.finish(held, "uncertain");
  response = await request(toolHistory(40));
  assert.match(response.text, /TOKEN_BUDGET_EXHAUSTED/);
  assert.equal(calls.length, 1);
});
test("Gateway history failures are distinct from weekly quota, bytes, rate and transport errors", () => {
  for (const [reason, code] of [
    ["CONTENT_LIMIT", "MODEL_HISTORY_REJECTED"],
    ["MESSAGE_LIMIT", "MODEL_HISTORY_REJECTED"],
    ["TOKEN_BUDGET_EXHAUSTED", "AI_WEEKLY_BUDGET_EXHAUSTED"],
    ["REQUEST_BYTES_LIMIT", "MODEL_CONTEXT_LIMIT"],
    ["PROVIDER_HTTP_429", "MODEL_RATE_LIMITED"],
    ["PROVIDER_STREAM_ERROR", "MODEL_CONNECTION_FAILED"],
    ["PROVIDER_STREAM_INCOMPLETE", "MODEL_CONNECTION_FAILED"],
    ["PROVIDER_HTTP_503", "MODEL_CONNECTION_FAILED"],
    ["PROVIDER_HTTP_401", "AI_UNAVAILABLE"],
  ])
    assert.deepEqual(classifyRunFailure("School gateway: " + reason), {
      code,
      reason,
    });
  assert.deepEqual(classifyRunFailure("PROVIDER_STREAM_ERROR"), {
    code: "MODEL_CONNECTION_FAILED",
    reason: "PROVIDER_STREAM_ERROR",
  });
  assert.equal(
    classifyRunFailure("School model request exceeds 512 KiB").code,
    "MODEL_CONTEXT_LIMIT",
  );
  assert.equal(
    classifyRunFailure(
      "SESSION_HISTORY_LIMIT: create a new independent session",
    ).code,
    "HISTORY_LIMIT",
  );
});
test("Unknown failure text and fabricated codes cannot escape into API errors or logs", () => {
  for (const value of [
    "an arbitrary secret-bearing upstream error",
    "School gateway: SECRET_INVENTED_CODE",
    { message: "School gateway: CONTENT_LIMIT" },
    new Error("Unknown failure text"),
  ])
    assert.deepEqual(classifyRunFailure(value), {
      code: "MODEL_RUN_FAILED",
      reason: "UNCLASSIFIED",
    });
  assert.equal(classifyRunFailure(null), null);
  assert.equal(classifyRunFailure(undefined), null);
  assert.equal(classifyRunFailure(""), null);
});
