import { beforeEach } from "vitest";

/** An in-memory localStorage, so the API client's token handling works under
 *  the node environment. Pulling in jsdom for one key-value store would be a
 *  browser's worth of machinery in front of four lines. */
class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length() {
    return this.data.size;
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, String(v));
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
  clear() {
    this.data.clear();
  }
}

globalThis.localStorage = new MemoryStorage();

beforeEach(() => localStorage.clear());
