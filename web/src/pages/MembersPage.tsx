import { useState, type FormEvent } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import {
  PROJECT_ROLE_DESCRIPTIONS,
  PROJECT_ROLE_LABELS,
  type Member,
  type Project,
  type ProjectRole,
} from "@rpit/shared";
import { ApiRequestError } from "../api/client.ts";
import { useAddMember, useMe, useMembers, useRemoveMember, useUpdateMember } from "../api/hooks.ts";
import { Options } from "../components/ui.tsx";

export function MembersPage() {
  const project = useOutletContext<Project>();
  const isOwner = project.role === "owner";
  const members = useMembers(project.id);

  return (
    <>
      <div className="toolbar">
        <h2>Members</h2>
        <span className="muted">
          You are {/^[aeiou]/i.test(project.role) ? "an" : "a"} {PROJECT_ROLE_LABELS[project.role].toLowerCase()} of
          this project.
        </span>
      </div>
      {isOwner && <InviteForm projectId={project.id} />}
      {members.isLoading ? (
        <div className="center-msg">Loading members…</div>
      ) : members.error ? (
        <div className="empty">{members.error.message}</div>
      ) : (
        <div className="scroll-x">
          <table className="grid">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {members.data?.map((m) => (
                <MemberRow key={m.userId} member={m} project={project} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ul className="role-help muted">
        {(Object.keys(PROJECT_ROLE_LABELS) as ProjectRole[]).map((r) => (
          <li key={r}>
            <b>{PROJECT_ROLE_LABELS[r]}:</b> {PROJECT_ROLE_DESCRIPTIONS[r]}
          </li>
        ))}
      </ul>
    </>
  );
}

function InviteForm({ projectId }: { projectId: string }) {
  const add = useAddMember(projectId);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ProjectRole>("editor");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await add.mutateAsync({ email, role });
      setEmail("");
    } catch (err) {
      setError(err instanceof ApiRequestError ? (err.fieldErrors?.email?.[0] ?? err.message) : (err as Error).message);
    }
  }

  return (
    <form className="panel invite" onSubmit={submit}>
      <label className="field">
        Email
        <input
          type="email"
          value={email}
          placeholder="teammate@example.com"
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </label>
      <label className="field">
        Role
        <select value={role} onChange={(e) => setRole(e.target.value as ProjectRole)}>
          <Options labels={PROJECT_ROLE_LABELS} />
        </select>
      </label>
      <button className="btn primary" disabled={add.isPending}>
        {add.isPending ? "Inviting…" : "Invite member"}
      </button>
      {error && <div className="form-error">{error}</div>}
    </form>
  );
}

function MemberRow({ member: m, project }: { member: Member; project: Project }) {
  const navigate = useNavigate();
  const me = useMe().data;
  const update = useUpdateMember(project.id);
  const remove = useRemoveMember(project.id);
  const isMe = m.userId === me?.id;
  const isOwner = project.role === "owner";
  const error = update.error ?? remove.error;

  async function onRemove() {
    const msg = isMe
      ? `Leave "${project.name}"? You will lose access until an owner invites you again.`
      : `Remove ${m.name} from "${project.name}"? Their tasks and test cases in this project will be unassigned.`;
    if (!confirm(msg)) return;
    try {
      await remove.mutateAsync(m.userId);
      if (isMe) navigate("/");
    } catch {
      // Shown inline from remove.error.
    }
  }

  return (
    <tr>
      <td>
        {m.name}
        {isMe && <span className="muted"> (you)</span>}
      </td>
      <td>{m.email}</td>
      <td>
        {isOwner ? (
          <select
            className="inline"
            value={m.role}
            aria-label={`Role of ${m.name}`}
            disabled={update.isPending}
            onChange={(e) => update.mutate({ userId: m.userId, role: e.target.value as ProjectRole })}
          >
            <Options labels={PROJECT_ROLE_LABELS} />
          </select>
        ) : (
          PROJECT_ROLE_LABELS[m.role]
        )}
        {error && <div className="form-error">{error.message}</div>}
      </td>
      <td className="actions">
        {(isOwner || isMe) && (
          <button className="btn sm danger" onClick={onRemove} disabled={remove.isPending}>
            {isMe ? "Leave project" : "Remove"}
          </button>
        )}
      </td>
    </tr>
  );
}
