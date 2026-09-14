// Typed client for the Knowledge Desk API. The bearer token lives in
// localStorage; every call attaches it. In production the API is same-origin
// (empty base); in dev, point VITE_API_BASE at the backend (e.g. :8000).

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";
const TOKEN_KEY = "kd_token";

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  status: number;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers as object) };
  if (opts.body) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const resp = await fetch(BASE + path, { ...opts, headers });
  if (resp.status === 204) return undefined as T;
  const text = await resp.text();
  const body = text ? JSON.parse(text) : null;
  if (!resp.ok) {
    const detail = body?.detail ?? `request failed (${resp.status})`;
    throw new ApiError(resp.status, typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return body as T;
}

export const changePassword = (current_password: string, new_password: string) =>
  req<void>("/me/password", {
    method: "POST",
    body: JSON.stringify({ current_password, new_password }),
  });

export const PAGE_SIZE = 25;

export type Page<T> = { items: T[]; total: number };

/** GET one page of a listing, reading the total from the X-Total-Count header.
 *  The body stays a plain array; only paginated endpoints send the header, and
 *  a missing one falls back to the page length so callers still work. */
async function getPage<T>(path: string, offset: number, limit = PAGE_SIZE): Promise<Page<T>> {
  const sep = path.includes("?") ? "&" : "?";
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const resp = await fetch(`${BASE}${path}${sep}limit=${limit}&offset=${offset}`, { headers });
  const text = await resp.text();
  const body = text ? JSON.parse(text) : null;
  if (!resp.ok) {
    const detail = body?.detail ?? `request failed (${resp.status})`;
    throw new ApiError(resp.status, typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  const items = body as T[];
  const header = resp.headers.get("X-Total-Count");
  return { items, total: header === null ? items.length : Number(header) };
}

export const api = {
  get: <T>(p: string) => req<T>(p),
  getPage,
  post: <T>(p: string, body?: unknown) => req<T>(p, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(p: string, body?: unknown) => req<T>(p, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  del: <T = void>(p: string) => req<T>(p, { method: "DELETE" }),
};

// --- domain types ---------------------------------------------------------

export type Me = { user_id: string; email: string; org_id: string; role: Role };
export type Role = "owner" | "admin" | "member";
export type TokenResp = { token: string; org_id: string; role: Role };
export type Member = { id: string; email: string; role: Role; created_at: string };
export type Group = { id: string; name: string; created_at: string };
export type GroupMember = { id: string; email: string };
export type DocumentRow = {
  id: string; path: string; source: string; status: string;
  content_hash: string; pii_types: string[]; acl: string[]; updated_at: string; chunk_count: number;
};
export type AuditRow = { action: string; detail: Record<string, unknown>; created_at: string; actor: string | null };
export type Usage = {
  questions: { used: number; cap: number };
  spend: { used_usd: number; budget_usd: number };
  storage: { docs: number; doc_cap: number; bytes: number; byte_cap: number };
  top_queries: { question: string; count: number }[];
};

// --- ask (SSE) ------------------------------------------------------------

export type AskEvent =
  | { type: "meta"; answer_id: string; provider: string }
  | { type: "sources"; sources: { document_id: string; ordinal: number; path: string }[] }
  | { type: "token"; text: string }
  | {
      type: "done";
      usage: { input_tokens: number; output_tokens: number };
      cost_usd: number;
      // Deterministic checks on the finished answer. Detectors, not a gate: the
      // tokens have already streamed by the time these arrive.
      warnings?: { code: string; detail: string }[];
    }
  | { type: "error"; message: string };

export async function askStream(
  question: string,
  onEvent: (e: AskEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const token = getToken();
  const resp = await fetch(BASE + "/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ question }),
    signal,
  });
  if (resp.status === 429) throw new ApiError(429, "rate limit exceeded, please slow down");
  if (!resp.ok || !resp.body) throw new ApiError(resp.status, "failed to start answer stream");

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data: "));
      if (line) onEvent(JSON.parse(line.slice(6)) as AskEvent);
    }
  }
}
