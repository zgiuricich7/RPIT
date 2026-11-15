import { useEffect, useRef, type ReactNode } from "react";
import {
  PRIORITY_LABELS,
  TASK_STATUS_LABELS,
  TEST_STATUS_LABELS,
  type Priority,
  type TaskStatus,
  type TestStatus,
  type User,
} from "@rpit/shared";
import { pct } from "../lib/format.ts";

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

export const TaskStatusPill = ({ status }: { status: TaskStatus }) => (
  <span className={`pill s-${status}`}>{TASK_STATUS_LABELS[status]}</span>
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
