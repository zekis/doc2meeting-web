import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { RequireAuth } from "./auth/RequireAuth";
import { AudioPlayerProvider } from "./audio";
import { App } from "./App";
import { Login } from "./pages/Login";
import { Privacy } from "./pages/Privacy";
import { AuthCallback } from "./pages/AuthCallback";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <AudioPlayerProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route
              path="/*"
              element={
                <RequireAuth>
                  <App />
                </RequireAuth>
              }
            />
          </Routes>
        </AudioPlayerProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
);
