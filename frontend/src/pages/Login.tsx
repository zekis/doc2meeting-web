import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import Icon from "@mdi/react";
import {
  mdiCloudUploadOutline,
  mdiHeadphones,
  mdiGoogleDrive,
  mdiApi,
  mdiCheckCircle,
  mdiBookOpenPageVariantOutline,
  mdiRocketLaunchOutline,
  mdiShieldCheckOutline,
  mdiSpeedometer,
} from "@mdi/js";

const FEATURES = [
  {
    icon: mdiCloudUploadOutline,
    title: "Drag & Drop Upload",
    desc: "Upload Word, Markdown, or PDF documents instantly. Or forward docs via email.",
  },
  {
    icon: mdiHeadphones,
    title: "Listen Anywhere",
    desc: "Turn any document into a narrated audiobook — listen on the train, walking, at the gym.",
  },
  {
    icon: mdiGoogleDrive,
    title: "Google Drive Storage",
    desc: "Your documents and audio are stored in your own Google Drive — you keep full control.",
  },
  {
    icon: mdiApi,
    title: "Developer API",
    desc: "Integrate document-to-audio into your workflow. Send docs via API, receive audio via Telegram.",
  },
];

const TIERS = [
  {
    name: "Free",
    price: "$0",
    period: "forever",
    accent: false,
    features: [
      "3 documents per month",
      "Up to 10 pages per document",
      "Natural voice narration",
      "Audio playback with speed control",
      "Google Drive storage",
    ],
    cta: "Get Started",
  },
  {
    name: "Pro",
    price: "$15",
    period: "/month",
    accent: true,
    badge: "Popular",
    features: [
      "50 documents per month",
      "Unlimited pages per document",
      "Priority processing",
      "Export notes & annotations",
      "Email-to-audio forwarding",
      "Voice comments on paragraphs",
    ],
    cta: "Start Free Trial",
  },
  {
    name: "API",
    price: "$30",
    period: "/month + usage",
    accent: false,
    features: [
      "Full REST API access",
      "Webhook notifications",
      "Telegram integration",
      "Bulk document processing",
      "Usage-based metering",
      "Everything in Pro",
    ],
    cta: "Get API Access",
  },
];

export function Login() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-dvh bg-bg text-fg">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <span className="text-fg-muted text-sm">Loading...</span>
        </div>
      </div>
    );
  }

  if (user) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="min-h-dvh bg-bg text-fg overflow-y-auto">
      {/* ---- Navigation ---- */}
      <header className="sticky top-0 z-30 bg-bg/80 backdrop-blur-md border-b border-border">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-6 py-4">
          <span className="text-accent font-bold text-xl tracking-tight">
            doc2meeting
          </span>
          <a
            href="/api/auth/google/login"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-btn bg-accent text-accent-fg text-sm font-semibold hover:opacity-90 transition-opacity"
          >
            Sign in with Google
          </a>
        </div>
      </header>

      {/* ---- Hero ---- */}
      <section className="max-w-4xl mx-auto px-6 pt-20 pb-16 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-pill bg-accent/10 text-accent text-xs font-medium mb-6">
          <Icon path={mdiBookOpenPageVariantOutline} size={0.55} />
          Document to Audiobook
        </div>
        <h1 className="text-4xl phone:text-5xl font-bold leading-tight mb-6">
          Turn documents into
          <br />
          <span className="text-accent">audiobooks instantly</span>
        </h1>
        <p className="text-fg-muted text-lg max-w-2xl mx-auto mb-10 leading-relaxed">
          Upload any document and get a natural-sounding audiobook you can listen to
          on your commute, at the gym, or on a walk. Turn reading into listening.
        </p>
        <div className="flex flex-col phone:flex-row items-center justify-center gap-4">
          <a
            href="/api/auth/google/login"
            className="inline-flex items-center gap-2.5 px-6 py-3 rounded-btn bg-accent text-accent-fg font-semibold text-base shadow-lg shadow-accent/20 hover:opacity-90 transition-opacity"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Get Started Free
          </a>
          <span className="text-fg-muted text-sm">No credit card required</span>
        </div>
      </section>

      {/* ---- How it works ---- */}
      <section className="max-w-5xl mx-auto px-6 py-16">
        <h2 className="text-2xl font-bold text-center mb-4">How it works</h2>
        <p className="text-fg-muted text-center mb-12 max-w-xl mx-auto">
          Three steps from document to audiobook
        </p>
        <div className="grid grid-cols-1 tablet:grid-cols-3 gap-8">
          {[
            { step: "1", title: "Upload", desc: "Drag & drop your Word, PDF, or Markdown file" },
            { step: "2", title: "Convert", desc: "Your document is converted into natural-sounding audio" },
            { step: "3", title: "Listen", desc: "Play your audiobook anywhere — phone, desktop, car" },
          ].map((s) => (
            <div key={s.step} className="text-center">
              <div className="w-12 h-12 rounded-full bg-accent/15 text-accent font-bold text-lg flex items-center justify-center mx-auto mb-4">
                {s.step}
              </div>
              <h3 className="font-semibold text-lg mb-2">{s.title}</h3>
              <p className="text-fg-muted text-sm">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---- Features ---- */}
      <section className="bg-surface border-y border-border">
        <div className="max-w-5xl mx-auto px-6 py-16">
          <h2 className="text-2xl font-bold text-center mb-12">
            Everything you need
          </h2>
          <div className="grid grid-cols-1 tablet:grid-cols-2 gap-8">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="flex gap-4 p-5 rounded-card bg-surface-elevated border border-border"
              >
                <div className="shrink-0 w-10 h-10 rounded-btn bg-accent/15 text-accent flex items-center justify-center">
                  <Icon path={f.icon} size={0.85} />
                </div>
                <div>
                  <h3 className="font-semibold mb-1">{f.title}</h3>
                  <p className="text-fg-muted text-sm leading-relaxed">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Pricing ---- */}
      <section className="max-w-5xl mx-auto px-6 py-20">
        <h2 className="text-2xl font-bold text-center mb-4">
          Simple, transparent pricing
        </h2>
        <p className="text-fg-muted text-center mb-12 max-w-xl mx-auto">
          Start free. Upgrade when you need more.
        </p>
        <div className="grid grid-cols-1 tablet:grid-cols-3 gap-6 max-w-4xl mx-auto">
          {TIERS.map((tier) => (
            <div
              key={tier.name}
              className={`relative flex flex-col rounded-card border p-6 ${
                tier.accent
                  ? "border-accent bg-accent/5 shadow-lg shadow-accent/10"
                  : "border-border bg-surface"
              }`}
            >
              {tier.badge && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-pill bg-accent text-accent-fg text-xs font-semibold">
                  {tier.badge}
                </span>
              )}
              <h3 className="font-semibold text-lg mb-1">{tier.name}</h3>
              <div className="flex items-baseline gap-1 mb-5">
                <span className="text-3xl font-bold">{tier.price}</span>
                <span className="text-fg-muted text-sm">{tier.period}</span>
              </div>
              <ul className="flex-1 space-y-3 mb-6">
                {tier.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-sm">
                    <Icon
                      path={mdiCheckCircle}
                      size={0.65}
                      className={tier.accent ? "text-accent shrink-0 mt-0.5" : "text-ok shrink-0 mt-0.5"}
                    />
                    <span className="text-fg-muted">{f}</span>
                  </li>
                ))}
              </ul>
              <a
                href="/api/auth/google/login"
                className={`block text-center py-2.5 rounded-btn text-sm font-semibold transition-opacity hover:opacity-90 ${
                  tier.accent
                    ? "bg-accent text-accent-fg"
                    : "bg-surface-elevated text-fg border border-border"
                }`}
              >
                {tier.cta}
              </a>
            </div>
          ))}
        </div>
        <p className="text-center text-fg-muted text-xs mt-6">
          Team plan ($25/user/mo) coming soon — shared document libraries
        </p>
      </section>

      {/* ---- Trust / social proof ---- */}
      <section className="bg-surface border-y border-border">
        <div className="max-w-4xl mx-auto px-6 py-16 text-center">
          <div className="flex flex-col tablet:flex-row items-center justify-center gap-10">
            <div className="flex items-center gap-3">
              <Icon path={mdiShieldCheckOutline} size={1} className="text-accent" />
              <div className="text-left">
                <div className="font-semibold text-sm">Secure by default</div>
                <div className="text-fg-muted text-xs">Google OAuth, encrypted at rest</div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Icon path={mdiSpeedometer} size={1} className="text-accent" />
              <div className="text-left">
                <div className="font-semibold text-sm">Fast conversion</div>
                <div className="text-fg-muted text-xs">Natural TTS narration in minutes</div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Icon path={mdiGoogleDrive} size={1} className="text-accent" />
              <div className="text-left">
                <div className="font-semibold text-sm">Your data, your Drive</div>
                <div className="text-fg-muted text-xs">Files stored in your Google Drive</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---- Footer ---- */}
      <footer className="max-w-6xl mx-auto px-6 py-10 flex flex-col tablet:flex-row items-center justify-between gap-4 text-fg-muted text-xs">
        <span className="text-accent font-bold text-sm">doc2meeting</span>
        <span>&copy; {new Date().getFullYear()} doc2meeting. All rights reserved.</span>
      </footer>
    </div>
  );
}
