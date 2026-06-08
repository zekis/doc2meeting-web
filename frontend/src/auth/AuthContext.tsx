import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  tier: string;
}

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  refreshToken: string | null;
  loading: boolean;
  login: (access: string, refresh: string, user: AuthUser) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

// Must match the key used by api.ts for getAuthHeaders()
const STORAGE_KEY = "doc2meeting_auth";

interface StoredAuth {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

function readStored(): StoredAuth | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.accessToken && data.refreshToken && data.user) return data;
    return null;
  } catch {
    return null;
  }
}

function writeStored(access: string, refresh: string, user: AuthUser) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ accessToken: access, refreshToken: refresh, user }),
  );
}

function clearStored() {
  localStorage.removeItem(STORAGE_KEY);
}

async function tryRefresh(
  refreshToken: string,
): Promise<{ access_token: string; refresh_token: string } | null> {
  try {
    const r = await fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(atob(parts[1]));
  } catch {
    return null;
  }
}

function isTokenExpired(token: string): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.exp !== "number") return true;
  return payload.exp * 1000 < Date.now() + 30_000;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const login = useCallback((access: string, refresh: string, u: AuthUser) => {
    writeStored(access, refresh, u);
    setAccessToken(access);
    setRefreshToken(refresh);
    setUser(u);
  }, []);

  const logout = useCallback(async () => {
    const stored = readStored();
    if (stored?.refreshToken) {
      fetch("/api/auth/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: stored.refreshToken }),
      }).catch(() => {});
    }
    clearStored();
    setAccessToken(null);
    setRefreshToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    (async () => {
      const stored = readStored();
      if (!stored) {
        setLoading(false);
        return;
      }

      if (!isTokenExpired(stored.accessToken)) {
        setAccessToken(stored.accessToken);
        setRefreshToken(stored.refreshToken);
        setUser(stored.user);
        setLoading(false);
        return;
      }

      // Access expired — try refresh
      const result = await tryRefresh(stored.refreshToken);
      if (result) {
        login(result.access_token, result.refresh_token, stored.user);
      } else {
        clearStored();
      }
      setLoading(false);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <AuthContext.Provider value={{ user, accessToken, refreshToken, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
