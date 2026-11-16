import { useRef, useState, type DragEvent } from "react";
import { INLINE_ATTACHMENT_TYPES, MAX_ATTACHMENT_BYTES, type Attachment } from "@rpit/shared";
import {
  attachmentUrl,
  useAttachments,
  useDeleteAttachment,
  useUploadAttachment,
  type AttachmentTarget,
} from "../api/hooks.ts";
import { formatBytes, formatDateTime } from "../lib/format.ts";

const isImage = (f: Attachment) => (INLINE_ATTACHMENT_TYPES as readonly string[]).includes(f.contentType);
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

/**
 * Files on a task, a test case, or (with neither id) the project itself.
 * Editors add files with the button or by dropping them on the section, and
 * delete them; everyone can open and download. Images get a thumbnail and
 * open in a new tab; other files download.
 */
export function Attachments(props: AttachmentTarget & { projectId: string; canEdit: boolean; heading?: string }) {
  const { projectId, taskId, testCaseId, canEdit } = props;
  const all = useAttachments(projectId);
  const upload = useUploadAttachment(projectId);
  const del = useDeleteAttachment(projectId);
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [over, setOver] = useState(false);

  const files = (all.data ?? []).filter((f) =>
    taskId ? f.taskId === taskId : testCaseId ? f.testCaseId === testCaseId : !f.taskId && !f.testCaseId,
  );

  async function add(list: File[]) {
    const problems: string[] = [];
    const ok = list.filter((f) => {
      if (f.size <= MAX_ATTACHMENT_BYTES) return true;
      problems.push(`${f.name} is too large (the limit is ${formatBytes(MAX_ATTACHMENT_BYTES)}).`);
      return false;
    });
    setErrors(problems);
    setUploading((n) => n + ok.length);
    // One at a time keeps memory use down and the order the files were picked in.
    for (const file of ok) {
      try {
        await upload.mutateAsync({ file, taskId, testCaseId });
      } catch (err) {
        problems.push(`${file.name}: ${(err as Error).message}`);
        setErrors([...problems]);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  async function remove(f: Attachment) {
    if (!confirm(`Delete ${f.filename}?`)) return;
    try {
      await del.mutateAsync(f.id);
    } catch (err) {
      setErrors([(err as Error).message]);
    }
  }

  const dropProps = canEdit
    ? {
        onDragOver: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setOver(true);
        },
        onDragLeave: (e: DragEvent) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
        },
        onDrop: (e: DragEvent) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          setOver(false);
          void add(Array.from(e.dataTransfer.files));
        },
      }
    : {};

  return (
    <section className={`attachments ${over ? "over" : ""}`} aria-label={props.heading ?? "Attachments"} {...dropProps}>
      <div className="attachments-head">
        <h3>
          {props.heading ?? "Attachments"} ({files.length})
        </h3>
        {canEdit && (
          <>
            <button type="button" className="btn sm" onClick={() => input.current?.click()} disabled={uploading > 0}>
              {uploading ? `Uploading ${uploading}…` : "Add files"}
            </button>
            <input
              ref={input}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                void add(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
          </>
        )}
      </div>
      {all.isLoading && <div className="muted">Loading files…</div>}
      {!all.isLoading && !files.length && (
        <div className="muted">{canEdit ? "No files yet. Drop files here or choose Add files." : "No files."}</div>
      )}
      {files.length > 0 && (
        <ul className="file-list">
          {files.map((f) => (
            <li key={f.id}>
              {isImage(f) ? (
                <a className="thumb" href={attachmentUrl(f.id)} target="_blank" rel="noopener" tabIndex={-1} aria-hidden>
                  <img src={attachmentUrl(f.id)} alt="" loading="lazy" />
                </a>
              ) : (
                <span className="thumb file-icon" aria-hidden>
                  {(f.filename.split(".").pop() ?? "").slice(0, 4).toUpperCase() || "FILE"}
                </span>
              )}
              <div className="file-main">
                {isImage(f) ? (
                  <a href={attachmentUrl(f.id)} target="_blank" rel="noopener">
                    {f.filename}
                  </a>
                ) : (
                  <a href={attachmentUrl(f.id, true)} download={f.filename}>
                    {f.filename}
                  </a>
                )}
                <div className="muted meta">
                  {formatBytes(f.size)} · {f.uploaderName ?? "Someone"} · {formatDateTime(f.createdAt)}
                </div>
              </div>
              {isImage(f) && (
                <a className="linkbtn" href={attachmentUrl(f.id, true)} download={f.filename}>
                  Download
                </a>
              )}
              {canEdit && (
                <button type="button" className="linkbtn" onClick={() => remove(f)} disabled={del.isPending}>
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {errors.map((e) => (
        <div key={e} className="form-error">
          {e}
        </div>
      ))}
    </section>
  );
}
