import { type ReactNode, useState, useRef, useEffect } from "react";
import Icon from "@mdi/react";
import {
  mdiCogOutline,
  mdiLogout,
  mdiShieldAccountOutline,
  mdiAccountCircleOutline,
} from "@mdi/js";
import { useAuth } from "../auth/AuthContext";

export type NavTab = "library" | "upload" | "player" | "settings" | "admin" | "account";

interface LayoutProps {
  children: ReactNode;
  onNavigate?: (tab: NavTab) => void;
}

export function Layout({ children, onNavigate }: LayoutProps) {
  const { user, logout } = useAuth();
  const isAdmin = user?.is_admin ?? false;

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  const initials = user?.name
    ? user.name
        .split(" ")
        .map((w) => w[0])
        .join("")
        .slice(0, 2)
        .toUpperCase()
    : "?";

  return (
    <div className="flex flex-col h-dvh bg-bg text-fg overflow-hidden">
      {/* ---- Top bar ---- */}
      <header className="flex items-center gap-3 px-4 py-2.5 bg-surface border-b border-border min-h-[3rem] shrink-0">
        <span className="text-accent font-bold text-lg tracking-tight select-none">
          Doc2Audioz
        </span>

        <div className="flex items-center gap-2 ml-auto">
          {user && (
            <span className="hidden phone:inline flex items-center gap-1.5 text-fg-muted text-sm truncate max-w-[200px]">
              {user.name}
              <span className="inline-flex px-1.5 py-0.5 rounded-pill bg-accent/15 text-accent text-[0.6rem] font-bold uppercase tracking-wide leading-none">
                {user.tier}
              </span>
            </span>
          )}
          {/* User badge with dropdown */}
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="w-8 h-8 rounded-full bg-accent/20 text-accent text-xs font-semibold flex items-center justify-center shrink-0 hover:bg-accent/30 transition-colors cursor-pointer"
              title={user?.name ?? "User"}
            >
              {initials}
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-44 bg-surface border border-border rounded-card shadow-lg z-50 py-1 overflow-hidden">
                <button
                  onClick={() => { setMenuOpen(false); onNavigate?.("account"); }}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-fg hover:bg-surface-elevated transition-colors"
                >
                  <Icon path={mdiAccountCircleOutline} size={0.7} className="text-fg-muted" />
                  Account
                </button>
                <button
                  onClick={() => { setMenuOpen(false); onNavigate?.("settings"); }}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-fg hover:bg-surface-elevated transition-colors"
                >
                  <Icon path={mdiCogOutline} size={0.7} className="text-fg-muted" />
                  Settings
                </button>
                {isAdmin && (
                  <button
                    onClick={() => { setMenuOpen(false); onNavigate?.("admin"); }}
                    className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-fg hover:bg-surface-elevated transition-colors"
                  >
                    <Icon path={mdiShieldAccountOutline} size={0.7} className="text-fg-muted" />
                    Admin
                  </button>
                )}
                <div className="h-px bg-border my-1" />
                <button
                  onClick={() => { setMenuOpen(false); logout(); }}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-fg-muted hover:text-fg hover:bg-surface-elevated transition-colors"
                >
                  <Icon path={mdiLogout} size={0.7} />
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* ---- Content area ---- */}
      <main className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        {children}
      </main>
    </div>
  );
}
