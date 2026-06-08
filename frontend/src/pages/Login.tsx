import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export function Login() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100vh" }}>
        Loading...
      </div>
    );
  }

  if (user) {
    return <Navigate to="/" replace />;
  }

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        height: "100vh",
        background: "var(--bg-primary, #f5f5f5)",
      }}
    >
      <div
        style={{
          background: "var(--bg-card, #fff)",
          borderRadius: 12,
          padding: "3rem 2.5rem",
          boxShadow: "0 2px 16px rgba(0,0,0,0.08)",
          textAlign: "center",
          maxWidth: 380,
          width: "100%",
        }}
      >
        <h1 style={{ marginBottom: "0.5rem", fontSize: "1.5rem" }}>doc2meeting</h1>
        <p style={{ color: "#666", marginBottom: "2rem", fontSize: "0.9rem" }}>
          Sign in to start reviewing documents
        </p>
        <a
          href="/api/auth/google/login"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 10,
            padding: "0.7rem 1.5rem",
            background: "#4285F4",
            color: "#fff",
            borderRadius: 6,
            textDecoration: "none",
            fontSize: "0.95rem",
            fontWeight: 500,
          }}
        >
          Sign in with Google
        </a>
      </div>
    </div>
  );
}
