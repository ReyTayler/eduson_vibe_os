import { useEffect, useRef, useState } from "react";
import {
  ShieldCheck,
  ArrowRight,
  LogOut,
  Plus,
  Gift,
  Users,
  Wallet,
  RefreshCw,
  Check,
  Loader2,
  Clock,
  KeyRound,
} from "lucide-react";
import "./admin.css";
type AdminUser = { id: string; login: string; name: string; csrf: string };
type Quota = {
  limitTokens: number;
  baseLimitTokens: number;
  extraLimitTokens: number;
  confirmed_tokens: number;
  uncertain_ceiling: number;
  remainingAuthorizationTokens: number;
  periodStartsAt: string;
  resetsAt: string;
  enabled: boolean;
};
type Account = {
  id: string;
  login: string;
  name: string;
  student: number;
  projects: number;
  budget: Quota;
};
type Grant = {
  id: string;
  tokens: number;
  note: string;
  adminName: string;
  createdAt: string;
  expiresAt: string;
};
const number = (n: number) => new Intl.NumberFormat("ru").format(n);
const moment = (value: string) =>
  new Intl.DateTimeFormat("ru", {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value)) + " МСК";
const pendingKey = "vibe-admin-pending-grant";
export default function Admin() {
  const [user, setUser] = useState<AdminUser | null>(null),
    [starting, setStarting] = useState(true),
    [login, setLogin] = useState(""),
    [password, setPassword] = useState(""),
    [accounts, setAccounts] = useState<Account[]>([]),
    [selectedId, setSelectedId] = useState(""),
    [amount, setAmount] = useState("1000000"),
    [note, setNote] = useState(""),
    [grants, setGrants] = useState<Grant[]>([]),
    [busy, setBusy] = useState(false),
    [refreshing, setRefreshing] = useState(false),
    [feedback, setFeedback] = useState(""),
    [error, setError] = useState(""),
    [oldPassword, setOldPassword] = useState(""),
    [newPassword, setNewPassword] = useState("");
  const csrf = useRef("");
  async function request<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const response = await fetch("/api/admin" + path, {
      method,
      credentials: "same-origin",
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(method !== "GET" ? { "X-CSRF-Token": csrf.current } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    if (!response.ok) {
      if (value.error === "ADMIN_REQUIRED") {
        csrf.current = "";
        setUser(null);
      }
      throw new Error(value.message ?? "Не удалось выполнить действие.");
    }
    return value as T;
  }
  async function refresh() {
    setRefreshing(true);
    try {
      const rows = await request<Account[]>("/students");
      setAccounts(rows);
      setSelectedId((old) =>
        rows.some((a) => a.id === old) ? old : (rows[0]?.id ?? ""),
      );
    } finally {
      setRefreshing(false);
    }
  }
  useEffect(() => {
    let active = true;
    request<AdminUser>("/me")
      .then((me) => {
        if (active) {
          csrf.current = me.csrf;
          setUser(me);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setStarting(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!user) return;
    void refresh().catch((e) => setError(e.message));
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, 30000);
    const visible = () => {
      if (document.visibilityState === "visible")
        void refresh().catch(() => {});
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [user?.id]);
  useEffect(() => {
    const resetsAt = accounts[0]?.budget.resetsAt;
    if (!user || !resetsAt) return;
    const wait = Date.parse(resetsAt) - Date.now();
    if (!Number.isFinite(wait) || wait < 0 || wait > 2147483647) return;
    const timer = setTimeout(() => {
      void refresh().catch(() => {});
    }, wait + 150);
    return () => clearTimeout(timer);
  }, [user?.id, accounts[0]?.budget.resetsAt]);
  useEffect(() => {
    if (!user || !selectedId) {
      setGrants([]);
      return;
    }
    let active = true;
    request<Grant[]>("/students/" + selectedId + "/grants")
      .then((rows) => {
        if (active) setGrants(rows);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [selectedId, user?.id]);
  async function enter(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await request("/auth/login", "POST", { login, password });
      const me = await request<AdminUser>("/me");
      csrf.current = me.csrf;
      setUser(me);
      setPassword("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    try {
      await request("/auth/logout", "POST", {});
      csrf.current = "";
      setUser(null);
      setAccounts([]);
      setGrants([]);
      setFeedback("");
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const selected = accounts.find((a) => a.id === selectedId);
  const parsed = Number(amount.replace(/[ \u00a0\u202f]/g, ""));
  const valid =
    /^\d+$/.test(amount.replace(/[ \u00a0\u202f]/g, "")) &&
    Number.isSafeInteger(parsed) &&
    parsed > 0;
  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !valid || busy) return;
    setBusy(true);
    setError("");
    setFeedback("");
    const payload = {
      tokens: parsed,
      note: note.trim(),
      periodStartsAt: selected.budget.periodStartsAt,
    };
    const fingerprint = JSON.stringify({ account: selected.id, ...payload });
    let requestId = crypto.randomUUID();
    try {
      const saved = JSON.parse(sessionStorage.getItem(pendingKey) ?? "null");
      if (
        saved?.fingerprint === fingerprint &&
        typeof saved?.requestId === "string"
      )
        requestId = saved.requestId;
      sessionStorage.setItem(
        pendingKey,
        JSON.stringify({ fingerprint, requestId }),
      );
      const result = await request<{ grant: Grant; replayed: boolean }>(
        "/students/" + selected.id + "/grants",
        "POST",
        { ...payload, requestId },
      );
      setFeedback(
        (result.replayed ? "Начисление уже выполнено: " : "Начислено ") +
          "+" +
          number(result.grant.tokens) +
          " токенов для " +
          selected.login +
          ". Действуют до " +
          moment(result.grant.expiresAt) +
          ".",
      );
      await refresh();
      setGrants(await request<Grant[]>("/students/" + selected.id + "/grants"));
      sessionStorage.removeItem(pendingKey);
      setNote("");
    } catch (e) {
      setError((e as Error).message);
      void refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await request("/me", "PATCH", { oldPassword, password: newPassword });
      csrf.current = "";
      setUser(null);
      setOldPassword("");
      setNewPassword("");
      setFeedback("Пароль изменён. Войдите с новым паролем.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (starting)
    return (
      <div className="boot">
        <ShieldCheck size={30} />
        <Loader2 className="spin" size={24} />
      </div>
    );
  if (!user)
    return (
      <div className="admin-login">
        <a className="admin-brand" href="/">
          <span>
            <ShieldCheck size={22} />
          </span>
          Vibe OS <small>Управление</small>
        </a>
        <section className="admin-login-card glass">
          <div className="admin-icon">
            <ShieldCheck size={28} />
          </div>
          <div className="eyebrow">ПАНЕЛЬ АДМИНИСТРАТОРА</div>
          <h1>
            Больше возможностей
            <br />
            для каждого ученика
          </h1>
          <p>Управляйте лимитами и проверяйте начисления в одном месте.</p>
          <form onSubmit={enter}>
            <label className="admin-field">
              Логин администратора
              <input
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                autoComplete="username"
                required
                maxLength={64}
              />
            </label>
            <label className="admin-field">
              Пароль администратора
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                maxLength={128}
              />
            </label>
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            {feedback && (
              <div className="admin-success" role="status">
                {feedback}
              </div>
            )}
            <button className="button primary" disabled={busy}>
              {busy ? (
                <Loader2 className="spin" size={18} />
              ) : (
                <>
                  Войти в админ-панель
                  <ArrowRight size={18} />
                </>
              )}
            </button>
          </form>
          <a className="admin-back" href="/">
            Перейти в ученический кабинет
          </a>
        </section>
        <div className="admin-login-note">
          <ShieldCheck size={14} />
          Доступ к управлению есть только у администратора
        </div>
      </div>
    );
  const extra = accounts.reduce((n, a) => n + a.budget.extraLimitTokens, 0);
  return (
    <div className="admin-page">
      <header className="admin-header">
        <a className="admin-brand" href="/admin">
          <span>
            <ShieldCheck size={22} />
          </span>
          Vibe OS <small>Управление</small>
        </a>
        <div className="admin-header-right">
          <span>{user.name}</span>
          <button className="button ghost" onClick={() => void logout()}>
            <LogOut size={16} />
            Выйти
          </button>
        </div>
      </header>
      <main className="admin-main">
        <div className="admin-title">
          <div>
            <div className="eyebrow">УЧЕНИКИ И ВОЗМОЖНОСТИ</div>
            <h1>Пусть идеи продолжаются</h1>
            <p>Добавляйте токены нужному аккаунту и следите за расходом.</p>
          </div>
          <button
            className="button secondary"
            disabled={refreshing || busy}
            onClick={() => void refresh().catch((e) => setError(e.message))}
          >
            <RefreshCw className={refreshing ? "spin" : ""} size={16} />
            Обновить
          </button>
        </div>
        <div className="admin-stats">
          <div className="admin-stat glass">
            <div className="admin-stat-icon">
              <Users size={22} />
            </div>
            <div>
              <span>Ученические кабинеты</span>
              <b>{accounts.length}</b>
            </div>
          </div>
          <div className="admin-stat glass">
            <div className="admin-stat-icon">
              <Wallet size={22} />
            </div>
            <div>
              <span>Базовый лимит на неделю</span>
              <b>
                1 000 000 <small>токенов</small>
              </b>
            </div>
          </div>
          <div className="admin-stat glass">
            <div className="admin-stat-icon">
              <Gift size={22} />
            </div>
            <div>
              <span>Добавлено на эту неделю</span>
              <b>
                {number(extra)} <small>токенов</small>
              </b>
            </div>
          </div>
        </div>
        <div className="admin-layout">
          <section className="admin-accounts glass">
            <div className="admin-section-head">
              <div>
                <h2>Аккаунты учеников</h2>
                <p>Выберите ученика для начисления</p>
              </div>
              <span className="admin-count">{accounts.length}</span>
            </div>
            <div className="admin-table-labels">
              <span>Ученик</span>
              <span>Лимит недели</span>
              <span>Осталось</span>
            </div>
            <div className="admin-rows">
              {accounts.map((a) => (
                <button
                  key={a.id}
                  title={"Выбрать " + a.login}
                  aria-pressed={a.id === selectedId}
                  className={
                    "admin-account-row " +
                    (a.id === selectedId ? "selected" : "")
                  }
                  onClick={() => {
                    setSelectedId(a.id);
                    setFeedback("");
                    setError("");
                  }}
                  disabled={busy}
                >
                  <span className="admin-account-person">
                    <span className="admin-avatar">
                      {String(a.student).padStart(2, "0")}
                    </span>
                    <span>
                      <b>{a.name}</b>
                      <small>
                        {a.login} · проектов: {a.projects}
                      </small>
                    </span>
                  </span>
                  <span className="admin-account-quota">
                    <b>{number(a.budget.limitTokens)}</b>
                    <small>
                      {a.budget.extraLimitTokens
                        ? "+ " +
                          number(a.budget.extraLimitTokens) +
                          " дополнительно"
                        : "Базовая квота"}
                    </small>
                  </span>
                  <span className="admin-account-left">
                    <b>{number(a.budget.remainingAuthorizationTokens)}</b>
                    <small>токенов доступно</small>
                  </span>
                </button>
              ))}
            </div>
            <div className="admin-account-foot">
              <Clock size={16} />
              <span>
                Базовая квота обновляется каждое воскресенье в 23:59 МСК.
                Дополнительные токены действуют до этого сброса.
              </span>
            </div>
            <details className="admin-password">
              <summary>
                <KeyRound size={15} />
                Изменить пароль администратора
              </summary>
              <form onSubmit={changePassword}>
                <label className="admin-field">
                  Текущий пароль администратора
                  <input
                    type="password"
                    value={oldPassword}
                    onChange={(e) => setOldPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                    maxLength={128}
                  />
                </label>
                <label className="admin-field">
                  Новый пароль администратора
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    autoComplete="new-password"
                    required
                    minLength={12}
                    maxLength={128}
                  />
                </label>
                <button className="button secondary" disabled={busy}>
                  Сохранить пароль
                </button>
              </form>
            </details>
          </section>
          <div className="admin-side">
            <section className="admin-grant glass">
              <div className="admin-grant-symbol">
                <Plus size={23} />
              </div>
              <div className="eyebrow">ДОПОЛНИТЕЛЬНАЯ КВОТА</div>
              <h2>Дать больше токенов</h2>
              <p>
                Начисление доступно сразу во всех проектах выбранного ученика.
              </p>
              <form onSubmit={add}>
                <label className="admin-field">
                  Аккаунт
                  <select
                    value={selectedId}
                    onChange={(e) => {
                      setSelectedId(e.target.value);
                      setFeedback("");
                      setError("");
                    }}
                    disabled={busy}
                  >
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.login} — {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="admin-field">
                  Количество токенов
                  <input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    inputMode="numeric"
                    required
                    disabled={busy}
                    placeholder="Например, 2000000"
                    maxLength={20}
                  />
                </label>
                <div className="admin-presets">
                  {[100000, 500000, 1000000, 2000000].map((n) => (
                    <button
                      type="button"
                      key={n}
                      className={parsed === n ? "active" : ""}
                      onClick={() => setAmount(String(n))}
                      disabled={busy}
                    >
                      {n >= 1000000 ? n / 1000000 + " млн" : n / 1000 + " тыс."}
                    </button>
                  ))}
                </div>
                <label className="admin-field">
                  Комментарий <small>необязательно</small>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={2}
                    maxLength={160}
                    disabled={busy}
                    placeholder="Например, дополнительная работа над проектом"
                  />
                </label>
                {selected && (
                  <div className="admin-expiry">
                    <Clock size={15} />
                    <span>
                      Действуют до <b>{moment(selected.budget.resetsAt)}</b>
                    </span>
                  </div>
                )}
                {error && (
                  <div className="form-error" role="alert">
                    {error}
                  </div>
                )}
                {feedback && (
                  <div className="admin-success" role="status">
                    <Check size={16} />
                    {feedback}
                  </div>
                )}
                <button
                  className="button primary admin-add"
                  disabled={!selected || !valid || busy}
                >
                  {busy ? (
                    <Loader2 className="spin" size={18} />
                  ) : (
                    <Plus size={18} />
                  )}
                  Начислить {valid ? number(parsed) : ""} токенов
                </button>
              </form>
            </section>
            <section className="admin-history glass">
              <div className="admin-section-head">
                <div>
                  <h2>Журнал начислений</h2>
                  <p>{selected?.login ?? "Выберите аккаунт"}</p>
                </div>
                <Gift size={19} />
              </div>
              {!grants.length ? (
                <div className="admin-empty">
                  Дополнительных начислений пока нет
                </div>
              ) : (
                <div className="admin-history-list">
                  {grants.map((g) => (
                    <article className="admin-history-item" key={g.id}>
                      <div>
                        <b>+{number(g.tokens)}</b>
                        <time>{moment(g.createdAt)}</time>
                      </div>
                      {g.note && <p>{g.note}</p>}
                      <small>
                        {g.adminName} · до {moment(g.expiresAt)}
                      </small>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
