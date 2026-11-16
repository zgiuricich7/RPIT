import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ASSIGNEE_ME,
  ASSIGNEE_NONE,
  DUE_FILTER_LABELS,
  EMPTY_TASK_FILTER,
  PRIORITIES,
  PRIORITY_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  activeFilterCount,
  type DueFilter,
  type Member,
  type TaskFilter,
} from "@rpit/shared";
import { Options } from "./ui.tsx";

/** How long typing pauses before the search is written to the URL. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Filter bar for the list and board. Controlled by `filter` (parsed from the
 * URL by the page); every change calls `onChange` with the whole new filter.
 * `shown` / `total` drive the "3 of 12 tasks" count.
 */
export function TaskFilters(props: {
  filter: TaskFilter;
  onChange: (f: TaskFilter, opts?: { replace?: boolean }) => void;
  members: Member[];
  meId: string | null;
  shown: number;
  total: number;
}) {
  const { filter, onChange, members, meId } = props;
  const set = <K extends keyof TaskFilter>(k: K, v: TaskFilter[K]) => onChange({ ...filter, [k]: v });
  const active = activeFilterCount(filter);

  const assigneeOptions: [string, string][] = [
    [ASSIGNEE_ME, "Me"],
    [ASSIGNEE_NONE, "Unassigned"],
    ...members.filter((m) => m.userId !== meId).map((m): [string, string] => [m.userId, m.name]),
  ];

  return (
    <div className="filters" role="search" aria-label="Filter tasks">
      <SearchBox value={filter.q} onChange={(q) => onChange({ ...filter, q }, { replace: true })} />
      <FilterMenu label="Assignee" options={assigneeOptions} selected={filter.assignee} onChange={(v) => set("assignee", v)} />
      <FilterMenu
        label="Priority"
        options={PRIORITIES.map((p) => [p, PRIORITY_LABELS[p]])}
        selected={filter.priority}
        onChange={(v) => set("priority", v as TaskFilter["priority"])}
      />
      <FilterMenu
        label="Status"
        options={TASK_STATUSES.map((s) => [s, TASK_STATUS_LABELS[s]])}
        selected={filter.status}
        onChange={(v) => set("status", v as TaskFilter["status"])}
      />
      <select
        className={`inline ${filter.due !== "all" ? "on" : ""}`}
        aria-label="Filter by due date"
        value={filter.due}
        onChange={(e) => set("due", e.target.value as DueFilter)}
      >
        <Options labels={DUE_FILTER_LABELS} />
      </select>
      {active > 0 && (
        <>
          <span className="muted filter-count" aria-live="polite">
            {props.shown} of {props.total} tasks
          </span>
          <button className="btn sm" onClick={() => onChange(EMPTY_TASK_FILTER)}>
            Clear filters
          </button>
        </>
      )}
    </div>
  );
}

/** Search input. Writes to the URL after a pause; press "/" anywhere on the page to focus it. */
function SearchBox({ value, onChange }: { value: string; onChange: (q: string) => void }) {
  const [text, setText] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Follow outside changes (Clear filters, back button).
  useEffect(() => setText(value), [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
      if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && !document.querySelector("dialog[open]")) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const update = (q: string, now = false) => {
    setText(q);
    clearTimeout(timer.current);
    if (now) onChange(q);
    else timer.current = setTimeout(() => onChange(q), SEARCH_DEBOUNCE_MS);
  };

  return (
    <input
      ref={ref}
      type="search"
      className="search"
      placeholder="Search tasks  /"
      aria-label="Search tasks by title or description"
      value={text}
      maxLength={200}
      onChange={(e) => update(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") update(text, true);
        if (e.key === "Escape" && text) {
          e.preventDefault();
          update("", true);
        }
      }}
    />
  );
}

/**
 * A dropdown checklist ("Priority: High, Low"). Built on <details> so it opens
 * with the keyboard and works without extra libraries; closes on an outside
 * click or Escape.
 */
function FilterMenu(props: {
  label: string;
  options: [value: string, label: string][];
  selected: string[];
  onChange: (values: string[]) => void;
}) {
  const { label, options, selected, onChange } = props;
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const names = options.filter(([v]) => selected.includes(v)).map(([, l]) => l);
  // Ids from a shared link for people who aren't members here still count, but have no name to show.
  const unknown = selected.length - names.length;
  const summary: ReactNode = !selected.length ? (
    <>{label}</>
  ) : (
    <>
      {label}: <b>{names.length ? names[0] : `${unknown} other`}</b>
      {selected.length > 1 && ` +${selected.length - 1}`}
    </>
  );

  const toggle = (v: string) => onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);

  return (
    <details
      ref={ref}
      className={`filter-menu ${selected.length ? "on" : ""}`}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && ref.current?.open) {
          e.preventDefault();
          ref.current.open = false;
          ref.current.querySelector("summary")?.focus();
        }
      }}
    >
      <summary aria-label={selected.length ? `${label}: ${names.join(", ")}` : `Filter by ${label.toLowerCase()}`}>
        {summary}
      </summary>
      <div className="filter-pop" role="group" aria-label={label}>
        {options.map(([v, l]) => (
          <label key={v} className="check">
            <input type="checkbox" checked={selected.includes(v)} onChange={() => toggle(v)} />
            {l}
          </label>
        ))}
        {selected.length > 0 && (
          <button type="button" className="linkbtn" onClick={() => onChange([])}>
            Clear
          </button>
        )}
      </div>
    </details>
  );
}
