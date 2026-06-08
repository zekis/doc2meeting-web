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

export interface DocumentSummary {
  id: number;
  rel_path: string;
  name: string;
  context_paths: string[];
  last_opened_at: string;
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

async function jsonOrThrow<T>(r: Response): Promise<T> {
  if (!r.ok) {
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
  return jsonOrThrow(
    await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
  );
}

export const api = {
  getTree: async (): Promise<TreeResponse> =>
    jsonOrThrow(await fetch("/api/tree")),

  getFile: async (relPath: string): Promise<string> => {
    const r = await fetch(`/api/files/${encodeURI(relPath)}`);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.text();
  },

  convertDocx: async (
    relPath: string
  ): Promise<{ saved_rel_path: string; size: number }> =>
    sendJson("POST", "/api/files/convert", { rel_path: relPath }),

  listDocuments: async (): Promise<DocumentSummary[]> =>
    jsonOrThrow(await fetch("/api/documents")),

  openDocument: async (relPath: string): Promise<DocumentDetail> =>
    sendJson("POST", "/api/documents/open", { rel_path: relPath }),

  getDocument: async (id: number): Promise<DocumentDetail> =>
    jsonOrThrow(await fetch(`/api/documents/${id}`)),

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
    const r = await fetch("/api/transcribe", { method: "POST", body: form });
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
    const r = await fetch(
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
    jsonOrThrow(await fetch("/api/settings")),

  updateSettings: async (patch: AppSettingsPatch): Promise<AppSettings> =>
    sendJson("PATCH", "/api/settings", patch),
};
