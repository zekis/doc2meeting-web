import { useEffect, useState } from "react";
import Icon from "@mdi/react";
import {
  mdiArrowLeft,
  mdiCrownOutline,
  mdiRocketLaunchOutline,
  mdiApi,
  mdiOpenInNew,
  mdiChartBar,
  mdiFileDocumentOutline,
  mdiBookOpenPageVariant,
} from "@mdi/js";
import { useAuth } from "../auth/AuthContext";
import { billingApi, type BillingInfo, type UsageInfo } from "../api";

const TIER_CONFIG: Record<string, { label: string; icon: string; color: string; desc: string }> = {
  free: {
    label: "Free",
    icon: mdiBookOpenPageVariant,
    color: "text-fg-muted",
    desc: "3 documents/month, up to 10 pages each",
  },
  pro: {
    label: "Pro",
    icon: mdiCrownOutline,
    color: "text-accent",
    desc: "50 documents/month, unlimited pages",
  },
  api: {
    label: "API",
    icon: mdiApi,
    color: "text-accent",
    desc: "Full API access, unlimited documents & pages",
  },
};

interface AccountPageProps {
  onBack: () => void;
}

export function AccountPage({ onBack }: AccountPageProps) {
  const { user } = useAuth();
  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [b, u] = await Promise.all([billingApi.getBilling(), billingApi.getUsage()]);
        setBilling(b);
        setUsage(u);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const friendlyError = (e: unknown): string => {
    const msg = (e as Error).message ?? String(e);
    if (msg.includes("Stripe not configured") || msg.includes("503"))
      return "Payments are not yet configured. Please contact your administrator to set up Stripe.";
    return msg;
  };

  const handleUpgrade = async (tier: string) => {
    setCheckoutLoading(tier);
    try {
      const { checkout_url } = await billingApi.createCheckout(tier);
      window.location.href = checkout_url;
    } catch (e) {
      setError(friendlyError(e));
      setCheckoutLoading(null);
    }
  };

  const handleManage = async () => {
    setPortalLoading(true);
    try {
      const { portal_url } = await billingApi.getPortalUrl();
      window.location.href = portal_url;
    } catch (e) {
      setError(friendlyError(e));
      setPortalLoading(false);
    }
  };

  const tier = billing?.tier ?? user?.tier ?? "free";
  const tierInfo = TIER_CONFIG[tier] ?? TIER_CONFIG.free;

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={onBack}
          className="p-1.5 rounded-btn hover:bg-surface-elevated transition-colors text-fg-muted hover:text-fg"
        >
          <Icon path={mdiArrowLeft} size={0.85} />
        </button>
        <h1 className="text-xl font-bold">My Account</h1>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-7 h-7 border-2 border-accent border-t-transparent rounded-full animate-spin" />
        </div>
      ) : (
        <div className="space-y-6">
          {error && (
            <div className="px-4 py-2.5 rounded-card bg-bad/10 text-bad text-sm">
              {error}
            </div>
          )}

          {/* Profile card */}
          <div className="rounded-card border border-border bg-surface p-5">
            <div className="flex items-center gap-4 mb-4">
              <div className="w-14 h-14 rounded-full bg-accent/20 text-accent text-lg font-bold flex items-center justify-center shrink-0">
                {user?.name
                  ?.split(" ")
                  .map((w) => w[0])
                  .join("")
                  .slice(0, 2)
                  .toUpperCase() ?? "?"}
              </div>
              <div className="min-w-0">
                <div className="font-semibold text-lg truncate">{user?.name}</div>
                <div className="text-fg-muted text-sm truncate">{user?.email}</div>
              </div>
            </div>
          </div>

          {/* Current plan */}
          <div className="rounded-card border border-border bg-surface p-5">
            <h2 className="text-sm font-semibold text-fg-muted uppercase tracking-wide mb-4">
              Current Plan
            </h2>
            <div className="flex items-start gap-3 mb-4">
              <div className={`shrink-0 mt-0.5 ${tierInfo.color}`}>
                <Icon path={tierInfo.icon} size={1.1} />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-bold text-xl">{tierInfo.label}</span>
                  {billing?.subscription_status && (
                    <span
                      className={`px-2 py-0.5 rounded-pill text-[0.65rem] font-semibold uppercase ${
                        billing.subscription_status === "active"
                          ? "bg-ok/15 text-ok"
                          : billing.subscription_status === "past_due"
                          ? "bg-warn/15 text-warn"
                          : "bg-fg-muted/15 text-fg-muted"
                      }`}
                    >
                      {billing.subscription_status}
                    </span>
                  )}
                </div>
                <p className="text-fg-muted text-sm mt-1">{tierInfo.desc}</p>
                {billing?.current_period_end && (
                  <p className="text-fg-muted text-xs mt-2">
                    Current period ends{" "}
                    {new Date(billing.current_period_end).toLocaleDateString("en-AU", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </p>
                )}
              </div>
            </div>

            {/* Manage subscription button for paid tiers */}
            {billing?.stripe_customer_id && (
              <button
                onClick={handleManage}
                disabled={portalLoading}
                className="flex items-center gap-2 px-4 py-2 rounded-btn bg-surface-elevated border border-border text-sm font-medium hover:text-fg transition-colors disabled:opacity-50"
              >
                <Icon path={mdiOpenInNew} size={0.65} />
                {portalLoading ? "Opening..." : "Manage Subscription"}
              </button>
            )}
          </div>

          {/* Usage */}
          <div className="rounded-card border border-border bg-surface p-5">
            <h2 className="text-sm font-semibold text-fg-muted uppercase tracking-wide mb-4 flex items-center gap-2">
              <Icon path={mdiChartBar} size={0.65} />
              Usage This Period
            </h2>
            <div className="grid grid-cols-2 gap-4">
              <UsageMeter
                icon={mdiFileDocumentOutline}
                label="Documents"
                used={usage?.docs_used ?? billing?.docs_used ?? 0}
                limit={usage?.docs_limit ?? billing?.docs_limit ?? null}
              />
              <UsageMeter
                icon={mdiBookOpenPageVariant}
                label="Pages / doc"
                used={usage?.pages_used ?? billing?.pages_used ?? 0}
                limit={usage?.pages_limit_per_doc ?? billing?.pages_limit_per_doc ?? null}
              />
            </div>
            {usage?.period_start && usage?.period_end && (
              <p className="text-fg-muted text-xs mt-3">
                Period:{" "}
                {new Date(usage.period_start).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
                {" — "}
                {new Date(usage.period_end).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}
              </p>
            )}
          </div>

          {/* Upgrade options (show if not on highest tier) */}
          {tier !== "api" && (
            <div className="rounded-card border border-border bg-surface p-5">
              <h2 className="text-sm font-semibold text-fg-muted uppercase tracking-wide mb-4 flex items-center gap-2">
                <Icon path={mdiRocketLaunchOutline} size={0.65} />
                Upgrade
              </h2>
              <div className="space-y-3">
                {tier === "free" && (
                  <UpgradeCard
                    name="Pro"
                    price="$15/month"
                    features={["50 documents/month", "Unlimited pages", "Priority processing", "Export reviews"]}
                    accent
                    loading={checkoutLoading === "pro"}
                    onUpgrade={() => handleUpgrade("pro")}
                  />
                )}
                {(tier === "free" || tier === "pro") && (
                  <UpgradeCard
                    name="API"
                    price="$30/month + usage"
                    features={["Full REST API", "Webhooks", "Telegram integration", "Everything in Pro"]}
                    accent={tier === "pro"}
                    loading={checkoutLoading === "api"}
                    onUpgrade={() => handleUpgrade("api")}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function UsageMeter({
  icon,
  label,
  used,
  limit,
}: {
  icon: string;
  label: string;
  used: number;
  limit: number | null;
}) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const isHigh = limit ? pct >= 80 : false;

  return (
    <div>
      <div className="flex items-center gap-1.5 text-sm mb-1.5">
        <Icon path={icon} size={0.6} className="text-fg-muted" />
        <span className="text-fg-muted">{label}</span>
      </div>
      <div className="font-bold text-lg">
        {used}
        {limit != null && <span className="text-fg-muted font-normal text-sm"> / {limit}</span>}
        {limit == null && <span className="text-fg-muted font-normal text-sm"> (unlimited)</span>}
      </div>
      {limit != null && (
        <div className="mt-1.5 h-1.5 rounded-full bg-surface-elevated overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${isHigh ? "bg-warn" : "bg-accent"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

function UpgradeCard({
  name,
  price,
  features,
  accent,
  loading,
  onUpgrade,
}: {
  name: string;
  price: string;
  features: string[];
  accent?: boolean;
  loading: boolean;
  onUpgrade: () => void;
}) {
  return (
    <div
      className={`flex flex-col phone:flex-row items-start phone:items-center justify-between gap-4 p-4 rounded-card border ${
        accent ? "border-accent bg-accent/5" : "border-border bg-surface-elevated"
      }`}
    >
      <div>
        <div className="flex items-baseline gap-2 mb-1">
          <span className="font-bold text-lg">{name}</span>
          <span className="text-fg-muted text-sm">{price}</span>
        </div>
        <ul className="text-fg-muted text-xs space-y-0.5">
          {features.map((f) => (
            <li key={f}>• {f}</li>
          ))}
        </ul>
      </div>
      <button
        onClick={onUpgrade}
        disabled={loading}
        className={`shrink-0 px-5 py-2 rounded-btn text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50 ${
          accent
            ? "bg-accent text-accent-fg"
            : "bg-surface border border-border text-fg"
        }`}
      >
        {loading ? "Redirecting..." : `Upgrade to ${name}`}
      </button>
    </div>
  );
}
