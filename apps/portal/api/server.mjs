import templates from "./templates.mjs";

/** Student BFF: server sessions, ownership, revision fences and one durable AI queue. */
import Fastify from "fastify";
import { DatabaseSync } from "node:sqlite";
import { hash, verify } from "@node-rs/argon2";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import {
  readFileSync,
  existsSync,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  constants,
} from "node:fs";
import path from "node:path";
import http from "node:http";
const ROOT = "/opt/vibe-os/portal",
  PRIVATE = "/var/lib/vibe-os/portal-private",
  DATA = "/var/lib/vibe-os/portal";
const ORIGIN = "https://80.249.145.94",
  PREVIEW = ORIGIN + ":8443";
const cookie = "__Host-vibe_session",
  TOKEN = /^[a-f0-9]{64}$/,
  ID = /^[a-f0-9]{32}$/;
const csrfSecret = readFileSync(PRIVATE + "/csrf-secret");
const brokerCapability = readFileSync(
  PRIVATE + "/broker-capability",
  "utf8",
).trim();
const app = Fastify({
  logger: false,
  trustProxy: "127.0.0.1",
  bodyLimit: 300000,
  requestTimeout: 15000,
});
const db = new DatabaseSync(DATA + "/portal.sqlite");
db.exec(
  "PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;PRAGMA trusted_schema=OFF;PRAGMA busy_timeout=5000",
);
db.exec(`
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,login TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password_hash TEXT NOT NULL,student INTEGER UNIQUE NOT NULL CHECK(student BETWEEN 1 AND 5),epoch INTEGER NOT NULL DEFAULT 1,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),epoch INTEGER NOT NULL,expires INTEGER NOT NULL,created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS folders(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(user_id,name));
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),folder_id TEXT REFERENCES folders(id),name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN('web','python','node')),revision INTEGER NOT NULL DEFAULT 1,created INTEGER NOT NULL,updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),name TEXT NOT NULL,cursor INTEGER NOT NULL DEFAULT 0,created INTEGER NOT NULL,updated INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),role TEXT NOT NULL CHECK(role IN('user','assistant','notice')),text TEXT NOT NULL,tools TEXT NOT NULL DEFAULT '[]',created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES chats(id),project_id TEXT NOT NULL REFERENCES projects(id),user_id TEXT NOT NULL REFERENCES users(id),state TEXT NOT NULL CHECK(state IN('queued','running','completed','failed','cancelled','interrupted')),prompt TEXT NOT NULL,base_revision INTEGER NOT NULL,partial TEXT NOT NULL DEFAULT '',error TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS one_project_run ON runs(project_id) WHERE state IN('queued','running');
CREATE INDEX IF NOT EXISTS chat_messages ON messages(chat_id,created);
CREATE INDEX IF NOT EXISTS user_projects ON projects(user_id,updated);
CREATE TRIGGER IF NOT EXISTS folder_owner_insert BEFORE INSERT ON projects WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM folders WHERE id=NEW.folder_id AND user_id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'FOLDER_OWNER');END;
CREATE TRIGGER IF NOT EXISTS folder_owner_update BEFORE UPDATE OF folder_id ON projects WHEN NEW.folder_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM folders WHERE id=NEW.folder_id AND user_id=NEW.user_id) BEGIN SELECT RAISE(ABORT,'FOLDER_OWNER');END;
`);
for (const table of ["chats", "runs"]) {
  if (
    !db
      .prepare("PRAGMA table_info(" + table + ")")
      .all()
      .some((c) => c.name === "reasoning_mode")
  )
    db.exec(
      "ALTER TABLE " +
        table +
        " ADD COLUMN reasoning_mode TEXT NOT NULL DEFAULT 'off' CHECK(reasoning_mode IN('off','low','high','max'))",
    );
}
function reasoning(v) {
  if (!["off", "low", "high", "max"].includes(v)) throw fail("INVALID_INPUT");
  return v;
}
const rid = () => randomBytes(16).toString("hex"),
  sha = (v) => createHash("sha256").update(v).digest("hex");
function fail(code, status = 400) {
  return Object.assign(new Error(code), { statusCode: status });
}
const ru = {
  AI_UNAVAILABLE:
    "Помощник временно недоступен. Файлы и редактор продолжают работать.",
  AUTH_REQUIRED: "Войдите в свой кабинет.",
  AUTH_FAILED: "Неверный логин или пароль.",
  RATE_LIMIT: "Слишком много попыток. Подождите минуту.",
  CSRF_DENIED: "Обновите страницу и повторите действие.",
  NOT_FOUND: "Не найдено.",
  INVALID_INPUT: "Проверьте введённые данные.",
  PROJECT_LIMIT: "Можно создать до 10 проектов.",
  CHAT_LIMIT: "В проекте уже 30 чатов.",
  FOLDER_LIMIT: "Можно создать до 20 папок.",
  FILE_CHANGED: "Файл изменился. Обновите его перед сохранением.",
  PROJECT_BUSY:
    "Помощник сейчас работает с этим проектом. Дождитесь завершения или остановите запрос.",
  QUEUE_LIMIT: "Очередь заполнена. Попробуйте немного позже.",
  THREE_HOSTING_SLOTS: "Уже включены три проекта. Остановите один из них.",
  INDEX_HTML_REQUIRED: "Для предпросмотра и публикации нужен файл index.html.",
  AI_BUDGET_EXHAUSTED:
    "Тестовый лимит ИИ исчерпан. Проекты и редактор продолжают работать.",
  WORKSPACE_OPERATION_FAILED: "Не удалось выполнить операцию с файлами.",
  WORKSPACE_UNAVAILABLE: "Исполнитель временно недоступен.",
  PUBLICATION_FILE_LIMIT:
    "В проекте слишком много или слишком большие файлы для публикации.",
  PREVIEW_UNAVAILABLE: "Предпросмотр завершился или проект выключен.",
  PASSWORD_REQUIRED: "Пароль должен содержать от 12 до 128 символов.",
  BASE_REVISION_CHANGED:
    "Проект изменился до начала запроса. Повторите запрос.",
  MODEL_RUN_FAILED:
    "Помощник не завершил запрос. Проверьте результат и начните новый чат, если история слишком большая.",
  BROKER_UNAVAILABLE: "Исполнитель временно недоступен.",
  AI_TIMEOUT: "Помощник не успел завершить работу.",
  CANCELLED: "Запрос остановлен.",
  HISTORY_LIMIT: "История этого чата слишком большая. Создайте новый чат.",
  FILE_NOT_FOUND: "Файл не найден.",
};
function fields(v, allowed, required = []) {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !allowed.includes(k)) ||
    required.some((k) => !Object.hasOwn(v, k))
  )
    throw fail("INVALID_INPUT");
  return v;
}
function str(v, max = 160) {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.length > max ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v)
  )
    throw fail("INVALID_INPUT");
  return v.trim();
}
function id(v) {
  if (typeof v !== "string" || !ID.test(v)) throw fail("NOT_FOUND", 404);
  return v;
}
function filePath(v) {
  if (
    typeof v !== "string" ||
    v.length > 512 ||
    v.startsWith("/") ||
    v.includes("\0") ||
    v.includes("\\") ||
    v.split("/").some((p) => p === ".." || p.startsWith("."))
  )
    throw fail("INVALID_INPUT");
  return v;
}
function callBroker(body, { stream = false } = {}) {
  const bytes = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: "/run/vibe-os-portal/broker.sock",
        method: "POST",
        path: "/v1/request",
        headers: {
          Authorization: "Bearer " + brokerCapability,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bytes),
        },
      },
      (res) => {
        if (stream && res.statusCode === 200) {
          resolve(res);
          return;
        }
        const chunks = [];
        let n = 0;
        res.on("data", (c) => {
          n += c.length;
          if (n > 3 * 1024 * 1024) {
            req.destroy();
            reject(fail("BROKER_UNAVAILABLE", 503));
            return;
          }
          chunks.push(c);
        });
        res.on("error", () => reject(fail("BROKER_UNAVAILABLE", 503)));
        res.on("end", () => {
          try {
            const v = JSON.parse(Buffer.concat(chunks));
            if (res.statusCode !== 200)
              throw fail(
                v.error ?? "BROKER_UNAVAILABLE",
                res.statusCode ?? 503,
              );
            resolve(v.result);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", () => reject(fail("BROKER_UNAVAILABLE", 503)));
    req.setTimeout(stream ? 1850000 : 20000, () => req.destroy());
    req.end(bytes);
  });
}
function getSession(req) {
  const raw = (req.headers.cookie ?? "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(cookie + "="))
    ?.slice(cookie.length + 1);
  if (!raw || !TOKEN.test(raw)) throw fail("AUTH_REQUIRED", 401);
  const row = db
    .prepare(
      "SELECT s.*,u.login,u.name,u.student,u.epoch AS current_epoch FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=?",
    )
    .get(sha(raw));
  if (!row || row.expires < Date.now() || row.epoch !== row.current_epoch)
    throw fail("AUTH_REQUIRED", 401);
  return { ...row, csrf: sha(Buffer.concat([csrfSecret, Buffer.from(raw)])) };
}
function ownProject(user, project) {
  const p = db
    .prepare("SELECT * FROM projects WHERE id=? AND user_id=?")
    .get(id(project), user.user_id);
  if (!p) throw fail("NOT_FOUND", 404);
  return p;
}
function ownChat(user, chat) {
  const row = db
    .prepare(
      "SELECT c.*,p.user_id,p.name AS project_name,p.kind,p.revision FROM chats c JOIN projects p ON p.id=c.project_id WHERE c.id=? AND p.user_id=?",
    )
    .get(id(chat), user.user_id);
  if (!row) throw fail("NOT_FOUND", 404);
  return row;
}
function ownRun(user, run) {
  const r = db
    .prepare("SELECT * FROM runs WHERE id=? AND user_id=?")
    .get(id(run), user.user_id);
  if (!r) throw fail("NOT_FOUND", 404);
  return r;
}
const manualLeases = new Set();
function unlocked(project) {
  if (
    manualLeases.has(project) ||
    db
      .prepare(
        "SELECT 1 FROM runs WHERE project_id=? AND state IN('queued','running')",
      )
      .get(project)
  )
    throw fail("PROJECT_BUSY", 423);
}
function revision(project, v) {
  if (!Number.isSafeInteger(v) || v !== project.revision)
    throw fail("FILE_CHANGED", 409);
}
function bump(project) {
  db.prepare(
    "UPDATE projects SET revision=revision+1,updated=? WHERE id=?",
  ).run(Date.now(), project);
}
function message(chat, role, text, tools = []) {
  if (!text && !tools.length) return;
  db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?)").run(
    rid(),
    chat,
    role,
    text,
    JSON.stringify(tools),
    Date.now(),
  );
}
const rates = new Map();
function rate(key, max = 8, window = 60000) {
  const now = Date.now();
  let v = rates.get(key);
  if (!v || v.start < now - window) v = { start: now, count: 0 };
  v.count++;
  rates.set(key, v);
  if (rates.size > 5000)
    for (const [k, r] of rates) if (r.start < now - window) rates.delete(k);
  if (v.count > max) throw fail("RATE_LIMIT", 429);
}
app.addHook("onRequest", async (req, reply) => {
  reply
    .header("Cache-Control", "no-store")
    .header("X-Content-Type-Options", "nosniff");
  if (req.url.startsWith("/api/")) {
    if (req.url.split("?")[0] !== "/api/auth/login") {
      req.student = getSession(req);
      if (!["GET", "HEAD"].includes(req.method)) {
        const supplied = req.headers["x-csrf-token"],
          expected = req.student.csrf;
        if (
          req.headers.origin !== ORIGIN ||
          typeof supplied !== "string" ||
          supplied.length !== expected.length ||
          !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
        )
          throw fail("CSRF_DENIED", 403);
      }
    }
  }
});

app.addHook("preHandler", async (req, reply) => {
  if (["GET", "HEAD"].includes(req.method)) return;
  const match =
    /^\/api\/projects\/([a-f0-9]{32})(?:\/(file|directories|run|preview|hosting))?$/.exec(
      req.url.split("?")[0],
    );
  if (!match) return;
  const project = ownProject(req.student, match[1]);
  unlocked(project.id);
  req.workspaceLease = project.id;
  manualLeases.add(project.id);
});
app.addHook("onResponse", async (req) => {
  if (req.workspaceLease) manualLeases.delete(req.workspaceLease);
});
app.addHook("onError", async (req) => {
  if (req.workspaceLease) manualLeases.delete(req.workspaceLease);
});

app.setErrorHandler((err, req, reply) => {
  const status = err.statusCode ?? 500;
  const code =
    status === 500
      ? "SERVER_UNAVAILABLE"
      : err.code?.startsWith("FST_")
        ? "INVALID_INPUT"
        : err.message;
  reply.code(status).send({
    error: code,
    message:
      ru[code] ??
      (status >= 500
        ? "Сервис временно недоступен. Повторите позже."
        : "Не удалось выполнить действие. Проверьте данные."),
  });
});
app.post("/api/auth/login", async (req, reply) => {
  if (req.headers.origin !== ORIGIN) throw fail("CSRF_DENIED", 403);
  rate("login-ip:" + req.ip, 15);
  const b = fields(req.body, ["login", "password"], ["login", "password"]);
  const login = str(b.login, 64).toLowerCase();
  if (typeof b.password !== "string" || b.password.length > 128)
    throw fail("AUTH_FAILED", 401);
  rate("login:" + login, 8);
  const user = db.prepare("SELECT * FROM users WHERE login=?").get(login);
  const dummy =
    "$argon2id$v=19$m=19456,t=2,p=1$MDEyMzQ1Njc4OWFiY2RlZg$qbXIWicGNn0rxBpUFMI/ZFAh26iRwQjuTHjW/UZyZeM";
  let okay = false;
  try {
    okay = await verify(user?.password_hash ?? dummy, b.password);
  } catch (hashError) {
    okay = false;
  }
  if (!user || !okay) throw fail("AUTH_FAILED", 401);
  const token = randomBytes(32).toString("hex"),
    now = Date.now();
  db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(
    sha(token),
    user.id,
    user.epoch,
    now + 7 * 86400000,
    now,
  );
  db.prepare("DELETE FROM sessions WHERE expires<?").run(now);
  reply.header(
    "Set-Cookie",
    cookie +
      "=" +
      token +
      "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800",
  );
  return { ok: true };
});
app.post("/api/auth/logout", async (req, reply) => {
  db.prepare("DELETE FROM sessions WHERE token_hash=?").run(
    req.student.token_hash,
  );
  closeStreams(req.student.token_hash);
  reply.header(
    "Set-Cookie",
    cookie + "=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
  );
  return { ok: true };
});
app.get("/api/me", async (req) => ({
  id: req.student.user_id,
  login: req.student.login,
  name: req.student.name,
  csrf: req.student.csrf,
}));
app.patch("/api/me", async (req) => {
  const b = fields(req.body, ["name", "oldPassword", "password"]);
  if (b.name !== undefined)
    db.prepare("UPDATE users SET name=? WHERE id=?").run(
      str(b.name, 64),
      req.student.user_id,
    );
  if (b.password !== undefined) {
    if (
      typeof b.password !== "string" ||
      b.password.length < 12 ||
      b.password.length > 128
    )
      throw fail("PASSWORD_REQUIRED");
    const u = db
      .prepare("SELECT * FROM users WHERE id=?")
      .get(req.student.user_id);
    if (
      typeof b.oldPassword !== "string" ||
      !(await verify(u.password_hash, b.oldPassword))
    )
      throw fail("AUTH_FAILED", 401);
    const h = await hash(b.password, {
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    db.prepare("UPDATE users SET password_hash=?,epoch=epoch+1 WHERE id=?").run(
      h,
      u.id,
    );
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(u.id);
    closeStreams(undefined, u.id);
  }
  return { ok: true };
});
app.get("/api/folders", async (req) =>
  db
    .prepare(
      "SELECT id,name,created FROM folders WHERE user_id=? ORDER BY created",
    )
    .all(req.student.user_id),
);
app.post("/api/folders", async (req) => {
  const b = fields(req.body, ["name"], ["name"]);
  if (
    db
      .prepare("SELECT count(*) n FROM folders WHERE user_id=?")
      .get(req.student.user_id).n >= 20
  )
    throw fail("FOLDER_LIMIT", 409);
  const folder = rid();
  try {
    db.prepare("INSERT INTO folders VALUES(?,?,?,?)").run(
      folder,
      req.student.user_id,
      str(b.name, 64),
      Date.now(),
    );
  } catch (e) {
    throw fail("INVALID_INPUT", 409);
  }
  return { id: folder };
});
app.patch("/api/folders/:id", async (req) => {
  const b = fields(req.body, ["name"], ["name"]);
  if (
    db
      .prepare("UPDATE folders SET name=? WHERE id=? AND user_id=?")
      .run(str(b.name, 64), id(req.params.id), req.student.user_id).changes !==
    1
  )
    throw fail("NOT_FOUND", 404);
  return { ok: true };
});
app.delete("/api/folders/:id", async (req) => {
  const folder = id(req.params.id);
  if (
    !db
      .prepare("SELECT 1 FROM folders WHERE id=? AND user_id=?")
      .get(folder, req.student.user_id)
  )
    throw fail("NOT_FOUND", 404);
  db.prepare(
    "UPDATE projects SET folder_id=NULL WHERE folder_id=? AND user_id=?",
  ).run(folder, req.student.user_id);
  db.prepare("DELETE FROM folders WHERE id=? AND user_id=?").run(
    folder,
    req.student.user_id,
  );
  return { ok: true };
});
async function projectList(user) {
  const rows = db
    .prepare(
      "SELECT p.*,(SELECT count(*) FROM chats c WHERE c.project_id=p.id) chatCount,(SELECT state FROM runs r WHERE r.project_id=p.id ORDER BY created DESC LIMIT 1) runState FROM projects p WHERE user_id=? ORDER BY updated DESC",
    )
    .all(user);
  const hosting = await callBroker({ op: "hosting" });
  return rows.map((p) => {
    const h = hosting.find((h) => h.project === p.id);
    return {
      ...p,
      hosting: !!h,
      slot: h?.slot ?? null,
      url: h ? PREVIEW + "/published/" + p.id + "/" : null,
    };
  });
}
app.get("/api/projects", async (req) => projectList(req.student.user_id));

async function createProject(user, b) {
  if (
    db
      .prepare("SELECT count(*) n FROM projects WHERE user_id=?")
      .get(user.user_id).n >= 10
  )
    throw fail("PROJECT_LIMIT", 409);
  const kind = b.kind ?? "web";
  if (!Object.hasOwn(templates, kind)) throw fail("INVALID_INPUT");
  const name = str(b.name, 80),
    folder =
      b.folderId === null || b.folderId === undefined ? null : id(b.folderId);
  if (
    folder &&
    !db
      .prepare("SELECT 1 FROM folders WHERE id=? AND user_id=?")
      .get(folder, user.user_id)
  )
    throw fail("NOT_FOUND", 404);
  const project = rid();
  await callBroker({ op: "provision", project, student: user.student });
  for (const [p, text] of Object.entries(templates[kind]))
    await callBroker({ op: "fs", project, action: "write", path: p, text });
  const now = Date.now();
  db.prepare("INSERT INTO projects VALUES(?,?,?,?,?,?,?,?)").run(
    project,
    user.user_id,
    folder,
    name,
    kind,
    1,
    now,
    now,
  );
  const chat = rid();
  db.prepare(
    "INSERT INTO chats(id,project_id,name,cursor,created,updated) VALUES(?,?,?,?,?,?)",
  ).run(chat, project, "Первый разговор", 0, now, now);
  return { id: project, chat };
}
app.post("/api/projects", async (req) =>
  createProject(
    req.student,
    fields(req.body, ["name", "kind", "folderId"], ["name"]),
  ),
);
app.patch("/api/projects/:id", async (req) => {
  const p = ownProject(req.student, req.params.id),
    b = fields(req.body, ["name", "folderId"]);
  const folder =
    b.folderId === undefined
      ? p.folder_id
      : b.folderId === null
        ? null
        : id(b.folderId);
  if (
    folder &&
    !db
      .prepare("SELECT 1 FROM folders WHERE id=? AND user_id=?")
      .get(folder, req.student.user_id)
  )
    throw fail("NOT_FOUND", 404);
  db.prepare("UPDATE projects SET name=?,folder_id=?,updated=? WHERE id=?").run(
    b.name === undefined ? p.name : str(b.name, 80),
    folder,
    Date.now(),
    p.id,
  );
  return { ok: true };
});
app.delete("/api/projects/:id", async (req) => {
  const p = ownProject(req.student, req.params.id);
  if (!req.workspaceLease) unlocked(p.id);
  try {
    await callBroker({ op: "delete", project: p.id });
  } catch (e) {
    if (e.statusCode !== 404) throw e;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "DELETE FROM messages WHERE chat_id IN(SELECT id FROM chats WHERE project_id=?)",
    ).run(p.id);
    db.prepare("DELETE FROM runs WHERE project_id=?").run(p.id);
    db.prepare("DELETE FROM chats WHERE project_id=?").run(p.id);
    db.prepare("DELETE FROM projects WHERE id=? AND user_id=?").run(
      p.id,
      req.student.user_id,
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { deleted: true };
});
app.get("/api/projects/:id/files", async (req) => {
  const p = ownProject(req.student, req.params.id);
  const files = [];
  async function walk(dir, depth = 0) {
    if (depth > 12) throw fail("INVALID_INPUT");
    const rows = await callBroker({
      op: "fs",
      project: p.id,
      action: "list",
      path: dir || ".",
    });
    for (const row of rows) {
      if (row.name.startsWith(".")) continue;
      const name = dir ? dir + "/" + row.name : row.name;
      files.push({
        path: name,
        type: row.info.type,
        size: row.info.size,
        version: row.info.version,
      });
      if (files.length > 1024) throw fail("INVALID_INPUT");
      if (row.info.type === "directory") await walk(name, depth + 1);
    }
  }
  await walk("");
  return { files, revision: p.revision };
});
app.get("/api/projects/:id/file", async (req) => {
  const p = ownProject(req.student, req.params.id);
  const file = filePath(req.query.path);
  const result = await callBroker({
    op: "fs",
    project: p.id,
    action: "read",
    path: file,
  });
  return {
    text: result.text,
    version: result.info.version,
    revision: p.revision,
  };
});
app.put("/api/projects/:id/file", async (req) => {
  const p = ownProject(req.student, req.params.id),
    b = fields(
      req.body,
      ["path", "text", "version", "revision"],
      ["path", "text", "revision"],
    );
  if (!req.workspaceLease) unlocked(p.id);
  revision(p, b.revision);
  if (
    typeof b.text !== "string" ||
    Buffer.byteLength(b.text) > 262144 ||
    b.text.includes("\0")
  )
    throw fail("INVALID_INPUT");
  const guard = b.version
    ? { kind: "replaceIfVersion", version: str(b.version, 64) }
    : { kind: "createIfAbsent" };
  const result = await callBroker({
    op: "fs",
    project: p.id,
    action: "write",
    path: filePath(b.path),
    text: b.text,
    guard,
  });
  bump(p.id);
  return { version: result.version, revision: p.revision + 1 };
});
app.post("/api/projects/:id/directories", async (req) => {
  const p = ownProject(req.student, req.params.id),
    b = fields(req.body, ["path", "revision"], ["path", "revision"]);
  if (!req.workspaceLease) unlocked(p.id);
  revision(p, b.revision);
  await callBroker({
    op: "fs",
    project: p.id,
    action: "mkdir",
    path: filePath(b.path),
  });
  bump(p.id);
  return { revision: p.revision + 1 };
});
app.patch("/api/projects/:id/file", async (req) => {
  const p = ownProject(req.student, req.params.id),
    b = fields(
      req.body,
      ["path", "newPath", "version", "revision"],
      ["path", "newPath", "version", "revision"],
    );
  if (!req.workspaceLease) unlocked(p.id);
  revision(p, b.revision);
  await callBroker({
    op: "fs",
    project: p.id,
    action: "rename",
    path: filePath(b.path),
    new: filePath(b.newPath),
    guard: { kind: "replaceIfVersion", version: str(b.version, 64) },
  });
  bump(p.id);
  return { revision: p.revision + 1 };
});
app.delete("/api/projects/:id/file", async (req) => {
  const p = ownProject(req.student, req.params.id),
    b = fields(
      req.body,
      ["path", "version", "revision"],
      ["path", "version", "revision"],
    );
  if (!req.workspaceLease) unlocked(p.id);
  revision(p, b.revision);
  await callBroker({
    op: "fs",
    project: p.id,
    action: "remove",
    path: filePath(b.path),
    guard: { kind: "replaceIfVersion", version: str(b.version, 64) },
  });
  bump(p.id);
  return { revision: p.revision + 1 };
});
app.post("/api/projects/:id/run", async (req) => {
  const p = ownProject(req.student, req.params.id),
    b = fields(req.body, ["path", "command"]);
  if (!req.workspaceLease) unlocked(p.id);
  rate("run:" + req.student.user_id, 20);
  let program, args;
  if (b.command !== undefined) {
    program = "bash";
    args = ["-c", str(b.command, 8192)];
  } else {
    const f = filePath(b.path);
    program = f.endsWith(".py") ? "python" : f.endsWith(".js") ? "node" : null;
    if (!program) throw fail("INVALID_INPUT");
    args = [f];
  }
  return callBroker({ op: "run", project: p.id, program, args });
});
app.post("/api/projects/:id/preview", async (req) => {
  const p = ownProject(req.student, req.params.id);
  if (!req.workspaceLease) unlocked(p.id);
  rate("snapshot:" + req.student.user_id, 20);
  const release = await callBroker({
    op: "snapshot",
    project: p.id,
    preview: true,
  });
  return { url: PREVIEW + "/published/" + release.release + "/" };
});
app.post("/api/projects/:id/hosting", async (req) => {
  const p = ownProject(req.student, req.params.id),
    b = fields(req.body, ["enabled"], ["enabled"]);
  if (typeof b.enabled !== "boolean") throw fail("INVALID_INPUT");
  if (!req.workspaceLease) unlocked(p.id);
  if (!b.enabled) {
    await callBroker({ op: "unhost", project: p.id });
    return { hosting: false };
  }
  const release = await callBroker({
    op: "snapshot",
    project: p.id,
    preview: false,
  });
  const h = await callBroker({
    op: "host",
    project: p.id,
    release: release.release,
  });
  return { ...h, url: PREVIEW + "/published/" + p.id + "/" };
});
app.get("/api/projects/:id/chats", async (req) => {
  const p = ownProject(req.student, req.params.id);
  return db
    .prepare(
      "SELECT id,name,reasoning_mode,created,updated FROM chats WHERE project_id=? ORDER BY updated DESC",
    )
    .all(p.id);
});
app.post("/api/projects/:id/chats", async (req) => {
  const p = ownProject(req.student, req.params.id),
    b = fields(req.body, ["name"]);
  if (
    db.prepare("SELECT count(*) n FROM chats WHERE project_id=?").get(p.id).n >=
    30
  )
    throw fail("CHAT_LIMIT", 409);
  const chat = rid(),
    now = Date.now();
  db.prepare(
    "INSERT INTO chats(id,project_id,name,cursor,created,updated) VALUES(?,?,?,?,?,?)",
  ).run(chat, p.id, b.name ? str(b.name, 80) : "Новый разговор", 0, now, now);
  return { id: chat };
});
app.get("/api/chats/:id", async (req) => {
  const c = ownChat(req.student, req.params.id);
  return {
    ...c,
    messages: db
      .prepare(
        "SELECT id,role,text,tools,created FROM messages WHERE chat_id=? ORDER BY created,id",
      )
      .all(c.id)
      .map((m) => ({ ...m, tools: JSON.parse(m.tools) })),
    activeRun:
      db
        .prepare(
          "SELECT id,state,partial,error FROM runs WHERE chat_id=? AND state IN('queued','running')",
        )
        .get(c.id) ?? null,
  };
});
app.patch("/api/chats/:id", async (req) => {
  const c = ownChat(req.student, req.params.id),
    b = fields(req.body, ["name", "reasoningMode"]);
  if (b.name === undefined && b.reasoningMode === undefined)
    throw fail("INVALID_INPUT");
  db.prepare(
    "UPDATE chats SET name=?,reasoning_mode=?,updated=? WHERE id=?",
  ).run(
    b.name === undefined ? c.name : str(b.name, 80),
    b.reasoningMode === undefined
      ? c.reasoning_mode
      : reasoning(b.reasoningMode),
    Date.now(),
    c.id,
  );
  return { ok: true };
});
async function modelBudget(student) {
  return callBroker({ op: "budget", student });
}
app.get("/api/status", async (req) => ({
  model: await modelBudget(req.student.student),
  hostingLimit: 3,
  projectLimit: 10,
}));

const subscribers = new Map();
function closeStreams(token, user) {
  for (const set of subscribers.values())
    for (const res of [...set])
      if (
        (token && res.sessionHash === token) ||
        (user && res.studentId === user)
      ) {
        set.delete(res);
        res.end();
      }
}

function notify(run, event, data) {
  for (const res of subscribers.get(run) ?? [])
    if (!res.destroyed)
      res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
}
app.post("/api/chats/:id/messages", async (req) => {
  const c = ownChat(req.student, req.params.id),
    b = fields(req.body, ["text", "requestId", "reasoningMode"], ["text"]);
  const reasoningMode = reasoning(b.reasoningMode ?? c.reasoning_mode);
  const text = str(b.text, 8192);
  if (Buffer.byteLength(text) > 8192) throw fail("INVALID_INPUT");
  const run = b.requestId ? id(b.requestId) : rid(),
    existing = db.prepare("SELECT * FROM runs WHERE id=?").get(run);
  if (existing) {
    if (
      existing.user_id !== req.student.user_id ||
      existing.chat_id !== c.id ||
      existing.prompt !== text ||
      existing.reasoning_mode !== reasoningMode
    )
      throw fail("INVALID_INPUT", 409);
    return { id: run, state: existing.state };
  }
  unlocked(c.project_id);
  rate("ai:" + req.student.user_id, 10);
  const budget = await modelBudget(req.student.student);
  if (!budget.ready) throw fail("AI_UNAVAILABLE", 503);
  if (budget.maxRemainingCalls < 1) throw fail("AI_BUDGET_EXHAUSTED", 409);
  unlocked(c.project_id);
  if (
    db
      .prepare("SELECT count(*) n FROM runs WHERE state IN('queued','running')")
      .get().n >= 10
  )
    throw fail("QUEUE_LIMIT", 409);
  const now = Date.now(),
    fresh = ownChat(req.student, c.id);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "INSERT INTO runs(id,chat_id,project_id,user_id,state,prompt,base_revision,partial,error,created,updated,reasoning_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      run,
      c.id,
      c.project_id,
      req.student.user_id,
      "queued",
      text,
      fresh.revision,
      "",
      null,
      now,
      now,
      reasoningMode,
    );
    message(c.id, "user", text);
    db.prepare("UPDATE chats SET updated=? WHERE id=?").run(now, c.id);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw fail("PROJECT_BUSY", 423);
  }
  void pump();
  return { id: run, state: "queued" };
});
app.get("/api/runs/:id", async (req) => {
  const r = ownRun(req.student, req.params.id);
  return { id: r.id, state: r.state, error: r.error, partial: r.partial };
});
app.post("/api/runs/:id/cancel", async (req) => {
  const r = ownRun(req.student, req.params.id);
  if (r.state === "queued") {
    db.prepare(
      "UPDATE runs SET state='cancelled',error='CANCELLED',updated=? WHERE id=?",
    ).run(Date.now(), r.id);
    notify(r.id, "complete", { state: "cancelled" });
    return { cancelled: true };
  }
  if (r.state === "running") {
    await callBroker({ op: "cancel", run: r.id });
    return { cancelled: true };
  }
  return { cancelled: false };
});
app.get("/api/runs/:id/events", async (req, reply) => {
  const r = ownRun(req.student, req.params.id);
  rate("events:" + req.student.user_id, 40);
  const set = subscribers.get(r.id) ?? new Set();
  if (set.size >= 4) throw fail("RATE_LIMIT", 429);
  subscribers.set(r.id, set);
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });
  res.sessionHash = req.student.token_hash;
  res.studentId = req.student.user_id;
  set.add(res);
  res.write(
    "event: status\ndata: " + JSON.stringify({ state: r.state }) + "\n\n",
  );
  if (r.partial)
    res.write(
      "event: delta\ndata: " + JSON.stringify({ text: r.partial }) + "\n\n",
    );
  if (!["queued", "running"].includes(r.state)) {
    res.write(
      "event: complete\ndata: " +
        JSON.stringify({ state: r.state, error: r.error }) +
        "\n\n",
    );
    res.end();
    set.delete(res);
    return;
  }
  const keep = setInterval(() => {
      const live = db
        .prepare(
          "SELECT s.epoch,s.expires,u.epoch current_epoch FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?",
        )
        .get(res.sessionHash);
      if (
        !live ||
        live.expires < Date.now() ||
        live.epoch !== live.current_epoch
      ) {
        res.end();
        return;
      }
      if (!res.destroyed) res.write(": alive\n\n");
    }, 15000),
    end = setTimeout(() => res.end(), 1850000);
  res.on("close", () => {
    clearInterval(keep);
    clearTimeout(end);
    set.delete(res);
    if (!set.size) subscribers.delete(r.id);
  });
});
let pumping = false,
  lastStudent = null;
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (true) {
      const run = db
        .prepare(
          "SELECT * FROM runs WHERE state='queued' ORDER BY CASE WHEN user_id=? THEN 1 ELSE 0 END,created LIMIT 1",
        )
        .get(lastStudent ?? "");
      if (!run) break;
      lastStudent = run.user_id;
      let complete = false,
        partial = "",
        lastSaved = 0;
      function finish(state, code = null, answer = "", tools = [], cursor) {
        db.prepare(
          "UPDATE runs SET state=?,error=?,partial=?,updated=? WHERE id=?",
        ).run(state, code, answer || partial, Date.now(), run.id);
        if (answer || tools.length)
          message(run.chat_id, "assistant", answer, tools);
        if (code)
          message(
            run.chat_id,
            "notice",
            ru[code] ??
              "Запрос прерван. Изменения в проекте могли сохраниться. Проверьте файлы.",
          );
        if (cursor !== undefined)
          db.prepare("UPDATE chats SET cursor=?,updated=? WHERE id=?").run(
            cursor,
            Date.now(),
            run.chat_id,
          );
        bump(run.project_id);
        notify(run.id, "complete", { state, error: code });
        complete = true;
      }
      const project = db
        .prepare("SELECT revision FROM projects WHERE id=?")
        .get(run.project_id);
      if (project.revision !== run.base_revision) {
        finish("failed", "BASE_REVISION_CHANGED");
        continue;
      }
      db.prepare(
        "UPDATE runs SET state='running',updated=? WHERE id=? AND state='queued'",
      ).run(Date.now(), run.id);
      notify(run.id, "phase", { text: "Запускаю помощника" });
      try {
        const chat = db
          .prepare("SELECT cursor FROM chats WHERE id=?")
          .get(run.chat_id);
        const response = await callBroker(
          {
            op: "ai",
            project: run.project_id,
            chat: run.chat_id,
            run: run.id,
            text: run.prompt,
            cursor: chat.cursor,
            reasoningMode: run.reasoning_mode,
          },
          { stream: true },
        );
        response.setEncoding("utf8");
        let buffer = "";
        for await (const data of response) {
          buffer += data.toString();
          if (buffer.length > 8388608) throw fail("BROKER_UNAVAILABLE", 503);
          let at;
          while ((at = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            const event = frame
                .split("\n")
                .find((l) => l.startsWith("event: "))
                ?.slice(7),
              line = frame
                .split("\n")
                .find((l) => l.startsWith("data: "))
                ?.slice(6);
            if (!event || !line) continue;
            const value = JSON.parse(line);
            if (event === "delta") {
              partial += value.text ?? "";
              if (Buffer.byteLength(partial) > 8388608)
                throw fail("RESULT_BYTES_LIMIT", 409);
              if (Date.now() - lastSaved > 150) {
                db.prepare(
                  "UPDATE runs SET partial=?,updated=? WHERE id=?",
                ).run(partial, Date.now(), run.id);
                lastSaved = Date.now();
              }
              notify(run.id, "delta", value);
            } else if (event === "complete") {
              finish(
                value.cancelled
                  ? "cancelled"
                  : value.error
                    ? "failed"
                    : "completed",
                value.error ?? (value.cancelled ? "CANCELLED" : null),
                value.text,
                value.tools,
                value.cursor,
              );
            } else if (event === "failed")
              finish(
                value.error === "CANCELLED" ? "cancelled" : "failed",
                value.error,
              );
            else notify(run.id, event, value);
          }
        }
        if (!complete) finish("interrupted", "BROKER_UNAVAILABLE");
      } catch (e) {
        if (!complete) finish("failed", e.message);
      }
    }
  } finally {
    pumping = false;
  }
}
const mime = {
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};
app.get("/published/:release/*", async (req, reply) => {
  const r = await callBroker({
    op: "published",
    release: id(req.params.release),
  });
  let file = req.params["*"] || "index.html";
  file = filePath(file);
  if (file.endsWith("/")) file += "index.html";
  const root = r.directory;
  const target = path.resolve(root, file);
  if (!target.startsWith(root + "/")) throw fail("NOT_FOUND", 404);
  let fd;
  try {
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > 262144) throw fail("NOT_FOUND", 404);
    const body = Buffer.alloc(st.size);
    readSync(fd, body, 0, body.length, 0);
    reply.header(
      "Content-Security-Policy",
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' " +
        PREVIEW +
        "; style-src 'unsafe-inline' " +
        PREVIEW +
        "; img-src data: " +
        PREVIEW +
        "; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors " +
        ORIGIN,
    );
    reply
      .header("Access-Control-Allow-Origin", "*")
      .header("Referrer-Policy", "no-referrer")
      .type(mime[path.extname(file)] ?? "text/plain")
      .send(body);
  } catch (e) {
    throw fail("NOT_FOUND", 404);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
});
app.get("/health", async () => ({ ok: true }));
app.get("/*", async (req, reply) => {
  const publicRoot = ROOT + "/web",
    url = req.url.split("?")[0];
  if (url.startsWith("/api/")) throw fail("NOT_FOUND", 404);
  let file = url === "/" ? "index.html" : decodeURIComponent(url.slice(1));
  if (
    file.includes("..") ||
    file.includes("\\") ||
    file.startsWith(".") ||
    file.includes("\0")
  )
    throw fail("NOT_FOUND", 404);
  const resolved = path.resolve(publicRoot, file);
  if (!resolved.startsWith(publicRoot + "/")) throw fail("NOT_FOUND", 404);
  if (!existsSync(resolved)) {
    if (!file.includes(".")) file = "index.html";
    else throw fail("NOT_FOUND", 404);
  }
  reply
    .header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src " +
        PREVIEW +
        "; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
    )
    .type(mime[path.extname(file)] ?? "application/octet-stream");
  if (file.startsWith("assets/"))
    reply.header("Cache-Control", "public,max-age=31536000,immutable");
  return readFileSync(publicRoot + "/" + file);
});
await callBroker({ op: "recover" });
for (const run of db
  .prepare("SELECT id,chat_id FROM runs WHERE state='running'")
  .all())
  message(
    run.chat_id,
    "notice",
    "Запрос прерван перезапуском. Изменения могли сохраниться — проверь файлы. Автоматически повторять запрос не будем.",
  );
db.prepare(
  "UPDATE runs SET state='interrupted',error='BROKER_UNAVAILABLE',updated=? WHERE state='running'",
).run(Date.now());
await app.listen({ host: "127.0.0.1", port: 8820 });
console.log("Student portal ready");
void pump();
process.on("SIGTERM", () => {
  void app.close().then(() => process.exit(0));
});
