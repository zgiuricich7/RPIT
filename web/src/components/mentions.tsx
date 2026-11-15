import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type TextareaHTMLAttributes } from "react";
import { activeMentionQuery, findMentions, type CommentMention, type Member } from "@rpit/shared";
import { useMe } from "../api/hooks.ts";

/**
 * Renders a comment body with its @-mentions highlighted. Uses the mentions
 * the server stored, so highlights stay put even if someone later leaves.
 */
export function CommentBody({ body, mentions }: { body: string; mentions: CommentMention[] }) {
  const me = useMe().data;
  const matches = findMentions(
    body,
    mentions.map((m) => ({ id: m.userId, name: m.name })),
  );
  const parts: ReactNode[] = [];
  let at = 0;
  for (const m of matches) {
    if (m.start > at) parts.push(body.slice(at, m.start));
    const name = mentions.find((x) => x.userId === m.userId)?.name;
    parts.push(
      <span key={m.start} className={`mention${m.userId === me?.id ? " me" : ""}`} title={name}>
        {body.slice(m.start, m.end)}
      </span>,
    );
    at = m.end;
  }
  if (at < body.length) parts.push(body.slice(at));
  return <p>{parts}</p>;
}

const MAX_SUGGESTIONS = 6;

/**
 * A textarea that suggests project members after `@` and inserts their full
 * name, which is what the server matches. Arrow keys move, Enter or Tab picks,
 * Escape dismisses.
 */
export function MentionTextarea(
  props: {
    value: string;
    onValueChange: (value: string) => void;
    members: Member[];
  } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange">,
) {
  const { value, onValueChange, members, onKeyDown, ...rest } = props;
  const me = useMe().data;
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const pendingCaret = useRef<number | null>(null);

  const active = activeMentionQuery(value.slice(0, caret));
  const q = active?.query.toLowerCase() ?? "";
  const suggestions =
    active && dismissedAt !== active.start
      ? members
          .filter((m) => m.userId !== me?.id)
          .filter((m) => m.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || m.name.toLowerCase().startsWith(q))
          .slice(0, MAX_SUGGESTIONS)
      : [];
  const open = suggestions.length > 0;
  const index = Math.min(highlight, suggestions.length - 1);

  useLayoutEffect(() => {
    if (pendingCaret.current === null || !ref.current) return;
    ref.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    setCaret(pendingCaret.current);
    pendingCaret.current = null;
  }, [value]);

  function pick(m: Member) {
    if (!active) return;
    const before = value.slice(0, active.start);
    const after = value.slice(caret).replace(/^\S*/, ""); // drop the rest of a partly typed word
    const insert = `@${m.name} `;
    pendingCaret.current = before.length + insert.length;
    onValueChange(before + insert + after.replace(/^ /, ""));
    setHighlight(0);
    ref.current?.focus();
  }

  function keyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (open && !e.metaKey && !e.ctrlKey) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setHighlight((index + step + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(suggestions[index]!);
        return;
      }
      if (e.key === "Escape") {
        // Close the suggestions, not the surrounding dialog.
        e.preventDefault();
        e.stopPropagation();
        setDismissedAt(active!.start);
        return;
      }
    }
    onKeyDown?.(e);
  }

  const syncCaret = () => setCaret(ref.current?.selectionStart ?? 0);
  const listId = "mention-suggestions";
  return (
    <div className="mention-input">
      <textarea
        {...rest}
        ref={ref}
        value={value}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${index}` : undefined}
        onChange={(e) => {
          onValueChange(e.target.value);
          setCaret(e.target.selectionStart);
          setHighlight(0);
        }}
        onKeyDown={keyDown}
        onKeyUp={syncCaret}
        onClick={syncCaret}
        onSelect={syncCaret}
        onBlur={() => active && setDismissedAt(active.start)}
        onFocus={() => setDismissedAt(null)}
      />
      {open && (
        <ul className="mention-menu" role="listbox" id={listId} aria-label="Mention a member">
          {suggestions.map((m, i) => (
            <li
              key={m.userId}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === index}
              className={i === index ? "on" : ""}
              // mousedown, not click, so the textarea keeps focus.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(m);
              }}
              onMouseEnter={() => setHighlight(i)}
            >
              <b>{m.name}</b> <span className="muted">{m.email}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
