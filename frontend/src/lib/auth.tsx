import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { apiFetch, clearTokens, getTokens, setTokens } from "@/lib/api";
import type { TokenResponse, UserOut } from "@/lib/types";

interface AuthContextValue {
  user: UserOut | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<UserOut>;
  register: (email: string, password: string, fullName: string, phone?: string) => Promise<UserOut>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserOut | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadCurrentUser() {
    const { accessToken } = getTokens();
    if (!accessToken) {
      setLoading(false);
      return;
    }
    try {
      const me = await apiFetch<UserOut>("/api/v1/auth/me");
      setUser(me);
    } catch {
      clearTokens();
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadCurrentUser();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function login(email: string, password: string) {
    const tokens = await apiFetch<TokenResponse>("/api/v1/auth/login", {
      method: "POST",
      skipAuth: true,
      body: JSON.stringify({ email, password }),
    });
    setTokens(tokens.access_token, tokens.refresh_token);
    const me = await apiFetch<UserOut>("/api/v1/auth/me");
    setUser(me);
    return me;
  }

  async function register(email: string, password: string, fullName: string, phone?: string) {
    const tokens = await apiFetch<TokenResponse>("/api/v1/auth/register", {
      method: "POST",
      skipAuth: true,
      body: JSON.stringify({ email, password, full_name: fullName, phone }),
    });
    setTokens(tokens.access_token, tokens.refresh_token);
    const me = await apiFetch<UserOut>("/api/v1/auth/me");
    setUser(me);
    return me;
  }

  async function logout() {
    const { refreshToken } = getTokens();
    if (refreshToken) {
      try {
        await apiFetch("/api/v1/auth/logout", {
          method: "POST",
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
      } catch {
        // best-effort; clear local state regardless
      }
    }
    clearTokens();
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
