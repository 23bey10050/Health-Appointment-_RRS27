const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

export function apiBaseUrl(): string {
  return API_BASE_URL;
}

const ACCESS_KEY = "clinic.access_token";
const REFRESH_KEY = "clinic.refresh_token";

export function getTokens() {
  return {
    accessToken: localStorage.getItem(ACCESS_KEY),
    refreshToken: localStorage.getItem(REFRESH_KEY),
  };
}

export function setTokens(accessToken: string, refreshToken: string) {
  localStorage.setItem(ACCESS_KEY, accessToken);
  localStorage.setItem(REFRESH_KEY, refreshToken);
}

export function clearTokens() {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function parseErrorBody(res: Response): Promise<{ message: string; code?: string }> {
  try {
    const body = await res.json();
    return { message: body.message ?? res.statusText, code: body.code };
  } catch {
    return { message: res.statusText };
  }
}

let refreshPromise: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  const { refreshToken } = getTokens();
  if (!refreshToken) return false;

  if (!refreshPromise) {
    refreshPromise = fetch(`${API_BASE_URL}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
      .then(async (res) => {
        if (!res.ok) return false;
        const body = await res.json();
        setTokens(body.access_token, body.refresh_token);
        return true;
      })
      .catch(() => false)
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit & { skipAuth?: boolean } = {}
): Promise<T> {
  const { skipAuth, ...init } = options;
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");

  if (!skipAuth) {
    const { accessToken } = getTokens();
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  }

  let res = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });

  if (res.status === 401 && !skipAuth) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      const { accessToken } = getTokens();
      headers.set("Authorization", `Bearer ${accessToken}`);
      res = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
    }
  }

  if (!res.ok) {
    const { message, code } = await parseErrorBody(res);
    throw new ApiError(res.status, message, code);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
