/** Generation 3: variable input/output envelopes; confirmed usage settles a reserve; errors and unknown outcomes retain their full ceiling. */
import { DatabaseSync } from "node:sqlite";
export const TOKEN_CEILING = 1_000_000;
export const CALL_DEBIT = 131_072;
export const INPUT_SAFETY_MARGIN = 32_768;
export class LegacyLedger {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;",
    );
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS token_budget(id INTEGER PRIMARY KEY CHECK(id=1),limit_tokens INTEGER NOT NULL CHECK(limit_tokens=1000000),debited_tokens INTEGER NOT NULL DEFAULT 0 CHECK(debited_tokens>=0 AND debited_tokens<=limit_tokens),enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN(0,1)));
CREATE TABLE IF NOT EXISTS model_requests(id TEXT PRIMARY KEY,credential_id INTEGER NOT NULL CHECK(credential_id BETWEEN 20 AND 27),body_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('sent','settled','failed','uncertain')),debit INTEGER NOT NULL CHECK(debit BETWEEN 1 AND 1000000),input_tokens INTEGER,output_tokens INTEGER,cache_read INTEGER,cache_write INTEGER,total_tokens INTEGER,http_status INTEGER,created_at INTEGER NOT NULL DEFAULT(unixepoch()),ended_at INTEGER);
INSERT INTO token_budget(id,limit_tokens) SELECT 1,1000000 WHERE NOT EXISTS(SELECT 1 FROM token_budget WHERE id=1);
CREATE TABLE IF NOT EXISTS budget_authorization(id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL CHECK(generation=3),limit_tokens INTEGER NOT NULL CHECK(limit_tokens=1000000),enabled INTEGER NOT NULL CHECK(enabled IN(0,1)));
INSERT INTO budget_authorization(id,generation,limit_tokens,enabled) SELECT 1,3,limit_tokens,enabled FROM token_budget WHERE id=1 AND NOT EXISTS(SELECT 1 FROM budget_authorization WHERE id=1);`);
    const generation = this.db
      .prepare("SELECT generation FROM budget_authorization WHERE id=1")
      .get().generation;
    if (![2, 3].includes(generation))
      throw new Error("UNSUPPORTED_BUDGET_GENERATION");
    const oldRequestSchema = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE name='model_requests'")
      .get().sql;
    if (
      generation === 2 ||
      /CHECK\s*\(\s*debit\s*=\s*65536\s*\)/.test(oldRequestSchema)
    ) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(`
ALTER TABLE model_requests RENAME TO model_requests_generation2;
CREATE TABLE model_requests(id TEXT PRIMARY KEY,credential_id INTEGER NOT NULL CHECK(credential_id BETWEEN 20 AND 27),body_hash TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('sent','settled','failed','uncertain')),debit INTEGER NOT NULL CHECK(debit BETWEEN 1 AND 1000000),input_tokens INTEGER,output_tokens INTEGER,cache_read INTEGER,cache_write INTEGER,total_tokens INTEGER,http_status INTEGER,created_at INTEGER NOT NULL DEFAULT(unixepoch()),ended_at INTEGER);
INSERT INTO model_requests SELECT * FROM model_requests_generation2;
ALTER TABLE budget_authorization RENAME TO budget_authorization_generation2;
CREATE TABLE budget_authorization(id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL CHECK(generation=3),limit_tokens INTEGER NOT NULL CHECK(limit_tokens=1000000),enabled INTEGER NOT NULL CHECK(enabled IN(0,1)));
INSERT INTO budget_authorization SELECT id,3,limit_tokens,enabled FROM budget_authorization_generation2;
`);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
    const policy = this.db
      .prepare("SELECT * FROM budget_authorization WHERE id=1")
      .get();
    if (policy.generation !== 3 || policy.limit_tokens !== TOKEN_CEILING)
      throw new Error("UNSUPPORTED_BUDGET_GENERATION");
    this.db
      .prepare(
        "UPDATE model_requests SET state='uncertain',ended_at=unixepoch() WHERE state='sent'",
      )
      .run();
  }
  accounted() {
    return this.db
      .prepare(
        "SELECT coalesce(sum(CASE WHEN state='settled' AND total_tokens IS NOT NULL THEN total_tokens ELSE debit END),0) AS total FROM model_requests",
      )
      .get().total;
  }
  reserve(id, keyId, hash, debit = CALL_DEBIT) {
    if (
      !Number.isSafeInteger(debit) ||
      debit < CALL_DEBIT ||
      debit > TOKEN_CEILING
    )
      throw new Error("INVALID_RESERVATION");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT 1 FROM model_requests WHERE id=?").get(id))
        throw new Error("REQUEST_ALREADY_ADMITTED");
      const b = this.db
        .prepare("SELECT * FROM budget_authorization WHERE id=1")
        .get();
      if (!b.enabled || this.accounted() + debit > b.limit_tokens)
        throw new Error("TOKEN_BUDGET_EXHAUSTED");
      this.db
        .prepare(
          "INSERT INTO model_requests(id,credential_id,body_hash,state,debit) VALUES(?,?,?,'sent',?)",
        )
        .run(id, keyId, hash, debit);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  finish(id, state, usage, status) {
    if (
      !["settled", "failed", "uncertain"].includes(state) ||
      (state === "settled" && !usage)
    )
      throw new Error("INVALID_STATE");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db
        .prepare("SELECT * FROM model_requests WHERE id=?")
        .get(id);
      if (!old || old.state !== "sent")
        throw new Error("REQUEST_SETTLEMENT_CAS");
      if (usage) {
        if (
          Object.keys(usage).sort().join(",") !==
          "cacheRead,cacheWrite,input,output,total"
        )
          throw new Error("INVALID_USAGE");
        for (const n of Object.values(usage))
          if (!Number.isSafeInteger(n) || n < 0)
            throw new Error("INVALID_USAGE");
        if (
          usage.total !==
          usage.input + usage.output + usage.cacheRead + usage.cacheWrite
        )
          throw new Error("INVALID_USAGE");
        if (usage.total > old.debit) {
          this.db
            .prepare("UPDATE budget_authorization SET enabled=0 WHERE id=1")
            .run();
          this.db.prepare("UPDATE token_budget SET enabled=0 WHERE id=1").run();
        }
      }
      this.db
        .prepare(
          "UPDATE model_requests SET state=?,input_tokens=?,output_tokens=?,cache_read=?,cache_write=?,total_tokens=?,http_status=?,ended_at=unixepoch() WHERE id=? AND state=?",
        )
        .run(
          state,
          usage?.input ?? null,
          usage?.output ?? null,
          usage?.cacheRead ?? null,
          usage?.cacheWrite ?? null,
          usage?.total ?? null,
          status ?? null,
          id,
          "sent",
        );
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  status() {
    const b = this.db
      .prepare("SELECT * FROM budget_authorization WHERE id=1")
      .get();
    const totals = this.db
      .prepare(
        "SELECT count(*) attempts,coalesce(sum(CASE WHEN state='settled' THEN total_tokens ELSE 0 END),0) confirmed_tokens,coalesce(sum(CASE WHEN state!='settled' OR total_tokens IS NULL THEN debit ELSE 0 END),0) uncertain_ceiling,coalesce(sum(debit),0) admittedCeilingTotal FROM model_requests",
      )
      .get();
    const accounted = this.accounted(),
      remaining = Math.max(0, b.limit_tokens - accounted);
    return {
      generation: 3,
      limitTokens: b.limit_tokens,
      debitedTokens: accounted,
      legacyDebitedTokens: this.db
        .prepare("SELECT debited_tokens FROM token_budget WHERE id=1")
        .get().debited_tokens,
      remainingAuthorizationTokens: remaining,
      enabled: !!b.enabled,
      maxRemainingCalls: Math.floor(remaining / CALL_DEBIT),
      ...totals,
    };
  }
  close() {
    this.db.close();
  }
}

/** Explicit Moscow wall-clock periods, Sunday 23:59:00; independent of process/host timezone. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const moscow = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Moscow",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
function localWall(ms) {
  const fields = Object.fromEntries(
    moscow
      .formatToParts(new Date(ms))
      .filter((x) => x.type !== "literal")
      .map((x) => [x.type, Number(x.value)]),
  );
  return Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
  );
}
function moscowUtc(wall) {
  let guess = wall;
  for (let i = 0; i < 4; i++) {
    const difference = wall - localWall(guess);
    if (!difference) return guess;
    guess += difference;
  }
  throw new Error("TIMEZONE_RESOLUTION_FAILED");
}
export function weekWindow(ms = Date.now()) {
  if (!Number.isFinite(ms)) throw new Error("INVALID_CLOCK");
  const wall = localWall(ms),
    d = new Date(wall);
  let reset = Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() - d.getUTCDay(),
    23,
    59,
    0,
  );
  if (ms < moscowUtc(reset)) reset -= WEEK_MS;
  return {
    start: moscowUtc(reset) / 1000,
    end: moscowUtc(reset + WEEK_MS) / 1000,
  };
}
function studentId(student) {
  if (student === null) return null;
  if (!Number.isInteger(student) || student < 1 || student > 5)
    throw new Error("BUDGET_SUBJECT_INVALID");
  return student;
}
/** Generation 4. Legacy global policy is archived and retained only for the operator's lifetime test allowance. */
export class Ledger extends LegacyLedger {
  constructor(
    path,
    { clock = () => Date.now(), mapLegacyStudents = false } = {},
  ) {
    super(path);
    this.clock = clock;
    const window = weekWindow(clock());
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
CREATE TABLE IF NOT EXISTS weekly_policy(id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL CHECK(generation=4),timezone TEXT NOT NULL CHECK(timezone='Europe/Moscow'),latest_period_start INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS weekly_budgets(student INTEGER NOT NULL CHECK(student BETWEEN 1 AND 5),period_start INTEGER NOT NULL,period_end INTEGER NOT NULL CHECK(period_end>period_start),limit_tokens INTEGER NOT NULL CHECK(limit_tokens=1000000),PRIMARY KEY(student,period_start));
CREATE TABLE IF NOT EXISTS request_scopes(request_id TEXT PRIMARY KEY REFERENCES model_requests(id),student INTEGER CHECK(student BETWEEN 1 AND 5),period_start INTEGER,CHECK((student IS NULL AND period_start IS NULL) OR (student IS NOT NULL AND period_start IS NOT NULL)));
CREATE INDEX IF NOT EXISTS scoped_weekly_requests ON request_scopes(student,period_start,request_id);
CREATE TABLE IF NOT EXISTS weekly_grants(id TEXT PRIMARY KEY,student INTEGER NOT NULL,period_start INTEGER NOT NULL,tokens INTEGER NOT NULL CHECK(tokens>0 AND tokens<=9007199254740991),actor TEXT NOT NULL,note TEXT NOT NULL,created_at INTEGER NOT NULL,FOREIGN KEY(student,period_start) REFERENCES weekly_budgets(student,period_start));
CREATE INDEX IF NOT EXISTS grants_by_week ON weekly_grants(student,period_start,created_at);
CREATE TRIGGER IF NOT EXISTS immutable_grant_update BEFORE UPDATE ON weekly_grants BEGIN SELECT RAISE(ABORT,'GRANTS_APPEND_ONLY');END;
CREATE TRIGGER IF NOT EXISTS immutable_grant_delete BEFORE DELETE ON weekly_grants BEGIN SELECT RAISE(ABORT,'GRANTS_APPEND_ONLY');END;
`);
      this.db
        .prepare(
          "INSERT OR IGNORE INTO weekly_policy VALUES(1,4,'Europe/Moscow',?)",
        )
        .run(window.start);
      const policy = this.db
        .prepare("SELECT * FROM weekly_policy WHERE id=1")
        .get();
      if (policy.generation !== 4 || policy.timezone !== "Europe/Moscow")
        throw new Error("UNSUPPORTED_WEEKLY_POLICY");
      const missing = this.db
        .prepare(
          "SELECT m.id,m.credential_id,m.created_at FROM model_requests m LEFT JOIN request_scopes s ON s.request_id=m.id WHERE s.request_id IS NULL",
        )
        .all();
      for (const row of missing) {
        const student =
          mapLegacyStudents &&
          row.credential_id >= 20 &&
          row.credential_id <= 24
            ? row.credential_id - 19
            : null;
        const period =
          student === null ? null : weekWindow(row.created_at * 1000);
        if (period) this.bucket(student, period);
        this.db
          .prepare("INSERT INTO request_scopes VALUES(?,?,?)")
          .run(row.id, student, period?.start ?? null);
      }
      for (let student = 1; student <= 5; student++)
        this.bucket(student, window);
      this.db
        .prepare(
          "UPDATE weekly_policy SET latest_period_start=max(latest_period_start,coalesce((SELECT max(period_start) FROM request_scopes),latest_period_start)) WHERE id=1",
        )
        .run();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      this.db.close();
      throw e;
    }
  }
  bucket(student, window) {
    this.db
      .prepare("INSERT OR IGNORE INTO weekly_budgets VALUES(?,?,?,1000000)")
      .run(student, window.start, window.end);
    const b = this.db
      .prepare(
        "SELECT limit_tokens,period_end FROM weekly_budgets WHERE student=? AND period_start=?",
      )
      .get(student, window.start);
    if (b.limit_tokens !== TOKEN_CEILING || b.period_end !== window.end)
      throw new Error("WEEKLY_LIMIT_INVALID");
  }
  extraTokens(student, period) {
    if (student === null) return 0;
    studentId(student);
    return this.db
      .prepare(
        "SELECT coalesce(sum(tokens),0) tokens FROM weekly_grants WHERE student=? AND period_start=?",
      )
      .get(student, period).tokens;
  }
  limitFor(student, period) {
    return TOKEN_CEILING + this.extraTokens(student, period);
  }
  grant({ id, student, tokens, actor, note = "", periodStart }) {
    studentId(student);
    if (
      student === null ||
      typeof id !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        id,
      ) ||
      !Number.isSafeInteger(tokens) ||
      tokens < 1 ||
      typeof actor !== "string" ||
      !/^[a-f0-9]{32}$/.test(actor) ||
      typeof note !== "string" ||
      Buffer.byteLength(note) > 512 ||
      !Number.isSafeInteger(periodStart)
    )
      throw new Error("GRANT_INPUT_INVALID");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db
        .prepare("SELECT * FROM weekly_grants WHERE id=?")
        .get(id);
      if (previous) {
        if (
          previous.student !== student ||
          previous.tokens !== tokens ||
          previous.actor !== actor ||
          previous.note !== note ||
          previous.period_start !== periodStart
        )
          throw new Error("GRANT_REQUEST_CONFLICT");
        this.db.exec("COMMIT");
        return {
          grant: this.publicGrant(previous),
          replayed: true,
          budget: this.status(student),
        };
      }
      const now = this.clock(),
        window = weekWindow(now);
      const latest = this.db
        .prepare("SELECT latest_period_start FROM weekly_policy WHERE id=1")
        .get().latest_period_start;
      if (window.start < latest) throw new Error("BUDGET_CLOCK_ROLLBACK");
      if (window.start !== periodStart) throw new Error("GRANT_WINDOW_CHANGED");
      this.bucket(student, window);
      if (!Number.isSafeInteger(this.limitFor(student, window.start) + tokens))
        throw new Error("GRANT_INPUT_INVALID");
      this.db
        .prepare("INSERT INTO weekly_grants VALUES(?,?,?,?,?,?,?)")
        .run(
          id,
          student,
          window.start,
          tokens,
          actor,
          note,
          Math.floor(now / 1000),
        );
      this.db
        .prepare(
          "UPDATE weekly_policy SET latest_period_start=max(latest_period_start,?) WHERE id=1",
        )
        .run(window.start);
      const row = this.db
        .prepare("SELECT * FROM weekly_grants WHERE id=?")
        .get(id);
      this.db.exec("COMMIT");
      return {
        grant: this.publicGrant(row),
        replayed: false,
        budget: this.status(student),
      };
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
  }
  publicGrant(row) {
    const bucket = this.db
      .prepare(
        "SELECT period_end FROM weekly_budgets WHERE student=? AND period_start=?",
      )
      .get(row.student, row.period_start);
    return {
      id: row.id,
      student: row.student,
      tokens: row.tokens,
      actor: row.actor,
      note: row.note,
      createdAt: new Date(row.created_at * 1000).toISOString(),
      periodStartsAt: new Date(row.period_start * 1000).toISOString(),
      expiresAt: new Date(bucket.period_end * 1000).toISOString(),
    };
  }
  grants(student) {
    studentId(student);
    if (student === null) throw new Error("GRANT_INPUT_INVALID");
    return this.db
      .prepare(
        "SELECT * FROM weekly_grants WHERE student=? ORDER BY created_at DESC,id DESC LIMIT 100",
      )
      .all(student)
      .map((row) => this.publicGrant(row));
  }
  totals(student = null, period = null) {
    studentId(student);
    const filter =
      student === null
        ? "s.student IS NULL"
        : "s.student=? AND s.period_start=?";
    const args = student === null ? [] : [student, period];
    return this.db
      .prepare(
        "SELECT count(*) attempts,coalesce(sum(CASE WHEN m.state='settled' THEN m.total_tokens ELSE 0 END),0) confirmed_tokens,coalesce(sum(CASE WHEN m.state!='settled' OR m.total_tokens IS NULL THEN m.debit ELSE 0 END),0) uncertain_ceiling,coalesce(sum(m.debit),0) admittedCeilingTotal FROM model_requests m JOIN request_scopes s ON s.request_id=m.id WHERE " +
          filter,
      )
      .get(...args);
  }
  accounted(student = null, period = null) {
    const t = this.totals(student, period);
    return t.confirmed_tokens + t.uncertain_ceiling;
  }
  reserveOutput(
    id,
    keyId,
    hash,
    inputCeiling,
    requestedOutput,
    student = null,
    providerOutput = 393216,
    contextWindow = 1048576,
  ) {
    const envelope = {
      inputCeiling,
      requestedOutput,
      providerOutput,
      contextWindow,
    };
    if (Object.values(envelope).some((n) => !Number.isSafeInteger(n) || n < 1))
      throw new Error("INVALID_RESERVATION");
    return this.reserve(id, keyId, hash, CALL_DEBIT, student, envelope);
  }
  reserve(
    id,
    keyId,
    hash,
    debit = CALL_DEBIT,
    student = null,
    envelope = null,
  ) {
    studentId(student);
    if (
      !Number.isSafeInteger(debit) ||
      debit < CALL_DEBIT ||
      debit > TOKEN_CEILING
    )
      throw new Error("INVALID_RESERVATION");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const admissionAt = this.clock(),
        window = weekWindow(admissionAt);
      if (this.db.prepare("SELECT 1 FROM model_requests WHERE id=?").get(id))
        throw new Error("REQUEST_ALREADY_ADMITTED");
      const auth = this.db
        .prepare("SELECT enabled FROM budget_authorization WHERE id=1")
        .get();
      const policy = this.db
        .prepare("SELECT latest_period_start FROM weekly_policy WHERE id=1")
        .get();
      if (!auth.enabled) throw new Error("TOKEN_BUDGET_EXHAUSTED");
      if (student !== null && window.start < policy.latest_period_start)
        throw new Error("BUDGET_CLOCK_ROLLBACK");
      if (student !== null) this.bucket(student, window);
      const remaining =
        this.limitFor(student, window.start) -
        this.accounted(student, student === null ? null : window.start);
      let maxTokens;
      if (envelope) {
        maxTokens = Math.min(
          envelope.requestedOutput,
          envelope.providerOutput,
          remaining - envelope.inputCeiling,
          envelope.contextWindow - envelope.inputCeiling,
        );
        if (maxTokens < 1) throw new Error("TOKEN_BUDGET_EXHAUSTED");
        debit = envelope.inputCeiling + maxTokens;
      }
      if (debit > remaining) throw new Error("TOKEN_BUDGET_EXHAUSTED");
      this.db
        .prepare(
          "INSERT INTO model_requests(id,credential_id,body_hash,state,debit,created_at) VALUES(?,?,?,'sent',?,?)",
        )
        .run(id, keyId, hash, debit, Math.floor(admissionAt / 1000));
      this.db
        .prepare("INSERT INTO request_scopes VALUES(?,?,?)")
        .run(id, student, student === null ? null : window.start);
      if (student !== null)
        this.db
          .prepare(
            "UPDATE weekly_policy SET latest_period_start=max(latest_period_start,?) WHERE id=1",
          )
          .run(window.start);
      this.db.exec("COMMIT");
      return {
        debit,
        maxTokens,
        periodStart: student === null ? null : window.start,
      };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  status(student = null, at = this.clock()) {
    studentId(student);
    const window = weekWindow(at);
    const totals = this.totals(student, student === null ? null : window.start),
      accounted = totals.confirmed_tokens + totals.uncertain_ceiling;
    const auth = this.db
      .prepare("SELECT enabled FROM budget_authorization WHERE id=1")
      .get();
    const latest = this.db
      .prepare("SELECT latest_period_start FROM weekly_policy WHERE id=1")
      .get().latest_period_start;
    const clockValid = student === null || window.start >= latest,
      enabled = !!auth.enabled && clockValid;
    const extraLimitTokens = this.extraTokens(student, window.start),
      limitTokens = TOKEN_CEILING + extraLimitTokens,
      remaining = Math.max(0, limitTokens - accounted);
    return {
      generation: 4,
      scope: student === null ? "operator" : "student",
      student,
      period: student === null ? "lifetime" : "weekly",
      timezone: "Europe/Moscow",
      periodStartsAt:
        student === null ? null : new Date(window.start * 1000).toISOString(),
      resetsAt:
        student === null ? null : new Date(window.end * 1000).toISOString(),
      limitTokens,
      baseLimitTokens: TOKEN_CEILING,
      extraLimitTokens,
      debitedTokens: accounted,
      remainingAuthorizationTokens: remaining,
      enabled,
      clockValid,
      maxRemainingCalls: enabled
        ? Math.floor(remaining / (INPUT_SAFETY_MARGIN + 1))
        : 0,
      ...totals,
    };
  }
  overview() {
    const lifetime = this.db
      .prepare(
        "SELECT count(*) attempts,coalesce(sum(CASE WHEN state='settled' THEN total_tokens ELSE 0 END),0) confirmed_tokens,coalesce(sum(CASE WHEN state!='settled' OR total_tokens IS NULL THEN debit ELSE 0 END),0) uncertain_ceiling FROM model_requests",
      )
      .get();
    return {
      generation: 4,
      policy: "one-million-per-student-per-moscow-week",
      lifetime,
      operator: this.status(),
      students: Array.from({ length: 5 }, (_, i) => this.status(i + 1)),
    };
  }
}
