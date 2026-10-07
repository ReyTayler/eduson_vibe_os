import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, BookOpen, Loader2, Play, X } from "lucide-react";
import { lessons, type Lesson } from "./lessons-data";
import "./lessons.css";

function slideCount(count: number) {
  const last = count % 10,
    hundred = count % 100;
  const word =
    hundred >= 11 && hundred <= 14
      ? "слайдов"
      : last === 1
        ? "слайд"
        : last >= 2 && last <= 4
          ? "слайда"
          : "слайдов";
  return count + " " + word;
}

export default function Lessons() {
  const [selected, setSelected] = useState<Lesson | null>(null);
  const returnFocus = useRef<HTMLAnchorElement | null>(null);
  return (
    <section className="lessons-page">
      <header className="lessons-title">
        <div>
          <span className="eyebrow">VIBE-CODING И НЕЙРОСЕТИ</span>
          <h1>Уроки</h1>
          <p>Открывай урок и пробуй новое в своих проектах.</p>
        </div>
        <span className="pill">
          <BookOpen size={15} />
          {lessons.length} уроков
        </span>
      </header>
      <div className="lessons-grid">
        {lessons.map((lesson) => (
          <a
            key={lesson.number}
            className="lesson-card glass"
            href={lesson.source}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={"Открыть урок " + lesson.number + ": " + lesson.title}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              returnFocus.current = e.currentTarget;
              setSelected(lesson);
            }}
          >
            <div className="lesson-cover">
              <img
                src={lesson.cover}
                srcSet={lesson.cover + " 384w, " + lesson.cover2x + " 768w"}
                sizes="(max-width: 600px) calc(100vw - 90px), (max-width: 900px) 40vw, (max-width: 1200px) 30vw, 24vw"
                alt={"Первый слайд урока " + lesson.number}
                width={768}
                height={432}
                loading={lesson.number > 4 ? "lazy" : "eager"}
                decoding="async"
              />
              <span className="lesson-cover-action">
                <Play size={18} fill="currentColor" />
                Открыть урок
              </span>
            </div>
            <div className="lesson-card-body">
              <div className="lesson-meta">
                <span>Урок {String(lesson.number).padStart(2, "0")}</span>
                <span title={lesson.moduleTitle}>Модуль {lesson.module}</span>
              </div>
              <h2>{lesson.title}</h2>
              <div className="lesson-card-footer">
                <span>{slideCount(lesson.slides)}</span>
                <ArrowUpRight size={17} />
              </div>
            </div>
          </a>
        ))}
      </div>
      {selected && (
        <LessonViewer
          key={selected.number}
          lesson={selected}
          onClose={() => {
            setSelected(null);
            requestAnimationFrame(() =>
              returnFocus.current?.focus({ preventScroll: true }),
            );
          }}
        />
      )}
    </section>
  );
}

function LessonViewer({
  lesson,
  onClose,
}: {
  lesson: Lesson;
  onClose: () => void;
}) {
  const panel = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const box = panel.current;
    if (!box) return;
    box.showModal();
    closeButton.current?.focus({ preventScroll: true });
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key !== "Tab") return;
      const controls = Array.from(
        box.querySelectorAll<HTMLElement>(
          "button:not(:disabled),a[href],iframe",
        ),
      ).filter((el) => el.getClientRects().length > 0 && el.tabIndex >= 0);
      const first = controls[0],
        last = controls.at(-1);
      if (!box.contains(document.activeElement)) {
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
    return () => {
      window.removeEventListener("keydown", key);
      document.body.style.overflow = overflow;
      if (box.open) box.close();
    };
  }, []);
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => {
      setFailed(true);
      setLoading(false);
    }, 15000);
    return () => clearTimeout(timer);
  }, [loading, attempt]);
  function retry() {
    setFailed(false);
    setLoading(true);
    setAttempt((old) => old + 1);
  }
  return (
    <dialog
      ref={panel}
      className="lesson-viewer"
      aria-labelledby="lesson-viewer-title"
      onClose={onClose}
    >
      <header className="lesson-viewer-header">
        <div className="lesson-viewer-heading">
          <span className="lesson-viewer-symbol">
            <BookOpen size={19} />
          </span>
          <div>
            <p>
              Урок {String(lesson.number).padStart(2, "0")} · {lesson.slides}{" "}
              слайда
            </p>
            <h2 id="lesson-viewer-title" title={lesson.title}>
              {lesson.title}
            </h2>
          </div>
        </div>
        <div className="lesson-viewer-actions">
          <span className="lesson-key-hint">← → слайды</span>
          <a
            className="button secondary small lesson-external"
            href={lesson.source}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Открыть урок в отдельной вкладке"
          >
            <ArrowUpRight size={17} />
            <span>Открыть отдельно</span>
          </a>
          <button
            ref={closeButton}
            className="icon-button lesson-close"
            aria-label="Закрыть урок"
            title="Закрыть урок"
            onClick={() => panel.current?.close()}
          >
            <X size={21} />
          </button>
        </div>
      </header>
      <div className="lesson-viewer-content" aria-busy={loading}>
        <iframe
          key={attempt}
          ref={frame}
          title={"Урок " + lesson.number + ": " + lesson.title}
          src={lesson.source}
          sandbox="allow-scripts allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox"
          allow="fullscreen; clipboard-write"
          allowFullScreen
          referrerPolicy="no-referrer"
          onLoad={() => {
            setLoading(false);
            setFailed(false);
            frame.current?.focus();
          }}
          onError={() => {
            setLoading(false);
            setFailed(true);
          }}
        />
        {loading && (
          <div className="lesson-loading" role="status">
            <Loader2 size={24} className="spin" />
            <p>Открываю урок…</p>
          </div>
        )}
        {failed && (
          <div className="lesson-loading lesson-load-error" role="alert">
            <BookOpen size={28} />
            <h3>Не удалось загрузить урок</h3>
            <p>Попробуй ещё раз или открой его в отдельной вкладке.</p>
            <button className="button primary" onClick={retry}>
              Попробовать ещё раз
            </button>
            <a
              href={lesson.source}
              target="_blank"
              rel="noopener noreferrer"
              className="text-button"
            >
              Открыть отдельно <ArrowUpRight size={16} />
            </a>
          </div>
        )}
      </div>
    </dialog>
  );
}
