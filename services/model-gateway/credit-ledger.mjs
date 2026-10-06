/** Generation 5: weekly monetary credits; raw token/request journals are preserved. */
import {
  Ledger,
  weekWindow,
  INPUT_SAFETY_MARGIN,
  TOKEN_CEILING,
} from "./ledger.mjs";
import {
  PRICING_VERSION,
  USD_NANOS,
  CREDIT_NANOS,
  BASE_WEEKLY_CREDITS,
  PEAK,
  ratesForWindow,
  nanoCost,
  credits,
} from "./pricing.mjs";
// Explicit rejections precede inference; stream/transport/5xx outcomes remain held.
const unbilledReject = (state, usage, status) =>
  state === "failed" &&
  !usage &&
  [400, 401, 402, 403, 404, 413, 422, 429].includes(status);
function subject(student) {
  if (!Number.isInteger(student) || student < 1 || student > 5)
    throw new Error("BUDGET_SUBJECT_INVALID");
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export class CreditLedger extends Ledger {
  constructor(file, options = {}) {
    super(file, options);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
CREATE TABLE IF NOT EXISTS credit_policy(id INTEGER PRIMARY KEY CHECK(id=1),generation INTEGER NOT NULL CHECK(generation=5),base_nanos INTEGER NOT NULL CHECK(base_nanos=1000000000),pricing_version TEXT NOT NULL);
INSERT OR IGNORE INTO credit_policy VALUES(1,5,1000000000,'deepseek-flash-2026-09-10');
CREATE TABLE IF NOT EXISTS credit_requests(request_id TEXT PRIMARY KEY REFERENCES model_requests(id),pricing_version TEXT NOT NULL,created_ms INTEGER NOT NULL,reserved_nanos INTEGER NOT NULL CHECK(reserved_nanos>=0),actual_nanos INTEGER,input_rate INTEGER,cache_rate INTEGER,output_rate INTEGER,band TEXT,ended_ms INTEGER,estimated INTEGER NOT NULL CHECK(estimated IN(0,1)));
CREATE TABLE IF NOT EXISTS weekly_credit_grants(id TEXT PRIMARY KEY,student INTEGER NOT NULL,period_start INTEGER NOT NULL,nanos INTEGER NOT NULL CHECK(nanos>0 AND nanos<=9007199254740991),actor TEXT NOT NULL,note TEXT NOT NULL,created_ms INTEGER NOT NULL,FOREIGN KEY(student,period_start) REFERENCES weekly_budgets(student,period_start));
CREATE INDEX IF NOT EXISTS credit_grants_by_week ON weekly_credit_grants(student,period_start);
CREATE TRIGGER IF NOT EXISTS immutable_credit_grant_update BEFORE UPDATE ON weekly_credit_grants BEGIN SELECT RAISE(ABORT,'GRANTS_APPEND_ONLY');END;
CREATE TRIGGER IF NOT EXISTS immutable_credit_grant_delete BEFORE DELETE ON weekly_credit_grants BEGIN SELECT RAISE(ABORT,'GRANTS_APPEND_ONLY');END;
`);
      const policy = this.db
        .prepare("SELECT * FROM credit_policy WHERE id=1")
        .get();
      if (policy.pricing_version !== PRICING_VERSION)
        throw new Error("CREDIT_PRICING_VERSION_MISMATCH");
      const missing = this.db
        .prepare(
          "SELECT m.* FROM model_requests m LEFT JOIN credit_requests c ON c.request_id=m.id WHERE c.request_id IS NULL",
        )
        .all();
      for (const row of missing) {
        const from = row.created_at * 1000,
          to = Math.max(from, (row.ended_at ?? row.created_at) * 1000),
          rates = ratesForWindow(from, to);
        const usage = {
          input: row.input_tokens ?? 0,
          cacheRead: row.cache_read ?? 0,
          cacheWrite: row.cache_write ?? 0,
          output: row.output_tokens ?? 0,
        };
        const actual =
          row.state === "settled" && row.total_tokens !== null
            ? nanoCost(usage, rates)
            : unbilledReject(
                  row.state,
                  row.total_tokens === null ? undefined : usage,
                  row.http_status,
                )
              ? 0
              : null;
        this.db
          .prepare("INSERT INTO credit_requests VALUES(?,?,?,?,?,?,?,?,?,?,1)")
          .run(
            row.id,
            PRICING_VERSION,
            from,
            actual ?? row.debit * PEAK.output,
            actual,
            rates.input,
            rates.cache,
            rates.output,
            rates.band,
            to,
          );
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      this.db.close();
      throw e;
    }
  }
  extraNanos(student, period) {
    return this.db
      .prepare(
        "SELECT coalesce(sum(nanos),0) value FROM weekly_credit_grants WHERE student=? AND period_start=?",
      )
      .get(student, period).value;
  }
  moneyTotals(student, period) {
    return this.db
      .prepare(
        "SELECT coalesce(sum(CASE WHEN c.actual_nanos IS NOT NULL THEN c.actual_nanos ELSE 0 END),0) spent,coalesce(sum(CASE WHEN c.actual_nanos IS NULL THEN c.reserved_nanos ELSE 0 END),0) held FROM model_requests m JOIN request_scopes s ON s.request_id=m.id JOIN credit_requests c ON c.request_id=m.id WHERE s.student=? AND s.period_start=?",
      )
      .get(student, period);
  }
  reserve(id, key, hash, debit, student = null, envelope = null) {
    if (student !== null) throw new Error("CREDIT_ENVELOPE_REQUIRED");
    return super.reserve(id, key, hash, debit, student, envelope);
  }
  reserveOutput(
    id,
    key,
    hash,
    inputCeiling,
    requestedOutput,
    student = null,
    providerOutput = 393216,
    contextWindow = 1048576,
  ) {
    if (student === null)
      return super.reserveOutput(
        id,
        key,
        hash,
        inputCeiling,
        requestedOutput,
        student,
        providerOutput,
        contextWindow,
      );
    subject(student);
    if (
      !uuid.test(id) ||
      [inputCeiling, requestedOutput, providerOutput, contextWindow].some(
        (v) => !Number.isSafeInteger(v) || v < 1,
      )
    )
      throw new Error("INVALID_RESERVATION");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = this.clock(),
        window = weekWindow(now);
      if (this.db.prepare("SELECT 1 FROM model_requests WHERE id=?").get(id))
        throw new Error("REQUEST_ALREADY_ADMITTED");
      const enabled = this.db
          .prepare("SELECT enabled FROM budget_authorization WHERE id=1")
          .get().enabled,
        latest = this.db
          .prepare("SELECT latest_period_start FROM weekly_policy WHERE id=1")
          .get().latest_period_start;
      if (!enabled) throw new Error("TOKEN_BUDGET_EXHAUSTED");
      if (window.start < latest) throw new Error("BUDGET_CLOCK_ROLLBACK");
      this.bucket(student, window);
      const total = this.moneyTotals(student, window.start),
        remaining =
          USD_NANOS +
          this.extraNanos(student, window.start) -
          total.spent -
          total.held;
      const inputReserve = inputCeiling * PEAK.input;
      const maxTokens = Math.min(
        requestedOutput,
        providerOutput,
        contextWindow - inputCeiling,
        Math.floor((remaining - inputReserve) / PEAK.output),
      );
      if (maxTokens < 1) throw new Error("CREDIT_BUDGET_EXHAUSTED");
      const debit = inputCeiling + maxTokens,
        reserved = inputReserve + maxTokens * PEAK.output;
      if (!Number.isSafeInteger(reserved) || debit > TOKEN_CEILING)
        throw new Error("INVALID_RESERVATION");
      this.db
        .prepare(
          "INSERT INTO model_requests(id,credential_id,body_hash,state,debit,created_at) VALUES(?,?,?,'sent',?,?)",
        )
        .run(id, key, hash, debit, Math.floor(now / 1000));
      this.db
        .prepare("INSERT INTO request_scopes VALUES(?,?,?)")
        .run(id, student, window.start);
      this.db
        .prepare(
          "INSERT INTO credit_requests VALUES(?,?,?,?,NULL,NULL,NULL,NULL,NULL,NULL,1)",
        )
        .run(id, PRICING_VERSION, now, reserved);
      this.db
        .prepare(
          "UPDATE weekly_policy SET latest_period_start=max(latest_period_start,?) WHERE id=1",
        )
        .run(window.start);
      this.db.exec("COMMIT");
      return {
        debit,
        maxTokens,
        periodStart: window.start,
        reservedCredits: credits(reserved),
      };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  finish(id, state, usage, status) {
    const row = this.db
      .prepare(
        "SELECT c.*,s.student FROM credit_requests c JOIN request_scopes s ON s.request_id=c.request_id WHERE c.request_id=?",
      )
      .get(id);
    if (!row || row.student === null)
      return super.finish(id, state, usage, status);
    if (
      !["settled", "failed", "uncertain"].includes(state) ||
      (state === "settled" && !usage)
    )
      throw new Error("INVALID_STATE");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const request = this.db
        .prepare("SELECT * FROM model_requests WHERE id=?")
        .get(id);
      if (!request || request.state !== "sent")
        throw new Error("REQUEST_SETTLEMENT_CAS");
      let actual = unbilledReject(state, usage, status) ? 0 : null,
        rates = null;
      const ended = Math.max(row.created_ms, this.clock());
      if (usage) {
        if (
          Object.keys(usage).sort().join(",") !==
            "cacheRead,cacheWrite,input,output,total" ||
          Object.values(usage).some((v) => !Number.isSafeInteger(v) || v < 0) ||
          usage.total !==
            usage.input + usage.output + usage.cacheRead + usage.cacheWrite
        )
          throw new Error("INVALID_USAGE");
        rates = ratesForWindow(row.created_ms, ended);
        actual = nanoCost(usage, rates);
        if (usage.total > request.debit || actual > row.reserved_nanos) {
          this.db
            .prepare("UPDATE budget_authorization SET enabled=0 WHERE id=1")
            .run();
          this.db.prepare("UPDATE token_budget SET enabled=0 WHERE id=1").run();
        }
      }
      this.db
        .prepare(
          "UPDATE model_requests SET state=?,input_tokens=?,output_tokens=?,cache_read=?,cache_write=?,total_tokens=?,http_status=?,ended_at=? WHERE id=? AND state='sent'",
        )
        .run(
          state,
          usage?.input ?? null,
          usage?.output ?? null,
          usage?.cacheRead ?? null,
          usage?.cacheWrite ?? null,
          usage?.total ?? null,
          status ?? null,
          Math.floor(ended / 1000),
          id,
        );
      this.db
        .prepare(
          "UPDATE credit_requests SET actual_nanos=?,input_rate=?,cache_rate=?,output_rate=?,band=?,ended_ms=? WHERE request_id=?",
        )
        .run(
          state === "settled" || unbilledReject(state, usage, status)
            ? actual
            : null,
          rates?.input ?? null,
          rates?.cache ?? null,
          rates?.output ?? null,
          rates?.band ?? null,
          ended,
          id,
        );
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  usage(student, period) {
    const row = this.db
      .prepare(
        "SELECT coalesce(sum(m.input_tokens),0) input,coalesce(sum(m.cache_read),0) cacheRead,coalesce(sum(m.cache_write),0) cacheWrite,coalesce(sum(m.output_tokens),0) output,coalesce(sum(m.total_tokens),0) total,coalesce(sum((m.input_tokens+m.cache_write)*c.input_rate),0) inputCost,coalesce(sum(m.cache_read*c.cache_rate),0) cacheCost,coalesce(sum(m.output_tokens*c.output_rate),0) outputCost FROM model_requests m JOIN request_scopes s ON s.request_id=m.id JOIN credit_requests c ON c.request_id=m.id WHERE s.student=? AND s.period_start=? AND m.state='settled'",
      )
      .get(student, period);
    return {
      inputTokens: row.input,
      cacheReadTokens: row.cacheRead,
      cacheWriteTokens: row.cacheWrite,
      outputTokens: row.output,
      totalTokens: row.total,
      cacheOfInputPercent:
        row.input + row.cacheRead + row.cacheWrite
          ? (100 * row.cacheRead) / (row.input + row.cacheRead + row.cacheWrite)
          : 0,
      inputCredits: credits(row.inputCost),
      cacheCredits: credits(row.cacheCost),
      outputCredits: credits(row.outputCost),
    };
  }
  status(student = null) {
    if (student === null) return { ...super.status(), unit: "tokens" };
    subject(student);
    const now = this.clock(),
      window = weekWindow(now),
      raw = super.status(student, now),
      total = this.moneyTotals(student, window.start),
      extra = this.extraNanos(student, window.start),
      limit = USD_NANOS + extra,
      remaining = Math.max(0, limit - total.spent - total.held);
    return {
      ...raw,
      generation: 5,
      unit: "credits",
      baseLimitCredits: BASE_WEEKLY_CREDITS,
      extraLimitCredits: credits(extra),
      limitCredits: credits(limit),
      spentCredits: credits(total.spent),
      reservedCredits: credits(total.held),
      remainingCredits: credits(remaining),
      costUsd: total.spent / USD_NANOS,
      costBasis: "published-tariff-estimate",
      pricingVersion: PRICING_VERSION,
      usage: this.usage(student, window.start),
      maxRemainingCalls: raw.enabled
        ? Math.floor(
            remaining / (INPUT_SAFETY_MARGIN * PEAK.input + PEAK.output),
          )
        : 0,
    };
  }
  grant({ id, student, credits: amount, actor, note = "", periodStart }) {
    subject(student);
    const nanos = amount * CREDIT_NANOS;
    if (
      !uuid.test(id) ||
      !Number.isSafeInteger(amount) ||
      amount < 1 ||
      !Number.isSafeInteger(nanos) ||
      !Number.isSafeInteger(periodStart) ||
      typeof actor !== "string" ||
      !/^[a-f0-9]{32}$/.test(actor) ||
      typeof note !== "string" ||
      Buffer.byteLength(note) > 512
    )
      throw new Error("GRANT_INPUT_INVALID");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db
        .prepare("SELECT * FROM weekly_credit_grants WHERE id=?")
        .get(id);
      if (old) {
        if (
          old.student !== student ||
          old.nanos !== nanos ||
          old.actor !== actor ||
          old.note !== note ||
          old.period_start !== periodStart
        )
          throw new Error("GRANT_REQUEST_CONFLICT");
        this.db.exec("COMMIT");
        return {
          grant: this.publicCreditGrant(old),
          replayed: true,
          budget: this.status(student),
        };
      }
      if (this.db.prepare("SELECT 1 FROM weekly_grants WHERE id=?").get(id))
        throw new Error("GRANT_REQUEST_CONFLICT");
      const now = this.clock(),
        window = weekWindow(now),
        latest = this.db
          .prepare("SELECT latest_period_start FROM weekly_policy WHERE id=1")
          .get().latest_period_start;
      if (window.start < latest) throw new Error("BUDGET_CLOCK_ROLLBACK");
      if (window.start !== periodStart) throw new Error("GRANT_WINDOW_CHANGED");
      this.bucket(student, window);
      if (
        !Number.isSafeInteger(
          USD_NANOS + this.extraNanos(student, window.start) + nanos,
        )
      )
        throw new Error("GRANT_INPUT_INVALID");
      this.db
        .prepare("INSERT INTO weekly_credit_grants VALUES(?,?,?,?,?,?,?)")
        .run(id, student, window.start, nanos, actor, note, now);
      this.db
        .prepare(
          "UPDATE weekly_policy SET latest_period_start=max(latest_period_start,?) WHERE id=1",
        )
        .run(window.start);
      const row = this.db
        .prepare("SELECT * FROM weekly_credit_grants WHERE id=?")
        .get(id);
      this.db.exec("COMMIT");
      return {
        grant: this.publicCreditGrant(row),
        replayed: false,
        budget: this.status(student),
      };
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
  }
  publicCreditGrant(row) {
    const b = this.db
      .prepare(
        "SELECT period_end FROM weekly_budgets WHERE student=? AND period_start=?",
      )
      .get(row.student, row.period_start);
    return {
      id: row.id,
      student: row.student,
      unit: "credits",
      credits: credits(row.nanos),
      actor: row.actor,
      note: row.note,
      createdAt: new Date(row.created_ms).toISOString(),
      periodStartsAt: new Date(row.period_start * 1000).toISOString(),
      expiresAt: new Date(b.period_end * 1000).toISOString(),
    };
  }
  grants(student) {
    subject(student);
    const now = this.db
        .prepare(
          "SELECT * FROM weekly_credit_grants WHERE student=? ORDER BY created_ms DESC LIMIT 100",
        )
        .all(student)
        .map((r) => this.publicCreditGrant(r)),
      old = super
        .grants(student)
        .map((r) => ({ ...r, unit: "tokens", archived: true }));
    return [...now, ...old]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 100);
  }
  records(student) {
    subject(student);
    return this.db
      .prepare(
        "SELECT m.id,m.state,m.created_at,m.input_tokens inputTokens,m.cache_read cacheReadTokens,m.cache_write cacheWriteTokens,m.output_tokens outputTokens,m.total_tokens totalTokens,c.actual_nanos,c.reserved_nanos,c.band,c.pricing_version,s.period_start periodStart FROM model_requests m JOIN request_scopes s ON s.request_id=m.id JOIN credit_requests c ON c.request_id=m.id WHERE s.student=? ORDER BY c.created_ms DESC LIMIT 30",
      )
      .all(student)
      .map((r) => ({
        ...r,
        spentCredits: r.actual_nanos === null ? null : credits(r.actual_nanos),
        reservedCredits: credits(r.reserved_nanos),
        createdAt: new Date(r.created_at * 1000).toISOString(),
        periodStartsAt: new Date(r.periodStart * 1000).toISOString(),
        estimated: true,
      }));
  }
  overview() {
    const raw = super.overview();
    return {
      ...raw,
      generation: 5,
      policy: "one-dollar-per-student-per-moscow-week-plus-explicit-grants",
      pricingVersion: PRICING_VERSION,
      creditsPerDollar: 1000,
      students: Array.from({ length: 5 }, (_, i) => this.status(i + 1)),
    };
  }
}
