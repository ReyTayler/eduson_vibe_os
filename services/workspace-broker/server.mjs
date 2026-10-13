/** Root-only typed workspace/engine coordinator, reachable solely through a protected Unix socket. */
import http from "node:http";
import { classifyRunFailure, classifyRpcFailure } from "./run-errors.mjs";
import { adminModelRequest } from "./admin-model.mjs";
import { requestChatTitle } from "./chat-title.mjs";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  chownSync,
  existsSync,
  openSync,
  closeSync,
  fsyncSync,
  readdirSync,
  statSync,
  lstatSync,
  rmSync,
} from "node:fs";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
const DATA = "/srv/vibe-os/data/student-projects",
  CONFIG = "/etc/vibe-os/student-projects",
  REGISTRY = "/var/lib/vibe-os/student-registry";
const state = "/var/lib/vibe-os/portal-broker";
const capability = readFileSync(
  "/var/lib/vibe-os/portal-private/broker-capability",
  "utf8",
).trim();
const templateTool = readFileSync(
  "/opt/vibe-os/portal-broker/templates/tool.cfg",
  "utf8",
);
const templateEngine = readFileSync(
  "/opt/vibe-os/portal-broker/templates/engine.cfg",
  "utf8",
);
const templateProfile = JSON.parse(
  readFileSync("/opt/vibe-os/portal-broker/templates/profile.json", "utf8"),
);
const templatePackage = readFileSync(
  "/opt/vibe-os/portal-broker/templates/package.json",
  "utf8",
);
const studentModelCapabilities = new Map(
  JSON.parse(
    readFileSync("/etc/vibe-os/credentials/student-capabilities.json", "utf8"),
  ).map((row) => [row.student, row.capability]),
);
if (studentModelCapabilities.size !== 5)
  throw new Error("FIVE_STUDENT_CAPABILITIES_REQUIRED");
const db = new DatabaseSync(state + "/runtime.sqlite");
db.exec(
  "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=5000",
);
db.exec(`CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,student INTEGER NOT NULL CHECK(student BETWEEN 1 AND 5),quota INTEGER UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY,project TEXT NOT NULL REFERENCES projects(id),created INTEGER NOT NULL,preview INTEGER NOT NULL CHECK(preview IN(0,1)),bytes INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS hosted(project TEXT PRIMARY KEY REFERENCES projects(id),student INTEGER NOT NULL,release TEXT NOT NULL REFERENCES snapshots(id),slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 3),UNIQUE(student,slot));`);
db.exec(
  "CREATE TABLE IF NOT EXISTS metadata(name TEXT PRIMARY KEY,value INTEGER NOT NULL);INSERT OR IGNORE INTO metadata VALUES('next_quota',2001);UPDATE metadata SET value=max(value,(SELECT coalesce(max(quota),2000)+1 FROM projects)) WHERE name='next_quota'",
);
const engines = new Map(),
  locks = new Set();

const budgets = new Map();
async function budget(student) {
  if (!Number.isInteger(student) || student < 1 || student > 5)
    throw error("INVALID_STUDENT");
  const item = budgets.get(student) ?? { at: 0, value: null, pending: null };
  budgets.set(student, item);
  if (
    item.value &&
    Date.now() - item.at < 1000 &&
    Date.now() < Date.parse(item.value.resetsAt)
  )
    return item.value;
  if (!item.pending)
    item.pending = new Promise((resolve, reject) => {
      const req = http.get(
        {
          socketPath: "/run/vibe-os-model/gateway.sock",
          path: "/v1/status",
          headers: {
            Authorization: "Bearer " + studentModelCapabilities.get(student),
            "X-Vibe-Credential": String(19 + student),
          },
        },
        (res) => {
          const parts = [];
          let bytes = 0;
          res.on("data", (c) => {
            bytes += c.length;
            if (bytes > 32768) req.destroy();
            else parts.push(c);
          });
          res.on("error", reject);
          res.on("end", () => {
            try {
              if (res.statusCode !== 200)
                throw error("BUDGET_UNAVAILABLE", 503);
              const v = JSON.parse(Buffer.concat(parts)).budget;
              const monetary = v.unit === "credits";
              if (
                v.student !== student ||
                v.period !== "weekly" ||
                (monetary
                  ? v.baseLimitCredits !== 1000 ||
                    !Number.isSafeInteger(v.extraLimitCredits) ||
                    v.extraLimitCredits < 0 ||
                    v.limitCredits !==
                      v.baseLimitCredits + v.extraLimitCredits ||
                    [
                      v.spentCredits,
                      v.reservedCredits,
                      v.remainingCredits,
                    ].some((n) => !Number.isFinite(n) || n < 0) ||
                    !v.usage
                  : v.baseLimitTokens !== 1000000 ||
                    !Number.isSafeInteger(v.extraLimitTokens) ||
                    v.extraLimitTokens < 0 ||
                    v.limitTokens !== v.baseLimitTokens + v.extraLimitTokens)
              )
                throw error("BUDGET_SCOPE_MISMATCH", 503);
              item.value = {
                unit: monetary ? "credits" : "tokens",
                ...(monetary
                  ? {
                      baseLimitCredits: v.baseLimitCredits,
                      extraLimitCredits: v.extraLimitCredits,
                      limitCredits: v.limitCredits,
                      spentCredits: v.spentCredits,
                      reservedCredits: v.reservedCredits,
                      remainingCredits: v.remainingCredits,
                      costUsd: v.costUsd,
                      costBasis: v.costBasis,
                      pricingVersion: v.pricingVersion,
                      usage: v.usage,
                    }
                  : {}),
                limitTokens: v.limitTokens,
                baseLimitTokens: v.baseLimitTokens,
                extraLimitTokens: v.extraLimitTokens,
                confirmedTokens: v.confirmed_tokens,
                reservedTokens: v.uncertain_ceiling,
                remainingTokens: v.remainingAuthorizationTokens,
                maxRemainingCalls: v.maxRemainingCalls,
                ready: v.enabled === true,
                period: "weekly",
                timezone: v.timezone,
                periodStartsAt: v.periodStartsAt,
                resetsAt: v.resetsAt,
              };
              item.at = Date.now();
              resolve(item.value);
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      req.on("error", () => reject(error("BUDGET_UNAVAILABLE", 503)));
      req.setTimeout(3000, () => req.destroy());
    }).finally(() => {
      item.pending = null;
    });
  try {
    return await item.pending;
  } catch {
    return {
      ...(item.value ?? {
        unit: "credits",
        baseLimitCredits: 1000,
        extraLimitCredits: 0,
        limitCredits: 1000,
        spentCredits: 0,
        reservedCredits: 0,
        remainingCredits: 0,
        limitTokens: 1000000,
        confirmedTokens: 0,
        reservedTokens: 0,
        remainingTokens: 0,
        period: "weekly",
        timezone: "Europe/Moscow",
        resetsAt: null,
      }),
      ready: false,
      maxRemainingCalls: 0,
    };
  }
}
function removeSnapshot(project, snapshot) {
  const id = identifier(project),
    rid = identifier(snapshot),
    directory = DATA + "/" + id + "/releases/" + rid;
  if (!directory.startsWith(DATA + "/" + id + "/releases/"))
    throw error("INVALID_PATH");
  if (existsSync(directory)) {
    const st = lstatSync(directory);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0)
      throw error("INVALID_SNAPSHOT");
    rmSync(directory, { recursive: true, force: false });
  }
  db.prepare("DELETE FROM snapshots WHERE id=? AND project=?").run(rid, id);
}
function cleanupSnapshots(id) {
  const rows = db
    .prepare(
      "SELECT s.id FROM snapshots s WHERE s.project=? AND NOT EXISTS(SELECT 1 FROM hosted h WHERE h.release=s.id) ORDER BY s.created DESC,s.id DESC",
    )
    .all(id);
  for (const row of rows.slice(3)) removeSnapshot(id, row.id);
}

const ID = /^[a-f0-9]{32}$/;
function error(code, status = 400) {
  return Object.assign(new Error(code), { status });
}
function identifier(v) {
  if (typeof v !== "string" || !ID.test(v)) throw error("INVALID_ID");
  return v;
}
function record(id) {
  identifier(id);
  const r = db.prepare("SELECT * FROM projects WHERE id=?").get(id);
  if (!r) throw error("PROJECT_NOT_FOUND", 404);
  return {
    ...r,
    ...JSON.parse(readFileSync(REGISTRY + "/" + id + ".json", "utf8")),
  };
}
function auth(req) {
  const value = req.headers.authorization ?? "";
  const token = value.startsWith("Bearer ") ? value.slice(7) : "";
  const a = Buffer.from(token),
    b = Buffer.from(capability);
  return a.length === b.length && timingSafeEqual(a, b);
}
function writeOwned(file, value, uid = 0, gid = 0, mode = 0o400) {
  writeFileSync(file, value, { mode });
  chownSync(file, uid, gid);
  chmodSync(file, mode);
}
function systemctl(...args) {
  const r = spawnSync("/usr/bin/systemctl", args, {
    encoding: "utf8",
    timeout: 15000,
  });
  if (r.status !== 0) throw error("SERVICE_OPERATION_FAILED", 503);
  return r.stdout;
}
function provision(id, student) {
  identifier(id);
  if (!Number.isInteger(student) || student < 1 || student > 5)
    throw error("INVALID_STUDENT");
  const prior = db.prepare("SELECT * FROM projects WHERE id=?").get(id);
  if (prior) {
    if (prior.student !== student) throw error("OWNER_MISMATCH", 403);
    return { created: false };
  }
  if (db.prepare("SELECT count(*) AS n FROM projects").get().n >= 50)
    throw error("PROJECT_LIMIT", 409);
  const quota = db
    .prepare("SELECT value FROM metadata WHERE name='next_quota'")
    .get().value;
  db.prepare("UPDATE metadata SET value=value+1 WHERE name='next_quota'").run();
  const engineUID = 28000 + student,
    toolUID = 29000 + student,
    base = DATA + "/" + id,
    config = CONFIG + "/" + id;
  if (existsSync(base) || existsSync(config))
    throw error("PROVISION_CONFLICT", 409);
  mkdirSync(base, { mode: 0o711 });
  chownSync(base, 0, 27000);
  mkdirSync(config, { mode: 0o700 });
  for (const [name, uid, gid, mode] of [
    ["workspace", toolUID, toolUID, 0o700],
    ["engine", engineUID, 23000, 0o700],
    ["releases", 0, 27000, 0o750],
  ]) {
    mkdirSync(base + "/" + name, { mode });
    chownSync(base + "/" + name, uid, gid);
  }
  const token = randomBytes(32).toString("hex");
  writeOwned(base + "/capability", token + "\n", engineUID, 23000);
  writeOwned(
    base + "/model-capability",
    studentModelCapabilities.get(student) + "\n",
    engineUID,
    23000,
  );
  writeOwned(base + "/project-id", id + "\n", engineUID, 23000);
  mkdirSync(base + "/engine/profiles", { mode: 0o700 });
  chownSync(base + "/engine/profiles", engineUID, 23000);
  mkdirSync(base + "/engine/profiles/student", { mode: 0o700 });
  chownSync(base + "/engine/profiles/student", engineUID, 23000);
  const profile = structuredClone(templateProfile);
  profile[0].insert = profile[0].insert.filter((p) => p.id !== "school-mock");
  for (const p of profile[0].insert) {
    if (p.id === "sdk-app-startup") p.config.profile = "student";
    if (p.id === "school-deepseek") {
      p.config.credentialId = 19 + student;
      delete p.config.maxTokens;
    }
    if (p.id === "sdk-jsonrpc-server") {
      delete p.config.maxSteps;
      p.config.maxLogBytes = 96 * 1024 * 1024;
      p.config.maxLogEvents = 1000000;
      p.config.maxEventBytes = 128 * 1024 * 1024;
      p.config.maxReadBytes = 128 * 1024 * 1024;
      delete p.config.maxTokens;
    }
    if (p.id === "system-prompt")
      p.config.personaPrefix =
        "Ты — внимательный помощник ученика по программированию. Отвечай по-русски. Выполняй просьбы, используя инструменты чтения, создания и изменения файлов в /workspace. Сначала изучай существующие файлы. Создавай нужные папки. Проверяй результат короткими командами. Сеть, долгие процессы и запуск веб-серверов недоступны. Для веб-проекта создай index.html, CSS и JavaScript: предпросмотр и публикацию обеспечивает кабинет. Не заявляй об изменениях, если инструмент их не подтвердил. Не проси API-ключи, не пытайся читать служебные файлы.";
  }
  profile[0].insert.push({
    id: "student-workspace-tools",
    name: "/opt/vibe-os/poc-profile/workspace-tools.js",
  });
  writeOwned(
    base + "/engine/profiles/student/package.json",
    templatePackage,
    0,
    0,
    0o444,
  );
  writeOwned(
    base + "/engine/profiles/student/cordis.patch.yml",
    JSON.stringify(profile, null, 2),
    0,
    0,
    0o444,
  );
  let tool = templateTool
    .replace(
      'dst: "/workspace" is_bind: true rw: true',
      'dst: "/workspace" is_bind: true rw: true is_dir: true',
    )
    .replaceAll("/srv/vibe-os/data/poc-project-1", base + "/workspace")
    .replaceAll('outside_id: "23001"', 'outside_id: "' + toolUID + '"');
  let engine = templateEngine.replace(
    'src: "/opt/vibe-os/poc-profile"',
    'src: "/opt/vibe-os/portal-profile"',
  );
  engine = engine
    .replaceAll("/srv/vibe-os/data/poc-engine-1", base + "/engine")
    .replaceAll("/run/vibe-os-poc", "/run/vibe-os-workspace");
  engine = engine
    .replaceAll("/var/lib/vibe-os/poc-engine/capability", base + "/capability")
    .replaceAll(
      "/var/lib/vibe-os/poc-engine/model-capability",
      base + "/model-capability",
    );
  engine = engine
    .split("\n")
    .filter((line) => !line.includes("/profiles/school-poc/"))
    .join("\n");
  engine = engine
    .replaceAll("/profiles/school-live/", "/profiles/student/")
    .replaceAll(
      'outside_id: "23000" count: 1 }',
      'outside_id: "' + engineUID + '" count: 1 }',
    );
  engine = engine.replace(
    'gidmap { inside_id: "1000" outside_id: "' + engineUID + '"',
    'gidmap { inside_id: "1000" outside_id: "23000"',
  );
  engine +=
    '\nmount { src: "' +
    base +
    '/project-id" dst: "/project-id" is_bind: true rw: false is_dir: false }\n';
  writeOwned(config + "/tool.cfg", tool, 0, 0, 0o444);
  writeOwned(config + "/engine.cfg", engine, 0, 0, 0o444);
  const quotaArgs = [
    "-x",
    "-c",
    "project -s -p " + base + " " + quota,
    "-c",
    "limit -p bsoft=128m bhard=128m isoft=4096 ihard=4096 " + quota,
    "/srv/vibe-os/data",
  ];
  const q = spawnSync("/usr/sbin/xfs_quota", quotaArgs, {
    encoding: "utf8",
    timeout: 10000,
  });
  if (q.status !== 0) throw error("QUOTA_SETUP_FAILED", 503);
  writeOwned(
    REGISTRY + "/" + id + ".json",
    JSON.stringify({
      workspace: base + "/workspace",
      config: config + "/tool.cfg",
      token,
      uid: engineUID,
      toolUid: toolUID,
    }),
    0,
    0,
    0o600,
  );
  db.prepare("INSERT INTO projects VALUES(?,?,?)").run(id, student, quota);
  return { created: true };
}
function operation(id, body) {
  const r = record(id),
    bytes = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: "/run/vibe-os-workspace/runner.sock",
        method: "POST",
        path: "/v1/operation",
        headers: {
          Authorization: "Bearer " + r.token,
          "X-Vibe-Project": id,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bytes),
        },
      },
      (res) => {
        const chunks = [];
        let n = 0;
        res.on("data", (c) => {
          n += c.length;
          if (n > 3 * 1024 * 1024) {
            req.destroy(error("RUNNER_OUTPUT_LIMIT"));
            return;
          }
          chunks.push(c);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const v = JSON.parse(Buffer.concat(chunks));
            if (res.statusCode !== 200)
              throw error(
                v.error?.includes("STALE")
                  ? "FILE_CHANGED"
                  : v.error?.includes("ENOENT") ||
                      v.error?.includes("no such file")
                    ? "FILE_NOT_FOUND"
                    : "WORKSPACE_OPERATION_FAILED",
                v.error?.includes("STALE") ? 409 : 400,
              );
            resolve(v.result);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", () => reject(error("WORKSPACE_UNAVAILABLE", 503)));
    req.setTimeout(12000, () => req.destroy(error("WORKSPACE_TIMEOUT", 503)));
    req.end(bytes);
  });
}
function checkUnlocked(id) {
  if (locks.has(id) || [...engines.values()].some((e) => e.project === id))
    throw error("PROJECT_BUSY", 423);
}
function relative(v) {
  if (
    typeof v !== "string" ||
    v.length > 512 ||
    v.includes("\0") ||
    v.startsWith("/") ||
    v.split("/").some((p) => p === "..") ||
    v.split("/").some((p) => p.startsWith("."))
  )
    throw error("INVALID_PATH");
  return v;
}
async function snapshot(id, preview) {
  record(id);
  checkUnlocked(id);
  locks.add(id);
  try {
    await operation(id, { op: "barrier" });
    cleanupSnapshots(id);
    const rid = randomBytes(16).toString("hex"),
      target = DATA + "/" + id + "/releases/" + rid;
    const entries = [];
    let bytes = 0;
    async function collect(dir, depth = 0) {
      if (depth > 12) throw error("DIRECTORY_DEPTH_LIMIT");
      const rows = await operation(id, { op: "list", path: dir || "." });
      for (const row of rows) {
        if (row.name.startsWith(".")) continue;
        const name = dir ? dir + "/" + row.name : row.name;
        relative(name);
        if (row.info.type === "directory") {
          await collect(name, depth + 1);
          continue;
        }
        if (row.info.type !== "file") continue;
        if (entries.length >= 256 || row.info.size > 262144)
          throw error("PUBLICATION_FILE_LIMIT");
        if (!/\.(html|css|js|mjs|json|txt|svg|md)$/i.test(name)) continue;
        const result = await operation(id, { op: "read", path: name });
        bytes += Buffer.byteLength(result.text);
        if (bytes > 2 * 1024 * 1024) throw error("PUBLICATION_SIZE_LIMIT");
        entries.push([name, result.text]);
      }
    }
    await collect("");
    if (!entries.some(([n]) => n === "index.html"))
      throw error("INDEX_HTML_REQUIRED", 409);
    mkdirSync(target, { mode: 0o750 });
    chownSync(target, 0, 27000);
    for (const [name, text] of entries) {
      const parent = path.dirname(target + "/" + name);
      mkdirSync(parent, { recursive: true, mode: 0o750 });
      let walk = parent;
      while (walk.startsWith(target) && walk !== path.dirname(target)) {
        chownSync(walk, 0, 27000);
        chmodSync(walk, 0o750);
        if (walk === target) break;
        walk = path.dirname(walk);
      }
      const file = target + "/" + name;
      writeOwned(file, text, 0, 27000, 0o444);
      const fd = openSync(file, "r");
      fsyncSync(fd);
      closeSync(fd);
    }
    const fd = openSync(target, "r");
    fsyncSync(fd);
    closeSync(fd);
    db.prepare("INSERT INTO snapshots VALUES(?,?,?,?,?)").run(
      rid,
      id,
      Date.now(),
      preview ? 1 : 0,
      bytes,
    );
    cleanupSnapshots(id);
    return { release: rid, files: entries.length, bytes };
  } finally {
    locks.delete(id);
  }
}
function host(id, release) {
  const r = record(id);
  identifier(release);
  checkUnlocked(id);
  const snap = db
    .prepare("SELECT * FROM snapshots WHERE id=? AND project=?")
    .get(release, id);
  if (!snap) throw error("RELEASE_NOT_FOUND", 404);
  db.exec("BEGIN IMMEDIATE");
  try {
    const prior = db.prepare("SELECT * FROM hosted WHERE project=?").get(id);
    if (prior) {
      db.prepare("UPDATE hosted SET release=? WHERE project=?").run(
        release,
        id,
      );
    } else {
      const used = db
        .prepare("SELECT slot FROM hosted WHERE student=?")
        .all(r.student)
        .map((r) => r.slot);
      const slot = [1, 2, 3].find((s) => !used.includes(s));
      if (!slot) throw error("THREE_HOSTING_SLOTS", 409);
      db.prepare("INSERT INTO hosted VALUES(?,?,?,?)").run(
        id,
        r.student,
        release,
        slot,
      );
    }
    db.exec("COMMIT");
    return {
      hosting: true,
      release,
      slot: db.prepare("SELECT slot FROM hosted WHERE project=?").get(id).slot,
    };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
function resolveRelease(rid) {
  identifier(rid);
  const alias = db
    .prepare("SELECT release FROM hosted WHERE project=?")
    .get(rid);
  if (alias) rid = alias.release;
  const s = db.prepare("SELECT * FROM snapshots WHERE id=?").get(rid);
  if (!s) throw error("PREVIEW_UNAVAILABLE", 404);
  const hosted = db.prepare("SELECT 1 FROM hosted WHERE release=?").get(rid);
  if (!hosted && (!s.preview || s.created < Date.now() - 60 * 60 * 1000))
    throw error("PREVIEW_UNAVAILABLE", 404);
  return {
    directory: DATA + "/" + s.project + "/releases/" + rid,
    project: s.project,
    preview: !hosted,
  };
}
function emit(res, event, data) {
  if (!res.destroyed)
    res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
}
async function ai(params, res) {
  const id = identifier(params.project),
    sid = identifier(params.chat),
    run = identifier(params.run);
  const reasoningMode = params.reasoningMode ?? "off";
  if (!["off", "low", "high", "max"].includes(reasoningMode))
    throw error("INVALID_REASONING_MODE");
  record(id);
  checkUnlocked(id);
  if (engines.size) throw error("AI_WORKER_BUSY", 423);
  if (
    params.op !== "inspect" &&
    (typeof params.text !== "string" || Buffer.byteLength(params.text) > 8192)
  )
    throw error("PROMPT_LIMIT");
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
  });
  const unit = "vibe-student-engine-" + run + ".service";
  const child = spawn(
    "/usr/bin/systemd-run",
    [
      "--quiet",
      "--collect",
      "--pipe",
      "--wait",
      "--service-type=exec",
      "--unit=" + unit,
      "--slice=vibe-student-engines.slice",
      "-p",
      "MemoryMax=1024M",
      "-p",
      "MemorySwapMax=0",
      "-p",
      "TasksMax=64",
      "-p",
      "CPUQuota=100%",
      "-p",
      "KillMode=control-group",
      "/opt/vibe-os/bin/nsjail",
      "--quiet",
      "--config",
      CONFIG + "/" + id + "/engine.cfg",
      "--",
      "/usr/bin/node",
      "/opt/vibe-os/build/deepseek-harness/apps/cli/lib/bin.js",
      "--profile",
      "student",
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
    },
  );
  let lineParts = [],
    lineBytes = 0,
    stderr = "",
    counter = 0,
    settledResolve,
    settledReject,
    stopped = false;
  const pending = new Map();
  const settled = new Promise((resolve, reject) => {
    settledResolve = resolve;
    settledReject = reject;
  });
  settled.catch(() => {});
  function rpc(method, values, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const n = ++counter;
      const timer = setTimeout(() => {
        pending.delete(n);
        console.error("Student engine RPC timeout", method);
        reject(error("ENGINE_PROTOCOL_TIMEOUT", 503));
      }, timeout);
      pending.set(n, { resolve, reject, timer });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: n, method, params: values }) +
          "\n",
      );
    });
  }
  const engine = {
    project: id,
    unit,
    child,
    cancelled: false,
    cancel: async () => {
      engine.cancelled = true;
      return rpc("session/cancel", { sessionId: sid, runId: run }, 20000);
    },
  };
  engines.set(run, engine);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => {
    stderr = (stderr + c.toString()).slice(-8192);
  });
  child.stdout.on("data", (chunk) => {
    for (const p of pending.values()) p.timer.refresh();
    const pieces = chunk.toString().split("\n");
    for (let i = 0; i < pieces.length; i++) {
      lineParts.push(pieces[i]);
      lineBytes += Buffer.byteLength(pieces[i]);
      if (lineBytes > 256 * 1024 * 1024) {
        settledReject(error("ENGINE_OUTPUT_LIMIT", 503));
        return;
      }
      if (i === pieces.length - 1) break;
      const line = lineParts.join("");
      lineParts = [];
      lineBytes = 0;
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) {
            const failure = classifyRpcFailure(msg.error);
            console.error(
              "Student engine RPC failure",
              failure.code,
              failure.reason,
            );
            p.reject(error(failure.code, 503));
          } else p.resolve(msg.result);
        }
        if (msg.method === "session.delta" && msg.params?.runId === run) {
          const f = msg.params.frame;
          const chunk = f?.chunk ?? f;
          if (chunk?.type === "text-delta" && typeof chunk.text === "string")
            emit(res, "delta", { text: chunk.text });
        }
        if (
          (msg.method === "session.settled" ||
            msg.method === "session.failure") &&
          msg.params?.runId === run
        )
          settledResolve(msg.params);
      } catch (parseError) {
        settledReject(error("ENGINE_PROTOCOL_ERROR", 503));
      }
    }
  });
  child.on("error", () => settledReject(error("ENGINE_START_FAILED", 503)));
  child.on("close", () => {
    stopped = true;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error("ENGINE_STOPPED", 503));
    }
    pending.clear();
    settledReject(error("ENGINE_STOPPED", 503));
  });
  try {
    emit(res, "phase", { text: "Запускаю помощника" });
    const initialized = await rpc("initialize", {
      provider: "school-deepseek",
      model: "deepseek-flash",
      reasoningMode,
    });
    const opened = await rpc("session/open", { sessionId: sid });
    if (
      !Number.isSafeInteger(opened.persistedCursor) ||
      opened.persistedCursor < 0
    )
      throw error("ENGINE_CURSOR_INVALID", 503);
    const startCursor = opened.persistedCursor;
    if (params.op === "inspect") {
      await rpc("shutdown", {}, 8000);
      await operation(id, { op: "barrier" });
      emit(res, "inspected", {
        sessionId: sid,
        resumed: opened.resumed,
        cursor: startCursor,
        paidCalls: 0,
        reasoningMode: initialized.reasoningMode,
        maxTokens: initialized.maxTokens,
        maxSteps: initialized.maxSteps,
        outputPolicy: initialized.outputPolicy,
      });
      return;
    }
    emit(res, "phase", { text: "Работаю с проектом" });
    await rpc("session/prompt", {
      sessionId: sid,
      runId: run,
      text: params.text,
    });
    const result = await settled;
    const events = [];
    let cursor = startCursor;
    for (;;) {
      const page = await rpc(
        "session/read",
        { sessionId: sid, cursor },
        180000,
      );
      events.push(...page.events);
      if (page.events.length === 0) break;
      if (page.nextCursor <= cursor) throw error("HISTORY_CURSOR_INVALID", 503);
      cursor = page.nextCursor;
    }
    const messages = events
      .filter((e) => e.type === "assistant/message")
      .map((e) => e.data?.message?.content ?? []);
    const answer = messages
      .flat()
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n\n");
    const tools = events
      .filter((e) => e.type === "tool/call")
      .map((e) => ({ name: e.data.name, arguments: e.data.arguments }))
      .slice(0, 24);
    const usage = events
      .filter((e) => e.type === "assistant/message")
      .reduce(
        (n, e) =>
          n +
          (e.data?.usage?.totalTokens ??
            (e.data?.usage?.inputTokens ?? 0) +
              (e.data?.usage?.outputTokens ?? 0)),
        0,
      );
    await rpc("shutdown", {}, 8000);
    const end = Date.now() + 5000;
    while (!stopped && Date.now() < end)
      await new Promise((r) => setTimeout(r, 30));
    await operation(id, { op: "barrier" });
    const failure = classifyRunFailure(result.error);
    if (failure)
      console.error(
        "Student model run failed",
        run,
        failure.code,
        failure.reason,
      );
    emit(res, "complete", {
      text: answer,
      tools,
      cursor,
      usage,
      cancelled: engine.cancelled,
      error: failure?.code,
      durable: result.durable === true,
    });
  } catch (e) {
    console.error(
      "Student engine failure",
      e.message,
      stderr.slice(-1800).replace(/[a-f0-9]{64}/g, "[redacted]"),
    );
    emit(res, "failed", { error: engine.cancelled ? "CANCELLED" : e.message });
  } finally {
    if (!stopped) {
      try {
        systemctl("stop", unit);
      } catch (cleanupError) {
        console.error("Engine stop unavailable");
      }
      child.kill("SIGKILL");
    }
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error("ENGINE_CLOSED", 503));
    }
    engines.delete(run);
    res.end();
  }
}
async function dispatch(p) {
  switch (p.op) {
    case "admin-budgets":
      return adminModelRequest("/v1/admin/overview");
    case "admin-grants":
      if (!Number.isInteger(p.student) || p.student < 1 || p.student > 5)
        throw error("INVALID_STUDENT");
      return adminModelRequest("/v1/admin/grants?student=" + p.student);
    case "admin-usage":
      if (!Number.isInteger(p.student) || p.student < 1 || p.student > 5)
        throw error("INVALID_STUDENT");
      return adminModelRequest("/v1/admin/usage?student=" + p.student);
    case "admin-grant": {
      const result = await adminModelRequest("/v1/admin/grants", p.grant);
      budgets.delete(p.grant.student);
      return result;
    }
    case "chat-title": {
      if (
        Object.keys(p).some(
          (key) => !["op", "project", "context"].includes(key),
        )
      )
        throw error("INVALID_REQUEST");
      const project = record(identifier(p.project));
      if (engines.size) throw error("AI_WORKER_BUSY", 423);
      const value = await budget(project.student);
      if (!value.ready || !value.maxRemainingCalls)
        throw error("AI_BUDGET_EXHAUSTED", 409);
      try {
        const title = await requestChatTitle({
          student: project.student,
          capability: studentModelCapabilities.get(project.student),
          context: p.context,
        });
        return { title };
      } finally {
        budgets.delete(project.student);
      }
    }
    case "budget":
      return budget(p.student);
    case "provision":
      return provision(p.project, p.student);
    case "fs": {
      const id = identifier(p.project);
      record(id);
      if (
        ![
          "stat",
          "read",
          "write",
          "edit",
          "mkdir",
          "list",
          "remove",
          "rename",
        ].includes(p.action)
      )
        throw error("INVALID_OPERATION");
      if (["write", "edit", "mkdir", "remove", "rename"].includes(p.action))
        checkUnlocked(id);
      const body = { op: p.action, path: p.path ?? "." };
      for (const k of ["text", "old", "new", "replaceAll", "guard"])
        if (p[k] !== undefined) body[k] = p[k];
      return operation(id, body);
    }
    case "run":
      checkUnlocked(identifier(p.project));
      return operation(p.project, {
        op: "run",
        program: p.program,
        args: p.args,
        timeoutMs: 3000,
      });
    case "snapshot":
      return snapshot(identifier(p.project), p.preview === true);
    case "host":
      return host(identifier(p.project), p.release);
    case "unhost":
      record(identifier(p.project));
      db.prepare("DELETE FROM hosted WHERE project=?").run(p.project);
      return { hosting: false };
    case "delete": {
      const id = identifier(p.project);
      record(id);
      checkUnlocked(id);
      locks.add(id);
      try {
        await operation(id, { op: "barrier" });
        db.prepare("DELETE FROM hosted WHERE project=?").run(id);
        const rows = db
          .prepare("SELECT id FROM snapshots WHERE project=?")
          .all(id);
        for (const row of rows) removeSnapshot(id, row.id);
        const base = DATA + "/" + id,
          config = CONFIG + "/" + id;
        for (const d of [base, config]) {
          const st = lstatSync(d);
          if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0)
            throw error("INVALID_PROJECT_ROOT");
        }
        rmSync(base, { recursive: true, force: false });
        rmSync(config, { recursive: true, force: false });
        const { unlinkSync } = await import("node:fs");
        unlinkSync(REGISTRY + "/" + id + ".json");
        db.prepare("DELETE FROM projects WHERE id=?").run(id);
        return { deleted: true };
      } finally {
        locks.delete(id);
      }
    }
    case "hosting":
      return db
        .prepare(
          "SELECT project,release,slot,student FROM hosted ORDER BY student,slot",
        )
        .all();
    case "published":
      return resolveRelease(p.release);
    case "cancel": {
      const e = engines.get(identifier(p.run));
      if (!e) return { cancelled: false };
      await e.cancel();
      return { cancelled: true };
    }
    case "recover": {
      for (const [id, e] of engines) {
        e.cancelled = true;
        try {
          systemctl("stop", e.unit);
        } catch (cleanupError) {
          console.error("Recovery stop unavailable");
        }
        e.child.kill("SIGKILL");
      }
      const until = Date.now() + 10000;
      while (engines.size && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 25));
      if (engines.size) throw error("ENGINE_RECOVERY_PENDING", 503);
      return { recovered: true };
    }
    default:
      throw error("UNKNOWN_OPERATION");
  }
}
const socket = "/run/vibe-os-portal/broker.sock";
if (existsSync(socket)) {
  const s = statSync(socket);
  if (!s.isSocket()) throw new Error("Refusing to replace non-socket");
  const { unlinkSync } = await import("node:fs");
  unlinkSync(socket);
}
const server = http.createServer(async (req, res) => {
  if (!auth(req)) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (req.method !== "POST" || req.url !== "/v1/request") {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const chunks = [];
    let n = 0;
    for await (const c of req) {
      n += c.length;
      if (n > 300000) throw error("REQUEST_LIMIT", 413);
      chunks.push(c);
    }
    const p = JSON.parse(Buffer.concat(chunks));
    if (!p || typeof p !== "object" || Array.isArray(p))
      throw error("INVALID_REQUEST");
    if (p.op === "ai" || p.op === "inspect") {
      await ai(p, res);
      return;
    }
    const value = await dispatch(p);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result: value }));
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(e.status ?? 500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: e.status ? e.message : "BROKER_UNAVAILABLE" }),
      );
    } else res.end();
  }
});
server.requestTimeout = 1850000;
server.headersTimeout = 5000;
server.maxHeadersCount = 32;
server.listen(socket, () => {
  chmodSync(socket, 0o660);
  chownSync(socket, 0, 27000);
  console.log("Student workspace coordinator ready");
});
process.on("SIGTERM", () => {
  for (const e of engines.values()) {
    try {
      systemctl("stop", e.unit);
    } catch (cleanupError) {
      console.error("Shutdown stop unavailable");
    }
  }
  server.close(() => process.exit(0));
});
