import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  getFirstCollision,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  type SortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ancestors,
  buildTree,
  childrenIndex,
  compareTasks,
  flattenTree,
  leafProgress,
  matchesWithAncestors,
  projectTreeDrop,
  type TaskFilter,
  type BoardColumn as Column,
  type FlatRow,
  type Label,
  type TaskCoverage,
  type Task,
  type TaskSort,
  type User,
} from "@rpit/shared";
import { useMoveTask } from "../api/hooks.ts";
import { useDialogs } from "../components/dialogs.tsx";
import { AssigneeName, DueDate, Meter, TaskLabels, TaskStatusPill, priorityLabel } from "../components/ui.tsx";
import { CoverageBadge } from "../components/coverage.tsx";
import { formatDate } from "../lib/format.ts";

/**
 * List and board views with drag and drop (@dnd-kit: mouse, touch and keyboard).
 * Moves go through useMoveTask, which sends the dropped task's new neighbours;
 * the server turns them into a position (see TaskMove / positionBetween).
 */

/** Filters and sort order from the URL (see TaskFilter), plus what the views need to apply them. */
export interface ViewOptions {
  filter: TaskFilter;
  /** True for tasks that pass every filter. */
  matches: (t: Task) => boolean;
  /** Any filter is narrowing the list. */
  filtered: boolean;
  sort: TaskSort;
  today: string;
  /** The project's labels, for showing tasks' label chips. */
  labels: Label[];
  /** The project's board columns, left to right (custom statuses). */
  columns: Column[];
  /** Linked test results per task, rolled up through subtasks. */
  coverage: Map<string, TaskCoverage>;
}

/** Pixels per tree level: indentation, and how far to drag sideways to nest or un-nest. */
const INDENT = 22;

/**
 * Mouse drags start after 5px so clicks still open tasks; touch drags start
 * after a 250ms press so the page still scrolls; keyboard: focus the handle or
 * card, Space to pick up, arrows to move, Space to drop, Escape to cancel.
 */
function useDragSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

/** Screen reader announcements that use task titles instead of ids. */
function announcements(title: (id: UniqueIdentifier | undefined) => string): Announcements {
  return {
    onDragStart: ({ active }) => `Picked up ${title(active.id)}.`,
    onDragOver: ({ active, over }) => (over ? `${title(active.id)} is over ${title(over.id)}.` : `${title(active.id)} is not over a drop target.`),
    onDragEnd: ({ active, over }) => (over ? `Dropped ${title(active.id)} at ${title(over.id)}.` : `Dropped ${title(active.id)}.`),
    onDragCancel: ({ active }) => `Cancelled moving ${title(active.id)}.`,
  };
}

const screenReaderInstructions = {
  draggable:
    "To pick up a task, press Space or Enter. Use the arrow keys to move it, Space or Enter to drop it, or Escape to cancel.",
};

// ---------------------------------------------------------------------------
// List: drag a row's handle up or down to reorder, sideways to nest or un-nest.

export function ListView(props: { projectId: string; tasks: Task[]; users: User[] | undefined; canEdit: boolean; opts: ViewOptions }) {
  const { projectId, tasks, users, canEdit, opts } = props;
  const { matches, filtered, sort, today, labels, columns, coverage } = opts;
  const move = useMoveTask(projectId);
  const sensors = useDragSensors();
  // Order and nesting only mean something in manual order with every task shown.
  const draggable = canEdit && !filtered && sort === "manual";

  // Matching tasks plus their ancestors (dimmed, for context); null when nothing is filtered out.
  const visible = useMemo(
    () => (filtered ? matchesWithAncestors(tasks, matches) : null),
    [tasks, filtered, matches],
  );
  const shown = useMemo(() => (visible ? tasks.filter((t) => visible.has(t.id)) : tasks), [tasks, visible]);
  const tree = useMemo(() => buildTree(shown, compareTasks(sort)), [shown, sort]);
  const kids = useMemo(() => childrenIndex(shown), [shown]);
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const parents = useMemo(() => [...kids.keys()].filter((k): k is string => !!k), [kids]);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [offsetX, setOffsetX] = useState(0);

  // While dragging, the dragged row's subtree is hidden: it moves with its parent.
  const rows = useMemo(() => flattenTree(tree, collapsed, activeId), [tree, collapsed, activeId]);
  const projection =
    activeId && overId ? projectTreeDrop(rows, activeId, overId, Math.round(offsetX / INDENT)) : null;

  const toggle = (id: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const reset = () => {
    setActiveId(null);
    setOverId(null);
    setOffsetX(0);
  };
  const onDragEnd = () => {
    const t = activeId ? byId.get(activeId) : undefined;
    if (t && projection && overId) {
      const unchanged = overId === activeId && projection.parentId === t.parentId;
      if (!unchanged) {
        move.mutate({
          id: t.id,
          parentId: projection.parentId,
          afterId: projection.afterId,
          beforeId: projection.beforeId,
        });
        // Show where it went.
        const parent = projection.parentId;
        if (parent) {
          setCollapsed((s) => {
            if (!s.has(parent)) return s;
            const n = new Set(s);
            n.delete(parent);
            return n;
          });
        }
      }
    }
    reset();
  };

  const title = (id: UniqueIdentifier | undefined) => (id ? (byId.get(String(id))?.title ?? "task") : "task");

  if (!rows.length) {
    return <div className="empty">No tasks match this filter.</div>;
  }
  return (
    <>
      <div className="toolbar">
        <button className="btn sm" onClick={() => setCollapsed(new Set())}>
          Expand all
        </button>
        <button className="btn sm" onClick={() => setCollapsed(new Set(parents))}>
          Collapse all
        </button>
        {canEdit && (
          <span className="muted hint">
            {draggable
              ? "Drag ⠿ to reorder; drag right to make a subtask, left to move it out."
              : "Clear filters and use manual order to drag tasks."}
          </span>
        )}
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        accessibility={{ announcements: announcements(title), screenReaderInstructions }}
        onDragStart={({ active }: DragStartEvent) => {
          setActiveId(String(active.id));
          setOverId(String(active.id));
        }}
        onDragMove={({ delta }) => setOffsetX(delta.x)}
        onDragOver={({ over }: DragOverEvent) => setOverId(over ? String(over.id) : null)}
        onDragEnd={onDragEnd}
        onDragCancel={reset}
      >
        <SortableContext items={rows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
          <div className="scroll-x">
            <table className="grid">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Status</th>
                  <th>Priority</th>
                  <th>Assignee</th>
                  <th>Start</th>
                  <th>Due</th>
                  <th>Progress</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <TaskRow
                    key={row.id}
                    row={row}
                    task={byId.get(row.id)!}
                    depth={row.id === activeId && projection ? projection.depth : row.depth}
                    childCount={(kids.get(row.id) ?? []).length}
                    open={!collapsed.has(row.id)}
                    onToggle={() => toggle(row.id)}
                    context={filtered && !matches(byId.get(row.id)!)}
                    {...{ tasks, users, canEdit, draggable, today, labels, columns }}
                    coverage={coverage.get(row.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </SortableContext>
      </DndContext>
    </>
  );
}

function TaskRow(props: {
  row: FlatRow;
  task: Task;
  depth: number;
  childCount: number;
  open: boolean;
  onToggle: () => void;
  context: boolean;
  tasks: Task[];
  users: User[] | undefined;
  canEdit: boolean;
  draggable: boolean;
  today: string;
  labels: Label[];
  columns: Column[];
  coverage: TaskCoverage | undefined;
}) {
  const { task: t, depth, childCount, open, tasks, users, canEdit, draggable, today, labels, columns } = props;
  const dialogs = useDialogs();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: t.id,
    disabled: !draggable,
  });
  // Rows only move vertically: the sideways drag shows up as the projected indentation instead.
  const style: CSSProperties = { transform: CSS.Translate.toString(transform && { ...transform, x: 0 }), transition };
  const cls = [props.context && "context", isDragging && "dragging"].filter(Boolean).join(" ");
  return (
    <tr ref={setNodeRef} style={style} className={cls || undefined}>
      <td>
        <div className="tree-name" style={{ paddingLeft: depth * INDENT }}>
          {draggable && (
            <button
              ref={setActivatorNodeRef}
              className="drag-handle"
              aria-label={`Move ${t.title}`}
              {...attributes}
              {...listeners}
            >
              ⠿
            </button>
          )}
          <button
            className={`toggle ${childCount ? "" : "hidden"}`}
            onClick={props.onToggle}
            aria-label={open ? "Collapse subtasks" : "Expand subtasks"}
            aria-expanded={open}
          >
            {open ? "▼" : "▶"}
          </button>
          <button className={`title-btn ${t.status === "done" ? "done" : ""}`} onClick={() => dialogs.openTask(t.id)}>
            {t.title}
          </button>
          <TaskLabels ids={t.labelIds} labels={labels} />
          <CoverageBadge coverage={props.coverage} />
          {isDragging && childCount > 0 && (
            <span className="comment-count">
              +{childCount} subtask{childCount > 1 ? "s" : ""}
            </span>
          )}
          {t.commentCount > 0 && <span className="comment-count">💬 {t.commentCount}</span>}
        </div>
      </td>
      <td>
        <TaskStatusPill task={t} columns={columns} />
      </td>
      <td>{priorityLabel(t.priority)}</td>
      <td>
        <AssigneeName id={t.assigneeId} users={users} />
      </td>
      <td>{t.startDate ? formatDate(t.startDate) : <span className="muted">—</span>}</td>
      <td>
        <DueDate task={t} today={today} compact />
      </td>
      <td>{childCount > 0 && <Meter {...leafProgress(tasks, t.id)} />}</td>
      <td className="actions">
        {canEdit && (
          <button className="btn sm" onClick={() => dialogs.newTask(t.id)}>
            Add subtask
          </button>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Board: drag cards between columns to change status, and within a column to reorder.

/** Task ids per board column id. */
type Columns = Record<string, string[]>;
const COLUMN_PREFIX = "column:";
/** In a sorted board, cards keep their sorted place: no reorder preview inside a column. */
const noReorder: SortingStrategy = () => null;

export function BoardView(props: { projectId: string; tasks: Task[]; users: User[] | undefined; canEdit: boolean; opts: ViewOptions }) {
  const { projectId, tasks, users, canEdit } = props;
  const { filter, matches, sort, today, labels } = props.opts;
  // Filtering by status shows just those columns (by id, or every column of a built-in status).
  const boardColumns = props.opts.columns;
  const visible = filter.status.length
    ? boardColumns.filter((c) => filter.status.includes(c.id) || filter.status.includes(c.category))
    : boardColumns;
  const columnIds = useMemo(() => boardColumns.map((c) => c.id), [boardColumns]);
  const columnById = useMemo(() => new Map(boardColumns.map((c) => [c.id, c])), [boardColumns]);
  const move = useMoveTask(projectId);
  const sensors = useDragSensors();
  const [leafOnly, setLeafOnly] = useState(false);
  const idx = useMemo(() => childrenIndex(tasks), [tasks]);
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const hasKids = (id: string) => (idx.get(id) ?? []).length > 0;
  const reorderable = sort === "manual";

  const columns = useMemo(() => {
    const out = Object.fromEntries(columnIds.map((c) => [c, [] as Task[]])) as Record<string, Task[]>;
    for (const t of tasks) {
      if ((!leafOnly || !hasKids(t.id)) && matches(t)) out[t.columnId]?.push(t);
    }
    if (sort !== "manual") for (const c of columnIds) out[c]!.sort(compareTasks(sort));
    return Object.fromEntries(columnIds.map((c) => [c, out[c]!.map((t) => t.id)])) as Columns;
  }, [tasks, leafOnly, matches, sort, idx, columnIds]);

  // While dragging, a working copy of the columns so the card previews in its new place.
  const [draft, setDraft] = useState<Columns | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const shown = draft ?? columns;

  /*
   * Collision detection for several columns, after dnd-kit's multiple-containers
   * example. The pointer decides which column you're over (the dragged card's
   * own rect can overlap two columns and make the target flip between them on
   * every render), then the closest card inside that column. Right after a card
   * changes column, layout is still settling: keep the previous target for a
   * frame so the move can't bounce back and loop.
   */
  const lastOverId = useRef<UniqueIdentifier | null>(null);
  const movedColumn = useRef(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      movedColumn.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [draft]);
  const collisionDetection: CollisionDetection = useCallback(
    (args) => {
      const byPointer = pointerWithin(args);
      let overId = getFirstCollision(byPointer.length ? byPointer : rectIntersection(args), "id");
      if (overId != null) {
        const id = String(overId);
        if (id.startsWith(COLUMN_PREFIX)) {
          const cards = shown[id.slice(COLUMN_PREFIX.length)] ?? [];
          if (cards.length) {
            const inColumn = args.droppableContainers.filter((c) => c.id !== id && cards.includes(String(c.id)));
            overId = closestCenter({ ...args, droppableContainers: inColumn })[0]?.id ?? overId;
          }
        }
        lastOverId.current = overId;
        return [{ id: overId }];
      }
      if (movedColumn.current) lastOverId.current = activeId;
      return lastOverId.current != null ? [{ id: lastOverId.current }] : [];
    },
    [activeId, shown],
  );

  const columnOf = (id: UniqueIdentifier, cols: Columns): string | null => {
    const s = String(id);
    if (s.startsWith(COLUMN_PREFIX)) return s.slice(COLUMN_PREFIX.length);
    return columnIds.find((c) => cols[c]?.includes(s)) ?? null;
  };

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) return;
    const cols = draft ?? columns;
    const from = columnOf(active.id, cols);
    const to = columnOf(over.id, cols);
    if (!from || !to || from === to) return;
    // Moving into another column: insert before the hovered card, or after it when the dragged card is
    // past its middle (so the bottom of a column means "last"), or at the end over empty column space.
    const target = (cols[to] ?? []).filter((id) => id !== active.id);
    const at = target.indexOf(String(over.id));
    const dragged = active.rect.current.translated;
    const below = !!dragged && dragged.top + dragged.height / 2 > over.rect.top + over.rect.height / 2;
    target.splice(at < 0 ? target.length : at + (below ? 1 : 0), 0, String(active.id));
    movedColumn.current = true;
    setDraft({ ...cols, [from]: (cols[from] ?? []).filter((id) => id !== active.id), [to]: target });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const cols = draft ?? columns;
    setDraft(null);
    setActiveId(null);
    const t = byId.get(String(active.id));
    const columnId = over ? columnOf(over.id, cols) : null;
    if (!t || !columnId) return;
    let list = cols[columnId] ?? [];
    const from = list.indexOf(t.id);
    const to = over && !String(over.id).startsWith(COLUMN_PREFIX) ? list.indexOf(String(over.id)) : from;
    if (from >= 0 && to >= 0 && from !== to) list = arrayMove(list, from, to);

    if (!reorderable) {
      // Sorted board: only the column (status) can change.
      if (columnId !== t.columnId) move.mutate({ id: t.id, columnId });
      return;
    }
    const i = list.indexOf(t.id);
    const afterId = list[i - 1] ?? null;
    const beforeId = list[i + 1] ?? null;
    const old = columns[t.columnId] ?? [];
    const oi = old.indexOf(t.id);
    const same = columnId === t.columnId;
    const samePlace = same && (old[oi - 1] ?? null) === afterId && (old[oi + 1] ?? null) === beforeId;
    if (!samePlace) move.mutate({ id: t.id, columnId: same ? undefined : columnId, afterId, beforeId });
  };

  const title = (id: UniqueIdentifier | undefined) => {
    const s = String(id ?? "");
    if (s.startsWith(COLUMN_PREFIX)) return `the ${columnById.get(s.slice(COLUMN_PREFIX.length))?.name ?? ""} column`;
    return byId.get(s)?.title ?? "task";
  };
  const active = activeId ? byId.get(activeId) : undefined;
  const overColumn = activeId ? columnOf(activeId, shown) : null;

  return (
    <>
      <div className="toolbar">
        <label className="check">
          <input type="checkbox" checked={leafOnly} onChange={(e) => setLeafOnly(e.target.checked)} />
          Show only tasks with no subtasks
        </label>
        {canEdit && !reorderable && (
          <span className="muted hint">Sorted by date: drag between columns to change status. Switch to manual order to reorder.</span>
        )}
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        accessibility={{ announcements: announcements(title), screenReaderInstructions }}
        onDragStart={({ active }) => setActiveId(String(active.id))}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={() => {
          setDraft(null);
          setActiveId(null);
        }}
      >
        <div className="board" style={{ "--board-cols": visible.length } as CSSProperties}>
          {visible.map((column) => (
            <BoardColumn
              key={column.id}
              column={column}
              count={(shown[column.id] ?? []).length}
              highlight={!!activeId && overColumn === column.id}
              ids={shown[column.id] ?? []}
              strategy={reorderable ? verticalListSortingStrategy : noReorder}
            >
              {(shown[column.id] ?? []).map((id) => {
                const t = byId.get(id);
                return t ? <BoardCard key={id} task={t} {...{ tasks, users, canEdit, today, labels }} hasKids={hasKids(id)} /> : null;
              })}
            </BoardColumn>
          ))}
        </div>
        <DragOverlay>
          {active && (
            <CardBody task={active} tasks={tasks} users={users} canEdit={false} today={today} labels={labels} hasKids={hasKids(active.id)} />
          )}
        </DragOverlay>
      </DndContext>
    </>
  );
}

function BoardColumn(props: {
  column: Column;
  count: number;
  highlight: boolean;
  ids: string[];
  strategy: SortingStrategy;
  children: ReactNode;
}) {
  const { column } = props;
  // The column itself is a drop target so empty columns (and the space below the last card) accept drops.
  const { setNodeRef } = useDroppable({ id: COLUMN_PREFIX + column.id });
  return (
    <section ref={setNodeRef} className={`column ${props.highlight ? "over" : ""}`} aria-label={column.name}>
      <h3>
        <span className={`s-${column.category}`}>{column.name}</span>
        <span>{props.count}</span>
      </h3>
      <SortableContext items={props.ids} strategy={props.strategy}>
        {props.children}
      </SortableContext>
    </section>
  );
}

interface CardProps {
  task: Task;
  tasks: Task[];
  users: User[] | undefined;
  canEdit: boolean;
  today: string;
  labels: Label[];
  hasKids: boolean;
}

function BoardCard(props: CardProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: props.task.id,
    disabled: !props.canEdit,
  });
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition };
  return (
    <div
      ref={(el) => {
        setNodeRef(el);
        setActivatorNodeRef(el);
      }}
      style={style}
      className={`card-slot ${isDragging ? "dragging" : ""}`}
      {...attributes}
      {...listeners}
      // The card holds buttons, so it can't itself be a button; it's a focusable group you can pick up.
      role="group"
      aria-label={props.task.title}
    >
      <CardBody {...props} />
    </div>
  );
}

function CardBody({ task: t, tasks, users, canEdit, today, labels, hasKids }: CardProps) {
  const dialogs = useDialogs();
  const crumb = ancestors(tasks, t.id)
    .map((a) => a.title)
    .join(" / ");
  return (
    <article className={`card p-${t.priority}`}>
      {crumb && <div className="crumb">{crumb}</div>}
      <button className="title-btn" onClick={() => dialogs.openTask(t.id)}>
        {t.title}
      </button>
      {t.labelIds.length > 0 && (
        <div className="card-labels">
          <TaskLabels ids={t.labelIds} labels={labels} />
        </div>
      )}
      {hasKids && <Meter {...leafProgress(tasks, t.id)} />}
      {t.dueDate && (
        <div className="card-due">
          <DueDate task={t} today={today} />
        </div>
      )}
      <div className="meta">
        <span>
          <AssigneeName id={t.assigneeId} users={users} />
          {t.commentCount > 0 && <span className="comment-count">💬 {t.commentCount}</span>}
        </span>
        {canEdit && (
          <button className="btn sm" onClick={() => dialogs.newTask(t.id)}>
            Add subtask
          </button>
        )}
      </div>
    </article>
  );
}
