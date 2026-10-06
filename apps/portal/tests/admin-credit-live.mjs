/** Performs only the user's authorized student01 +$2 grant, once; no model requests. */
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
const repo = "/opt/vibe-os/platform",
  origin = "https://80.249.145.94",
  privateDir = "/var/lib/vibe-os/operator-snapshots/credit-policy-20261007",
  intentFile = privateDir + "/authorized-credit-grant.json";
const admin = JSON.parse(
  readFileSync("/var/lib/vibe-os/portal-private/admin-login.json", "utf8"),
);
const students = JSON.parse(
  readFileSync("/var/lib/vibe-os/portal-private/student-logins.json", "utf8"),
);
const status = () =>
  JSON.parse(
    execFileSync("/usr/local/bin/node", [
      "/opt/vibe-os/model-gateway/services/model-gateway/operator.mjs",
      "status",
    ]),
  ).overview;
const before = status();
let intent;
if (existsSync(intentFile)) {
  intent = JSON.parse(readFileSync(intentFile, "utf8"));
} else {
  intent = {
    requestId: randomUUID(),
    credits: 2000,
    note: "Дополнительный бюджет $2 по запросу владельца платформы",
    periodStartsAt: before.students[0].periodStartsAt,
  };
  writeFileSync(intentFile, JSON.stringify(intent, null, 2) + "\n", {
    mode: 0o400,
    flag: "wx",
  });
  chmodSync(intentFile, 0o400);
}
if (intent.credits !== 2000) throw new Error("Unauthorized grant amount");
const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  }),
  errors = [],
  checks = [];
function assert(v, message) {
  if (!v) throw new Error(message);
}
try {
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + "/admin", { waitUntil: "networkidle" });
  await page
    .getByLabel("Логин администратора", { exact: true })
    .fill(admin.login);
  await page
    .getByLabel("Пароль администратора", { exact: true })
    .fill(admin.password);
  await page.getByRole("button", { name: "Войти в админ-панель" }).click();
  await page
    .getByRole("heading", { name: "Аккаунты учеников" })
    .waitFor({ timeout: 30000 });
  const accountsResponse = await context.request.get(
    origin + "/api/admin/students",
  );
  assert(accountsResponse.status() === 200, "Admin account list");
  const accounts = await accountsResponse.json();
  assert(accounts.length === 5, "Five student accounts");
  const first = accounts.find((a) => a.login === "student01");
  assert(first && first.student === 1, "Selected account is student01");
  const me = await (await context.request.get(origin + "/api/admin/me")).json();
  const grantsBefore = await (
    await context.request.get(
      origin + "/api/admin/students/" + first.id + "/grants",
    )
  ).json();
  const exists = grantsBefore.find((g) => g.id === intent.requestId);
  if (!exists) {
    assert(
      intent.periodStartsAt === first.budget.periodStartsAt,
      "Grant belongs to the authorized week",
    );
    const beforeRoot = before.students[0];
    await page.getByTitle("Выбрать student01", { exact: true }).click();
    await page.getByLabel("Количество кредитов", { exact: true }).fill("2000");
    await page.locator("textarea").first().fill(intent.note);
    await page.route(
      "**/api/admin/students/" + first.id + "/grants",
      async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        const body = route.request().postDataJSON();
        assert(
          body.credits === intent.credits && body.note === intent.note,
          "Exact authorized UI grant",
        );
        await route.continue({
          postData: JSON.stringify({
            ...body,
            requestId: intent.requestId,
            periodStartsAt: intent.periodStartsAt,
          }),
        });
      },
    );
    const saved = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url().endsWith("/api/admin/students/" + first.id + "/grants"),
    );
    await page.getByRole("button", { name: /^Начислить 2/ }).click();
    const response = await saved,
      data = await response.json();
    assert(
      response.status() === 200,
      "UI grant " + response.status() + " " + data.error,
    );
    assert(
      data.budget.extraLimitCredits === beforeRoot.extraLimitCredits + 2000,
      "Two thousand credits added exactly once",
    );
    await page.unroute("**/api/admin/students/" + first.id + "/grants");
    checks.push(
      "Authorized student01 +$2 grant performed through the live admin form",
    );
  } else {
    assert(exists.credits === 2000, "Existing grant matches authorization");
    checks.push(
      "Existing authorized operation recovered without another credit",
    );
  }
  await page
    .getByText(intent.note, { exact: true })
    .waitFor({ timeout: 30000 });
  await page.waitForFunction(
    () => !document.querySelector(".admin-add")?.hasAttribute("disabled"),
    {},
    { timeout: 30000 },
  );
  assert(
    await page.evaluate(
      () => sessionStorage.getItem("vibe-admin-pending-credit-grant") === null,
    ),
    "Successful operation key cleared for intentional next grants",
  );
  const replay = await context.request.post(
    origin + "/api/admin/students/" + first.id + "/grants",
    { headers: { Origin: origin, "X-CSRF-Token": me.csrf }, data: intent },
  );
  assert(
    replay.status() === 200 && (await replay.json()).replayed === true,
    "Retry is idempotent",
  );
  const conflict = await context.request.post(
    origin + "/api/admin/students/" + first.id + "/grants",
    {
      headers: { Origin: origin, "X-CSRF-Token": me.csrf },
      data: { ...intent, credits: 1 },
    },
  );
  assert(conflict.status() === 409, "Conflicting reused key rejected");
  const noCsrf = await context.request.post(
    origin + "/api/admin/students/" + first.id + "/grants",
    { headers: { Origin: origin }, data: intent },
  );
  assert(noCsrf.status() === 403, "Mutation requires admin CSRF");
  checks.push(
    "Idempotent retry, conflict rejection and CSRF enforced on the deployed API",
  );
  const after = status();
  assert(
    after.students[0].limitCredits === 3000 &&
      after.students[0].extraLimitCredits === 2000,
    "Final quota is base $1 + extra $2",
  );
  assert(
    after.students[0].confirmed_tokens === before.students[0].confirmed_tokens,
    "Existing spend preserved",
  );
  assert(
    JSON.stringify(after.lifetime) === JSON.stringify(before.lifetime),
    "No paid model calls",
  );
  for (let i = 1; i < 5; i++)
    assert(
      JSON.stringify(after.students[i]) === JSON.stringify(before.students[i]),
      "Other student budget unchanged",
    );
  assert(
    JSON.stringify(after.operator) === JSON.stringify(before.operator),
    "Operator budget unchanged",
  );
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByText(intent.note, { exact: true })
    .waitFor({ timeout: 30000 });
  const allGrants = await (
    await context.request.get(
      origin + "/api/admin/students/" + first.id + "/grants",
    )
  ).json();
  assert(
    allGrants.filter((g) => g.id === intent.requestId).length === 1,
    "One durable grant after reload",
  );
  assert(
    allGrants.some(
      (g) => g.unit === "tokens" && g.archived && g.tokens === 2000000,
    ),
    "Legacy token grant retained in history",
  );
  const usageRows = await (
    await context.request.get(
      origin + "/api/admin/students/" + first.id + "/usage",
    )
  ).json();
  assert(
    usageRows.length > 0 &&
      usageRows.every((r) => r.createdAt && "spentCredits" in r),
    "Per-model-call usage ledger",
  );
  await page
    .getByRole("heading", { name: "Последние вызовы модели" })
    .waitFor();
  assert(
    await page.getByText("Кэш входа", { exact: true }).count(),
    "Cache/input/output breakdown",
  );

  await page.screenshot({
    path: repo + "/evidence/portal-ui/admin-credit.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    !(await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    )),
    "Admin mobile overflow",
  );
  await page.screenshot({
    path: repo + "/evidence/portal-ui/mobile-admin-credit.png",
    fullPage: true,
  });
  checks.push(
    "Admin account quotas and audit journal persist after reload; responsive mobile layout",
  );
  const studentContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      timezoneId: "America/New_York",
    }),
    studentPage = await studentContext.newPage();
  studentPage.on("pageerror", (e) => errors.push(e.message));
  await studentPage.goto(origin, { waitUntil: "networkidle" });
  await studentPage
    .getByLabel("Логин", { exact: true })
    .fill(students[0].login);
  await studentPage
    .getByLabel("Пароль", { exact: true })
    .fill(students[0].password);
  await studentPage
    .getByRole("button", { name: "Войти в пространство" })
    .click();
  const own = await (
    await studentContext.request.get(origin + "/api/status")
  ).json();
  assert(
    own.model.limitCredits === 3000 && own.model.extraLimitCredits === 2000,
    "Student API receives total and extra allowance",
  );
  const blocked = await studentContext.request.post(
    origin + "/api/admin/students/" + first.id + "/grants",
    { headers: { Origin: origin }, data: intent },
  );
  assert(blocked.status() === 401, "Student session cannot credit any account");
  const adminBlocked = await studentContext.request.get(
    origin + "/api/admin/students",
  );
  assert(
    adminBlocked.status() === 401,
    "Student cannot list administrator budgets",
  );
  const profileButtons = studentPage.getByRole("button", {
    name: "Настройки",
    exact: true,
  });
  if (await profileButtons.count()) await profileButtons.first().click();
  else await studentPage.getByTitle("Настройки", { exact: true }).click();
  await studentPage
    .getByText("Из них дополнительно", { exact: true })
    .waitFor({ timeout: 30000 });
  await studentPage.screenshot({
    path: repo + "/evidence/portal-ui/student-credit.png",
    fullPage: true,
  });
  checks.push(
    "Student01 sees 3000-credit weekly total and 2000-credit extra; student cookies cannot access admin operations",
  );
  await studentPage.getByText("Доступно кредитов", { exact: true }).waitFor();
  const lines = await studentPage.locator(".budget-line").allTextContents();
  assert(
    lines.some(
      (l) =>
        l.includes("Следующий сброс") &&
        l.includes("23:59") &&
        l.includes("МСК"),
    ),
    "Moscow reset wording",
  );
  await studentPage.setViewportSize({ width: 390, height: 844 });
  assert(
    !(await studentPage.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    )),
    "Student mobile overflow",
  );
  await studentPage.screenshot({
    path: repo + "/evidence/portal-ui/mobile-student-credit.png",
    fullPage: true,
  });

  const identities = [];
  for (let n = 0; n < 5; n++) {
    const identity = await browser.newContext();
    const login = await identity.request.post(origin + "/api/auth/login", {
      headers: { Origin: origin },
      data: { login: students[n].login, password: students[n].password },
    });
    assert(login.status() === 200, "Student login " + (n + 1));
    const personal = await (
      await identity.request.get(
        origin + "/api/status?student=" + (n === 0 ? 5 : 1),
      )
    ).json();
    assert(
      personal.model.unit === "credits" &&
        personal.model.limitCredits === (n === 0 ? 3000 : 1000),
      "Own credit quota despite browser spoof",
    );
    const mine = await (await identity.request.get(origin + "/api/me")).json();
    await identity.request.post(origin + "/api/auth/logout", {
      headers: { Origin: origin, "X-CSRF-Token": mine.csrf },
      data: {},
    });
    identities.push({
      student: n + 1,
      limitCredits: personal.model.limitCredits,
      spentCredits: personal.model.spentCredits,
      remainingCredits: personal.model.remainingCredits,
    });
    await identity.close();
  }
  checks.push(
    "Five independent $1 weekly budgets, selected account +$2, browser identity spoof rejected",
  );
  assert(errors.length === 0, "Browser errors");
  const report = {
    passed: true,
    timeUtc: new Date().toISOString(),
    paidCalls: 0,
    checks,
    grantId: intent.requestId,
    student: "student01",
    baseCredits: 1000,
    extraCredits: 2000,
    totalCredits: after.students[0].limitCredits,
    remainingCredits: after.students[0].remainingCredits,
    confirmedTokensPreserved: after.students[0].confirmed_tokens,
    expiresAt: after.students[0].resetsAt,
    productionBudgetBefore: before.lifetime,
    productionBudgetAfter: after.lifetime,
    otherStudentsUnchanged: true,
    identities,
    browserErrors: errors,
  };
  writeFileSync(
    repo + "/evidence/admin-credit-acceptance.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  await studentContext.request.post(origin + "/api/auth/logout", {
    headers: {
      Origin: origin,
      "X-CSRF-Token": (
        await (await studentContext.request.get(origin + "/api/me")).json()
      ).csrf,
    },
    data: {},
  });
  await context.request.post(origin + "/api/admin/auth/logout", {
    headers: { Origin: origin, "X-CSRF-Token": me.csrf },
    data: {},
  });
  await studentContext.close();
  await context.close();
} finally {
  await browser.close();
}
