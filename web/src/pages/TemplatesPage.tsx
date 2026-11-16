import { useState } from "react";
import { Link } from "react-router-dom";
import type { ProjectTemplate } from "@rpit/shared";
import { useDeleteTemplate, useProjects, useTemplates } from "../api/hooks.ts";
import { ProjectDialog } from "../components/dialogs.tsx";
import { MarkdownView } from "../components/markdown.tsx";
import { TopBar } from "../components/TopBar.tsx";
import { TemplateDialog, templateAudience, templateSummary, WHAT_TEMPLATES_COPY } from "../components/templates.tsx";
import { formatDateTime } from "../lib/format.ts";

/**
 * Project templates the user can use: their own, then ones shared with them.
 * Templates are saved from a project's overview ("Save as template"); here the
 * owner renames, shares and deletes them, and anyone can start a project.
 */
export function TemplatesPage() {
  const templates = useTemplates();
  const [using, setUsing] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProjectTemplate | null>(null);
  const mine = templates.data?.filter((t) => t.isOwner) ?? [];
  const shared = templates.data?.filter((t) => !t.isOwner) ?? [];

  const cards = (list: ProjectTemplate[]) => (
    <div className="plan-list">
      {list.map((t) => (
        <TemplateCard key={t.id} template={t} onUse={() => setUsing(t.id)} onEdit={() => setEditing(t)} />
      ))}
    </div>
  );

  return (
    <>
      <TopBar />
      <main className="page">
        <div className="toolbar">
          <h2>Templates</h2>
          <span className="muted">Start new projects from the structure of one you've already set up.</span>
        </div>
        {templates.isLoading ? (
          <div className="center-msg">Loading templates…</div>
        ) : templates.error ? (
          <div className="empty">{templates.error.message}</div>
        ) : !templates.data?.length ? (
          <div className="empty">
            <h3 style={{ color: "var(--ink)", marginBottom: 8 }}>No templates yet</h3>
            <p>
              Open a project you own and choose <b>Save as template</b> on its overview. {WHAT_TEMPLATES_COPY}
            </p>
          </div>
        ) : (
          <>
            <h3 className="home-heading">Your templates</h3>
            {mine.length ? (
              cards(mine)
            ) : (
              <p className="muted">
                You haven't saved any. Open a project you own and choose <b>Save as template</b> on its overview.
              </p>
            )}
            {shared.length > 0 && (
              <>
                <h3 className="home-heading">Shared with you</h3>
                {cards(shared)}
              </>
            )}
            <p className="muted inbox-note">
              {WHAT_TEMPLATES_COPY} To change a template's content, set up a project the way you want it and choose{" "}
              <b>Save as template</b>, then <b>Update a template</b>.
            </p>
          </>
        )}
        {using && <ProjectDialog project={null} templateId={using} onClose={() => setUsing(null)} />}
        {editing && <TemplateDialog template={editing} onClose={() => setEditing(null)} />}
      </main>
    </>
  );
}

function TemplateCard({ template: t, onUse, onEdit }: { template: ProjectTemplate; onUse: () => void; onEdit: () => void }) {
  const del = useDeleteTemplate();
  const source = useProjects().data?.find((p) => p.id === t.sourceProjectId);

  async function remove() {
    if (!confirm(`Delete the template "${t.name}"? Projects already made from it aren't affected.`)) return;
    try {
      await del.mutateAsync(t.id);
    } catch (err) {
      alert((err as Error).message);
    }
  }

  return (
    <div className="panel plan-card template-card">
      <h3>
        {t.name} <span className="plan-state closed">{templateAudience(t)}</span>
      </h3>
      <div className="plan-meta">
        <span>{templateSummary(t.counts)}</span>
      </div>
      {t.description.trim() && <MarkdownView source={t.description} />}
      <div className="plan-meta">
        <span>Updated {formatDateTime(t.updatedAt)}</span>
        {source && (
          <span>
            Saved from <Link to={`/projects/${source.id}/overview`}>{source.name}</Link>
          </span>
        )}
      </div>
      <div className="template-actions">
        <button className="btn sm primary" onClick={onUse}>
          Use template
        </button>
        {t.isOwner && (
          <>
            <button className="btn sm" onClick={onEdit}>
              Edit and share
            </button>
            <button className="btn sm danger" onClick={remove} disabled={del.isPending}>
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  );
}
