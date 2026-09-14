import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, AskEvent, api, askStream, setToken } from "./api";

/** A Response whose body streams the given string pieces, one read per piece.
 *  The pieces are the point: the server's framing does not survive TCP, so the
 *  parser has to reassemble frames that arrive split. */
function streaming(pieces: string[], init: ResponseInit = { status: 200 }): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of pieces) controller.enqueue(encoder.encode(p));
      controller.close();
    },
  });
  return new Response(body, init);
}

function frame(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function collect(): [AskEvent[], (e: AskEvent) => void] {
  const seen: AskEvent[] = [];
  return [seen, (e) => seen.push(e)];
}

afterEach(() => vi.unstubAllGlobals());

describe("askStream", () => {
  it("reads whole frames that arrive in one chunk", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streaming([
      frame({ type: "meta", answer_id: "a1", provider: "claude" }) +
      frame({ type: "token", text: "hello " }) +
      frame({ type: "done", usage: { input_tokens: 1, output_tokens: 2 }, cost_usd: 0.5 }),
    ])));

    const [seen, onEvent] = collect();
    await askStream("q", onEvent);

    expect(seen.map((e) => e.type)).toEqual(["meta", "token", "done"]);
  });

  it("reassembles a frame split across reads", async () => {
    // The split lands inside the JSON, which is where a naive per-chunk parse
    // throws rather than merely dropping something.
    const whole = frame({ type: "token", text: "reassembled" });
    const cut = whole.indexOf("text") + 2;
    vi.stubGlobal("fetch", vi.fn(async () =>
      streaming([whole.slice(0, cut), whole.slice(cut)]),
    ));

    const [seen, onEvent] = collect();
    await askStream("q", onEvent);

    expect(seen).toEqual([{ type: "token", text: "reassembled" }]);
  });

  it("reassembles a frame whose blank-line terminator is itself split", async () => {
    const whole = frame({ type: "token", text: "x" });
    vi.stubGlobal("fetch", vi.fn(async () =>
      streaming([whole.slice(0, whole.length - 1), "\n"]),
    ));

    const [seen, onEvent] = collect();
    await askStream("q", onEvent);

    expect(seen).toEqual([{ type: "token", text: "x" }]);
  });

  it("keeps token order across many small reads", async () => {
    const words = ["the ", "sky ", "is ", "blue"];
    const stream = words.map((w) => frame({ type: "token", text: w })).join("");
    // One byte at a time: every frame boundary is split.
    vi.stubGlobal("fetch", vi.fn(async () => streaming(stream.split(""))));

    const [seen, onEvent] = collect();
    await askStream("q", onEvent);

    expect(seen.map((e) => (e as { text: string }).text)).toEqual(words);
  });

  it("surfaces a rate limit as an ApiError rather than an empty answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 429 })));
    await expect(askStream("q", () => {})).rejects.toBeInstanceOf(ApiError);
  });

  it("ignores keep-alive comments and blank padding between frames", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streaming([
      ": keep-alive\n\n" + frame({ type: "token", text: "kept" }),
    ])));

    const [seen, onEvent] = collect();
    await askStream("q", onEvent);

    expect(seen).toEqual([{ type: "token", text: "kept" }]);
  });
});

describe("getPage", () => {
  function paged(items: unknown[], headers: Record<string, string>): Response {
    return new Response(JSON.stringify(items), { status: 200, headers });
  }

  it("reads the total from X-Total-Count rather than the page length", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      paged([{ id: "1" }], { "X-Total-Count": "97", "Content-Type": "application/json" }),
    ));

    const page = await api.getPage<{ id: string }>("/documents", 0);

    expect(page.total).toBe(97);
    expect(page.items).toHaveLength(1);
  });

  it("falls back to the page length when the header is absent", async () => {
    // A browser hides the header on a cross-origin reply unless it is exposed,
    // so the fallback is what keeps the pager sane against a misconfigured API.
    vi.stubGlobal("fetch", vi.fn(async () =>
      paged([{ id: "1" }, { id: "2" }], { "Content-Type": "application/json" }),
    ));

    const page = await api.getPage<{ id: string }>("/documents", 0);

    expect(page.total).toBe(2);
  });

  /** A fetch stub that records how it was called. Typed with the parameters it
   *  actually receives, so the recorded calls stay inspectable. */
  function spyFetch() {
    const spy = vi.fn(async (_url: string, _init?: RequestInit) =>
      paged([], { "X-Total-Count": "0" }),
    );
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  it("appends paging to a path that already carries a query string", async () => {
    const spy = spyFetch();

    await api.getPage("/documents?source=local-folder", 50);

    expect(spy.mock.calls[0][0]).toContain("?source=local-folder&limit=");
  });

  it("sends the bearer token", async () => {
    setToken("tok-123");
    const spy = spyFetch();

    await api.getPage("/members", 0);

    const headers = spy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok-123");
  });
});
