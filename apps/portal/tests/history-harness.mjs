/** Long native tool history and classified failures against a temporary offline gateway. */
import { createGateway } from "../../../services/model-gateway/server.mjs";
import { CreditLedger } from "../../../services/model-gateway/credit-ledger.mjs";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  chownSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { chromium } from "playwright";
const repo = "/opt/vibe-os/platform",
  origin = "https://80.249.145.94",
  directory = "/run/vibe-os-history-qa";
const accounts = JSON.parse(
  readFileSync("/var/lib/vibe-os/portal-private/student-logins.json", "utf8"),
);
const studentCaps = JSON.parse(
  readFileSync("/etc/vibe-os/credentials/student-capabilities.json", "utf8"),
);
const actualStatus = () =>
  JSON.parse(
    execFileSync("/usr/local/bin/node", [
      "/opt/vibe-os/model-gateway/services/model-gateway/operator.mjs",
      "status",
    ]),
  ).overview.lifetime;
const before = actualStatus(),
  ledger = new CreditLedger(":memory:"),
  calls = [],
  checks = [],
  browserErrors = [];
const marker = "HISTORY_FIXTURE_FINAL_20_STEPS";
let cookie = "",
  csrf = "",
  project,
  server,
  browser,
  cfg,
  originalCfg,
  fixtureRun,
  chat,
  phase = "history",
  round = 0;
function assert(v, message) {
  if (!v) throw new Error(message);
}
async function api(method, path, body, expected = 200) {
  const res = await fetch(origin + "/api" + path, {
    method,
    headers: {
      Origin: origin,
      Cookie: cookie,
      "X-CSRF-Token": csrf,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const set = res.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  const data = await res.json();
  assert(
    res.status === expected,
    "API " + method + " " + path + " " + res.status,
  );
  return data;
}
function row(type, data) {
  return (
    "event: " + type + "\ndata: " + JSON.stringify({ type, ...data }) + "\n\n"
  );
}
function fixtureStream(toolRound = null, text = marker, broken = false) {
  const chunks = [
    row("message_start", {
      message: {
        id: "fixture_" + calls.length,
        type: "message",
        role: "assistant",
        model: "deepseek-flash",
        content: [],
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    }),
  ];
  let index = 0;
  function block(content, delta) {
    chunks.push(row("content_block_start", { index, content_block: content }));
    if (delta) chunks.push(row("content_block_delta", { index, delta }));
    chunks.push(row("content_block_stop", { index }));
    index++;
  }
  if (toolRound !== null) {
    chunks.push(
      row("content_block_start", {
        index,
        content_block: { type: "thinking", thinking: "" },
      }),
    );
    chunks.push(
      row("content_block_delta", {
        index,
        delta: {
          type: "thinking_delta",
          thinking: "I will inspect files and keep the whole conversation.",
        },
      }),
    );
    chunks.push(
      row("content_block_delta", {
        index,
        delta: {
          type: "signature_delta",
          signature: "fixture-reasoning-signature-" + toolRound,
        },
      }),
    );
    chunks.push(row("content_block_stop", { index }));
    index++;
    block(
      { type: "text", text: "" },
      { type: "text_delta", text: "Проверяю файлы.\n" },
    );
    for (let k = 0; k < 2; k++)
      block(
        {
          type: "tool_use",
          id: "history_tool_" + toolRound + "_" + k,
          name: "read_file",
          input: {},
        },
        {
          type: "input_json_delta",
          partial_json: JSON.stringify({ path: "main.py" }),
        },
      );
  } else block({ type: "text", text: "" }, { type: "text_delta", text });
  if (broken)
    chunks.push(
      row("error", {
        error: {
          type: "overloaded_error",
          message: "PRIVATE_FIXTURE_UPSTREAM_ERROR",
        },
      }),
    );
  else {
    chunks.push(
      row("message_delta", {
        delta: {
          stop_reason: toolRound === null ? "end_turn" : "tool_use",
          stop_sequence: null,
        },
        usage: { output_tokens: 32 },
      }),
    );
    chunks.push(row("message_stop", {}));
  }
  let n = 0;
  return new Response(
    new ReadableStream({
      pull(c) {
        if (n < chunks.length) c.enqueue(Buffer.from(chunks[n++]));
        else c.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
function blockStats(messages) {
  let total = 0,
    max = 0;
  function count(items) {
    total += items.length;
    max = Math.max(max, items.length);
    for (const b of items) if (Array.isArray(b.content)) count(b.content);
  }
  for (const m of messages) count(m.content);
  return { messages: messages.length, blocks: total, maxBlocksPerList: max };
}
async function waitForRun(id) {
  const deadline = Date.now() + 120000;
  let run;
  do {
    run = await api("GET", "/runs/" + id);
    if (!["queued", "running"].includes(run.state)) return run;
    await new Promise((r) => setTimeout(r, 250));
  } while (Date.now() < deadline);
  throw new Error("Fixture run timed out");
}
async function submit(text) {
  fixtureRun = (await api("POST", "/chats/" + chat + "/messages", { text })).id;
  const run = await waitForRun(fixtureRun);
  fixtureRun = undefined;
  return run;
}
try {
  await api("POST", "/auth/login", {
    login: accounts[4].login,
    password: accounts[4].password,
  });
  csrf = (await api("GET", "/me")).csrf;
  const priorProjects = (await api("GET", "/projects")).map((p) => p.id).sort();
  project = (
    await api("POST", "/projects", {
      name: "Проверка истории помощника",
      kind: "python",
    })
  ).id;
  chat = (await api("GET", "/projects/" + project + "/chats"))[0].id;
  await api("PATCH", "/chats/" + chat, { reasoningMode: "high" });
  mkdirSync(directory, { recursive: true, mode: 0o750 });
  chmodSync(directory, 0o750);
  chownSync(directory, 0, 23000);
  server = createGateway({
    ledger,
    vault: { get: () => "offline-fixture-no-api-key", metadata: () => [] },
    capability: randomBytes(32).toString("hex"),
    studentCapabilities: studentCaps,
    fetchImpl: async (url, options) => {
      if (url.endsWith("/models"))
        return Response.json({
          data: [
            {
              id: "deepseek-flash",
              context_window: 1048576,
              max_output_tokens: 393216,
            },
          ],
        });
      const value = JSON.parse(options.body);
      calls.push({
        phase,
        ...blockStats(value.messages),
        student: value.metadata.user_id,
        reasoning: value.output_config?.effort,
        signatureReplay: value.messages.some((m) =>
          m.content.some(
            (b) =>
              b.type === "thinking" &&
              b.signature?.startsWith("fixture-reasoning-signature-"),
          ),
        ),
      });
      if (phase === "history") {
        round++;
        return fixtureStream(round <= 20 ? round : null);
      }
      if (phase === "rate")
        return Response.json(
          { error: { message: "PRIVATE_FIXTURE_UPSTREAM_ERROR" } },
          { status: 429 },
        );
      if (phase === "stream")
        return fixtureStream(null, "Сохранённый частичный ответ", true);
      return fixtureStream(null, "HISTORY_RESUMED_SAME_CHAT");
    },
  });
  server.listen(directory + "/gateway.sock");
  await once(server, "listening");
  chmodSync(directory + "/gateway.sock", 0o660);
  chownSync(directory + "/gateway.sock", 0, 23000);
  cfg = "/etc/vibe-os/student-projects/" + project + "/engine.cfg";
  originalCfg = readFileSync(cfg, "utf8");
  assert(
    originalCfg.includes('src: "/run/vibe-os-model"'),
    "Model mount present",
  );
  writeFileSync(
    cfg,
    originalCfg.replace(
      'src: "/run/vibe-os-model"',
      'src: "' + directory + '"',
    ),
  );
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.on("pageerror", (e) => browserErrors.push(e.message));
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByLabel("Логин", { exact: true }).fill(accounts[4].login);
  await page.getByLabel("Пароль", { exact: true }).fill(accounts[4].password);
  await page.getByRole("button", { name: "Войти в пространство" }).click();
  await page
    .getByRole("button", { name: "Открыть Проверка истории помощника" })
    .click();
  const response = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      /\/api\/chats\/[a-f0-9]+\/messages$/.test(r.url()),
  );
  await page
    .getByLabel("Сообщение помощнику")
    .fill("Проверка длинной истории: двадцать шагов и сорок чтений файла.");
  await page.getByTitle("Отправить сообщение", { exact: true }).click();
  const submitted = await response;
  assert(submitted.status() === 200, "UI prompt admitted");
  fixtureRun = (await submitted.json()).id;
  const run = await waitForRun(fixtureRun);
  assert(
    run.state === "completed",
    "Long history " + run.state + " " + run.error,
  );
  fixtureRun = undefined;
  assert(round === 21, "Twenty tool rounds followed by final answer");
  assert(
    calls.some((c) => c.messages > 32 && c.blocks > 64),
    "Crossed both old history count guards",
  );
  assert(
    calls.slice(1).every((c) => c.signatureReplay),
    "High reasoning signatures replayed",
  );
  assert(
    calls.every(
      (c) => c.student === "vibe-student-5" && c.reasoning === "high",
    ),
    "Student and reasoning scope",
  );
  const content = await api("GET", "/chats/" + chat);
  assert(
    content.messages.some(
      (m) =>
        m.role === "assistant" &&
        m.text.includes(marker) &&
        m.tools.length === 24,
    ),
    "Long answer durable; display tool summary is capped separately",
  );
  const nativePath =
    "/srv/vibe-os/data/student-projects/" +
    project +
    "/engine/sessions/--workspace--/" +
    chat +
    "/session.v4.jsonl";
  const native = readFileSync(nativePath, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert(
    native.filter((e) => e.type === "tool/call").length === 40,
    "All forty real tools are durable",
  );
  assert(
    native
      .filter((e) => e.type === "tool/result")
      .every((e) => e.data.message.isError !== true),
    "All forty file reads succeeded",
  );
  await page.waitForFunction(
    (marker) =>
      document
        .querySelector(".chat-message.assistant .message-body")
        ?.textContent.includes(marker),
    marker,
    { timeout: 30000 },
  );
  checks.push(
    "20 native tool rounds, 40 successful file reads, 41 request messages and 161 content blocks; high reasoning/signatures replay; visible and persisted final answer",
  );
  phase = "resume";
  const resumed = await submit(
    "Продолжи в том же чате после загрузки истории.",
  );
  assert(resumed.state === "completed", "Resume in same chat " + resumed.error);
  checks.push(
    "Native engine restart resumes the same long chat and completes another turn",
  );
  phase = "rate";
  const limited = await submit("Проверка ошибки ограничения частоты.");
  assert(
    limited.state === "failed" && limited.error === "MODEL_RATE_LIMITED",
    "429 specific error " + limited.error,
  );
  phase = "stream";
  const broken = await submit("Проверка разрыва модельного потока.");
  assert(
    broken.state === "failed" && broken.error === "MODEL_CONNECTION_FAILED",
    "Midstream specific error " + broken.error,
  );
  checks.push(
    "Upstream 429 and midstream errors retain their exact safe classification through the SDK, broker and API",
  );
  while (ledger.status(5).maxRemainingCalls > 0) {
    const held = randomUUID();
    ledger.reserveOutput(
      held,
      24,
      "fixture-credit-exhaustion",
      32768,
      393216,
      5,
    );
    ledger.finish(held, "uncertain");
  }
  phase = "quota";
  const exhausted = await submit("Проверка недельной квоты.");
  assert(
    exhausted.state === "failed" &&
      exhausted.error === "AI_WEEKLY_CREDITS_EXHAUSTED",
    "Weekly quota specific error " + exhausted.error,
  );
  const final = await api("GET", "/chats/" + chat),
    notices = final.messages
      .filter((m) => m.role === "notice")
      .map((m) => m.text);
  assert(
    notices.some((n) => n.includes("частоту запросов")),
    "Rate notice",
  );
  assert(
    notices.some((n) => n.includes("Соединение с DeepSeek")),
    "Stream notice",
  );
  assert(
    notices.some(
      (n) => n.includes("недельных кредитов") && n.includes("23:59"),
    ),
    "Quota notice",
  );
  assert(
    !notices.some((n) => n.includes("новый чат")),
    "Unrelated failures do not suggest abandoning the chat",
  );
  assert(
    !JSON.stringify(final).includes("PRIVATE_FIXTURE_UPSTREAM_ERROR"),
    "Provider private body never reaches the chat",
  );
  checks.push(
    "Correct Russian notices for rate, stream and weekly quota; no misleading new-chat advice or upstream error body",
  );
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: "Открыть Проверка истории помощника" })
    .click();
  await page
    .getByText(notices.at(-1), { exact: true })
    .waitFor({ timeout: 30000 });
  assert(
    (await page.locator(".chat-message.assistant").allTextContents())
      .join("\n")
      .includes("HISTORY_RESUMED_SAME_CHAT"),
    "Chat survives reload",
  );
  assert(browserErrors.length === 0, "No browser errors");
  checks.push(
    "UI reload preserves long chat, successful resumed answer and precise error notices",
  );
  await browser.close();
  browser = undefined;
  const after = actualStatus();
  assert(
    JSON.stringify(after) === JSON.stringify(before),
    "Production budget unchanged",
  );
  await api("DELETE", "/projects/" + project, {});
  project = undefined;
  assert(
    JSON.stringify((await api("GET", "/projects")).map((p) => p.id).sort()) ===
      JSON.stringify(priorProjects),
    "Human projects untouched",
  );
  const report = {
    passed: true,
    timeUtc: new Date().toISOString(),
    paidCalls: 0,
    checks,
    nativeModelCalls: calls.length,
    nativeSuccessfulToolCalls: 40,
    maximumRequestMessages: Math.max(...calls.map((c) => c.messages)),
    maximumRequestContentBlocks: Math.max(...calls.map((c) => c.blocks)),
    productionBudgetBefore: before,
    productionBudgetAfter: after,
    browserErrors,
    fixtureRemoved: true,
  };
  writeFileSync(
    repo + "/evidence/credit-history-harness.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} catch (error) {
  if (project && chat) {
    const nativePath =
      "/srv/vibe-os/data/student-projects/" +
      project +
      "/engine/sessions/--workspace--/" +
      chat +
      "/session.v4.jsonl";
    const events = readFileSync(nativePath, "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    const endings = events
      .filter((e) => e.type === "turn/end")
      .map((e) => e.data.reason);
    console.error(
      JSON.stringify({
        fixtureFailure: error.message,
        phase,
        modelCalls: calls.length,
        endings,
      }),
    );
  }
  throw error;
} finally {
  if (fixtureRun)
    await api("POST", "/runs/" + fixtureRun + "/cancel", {}).catch(() => {});
  if (browser) await browser.close();
  if (project && cfg && originalCfg) writeFileSync(cfg, originalCfg);
  if (project) await api("DELETE", "/projects/" + project, {}).catch(() => {});
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  ledger.close();
  rmSync(directory, { recursive: true, force: true });
  if (cookie) await api("POST", "/auth/logout", {}).catch(() => {});
}
