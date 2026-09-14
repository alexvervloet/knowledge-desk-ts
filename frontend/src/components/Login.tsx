import { FormEvent, useState } from "react";
import { ApiError, TokenResp, api, setToken } from "../api";

export function Login({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [orgSlug, setOrgSlug] = useState("");
  const [orgName, setOrgName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const resp =
        mode === "signup"
          ? await api.post<TokenResp>("/auth/signup", {
              org_slug: orgSlug, org_name: orgName, email, password,
            })
          : await api.post<TokenResp>("/auth/login", {
              email, password, org_slug: orgSlug || undefined,
            });
      setToken(resp.token);
      onAuthed();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app" style={{ maxWidth: 400 }}>
      <h1 className="brand">Knowledge Desk</h1>
      <div className="card">
        <div className="row" style={{ marginBottom: "0.5rem" }}>
          <button className={mode === "login" ? "primary" : ""} onClick={() => setMode("login")}>Log in</button>
          <button className={mode === "signup" ? "primary" : ""} onClick={() => setMode("signup")}>Create org</button>
        </div>
        <form onSubmit={submit}>
          {mode === "signup" && (
            <>
              <label>Org slug (lowercase, e.g. acme)</label>
              <input value={orgSlug} onChange={(e) => setOrgSlug(e.target.value)} required />
              <label>Org name</label>
              <input value={orgName} onChange={(e) => setOrgName(e.target.value)} required />
            </>
          )}
          {mode === "login" && (
            <>
              <label>Org slug (optional if you belong to one org)</label>
              <input value={orgSlug} onChange={(e) => setOrgSlug(e.target.value)} />
            </>
          )}
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
          {error && <p className="error">{error}</p>}
          <button className="primary" type="submit" disabled={busy} style={{ marginTop: "0.75rem", width: "100%" }}>
            {busy ? "..." : mode === "signup" ? "Create organization" : "Log in"}
          </button>
        </form>
      </div>
    </div>
  );
}
