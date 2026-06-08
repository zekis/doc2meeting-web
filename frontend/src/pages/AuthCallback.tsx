import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth, type AuthUser } from "../auth/AuthContext";

/**
 * Handles the OAuth callback redirect.
 * Backend redirects here with tokens in the URL fragment:
 *   /auth/callback#access=...&refresh=...&user=...
 */
export function AuthCallback() {
  const { login, user } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    try {
      const hash = window.location.hash.slice(1);
      const params = new URLSearchParams(hash);
      const accessToken = params.get("access");
      const refreshToken = params.get("refresh");
      const userStr = params.get("user");

      if (!accessToken || !refreshToken || !userStr) {
        setError("Missing authentication data in callback URL");
        return;
      }

      const parsedUser: AuthUser = JSON.parse(decodeURIComponent(userStr));
      login(accessToken, refreshToken, parsedUser);
      setDone(true);
    } catch (e) {
      setError(`Authentication failed: ${(e as Error).message}`);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh", flexDirection: "column", gap: "1rem" }}>
        <p style={{ color: "#c00" }}>{error}</p>
        <a href="/login" style={{ color: "#4285F4" }}>Back to login</a>
      </div>
    );
  }

  if (done || user) {
    return <Navigate to="/" replace />;
  }

  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh" }}>
      Signing in...
    </div>
  );
}
