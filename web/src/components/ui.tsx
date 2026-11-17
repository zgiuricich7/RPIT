import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  dueState,
  toCalendarDate,
  PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  TEST_STATUS_LABELS,
  type BoardColumn,
  type Label,
  type Priority,
  type Task,
  type TestStatus,
  type User,
} from "@rpit/shared";
import { formatDate, pct } from "../lib/format.ts";

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} className="modal" onClose={props.onClose} aria-label={props.title}>
      {props.children}
      {props.footer && <div className="modal-foot">{props.footer}</div>}
    </dialog>
  );
}

/**
 * A task's status: its board column's name, coloured by what the column counts
 * as. Falls back to the built-in status name while columns are loading.
 */
export const TaskStatusPill = ({ task, columns }: { task: Pick<Task, "status" | "columnId">; columns?: BoardColumn[] }) => (
  <span className={`pill s-${task.status}`}>
    {columns?.find((c) => c.id === task.columnId)?.name ?? TASK_STATUS_LABELS[task.status]}
  </span>
);
export const TestStatusPill = ({ status }: { status: TestStatus }) => (
  <span className={`pill s-${status}`}>{TEST_STATUS_LABELS[status]}</span>
);

export function Meter({ done, total }: { done: number; total: number }) {
  return (
    <div className="meter-wrap" aria-label={`${done} of ${total} done`}>
      <div className="meter">
        <i style={{ width: `${pct(done, total)}%` }} />
      </div>
      {done}/{total}
    </div>
  );
}

export function Stack<K extends string>(props: { counts: Record<K, number>; colors: Record<K, string> }) {
  const keys = Object.keys(props.counts) as K[];
  const total = keys.reduce((n, k) => n + props.counts[k], 0);
  return (
    <div className="stack" role="img" aria-label="Distribution">
      {total > 0 && keys.map((k) => <i key={k} style={{ width: `${pct(props.counts[k], total)}%`, background: props.colors[k] }} />)}
    </div>
  );
}

export function AssigneeName({ id, users }: { id: string | null; users: User[] | undefined }) {
  if (!id) return <span className="muted">Unassigned</span>;
  return <>{users?.find((u) => u.id === id)?.name ?? "Unknown user"}</>;
}

/** A label's coloured chip. */
export const LabelChip = ({ label }: { label: Pick<Label, "name" | "color"> }) => (
  <span className={`label-chip lc-${label.color}`}>{label.name}</span>
);

/**
 * A task's labels, in the project's label order (by name). Ids without a
 * loaded label (just deleted, or still loading) are skipped.
 */
export function TaskLabels({ ids, labels }: { ids: string[]; labels: Label[] | undefined }) {
  if (!ids.length || !labels) return null;
  const shown = labels.filter((l) => ids.includes(l.id));
  if (!shown.length) return null;
  return (
    <span className="labels" aria-label={`Labels: ${shown.map((l) => l.name).join(", ")}`}>
      {shown.map((l) => (
        <LabelChip key={l.id} label={l} />
      ))}
    </span>
  );
}

export function Options<K extends string>({ labels }: { labels: Record<K, string> }) {
  return (
    <>
      {(Object.keys(labels) as K[]).map((k) => (
        <option key={k} value={k}>
          {labels[k]}
        </option>
      ))}
    </>
  );
}

export const priorityLabel = (p: Priority) => PRIORITY_LABELS[p];

/** The viewer's local date as YYYY-MM-DD; due states are computed against it. */
export const useToday = () => toCalendarDate(new Date());

/**
 * A task's due date, highlighted when overdue or due today (done tasks are
 * never highlighted). `compact` shows just the date, for table cells.
 */
export function DueDate({ task, today, compact }: { task: Pick<Task, "status" | "dueDate">; today: string; compact?: boolean }) {
  if (!task.dueDate) return compact ? <span className="muted">—</span> : null;
  const state = dueState(task, today);
  const date = formatDate(task.dueDate);
  const full = state === "overdue" ? `Overdue, due ${date}` : state === "today" ? "Due today" : `Due ${date}`;
  const text = compact ? date : state === "overdue" ? `Overdue · ${date}` : full;
  return (
    <span className={`due ${state ?? ""}`} title={full} aria-label={full}>
      {text}
    </span>
  );
}

const COLLAPSED_KEY = "rpit.collapsed";

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * Whether the section `id` is open, remembered in this browser (a per-viewer
 * convenience: it never reaches the server). Sections start open.
 */
export function useCollapsed(id: string, defaultOpen = true): [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState(() => {
    const stored = readCollapsed();
    return defaultOpen ? !stored.has(id) : stored.has(`${id}:open`);
  });
  const setOpen = (next: boolean) => {
    setOpenState(next);
    try {
      const stored = readCollapsed();
      // Only remember the non-default state, so the list stays small.
      const key = defaultOpen ? id : `${id}:open`;
      if (next === defaultOpen) stored.delete(key);
      else stored.add(key);
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...stored]));
    } catch {
      // Storage blocked: the section still toggles, it just isn't remembered.
    }
  };
  return [open, setOpen];
}

/**
 * A section with a heading that shows or hides its body. `storageKey` remembers
 * the choice in this browser; `forceOpen` shows the body regardless (e.g. while
 * searching). The body is only rendered while open, so queries inside it wait.
 */
export function Collapsible(props: {
  storageKey: string;
  title: ReactNode;
  /** Shown after the title, e.g. a count. */
  meta?: ReactNode;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  className?: string;
  /** Heading level of the title. */
  level?: 3 | 4;
  children: () => ReactNode;
}) {
  const [stored, setOpen] = useCollapsed(props.storageKey, props.defaultOpen ?? true);
  const open = props.forceOpen || stored;
  const bodyId = useId();
  const Heading = props.level === 4 ? "h4" : "h3";
  return (
    <section className={`collapsible${open ? " open" : ""}${props.className ? ` ${props.className}` : ""}`}>
      <Heading className="collapsible-head">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          disabled={props.forceOpen}
          onClick={() => setOpen(!open)}
        >
          <span className="chev" aria-hidden="true" />
          <span>{props.title}</span>
          {props.meta !== undefined && <span className="muted collapsible-meta">{props.meta}</span>}
        </button>
      </Heading>
      <div id={bodyId} hidden={!open}>
        {open && props.children()}
      </div>
    </section>
  );
}
