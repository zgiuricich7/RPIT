import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";
import type { ProjectEvent } from "@rpit/shared";
import type { DB } from "./db/index.ts";
import { afterCommit } from "./db/index.ts";

/**
 * Real-time updates. `logActivity` publishes a ProjectEvent for every audited
 * write once its transaction commits; `GET /api/projects/:id/events` streams
 * them to project members as server-sent events (see routes/events.ts).
 *
 * In-process only: fine for the single-server SQLite deployment. Running more
 * than one server process would need a shared broker (e.g. Postgres LISTEN/NOTIFY).
 */

/** Header the web app sends with every request so a tab can skip events caused by its own writes. */
export const CLIENT_ID_HEADER = "x-rpit-client";

const requestContext = new AsyncLocalStorage<{ clientId: string | null }>();

/** Middleware: remembers the calling tab's client id for events published during this request. */
export function trackClientId(req: Request, _res: Response, next: NextFunction) {
  const id = req.get(CLIENT_ID_HEADER);
  requestContext.run({ clientId: id && id.length <= 64 ? id : null }, next);
}

export interface Subscriber {
  /** Client id of the tab listening; events it caused aren't sent back to it. */
  clientId: string | null;
  send: (event: ProjectEvent) => void;
}

export interface Published {
  event: ProjectEvent;
  originClientId: string | null;
}

export class EventHub {
  private subs = new Map<string, Set<Subscriber>>();

  subscribe(projectId: string, sub: Subscriber): () => void {
    let set = this.subs.get(projectId);
    if (!set) this.subs.set(projectId, (set = new Set()));
    set.add(sub);
    return () => {
      set.delete(sub);
      if (!set.size && this.subs.get(projectId) === set) this.subs.delete(projectId);
    };
  }

  publish({ event, originClientId }: Published) {
    for (const sub of [...(this.subs.get(event.projectId) ?? [])]) {
      if (originClientId && sub.clientId === originClientId) continue;
      sub.send(event);
    }
  }

  subscriberCount(projectId: string) {
    return this.subs.get(projectId)?.size ?? 0;
  }
}

const hubs = new WeakMap<DB, EventHub>();

/** The event hub for a database (one per app; tests each get their own). */
export function eventHub(db: DB): EventHub {
  let hub = hubs.get(db);
  if (!hub) hubs.set(db, (hub = new EventHub()));
  return hub;
}

/** Publish `event` after the current transaction commits. Called by logActivity. */
export function publishEvent(db: DB, event: ProjectEvent) {
  const originClientId = requestContext.getStore()?.clientId ?? null;
  afterCommit(db, () => eventHub(db).publish({ event, originClientId }));
}
