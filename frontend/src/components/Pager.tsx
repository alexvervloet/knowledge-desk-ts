import { PAGE_SIZE } from "../api";
import { pagerState } from "./pagerState";

/** Offset pager for the admin listings. Renders nothing when everything fits on
 *  one page, so small orgs never see controls they do not need. The arithmetic
 *  lives in pagerState so its boundaries can be tested without a DOM. */
export function Pager({
  offset,
  total,
  count,
  onChange,
}: {
  offset: number;
  total: number;
  count: number;
  onChange: (next: number) => void;
}) {
  const { visible, first, last, hasPrev, hasNext } = pagerState(offset, total, count);
  if (!visible) return null;

  return (
    <div className="row" style={{ marginTop: "0.6rem", justifyContent: "space-between" }}>
      <span className="muted">
        {first} to {last} of {total}
      </span>
      <div className="row">
        <button disabled={!hasPrev} onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}>
          Previous
        </button>
        <button disabled={!hasNext} onClick={() => onChange(offset + PAGE_SIZE)}>
          Next
        </button>
      </div>
    </div>
  );
}
