import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Element, ElementContent, Root, RootContent } from "hast";
import {
  applyMarkdownFormat,
  continueList,
  findMentions,
  type CommentMention,
  type MarkdownFormat,
  type Member,
  type TextEdit,
} from "@rpit/shared";
import { useMe } from "../api/hooks.ts";
import { MentionTextarea } from "./mentions.tsx";

// ---------------------------------------------------------------------------
// Rendering

/**
 * Safe by construction: react-markdown builds React elements and ignores raw
 * HTML, and its default URL filter drops javascript: and similar links.
 * Images are shown as links so viewing a comment never loads a third-party URL.
 */
const components: Components = {
  a: ({ node: _n, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer nofollow" />,
  img: ({ src, alt }) => (
    <a href={typeof src === "string" ? src : undefined} target="_blank" rel="noopener noreferrer nofollow">
      {alt || "image"}
    </a>
  ),
};

/** Splits text nodes around @-mentions (outside code and links) into highlighted spans. */
function rehypeMentions(opts: { mentions: CommentMention[]; meId: string | undefined }) {
  const candidates = opts.mentions.map((m) => ({ id: m.userId, name: m.name }));
  const walk = (parent: Root | Element) => {
    const out: (RootContent | ElementContent)[] = [];
    for (const child of parent.children) {
      if (child.type === "element") {
        if (!["code", "pre", "a"].includes(child.tagName)) walk(child);
        out.push(child);
        continue;
      }
      if (child.type !== "text") {
        out.push(child);
        continue;
      }
      let at = 0;
      for (const m of findMentions(child.value, candidates)) {
        if (m.start > at) out.push({ type: "text", value: child.value.slice(at, m.start) });
        out.push({
          type: "element",
          tagName: "span",
          properties: { className: m.userId === opts.meId ? ["mention", "me"] : ["mention"] },
          children: [{ type: "text", value: child.value.slice(m.start, m.end) }],
        });
        at = m.end;
      }
      if (at < child.value.length) out.push(at === 0 ? child : { type: "text", value: child.value.slice(at) });
    }
    parent.children = out as typeof parent.children;
  };
  return (tree: Root) => walk(tree);
}

export function MarkdownView(props: { source: string; mentions?: CommentMention[]; empty?: ReactNode; className?: string }) {
  const me = useMe().data;
  if (!props.source.trim()) return props.empty ? <div className="md-empty muted">{props.empty}</div> : null;
  return (
    <div className={`md ${props.className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={props.mentions?.length ? [[rehypeMentions, { mentions: props.mentions, meId: me?.id }]] : []}
        components={components}
      >
        {props.source}
      </ReactMarkdown>
    </div>
  );
}

/** A comment body: Markdown with the stored @-mentions highlighted. */
export const CommentBody = ({ body, mentions }: { body: string; mentions: CommentMention[] }) => (
  <MarkdownView source={body} mentions={mentions} />
);

// ---------------------------------------------------------------------------
// Editing

/**
 * Applies a toolbar edit through the browser's editing commands so Ctrl+Z
 * still works. Only the changed middle of the text is replaced. Falls back to
 * setting the value directly if the command isn't supported.
 */
function applyEdit(el: HTMLTextAreaElement, next: TextEdit, setValue: (v: string) => void) {
  const prev = el.value;
  let s = 0;
  while (s < prev.length && s < next.value.length && prev[s] === next.value[s]) s++;
  let e = 0;
  while (
    e < prev.length - s &&
    e < next.value.length - s &&
    prev[prev.length - 1 - e] === next.value[next.value.length - 1 - e]
  ) {
    e++;
  }
  const insert = next.value.slice(s, next.value.length - e);
  el.focus();
  el.setSelectionRange(s, prev.length - e);
  let ok = false;
  try {
    ok = insert ? document.execCommand("insertText", false, insert) : document.execCommand("delete");
  } catch {
    ok = false;
  }
  if (!ok || el.value !== next.value) setValue(next.value);
  requestAnimationFrame(() => el.setSelectionRange(next.selectionStart, next.selectionEnd));
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";

interface ToolDef {
  format: MarkdownFormat;
  label: string;
  glyph: ReactNode;
  key?: string;
}
const TOOL_GROUPS: ToolDef[][] = [
  [
    { format: "bold", label: "Bold", glyph: <b>B</b>, key: "b" },
    { format: "italic", label: "Italic", glyph: <i>I</i>, key: "i" },
    { format: "strike", label: "Strikethrough", glyph: <s>S</s> },
    { format: "code", label: "Inline code", glyph: <code>{"<>"}</code>, key: "e" },
    { format: "link", label: "Link", glyph: "Link", key: "k" },
  ],
  [
    { format: "heading", label: "Heading", glyph: "H" },
    { format: "quote", label: "Quote", glyph: "“ ”" },
    { format: "bullet", label: "Bulleted list", glyph: "• List" },
    { format: "numbered", label: "Numbered list", glyph: "1. List" },
    { format: "task", label: "Checklist", glyph: "☐ Tasks" },
    { format: "codeblock", label: "Code block", glyph: <code>{"{ }"}</code> },
  ],
];
const SHORTCUTS = new Map(TOOL_GROUPS.flat().filter((t) => t.key).map((t) => [t.key!, t.format]));

/**
 * A labelled Markdown field: formatting toolbar, Write/Preview tabs and a
 * textarea (with @-mention suggestions when `members` is given).
 * When `readOnly`, shows the rendered Markdown instead.
 *
 * Uses a div + aria-labelledby rather than <label>, because a label wrapping
 * toolbar buttons would forward clicks on its text to the first button.
 */
export function MarkdownEditor(props: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  members?: Member[];
  mentions?: CommentMention[];
  readOnly?: boolean;
  autoFocus?: boolean;
  maxLength?: number;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Hide the visible label (e.g. the comment box under a "Discussion" heading). */
  hideLabel?: boolean;
}) {
  const { value, onValueChange, rows = 4 } = props;
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(false);

  const label = (
    <span id={`${id}-label`} className={props.hideLabel ? "visually-hidden" : undefined}>
      {props.label}
    </span>
  );

  if (props.readOnly) {
    return (
      <div className="field" role="group" aria-labelledby={`${id}-label`}>
        {label}
        <MarkdownView source={value} mentions={props.mentions} empty="None" className="md-readonly" />
      </div>
    );
  }

  function format(f: MarkdownFormat) {
    const el = ref.current;
    if (!el) return;
    applyEdit(el, applyMarkdownFormat(el.value, el.selectionStart, el.selectionEnd, f), onValueChange);
  }

  function keyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const shortcut = mod && !e.shiftKey && !e.altKey ? SHORTCUTS.get(e.key.toLowerCase()) : undefined;
    if (shortcut) {
      e.preventDefault();
      format(shortcut);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && !e.nativeEvent.isComposing) {
      const next = continueList(el.value, el.selectionStart, el.selectionEnd);
      if (next) {
        e.preventDefault();
        applyEdit(el, next, onValueChange);
        return;
      }
    }
    props.onKeyDown?.(e);
  }

  const textareaProps = {
    id: `${id}-input`,
    rows,
    value,
    placeholder: props.placeholder,
    autoFocus: props.autoFocus,
    maxLength: props.maxLength,
    "aria-labelledby": `${id}-label`,
    onKeyDown: keyDown,
  };

  return (
    <div className="field md-field">
      {label}
      <div className={`md-editor${preview ? " previewing" : ""}`}>
        <div className="md-toolbar" role="toolbar" aria-label={`${props.label} formatting`}>
          <div className="seg md-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={!preview} className={preview ? "" : "on"} onClick={() => setPreview(false)}>
              Write
            </button>
            <button type="button" role="tab" aria-selected={preview} className={preview ? "on" : ""} onClick={() => setPreview(true)}>
              Preview
            </button>
          </div>
          {!preview &&
            TOOL_GROUPS.map((group, i) => (
              <div className="md-tools" key={i}>
                {group.map((t) => {
                  const hint = t.key ? `${t.label} (${MOD}${t.key.toUpperCase()})` : t.label;
                  return (
                    <button
                      type="button"
                      key={t.format}
                      title={hint}
                      aria-label={hint}
                      // Keep focus (and the selection) in the textarea.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => format(t.format)}
                    >
                      {t.glyph}
                    </button>
                  );
                })}
              </div>
            ))}
        </div>
        {preview ? (
          <div className="md-preview" style={{ minHeight: `${rows * 1.45 + 1}em` }}>
            <MarkdownView source={value} empty="Nothing to preview yet." />
          </div>
        ) : props.members ? (
          <MentionTextarea {...textareaProps} inputRef={ref} members={props.members} onValueChange={onValueChange} />
        ) : (
          <textarea {...textareaProps} ref={ref} onChange={(e) => onValueChange(e.target.value)} />
        )}
      </div>
      {!preview && (
        <span className="md-hint">
          Markdown supported{props.members ? ". Type @ to mention someone." : "."}
        </span>
      )}
    </div>
  );
}
