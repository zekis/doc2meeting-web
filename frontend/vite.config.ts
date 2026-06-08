import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

// HTTPS in dev so the Media Capture API (mic) works over the Tailscale IP.
// Self-signed cert — the browser will warn once per device; tap through.
// For a properly-signed cert, run `tailscale serve --https 443 5303` instead
// and use the resulting *.ts.net URL.
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    host: true,
    port: 5303,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:8300", secure: false },
      "/audio": { target: "http://127.0.0.1:8300", secure: false },
    },
  },
});
