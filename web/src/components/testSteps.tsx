import { useRef, type KeyboardEvent } from "react";
import type { TestStep } from "@rpit/shared";
import { MarkdownView } from "./markdown.tsx";

/** A step being edited, with a stable key so React keeps focus while rows move. */
export interface DraftStep extends TestStep {
  key: string;
}

let nextKey = 0;
export const draftSteps = (steps: TestStep[]): DraftStep[] => steps.map((s) => ({ ...s, key: `s${nextKey++}` }));
const blank = (): DraftStep => ({ action: "", expected: "", key: `s${nextKey++}` });

/** Steps to save: trimmed, without rows where both fields are blank. */
export const stepsToSave = (steps: DraftStep[]): TestStep[] =>
  steps
    .map((s) => ({ action: s.action.trim(), expected: s.expected.trim() }))
    .filter((s) => s.action || s.expected);

/** Grows a textarea to fit its text, so steps stay compact but never scroll. */
function autoSize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + 2}px`;
}

/**
 * Edit a test case's ordered steps: each row is an action and its expected
 * result (Markdown, shown rendered when read-only). Rows can be moved up and
 * down, removed, and added; Alt+↑/↓ moves the focused row, and Enter in the
 * last row's expected result adds a new row.
 */
export function StepsEditor({ steps, onChange, readOnly }: { steps: DraftStep[]; onChange: (s: DraftStep[]) => void; readOnly?: boolean }) {
  const list = useRef<HTMLOListElement>(null);

  if (readOnly) {
    const shown = stepsToSave(steps);
    return (
      <div className="field">
        <span>Steps</span>
        {shown.length ? (
          <ol className="steps-view">
            {shown.map((s, i) => (
              <li key={i}>
                <div className="step-action">{s.action ? <MarkdownView source={s.action} /> : <i className="muted">No action</i>}</div>
                {s.expected && (
                  <div className="step-expected">
                    <span className="muted">Expected</span>
                    <MarkdownView source={s.expected} />
                  </div>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <span className="muted">No steps.</span>
        )}
      </div>
    );
  }

  const update = (i: number, patch: Partial<TestStep>) => onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const focusRow = (i: number, field: "action" | "expected" = "action") =>
    requestAnimationFrame(() =>
      list.current?.querySelectorAll<HTMLTextAreaElement>(`textarea[data-field="${field}"]`)[i]?.focus(),
    );
  const move = (i: number, by: -1 | 1, field?: "action" | "expected") => {
    const j = i + by;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
    if (field) focusRow(j, field);
  };
  const add = (at = steps.length) => {
    onChange([...steps.slice(0, at), blank(), ...steps.slice(at)]);
    focusRow(at);
  };
  const keys = (i: number, field: "action" | "expected") => (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      move(i, e.key === "ArrowUp" ? -1 : 1, field);
    } else if (e.key === "Enter" && !e.shiftKey && field === "expected" && i === steps.length - 1) {
      e.preventDefault();
      add();
    }
  };

  return (
    <div className="field" role="group" aria-label="Steps">
      <span>Steps</span>
      {steps.length > 0 && (
        <ol className="steps-edit" ref={list}>
          {steps.map((s, i) => (
            <li key={s.key}>
              <span className="step-num" aria-hidden>
                {i + 1}
              </span>
              <textarea
                data-field="action"
                rows={1}
                ref={autoSize}
                value={s.action}
                placeholder="Action"
                aria-label={`Step ${i + 1} action`}
                maxLength={5_000}
                onChange={(e) => {
                  autoSize(e.target);
                  update(i, { action: e.target.value });
                }}
                onKeyDown={keys(i, "action")}
              />
              <textarea
                data-field="expected"
                rows={1}
                ref={autoSize}
                value={s.expected}
                placeholder="Expected result"
                aria-label={`Step ${i + 1} expected result`}
                maxLength={5_000}
                onChange={(e) => {
                  autoSize(e.target);
                  update(i, { expected: e.target.value });
                }}
                onKeyDown={keys(i, "expected")}
              />
              <span className="step-tools">
                <button type="button" className="btn sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move step ${i + 1} up`}>
                  ↑
                </button>
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => move(i, 1)}
                  disabled={i === steps.length - 1}
                  aria-label={`Move step ${i + 1} down`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="btn sm danger"
                  onClick={() => onChange(steps.filter((_, j) => j !== i))}
                  aria-label={`Remove step ${i + 1}`}
                >
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
      <div>
        <button type="button" className="btn sm" onClick={() => add()}>
          Add step
        </button>
        <span className="muted step-hint"> Markdown works in steps. Alt+↑/↓ moves a step.</span>
      </div>
    </div>
  );
}
