import { ReviewDetail, SectionDetail } from "../api";
import { ParaAction } from "./DocReview";
import { ParagraphRow } from "./ParagraphRow";

interface Props {
  section: SectionDetail;
  nowPlayingParagraphIdx: number | null;
  /** Currently-running per-paragraph action originating in this section, if any. */
  activeAction:
    | { sectionIdx: number; paragraphIdx: number; action: ParaAction; state: "loading" | "playing" }
    | null;
  onAction: (action: ParaAction, paragraphIdx: number) => void;
  onReviewUpdated: (r: ReviewDetail) => void;
}

/**
 * Render one section as a sequence of grid items inside the parent .para-grid.
 *
 * The section heading itself isn't rendered as a separate row — the backend
 * folds the section title into the first paragraph's text so it lives inside
 * a review unit. A 0-height anchor div carries the id + data-section-idx so
 * the section nav's scrollIntoView and the in-doc scrollspy continue to work.
 */
export function SectionBlock({
  section,
  nowPlayingParagraphIdx,
  activeAction,
  onAction,
  onReviewUpdated,
}: Props) {
  return (
    <>
      <div
        id={`section-${section.idx}`}
        data-section-idx={section.idx}
        className="section-anchor"
        aria-hidden="true"
      />

      {section.paragraphs.map((p, i) => (
        <ParagraphRow
          key={i}
          sectionIdx={section.idx}
          paragraphIdx={i}
          text={p}
          reviews={section.reviews.filter((r) => r.paragraph_idx === i)}
          nowPlaying={nowPlayingParagraphIdx === i}
          activeAction={
            activeAction?.paragraphIdx === i ? activeAction : null
          }
          onAction={(action) => onAction(action, i)}
          onReviewUpdated={onReviewUpdated}
        />
      ))}
    </>
  );
}
