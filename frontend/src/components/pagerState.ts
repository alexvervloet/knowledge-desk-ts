import { PAGE_SIZE } from "../api";

export type PagerState = {
  /** False when everything fits on one page, so small orgs see no controls. */
  visible: boolean;
  /** 1-based index of the first row shown, 0 when there are none. */
  first: number;
  /** 1-based index of the last row shown. */
  last: number;
  hasPrev: boolean;
  hasNext: boolean;
};

/** The pager's arithmetic, separated from its markup so the boundaries can be
 *  checked directly: the last page, a page that is exactly full, and a total
 *  that has shrunk under the current offset because rows were deleted. */
export function pagerState(offset: number, total: number, count: number): PagerState {
  const last = offset + count;
  return {
    visible: total > PAGE_SIZE,
    first: count === 0 ? 0 : offset + 1,
    last,
    hasPrev: offset > 0,
    hasNext: last < total,
  };
}
