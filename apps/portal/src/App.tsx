import Admin from "./Admin";
import {
  useEffect,
  useRef,
  useState,
  lazy,
  Suspense,
  type ReactNode,
} from "react";
import {
  ArrowUpRight,
  ArrowRight,
  Plus,
  LayoutDashboard,
  FolderKanban,
  MessageSquare,
  Globe,
  Settings,
  LogOut,
  Search,
  ChevronRight,
  Folder,
  MoreHorizontal,
  Code2,
  Braces,
  Check,
  X,
  Loader2,
  Power,
  Copy,
  Sparkles,
  ShieldCheck,
  ArrowLeft,
  Pencil,
  Trash2,
  Layers,
  Command,
} from "lucide-react";
import {
  api,
  session,
  ago,
  kindName,
  type User,
  type Project,
  type Folder as FolderType,
  type Chat,
  type Budget,
} from "./api";
const Workspace = lazy(() => import("./Workspace"));
type View = "home" | "projects" | "chats" | "hosting" | "settings";
type Dialog = {
  title: string;
  label: string;
  initial?: string;
  hint?: string;
  submit: (value: string) => Promise<void>;
};
type Confirm = { title: string; text: string; submit: () => Promise<void> };
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <span className="brand-mark">
        <svg viewBox="0 0 36 36" aria-hidden="true">
          <path d="M8 12l10 16 10-16M13 9l5 9 5-9" />
        </svg>
      </span>
      {!compact && (
        <span>
          vibe<span className="brand-os">os</span>
          <i>•</i>
        </span>
      )}
    </div>
  );
}
function GlassScene() {
  return (
    <div className="glass-scene" aria-hidden="true">
      <div className="scene-ring" />
      <div className="scene-orb" />
      <div className="floating-code">
        <div className="window-dots">
          <i />
          <i />
          <i />
        </div>
        <div className="code-line">
          <b>const</b> idea = <em>'something new'</em>;
        </div>
        <div className="code-line">
          <b>create</b>(idea);
        </div>
        <span className="scene-code-glow" />
      </div>
      <div className="floating-browser">
        <div className="mini-bar">
          <span />
          <i />
        </div>
        <div className="mini-content">
          <div className="mini-avatar" />
          <b>
            hello, world<span> ✦</span>
          </b>
          <div className="mini-lines">
            <i />
            <i />
          </div>
          <div className="mini-button">
            let's create <ArrowUpRight size={11} />
          </div>
        </div>
      </div>
      <div className="scene-spark">
        <Sparkles size={21} />
      </div>
      <div className="scene-cursor">
        <svg viewBox="0 0 30 36">
          <path d="M4 3L26 19 15 22 10 32Z" />
        </svg>
        <span>твоя идея</span>
      </div>
    </div>
  );
}
function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [login, setLogin] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function enter(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/auth/login", "POST", { login, password });
      const user = await api<User>("/me");
      session(user);
      onLogin(user);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <div className="login-decor" />
      <header className="login-top">
        <Logo />
        <span className="pill">
          <span className="blue-dot" />
          Пространство для твоих идей
        </span>
      </header>
      <main className="login-main">
        <section className="login-story">
          <div className="eyebrow">ПРОБУЙ. СОЗДАВАЙ. РАСТИ.</div>
          <h1>
            Твой следующий
            <br />
            проект начинается
            <br />
            <span>здесь.</span>
          </h1>
          <p>
            Пиши код, экспериментируй и превращай
            <br className="desktop-break" /> свои идеи в работающие проекты.
          </p>
          <GlassScene />
          <div className="login-features">
            <span>
              <Code2 size={17} />
              Твой код
            </span>
            <span>
              <Sparkles size={17} />
              Помощник с ИИ
            </span>
            <span>
              <Globe size={17} />
              Проекты онлайн
            </span>
          </div>
        </section>
        <section className="login-card glass">
          <span className="login-card-symbol">
            <Layers size={25} />
          </span>
          <h2>С возвращением</h2>
          <p>
            Войди в свой кабинет. Здесь всё готово
            <br />
            для твоей следующей идеи.
          </p>
          <form onSubmit={enter}>
            <label htmlFor="login">Логин</label>
            <div className="input-wrap">
              <span>@</span>
              <input
                id="login"
                name="username"
                autoComplete="username"
                placeholder="Логин ученика"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                required
                maxLength={64}
              />
            </div>
            <label htmlFor="password">Пароль</label>
            <div className="input-wrap">
              <ShieldCheck size={17} />
              <input
                id="password"
                type="password"
                name="password"
                autoComplete="current-password"
                placeholder="Твой пароль"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                maxLength={128}
              />
            </div>
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <button className="button primary login-submit" disabled={busy}>
              {busy ? (
                <Loader2 className="spin" size={18} />
              ) : (
                <>
                  Войти в пространство <ArrowRight size={18} />
                </>
              )}
            </button>
          </form>
          <div className="login-note">
            <ShieldCheck size={15} />
            Личный кабинет · твои проекты и разговоры
          </div>
          <a className="login-admin-link" href="/admin">
            Вход для администратора
          </a>
        </section>
      </main>
      <footer className="login-footer">
        <span>Vibe OS</span>
        <span>Маленький шаг. Большая идея.</span>
      </footer>
    </div>
  );
}
function ProjectCover({ project }: { project: Project }) {
  return (
    <div className={"project-cover cover-" + project.kind}>
      {project.kind === "web" ? (
        <div className="cover-browser">
          <div className="cover-toolbar">
            <i />
            <i />
            <i />
            <span />
          </div>
          <div className="cover-layout">
            <div className="cover-text">
              <b />
              <i />
              <i />
              <em />
            </div>
            <div className="cover-sphere" />
          </div>
        </div>
      ) : (
        <div className="cover-code">
          <span>{project.kind === "python" ? "PY" : "JS"}</span>
          <div>
            <i className="c-line long" />
            <i className="c-line" />
            <i className="c-line short" />
            <i className="c-line long" />
          </div>
        </div>
      )}
      <span className="cover-corner">
        {project.kind === "web"
          ? "HTML · CSS · JS"
          : project.kind === "python"
            ? "PYTHON 3"
            : "NODE.JS"}
      </span>
    </div>
  );
}
function StudentApp() {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [view, setView] = useState<View>("home"),
    [projects, setProjects] = useState<Project[]>([]),
    [folders, setFolders] = useState<FolderType[]>([]),
    [budget, setBudget] = useState<Budget | null>(null),
    [opened, setOpened] = useState<Project | null>(null),
    [initialChat, setInitialChat] = useState<string | undefined>(),
    [search, setSearch] = useState(""),
    [folder, setFolder] = useState("all"),
    [type, setType] = useState("all"),
    [toast, setToast] = useState(""),
    [dialog, setDialog] = useState<Dialog | null>(null),
    [confirm, setConfirm] = useState<Confirm | null>(null),
    [projectModal, setProjectModal] = useState(false),
    [editing, setEditing] = useState<Project | null>(null),
    [menu, setMenu] = useState<string | null>(null),
    [allChats, setAllChats] = useState<(Chat & { project: Project })[]>([]);
  const searchRef = useRef<HTMLInputElement>(null);
  function say(value: string) {
    setToast(value);
  }
  async function reload() {
    const [p, f, s] = await Promise.all([
      api<Project[]>("/projects"),
      api<FolderType[]>("/folders"),
      api<{ model: Budget }>("/status"),
    ]);
    setProjects(p);
    setFolders(f);
    setBudget(s.model);
    setOpened((old) => (old ? (p.find((x) => x.id === old.id) ?? old) : null));
  }
  useEffect(() => {
    api<User>("/me")
      .then((u) => {
        session(u);
        setUser(u);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
    const expire = () => {
      setUser(null);
      setOpened(null);
    };
    window.addEventListener("auth-expired", expire);
    return () => window.removeEventListener("auth-expired", expire);
  }, []);
  useEffect(() => {
    if (user) void reload().catch((e) => say(e.message));
  }, [user?.id]);
  useEffect(() => {
    if (!user) return;
    let active = true;
    const refreshBudget = () => {
      void api<{ model: Budget }>("/status")
        .then((s) => {
          if (active) setBudget(s.model);
        })
        .catch(() => {});
    };
    const interval = setInterval(refreshBudget, 30000);
    const untilReset = budget?.resetsAt
      ? Date.parse(budget.resetsAt) - Date.now()
      : NaN;
    const reset =
      Number.isFinite(untilReset) && untilReset >= 0 && untilReset < 2147483647
        ? setTimeout(refreshBudget, untilReset + 150)
        : null;
    const visible = () => {
      if (document.visibilityState === "visible") refreshBudget();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      active = false;
      clearInterval(interval);
      if (reset !== null) clearTimeout(reset);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [user?.id, budget?.resetsAt]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (view === "chats" && user)
      Promise.all(
        projects.map(async (p) =>
          (await api<Chat[]>("/projects/" + p.id + "/chats")).map((c) => ({
            ...c,
            project: p,
          })),
        ),
      )
        .then((v) =>
          setAllChats(v.flat().sort((a, b) => b.updated - a.updated)),
        )
        .catch((e) => say(e.message));
  }, [view, projects.length]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpened(null);
        setView("projects");
        setTimeout(() => searchRef.current?.focus(), 30);
      }
      if (e.key === "Escape") {
        setMenu(null);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);
  async function action(fn: () => Promise<unknown>, success?: string) {
    try {
      await fn();
      await reload();
      if (success) say(success);
    } catch (e) {
      say((e as Error).message);
    }
  }
  function navigate(v: View) {
    setView(v);
    setOpened(null);
    setMenu(null);
  }
  function open(p: Project, chat?: string) {
    setInitialChat(chat);
    setOpened(p);
    setView("projects");
    setMenu(null);
  }
  function newProject() {
    setEditing(null);
    setProjectModal(true);
  }
  function rename(p: Project) {
    setEditing(p);
    setProjectModal(true);
    setMenu(null);
  }
  async function hosting(p: Project) {
    await action(
      () =>
        api("/projects/" + p.id + "/hosting", "POST", { enabled: !p.hosting }),
      p.hosting
        ? "Проект остановлен. Данные сохранены."
        : "Проект теперь онлайн",
    );
  }
  function newFolder() {
    setDialog({
      title: "Новая папка",
      label: "Название папки",
      hint: "Собирай связанные проекты в одном месте.",
      submit: async (name) => {
        await api("/folders", "POST", { name });
        await reload();
        say("Папка создана");
      },
    });
  }
  const initials =
    user?.name
      .split(/\s+/)
      .map((s) => s[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() ?? "";
  const hosted = projects.filter((p) => p.hosting),
    visible = projects.filter(
      (p) =>
        (folder === "all" || p.folder_id === folder) &&
        (type === "all" || p.kind === type) &&
        p.name.toLowerCase().includes(search.toLowerCase()),
    );
  if (loading)
    return (
      <div className="boot">
        <Logo />
        <Loader2 className="spin" size={24} />
      </div>
    );
  if (!user)
    return (
      <>
        <Login onLogin={setUser} />
        {toast && (
          <div className="toast" role="status">
            {toast}
          </div>
        )}
      </>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar glass">
        <Logo />
        <div className="workspace-label">
          <span className="workspace-dot" />
          Личное пространство
        </div>
        <nav>
          {(
            [
              { id: "home", label: "Обзор", icon: LayoutDashboard },
              { id: "projects", label: "Проекты", icon: FolderKanban },
              { id: "chats", label: "Разговоры", icon: MessageSquare },
              { id: "hosting", label: "Хостинг", icon: Globe },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              title={item.label}
              className={"nav-item " + (view === item.id ? "active" : "")}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={19} />
              <span>{item.label}</span>
              {item.id === "projects" && <small>{projects.length}</small>}
              {view === item.id && <i />}
            </button>
          ))}
        </nav>
        <div className="sidebar-folders">
          <div className="sidebar-section">
            <span>ПАПКИ</span>
            <button
              className="icon-button"
              title="Создать папку"
              onClick={newFolder}
            >
              <Plus size={15} />
            </button>
          </div>
          {folders.length ? (
            folders.map((f) => (
              <button
                key={f.id}
                className="folder-nav"
                title={f.name}
                onClick={() => {
                  navigate("projects");
                  setFolder(f.id);
                }}
              >
                <Folder size={16} />
                <span>{f.name}</span>
                <small>
                  {projects.filter((p) => p.folder_id === f.id).length}
                </small>
              </button>
            ))
          ) : (
            <p className="sidebar-muted">
              Новая папка —<br />
              порядок для твоих идей.
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="assistant-ready">
            <span className="ready-orb">
              <Sparkles size={18} />
            </span>
            <div>
              <b>Помощник рядом</b>
              <small>Твоя идея + немного ИИ</small>
            </div>
          </div>
          <button
            className={
              "nav-item settings-nav " + (view === "settings" ? "active" : "")
            }
            onClick={() => navigate("settings")}
            title="Настройки"
          >
            <Settings size={18} />
            <span>Настройки</span>
          </button>
          <button
            className="profile-button"
            onClick={() => navigate("settings")}
          >
            <span className="avatar">{initials}</span>
            <div>
              <b>{user.name}</b>
              <small>{user.login}</small>
            </div>
            <MoreHorizontal size={18} />
          </button>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <div className="breadcrumb">
            Моё пространство <ChevronRight size={14} />
            <span>
              {opened
                ? opened.name
                : {
                    home: "Обзор",
                    projects: "Проекты",
                    chats: "Разговоры",
                    hosting: "Хостинг",
                    settings: "Настройки",
                  }[view]}
            </span>
          </div>
          <div className="topbar-right">
            <span className="private-label">
              <ShieldCheck size={14} />
              Личный кабинет
            </span>
            <button className="button small primary" onClick={newProject}>
              <Plus size={16} />
              <span>Новый проект</span>
            </button>
          </div>
        </header>
        {opened ? (
          <Suspense
            fallback={
              <div className="editor-loading">
                <Loader2 className="spin" size={24} />
              </div>
            }
          >
            <Workspace
              key={opened.id}
              project={opened}
              user={user}
              budget={budget}
              initialChat={initialChat}
              onBack={() => setOpened(null)}
              reload={reload}
              say={say}
            />
          </Suspense>
        ) : (
          <main className="dashboard-content">
            {view === "home" && (
              <>
                <section className="welcome glass">
                  <div className="welcome-text">
                    <span className="eyebrow">
                      ТВОЁ ПРОСТРАНСТВО ДЛЯ СОЗДАНИЯ
                    </span>
                    <h1>
                      Идеям здесь
                      <br />
                      <span>просторно.</span>
                    </h1>
                    <p>
                      От первого «привет, мир» до проекта,
                      <br />
                      которым хочется поделиться.
                    </p>
                    <div className="welcome-actions">
                      <button className="button primary" onClick={newProject}>
                        Создать проект <ArrowUpRight size={17} />
                      </button>
                      {projects.length > 0 && (
                        <button
                          className="text-button"
                          onClick={() => open(projects[0])}
                        >
                          Продолжить работу <ArrowRight size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                  <GlassScene />
                  <span className="welcome-caption">
                    <span className="blue-dot" />
                    Новая идея — всего в одном шаге
                  </span>
                </section>
                <section className="stats-row">
                  <Stat
                    icon={<FolderKanban size={19} />}
                    value={projects.length}
                    label="Твоих проектов"
                    tone="blue"
                  />
                  <Stat
                    icon={<MessageSquare size={19} />}
                    value={projects.reduce((n, p) => n + p.chatCount, 0)}
                    label="Разговоров с помощником"
                    tone="lilac"
                  />
                  <Stat
                    icon={<Globe size={19} />}
                    value={hosted.length + " / 3"}
                    label="Проектов сейчас онлайн"
                    tone="mint"
                  />
                </section>
              </>
            )}
            {(view === "home" || view === "projects") && (
              <>
                <section className="section-heading">
                  <div>
                    <h2>
                      {view === "home"
                        ? "Продолжим создавать?"
                        : "Твои проекты"}
                      <span>{projects.length}</span>
                    </h2>
                    <p>
                      {view === "home"
                        ? "Идеи, к которым можно вернуться в любой момент."
                        : "Создавай, объединяй в папки и развивай в своём темпе."}
                    </p>
                  </div>
                  {view === "home" ? (
                    <button
                      className="text-button"
                      onClick={() => navigate("projects")}
                    >
                      Все проекты <ArrowRight size={15} />
                    </button>
                  ) : (
                    <button className="button secondary" onClick={newFolder}>
                      <Folder size={16} />
                      Новая папка
                    </button>
                  )}
                </section>
                {view === "projects" && (
                  <div className="project-controls">
                    <div className="search-box">
                      <Search size={17} />
                      <input
                        ref={searchRef}
                        placeholder="Найти проект…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                      <kbd>⌘ K</kbd>
                    </div>
                    <div className="filter-buttons">
                      {[
                        ["all", "Все"],
                        ["web", "Веб"],
                        ["python", "Python"],
                        ["node", "JavaScript"],
                      ].map(([id, label]) => (
                        <button
                          key={id}
                          className={type === id ? "selected" : ""}
                          onClick={() => setType(id)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <select
                      className="folder-select"
                      value={folder}
                      onChange={(e) => setFolder(e.target.value)}
                      aria-label="Папка"
                    >
                      <option value="all">Все папки</option>
                      {folders.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {view === "projects" && folder !== "all" && (
                  <div className="folder-heading">
                    <Folder size={17} />
                    <b>{folders.find((f) => f.id === folder)?.name}</b>
                    <button
                      className="icon-button"
                      title="Переименовать папку"
                      onClick={() =>
                        setDialog({
                          title: "Название папки",
                          label: "Название",
                          initial: folders.find((f) => f.id === folder)?.name,
                          submit: async (name) => {
                            await api("/folders/" + folder, "PATCH", { name });
                            await reload();
                          },
                        })
                      }
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      className="icon-button"
                      title="Удалить папку"
                      onClick={() =>
                        setConfirm({
                          title: "Удалить папку?",
                          text: "Проекты останутся в кабинете. Удалится только папка.",
                          submit: async () => {
                            await api("/folders/" + folder, "DELETE", {});
                            setFolder("all");
                            await reload();
                          },
                        })
                      }
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                )}
                <div className="projects-grid">
                  {(view === "home" ? projects.slice(0, 3) : visible).map(
                    (p) => (
                      <article className="project-card glass" key={p.id}>
                        <button
                          className="project-cover-button"
                          onClick={() => open(p)}
                          aria-label={"Открыть " + p.name}
                        >
                          <ProjectCover project={p} />
                        </button>
                        <div className="project-card-body">
                          <div className="project-meta">
                            <span>{kindName[p.kind]}</span>
                            <span
                              className={
                                "project-status " + (p.hosting ? "online" : "")
                              }
                            >
                              <i />
                              {p.hosting
                                ? "В эфире"
                                : p.runState === "running"
                                  ? "ИИ работает"
                                  : "В разработке"}
                            </span>
                          </div>
                          <div className="project-title-row">
                            <button onClick={() => open(p)}>
                              <h3>{p.name}</h3>
                            </button>
                            <div className="project-menu-wrap">
                              <button
                                className="icon-button"
                                title="Действия с проектом"
                                onClick={() =>
                                  setMenu(menu === p.id ? null : p.id)
                                }
                              >
                                <MoreHorizontal size={18} />
                              </button>
                              {menu === p.id && (
                                <div className="dropdown-menu">
                                  <button onClick={() => rename(p)}>
                                    <Pencil size={14} />
                                    Название и папка
                                  </button>
                                  <button
                                    onClick={() => {
                                      setMenu(null);
                                      setConfirm({
                                        title: "Удалить проект?",
                                        text:
                                          "Файлы и чаты проекта «" +
                                          p.name +
                                          "» будут удалены. Опубликованный сайт выключится.",
                                        submit: async () => {
                                          await api(
                                            "/projects/" + p.id,
                                            "DELETE",
                                            {},
                                          );
                                          await reload();
                                          say("Проект удалён");
                                        },
                                      });
                                    }}
                                  >
                                    <Trash2 size={14} />
                                    Удалить проект
                                  </button>
                                  {p.kind === "web" && (
                                    <button
                                      onClick={() => {
                                        setMenu(null);
                                        void hosting(p);
                                      }}
                                    >
                                      <Power size={14} />
                                      {p.hosting
                                        ? "Остановить хостинг"
                                        : "Включить хостинг"}
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="project-card-footer">
                            <span>
                              <MessageSquare size={13} />
                              {p.chatCount}
                              <i /> {ago(p.updated)}
                            </span>
                            <button
                              className="round-arrow"
                              onClick={() => open(p)}
                              aria-label="Открыть проект"
                            >
                              <ArrowUpRight size={17} />
                            </button>
                          </div>
                        </div>
                      </article>
                    ),
                  )}
                  {(view === "home"
                    ? projects.length < 3
                    : visible.length > 0) && (
                    <button className="new-project-card" onClick={newProject}>
                      <span>
                        <Plus size={24} />
                      </span>
                      <b>Что создадим дальше?</b>
                      <small>Дай новой идее место</small>
                    </button>
                  )}
                </div>
                {projects.length === 0 && (
                  <div className="empty-state glass">
                    <span className="empty-symbol">
                      <Sparkles size={31} />
                    </span>
                    <h2>Первая идея — твоя.</h2>
                    <p>
                      Сайт, игра или первые строчки кода.
                      <br />
                      Создай проект — помощник будет рядом.
                    </p>
                    <button className="button primary" onClick={newProject}>
                      <Plus size={17} />
                      Создать первый проект
                    </button>
                  </div>
                )}
                {projects.length > 0 &&
                  view === "projects" &&
                  visible.length === 0 && (
                    <div className="empty-state">
                      <Search size={30} />
                      <h3>Пока ничего не нашлось</h3>
                      <p>Попробуй другое название или убери фильтры.</p>
                      <button
                        className="button secondary"
                        onClick={() => {
                          setType("all");
                          setFolder("all");
                          setSearch("");
                        }}
                      >
                        Сбросить фильтры
                      </button>
                    </div>
                  )}
                {view === "home" && (
                  <section className="idea-banner glass">
                    <span className="idea-icon">
                      <Sparkles size={25} />
                    </span>
                    <div>
                      <h3>Есть идея, но пока не знаешь, с чего начать?</h3>
                      <p>
                        Расскажи помощнику, что хочется создать. Первый шаг
                        найдём вместе.
                      </p>
                    </div>
                    <button
                      className="text-button"
                      onClick={() =>
                        projects.length ? open(projects[0]) : newProject()
                      }
                    >
                      Начнём <ArrowRight size={17} />
                    </button>
                  </section>
                )}
              </>
            )}
            {view === "chats" && (
              <>
                <PageTitle
                  eyebrow="МЫСЛИ СТАНОВЯТСЯ ПРОЕКТАМИ"
                  title="Твои разговоры"
                  description="У каждого проекта своя история. Здесь можно продолжить любую."
                />
                <div className="chat-list glass">
                  {allChats.map((c) => (
                    <button
                      className="chat-list-row"
                      key={c.id}
                      onClick={() => open(c.project, c.id)}
                    >
                      <span className="chat-icon">
                        <MessageSquare size={20} />
                      </span>
                      <div>
                        <b>{c.name}</b>
                        <small>
                          {c.project.name} · {ago(c.updated)}
                        </small>
                      </div>
                      <ArrowUpRight size={18} />
                    </button>
                  ))}
                </div>
                {!allChats.length && (
                  <div className="empty-state glass">
                    <MessageSquare size={32} />
                    <h2>Тут начнётся разговор</h2>
                    <p>Создай проект и опиши помощнику свою идею.</p>
                    <button className="button primary" onClick={newProject}>
                      Создать проект <Plus size={16} />
                    </button>
                  </div>
                )}
              </>
            )}
            {view === "hosting" && (
              <>
                <PageTitle
                  eyebrow="ТВОИ ИДЕИ В ИНТЕРНЕТЕ"
                  title="Пусть проекты живут"
                  description="Одновременно можно включить три проекта. Выключение сохраняет файлы и разговоры."
                />
                <div className="hosting-summary glass">
                  <span className="hosting-orb">
                    <Globe size={31} />
                  </span>
                  <div>
                    <b>{hosted.length} из 3 слотов занято</b>
                    <p>
                      {3 - hosted.length
                        ? "Есть место для новой публикации."
                        : "Выключи один проект, чтобы включить другой."}
                    </p>
                  </div>
                  <div className="slot-indicators">
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className={i < hosted.length ? "filled" : ""}
                      />
                    ))}
                  </div>
                </div>
                <div className="hosting-grid">
                  {[1, 2, 3].map((slot) => {
                    const p = hosted.find((p) => p.slot === slot);
                    return (
                      <article
                        className={"hosting-card glass " + (!p ? "vacant" : "")}
                        key={slot}
                      >
                        <div className="hosting-card-top">
                          <span>Слот 0{slot}</span>
                          <span
                            className={"project-status " + (p ? "online" : "")}
                          >
                            <i />
                            {p ? "Онлайн" : "Свободен"}
                          </span>
                        </div>
                        {p ? (
                          <>
                            <span className="hosting-project-icon">
                              <Globe size={25} />
                            </span>
                            <h3>{p.name}</h3>
                            <p>Опубликованная версия проекта</p>
                            <a
                              className="button secondary"
                              href={p.url!}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Открыть сайт <ArrowUpRight size={16} />
                            </a>
                            <div className="hosting-actions">
                              <button
                                onClick={() =>
                                  void action(
                                    () =>
                                      api(
                                        "/projects/" + p.id + "/hosting",
                                        "POST",
                                        { enabled: true },
                                      ),
                                    "Публикация обновлена",
                                  )
                                }
                              >
                                <Layers size={14} />
                                Обновить
                              </button>
                              <button onClick={() => void hosting(p)}>
                                <Power size={14} />
                                Выключить
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            <span className="vacant-ring">
                              <Plus size={27} />
                            </span>
                            <h3>Место для твоей идеи</h3>
                            <p>
                              Выбери веб-проект ниже
                              <br />и включи хостинг.
                            </p>
                          </>
                        )}
                      </article>
                    );
                  })}
                </div>
                <section className="section-heading">
                  <div>
                    <h2>Готовы к публикации</h2>
                    <p>
                      Публикуется сохранённая версия. Изменения можно выложить
                      повторно.
                    </p>
                  </div>
                </section>
                <div className="publish-list glass">
                  {projects
                    .filter((p) => p.kind === "web" && !p.hosting)
                    .map((p) => (
                      <div className="publish-row" key={p.id}>
                        <span className="chat-icon">
                          <Code2 size={20} />
                        </span>
                        <div>
                          <b>{p.name}</b>
                          <small>HTML, CSS и JavaScript</small>
                        </div>
                        <button
                          className="button small primary"
                          disabled={hosted.length >= 3}
                          onClick={() => void hosting(p)}
                        >
                          <Power size={14} />
                          Включить
                        </button>
                      </div>
                    ))}
                  {!projects.some((p) => p.kind === "web" && !p.hosting) && (
                    <p className="publish-empty">
                      Создай новый веб-проект, чтобы опубликовать его здесь.
                    </p>
                  )}
                </div>
              </>
            )}
            {view === "settings" && (
              <SettingsPage
                user={user}
                budget={budget}
                say={say}
                onUpdate={async () => {
                  const u = await api<User>("/me");
                  session(u);
                  setUser(u);
                }}
                onLogout={async () => {
                  await api("/auth/logout", "POST", {});
                  setUser(null);
                  setOpened(null);
                }}
              />
            )}
          </main>
        )}
        <footer className="app-footer">
          <span>Сделано для твоих идей.</span>
          <span>
            vibe os <span className="footer-star">✦</span>
          </span>
        </footer>
      </div>
      {toast && (
        <div className="toast" role="status">
          <Check size={17} />
          {toast}
          <button onClick={() => setToast("")} aria-label="Закрыть уведомление">
            <X size={15} />
          </button>
        </div>
      )}
      {projectModal && (
        <ProjectModal
          editing={editing}
          folders={folders}
          onClose={() => setProjectModal(false)}
          onSubmit={async (values) => {
            if (editing) {
              await api("/projects/" + editing.id, "PATCH", {
                name: values.name,
                folderId: values.folderId,
              });
              await reload();
              say("Проект обновлён");
            } else {
              const p = await api<{ id: string; chat: string }>(
                "/projects",
                "POST",
                values,
              );
              const rows = await api<Project[]>("/projects");
              setProjects(rows);
              open(
                rows.find((r) => r.id === p.id)!,
                p.chat,
              );
              await reload();
              say("Проект создан. Можно начинать!");
            }
            setProjectModal(false);
          }}
        />
      )}
      {dialog && <TextDialog dialog={dialog} onClose={() => setDialog(null)} />}
      {confirm && (
        <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
      )}
    </div>
  );
}
function Stat({
  icon,
  value,
  label,
  tone,
}: {
  icon: ReactNode;
  value: string | number;
  label: string;
  tone: string;
}) {
  return (
    <div className="stat-card glass">
      <span className={"stat-icon " + tone}>{icon}</span>
      <div>
        <b>{value}</b>
        <small>{label}</small>
      </div>
      <span className="stat-dash">—</span>
    </div>
  );
}
function PageTitle({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="page-title">
      <span className="eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      <p>{description}</p>
    </div>
  );
}
function SettingsPage({
  user,
  budget,
  say,
  onUpdate,
  onLogout,
}: {
  user: User;
  budget: Budget | null;
  say: (v: string) => void;
  onUpdate: () => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const [name, setName] = useState(user.name),
    [old, setOld] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(
        "/me",
        "PATCH",
        password ? { name, oldPassword: old, password } : { name },
      );
      if (password) {
        await onLogout().catch(() => {});
        window.dispatchEvent(new Event("auth-expired"));
        say("Пароль изменён. Войди с новым паролем.");
      } else {
        await onUpdate();
        say("Профиль сохранён");
      }
    } catch (e) {
      say((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageTitle
        eyebrow="ТВОЁ ЛИЧНОЕ ПРОСТРАНСТВО"
        title="Всё на своих местах"
        description="Как к тебе обращаться и как защитить твой кабинет."
      />
      <div className="settings-grid">
        <form className="settings-card glass" onSubmit={save}>
          <h2>Твой профиль</h2>
          <label>
            Логин
            <input value={user.login} disabled />
          </label>
          <label>
            Имя в кабинете
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={64}
            />
          </label>
          <div className="settings-divider" />
          <h3>Изменить пароль</h3>
          <p>Оставь эти поля пустыми, если пароль менять не нужно.</p>
          <label>
            Текущий пароль
            <input
              type="password"
              autoComplete="current-password"
              value={old}
              onChange={(e) => setOld(e.target.value)}
            />
          </label>
          <label>
            Новый пароль
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              minLength={12}
              maxLength={128}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Не меньше 12 символов"
            />
          </label>
          <button className="button primary" disabled={busy}>
            {busy ? (
              <Loader2 className="spin" size={16} />
            ) : (
              <Check size={16} />
            )}
            Сохранить изменения
          </button>
        </form>
        <div className="settings-side">
          <div className="settings-card glass">
            <span className="settings-icon">
              <Sparkles size={24} />
            </span>
            <h2>Помощник с ИИ</h2>
            <p>
              DeepSeek помогает разбираться в коде и работает с файлами твоего
              проекта.
            </p>
            <div className="budget-status">
              <span
                className={
                  budget?.ready && budget?.maxRemainingCalls
                    ? "green-dot"
                    : "blue-dot"
                }
              />
              {!budget?.ready
                ? "Временно недоступен"
                : budget?.maxRemainingCalls
                  ? "Подключён"
                  : "Лимит исчерпан"}
            </div>
            <div className="budget-line">
              <span>Доступно токенов</span>
              <b>
                {budget
                  ? new Intl.NumberFormat("ru").format(budget.remainingTokens)
                  : "—"}
              </b>
            </div>
            <div className="budget-line">
              <span>Твой лимит на неделю</span>
              <b>
                {new Intl.NumberFormat("ru").format(
                  budget?.limitTokens ?? 1000000,
                )}
              </b>
            </div>
            {!!budget?.extraLimitTokens && (
              <div className="budget-line">
                <span>Из них дополнительно</span>
                <b>
                  +{new Intl.NumberFormat("ru").format(budget.extraLimitTokens)}
                </b>
              </div>
            )}
            <div className="budget-line">
              <span>Использовано</span>
              <b>
                {new Intl.NumberFormat("ru").format(
                  budget?.confirmedTokens ?? 0,
                )}
              </b>
            </div>
            {!!budget?.reservedTokens && (
              <div className="budget-line">
                <span>В резерве</span>
                <b>
                  {new Intl.NumberFormat("ru").format(budget.reservedTokens)}
                </b>
              </div>
            )}
            <div className="budget-line">
              <span>Следующий сброс</span>
              <b>
                {budget?.resetsAt
                  ? new Intl.DateTimeFormat("ru", {
                      timeZone: "Europe/Moscow",
                      day: "2-digit",
                      month: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                      hourCycle: "h23",
                    }).format(new Date(budget.resetsAt)) + " МСК"
                  : "—"}
              </b>
            </div>
            <small>
              Базовый лимит — 1 млн токенов в неделю на все твои проекты и чаты.
              Дополнительные начисления действуют до следующего сброса. Сброс
              каждое воскресенье в 23:59 по Москве. Для незавершённых запросов
              сохраняется резерв.
            </small>
          </div>
          <div className="settings-card glass">
            <h3>Завершить работу</h3>
            <p>Файлы и разговоры останутся в твоём кабинете.</p>
            <button
              className="button secondary"
              onClick={() => void onLogout().catch((e) => say(e.message))}
            >
              <LogOut size={16} />
              Выйти из кабинета
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
function Modal({
  children,
  onClose,
  className = "",
}: {
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && box.current) {
        const list = Array.from(
          box.current.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]",
          ),
        );
        const first = list[0],
          last = list.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        className={"modal glass " + className}
      >
        <button
          className="modal-close icon-button"
          onClick={onClose}
          aria-label="Закрыть"
        >
          <X size={20} />
        </button>
        {children}
      </div>
    </div>
  );
}
export function TextDialog({
  dialog,
  onClose,
}: {
  dialog: Dialog;
  onClose: () => void;
}) {
  const [value, setValue] = useState(dialog.initial ?? ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal onClose={onClose}>
      <span className="modal-symbol">
        <Folder size={25} />
      </span>
      <h2>{dialog.title}</h2>
      {dialog.hint && <p>{dialog.hint}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          dialog
            .submit(value)
            .then(onClose)
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          {dialog.label}
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            required
            maxLength={200}
          />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Отмена
          </button>
          <button className="button primary" disabled={busy || !value.trim()}>
            {busy ? (
              <Loader2 size={16} className="spin" />
            ) : (
              <Check size={16} />
            )}
            Сохранить
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function ConfirmDialog({
  confirm,
  onClose,
}: {
  confirm: Confirm;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal onClose={onClose}>
      <h2>{confirm.title}</h2>
      <p>{confirm.text}</p>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-actions">
        <button className="button secondary" onClick={onClose}>
          Отмена
        </button>
        <button
          className="button primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            confirm
              .submit()
              .then(onClose)
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? <Loader2 className="spin" size={16} /> : "Продолжить"}
        </button>
      </div>
    </Modal>
  );
}
function ProjectModal({
  editing,
  folders,
  onClose,
  onSubmit,
}: {
  editing: Project | null;
  folders: FolderType[];
  onClose: () => void;
  onSubmit: (v: {
    name: string;
    kind: Project["kind"];
    folderId: string | null;
  }) => Promise<void>;
}) {
  const [name, setName] = useState(editing?.name ?? ""),
    [kind, setKind] = useState<Project["kind"]>(editing?.kind ?? "web"),
    [folder, setFolder] = useState(editing?.folder_id ?? ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal onClose={onClose} className="project-modal">
      <span className="modal-symbol">
        <Sparkles size={25} />
      </span>
      <span className="eyebrow">ДАЙ ИДЕЕ МЕСТО</span>
      <h2>{editing ? "О твоём проекте" : "Что будем создавать?"}</h2>
      <p>
        {editing
          ? "Хорошее название помогает найти свою идею."
          : "Выбери начало. Дальше всё зависит от тебя."}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          onSubmit({ name, kind, folderId: folder || null })
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <label>
          Название проекта
          <input
            placeholder="Например, мой космический сайт"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
          />
        </label>
        {!editing && (
          <div className="template-options">
            {(
              [
                {
                  id: "web",
                  label: "Веб-проект",
                  detail: "Сайты и интерактивы",
                  icon: Globe,
                },
                {
                  id: "python",
                  label: "Python",
                  detail: "Код и эксперименты",
                  icon: Braces,
                },
                {
                  id: "node",
                  label: "JavaScript",
                  detail: "Программы на Node",
                  icon: Code2,
                },
              ] as const
            ).map((t) => (
              <button
                type="button"
                key={t.id}
                className={kind === t.id ? "selected" : ""}
                onClick={() => setKind(t.id)}
              >
                <t.icon size={23} />
                <b>{t.label}</b>
                <small>{t.detail}</small>
                {kind === t.id && (
                  <Check size={14} className="template-check" />
                )}
              </button>
            ))}
          </div>
        )}
        <label>
          Папка
          <select
            aria-label="Папка"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
          >
            <option value="">Без папки</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Отмена
          </button>
          <button className="button primary" disabled={busy || !name.trim()}>
            {busy ? <Loader2 className="spin" size={17} /> : <Plus size={17} />}{" "}
            {editing ? "Сохранить" : "Создать проект"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function App() {
  return window.location.pathname.replace(/\/$/, "") === "/admin" ? (
    <Admin />
  ) : (
    <StudentApp />
  );
}
