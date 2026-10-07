export interface User {
  id: string;
  login: string;
  name: string;
  csrf: string;
}
export interface Project {
  id: string;
  user_id: string;
  folder_id: string | null;
  name: string;
  kind: "web" | "python" | "node";
  revision: number;
  created: number;
  updated: number;
  chatCount: number;
  runState: string | null;
  hosting: boolean;
  slot: number | null;
  url: string | null;
}
export interface Folder {
  id: string;
  name: string;
  created: number;
}
export type ReasoningMode = "off" | "low" | "high" | "max";
export interface Chat {
  reasoning_mode: ReasoningMode;
  id: string;
  name: string;
  name_source?: "default" | "auto" | "manual";
  name_revision?: number;
  name_status?: "idle" | "queued" | "generating" | "ready" | "fallback";
  project_id?: string;
  created: number;
  updated: number;
}
export interface Tool {
  name: string;
  arguments: string;
}
export interface Message {
  id: string;
  role: "user" | "assistant" | "notice";
  text: string;
  tools: Tool[];
  created: number;
}
export interface ChatDetail extends Chat {
  messages: Message[];
  activeRun: { id: string; state: string; partial: string } | null;
}
export interface FileEntry {
  path: string;
  type: "file" | "directory" | "other";
  size: number;
  version: string;
}
export interface TokenUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheOfInputPercent: number;
  inputCredits: number;
  cacheCredits: number;
  outputCredits: number;
}
export interface Budget {
  unit: "credits" | "tokens";
  baseLimitCredits: number;
  extraLimitCredits: number;
  limitCredits: number;
  spentCredits: number;
  reservedCredits: number;
  remainingCredits: number;
  costUsd: number;
  costBasis: string;
  pricingVersion: string;
  usage?: TokenUsage;
  baseLimitTokens: number;
  extraLimitTokens: number;
  reservedTokens: number;
  period: "weekly";
  timezone: "Europe/Moscow";
  periodStartsAt: string;
  resetsAt: string | null;
  limitTokens: number;
  confirmedTokens: number;
  remainingTokens: number;
  maxRemainingCalls: number;
  ready: boolean;
}
let csrf = "";
export function session(user: User) {
  csrf = user.csrf;
}
export async function api<T>(
  url: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const res = await fetch("/api" + url, {
    method,
    credentials: "same-origin",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" ? { "X-CSRF-Token": csrf } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const value = await res.json();
  if (!res.ok) {
    if (res.status === 401 && !url.includes("/auth/login"))
      window.dispatchEvent(new Event("auth-expired"));
    throw Object.assign(
      new Error(value.message ?? "Не удалось выполнить действие."),
      { code: value.error, status: res.status },
    );
  }
  return value as T;
}
export function ago(time: number) {
  const diff = Math.floor((Date.now() - time) / 86400000);
  return diff === 0
    ? "Сегодня"
    : diff === 1
      ? "Вчера"
      : new Intl.DateTimeFormat("ru", {
          day: "numeric",
          month: "short",
        }).format(time);
}
export const kindName = {
  web: "Веб-проект",
  python: "Python",
  node: "JavaScript",
};
