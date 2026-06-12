import { Link } from "react-router-dom";

export function Privacy() {
  return (
    <div className="min-h-dvh bg-bg text-fg overflow-y-auto">
      <header className="sticky top-0 z-30 bg-bg/80 backdrop-blur-md border-b border-border">
        <div className="max-w-6xl mx-auto flex items-center justify-between px-6 py-4">
          <Link to="/login" className="text-accent font-bold text-xl tracking-tight">
            Doc2Audioz
          </Link>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-3xl font-bold mb-8">Privacy Policy</h1>
        <p className="text-fg-muted text-sm mb-6">Last updated: June 2026</p>

        <div className="space-y-8 text-sm leading-relaxed text-fg-muted">
          <section>
            <h2 className="text-lg font-semibold text-fg mb-3">Overview</h2>
            <p>
              Doc2Audioz converts your documents into audiobooks. We are committed to
              protecting your privacy and being transparent about how your data is handled.
              The short version: <strong className="text-fg">we don't store your documents or audio files
              on our servers.</strong>
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-fg mb-3">Data We Collect</h2>
            <ul className="list-disc pl-5 space-y-2">
              <li>
                <strong className="text-fg">Account information:</strong> When you sign in with Google,
                we receive your name, email address, and profile picture. This is used solely to
                identify your account.
              </li>
              <li>
                <strong className="text-fg">Usage metadata:</strong> We store lightweight records of
                document processing (titles, page counts, timestamps) for billing and usage tracking.
                This does not include the content of your documents.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-fg mb-3">Google Drive Integration</h2>
            <p>
              Your documents and generated audiobook files are stored in your own Google Drive
              account. We request limited Google Drive permissions to create, read, and manage
              files within a dedicated app folder. We do not access any other files in your
              Drive. You can disconnect your Drive at any time from your account settings,
              and your files remain in your Drive.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-fg mb-3">Document Processing</h2>
            <p>
              When you upload a document, it is temporarily processed in memory to generate
              audio. The document content and generated audio are then saved to your Google
              Drive. We do not retain copies of your documents or audio on our servers after
              processing is complete.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-fg mb-3">Third-Party Services</h2>
            <ul className="list-disc pl-5 space-y-2">
              <li>
                <strong className="text-fg">Google OAuth:</strong> Used for authentication.
                Subject to{" "}
                <a
                  href="https://policies.google.com/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  Google's Privacy Policy
                </a>.
              </li>
              <li>
                <strong className="text-fg">Google Drive API:</strong> Used to store your files
                in your own Drive account.
              </li>
              <li>
                <strong className="text-fg">Stripe:</strong> Payment processing for paid plans.
                We do not store your credit card details. Subject to{" "}
                <a
                  href="https://stripe.com/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  Stripe's Privacy Policy
                </a>.
              </li>
              <li>
                <strong className="text-fg">Text-to-Speech:</strong> Document text is sent to a
                TTS provider to generate audio narration. Text is processed in real-time and
                not retained by the provider after generation.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-fg mb-3">Data Retention</h2>
            <p>
              Account information is retained while your account is active. If you delete your
              account, we remove all associated metadata from our systems. Files in your Google
              Drive are not affected by account deletion — they remain in your Drive under your
              control.
            </p>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-fg mb-3">Your Rights</h2>
            <p>You can:</p>
            <ul className="list-disc pl-5 space-y-2 mt-2">
              <li>Disconnect your Google Drive at any time</li>
              <li>Delete your account and all associated metadata</li>
              <li>Access and export your files directly from your Google Drive</li>
              <li>Revoke our app's access via your Google account settings</li>
            </ul>
          </section>

          <section>
            <h2 className="text-lg font-semibold text-fg mb-3">Contact</h2>
            <p>
              If you have questions about this privacy policy, please contact us at the
              email address associated with your account administrator.
            </p>
          </section>
        </div>
      </main>

      <footer className="max-w-6xl mx-auto px-6 py-10 flex items-center justify-center text-fg-muted text-xs">
        <span>&copy; {new Date().getFullYear()} Doc2Audioz. All rights reserved.</span>
      </footer>
    </div>
  );
}
