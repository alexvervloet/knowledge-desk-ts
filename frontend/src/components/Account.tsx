import { FormEvent, useState } from "react";
import { ApiError, Me, changePassword } from "../api";

/** Change your own password. Self-service only: there is no admin reset, because
 *  an admin who could reset an owner's password could sign in as them. */
export function Account({ me }: { me: Me }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setDone(false);
    if (next !== confirm) {
      setError("The new passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not change the password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 420 }}>
      <h2>Password</h2>
      <p className="muted">
        Signed in as {me.email}. Changing your password signs out your other
        sessions and keeps this one.
      </p>
      <form onSubmit={submit}>
        <label>Current password</label>
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        <label>New password</label>
        <input
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
          minLength={8}
        />
        <label>Confirm new password</label>
        <input
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          minLength={8}
        />
        {error && <p className="error">{error}</p>}
        {done && <p className="muted">Password changed. Other sessions were signed out.</p>}
        <button className="primary" type="submit" disabled={busy} style={{ marginTop: "0.75rem" }}>
          {busy ? "..." : "Change password"}
        </button>
      </form>
    </div>
  );
}
