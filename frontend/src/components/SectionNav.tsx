import { SectionDetail } from "../api";

interface Props {
  sections: SectionDetail[];
  activeIdx: number | null;
  onSelect: (idx: number) => void;
  onReviewSection: (idx: number) => void;
  batchRunning: boolean;
}

export function SectionNav({
  sections,
  activeIdx,
  onSelect,
  onReviewSection,
  batchRunning,
}: Props) {
  return (
    <nav className="section-nav">
      <h3>Sections</h3>
      <ol>
        {sections.map((s) => {
          const reviewedParas = new Set(s.reviews.map((r) => r.paragraph_idx))
            .size;
          const unreviewedParas = s.paragraphs.length - reviewedParas;
          const reviewable = unreviewedParas > 0;
          return (
            <li key={s.idx} className={`level-${s.level}`}>
              <div
                className={`nav-row ${s.idx === activeIdx ? "active" : ""}`}
              >
                <button
                  className="nav-item"
                  onClick={() => onSelect(s.idx)}
                  title={s.full_path}
                >
                  <span className="nav-idx">{s.idx + 1}.</span>
                  <span className="nav-title">{s.title}</span>
                  <span className="nav-icons">
                    {s.reviewed && (
                      <span className="nav-icon icon-reviewed" title="Reviewed">
                        🔊
                      </span>
                    )}
                    {s.accepted_count > 0 && (
                      <span
                        className="nav-icon icon-accepted"
                        title={`${s.accepted_count} accepted`}
                      >
                        ✓{s.accepted_count}
                      </span>
                    )}
                    {s.rejected_count > 0 && (
                      <span
                        className="nav-icon icon-rejected"
                        title={`${s.rejected_count} rejected`}
                      >
                        ✗{s.rejected_count}
                      </span>
                    )}
                  </span>
                </button>
                {reviewable && s.paragraphs.length > 0 && (
                  <button
                    className="nav-review-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onReviewSection(s.idx);
                    }}
                    disabled={batchRunning}
                    title={`Review ${unreviewedParas} unreviewed paragraph${unreviewedParas === 1 ? "" : "s"}`}
                  >
                    ▶
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
