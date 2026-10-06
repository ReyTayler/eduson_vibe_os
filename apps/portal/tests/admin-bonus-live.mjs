/** Performs only the user's authorized student01 +2m grant, once; no model requests. */
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
const repo = "/opt/vibe-os/platform",
  origin = "https://80.249.145.94",
  privateDir =
    "/var/lib/vibe-os/operator-snapshots/admin-weekly-grants-20261006",
  intentFile = privateDir + "/authorized-grant.json";
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
if (before.generation !== 4)
  throw new Error("ARCHIVED_TOKEN_ACCEPTANCE_USE_ADMIN_CREDIT_LIVE");
let intent;
if (existsSync(intentFile)) {
  intent = JSON.parse(readFileSync(intentFile, "utf8"));
} else {
  intent = {
    requestId: randomUUID(),
    tokens: 2000000,
    note: "Дополнительная квота по запросу владельца платформы",
    periodStartsAt: before.students[0].periodStartsAt,
  };
  writeFileSync(intentFile, JSON.stringify(intent, null, 2) + "\n", {
    mode: 0o400,
    flag: "wx",
  });
  chmodSync(intentFile, 0o400);
}
if (intent.tokens !== 2000000) throw new Error("Unauthorized grant amount");
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
    await page
      .getByLabel("Количество токенов", { exact: true })
      .fill("2000000");
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
          body.tokens === intent.tokens && body.note === intent.note,
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
      data.budget.extraLimitTokens === beforeRoot.extraLimitTokens + 2000000,
      "Two million added exactly once",
    );
    await page.unroute("**/api/admin/students/" + first.id + "/grants");
    checks.push(
      "Authorized student01 +2m grant performed through the live admin form",
    );
  } else {
    assert(exists.tokens === 2000000, "Existing grant matches authorization");
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
      () => sessionStorage.getItem("vibe-admin-pending-grant") === null,
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
      data: { ...intent, tokens: 1 },
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
    after.students[0].limitTokens === 3000000 &&
      after.students[0].extraLimitTokens === 2000000,
    "Final quota is base 1m + extra 2m",
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
  await page.screenshot({
    path: repo + "/evidence/portal-ui/admin-bonus.png",
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
    path: repo + "/evidence/portal-ui/mobile-admin-bonus.png",
    fullPage: true,
  });
  checks.push(
    "Admin account quotas and audit journal persist after reload; responsive mobile layout",
  );
  const studentContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
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
    own.model.limitTokens === 3000000 && own.model.extraLimitTokens === 2000000,
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
    path: repo + "/evidence/portal-ui/student-bonus.png",
    fullPage: true,
  });
  checks.push(
    "Student01 sees 3m weekly total and +2m extra; student cookies cannot access admin operations",
  );
  assert(errors.length === 0, "Browser errors");
  const report = {
    passed: true,
    timeUtc: new Date().toISOString(),
    paidCalls: 0,
    checks,
    grantId: intent.requestId,
    student: "student01",
    baseTokens: 1000000,
    extraTokens: 2000000,
    totalTokens: after.students[0].limitTokens,
    remainingTokens: after.students[0].remainingAuthorizationTokens,
    confirmedTokensPreserved: after.students[0].confirmed_tokens,
    expiresAt: after.students[0].resetsAt,
    productionBudgetBefore: before.lifetime,
    productionBudgetAfter: after.lifetime,
    otherStudentsUnchanged: true,
    browserErrors: errors,
  };
  writeFileSync(
    repo + "/evidence/admin-bonus-acceptance.json",
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
