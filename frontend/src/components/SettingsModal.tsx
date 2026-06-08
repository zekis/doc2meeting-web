import { useEffect, useState } from "react";
import { api, AppSettings, AppSettingsPatch } from "../api";

interface SettingsModalProps {
  onClose: () => void;
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const s = await api.getSettings();
        setSettings(s);
        setDraft(s);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, []);

  const dirty =
    !!settings &&
    !!draft &&
    (
      settings.narrator_voice !== draft.narrator_voice ||
      settings.reviewer_voice !== draft.reviewer_voice ||
      settings.narrator_instructions !== draft.narrator_instructions ||
      settings.reviewer_instructions !== draft.reviewer_instructions ||
      settings.responder_instructions !== draft.responder_instructions ||
      settings.default_persona !== draft.default_persona ||
      settings.tts_model !== draft.tts_model
    );

  const handleSave = async () => {
    if (!draft || !settings || !dirty) return;
    setSaving(true);
    setError(null);
    // Only send the fields that actually changed.
    const patch: AppSettingsPatch = {};
    (Object.keys(draft) as (keyof AppSettings)[]).forEach((k) => {
      if (
        k === "narrator_voice" ||
        k === "reviewer_voice" ||
        k === "narrator_instructions" ||
        k === "reviewer_instructions" ||
        k === "responder_instructions" ||
        k === "default_persona" ||
        k === "tts_model"
      ) {
        if (draft[k] !== settings[k]) {
          (patch as Record<string, string>)[k] = draft[k] as string;
        }
      }
    });
    try {
      const saved = await api.updateSettings(patch);
      setSettings(saved);
      setDraft(saved);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    if (!draft) return;
    setDraft({ ...draft, [key]: value });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal settings-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>Voice & tone settings</h2>
          <button className="link-btn" onClick={onClose}>
            close
          </button>
        </header>
        {!draft ? (
          <p className="modal-help">
            {error ? `Failed to load settings: ${error}` : "Loading settings..."}
          </p>
        ) : (
          <>
            <div className="modal-body settings-body">
              <div className="settings-grid">
                <label className="settings-field">
                  <span>Narrator voice</span>
                  <select
                    value={draft.narrator_voice}
                    onChange={(e) => update("narrator_voice", e.target.value)}
                  >
                    {draft.available_voices.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="settings-field">
                  <span>Reviewer voice</span>
                  <select
                    value={draft.reviewer_voice}
                    onChange={(e) => update("reviewer_voice", e.target.value)}
                  >
                    {draft.available_voices.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="settings-field">
                  <span>Reviewer persona</span>
                  <select
                    value={draft.default_persona}
                    onChange={(e) => update("default_persona", e.target.value)}
                  >
                    {draft.available_personas.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="settings-field">
                  <span>TTS model</span>
                  <select
                    value={draft.tts_model}
                    onChange={(e) => update("tts_model", e.target.value)}
                  >
                    {draft.available_tts_models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="settings-field settings-field-wide">
                <span>
                  Narrator tone
                  <small> (only applied when TTS model is <code>gpt-4o-mini-tts</code>)</small>
                </span>
                <textarea
                  rows={4}
                  value={draft.narrator_instructions}
                  onChange={(e) => update("narrator_instructions", e.target.value)}
                />
              </label>

              <label className="settings-field settings-field-wide">
                <span>Reviewer tone</span>
                <textarea
                  rows={4}
                  value={draft.reviewer_instructions}
                  onChange={(e) => update("reviewer_instructions", e.target.value)}
                />
              </label>

              <label className="settings-field settings-field-wide">
                <span>Responder tone</span>
                <textarea
                  rows={4}
                  value={draft.responder_instructions}
                  onChange={(e) => update("responder_instructions", e.target.value)}
                />
              </label>

              {error && <p className="settings-error">{error}</p>}
            </div>
            <footer className="modal-foot">
              <button
                className="ghost"
                onClick={onClose}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                className="primary"
                onClick={handleSave}
                disabled={!dirty || saving}
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
