import { addDays, toCalendarDate, type NotificationKind } from "@rpit/shared";
import type { DB } from "./db/index.ts";
import { transaction } from "./db/index.ts";
import { notify } from "./notify.ts";

/**
 * Due-date reminders. For open tasks with `remind_assignee` on and an assignee,
 * the assignee gets an in-app notification:
 * - `task_starts`   on the start date (skipped when the task is also due that day),
 * - `task_due_soon` the day before the due date,
 * - `task_due`      on the due date.
 *
 * `task_reminders` records what was sent, so each reminder goes out once per
 * (task, kind, date) however often the job runs; moving a date allows a new one.
 * "Today" is the server's local date. A reminder whose day passed while the
 * server was down is not sent late.
 */

/** How often the server checks for reminders to send. */
export const REMINDER_INTERVAL_MS = 15 * 60_000;

interface Candidate {
  id: string;
  project_id: string;
  assignee_id: string;
  start_date: string | null;
  due_date: string | null;
}

/** Send every reminder due on `today` (YYYY-MM-DD). Returns how many were sent. */
export function sendTaskReminders(db: DB, today: string): number {
  const tomorrow = addDays(today, 1);
  const tasks = db
    .prepare(
      `SELECT id, project_id, assignee_id, start_date, due_date FROM tasks
       WHERE remind_assignee = 1 AND assignee_id IS NOT NULL AND status != 'done'
         AND (start_date = ? OR due_date IN (?, ?))`,
    )
    .all(today, today, tomorrow) as unknown as Candidate[];

  const record = db.prepare(`INSERT OR IGNORE INTO task_reminders (task_id, kind, for_date) VALUES (?, ?, ?)`);
  let sent = 0;
  transaction(db, () => {
    for (const t of tasks) {
      const kinds: NotificationKind[] = [];
      if (t.due_date === today) kinds.push("task_due");
      else if (t.start_date === today) kinds.push("task_starts");
      if (t.due_date === tomorrow) kinds.push("task_due_soon");
      for (const kind of kinds) {
        // Only the first run of the day records it; later runs are ignored by the primary key.
        if (Number(record.run(t.id, kind, today).changes) === 0) continue;
        notify(db, { recipients: [t.assignee_id], actorId: null, projectId: t.project_id, kind, taskId: t.id });
        sent++;
      }
    }
  });
  return sent;
}

/** Run now and then every REMINDER_INTERVAL_MS. Returns a function that stops it. */
export function startReminderScheduler(db: DB): () => void {
  const run = () => {
    try {
      sendTaskReminders(db, toCalendarDate(new Date()));
    } catch (err) {
      console.error("Sending task reminders failed", err);
    }
  };
  run();
  const timer = setInterval(run, REMINDER_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
