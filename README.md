# doc2meeting-web

Interactive document review webapp. Upload a markdown spec, navigate by section, hear a narrator read it aloud while a reviewer agent comments — accept or reject each comment, then export the curated markdown.

## Architecture (Week 1 MVP)

```
┌─────────────────┐         ┌──────────────────────────────┐
│  React + Vite   │ ──────▶ │  FastAPI + SQLModel + SQLite │
│  3-pane UI      │ ◀────── │   - markdown parser/cleaner  │
└─────────────────┘         │   - Reviewer + Editor agents │
                            │   - OpenAI TTS render        │
                            └──────────────────────────────┘
```

- **Backend** is a self-contained FastAPI service: it parses markdown into sections, runs the Reviewer/Editor/Narrator agents, and renders TTS audio.
- **Frontend** is a single-page React app: left = section nav, middle = markdown, right = comment bubbles with audio playback and accept/reject.

What's in this MVP and what isn't:

| In | Not yet |
|---|---|
| Upload markdown, parse to sections | Source-material upload / RAG context |
| Per-section reviewer (Claude Opus 4.7, skeptical persona) | Streaming token-by-token reviews |
| Per-section narrator audio (OpenAI gpt-4o-mini-tts) | Real-time / continuous playback |
| Accept / reject each comment | Editor agent applying accepted edits to markdown |
| Comment history persisted to SQLite | Edit history / audit trail |
| Export current markdown | Diff view, side-by-side compare |
| Local single-user | Authentication, multi-user |

## Setup

### Prerequisites

- Python 3.11
- Node.js 20+
- ffmpeg on PATH (needed by pydub)
- `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` available

### Backend

```pwsh
cd d:\Git\doc2meeting-web\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .
copy .env.example .env
# Edit .env with your API keys
.\.venv\Scripts\uvicorn app.main:app --reload --port 8000
```

Open <http://127.0.0.1:8000/docs> for the auto-generated OpenAPI UI to poke at the endpoints.

### Frontend

```pwsh
cd d:\Git\doc2meeting-web\frontend
npm install
npm run dev
```

Open <http://localhost:5173>. Vite proxies `/api/*` and `/audio/*` to the backend on port 8000.

## How a review flows

1. Upload a markdown doc on the library screen → backend parses it into sections, returns the document detail, frontend opens it.
2. Click a section in the left nav. The middle pane renders the markdown for that section.
3. Click **Review this section** → backend calls Claude for commentary then OpenAI TTS for the audio, persists a `Review` row, returns it to the frontend.
4. Comment bubble appears in the right pane with playable audio.
5. Click **Accept** or **Reject** on the bubble. Status persists.
6. Use **Prev / Next** in the middle pane (or the section nav) to move through the doc.
7. Hit `GET /api/documents/{id}/export` to pull the current markdown.

## Backend API at a glance

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/documents` | Upload markdown |
| GET | `/api/documents` | List documents |
| GET | `/api/documents/{id}` | Document + sections |
| GET | `/api/documents/{id}/export` | Current markdown |
| GET | `/api/sections/{id}` | Section + reviews |
| POST | `/api/sections/{id}/review?persona=skeptical` | Generate reviewer turn |
| POST | `/api/reviews/{id}/accept` | Mark accepted |
| POST | `/api/reviews/{id}/reject` | Mark rejected |
| GET | `/audio/{path}` | Serve a generated MP3 |

## Roadmap (Week 2+)

1. **Editor agent**: on accept, third Claude call to produce the actual replacement markdown for that section. Show diff in middle pane. User confirms → section body updated.
2. **Edit history table**: every accepted edit becomes a row; user can revert.
3. **Source material**: upload reference docs, pass as cached system prompt to the reviewer.
4. **Streaming**: SSE for the reviewer's token-by-token reply; chunked TTS playback for low latency.
5. **Auth + deploy**: trivial single-user token for hosted use.

## Repo layout

```
doc2meeting-web/
├── backend/
│   ├── pyproject.toml
│   ├── .env.example
│   └── app/
│       ├── main.py        # FastAPI routes
│       ├── db.py          # SQLite engine
│       ├── models.py      # SQLModel tables
│       ├── pipeline.py    # agents + TTS + paragraph splitter
│       └── doc/           # markdown parser + TTS text cleaner
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── api.ts
│       ├── styles.css
│       └── components/
│           ├── DocList.tsx
│           ├── DocReview.tsx
│           ├── SectionNav.tsx
│           ├── SectionView.tsx
│           └── CommentPanel.tsx
└── README.md
```
