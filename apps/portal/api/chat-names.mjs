/** Short chat titles are metadata: never feed them back into Harness history. */
const GENERIC = /^(первый разговор|новый разговор|новый чат)(?:\s+\d+)?$/iu;
const LIMIT = 80;
const fail = (code, statusCode = 400) =>
  Object.assign(new Error(code), { statusCode });

export function redactTitleContext(value) {
  return String(value ?? "")
    .replace(/[\u0060]{3}[\s\S]*?(?:[\u0060]{3}|$)/g, " ")
    .split(/\r?\n/)
    .filter(
      (line) =>
        !/(?:password|passwd|secret|api[_ -]?key|парол[ья]|секрет|токен\s*[:=])\s*[:=]?/iu.test(
          line,
        ),
    )
    .join("\n")
    .replace(/\b(?:sk-|Bearer\s+)[a-z0-9._-]{8,}/gi, "[скрыто]")
    .replace(/\b[a-z0-9_+/=-]{40,}\b/gi, "[скрыто]")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[скрыто]")
    .replace(/https?:\/\/\S+/gi, "[ссылка]")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
export function normalizeChatName(value) {
  if (
    typeof value !== "string" ||
    value.length > LIMIT ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw fail("INVALID_INPUT");
  const result = value.trim().replace(/\s+/g, " ");
  if (!result) throw fail("INVALID_INPUT");
  return result;
}
function shorten(value, limit = 65) {
  if (value.length <= limit) return value;
  const start = value.slice(0, limit);
  const space = start.lastIndexOf(" ");
  return (
    space > limit / 2
      ? start.slice(0, space)
      : Array.from(start).slice(0, -1).join("")
  ).trim();
}
export function localChatName(project, request = "") {
  const source = redactTitleContext(request)
    .replace(/[\u0060*_#<>]/g, "")
    .replace(
      /^(?:привет[!,.]?\s*|пожалуйста[,.]?\s*|давай\s*|можешь\s+(?:ли\s+)?|мне\s+нужно\s+|я\s+хочу\s+|хочу\s+)/giu,
      "",
    )
    .replace(/^[^а-яa-z0-9]+/iu, "");
  const sentence = source
    .split(/[!?\n]/)[0]
    .replace(/\[скрыто\]|\[ссылка\]/g, "")
    .trim();
  const words = sentence.split(/\s+/).filter(Boolean).slice(0, 6);
  let title = words.join(" ").replace(/[,:;.\s]+$/g, "");
  if (title.length < 8 || !/[а-яa-z]/iu.test(title))
    title =
      redactTitleContext(project)
        .replace(/\[скрыто\]|\[ссылка\]/g, "")
        .trim() || "Новый разговор";
  title = shorten(title);
  return title.charAt(0).toLocaleUpperCase("ru") + title.slice(1);
}
export function modelChatName(value) {
  if (
    typeof value !== "string" ||
    value.trim().includes("\n") ||
    value.length > 160
  )
    return null;
  const clean = value
    .trim()
    .replace(/^[«"'\u0060]+|[»"'\u0060.]+$/g, "")
    .replace(/\s+/g, " ");
  if (
    clean.length < 6 ||
    clean.length > 65 ||
    !/[а-яa-z]/iu.test(clean) ||
    /[<>{}\u0060]|скрыто|https?:|\bsk-|^\s*(?:название|ответ)\s*:/iu.test(
      clean,
    ) ||
    redactTitleContext(clean) !== clean
  )
    return null;
  return clean;
}

export function migrateChatNames(db) {
  const columns = new Set(
    db
      .prepare("PRAGMA table_info(chats)")
      .all()
      .map((c) => c.name),
  );
  const first = !columns.has("name_source");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!columns.has("name_source"))
      db.exec(
        "ALTER TABLE chats ADD COLUMN name_source TEXT NOT NULL DEFAULT 'default' CHECK(name_source IN('default','auto','manual'))",
      );
    if (!columns.has("name_revision"))
      db.exec(
        "ALTER TABLE chats ADD COLUMN name_revision INTEGER NOT NULL DEFAULT 0",
      );
    if (!columns.has("name_status"))
      db.exec(
        "ALTER TABLE chats ADD COLUMN name_status TEXT NOT NULL DEFAULT 'idle' CHECK(name_status IN('idle','queued','generating','ready','fallback'))",
      );
    if (first) {
      const list = db
        .prepare(
          "SELECT c.id,c.name,p.name project_name FROM chats c JOIN projects p ON p.id=c.project_id",
        )
        .all();
      const firstMessage = db.prepare(
        "SELECT text FROM messages WHERE chat_id=? AND role='user' ORDER BY created,id LIMIT 1",
      );
      const update = db.prepare(
        "UPDATE chats SET name=?,name_source=?,name_status=?,name_revision=name_revision+1 WHERE id=?",
      );
      for (const c of list) {
        if (!GENERIC.test(c.name.trim())) {
          update.run(c.name, "manual", "ready", c.id);
          continue;
        }
        const initial = firstMessage.get(c.id);
        update.run(
          localChatName(c.project_name, initial?.text),
          initial ? "auto" : "default",
          initial ? "queued" : "idle",
          c.id,
        );
      }
    }
    // An interrupted paid request can have incurred cost. Do not repeat it on restart.
    db.exec(
      "UPDATE chats SET name_status='fallback' WHERE name_status='generating'",
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function createChatNames({
  db,
  callBroker,
  isBusy = () => false,
  retryMs = 1000,
}) {
  migrateChatNames(db);
  const inFlight = new Map();
  let timer = null,
    working = false,
    closed = false;
  const row = (id) =>
    db
      .prepare(
        "SELECT c.*,p.name project_name FROM chats c JOIN projects p ON p.id=c.project_id WHERE c.id=?",
      )
      .get(id);
  function context(c) {
    const first = db
      .prepare(
        "SELECT text FROM messages WHERE chat_id=? AND role='user' ORDER BY created,id LIMIT 1",
      )
      .get(c.id);
    const recent = db
      .prepare(
        "SELECT text FROM messages WHERE chat_id=? AND role='user' ORDER BY created DESC,id DESC LIMIT 2",
      )
      .all(c.id)
      .reverse();
    return {
      fallback: localChatName(c.project_name, first?.text),
      hasRequest: !!first,
      text: JSON.stringify({
        project: redactTitleContext(c.project_name).slice(0, 160),
        firstRequest: redactTitleContext(first?.text).slice(0, 1600),
        laterRequests: recent.map((m) =>
          redactTitleContext(m.text).slice(0, 700),
        ),
      }),
    };
  }
  function onMessage(id) {
    const c = row(id);
    if (!c || c.name_source !== "default") return;
    db.prepare(
      "UPDATE chats SET name=?,name_source='auto',name_status='queued',name_revision=name_revision+1 WHERE id=? AND name_source='default'",
    ).run(context(c).fallback, id);
  }
  async function suggest(c) {
    const data = context(c);
    const fallback = (reason) => ({
      name: data.fallback,
      source: "local",
      reason,
      name_revision: c.name_revision,
    });
    if (!data.hasRequest) return fallback("empty");
    if (isBusy()) return fallback("busy");
    const key = c.id + ":" + c.name_revision;
    if (inFlight.has(key)) return inFlight.get(key);
    // Titles are intentionally lower priority and at most one tiny call at a time.
    if (inFlight.size) return fallback("busy");
    const job = (async () => {
      try {
        const result = await callBroker({
          op: "chat-title",
          project: c.project_id,
          context: data.text,
        });
        const name = modelChatName(result.title);
        return name
          ? { name, source: "model", name_revision: c.name_revision }
          : fallback("unavailable");
      } catch (e) {
        return fallback(
          e.message === "AI_BUDGET_EXHAUSTED"
            ? "budget"
            : e.message === "AI_WORKER_BUSY"
              ? "busy"
              : "unavailable",
        );
      }
    })();
    inFlight.set(key, job);
    void job.finally(() => inFlight.delete(key));
    return job;
  }
  function schedule(delay = 0) {
    if (
      closed ||
      working ||
      timer ||
      !db
        .prepare(
          "SELECT 1 FROM chats WHERE name_source='auto' AND name_status='queued' LIMIT 1",
        )
        .get()
    )
      return;
    timer = setTimeout(() => {
      timer = null;
      void drain();
    }, delay);
    timer.unref?.();
  }
  async function drain() {
    if (closed || working) return;
    if (isBusy() || inFlight.size) {
      schedule(retryMs);
      return;
    }
    const c = db
      .prepare(
        "SELECT c.*,p.name project_name FROM chats c JOIN projects p ON p.id=c.project_id WHERE name_source='auto' AND name_status='queued' ORDER BY c.created LIMIT 1",
      )
      .get();
    if (!c) return;
    working = true;
    db.prepare(
      "UPDATE chats SET name_status='generating' WHERE id=? AND name_source='auto' AND name_revision=?",
    ).run(c.id, c.name_revision);
    try {
      const result = await suggest(c);
      if (!closed)
        db.prepare(
          "UPDATE chats SET name=?,name_status=?,name_revision=name_revision+1 WHERE id=? AND name_source='auto' AND name_revision=?",
        ).run(
          result.name,
          result.source === "model" ? "ready" : "fallback",
          c.id,
          c.name_revision,
        );
    } finally {
      working = false;
      schedule(retryMs);
    }
  }
  function manualName(c, name, revision) {
    if (
      revision !== undefined &&
      (!Number.isSafeInteger(revision) || revision < 0)
    )
      throw fail("INVALID_INPUT");
    const clean = normalizeChatName(name);
    const changed = db
      .prepare(
        "UPDATE chats SET name=?,name_source='manual',name_status='ready',name_revision=name_revision+1,updated=? WHERE id=? AND name_revision=?",
      )
      .run(clean, Date.now(), c.id, revision ?? c.name_revision);
    if (!changed.changes) throw fail("CHAT_NAME_CHANGED", 409);
    return row(c.id);
  }
  return {
    onMessage,
    suggest,
    schedule,
    manualName,
    pending: () => inFlight.size + Number(working),
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export function registerTitleSuggestion({ app, names, ownChat, fields, rate }) {
  app.post("/api/chats/:id/title-suggestion", async (req) => {
    const c = ownChat(req.student, req.params.id);
    fields(req.body, []);
    rate("chat-name:" + req.student.user_id, 4);
    return names.suggest(c);
  });
}
