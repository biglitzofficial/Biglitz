import { currentIdToken } from "./firebase";

const BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function send(method: string, path: string, body?: unknown, auth = true): Promise<Response> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) {
    const token = await currentIdToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  } catch {
    throw new ApiError(0, "NETWORK", "No connection. Check your internet and try again.");
  }
  if (!res.ok) {
    let code = "ERROR";
    let message = "Something went wrong. Please try again.";
    try {
      const j = (await res.json()) as { code?: string; message?: string };
      code = j.code ?? code;
      message = j.message ?? message;
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, code, message);
  }
  return res;
}

/** Screen data cache (stale-while-revalidate): screens render the last result instantly, then refresh. Cleared on any write or sign-out. */
export const screenCache = new Map<string, unknown>();
export const clearScreenCache = (): void => screenCache.clear();

export async function api<T>(method: "GET" | "POST" | "PUT" | "PATCH", path: string, body?: unknown, auth = true): Promise<T> {
  if (method !== "GET") clearScreenCache();
  const res = await send(method, path, body, auth);
  return (await res.json()) as T;
}
export const get = <T>(path: string, params?: Record<string, string | undefined>): Promise<T> => {
  const qs = params ? new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString() : "";
  return api<T>("GET", qs ? `${path}?${qs}` : path);
};
export const post = <T>(path: string, body?: unknown): Promise<T> => api<T>("POST", path, body ?? {});
export const put = <T>(path: string, body: unknown): Promise<T> => api<T>("PUT", path, body);
export const patch = <T>(path: string, body: unknown): Promise<T> => api<T>("PATCH", path, body);

/** Downloads an authenticated file (e.g. the bank transfer CSV). */
export async function download(path: string, fileName: string): Promise<void> {
  const res = await send("GET", path);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/** Uploads a blob to a backend-issued signed URL. */
export async function uploadToSignedUrl(url: string, blob: Blob, contentType: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { method: "PUT", headers: { "Content-Type": contentType }, body: blob });
  } catch {
    throw new ApiError(0, "UPLOAD_FAILED", "Upload failed. Check your internet and try again.");
  }
  if (!res.ok) throw new ApiError(res.status, "UPLOAD_FAILED", "Upload failed. Please try again.");
}
