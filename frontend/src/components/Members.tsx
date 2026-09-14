import { FormEvent, useEffect, useState } from "react";
import { ApiError, Group, GroupMember, Me, Member, PAGE_SIZE, Role, api } from "../api";
import { Pager } from "./Pager";

export function Members({ me }: { me: Me }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [groups, setGroups] = useState<Group[]>([]);
  // The group picker needs every member, not just the visible page. Capped at
  // the API maximum; an org past that needs a search box rather than a select.
  const [allMembers, setAllMembers] = useState<Member[]>([]);
  const [error, setError] = useState("");

  // add-member form
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("member");

  // groups
  const [groupName, setGroupName] = useState("");
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([]);

  async function load(at = offset) {
    try {
      const page = await api.getPage<Member>("/members", at);
      if (page.items.length === 0 && at > 0) return load(Math.max(0, at - PAGE_SIZE));
      setMembers(page.items);
      setTotal(page.total);
      setOffset(at);
      setGroups(await api.get<Group[]>("/groups"));
      setAllMembers((await api.getPage<Member>("/members", 0, 500)).items);
    } catch (err) { setError(err instanceof ApiError ? err.message : "failed to load"); }
  }
  useEffect(() => { void load(0); }, []);

  function wrap(fn: () => Promise<unknown>) {
    setError("");
    fn().catch((err) => setError(err instanceof ApiError ? err.message : "action failed"));
  }

  async function addMember(e: FormEvent) {
    e.preventDefault();
    wrap(async () => {
      await api.post("/members", { email, password, role });
      setEmail(""); setPassword(""); setRole("member");
      await load();
    });
  }

  async function openGroupMembers(id: string) {
    setOpenGroup(id);
    setGroupMembers(await api.get<GroupMember[]>(`/groups/${id}/members`));
  }

  return (
    <div>
      <div className="card">
        <h2>Members ({total})</h2>
        {error && <p className="error">{error}</p>}
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>Email</th><th>Role</th><th></th></tr></thead>
            <tbody>
              {members.map((m) => {
                const isSelf = m.id === me.user_id;
                return (
                  <tr key={m.id}>
                    <td>{m.email}{isSelf && <span className="muted"> (you)</span>}</td>
                    <td>
                      <select
                        value={m.role}
                        disabled={isSelf}
                        onChange={(e) => wrap(async () => { await api.patch(`/members/${m.id}`, { role: e.target.value }); await load(); })}
                      >
                        <option value="member">member</option>
                        <option value="admin">admin</option>
                        <option value="owner">owner</option>
                      </select>
                    </td>
                    <td>
                      {!isSelf && (
                        <button className="danger" onClick={() => wrap(async () => { await api.del(`/members/${m.id}`); await load(); })}>Remove</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <Pager offset={offset} total={total} count={members.length} onChange={(n) => load(n)} />

        <form className="row" style={{ marginTop: "0.75rem" }} onSubmit={addMember}>
          <input placeholder="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required style={{ flex: "2 1 160px" }} />
          <input placeholder="temp password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} style={{ flex: "2 1 140px" }} />
          <select value={role} onChange={(e) => setRole(e.target.value as Role)} style={{ flex: "1 1 100px" }}>
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
          <button className="primary" type="submit">Add</button>
        </form>
      </div>

      <div className="card">
        <h2>Groups</h2>
        <div className="row">
          <input placeholder="new group name" value={groupName} onChange={(e) => setGroupName(e.target.value)} style={{ flex: "2 1 160px" }} />
          <button className="primary" onClick={() => wrap(async () => { await api.post("/groups", { name: groupName }); setGroupName(""); await load(); })}>Create</button>
        </div>
        <ul>
          {groups.map((g) => (
            <li key={g.id} style={{ marginTop: "0.4rem" }}>
              <div className="row">
                <strong>{g.name}</strong>
                <button onClick={() => openGroupMembers(g.id)}>Members</button>
                <button className="danger" onClick={() => wrap(async () => { await api.del(`/groups/${g.id}`); if (openGroup === g.id) setOpenGroup(null); await load(); })}>Delete</button>
              </div>
              {openGroup === g.id && (
                <div style={{ marginLeft: "1rem", marginTop: "0.4rem" }}>
                  {groupMembers.map((gm) => (
                    <div key={gm.id} className="row">
                      <span>{gm.email}</span>
                      <button className="danger" onClick={() => wrap(async () => { await api.del(`/groups/${g.id}/members/${gm.id}`); await openGroupMembers(g.id); })}>Remove</button>
                    </div>
                  ))}
                  <div className="row" style={{ marginTop: "0.3rem" }}>
                    <select id={`add-${g.id}`} defaultValue="">
                      <option value="" disabled>add member...</option>
                      {allMembers.map((m) => <option key={m.id} value={m.email}>{m.email}</option>)}
                    </select>
                    <button onClick={() => {
                      const sel = document.getElementById(`add-${g.id}`) as HTMLSelectElement;
                      if (sel.value) wrap(async () => { await api.post(`/groups/${g.id}/members`, { email: sel.value }); await openGroupMembers(g.id); });
                    }}>Add</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
