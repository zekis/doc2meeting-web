import { useCallback, useEffect, useState } from "react";
import {
  adminApi,
  type AdminUser,
  type AdminStats,
  type AdminRevenue,
  type AdminHealth,
} from "../api";

type Tab = "overview" | "users" | "health";

export function AdminDashboard({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<Tab>("overview");

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <div className="flex items-center gap-3 mb-6">
        <button onClick={onBack} className="text-fg-muted hover:text-fg text-sm">
          &larr; Back
        </button>
        <h1 className="text-xl font-bold text-fg">Admin Dashboard</h1>
      </div>

      <div className="flex gap-1 mb-6 border-b border-border">
        {(["overview", "users", "health"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? "border-accent text-accent"
                : "border-transparent text-fg-muted hover:text-fg"
            }`}
          >
            {t === "overview" ? "Overview" : t === "users" ? "Users" : "System Health"}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab />}
      {tab === "users" && <UsersTab />}
      {tab === "health" && <HealthTab />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview Tab — stats + revenue
// ---------------------------------------------------------------------------

function OverviewTab() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [revenue, setRevenue] = useState<AdminRevenue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [s, r] = await Promise.all([adminApi.getStats(), adminApi.getRevenue()]);
        setStats(s);
        setRevenue(r);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <p className="text-fg-muted">Loading...</p>;
  if (error) return <p className="text-bad">{error}</p>;

  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="grid grid-cols-2 tablet:grid-cols-4 gap-4">
        <StatCard label="Total Users" value={stats?.total_users ?? 0} />
        <StatCard label="Documents" value={stats?.total_documents ?? 0} />
        <StatCard label="Pages Processed" value={stats?.total_pages ?? 0} />
        <StatCard label="Audio Minutes" value={stats?.total_audio_minutes ?? 0} />
      </div>

      {/* Revenue */}
      {revenue && (
        <div className="bg-surface rounded-xl border border-border p-5">
          <h2 className="text-lg font-semibold text-fg mb-4">Revenue</h2>
          <div className="grid grid-cols-2 tablet:grid-cols-4 gap-4">
            <StatCard label="MRR" value={revenue.mrr_display} />
            <StatCard label="Active Subs" value={revenue.active_subscriptions} />
            <StatCard label="New (30d)" value={revenue.new_30d} />
            <StatCard label="Canceled (30d)" value={revenue.canceled_30d} />
          </div>
          {revenue.past_due > 0 && (
            <p className="mt-3 text-sm text-warn">
              {revenue.past_due} subscription(s) past due
            </p>
          )}
          <div className="mt-4 flex gap-4 text-sm text-fg-muted">
            {Object.entries(revenue.tier_breakdown).map(([tier, count]) => (
              <span key={tier}>
                {tier}: <strong className="text-fg">{count}</strong>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Usage chart (simple table for now) */}
      {stats?.by_period && stats.by_period.length > 0 && (
        <div className="bg-surface rounded-xl border border-border p-5">
          <h2 className="text-lg font-semibold text-fg mb-4">Usage (Last 30 Days)</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-fg-muted text-left">
                  <th className="py-2 pr-4">Date</th>
                  <th className="py-2 pr-4">Docs</th>
                  <th className="py-2">Pages</th>
                </tr>
              </thead>
              <tbody>
                {stats.by_period.slice(-14).map((row) => (
                  <tr key={row.date} className="border-b border-border/50">
                    <td className="py-1.5 pr-4 text-fg-muted">{row.date}</td>
                    <td className="py-1.5 pr-4">{row.docs}</td>
                    <td className="py-1.5">{row.pages}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Users Tab
// ---------------------------------------------------------------------------

function UsersTab() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi.listUsers({
        q: search || undefined,
        tier: tierFilter || undefined,
        page,
        page_size: 25,
      });
      setUsers(res.users);
      setTotal(res.total);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [search, tierFilter, page]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const handleSuspend = async (userId: string, suspend: boolean) => {
    try {
      await adminApi.suspendUser(userId, suspend);
      loadUsers();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleTierChange = async (userId: string, tier: string) => {
    try {
      await adminApi.updateTier(userId, tier);
      loadUsers();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const totalPages = Math.ceil(total / 25);

  return (
    <div className="space-y-4">
      {/* Search / filter bar */}
      <div className="flex flex-col phone:flex-row gap-3">
        <input
          type="text"
          placeholder="Search by name or email..."
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          className="flex-1 px-3 py-2 rounded-btn bg-bg border border-border text-fg text-sm focus:border-accent focus:outline-none"
        />
        <select
          value={tierFilter}
          onChange={(e) => { setTierFilter(e.target.value); setPage(1); }}
          className="px-3 py-2 rounded-btn bg-bg border border-border text-fg text-sm"
        >
          <option value="">All tiers</option>
          <option value="free">Free</option>
          <option value="pro">Pro</option>
          <option value="api">API</option>
          <option value="team">Team</option>
        </select>
      </div>

      {error && <p className="text-bad text-sm">{error}</p>}

      {/* Users table */}
      <div className="bg-surface rounded-xl border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-fg-muted text-left">
              <th className="py-2.5 px-4">User</th>
              <th className="py-2.5 px-4">Tier</th>
              <th className="py-2.5 px-4">Docs</th>
              <th className="py-2.5 px-4">Reviews</th>
              <th className="py-2.5 px-4">Joined</th>
              <th className="py-2.5 px-4">Status</th>
              <th className="py-2.5 px-4">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-fg-muted">
                  Loading...
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-fg-muted">
                  No users found
                </td>
              </tr>
            ) : (
              users.map((u) => (
                <tr key={u.id} className="border-b border-border/50 hover:bg-surface-elevated/50">
                  <td className="py-2.5 px-4">
                    <div>
                      <span className="font-medium text-fg">{u.name}</span>
                      {u.is_admin && (
                        <span className="ml-1.5 text-[0.65rem] font-semibold bg-accent/15 text-accent px-1.5 py-0.5 rounded">
                          ADMIN
                        </span>
                      )}
                    </div>
                    <div className="text-fg-muted text-xs">{u.email}</div>
                  </td>
                  <td className="py-2.5 px-4">
                    <select
                      value={u.tier}
                      onChange={(e) => handleTierChange(u.id, e.target.value)}
                      className="text-xs font-semibold px-2 py-1 rounded bg-bg border border-border text-fg cursor-pointer"
                    >
                      <option value="free">free</option>
                      <option value="pro">pro</option>
                      <option value="api">api</option>
                      <option value="team">team</option>
                    </select>
                  </td>
                  <td className="py-2.5 px-4">{u.doc_count}</td>
                  <td className="py-2.5 px-4">{u.review_count}</td>
                  <td className="py-2.5 px-4 text-fg-muted text-xs">
                    {new Date(u.created_at).toLocaleDateString()}
                  </td>
                  <td className="py-2.5 px-4">
                    {u.suspended_at ? (
                      <span className="text-bad text-xs font-medium">Suspended</span>
                    ) : (
                      <span className="text-good text-xs font-medium">Active</span>
                    )}
                  </td>
                  <td className="py-2.5 px-4">
                    {!u.is_admin && (
                      <button
                        onClick={() => handleSuspend(u.id, !u.suspended_at)}
                        className={`text-xs px-2.5 py-1 rounded-btn font-medium ${
                          u.suspended_at
                            ? "bg-good/10 text-good hover:bg-good/20"
                            : "bg-bad/10 text-bad hover:bg-bad/20"
                        }`}
                      >
                        {u.suspended_at ? "Unsuspend" : "Suspend"}
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-fg-muted">
            {total} user{total !== 1 ? "s" : ""} total
          </span>
          <div className="flex gap-2">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="px-3 py-1 rounded-btn bg-surface border border-border text-fg-muted disabled:opacity-50"
            >
              Prev
            </button>
            <span className="px-2 py-1 text-fg-muted">
              {page} / {totalPages}
            </span>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="px-3 py-1 rounded-btn bg-surface border border-border text-fg-muted disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Health Tab
// ---------------------------------------------------------------------------

function HealthTab() {
  const [health, setHealth] = useState<AdminHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setHealth(await adminApi.getHealth());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (loading) return <p className="text-fg-muted">Loading...</p>;
  if (error) return <p className="text-bad">{error}</p>;
  if (!health) return null;

  const statusColor =
    health.status === "ok" ? "text-good" : health.status === "degraded" ? "text-warn" : "text-bad";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className={`text-2xl font-bold ${statusColor}`}>
            {health.status === "ok" ? "Healthy" : health.status === "degraded" ? "Degraded" : "Down"}
          </span>
          <span className="text-xs text-fg-muted">
            {new Date(health.timestamp).toLocaleString()}
          </span>
        </div>
        <button
          onClick={refresh}
          className="text-sm px-3 py-1.5 rounded-btn bg-surface border border-border text-fg-muted hover:text-fg"
        >
          Refresh
        </button>
      </div>

      <div className="grid gap-4">
        {Object.entries(health.services).map(([name, svc]) => {
          const color = svc.status === "ok" ? "border-good/30 bg-good/5" :
                        svc.status === "error" ? "border-bad/30 bg-bad/5" :
                        "border-border bg-surface";
          const statusText = svc.status === "ok" ? "OK" :
                            svc.status === "error" ? "Error" :
                            svc.status === "not_configured" ? "Not Configured" :
                            svc.status;
          const sColor = svc.status === "ok" ? "text-good" :
                         svc.status === "error" ? "text-bad" : "text-fg-muted";

          return (
            <div key={name} className={`rounded-xl border p-4 ${color}`}>
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-medium text-fg capitalize">{name.replace(/_/g, " ")}</h3>
                <span className={`text-sm font-semibold ${sColor}`}>{statusText}</span>
              </div>
              {Object.entries(svc)
                .filter(([k]) => k !== "status")
                .map(([k, v]) => (
                  <p key={k} className="text-xs text-fg-muted">
                    {k.replace(/_/g, " ")}: <span className="text-fg">{String(v)}</span>
                  </p>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-surface rounded-xl border border-border p-4">
      <p className="text-xs text-fg-muted mb-1">{label}</p>
      <p className="text-2xl font-bold text-fg">{value}</p>
    </div>
  );
}

function TierBadge({ tier }: { tier: string }) {
  const colors: Record<string, string> = {
    free: "bg-fg-muted/10 text-fg-muted",
    pro: "bg-accent/10 text-accent",
    api: "bg-warn/10 text-warn",
    team: "bg-good/10 text-good",
  };
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded ${colors[tier] ?? colors.free}`}>
      {tier}
    </span>
  );
}
