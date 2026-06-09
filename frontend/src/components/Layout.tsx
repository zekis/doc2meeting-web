import { type ReactNode } from "react";
import Icon from "@mdi/react";
import {
  mdiBookOpenPageVariant,
  mdiCloudUploadOutline,
  mdiPlayCircleOutline,
  mdiCogOutline,
  mdiLogout,
} from "@mdi/js";
import { useAuth } from "../auth/AuthContext";

interface LayoutProps {
  children: ReactNode;
  activeTab?: "library" | "upload" | "player" | "settings";
  onNavigate?: (tab: "library" | "upload" | "player" | "settings") => void;
}

const NAV_ITEMS = [
  { key: "library" as const, icon: mdiBookOpenPageVariant, label: "Library" },
  { key: "upload" as const, icon: mdiCloudUploadOutline, label: "Upload" },
  { key: "player" as const, icon: mdiPlayCircleOutline, label: "Player" },
  { key: "settings" as const, icon: mdiCogOutline, label: "Settings" },
];

export function Layout({ children, activeTab = "library", onNavigate }: LayoutProps) {
  const { user, logout } = useAuth();

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
          doc2meeting
        </span>

        {/* Desktop nav (>1024px) */}
        <nav className="hidden laptop:flex items-center gap-1 ml-6">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              onClick={() => onNavigate?.(item.key)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-btn text-sm font-medium transition-colors
                ${
                  activeTab === item.key
                    ? "bg-accent/15 text-accent"
                    : "text-fg-muted hover:text-fg hover:bg-surface-elevated"
                }`}
            >
              <Icon path={item.icon} size={0.7} />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-2 ml-auto">
          {user && (
            <span className="hidden phone:inline text-fg-muted text-sm truncate max-w-[120px]">
              {user.name}
            </span>
          )}
          <button
            onClick={logout}
            className="hidden laptop:flex items-center gap-1 text-fg-muted hover:text-fg text-sm px-2 py-1 rounded-btn transition-colors"
            title="Sign out"
          >
            <Icon path={mdiLogout} size={0.7} />
          </button>
          <div
            className="w-8 h-8 rounded-full bg-accent/20 text-accent text-xs font-semibold flex items-center justify-center shrink-0"
            title={user?.name ?? "User"}
          >
            {initials}
          </div>
        </div>
      </header>

      {/* ---- Tablet side rail (768-1024px) ---- */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        <nav className="hidden tablet:flex laptop:hidden flex-col items-center gap-1 py-3 px-1.5 bg-surface border-r border-border w-16 shrink-0">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              onClick={() => onNavigate?.(item.key)}
              className={`flex flex-col items-center gap-0.5 w-full py-2 rounded-btn text-[0.65rem] font-medium transition-colors
                ${
                  activeTab === item.key
                    ? "bg-accent/15 text-accent"
                    : "text-fg-muted hover:text-fg hover:bg-surface-elevated"
                }`}
              title={item.label}
            >
              <Icon path={item.icon} size={0.85} />
              <span>{item.label}</span>
            </button>
          ))}
          <div className="mt-auto">
            <button
              onClick={logout}
              className="flex flex-col items-center gap-0.5 w-full py-2 rounded-btn text-[0.65rem] text-fg-muted hover:text-fg transition-colors"
              title="Sign out"
            >
              <Icon path={mdiLogout} size={0.85} />
              <span>Logout</span>
            </button>
          </div>
        </nav>

        {/* ---- Content area ---- */}
        <main className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          {children}
        </main>
      </div>

      {/* ---- Bottom nav (mobile, <768px) ---- */}
      <nav className="flex tablet:hidden items-center justify-around bg-surface border-t border-border py-1.5 px-2 shrink-0 safe-area-bottom">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            onClick={() => onNavigate?.(item.key)}
            className={`flex flex-col items-center gap-0.5 py-1 px-3 rounded-btn text-[0.65rem] font-medium transition-colors
              ${
                activeTab === item.key
                  ? "text-accent"
                  : "text-fg-muted active:text-fg"
              }`}
          >
            <Icon path={item.icon} size={0.85} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
