import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { Pencil, Sparkles, Loader2, Check } from "lucide-react";
import { api, type Chat } from "./api";
import { Modal } from "./App";
import "./chat-names.css";

type Suggestion = {
  name: string;
  source: "model" | "local";
  reason?: "empty" | "busy" | "budget" | "unavailable";
  name_revision: number;
};
type Props = { chat: Chat; onSaved: () => Promise<void>; compact?: boolean };
export default function ChatNameActions({
  chat,
  onSaved,
  compact = false,
}: Props) {
  const [mode, setMode] = useState<"rename" | "suggest" | null>(null);
  const close = useCallback(() => setMode(null), []);
  return (
    <div className={"chat-name-actions" + (compact ? " compact" : "")}>
      <button
        type="button"
        className="icon-button"
        title="Переименовать чат"
        aria-label={"Переименовать чат «" + chat.name + "»"}
        onClick={() => setMode("rename")}
      >
        <Pencil size={compact ? 13 : 16} />
      </button>
      <button
        type="button"
        className="icon-button"
        title="Подобрать название"
        aria-label={"Подобрать название для «" + chat.name + "»"}
        onClick={() => setMode("suggest")}
      >
        <Sparkles size={compact ? 14 : 17} />
      </button>
      {mode &&
        createPortal(
          <ChatNameDialog
            key={chat.id + ":" + mode}
            chat={chat}
            initialMode={mode}
            onClose={close}
            onSaved={onSaved}
          />,
          document.body,
        )}
    </div>
  );
}
function ChatNameDialog({
  chat,
  initialMode,
  onClose,
  onSaved,
}: Props & { initialMode: "rename" | "suggest"; onClose: () => void }) {
  const [name, setName] = useState(chat.name),
    [busy, setBusy] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [hint, setHint] = useState("");
  const revision = useRef(chat.name_revision),
    active = useRef(true),
    editVersion = useRef(0),
    started = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  async function generate() {
    setBusy(true);
    setError("");
    setHint("");
    const version = editVersion.current;
    try {
      const value = await api<Suggestion>(
        "/chats/" + chat.id + "/title-suggestion",
        "POST",
        {},
      );
      if (!active.current) return;
      if (version !== editVersion.current) {
        setHint(
          "Твоё имя сохранено в поле. Для нового варианта нажми ещё раз.",
        );
        return;
      }
      setName(value.name);
      revision.current = value.name_revision;
      setHint(
        value.source === "model"
          ? "Название подобрано по истории. Можно поправить перед сохранением."
          : value.reason === "empty"
            ? "В чате ещё нет запросов. Предложено название проекта."
            : value.reason === "busy"
              ? "Помощник занят. Название составлено из первого запроса."
              : value.reason === "budget"
                ? "Кредитов недостаточно. Название составлено из первого запроса."
                : "Название составлено из первого запроса.",
      );
      input.current?.focus();
    } catch (e) {
      if (active.current) setError((e as Error).message);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (initialMode === "suggest" && !started.current) {
      started.current = true;
      void generate();
    }
  }, [initialMode]);
  async function save() {
    if (!name.trim() || saving || busy) return;
    setSaving(true);
    setError("");
    try {
      await api("/chats/" + chat.id, "PATCH", {
        name: name.trim(),
        ...(revision.current !== undefined
          ? { nameRevision: revision.current }
          : {}),
      });
      if (!active.current) return;
      try {
        await onSaved();
      } catch {
        /* Rename is already durable; the list refresh can retry. */
      }
      onClose();
    } catch (e) {
      if (!active.current) return;
      if ((e as Error & { code?: string }).code === "CHAT_NAME_CHANGED") {
        const current = await api<Chat>("/chats/" + chat.id).catch(() => null);
        if (!active.current) return;
        if (current) revision.current = current.name_revision;
        setError(
          "Чат уже переименован: «" +
            (current?.name ?? chat.name) +
            "». Проверь своё имя и нажми «Сохранить» ещё раз.",
        );
      } else setError((e as Error).message);
    } finally {
      if (active.current) setSaving(false);
    }
  }
  return (
    <Modal
      className="chat-name-modal"
      onClose={onClose}
      label={
        initialMode === "suggest" ? "Подобрать название" : "Название разговора"
      }
    >
      <span className="modal-symbol">
        <MessageIcon mode={initialMode} />
      </span>
      <h2>
        {initialMode === "suggest"
          ? "Подобрать название"
          : "Название разговора"}
      </h2>
      <p>
        Короткое имя поможет найти нужный разговор. Сохранённое имя останется
        твоим.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            e.stopPropagation();
            void save();
          }
        }}
      >
        <label className="field">
          Название
          <input
            ref={input}
            autoFocus
            value={name}
            maxLength={80}
            placeholder="Например: Космическая игра на Python"
            onChange={(e) => {
              editVersion.current++;
              setName(e.target.value);
            }}
          />
        </label>
        <div className="chat-name-detail">
          <span>До 80 символов</span>
          <span>{name.length}/80</span>
        </div>
        <div className="chat-name-emojis" aria-label="Добавить эмодзи">
          {["🎮", "🚀", "🐧", "🐍", "🎨", "💡", "🛠️", "📚"].map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={"Добавить " + emoji}
              title={"Добавить " + emoji}
              disabled={saving || busy}
              onClick={() => {
                editVersion.current++;
                setName((value) => {
                  const plain = value.replace(
                    /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\u200D\p{Extended_Pictographic})*\s*/u,
                    "",
                  );
                  return (emoji + " " + plain).slice(0, 80);
                });
                input.current?.focus();
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
        {hint && (
          <p className="chat-name-hint" role="status">
            <Check size={15} />
            {hint}
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="chat-name-footer">
          <button
            className="button secondary"
            type="button"
            disabled={busy || saving}
            onClick={() => void generate()}
          >
            {busy ? (
              <Loader2 className="spin" size={16} />
            ) : (
              <Sparkles size={16} />
            )}
            {busy ? "Подбираем…" : "Подобрать название"}
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={saving || busy || !name.trim()}
          >
            {saving ? (
              <Loader2 className="spin" size={16} />
            ) : (
              <Check size={16} />
            )}
            Сохранить
          </button>
        </div>
        <small className="chat-name-cost">
          Подбор с ИИ использует немного недельных кредитов.
        </small>
      </form>
    </Modal>
  );
}
function MessageIcon({ mode }: { mode: "rename" | "suggest" }) {
  return mode === "suggest" ? <Sparkles size={25} /> : <Pencil size={25} />;
}
