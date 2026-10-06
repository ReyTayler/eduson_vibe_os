/** Separate administrator sessions; all quota mutations pass through the root broker. */
import { randomBytes, timingSafeEqual } from "node:crypto";
export function initializeAdminSchema(db) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS administrators(id TEXT PRIMARY KEY,login TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password_hash TEXT NOT NULL,epoch INTEGER NOT NULL DEFAULT 1,created INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS admin_sessions(token_hash TEXT PRIMARY KEY,admin_id TEXT NOT NULL REFERENCES administrators(id),epoch INTEGER NOT NULL,expires INTEGER NOT NULL,created INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS admin_session_expiry ON admin_sessions(expires);",
  );
}
export function registerAdmin({
  app,
  db,
  sha,
  rid,
  fields,
  str,
  fail,
  callBroker,
  rate,
  hash,
  verify,
  csrfSecret,
  origin,
}) {
  initializeAdminSchema(db);
  const cookie = "__Host-vibe_admin_session",
    sessionMs = 8 * 3600000;
  const cookieValue = (token, seconds) =>
    cookie +
    "=" +
    token +
    "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" +
    seconds;
  function adminSession(req) {
    const raw = (req.headers.cookie ?? "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(cookie + "="))
      ?.slice(cookie.length + 1);
    if (!raw || !/^[a-f0-9]{64}$/.test(raw)) throw fail("ADMIN_REQUIRED", 401);
    const user = db
      .prepare(
        "SELECT s.*,a.login,a.name,a.epoch current_epoch FROM admin_sessions s JOIN administrators a ON a.id=s.admin_id WHERE token_hash=?",
      )
      .get(sha(raw));
    if (
      !user ||
      user.expires <= Date.now() ||
      user.epoch !== user.current_epoch
    )
      throw fail("ADMIN_REQUIRED", 401);
    return {
      ...user,
      csrf: sha(Buffer.concat([csrfSecret, Buffer.from("admin:" + raw)])),
    };
  }
  function student(userId) {
    if (typeof userId !== "string" || !/^[a-f0-9]{32}$/.test(userId))
      throw fail("INVALID_INPUT");
    const row = db
      .prepare("SELECT id,login,name,student FROM users WHERE id=?")
      .get(userId);
    if (!row) throw fail("NOT_FOUND", 404);
    return row;
  }
  function actorNames(grants) {
    return grants.map((g) => ({
      ...g,
      adminName:
        db.prepare("SELECT name FROM administrators WHERE id=?").get(g.actor)
          ?.name ?? "Администратор",
    }));
  }
  app.register(
    async function (adminApp) {
      adminApp.addHook("onRequest", async (req) => {
        if (req.url.split("?")[0] === "/api/admin/auth/login") return;
        req.admin = adminSession(req);
        if (!["GET", "HEAD"].includes(req.method)) {
          const supplied = req.headers["x-csrf-token"],
            expected = req.admin.csrf;
          if (
            req.headers.origin !== origin ||
            typeof supplied !== "string" ||
            supplied.length !== expected.length ||
            !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
          )
            throw fail("CSRF_DENIED", 403);
        }
      });
      adminApp.post("/auth/login", async (req, reply) => {
        if (req.headers.origin !== origin) throw fail("CSRF_DENIED", 403);
        rate("admin-login-ip:" + req.ip, 15);
        const b = fields(
            req.body,
            ["login", "password"],
            ["login", "password"],
          ),
          login = str(b.login, 64).toLowerCase();
        if (typeof b.password !== "string" || b.password.length > 128)
          throw fail("AUTH_FAILED", 401);
        rate("admin-login:" + login, 8);
        const user = db
          .prepare("SELECT * FROM administrators WHERE login=?")
          .get(login);
        const dummy =
          "$argon2id$v=19$m=19456,t=2,p=1$MDEyMzQ1Njc4OWFiY2RlZg$qbXIWicGNn0rxBpUFMI/ZFAh26iRwQjuTHjW/UZyZeM";
        let okay = false;
        try {
          okay = await verify(user?.password_hash ?? dummy, b.password);
        } catch (_hash) {}
        if (!user || !okay) throw fail("AUTH_FAILED", 401);
        const token = randomBytes(32).toString("hex"),
          now = Date.now();
        db.prepare("INSERT INTO admin_sessions VALUES(?,?,?,?,?)").run(
          sha(token),
          user.id,
          user.epoch,
          now + sessionMs,
          now,
        );
        db.prepare("DELETE FROM admin_sessions WHERE expires<=?").run(now);
        reply.header("Set-Cookie", cookieValue(token, sessionMs / 1000));
        return { ok: true };
      });
      adminApp.post("/auth/logout", async (req, reply) => {
        db.prepare("DELETE FROM admin_sessions WHERE token_hash=?").run(
          req.admin.token_hash,
        );
        reply.header("Set-Cookie", cookieValue("", 0));
        return { ok: true };
      });
      adminApp.get("/me", async (req) => ({
        id: req.admin.admin_id,
        login: req.admin.login,
        name: req.admin.name,
        csrf: req.admin.csrf,
      }));
      adminApp.patch("/me", async (req, reply) => {
        const b = fields(
          req.body,
          ["oldPassword", "password"],
          ["oldPassword", "password"],
        );
        if (
          typeof b.password !== "string" ||
          b.password.length < 12 ||
          b.password.length > 128
        )
          throw fail("PASSWORD_REQUIRED");
        const user = db
          .prepare("SELECT * FROM administrators WHERE id=?")
          .get(req.admin.admin_id);
        if (
          typeof b.oldPassword !== "string" ||
          b.oldPassword.length > 128 ||
          !(await verify(user.password_hash, b.oldPassword))
        )
          throw fail("AUTH_FAILED", 401);
        const encoded = await hash(b.password, {
          memoryCost: 19456,
          timeCost: 2,
          parallelism: 1,
        });
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare(
            "UPDATE administrators SET password_hash=?,epoch=epoch+1 WHERE id=?",
          ).run(encoded, user.id);
          db.prepare("DELETE FROM admin_sessions WHERE admin_id=?").run(
            user.id,
          );
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
        reply.header("Set-Cookie", cookieValue("", 0));
        return { ok: true };
      });
      adminApp.get("/students", async () => {
        const overview = await callBroker({ op: "admin-budgets" });
        return db
          .prepare(
            "SELECT u.id,u.login,u.name,u.student,(SELECT count(*) FROM projects p WHERE p.user_id=u.id) projects FROM users u ORDER BY u.student",
          )
          .all()
          .map((u) => ({
            ...u,
            budget: overview.students.find((b) => b.student === u.student),
          }));
      });
      adminApp.get("/students/:id/grants", async (req) => {
        const user = student(req.params.id);
        return actorNames(
          await callBroker({ op: "admin-grants", student: user.student }),
        );
      });
      adminApp.get("/students/:id/usage", async (req) => {
        const user = student(req.params.id);
        return callBroker({ op: "admin-usage", student: user.student });
      });
      adminApp.post("/students/:id/grants", async (req) => {
        rate("admin-grant:" + req.admin.admin_id, 30);
        const user = student(req.params.id);
        const b = fields(
          req.body,
          ["requestId", "credits", "note", "periodStartsAt"],
          ["requestId", "credits", "periodStartsAt"],
        );
        const periodStart = Date.parse(b.periodStartsAt) / 1000;
        if (
          typeof b.requestId !== "string" ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
            b.requestId,
          ) ||
          !Number.isSafeInteger(b.credits) ||
          b.credits < 1 ||
          typeof b.periodStartsAt !== "string" ||
          !Number.isSafeInteger(periodStart) ||
          typeof (b.note ?? "") !== "string" ||
          Buffer.byteLength(b.note ?? "") > 512
        )
          throw fail("GRANT_INPUT_INVALID");
        const result = await callBroker({
          op: "admin-grant",
          grant: {
            id: b.requestId,
            student: user.student,
            credits: b.credits,
            actor: req.admin.admin_id,
            note: b.note ?? "",
            periodStart,
          },
        });
        return { ...result, grant: actorNames([result.grant])[0] };
      });
    },
    { prefix: "/api/admin" },
  );
}
