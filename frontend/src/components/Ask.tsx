import { FormEvent, useRef, useState } from "react";
import { ApiError, AskEvent, api, askStream } from "../api";

type Source = { document_id: string; ordinal: number; path: string };

export function Ask() {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [provider, setProvider] = useState("");
  const [answerId, setAnswerId] = useState("");
  const [error, setError] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [feedback, setFeedback] = useState<"up" | "down" | "">("");
  const [warnings, setWarnings] = useState<{ code: string; detail: string }[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  async function ask(e: FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    setAnswer(""); setSources([]); setProvider(""); setAnswerId("");
    setError(""); setFeedback(""); setWarnings([]); setStreaming(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await askStream(question, (ev: AskEvent) => {
        if (ev.type === "meta") { setProvider(ev.provider); setAnswerId(ev.answer_id); }
        else if (ev.type === "sources") setSources(ev.sources);
        else if (ev.type === "token") setAnswer((a) => a + ev.text);
        else if (ev.type === "done") setWarnings(ev.warnings ?? []);
        else if (ev.type === "error") setError(ev.message);
      }, ctrl.signal);
    } catch (err) {
      if (!ctrl.signal.aborted) setError(err instanceof ApiError ? err.message : "answer failed");
    } finally {
      setStreaming(false);
    }
  }

  function stop() {
    abortRef.current?.abort();
    setStreaming(false);
  }

  async function sendFeedback(rating: "up" | "down") {
    if (!answerId) return;
    setFeedback(rating);
    try { await api.post("/feedback", { answer_id: answerId, rating }); } catch { /* best effort */ }
  }

  return (
    <div>
      <form className="card" onSubmit={ask}>
        <label>Ask across the documents you're allowed to see</label>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="e.g. what is our refund policy?"
          maxLength={500}
        />
        <div className="row" style={{ marginTop: "0.5rem" }}>
          <button className="primary" type="submit" disabled={streaming || !question.trim()}>
            {streaming ? "Answering..." : "Ask"}
          </button>
          {streaming && <button type="button" onClick={stop}>Stop</button>}
        </div>
      </form>

      {provider === "mock" && (
        <p className="banner">Mock provider: no answer-model key is set, so replies are not model-generated.</p>
      )}
      {error && <p className="error">{error}</p>}

      {(answer || sources.length > 0) && (
        <div className="card">
          <p className="answer">{answer}</p>
          {warnings.length > 0 && (
            // Shown after the fact on purpose. The answer streamed, so this is
            // not a gate that held something back; it is the reader being told
            // what the checks noticed about what they have already read.
            <div className="banner">
              <strong>Checks flagged this answer</strong>
              <ul>
                {warnings.map((w) => (
                  <li key={w.code}><code>{w.code}</code> — {w.detail}</li>
                ))}
              </ul>
            </div>
          )}
          {sources.length > 0 && (
            <div className="sources">
              <strong>Sources</strong>
              <ul>
                {sources.map((s, i) => (
                  <li key={i}>[{i + 1}] <code>{s.path}</code> <span className="muted">#{s.ordinal}</span></li>
                ))}
              </ul>
            </div>
          )}
          {answerId && !streaming && (
            <div className="row" style={{ marginTop: "0.5rem" }}>
              <span className="muted">Helpful?</span>
              <button className={feedback === "up" ? "primary" : ""} onClick={() => sendFeedback("up")}>👍</button>
              <button className={feedback === "down" ? "primary" : ""} onClick={() => sendFeedback("down")}>👎</button>
              {feedback && <span className="muted">thanks</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
