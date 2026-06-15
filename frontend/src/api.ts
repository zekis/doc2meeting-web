// Backend API client — same host via Vite proxy in dev, so paths are bare.

export interface FileTreeNode {
  name: string;
  type: "folder" | "file";
  rel_path: string;
  children?: FileTreeNode[];
  size?: number;
  mtime?: number;
}

export interface TreeResponse {
  root: string;
  root_abs: string;
  tree: FileTreeNode;
}

export interface UserCommentData {
  id: number;
  section_idx: number;
  paragraph_idx: number;
  text: string;
  created_at: string;
}

export interface DocumentSummary {
  id: number;
  rel_path: string;
  name: string;
  context_paths: string[];
  last_opened_at: string;
  on_drive?: boolean;
}

export interface DocumentDetail {
  id: number;
  rel_path: string;
  name: string;
  content_hash: string;
  stored_hash: string;
  context_paths: string[];
  section_count: number;
  stale_review_count: number;
  /** Set when the on-disk hash differs from what we last saw — the file was
   * edited outside the app and previously-saved reviews may now mis-align. */
  structure_changed: boolean;
  sections: SectionDetail[];
  /** Sum of OpenAI agent + TTS spend across every review on this doc, in USD. */
  total_cost_usd: number;
}

export interface SectionDetail {
  idx: number;
  level: number;
  title: string;
  body: string;
  paragraphs: string[];
  full_path: string;
  review_count: number;
  reviewed: boolean;
  accepted_count: number;
  rejected_count: number;
  reviews: ReviewDetail[];
}

export type ReviewStatus = "pending" | "accepted" | "rejected";

export interface ReviewDetail {
  id: number;
  document_id: number;
  section_idx: number;
  paragraph_idx: number;
  persona: string;
  comment: string;
  user_comment: string | null;
  /**
   * When the editor agent (Week 2) acts on an accepted critique it writes the
   * proposed replacement here; the paragraph view renders the original with
   * strikethrough above this text, and `save_version` applies it on export.
   */
  proposed_replacement: string | null;
  /**
   * Conversational narrator reply to the reviewer, produced by the responder
   * agent when auto-accept is on. When unset, the boilerplate "Noted." is used.
   */
  narrator_response_text: string | null;
  narrator_audio_url: string | null;
  reviewer_audio_url: string | null;
  response_audio_url: string | null;
  status: ReviewStatus;
  created_at: string;
  resolved_at: string | null;
}

export interface SaveVersionResult {
  saved_rel_path: string;
  saved_at: string;
  size: number;
}

export interface AppSettings {
  narrator_voice: string;
  reviewer_voice: string;
  narrator_instructions: string;
  reviewer_instructions: string;
  responder_instructions: string;
  default_persona: string;
  tts_model: string;
  available_voices: string[];
  available_tts_models: string[];
  available_personas: string[];
}

export interface UploadResult {
  id: number;
  rel_path: string;
  name: string;
  original_name: string;
  size: number;
}

export type AppSettingsPatch = Partial<
  Pick<
    AppSettings,
    | "narrator_voice"
    | "reviewer_voice"
    | "narrator_instructions"
    | "reviewer_instructions"
    | "responder_instructions"
    | "default_persona"
    | "tts_model"
  >
>;

const STORAGE_KEY = "doc2meeting_auth";

function getAuthHeaders(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const { accessToken } = JSON.parse(raw);
      if (accessToken) return { Authorization: `Bearer ${accessToken}` };
    }
  } catch {
    // ignore
  }
  return {};
}

async function jsonOrThrow<T>(r: Response): Promise<T> {
  if (!r.ok) {
    // On 401, clear auth and redirect to login
    if (r.status === 401) {
      localStorage.removeItem(STORAGE_KEY);
      window.location.href = "/login";
      throw new Error("Session expired");
    }
    const detail = await r.text();
    throw new Error(`${r.status} ${r.statusText}: ${detail}`);
  }
  return r.json();
}

async function sendJson<T>(
  method: "POST" | "PATCH",
  url: string,
  body?: Record<string, unknown>
): Promise<T> {
  const headers: Record<string, string> = { ...getAuthHeaders() };
  if (body) headers["Content-Type"] = "application/json";
  return jsonOrThrow(
    await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
  );
}

async function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = { ...getAuthHeaders(), ...(init?.headers as Record<string, string> || {}) };
  return fetch(url, { ...init, headers });
}

export const api = {
  getTree: async (): Promise<TreeResponse> =>
    jsonOrThrow(await authFetch("/api/tree")),

  getFile: async (relPath: string): Promise<string> => {
    const r = await authFetch(`/api/files/${encodeURI(relPath)}`);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.text();
  },

  convertDocx: async (
    relPath: string
  ): Promise<{ saved_rel_path: string; size: number }> =>
    sendJson("POST", "/api/files/convert", { rel_path: relPath }),

  listDocuments: async (): Promise<DocumentSummary[]> =>
    jsonOrThrow(await authFetch("/api/documents")),

  openDocument: async (relPath: string): Promise<DocumentDetail> =>
    sendJson("POST", "/api/documents/open", { rel_path: relPath }),

  deleteDocument: async (id: number): Promise<void> => {
    await jsonOrThrow(await authFetch(`/api/documents/${id}`, { method: "DELETE" }));
  },

  getDocument: async (id: number): Promise<DocumentDetail> =>
    jsonOrThrow(await authFetch(`/api/documents/${id}`)),

  // User voice comments
  listComments: async (docId: number): Promise<UserCommentData[]> =>
    jsonOrThrow(await authFetch(`/api/documents/${docId}/comments`)),

  createComment: async (docId: number, sectionIdx: number, paragraphIdx: number, text: string): Promise<UserCommentData> =>
    sendJson("POST", `/api/documents/${docId}/comments`, { section_idx: sectionIdx, paragraph_idx: paragraphIdx, text }),

  deleteComment: async (docId: number, commentId: number): Promise<void> => {
    await jsonOrThrow(await authFetch(`/api/documents/${docId}/comments/${commentId}`, { method: "DELETE" }));
  },

  exportComments: async (docId: number): Promise<string> => {
    const res = await authFetch(`/api/documents/${docId}/comments/export`);
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    return res.text();
  },

  setContextPaths: async (
    docId: number,
    paths: string[]
  ): Promise<DocumentDetail> =>
    sendJson("PATCH", `/api/documents/${docId}`, { context_paths: paths }),

  saveVersion: async (docId: number): Promise<SaveVersionResult> =>
    sendJson("POST", `/api/documents/${docId}/save_version`),

  saveMarkup: async (
    docId: number
  ): Promise<SaveVersionResult & { review_count: number }> =>
    sendJson("POST", `/api/documents/${docId}/save_markup`),

  getParagraphNarrator: async (
    docId: number,
    sectionIdx: number,
    paragraphIdx: number
  ): Promise<{ narrator_audio_url: string }> =>
    sendJson(
      "POST",
      `/api/documents/${docId}/sections/${sectionIdx}/paragraphs/${paragraphIdx}/narrator`
    ),

  // Staged pipeline: each call is independently idempotent. Used by the
  // player's pump so it can run one segment of work at a time, ahead of the
  // playhead. /reviewer must run before /response.
  stageReviewer: async (
    docId: number,
    sectionIdx: number,
    paragraphIdx: number,
    persona = "skeptical"
  ): Promise<ReviewDetail> =>
    sendJson(
      "POST",
      `/api/documents/${docId}/sections/${sectionIdx}/paragraphs/${paragraphIdx}/reviewer?persona=${encodeURIComponent(persona)}`
    ),

  stageResponse: async (
    docId: number,
    sectionIdx: number,
    paragraphIdx: number
  ): Promise<ReviewDetail> =>
    sendJson(
      "POST",
      `/api/documents/${docId}/sections/${sectionIdx}/paragraphs/${paragraphIdx}/response`
    ),

  transcribe: async (audio: Blob): Promise<{ text: string }> => {
    const form = new FormData();
    const ext =
      audio.type.includes("webm") ? "webm" :
      audio.type.includes("mp4") ? "mp4" :
      audio.type.includes("ogg") ? "ogg" : "bin";
    form.append("audio", audio, `note.${ext}`);
    const r = await authFetch("/api/transcribe", { method: "POST", body: form });
    if (!r.ok) {
      const detail = await r.text();
      throw new Error(`${r.status} ${r.statusText}: ${detail}`);
    }
    return r.json();
  },

  clearParagraphReviews: async (
    docId: number,
    sectionIdx: number,
    paragraphIdx: number
  ): Promise<{ deleted: number }> =>
    sendJson(
      "POST",
      `/api/documents/${docId}/sections/${sectionIdx}/paragraphs/${paragraphIdx}/clear`
    ),

  voiceComment: async (
    docId: number,
    sectionIdx: number,
    paragraphIdx: number,
    audio: Blob
  ): Promise<{ transcript: string; review: ReviewDetail | null }> => {
    const form = new FormData();
    const ext =
      audio.type.includes("webm") ? "webm" :
      audio.type.includes("mp4") ? "mp4" :
      audio.type.includes("ogg") ? "ogg" : "bin";
    form.append("audio", audio, `comment.${ext}`);
    const r = await authFetch(
      `/api/documents/${docId}/sections/${sectionIdx}/paragraphs/${paragraphIdx}/voice_comment`,
      { method: "POST", body: form }
    );
    if (!r.ok) {
      const detail = await r.text();
      throw new Error(`${r.status} ${r.statusText}: ${detail}`);
    }
    return r.json();
  },

  generateParagraphReview: async (
    docId: number,
    sectionIdx: number,
    paragraphIdx: number,
    opts: {
      persona?: string;
      autoAccept?: boolean;
      withResponse?: boolean;
    } = {}
  ): Promise<ReviewDetail> => {
    const persona = opts.persona ?? "skeptical";
    const params = new URLSearchParams({ persona });
    if (opts.autoAccept) params.set("auto_accept", "true");
    if (opts.withResponse) params.set("with_response", "true");
    return sendJson(
      "POST",
      `/api/documents/${docId}/sections/${sectionIdx}/paragraphs/${paragraphIdx}/review?${params.toString()}`
    );
  },

  acceptReview: async (
    reviewId: number,
    userComment?: string
  ): Promise<ReviewDetail> =>
    sendJson("POST", `/api/reviews/${reviewId}/accept`, {
      user_comment: userComment ?? null,
    }),

  rejectReview: async (
    reviewId: number,
    userComment?: string
  ): Promise<ReviewDetail> =>
    sendJson("POST", `/api/reviews/${reviewId}/reject`, {
      user_comment: userComment ?? null,
    }),

  getSettings: async (): Promise<AppSettings> =>
    jsonOrThrow(await authFetch("/api/settings")),

  updateSettings: async (patch: AppSettingsPatch): Promise<AppSettings> =>
    sendJson("PATCH", "/api/settings", patch),

  uploadDocument: async (
    file: File,
    onProgress?: (pct: number) => void
  ): Promise<UploadResult> => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/documents/upload");

      // Set auth header
      const headers = getAuthHeaders();
      for (const [k, v] of Object.entries(headers)) {
        xhr.setRequestHeader(k, v);
      }

      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      });

      xhr.addEventListener("load", () => {
        if (xhr.status === 401) {
          localStorage.removeItem(STORAGE_KEY);
          window.location.href = "/login";
          reject(new Error("Session expired"));
          return;
        }
        if (xhr.status >= 400) {
          // Try to extract a friendly message from structured error responses
          let msg = `Upload failed (${xhr.status})`;
          try {
            const body = JSON.parse(xhr.responseText);
            const detail = typeof body.detail === "object" ? body.detail : body;
            if (detail.error === "page_limit_exceeded") {
              msg = `Document has ${detail.page_count} pages — free tier limit is ${detail.pages_limit}. Upgrade to upload larger documents.`;
            } else if (detail.message) {
              msg = detail.message;
            } else if (typeof body.detail === "string") {
              msg = body.detail;
            }
          } catch {
            // Not JSON — use raw text if short
            if (xhr.responseText.length < 200) msg = xhr.responseText;
          }
          reject(new Error(msg));
          return;
        }
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error("Invalid response"));
        }
      });

      xhr.addEventListener("error", () => reject(new Error("Upload failed")));
      xhr.addEventListener("abort", () => reject(new Error("Upload cancelled")));

      const form = new FormData();
      form.append("file", file);
      xhr.send(form);
    });
  },
};

// ---------------------------------------------------------------------------
// Virtual Meeting API
// ---------------------------------------------------------------------------

export interface MeetingStartResult {
  session_id: string;
  intro_message: string;
  intro_audio_url: string | null;
}

export interface MeetingReply {
  reply: string;
  tool_action: string | null;
  target_section_idx: number | null;
  target_paragraph_idx: number | null;
  audio_url: string | null;
}

export interface MeetingMessageData {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  section_idx: number;
  paragraph_idx: number;
  tool_action: string | null;
  audio_url: string | null;
  created_at: string;
}

export interface MeetingSessionInfo {
  id: string;
  status: string;
  current_section_idx: number;
  current_paragraph_idx: number;
  created_at: string;
}

export interface MeetingResumeResult {
  session_id: string;
  resume_message: string;
  resume_audio_url: string | null;
  current_section_idx: number;
  current_paragraph_idx: number;
}

export const meetingApi = {
  startMeeting: async (docId: number): Promise<MeetingStartResult> =>
    sendJson("POST", `/api/meetings/${docId}/start`),

  getLatestSession: async (docId: number): Promise<{ session: MeetingSessionInfo | null }> =>
    jsonOrThrow(await authFetch(`/api/meetings/${docId}/latest`)),

  resumeMeeting: async (sessionId: string): Promise<MeetingResumeResult> =>
    sendJson("POST", `/api/meetings/${sessionId}/resume`),

  sendMessage: async (
    sessionId: string,
    text: string,
    sectionIdx: number,
    paragraphIdx: number,
  ): Promise<MeetingReply> =>
    sendJson("POST", `/api/meetings/${sessionId}/message`, {
      text,
      section_idx: sectionIdx,
      paragraph_idx: paragraphIdx,
    }),

  /** Stream a message — calls onText immediately when LLM finishes, onAudio when TTS chunks are assembled. */
  sendMessageStream: async (
    sessionId: string,
    text: string,
    sectionIdx: number,
    paragraphIdx: number,
    onText: (reply: MeetingReply) => void,
    onAudio: (audioUrl: string | null) => void,
  ): Promise<void> => {
    const res = await authFetch(`/api/meetings/${sessionId}/message/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, section_idx: sectionIdx, paragraph_idx: paragraphIdx }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const audioChunks: BlobPart[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "text") {
          onText({
            reply: event.reply,
            tool_action: event.tool_action,
            target_section_idx: event.target_section_idx,
            target_paragraph_idx: event.target_paragraph_idx,
            audio_url: null,
          });
        } else if (event.type === "audio_chunk") {
          // Decode base64 chunk and accumulate
          const binary = atob(event.data);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          audioChunks.push(bytes);
        } else if (event.type === "audio_done") {
          // Assemble all chunks into a blob URL for playback
          if (audioChunks.length > 0) {
            const blob = new Blob(audioChunks, { type: "audio/mpeg" });
            onAudio(URL.createObjectURL(blob));
          } else {
            onAudio(null);
          }
        } else if (event.type === "audio") {
          // Legacy fallback (non-streaming endpoints)
          onAudio(event.audio_url);
        }
      }
    }
  },

  getMeetingNotes: async (sessionId: string): Promise<MeetingMessageData[]> =>
    jsonOrThrow(await authFetch(`/api/meetings/${sessionId}/notes`)),

  endMeeting: async (sessionId: string): Promise<{ status: string }> =>
    sendJson("POST", `/api/meetings/${sessionId}/end`),

  exportMeetingNotes: async (sessionId: string): Promise<string> => {
    const res = await authFetch(`/api/meetings/${sessionId}/notes/export`);
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);
    return res.text();
  },
};

// ---------------------------------------------------------------------------
// Billing API
// ---------------------------------------------------------------------------

export interface BillingInfo {
  tier: string;
  stripe_customer_id: string | null;
  subscription_status: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  docs_used: number;
  docs_limit: number | null;
  pages_used: number;
  pages_limit_per_doc: number | null;
}

export interface UsageInfo {
  docs_used: number;
  docs_limit: number | null;
  pages_used: number;
  pages_limit_per_doc: number | null;
  period_start: string | null;
  period_end: string | null;
}

export const billingApi = {
  getBilling: async (): Promise<BillingInfo> =>
    jsonOrThrow(await authFetch("/api/billing")),

  getUsage: async (): Promise<UsageInfo> =>
    jsonOrThrow(await authFetch("/api/usage")),

  createCheckout: async (tier: string): Promise<{ checkout_url: string }> =>
    sendJson("POST", "/api/checkout", { tier }),

  getPortalUrl: async (): Promise<{ portal_url: string }> =>
    jsonOrThrow(await authFetch("/api/billing/portal")),
};

// ---------------------------------------------------------------------------
// Cloud Storage (Google Drive) API
// ---------------------------------------------------------------------------

export interface DriveStatus {
  connected: boolean;
  storage_provider: string;
}

export async function getDriveStatus(): Promise<DriveStatus> {
  return jsonOrThrow(await authFetch("/api/auth/drive/status"));
}

export function connectDrive(): void {
  const auth = localStorage.getItem("doc2meeting_auth");
  const token = auth ? JSON.parse(auth).accessToken : "";
  window.location.href = `/api/auth/drive/connect?token=${encodeURIComponent(token)}`;
}

export async function disconnectDrive(): Promise<{ ok: boolean }> {
  return sendJson("POST", "/api/auth/drive/disconnect");
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  modifiedTime: string;
  isFolder: boolean;
}

export interface DriveBrowseResult {
  files: DriveFile[];
  nextPageToken: string | null;
}

export async function browseDriveFiles(opts: {
  folderId?: string;
  query?: string;
  pageToken?: string;
} = {}): Promise<DriveBrowseResult> {
  const params = new URLSearchParams();
  if (opts.folderId) params.set("folder_id", opts.folderId);
  if (opts.query) params.set("q", opts.query);
  if (opts.pageToken) params.set("page_token", opts.pageToken);
  return jsonOrThrow(await authFetch(`/api/drive/browse?${params.toString()}`));
}

export async function importDriveFile(fileId: string, name: string): Promise<UploadResult> {
  return sendJson("POST", "/api/drive/import", { file_id: fileId, name });
}

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  tier: string;
  is_admin: boolean;
  stripe_customer_id: string | null;
  suspended_at: string | null;
  created_at: string;
  doc_count: number;
  review_count: number;
}

export interface AdminUserList {
  users: AdminUser[];
  total: number;
  page: number;
  page_size: number;
}

export interface AdminUserDetail extends AdminUser {
  subscriptions: Array<{
    id: string;
    tier: string;
    status: string;
    stripe_subscription_id: string;
    current_period_start: string;
    current_period_end: string;
    created_at: string;
    canceled_at: string | null;
  }>;
  recent_usage: Array<{
    id: number;
    action: string;
    page_count: number;
    created_at: string;
  }>;
}

export interface AdminStats {
  total_users: number;
  total_documents: number;
  total_pages: number;
  total_audio_minutes: number;
  by_period: Array<{ date: string; docs: number; pages: number }>;
}

export interface AdminRevenue {
  mrr_cents: number;
  mrr_display: string;
  active_subscriptions: number;
  past_due: number;
  canceled_30d: number;
  new_30d: number;
  tier_breakdown: Record<string, number>;
}

export interface AdminHealth {
  status: string;
  services: Record<string, { status: string; [key: string]: unknown }>;
  timestamp: string;
}

export const adminApi = {
  listUsers: async (
    params: { q?: string; tier?: string; page?: number; page_size?: number } = {}
  ): Promise<AdminUserList> => {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.tier) qs.set("tier", params.tier);
    if (params.page) qs.set("page", String(params.page));
    if (params.page_size) qs.set("page_size", String(params.page_size));
    return jsonOrThrow(await authFetch(`/api/admin/users?${qs.toString()}`));
  },

  getUser: async (userId: string): Promise<AdminUserDetail> =>
    jsonOrThrow(await authFetch(`/api/admin/users/${userId}`)),

  suspendUser: async (userId: string, suspend: boolean): Promise<{ id: string; suspended: boolean }> =>
    sendJson("POST", `/api/admin/users/${userId}/suspend`, { suspend }),

  updateTier: async (userId: string, tier: string): Promise<{ id: string; tier: string; previous_tier: string }> =>
    sendJson("POST", `/api/admin/users/${userId}/tier`, { tier }),

  getStats: async (period: string = "month"): Promise<AdminStats> =>
    jsonOrThrow(await authFetch(`/api/admin/stats?period=${period}`)),

  getRevenue: async (): Promise<AdminRevenue> =>
    jsonOrThrow(await authFetch("/api/admin/revenue")),

  getHealth: async (): Promise<AdminHealth> =>
    jsonOrThrow(await authFetch("/api/admin/health")),

  exportNotes: async (docId: number): Promise<{
    document_id: number;
    document_path: string;
    exported_at: string;
    total_reviews: number;
    accepted: number;
    rejected: number;
    pending: number;
    markdown: string;
  }> => jsonOrThrow(await authFetch(`/api/documents/${docId}/export/notes`)),
};
