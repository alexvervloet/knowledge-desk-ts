import { describe, expect, it } from "vitest";
import { PAGE_SIZE } from "../api";
import { pagerState } from "./pagerState";

describe("pagerState", () => {
  it("hides itself when everything fits on one page", () => {
    expect(pagerState(0, PAGE_SIZE, PAGE_SIZE).visible).toBe(false);
    expect(pagerState(0, PAGE_SIZE + 1, PAGE_SIZE).visible).toBe(true);
  });

  it("describes the first page", () => {
    const s = pagerState(0, 97, PAGE_SIZE);
    expect([s.first, s.last]).toEqual([1, PAGE_SIZE]);
    expect(s.hasPrev).toBe(false);
    expect(s.hasNext).toBe(true);
  });

  it("describes a middle page", () => {
    const s = pagerState(PAGE_SIZE, 97, PAGE_SIZE);
    expect([s.first, s.last]).toEqual([PAGE_SIZE + 1, PAGE_SIZE * 2]);
    expect(s.hasPrev).toBe(true);
    expect(s.hasNext).toBe(true);
  });

  it("offers no next page on a short final page", () => {
    const s = pagerState(PAGE_SIZE * 3, 97, 97 - PAGE_SIZE * 3);
    expect(s.last).toBe(97);
    expect(s.hasNext).toBe(false);
  });

  it("offers no next page when the final page is exactly full", () => {
    // The off-by-one worth pinning: last === total, not last < total.
    const total = PAGE_SIZE * 4;
    const s = pagerState(PAGE_SIZE * 3, total, PAGE_SIZE);
    expect(s.last).toBe(total);
    expect(s.hasNext).toBe(false);
  });

  it("reports zero rather than a phantom first row on an empty page", () => {
    // Reachable when rows are deleted out from under an offset. The components
    // step back to the previous page when this happens; until they do, the
    // label must not claim to be showing a row that is not there.
    const s = pagerState(PAGE_SIZE * 2, 30, 0);
    expect(s.first).toBe(0);
    expect(s.hasPrev).toBe(true);
    expect(s.hasNext).toBe(false);
  });
});
