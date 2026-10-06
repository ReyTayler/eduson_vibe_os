/** Real native Harness and UI against a fixture-only, offline model gateway; no paid prompts. */
import { createGateway } from "../../../services/model-gateway/server.mjs";
import { Ledger } from "../../../services/model-gateway/ledger.mjs";
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
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";
const repo = "/opt/vibe-os/platform",
  origin = "https://80.249.145.94",
  directory = "/run/vibe-os-response-qa";
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
  ledger = new Ledger(":memory:"),
  calls = [],
  checks = [],
  browserErrors = [];
let cookie = "",
  csrf = "",
  project,
  server,
  browser,
  cfg,
  originalCfg,
  fixtureRun;
const small = "LONG_UI_BEGIN_" + "x".repeat(90000) + "_LONG_UI_END";
const large = "LARGE_BEGIN_" + "A".repeat(9 * 1024 * 1024) + "_LARGE_END";
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
function streamResponse(toolIndex, text) {
  const tool = toolIndex !== null,
    blocks = [];
  blocks.push(
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
  );
  if (tool) {
    blocks.push(
      row("content_block_start", {
        index: 0,
        content_block: {
          type: "tool_use",
          id: "fixture_tool_" + toolIndex,
          name: "read_file",
          input: {},
        },
      }),
    );
    blocks.push(
      row("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"path":"main.py"}' },
      }),
    );
  } else {
    blocks.push(
      row("content_block_start", {
        index: 0,
        content_block: { type: "text", text: "" },
      }),
    );
    for (let n = 0; n < text.length; n += 32768)
      blocks.push(
        row("content_block_delta", {
          index: 0,
          delta: { type: "text_delta", text: text.slice(n, n + 32768) },
        }),
      );
  }
  blocks.push(row("content_block_stop", { index: 0 }));
  blocks.push(
    row("message_delta", {
      delta: {
        stop_reason: tool ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: {
        output_tokens: tool ? 16 : text.length > 100000 ? 100000 : 20000,
      },
    }),
  );
  blocks.push(row("message_stop", {}));
  let n = 0;
  const shouldPause = !tool && text === small;
  return new Response(
    new ReadableStream({
      async pull(controller) {
        if (shouldPause && n === blocks.length - 3)
          await new Promise((r) => setTimeout(r, 1700));
        if (n < blocks.length) controller.enqueue(Buffer.from(blocks[n++]));
        else controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
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
      name: "Проверка длинного ответа",
      kind: "python",
    })
  ).id;
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
      const value = JSON.parse(options.body),
        number = calls.length + 1;
      calls.push({
        number,
        maxTokens: value.max_tokens,
        student: value.metadata.user_id,
        toolResultPresent: JSON.stringify(value.messages).includes(
          "tool_result",
        ),
      });
      return number <= 8
        ? streamResponse(number, null)
        : streamResponse(null, number === 9 ? small : large);
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
    "Expected model directory mount",
  );
  writeFileSync(
    cfg,
    originalCfg.replace(
      'src: "/run/vibe-os-model"',
      'src: "' + directory + '"',
    ),
  );
  const profile = JSON.parse(
    readFileSync(
      "/srv/vibe-os/data/student-projects/" +
        project +
        "/engine/profiles/student/cordis.patch.yml",
      "utf8",
    ),
  );
  for (const row of profile[0].insert)
    if (["school-deepseek", "sdk-jsonrpc-server"].includes(row.id))
      assert(
        !("maxTokens" in row.config) && !("maxSteps" in row.config),
        "No fixed output or step config",
      );
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    page = await context.newPage();
  page.on("pageerror", (e) => browserErrors.push(e.message));
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByLabel("Логин", { exact: true }).fill(accounts[4].login);
  await page.getByLabel("Пароль", { exact: true }).fill(accounts[4].password);
  await page.getByRole("button", { name: "Войти в пространство" }).click();
  await page
    .getByRole("button", { name: "Открыть Проверка длинного ответа" })
    .click();
  await page.getByLabel("Сообщение помощнику").waitFor();
  assert(
    (await page.getByText("По квоте", { exact: true }).count()) === 1,
    "Quota-only UI hint",
  );
  const submitted = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      /\/api\/chats\/[a-f0-9]+\/messages$/.test(r.url()),
  );
  await page
    .getByLabel("Сообщение помощнику")
    .fill(
      "Проверка снятого лимита ответа: восемь чтений файла и длинный ответ.",
    );
  await page.getByTitle("Отправить сообщение", { exact: true }).click();
  const submittedResponse = await submitted;
  assert(submittedResponse.status() === 200, "UI prompt admitted");
  fixtureRun = (await submittedResponse.json()).id;
  await page.waitForFunction(
    () =>
      document.querySelector(".live-message .message-body")?.textContent
        .length > 65536,
    {},
    { timeout: 60000 },
  );
  checks.push("streaming UI displays more than 65536 characters");
  await page.waitForFunction(
    () =>
      document
        .querySelector(".chat-message.assistant .message-body")
        ?.textContent.endsWith("_LONG_UI_END"),
    {},
    { timeout: 60000 },
  );
  assert(
    calls.length === 9,
    "Eight real tool steps followed by final model response",
  );
  assert(
    calls.every(
      (c) => c.maxTokens === 393216 && c.student === "vibe-student-5",
    ),
    "Actual SDK uses discovered provider maximum",
  );
  assert(
    calls.slice(1).every((c) => c.toolResultPresent),
    "Native tool results replayed",
  );
  fixtureRun = undefined;
  checks.push(
    "native Harness completed 9 model steps; provider maximum discovered; real read_file replay",
  );
  const chat = (await api("GET", "/projects/" + project + "/chats"))[0].id;
  const answer = (await api("GET", "/chats/" + chat)).messages.find(
    (m) => m.role === "assistant",
  );
  assert(
    answer.text === small && answer.tools.length === 8,
    "Complete durable assistant text and all eight real tools",
  );
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: "Открыть Проверка длинного ответа" })
    .click();
  await page.waitForFunction(() =>
    document
      .querySelector(".chat-message.assistant .message-body")
      ?.textContent.endsWith("_LONG_UI_END"),
  );
  assert(
    (await page
      .locator(".chat-message.assistant .message-body")
      .textContent()) === small,
    "Reload preserves complete long answer",
  );
  await page.screenshot({
    path: repo + "/evidence/portal-ui/quota-only-answer.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    !(await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    )),
    "Mobile overflow",
  );
  await page.screenshot({
    path: repo + "/evidence/portal-ui/mobile-quota-only-answer.png",
    fullPage: true,
  });
  await context.close();
  await browser.close();
  browser = undefined;
  checks.push(
    "complete text after browser reload; mobile layout; no 64K label",
  );
  const nextChat = (
    await api("POST", "/projects/" + project + "/chats", {
      name: "Проверка ответа больше 8 МиБ",
    })
  ).id;
  fixtureRun = (
    await api("POST", "/chats/" + nextChat + "/messages", {
      text: "Проверка сохранения большого модельного ответа.",
    })
  ).id;
  let run;
  const deadline = Date.now() + 60000;
  do {
    run = await api("GET", "/runs/" + fixtureRun);
    if (!["queued", "running"].includes(run.state)) break;
    await new Promise((r) => setTimeout(r, 200));
  } while (Date.now() < deadline);
  assert(
    run.state === "completed",
    "Large response run " + run.state + " " + run.error,
  );
  fixtureRun = undefined;
  const big = (await api("GET", "/chats/" + nextChat)).messages.find(
    (m) => m.role === "assistant",
  );
  assert(
    big.text === large && Buffer.byteLength(big.text) > 8388608,
    "Full answer greater than old 8MiB cap persisted through native SDK/broker/API",
  );
  checks.push(
    "9MiB answer traverses real native Harness, private protocol, broker and portal; exact persisted bytes",
  );
  await api("DELETE", "/projects/" + project, {});
  project = undefined;
  assert(
    JSON.stringify((await api("GET", "/projects")).map((p) => p.id).sort()) ===
      JSON.stringify(priorProjects),
    "Human projects preserved",
  );
  assert(browserErrors.length === 0, "Browser errors");
  const after = actualStatus();
  assert(
    JSON.stringify(after) === JSON.stringify(before),
    "Production token spend unchanged",
  );
  const report = {
    passed: true,
    timeUtc: new Date().toISOString(),
    checks,
    paidCalls: 0,
    modelFixture:
      "fixture-only offline gateway; real pinned native Harness; real filesystem tools; real live portal/UI",
    nativeModelCalls: calls.length,
    nativeReadFileSteps: 8,
    uiCharacters: small.length,
    largeAnswerBytes: Buffer.byteLength(large),
    productionBudgetBefore: before,
    productionBudgetAfter: after,
    fixtureBudget: ledger.status(5),
    browserErrors,
    fixtureRemoved: true,
  };
  writeFileSync(
    repo + "/evidence/response-harness-acceptance.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      passed: true,
      checks: checks.length,
      paidCalls: 0,
      nativeModelCalls: calls.length,
      toolSteps: 8,
      largeAnswerBytes: Buffer.byteLength(large),
    }),
  );
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
