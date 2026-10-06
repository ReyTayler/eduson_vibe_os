/** Root-operated weekly quota acceptance. Does not send model prompts. */
import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";
const origin = "https://80.249.145.94",
  repo = "/opt/vibe-os/platform";
const accounts = JSON.parse(
  readFileSync("/var/lib/vibe-os/portal-private/student-logins.json", "utf8"),
);
const caps = JSON.parse(
  readFileSync("/etc/vibe-os/credentials/student-capabilities.json", "utf8"),
);
const brokerCap = readFileSync(
  "/var/lib/vibe-os/portal-private/broker-capability",
  "utf8",
).trim();
const status = () =>
  JSON.parse(
    execFileSync("/usr/local/bin/node", [
      "/opt/vibe-os/model-gateway/services/model-gateway/operator.mjs",
      "status",
    ]),
  );
const before = status(),
  checks = [],
  students = [],
  errors = [];
let browser, fixture;
function assert(v, message) {
  if (!v) throw new Error(message);
}
class Student {
  constructor(account) {
    this.account = account;
    this.cookie = "";
    this.csrf = "";
  }
  async call(method, path, body, expected = 200) {
    const res = await fetch(origin + "/api" + path, {
      method,
      headers: {
        Origin: origin,
        Cookie: this.cookie,
        "X-CSRF-Token": this.csrf,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    const data = await res.json();
    assert(
      res.status === expected,
      "API " + method + " " + path + " status " + res.status,
    );
    return data;
  }
  async login() {
    await this.call("POST", "/auth/login", {
      login: this.account.login,
      password: this.account.password,
    });
    this.csrf = (await this.call("GET", "/me")).csrf;
    return this;
  }
}
function privateRequest(socketPath, path, capability, credential, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: "Bearer " + capability,
          ...(credential === undefined
            ? {}
            : { "X-Vibe-Credential": String(credential) }),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          data += c;
          if (data.length > 128000)
            req.destroy(new Error("Private response too large"));
        });
        res.on("end", () => resolve({ status: res.statusCode, data }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(60000, () =>
      req.destroy(new Error("Private request timeout")),
    );
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
try {
  const initialProjects = [],
    personal = [];
  for (let n = 1; n <= 5; n++) {
    const student = await new Student(accounts[n - 1]).login();
    students.push(student);
    initialProjects.push(
      (await student.call("GET", "/projects")).map((p) => p.id).sort(),
    );
    const own = await student.call("GET", "/status"),
      spoof = await student.call(
        "GET",
        "/status?student=" + (n === 5 ? 1 : n + 1),
      );
    const cap = caps.find((row) => row.student === n).capability;
    const raw = await privateRequest(
      "/run/vibe-os-model/gateway.sock",
      "/v1/status",
      cap,
      19 + n,
    );
    assert(raw.status === 200, "Student gateway status");
    const gateway = JSON.parse(raw.data);
    const wrong = await privateRequest(
      "/run/vibe-os-model/gateway.sock",
      "/v1/status",
      cap,
      n === 5 ? 20 : 20 + n,
    );
    assert(wrong.status === 403, "Cross-student credential rejected");
    assert(
      !gateway.overview && !gateway.credentials && gateway.budget.student === n,
      "Status privacy",
    );
    const v = own.model,
      g = gateway.budget;
    assert(
      v.ready &&
        v.period === "weekly" &&
        v.timezone === "Europe/Moscow" &&
        v.limitTokens === 1000000,
      "Personal weekly policy",
    );
    assert(
      v.resetsAt === g.resetsAt &&
        v.periodStartsAt === g.periodStartsAt &&
        v.confirmedTokens === g.confirmed_tokens &&
        v.reservedTokens === g.uncertain_ceiling &&
        v.remainingTokens === g.remainingAuthorizationTokens,
      "API own budget mapping",
    );
    assert(
      spoof.model.confirmedTokens === v.confirmedTokens &&
        spoof.model.remainingTokens === v.remainingTokens,
      "Browser cannot select another student",
    );
    const reset = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Moscow",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(new Date(v.resetsAt));
    assert(reset === "Sunday 23:59:00", "Sunday Moscow deadline");
    personal.push({ student: n, ...v });
    checks.push(
      "student " + n + " personal quota, reset and identity isolation",
    );
  }
  fixture = (
    await students[4].call("POST", "/projects", {
      name: "Приёмка личной недельной квоты",
      kind: "python",
    })
  ).id;
  const token = readFileSync(
    "/srv/vibe-os/data/student-projects/" + fixture + "/model-capability",
    "utf8",
  ).trim();
  assert(
    token === caps.find((c) => c.student === 5).capability,
    "New project receives own student capability",
  );
  const provisioned = await privateRequest(
    "/run/vibe-os-model/gateway.sock",
    "/v1/status",
    token,
    24,
  );
  assert(
    provisioned.status === 200 &&
      JSON.parse(provisioned.data).budget.student === 5,
    "New project gateway budget",
  );
  const chat = (
    await students[4].call("GET", "/projects/" + fixture + "/chats")
  )[0].id;
  const inspect = await privateRequest(
    "/run/vibe-os-portal/broker.sock",
    "/v1/request",
    brokerCap,
    undefined,
    {
      op: "inspect",
      project: fixture,
      chat,
      run: randomBytes(16).toString("hex"),
      reasoningMode: "off",
    },
  );
  const block = inspect.data
    .split("\n\n")
    .find((s) => s.startsWith("event: inspected\n"));
  assert(inspect.status === 200 && block, "Native Harness initialized");
  const engine = JSON.parse(block.split("\ndata: ")[1]);
  assert(
    engine.paidCalls === 0 &&
      engine.maxTokens === 393216 &&
      engine.reasoningMode === "off",
    "Native engine policy",
  );
  checks.push(
    "new project personal capability and free native Harness initialization",
  );
  await students[4].call("DELETE", "/projects/" + fixture, {});
  fixture = undefined;
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    timezoneId: "America/New_York",
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.getByLabel("Логин", { exact: true }).fill(accounts[0].login);
  await page.getByLabel("Пароль", { exact: true }).fill(accounts[0].password);
  await page.getByRole("button", { name: "Войти в пространство" }).click();
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await page.getByText("Твой лимит на неделю", { exact: true }).waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".budget-line")].some(
      (el) =>
        el.textContent.includes("Следующий сброс") &&
        el.textContent.includes("23:59") &&
        el.textContent.includes("МСК"),
    ),
  );
  const lines = await page.locator(".budget-line").allTextContents();
  assert(
    lines.some((l) => l.includes("1 000 000")) &&
      lines.some((l) => l.includes("Использовано")),
    "Personal settings UI",
  );
  assert(
    await page
      .getByText("Сброс каждое воскресенье в 23:59 по Москве.", {
        exact: false,
      })
      .count(),
    "Reset wording",
  );
  await page.screenshot({
    path: repo + "/evidence/portal-ui/weekly-quota.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    !(await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    )),
    "Mobile settings overflow",
  );
  await page.screenshot({
    path: repo + "/evidence/portal-ui/mobile-weekly-quota.png",
    fullPage: true,
  });
  checks.push(
    "desktop and mobile quota settings; Moscow reset despite New York browser timezone",
  );
  await context.close();
  await browser.close();
  browser = undefined;
  for (let i = 0; i < 5; i++)
    assert(
      JSON.stringify(
        (await students[i].call("GET", "/projects")).map((p) => p.id).sort(),
      ) === JSON.stringify(initialProjects[i]),
      "Human projects preserved",
    );
  assert(errors.length === 0, "Browser errors");
  const after = status();
  assert(
    after.overview.lifetime.attempts === before.overview.lifetime.attempts &&
      after.overview.lifetime.confirmed_tokens ===
        before.overview.lifetime.confirmed_tokens,
    "No paid calls during acceptance",
  );
  checks.push("all existing projects preserved; zero model calls");
  const report = {
    passed: true,
    timeUtc: new Date().toISOString(),
    checks,
    personalBudgets: personal,
    paidCalls: 0,
    browserErrors: errors,
    projectCounts: initialProjects.map((p) => p.length),
    lifetimeBefore: before.overview.lifetime,
    lifetimeAfter: after.overview.lifetime,
  };
  writeFileSync(
    repo + "/evidence/weekly-quota-acceptance.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      passed: true,
      checks: checks.length,
      paidCalls: 0,
      students: 5,
      reset: personal[0].resetsAt,
    }),
  );
} finally {
  if (browser) await browser.close();
  if (fixture && students[4])
    await students[4]
      .call("DELETE", "/projects/" + fixture, {})
      .catch(() => {});
  for (const student of students)
    await student.call("POST", "/auth/logout", {}).catch(() => {});
}
