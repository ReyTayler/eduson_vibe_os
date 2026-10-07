import { useEffect, useRef, useState, Suspense, lazy } from "react";
import {
  ArrowLeft,
  ArrowUp,
  ArrowUpRight,
  Plus,
  FilePlus,
  FolderPlus,
  FileCode2,
  FileText,
  Folder,
  ChevronRight,
  ChevronDown,
  Save,
  Play,
  Eye,
  Code2,
  Terminal,
  Globe,
  Power,
  Loader2,
  X,
  Sparkles,
  MessageSquare,
  Check,
  Square,
  RefreshCw,
  Pencil,
  Trash2,
  Copy,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Maximize2,
} from "lucide-react";
import { html } from "@codemirror/lang-html";
import { python } from "@codemirror/lang-python";
import { javascript } from "@codemirror/lang-javascript";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import {
  api,
  kindName,
  type Project,
  type User,
  type Budget,
  type FileEntry,
  type Chat,
  type ChatDetail,
  type Message,
  type Tool,
  type ReasoningMode,
} from "./api";
import { TextDialog, ConfirmDialog } from "./App";
import "./workspace-viewer.css";
import ChatNameActions from "./ChatNameActions";
const CodeMirror = lazy(() => import("@uiw/react-codemirror"));
type Dialog = {
  title: string;
  label: string;
  initial?: string;
  hint?: string;
  submit: (value: string) => Promise<void>;
};
type Confirm = { title: string; text: string; submit: () => Promise<void> };
interface Props {
  project: Project;
  user: User;
  budget: Budget | null;
  initialChat?: string;
  onBack: () => void;
  reload: () => Promise<void>;
  say: (s: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}
export default function Workspace({
  project,
  user,
  budget,
  initialChat,
  onBack,
  reload,
  say,
  onDirtyChange,
}: Props) {
  const [files, setFiles] = useState<FileEntry[]>([]),
    [revision, setRevision] = useState(project.revision),
    [file, setFile] = useState<FileEntry | null>(null),
    [text, setText] = useState(""),
    [savedText, setSavedText] = useState(""),
    [mode, setMode] = useState<"code" | "preview">("code"),
    [preview, setPreview] = useState(""),
    [output, setOutput] = useState(""),
    [consoleOpen, setConsoleOpen] = useState(false),
    [command, setCommand] = useState(""),
    [running, setRunning] = useState(false),
    [saving, setSaving] = useState(false),
    [previewing, setPreviewing] = useState(false),
    [fileLoading, setFileLoading] = useState(false),
    [expanded, setExpanded] = useState(false),
    [chats, setChats] = useState<Chat[]>([]),
    [selectedChat, setSelectedChat] = useState(""),
    [chat, setChat] = useState<ChatDetail | null>(null),
    [draft, setDraft] = useState(""),
    [sending, setSending] = useState(false),
    [reasoningSaving, setReasoningSaving] = useState(false),
    [activeRun, setActiveRun] = useState<string | null>(null),
    [partial, setPartial] = useState(""),
    [phase, setPhase] = useState(""),
    [dialog, setDialog] = useState<Dialog | null>(null),
    [confirm, setConfirm] = useState<Confirm | null>(null),
    [collapsed, setCollapsed] = useState<Set<string>>(new Set()),
    [chatMenu, setChatMenu] = useState(false),
    [hideChat, setHideChat] = useState(false),
    [hostBusy, setHostBusy] = useState(false),
    [fileMenu, setFileMenu] = useState<string | null>(null);
  const fileRef = useRef<FileEntry | null>(null),
    dirtyRef = useRef(false),
    revisionRef = useRef(project.revision),
    chatRef = useRef(""),
    events = useRef<EventSource | null>(null),
    partialBuffer = useRef(""),
    partialFlush = useRef<ReturnType<typeof setTimeout> | null>(null),
    scroll = useRef<HTMLDivElement>(null),
    viewer = useRef<HTMLDialogElement>(null),
    viewerClose = useRef<HTMLButtonElement>(null),
    viewerReturnFocus = useRef<HTMLElement | null>(null),
    fileReadSequence = useRef(0),
    mounted = useRef(true);
  const dirty = text !== savedText,
    busy =
      !!activeRun ||
      sending ||
      reasoningSaving ||
      project.runState === "running" ||
      project.runState === "queued";
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    fileRef.current = file;
    dirtyRef.current = dirty;
    revisionRef.current = revision;
  }, [file, dirty, revision]);
  useEffect(() => {
    chatRef.current = selectedChat;
  }, [selectedChat]);
  async function refreshFiles(read = false) {
    const data = await api<{ files: FileEntry[]; revision: number }>(
      "/projects/" + project.id + "/files",
    );
    if (!mounted.current) return;
    setFiles(data.files);
    setRevision(data.revision);
    revisionRef.current = data.revision;
    const entry = fileRef.current;
    const request = fileReadSequence.current;
    if (read && entry && !dirtyRef.current && !fileLoading && !saving) {
      try {
        const f = await api<{
          text: string;
          version: string;
          revision: number;
        }>(
          "/projects/" +
            project.id +
            "/file?path=" +
            encodeURIComponent(entry.path),
        );
        if (
          !mounted.current ||
          request !== fileReadSequence.current ||
          fileRef.current?.path !== entry.path ||
          dirtyRef.current ||
          f.revision < revisionRef.current
        )
          return data;
        setText(f.text);
        setSavedText(f.text);
        setFile({ ...entry, version: f.version });
        fileRef.current = { ...entry, version: f.version };
        setRevision(f.revision);
        revisionRef.current = f.revision;
      } catch (e) {
        if (
          !mounted.current ||
          request !== fileReadSequence.current ||
          fileRef.current?.path !== entry.path ||
          dirtyRef.current
        )
          return data;
        setFile(null);
        fileRef.current = null;
        setText("");
        setSavedText("");
      }
    }
    return data;
  }
  async function readFile(entry: FileEntry) {
    if (entry.type !== "file") return false;
    const request = ++fileReadSequence.current;
    setFileLoading(true);
    try {
      const value = await api<{
        text: string;
        version: string;
        revision: number;
      }>(
        "/projects/" +
          project.id +
          "/file?path=" +
          encodeURIComponent(entry.path),
      );
      if (!mounted.current || request !== fileReadSequence.current)
        return false;
      setFile({ ...entry, version: value.version });
      fileRef.current = { ...entry, version: value.version };
      setText(value.text);
      setSavedText(value.text);
      dirtyRef.current = false;
      setRevision(value.revision);
      revisionRef.current = value.revision;
      setMode("code");
      return true;
    } finally {
      if (mounted.current && request === fileReadSequence.current)
        setFileLoading(false);
    }
  }
  function openViewer(returnFocus?: HTMLElement | null) {
    const panel = viewer.current;
    if (!panel || panel.matches(":modal")) return;
    viewerReturnFocus.current =
      returnFocus ?? (document.activeElement as HTMLElement | null);
    // Keep the same editor and iframe mounted when moving into the browser top layer.
    panel.close();
    panel.showModal();
    setExpanded(true);
  }
  function closeViewer() {
    const panel = viewer.current;
    if (!panel) return;
    panel.close();
    panel.show();
    setExpanded(false);
    const returnFocus = viewerReturnFocus.current;
    requestAnimationFrame(() => {
      if (!panel.matches(":modal") && returnFocus?.isConnected)
        returnFocus.focus({ preventScroll: true });
    });
  }
  function chooseFile(entry: FileEntry, inWindow = false) {
    if (entry.type === "directory") {
      setCollapsed((old) => {
        const next = new Set(old);
        next.has(entry.path) ? next.delete(entry.path) : next.add(entry.path);
        return next;
      });
      return;
    }
    if (saving) return;
    const returnFocus = document.activeElement as HTMLElement | null;
    const open = async () => {
      if (await readFile(entry)) {
        setFileMenu(null);
        if (inWindow) openViewer(returnFocus);
      }
    };
    if (fileRef.current?.path === entry.path && !fileLoading) {
      setMode("code");
      setFileMenu(null);
      if (inWindow) openViewer(returnFocus);
      return;
    }
    if (dirtyRef.current) {
      setConfirm({
        title: "Перейти к другому файлу?",
        text: "В текущем файле есть несохранённые изменения. При переходе они будут потеряны.",
        submit: open,
      });
    } else void open().catch((e) => say(e.message));
  }
  async function saveFile() {
    if (!fileRef.current || !dirtyRef.current || saving || fileLoading) return;
    setSaving(true);
    try {
      const f = fileRef.current;
      const result = await api<{ version: string; revision: number }>(
        "/projects/" + project.id + "/file",
        "PUT",
        {
          path: f.path,
          text,
          version: f.version,
          revision: revisionRef.current,
        },
      );
      setFile({ ...f, version: result.version });
      fileRef.current = { ...f, version: result.version };
      setSavedText(text);
      dirtyRef.current = false;
      setRevision(result.revision);
      revisionRef.current = result.revision;
      await refreshFiles();
      await reload();
      say("Изменения сохранены");
    } finally {
      setSaving(false);
    }
  }
  async function loadChats(prefer?: string) {
    const list = await api<Chat[]>("/projects/" + project.id + "/chats");
    if (!mounted.current) return;
    setChats(list);
    const id = prefer ?? chatRef.current ?? list[0]?.id;
    const chosen = list.some((c) => c.id === id) ? id : list[0]?.id;
    if (chosen) {
      setSelectedChat(chosen);
      chatRef.current = chosen;
    }
  }
  async function loadChat(id: string) {
    if (!id) return;
    const value = await api<ChatDetail>("/chats/" + id);
    if (!mounted.current || chatRef.current !== id) return;
    setChat(value);
    if (value.activeRun) {
      setActiveRun(value.activeRun.id);
      setPartial("");
      watch(value.activeRun.id);
    } else {
      setActiveRun(null);
    }
  }
  function watch(run: string) {
    events.current?.close();
    if (partialFlush.current) clearTimeout(partialFlush.current);
    partialFlush.current = null;
    partialBuffer.current = "";
    setPartial("");
    const source = new EventSource("/api/runs/" + run + "/events");
    events.current = source;
    source.addEventListener("status", (event) => {
      const value = JSON.parse((event as MessageEvent).data);
      // Status precedes a complete persisted partial on every SSE connection.
      partialBuffer.current = "";
      setPartial("");
      setPhase(
        value.state === "queued" ? "Идея в очереди" : "Помощник работает",
      );
    });
    source.addEventListener("phase", (event) =>
      setPhase(JSON.parse((event as MessageEvent).data).text),
    );
    source.addEventListener("delta", (event) => {
      if (events.current !== source) return;
      partialBuffer.current +=
        JSON.parse((event as MessageEvent).data).text ?? "";
      if (!partialFlush.current)
        partialFlush.current = setTimeout(() => {
          partialFlush.current = null;
          if (mounted.current && events.current === source)
            setPartial(partialBuffer.current);
        }, 100);
    });
    source.addEventListener("complete", () => {
      source.close();
      events.current = null;
      setActiveRun(null);
      if (partialFlush.current) clearTimeout(partialFlush.current);
      partialFlush.current = null;
      partialBuffer.current = "";
      setPartial("");
      setPhase("");
      void Promise.all([
        loadChat(chatRef.current),
        loadChats(),
        refreshFiles(true),
        reload(),
      ]).catch((e) => say(e.message));
    });
    source.onerror = () => {
      setPhase("Восстанавливаю связь…");
    };
  }
  useEffect(() => {
    mounted.current = true;
    void refreshFiles()
      .then(async (data) => {
        if (!data || !mounted.current) return;
        const preferred =
          project.kind === "web"
            ? "index.html"
            : project.kind === "python"
              ? "main.py"
              : "main.js";
        const f =
          data.files.find((f) => f.path === preferred) ??
          data.files.find((f) => f.type === "file");
        if (f) await readFile(f);
      })
      .catch((e) => say(e.message));
    void loadChats(initialChat).catch((e) => say(e.message));
    return () => {
      mounted.current = false;
      events.current?.close();
      if (partialFlush.current) clearTimeout(partialFlush.current);
      partialFlush.current = null;
      partialBuffer.current = "";
    };
  }, [project.id]);
  useEffect(() => {
    void loadChat(selectedChat).catch((e) => say(e.message));
  }, [selectedChat]);
  const pendingChatNames = chats.some(
    (c) => c.name_status === "queued" || c.name_status === "generating",
  );
  useEffect(() => {
    if (!pendingChatNames) return;
    const timer = setInterval(() => {
      void loadChats().catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [pendingChatNames, project.id]);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => {
      void reload()
        .then(() => refreshFiles(true))
        .catch((e) => say(e.message));
    }, 3500);
    return () => clearInterval(timer);
  }, [busy, project.id]);
  useEffect(() => {
    if (!expanded) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    viewerClose.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [expanded]);
  useEffect(() => {
    if (!expanded) return;
    const key = (e: KeyboardEvent) => {
      const panel = viewer.current;
      if (!panel || dialog || confirm || e.defaultPrevented || e.key !== "Tab")
        return;
      const controls = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],iframe,[contenteditable="true"],[tabindex="0"]',
        ),
      ).filter(
        (el) =>
          el.tabIndex >= 0 &&
          el.getClientRects().length > 0 &&
          getComputedStyle(el).visibility !== "hidden",
      );
      const first = controls[0],
        last = controls.at(-1);
      if (!panel.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first)?.focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [expanded, dialog, confirm]);
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [chat?.messages, partial, activeRun]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!busy) void saveFile().catch((e) => say(e.message));
      }
    };
    window.addEventListener("keydown", key);
    const before = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", before);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("beforeunload", before);
    };
  }, [text, busy, revision, file]);
  async function newChat() {
    try {
      const c = await api<{ id: string }>(
        "/projects/" + project.id + "/chats",
        "POST",
        {},
      );
      await loadChats(c.id);
      setChatMenu(false);
    } catch (e) {
      say((e as Error).message);
    }
  }
  async function changeReasoning(mode: ReasoningMode) {
    if (!chat || chat.id !== selectedChat || busy) return;
    const current = selectedChat;
    setReasoningSaving(true);
    try {
      await api("/chats/" + current, "PATCH", { reasoningMode: mode });
      if (chatRef.current === current) {
        await loadChat(current);
        await loadChats(chatRef.current);
      } else await loadChats();
    } catch (e) {
      say((e as Error).message);
    } finally {
      setReasoningSaving(false);
    }
  }
  async function send() {
    if (
      !draft.trim() ||
      !selectedChat ||
      chat?.id !== selectedChat ||
      busy ||
      saving ||
      fileLoading
    )
      return;
    setSending(true);
    try {
      if (dirty) await saveFile();
      const value = draft.trim();
      const r = await api<{ id: string }>(
        "/chats/" + selectedChat + "/messages",
        "POST",
        {
          text: value,
          reasoningMode: chat?.reasoning_mode ?? "off",
          requestId: crypto.randomUUID().replaceAll("-", ""),
        },
      );
      setDraft("");
      setActiveRun(r.id);
      setPartial("");
      setChat((old) =>
        old
          ? {
              ...old,
              messages: [
                ...old.messages,
                {
                  id: r.id,
                  role: "user",
                  text: value,
                  tools: [],
                  created: Date.now(),
                },
              ],
            }
          : old,
      );
      watch(r.id);
      await loadChats(chatRef.current);
      await reload();
    } catch (e) {
      say((e as Error).message);
    } finally {
      setSending(false);
    }
  }
  async function runCode(custom?: string) {
    if (busy || saving || fileLoading) return;
    setRunning(true);
    setConsoleOpen(true);
    try {
      if (dirty) await saveFile();
      const r = await api<{
        exitCode: number;
        timedOut: boolean;
        stdout: { text: string };
        stderr: { text: string };
        durationMs: number;
      }>(
        "/projects/" + project.id + "/run",
        "POST",
        custom ? { command: custom } : { path: file?.path },
      );
      setOutput(
        (custom ? "$ " + custom + "\n\n" : "") +
          r.stdout.text +
          r.stderr.text +
          "\n" +
          (r.timedOut
            ? "Команда остановлена по лимиту времени."
            : "Завершено · код " + r.exitCode) +
          " · " +
          r.durationMs +
          " мс",
      );
    } catch (e) {
      setOutput((e as Error).message);
    } finally {
      setRunning(false);
    }
  }
  async function showPreview() {
    if (busy || saving || fileLoading) return;
    setPreviewing(true);
    try {
      if (dirty) await saveFile();
      const r = await api<{ url: string }>(
        "/projects/" + project.id + "/preview",
        "POST",
        {},
      );
      setPreview(r.url);
      setMode("preview");
    } catch (e) {
      say((e as Error).message);
    } finally {
      setPreviewing(false);
    }
  }
  async function host(enabled: boolean) {
    if (busy || saving || fileLoading || hostBusy) return;
    setHostBusy(true);
    try {
      if (dirty) await saveFile();
      await api("/projects/" + project.id + "/hosting", "POST", { enabled });
      await reload();
      say(
        enabled
          ? "Сохранённая версия теперь онлайн"
          : "Проект выключен. Данные сохранены.",
      );
    } catch (e) {
      say((e as Error).message);
    } finally {
      setHostBusy(false);
    }
  }
  function createEntry(directory = false) {
    if (busy || saving || fileLoading) return;
    setDialog({
      title: directory ? "Новая директория" : "Новый файл",
      label: directory ? "Путь директории" : "Имя и путь файла",
      hint: directory
        ? "Например: src. Родительская директория должна существовать."
        : "Например: src/hello.py. Для вложенного файла сначала создай папку.",
      submit: async (p) => {
        if (dirty) await saveFile();
        if (directory)
          await api("/projects/" + project.id + "/directories", "POST", {
            path: p,
            revision: revisionRef.current,
          });
        else
          await api("/projects/" + project.id + "/file", "PUT", {
            path: p,
            text: "",
            revision: revisionRef.current,
          });
        const data = await refreshFiles();
        await reload();
        if (!directory) {
          const entry = data?.files.find((f) => f.path === p);
          if (entry) await readFile(entry);
        }
        say(directory ? "Директория создана" : "Файл создан");
      },
    });
  }

  function renameEntry(entry: FileEntry) {
    setFileMenu(null);
    setDialog({
      title:
        entry.type === "directory"
          ? "Переименовать директорию"
          : "Переименовать файл",
      label: "Новый путь",
      initial: entry.path,
      submit: async (name) => {
        if (dirty) await saveFile();
        const current = fileRef.current;
        const version =
          entry.type === "file" && current?.path === entry.path
            ? current.version
            : entry.version;
        await api("/projects/" + project.id + "/file", "PATCH", {
          path: entry.path,
          newPath: name,
          version,
          revision: revisionRef.current,
        });
        const data = await refreshFiles();
        const next =
          current?.path === entry.path
            ? name
            : current?.path.startsWith(entry.path + "/")
              ? name + current.path.slice(entry.path.length)
              : current?.path;
        if (next) {
          const f = data?.files.find((f) => f.path === next);
          if (f) await readFile(f);
        }
        await reload();
        say("Название изменено");
      },
    });
  }
  function removeEntry(entry: FileEntry) {
    setFileMenu(null);
    setConfirm({
      title:
        entry.type === "directory" ? "Удалить директорию?" : "Удалить файл?",
      text:
        entry.type === "directory"
          ? "Можно удалить пустую директорию. Сначала удали или перемести файлы внутри неё."
          : "Файл " +
            entry.path +
            " будет удалён из проекта. Опубликованная версия сайта останется прежней.",
      submit: async () => {
        await api("/projects/" + project.id + "/file", "DELETE", {
          path: entry.path,
          version: entry.version,
          revision: revisionRef.current,
        });
        if (fileRef.current?.path === entry.path) {
          setFile(null);
          fileRef.current = null;
          setText("");
          setSavedText("");
          dirtyRef.current = false;
        }
        await refreshFiles();
        await reload();
        say(entry.type === "directory" ? "Директория удалена" : "Файл удалён");
      },
    });
  }
  const language = file?.path.endsWith(".py")
    ? python()
    : file?.path.endsWith(".html")
      ? html()
      : file?.path.endsWith(".css")
        ? css()
        : file?.path.endsWith(".md")
          ? markdown()
          : javascript();
  const canRun = file?.path.endsWith(".py") || file?.path.endsWith(".js");
  function visible(entry: FileEntry) {
    return ![...collapsed].some((p) => entry.path.startsWith(p + "/"));
  }
  return (
    <main className="workspace-page">
      <div className="workspace-heading">
        <div>
          <button
            className="icon-button"
            title="Назад к проектам"
            onClick={() =>
              dirty
                ? setConfirm({
                    title: "Выйти из проекта?",
                    text: "Есть несохранённые изменения. Сохрани их или выйди без сохранения.",
                    submit: async () => onBack(),
                  })
                : onBack()
            }
          >
            <ArrowLeft size={19} />
          </button>
          <div>
            <h1>{project.name}</h1>
            <span>
              {kindName[project.kind]}
              <i />{" "}
              <span className={project.hosting ? "green-text" : ""}>
                {project.hosting ? "В эфире" : "В разработке"}
              </span>
            </span>
          </div>
        </div>
        <div className="workspace-heading-actions">
          {project.kind === "web" && (
            <>
              <button
                className="button secondary small"
                disabled={busy || hostBusy || saving || fileLoading}
                onClick={() => void host(!project.hosting)}
              >
                {hostBusy ? (
                  <Loader2 className="spin" size={15} />
                ) : (
                  <Power size={15} />
                )}
                <span>
                  {project.hosting ? "Выключить хостинг" : "Включить хостинг"}
                </span>
              </button>
              {project.hosting && (
                <a
                  className="icon-button"
                  title="Открыть опубликованный сайт"
                  href={project.url!}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ArrowUpRight size={18} />
                </a>
              )}
            </>
          )}
          <button
            className="icon-button"
            title={hideChat ? "Открыть помощника" : "Скрыть помощника"}
            onClick={() => setHideChat(!hideChat)}
          >
            {hideChat ? (
              <PanelRightOpen size={19} />
            ) : (
              <PanelRightClose size={19} />
            )}
          </button>
        </div>
      </div>
      <div className={"workbench glass " + (hideChat ? "no-chat" : "")}>
        <aside className="file-panel">
          <div className="panel-heading">
            <span>ФАЙЛЫ</span>
            <div>
              <button
                className="icon-button"
                title="Создать файл"
                disabled={busy}
                onClick={() => createEntry()}
              >
                <FilePlus size={15} />
              </button>
              <button
                className="icon-button"
                title="Создать директорию"
                disabled={busy}
                onClick={() => createEntry(true)}
              >
                <FolderPlus size={15} />
              </button>
            </div>
          </div>
          <div className="file-tree">
            {files
              .filter(visible)
              .sort((a, b) => a.path.localeCompare(b.path))
              .map((f) => (
                <div className="file-tree-item" key={f.path}>
                  <button
                    title={f.path}
                    className={
                      "file-tree-row " +
                      (file?.path === f.path ? "selected" : "")
                    }
                    style={{ paddingLeft: 12 + f.path.split("/").length * 9 }}
                    onClick={() => chooseFile(f)}
                    onDoubleClick={() =>
                      f.type === "file" && chooseFile(f, true)
                    }
                  >
                    {f.type === "directory" ? (
                      <>
                        <span className="file-chevron">
                          {collapsed.has(f.path) ? (
                            <ChevronRight size={12} />
                          ) : (
                            <ChevronDown size={12} />
                          )}
                        </span>
                        <Folder size={15} />
                      </>
                    ) : f.path.endsWith(".md") ? (
                      <FileText size={15} />
                    ) : (
                      <FileCode2 size={15} />
                    )}
                    <span>{f.path.split("/").at(-1)}</span>
                  </button>
                  {f.type === "file" && (
                    <button
                      className="tree-expand icon-button"
                      title={"Открыть на весь экран: " + f.path}
                      aria-label={"Открыть на весь экран: " + f.path}
                      disabled={saving}
                      onClick={() => chooseFile(f, true)}
                    >
                      <Maximize2 size={12} />
                    </button>
                  )}
                  <button
                    className="tree-actions icon-button"
                    aria-label={"Действия: " + f.path}
                    aria-expanded={fileMenu === f.path}
                    onClick={() =>
                      setFileMenu(fileMenu === f.path ? null : f.path)
                    }
                  >
                    <MoreHorizontal size={12} />
                  </button>
                  {fileMenu === f.path && (
                    <div className="tree-dropdown">
                      {f.type === "file" && (
                        <button
                          disabled={saving}
                          onClick={() => chooseFile(f, true)}
                        >
                          <Maximize2 size={12} />
                          На весь экран
                        </button>
                      )}
                      <button
                        disabled={busy || saving || fileLoading}
                        onClick={() => renameEntry(f)}
                      >
                        <Pencil size={12} />
                        Переименовать
                      </button>
                      <button
                        disabled={busy || saving || fileLoading}
                        onClick={() => removeEntry(f)}
                      >
                        <Trash2 size={12} />
                        Удалить
                      </button>
                    </div>
                  )}
                </div>
              ))}
          </div>
          <div className="files-bottom">
            <span className="blue-dot" />
            {files.filter((f) => f.type === "file").length} файлов в проекте
          </div>
        </aside>
        <dialog
          ref={viewer}
          open
          className="workspace-viewer"
          role={expanded ? "dialog" : "presentation"}
          aria-modal={expanded || undefined}
          aria-labelledby={expanded ? "workspace-viewer-title" : undefined}
          onCancel={(e) => {
            if (dialog || confirm) e.preventDefault();
          }}
          onClose={() => {
            // An earlier close event may arrive after showModal/show has reopened the panel.
            if (viewer.current?.open) return;
            closeViewer();
          }}
        >
          {expanded && (
            <header
              className={
                "viewer-header " +
                (mode === "preview" ? "viewer-preview" : "viewer-code")
              }
            >
              <div className="viewer-heading">
                <span className="viewer-symbol">
                  {mode === "preview" ? (
                    <Eye size={20} />
                  ) : (
                    <FileCode2 size={20} />
                  )}
                </span>
                <div>
                  <p>
                    {mode === "preview" ? "Результат проекта" : project.name}
                  </p>
                  <h2
                    id="workspace-viewer-title"
                    title={mode === "preview" ? project.name : file?.path}
                  >
                    {mode === "preview"
                      ? project.name
                      : (file?.path ?? "Редактор")}
                  </h2>
                </div>
              </div>
              <div className="viewer-actions">
                {mode === "code" ? (
                  <select
                    aria-label="Открыть файл в окне"
                    value={file?.path ?? ""}
                    disabled={saving}
                    onChange={(e) => {
                      const entry = files.find(
                        (f) => f.path === e.target.value,
                      );
                      if (entry) chooseFile(entry);
                    }}
                  >
                    {!file && <option value="">Выбери файл</option>}
                    {files
                      .filter((f) => f.type === "file")
                      .map((f) => (
                        <option key={f.path} value={f.path}>
                          {f.path}
                        </option>
                      ))}
                  </select>
                ) : (
                  <>
                    {file && (
                      <button
                        className="icon-button"
                        title="Вернуться к файлу"
                        aria-label="Вернуться к файлу"
                        onClick={() => setMode("code")}
                      >
                        <Code2 size={18} />
                      </button>
                    )}
                    <button
                      className="icon-button"
                      title="Обновить предпросмотр"
                      aria-label="Обновить предпросмотр"
                      disabled={busy || previewing || fileLoading || saving}
                      onClick={() => void showPreview()}
                    >
                      {previewing ? (
                        <Loader2 className="spin" size={18} />
                      ) : (
                        <RefreshCw size={18} />
                      )}
                    </button>
                  </>
                )}
                <button
                  ref={viewerClose}
                  className="icon-button viewer-close"
                  title="Закрыть окно · Esc"
                  aria-label="Закрыть полноэкранное окно"
                  onClick={closeViewer}
                >
                  <X size={21} />
                </button>
              </div>
            </header>
          )}
          <section
            className={
              "editor-panel " +
              (mode === "preview" ? "preview-mode" : "code-mode")
            }
          >
            <div className="editor-tabs">
              <button
                className={mode === "code" ? "selected" : ""}
                onClick={() => setMode("code")}
              >
                <Code2 size={15} />
                {file?.path.split("/").at(-1) ?? "Редактор"}
                {dirty && <i className="unsaved-dot" />}
              </button>
              {project.kind === "web" && (
                <button
                  className={mode === "preview" ? "selected" : ""}
                  onClick={() =>
                    preview ? setMode("preview") : void showPreview()
                  }
                >
                  <Eye size={15} />
                  Предпросмотр
                </button>
              )}
              <span />
              <button
                className="icon-button"
                title="Обновить файлы"
                onClick={() =>
                  void refreshFiles(true).catch((e) => say(e.message))
                }
              >
                <RefreshCw size={14} />
              </button>
            </div>
            <div className="editor-toolbar">
              <span>
                {mode === "preview"
                  ? "Результат проекта"
                  : (file?.path ?? "Выбери файл слева")}
              </span>
              <div>
                {!expanded && (
                  <button
                    className="button tiny secondary expand-view"
                    title={
                      mode === "preview"
                        ? "Развернуть проект на весь экран"
                        : "Развернуть файл на весь экран"
                    }
                    aria-label={
                      mode === "preview"
                        ? "Развернуть проект на весь экран"
                        : "Развернуть файл на весь экран"
                    }
                    disabled={
                      fileLoading || (mode === "preview" ? !preview : !file)
                    }
                    onClick={() => openViewer()}
                  >
                    <Maximize2 size={14} />
                    <span>На весь экран</span>
                  </button>
                )}
                {mode === "code" && (
                  <button
                    className="button tiny secondary"
                    title="Сохранить · Ctrl+S"
                    disabled={!dirty || busy || saving || fileLoading}
                    onClick={() => void saveFile().catch((e) => say(e.message))}
                  >
                    {saving ? (
                      <Loader2 className="spin" size={13} />
                    ) : (
                      <Save size={13} />
                    )}
                    Сохранить
                  </button>
                )}
                {project.kind === "web" ? (
                  <button
                    className="button tiny primary"
                    disabled={busy || previewing || saving || fileLoading}
                    onClick={() => void showPreview()}
                  >
                    {previewing ? (
                      <Loader2 className="spin" size={13} />
                    ) : (
                      <Eye size={13} />
                    )}
                    Просмотр
                  </button>
                ) : (
                  <button
                    className="button tiny primary"
                    disabled={
                      !canRun || running || busy || saving || fileLoading
                    }
                    onClick={() => void runCode()}
                  >
                    {running ? (
                      <Loader2 className="spin" size={13} />
                    ) : (
                      <Play size={13} />
                    )}
                    Запустить
                  </button>
                )}
              </div>
            </div>
            <div className="editor-content" aria-busy={fileLoading}>
              {fileLoading && (
                <div className="file-loading-indicator">
                  <Loader2 size={14} className="spin" />
                  Открываю файл…
                </div>
              )}
              {mode === "preview" && preview ? (
                <div className="preview-frame">
                  <iframe
                    title="Предпросмотр проекта"
                    src={preview}
                    sandbox="allow-scripts"
                  />
                  <a
                    href={preview}
                    target="_blank"
                    rel="noreferrer"
                    className="preview-open"
                  >
                    Открыть отдельно <ArrowUpRight size={13} />
                  </a>
                </div>
              ) : file ? (
                <Suspense
                  fallback={
                    <div className="editor-loading">
                      <Loader2 className="spin" size={22} />
                    </div>
                  }
                >
                  <CodeMirror
                    className="document-editor"
                    value={text}
                    height="100%"
                    extensions={[language]}
                    editable={!busy && !saving && !fileLoading}
                    onChange={(value) => {
                      setText(value);
                      dirtyRef.current = value !== savedText;
                    }}
                    basicSetup={{
                      lineNumbers: true,
                      foldGutter: true,
                      highlightActiveLine: true,
                      autocompletion: true,
                    }}
                  />
                </Suspense>
              ) : (
                <div className="editor-empty">
                  <FileCode2 size={31} />
                  <h3>Место для твоего кода</h3>
                  <p>Открой файл слева или создай новый.</p>
                  <button
                    className="button secondary small"
                    disabled={busy}
                    onClick={() => createEntry()}
                  >
                    <FilePlus size={15} />
                    Создать файл
                  </button>
                </div>
              )}
            </div>
            <div className="editor-status">
              <span>
                {busy ? (
                  <>
                    <Loader2 size={12} className="spin" />
                    Помощник работает с файлами
                  </>
                ) : dirty ? (
                  <>
                    <span className="unsaved-dot" />
                    Есть изменения
                  </>
                ) : (
                  <>
                    <Check size={12} />
                    Всё сохранено
                  </>
                )}
              </span>
              <div>
                {file && mode === "code" && (
                  <>
                    <button
                      title="Переименовать файл"
                      disabled={busy}
                      onClick={() => file && renameEntry(file)}
                    >
                      <Pencil size={12} />
                    </button>
                    <button
                      title="Удалить файл"
                      disabled={busy}
                      onClick={() => file && removeEntry(file)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </>
                )}
                <button
                  className={consoleOpen ? "active" : ""}
                  onClick={() => setConsoleOpen(!consoleOpen)}
                >
                  <Terminal size={13} />
                  Консоль
                </button>
              </div>
            </div>
            {consoleOpen && (
              <div className="console-panel">
                <div className="console-header">
                  <span>
                    <Terminal size={13} />
                    Результат выполнения
                  </span>
                  <button
                    className="icon-button"
                    title="Закрыть консоль"
                    onClick={() => setConsoleOpen(false)}
                  >
                    <X size={14} />
                  </button>
                </div>
                <pre>
                  {running
                    ? "Запускаю код…"
                    : output || "Здесь появится результат твоей программы."}
                </pre>
                <form
                  className="command-input"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (command.trim()) {
                      void runCode(command);
                      setCommand("");
                    }
                  }}
                >
                  <span>›</span>
                  <input
                    aria-label="Команда"
                    placeholder="python3.10 main.py"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    disabled={busy || running || saving || fileLoading}
                    maxLength={8000}
                  />
                  <button
                    type="submit"
                    title="Выполнить команду"
                    disabled={busy || running || !command.trim()}
                  >
                    <ArrowUp size={14} />
                  </button>
                </form>
              </div>
            )}
          </section>
          {dialog && (
            <TextDialog dialog={dialog} onClose={() => setDialog(null)} />
          )}
          {confirm && (
            <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
          )}
        </dialog>
        {!hideChat && (
          <section className="assistant-panel">
            <div className="assistant-panel-top">
              <span className="ai-symbol">
                <Sparkles size={19} />
              </span>
              <div>
                <b>Помощник</b>
                <small>
                  <span className="green-dot" />
                  DeepSeek
                </small>
              </div>
              <button
                className="icon-button"
                title="Новый чат"
                onClick={() => void newChat()}
              >
                <Plus size={18} />
              </button>
            </div>
            <div className="chat-selector">
              <select
                aria-label="Выбрать чат"
                value={selectedChat}
                onChange={(e) => {
                  events.current?.close();
                  setActiveRun(null);
                  setPartial("");
                  setSelectedChat(e.target.value);
                  chatRef.current = e.target.value;
                }}
              >
                {chats.map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              {chats.find((c) => c.id === selectedChat) && (
                <ChatNameActions
                  compact
                  chat={chats.find((c) => c.id === selectedChat)!}
                  onSaved={() => loadChats(selectedChat)}
                />
              )}
            </div>
            <div className="chat-messages" ref={scroll}>
              {chat?.messages.length ? (
                chat.messages.map((m) => (
                  <ChatMessage key={m.id} message={m} user={user} />
                ))
              ) : (
                <div className="assistant-empty">
                  <span>
                    <Sparkles size={29} />
                  </span>
                  <h3>
                    Идея начинается
                    <br />с разговора.
                  </h3>
                  <p>
                    Расскажи, что хочешь создать.
                    <br />
                    Будем разбираться и писать код вместе.
                  </p>
                  <div className="prompt-chips">
                    {(project.kind === "web"
                      ? [
                          "Добавь красивую анимацию",
                          "Помоги сделать сайт о космосе",
                          "Объясни, как устроен проект",
                        ]
                      : [
                          "Объясни этот код",
                          "Придумай полезную программу",
                          "Помоги найти ошибку",
                        ]
                    ).map((s) => (
                      <button key={s} onClick={() => setDraft(s)}>
                        <Sparkles size={12} />
                        {s}
                        <ArrowUpRight size={12} />
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {activeRun && (
                <div className="live-message">
                  <span className="live-phase">
                    <Loader2 size={13} className="spin" />
                    {phase || "Помощник работает"}
                  </span>
                  {partial && <MessageBody text={partial} />}
                </div>
              )}
            </div>
            <div className="chat-composer">
              <div className="reasoning-controls">
                <label htmlFor="reasoning-mode">
                  <Sparkles size={13} />
                  Рассуждения
                </label>
                <select
                  id="reasoning-mode"
                  aria-label="Режим рассуждений"
                  value={chat?.reasoning_mode ?? "off"}
                  disabled={busy || !chat || chat.id !== selectedChat}
                  onChange={(e) =>
                    void changeReasoning(e.target.value as ReasoningMode)
                  }
                >
                  <option value="off">Выключены</option>
                  <option value="low">Low</option>
                  <option value="high">High</option>
                  <option value="max">Max</option>
                </select>
                <span title="Длина ответа зависит от остатка недельной квоты и возможностей модели">
                  По квоте
                </span>
              </div>
              <div className="composer-box">
                <textarea
                  aria-label="Сообщение помощнику"
                  placeholder="Что хочешь создать или изменить?"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  maxLength={8000}
                  rows={3}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <div className="composer-bottom">
                  <span>
                    <Sparkles size={12} />
                    Работает с файлами проекта
                  </span>
                  {activeRun ? (
                    <button
                      className="send-button stop"
                      title="Остановить помощника"
                      onClick={() =>
                        void api(
                          "/runs/" + activeRun + "/cancel",
                          "POST",
                          {},
                        ).catch((e) => say(e.message))
                      }
                    >
                      <Square size={14} />
                    </button>
                  ) : (
                    <button
                      className="send-button"
                      title="Отправить сообщение"
                      disabled={
                        !draft.trim() ||
                        busy ||
                        saving ||
                        fileLoading ||
                        !budget?.ready ||
                        !budget?.maxRemainingCalls
                      }
                      onClick={() => void send()}
                    >
                      {sending ? (
                        <Loader2 size={17} className="spin" />
                      ) : (
                        <ArrowUp size={19} />
                      )}
                    </button>
                  )}
                </div>
              </div>
              <p>
                {!budget?.ready
                  ? "Помощник временно недоступен. Редактор работает."
                  : budget?.maxRemainingCalls === 0
                    ? "Недельный лимит исчерпан. Редактор продолжает работать."
                    : "Enter — отправить · Shift + Enter — новая строка"}
              </p>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
function MessageBody({ text }: { text: string }) {
  const parts = text.split("```");
  return (
    <div className="message-body">
      {parts.map((part, i) =>
        i % 2 ? (
          <div className="chat-code" key={i}>
            <div>
              <span>{part.split("\n")[0] || "Код"}</span>
              <button
                title="Скопировать код"
                onClick={() =>
                  void navigator.clipboard.writeText(
                    part.split("\n").slice(1).join("\n"),
                  )
                }
              >
                <Copy size={12} />
              </button>
            </div>
            <pre>{part.split("\n").slice(1).join("\n")}</pre>
          </div>
        ) : (
          <p key={i}>{part}</p>
        ),
      )}
    </div>
  );
}
function ChatMessage({ message, user }: { message: Message; user: User }) {
  if (message.role === "notice")
    return <div className="chat-notice">{message.text}</div>;
  return (
    <div className={"chat-message " + message.role}>
      <div className="message-name">
        {message.role === "assistant" ? (
          <>
            <Sparkles size={13} />
            Помощник
          </>
        ) : (
          <>
            <span className="message-avatar">{user.name[0]}</span>Ты
          </>
        )}
      </div>
      {message.tools.length > 0 && (
        <details className="tool-results">
          <summary>
            <Check size={13} />
            {message.tools.length}{" "}
            {message.tools.length === 1
              ? "действие"
              : message.tools.length > 1 && message.tools.length < 5
                ? "действия"
                : "действий"}{" "}
            в проекте
            <ChevronDown size={12} />
          </summary>
          {message.tools.map((t, i) => {
            let p = "";
            try {
              const args = JSON.parse(t.arguments);
              p = args.path ?? args.command ?? "";
            } catch (parseError) {
              p = "";
            }
            return (
              <div className="tool-result" key={i}>
                <Check size={12} />
                <span>
                  {(
                    {
                      read_file: "Прочитал файл",
                      write_file: "Сохранил файл",
                      edit_file: "Изменил файл",
                      list_directory: "Посмотрел файлы",
                      create_directory: "Создал директорию",
                      run_command: "Выполнил команду",
                    } as Record<string, string>
                  )[t.name] ?? t.name}
                  <small>{p.slice(0, 100)}</small>
                </span>
              </div>
            );
          })}
        </details>
      )}
      <MessageBody text={message.text} />
    </div>
  );
}
