/**
 * Plain-text helpers for the Markdown editor toolbar. Each takes the current
 * value and selection and returns the new value and selection, so they're
 * easy to test and the UI only has to apply the result.
 */

export interface TextEdit {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export const INLINE_FORMATS = ["bold", "italic", "strike", "code"] as const;
export const LINE_FORMATS = ["heading", "quote", "bullet", "numbered", "task"] as const;
export type InlineFormat = (typeof INLINE_FORMATS)[number];
export type LineFormat = (typeof LINE_FORMATS)[number];
export type MarkdownFormat = InlineFormat | LineFormat | "link" | "codeblock";

const INLINE: Record<InlineFormat, { marker: string; placeholder: string }> = {
  bold: { marker: "**", placeholder: "bold text" },
  italic: { marker: "_", placeholder: "italic text" },
  strike: { marker: "~~", placeholder: "struck text" },
  code: { marker: "`", placeholder: "code" },
};

const LINE_PREFIX: Record<LineFormat, { match: RegExp; prefix: (i: number) => string }> = {
  heading: { match: /^#{1,6} /, prefix: () => "### " },
  quote: { match: /^> ?/, prefix: () => "> " },
  bullet: { match: /^[-*+] (?!\[[ xX]\] )/, prefix: () => "- " },
  numbered: { match: /^\d+[.)] /, prefix: (i) => `${i + 1}. ` },
  task: { match: /^[-*+] \[[ xX]\] /, prefix: () => "- [ ] " },
};

const edit = (value: string, selectionStart: number, selectionEnd = selectionStart): TextEdit => ({
  value,
  selectionStart,
  selectionEnd,
});

/** Wraps the selection in a marker, or removes it if the selection is already wrapped. */
function toggleInline(value: string, start: number, end: number, f: InlineFormat): TextEdit {
  const { marker, placeholder } = INLINE[f];
  const m = marker.length;
  // Already wrapped, with the markers just outside the selection: unwrap.
  if (value.slice(start - m, start) === marker && value.slice(end, end + m) === marker) {
    return edit(value.slice(0, start - m) + value.slice(start, end) + value.slice(end + m), start - m, end - m);
  }
  // Already wrapped, with the markers inside the selection: unwrap.
  const sel = value.slice(start, end);
  if (sel.length >= 2 * m && sel.startsWith(marker) && sel.endsWith(marker)) {
    const inner = sel.slice(m, -m);
    return edit(value.slice(0, start) + inner + value.slice(end), start, start + inner.length);
  }
  if (start === end) {
    const v = value.slice(0, start) + marker + placeholder + marker + value.slice(end);
    return edit(v, start + m, start + m + placeholder.length);
  }
  // Keep surrounding whitespace outside the markers (double-click selects a trailing space).
  const lead = sel.length - sel.trimStart().length;
  const trail = sel.length - sel.trimEnd().length;
  const s = start + lead;
  const e = end - trail;
  if (s >= e) return toggleInline(value, end, end, f);
  const v = value.slice(0, s) + marker + value.slice(s, e) + marker + value.slice(e);
  return edit(v, s + m, e + m);
}

function insertLink(value: string, start: number, end: number): TextEdit {
  const sel = value.slice(start, end).trim();
  if (/^https?:\/\/\S+$/i.test(sel)) {
    const text = "link text";
    const v = `${value.slice(0, start)}[${text}](${sel})${value.slice(end)}`;
    return edit(v, start + 1, start + 1 + text.length);
  }
  const text = sel || "link text";
  const v = `${value.slice(0, start)}[${text}](https://)${value.slice(end)}`;
  // Select the URL so it can be typed or pasted straight away.
  const urlStart = start + text.length + 3;
  return edit(v, urlStart, urlStart + "https://".length);
}

/** The start of the line containing `start` and the end of the line containing `end`. */
function lineRange(value: string, start: number, end: number) {
  const from = value.lastIndexOf("\n", start - 1) + 1;
  // A selection that ends right after a newline shouldn't include the next line.
  const effectiveEnd = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const nl = value.indexOf("\n", effectiveEnd);
  return { from, to: nl === -1 ? value.length : nl };
}

/** Adds a prefix to every selected line, or removes it if every non-empty line already has it. */
function toggleLines(value: string, start: number, end: number, f: LineFormat): TextEdit {
  const { from, to } = lineRange(value, start, end);
  const lines = value.slice(from, to).split("\n");
  const { match, prefix } = LINE_PREFIX[f];
  const nonEmpty = lines.filter((l) => l.trim());
  const remove = nonEmpty.length > 0 && nonEmpty.every((l) => match.test(l));
  // Switching between list types replaces the other list's marker.
  const otherList = /^([-*+] \[[ xX]\] |[-*+] |\d+[.)] |> ?|#{1,6} )/;
  let n = 0;
  const next = lines.map((l) => {
    if (remove) return l.replace(match, "");
    if (!l.trim() && lines.length > 1) return l;
    return prefix(n++) + l.replace(otherList, "");
  });
  const block = next.join("\n");
  const v = value.slice(0, from) + block + value.slice(to);
  if (start === end && lines.length === 1) {
    // Keep the caret where it was relative to the text.
    const delta = block.length - (to - from);
    return edit(v, Math.max(from, start + delta));
  }
  return edit(v, from, from + block.length);
}

function codeBlock(value: string, start: number, end: number): TextEdit {
  const { from, to } = lineRange(value, start, end);
  const body = start === end && from === to ? "code" : value.slice(from, to);
  const before = from > 0 && value[from - 1] !== "\n" ? "\n" : "";
  const block = `${before}\`\`\`\n${body}\n\`\`\``;
  const v = value.slice(0, from) + block + value.slice(to);
  const bodyStart = from + before.length + 4;
  return edit(v, bodyStart, bodyStart + body.length);
}

export function applyMarkdownFormat(value: string, start: number, end: number, format: MarkdownFormat): TextEdit {
  if (format === "link") return insertLink(value, start, end);
  if (format === "codeblock") return codeBlock(value, start, end);
  if ((INLINE_FORMATS as readonly string[]).includes(format)) return toggleInline(value, start, end, format as InlineFormat);
  return toggleLines(value, start, end, format as LineFormat);
}

/**
 * On Enter inside a list item, start the next item ("- ", "2. ", "- [ ] ", "> ").
 * On Enter in an empty item, end the list instead. Returns null when the
 * caret isn't in a list, so the default Enter behaviour applies.
 */
export function continueList(value: string, start: number, end: number): TextEdit | null {
  if (start !== end) return null;
  const from = value.lastIndexOf("\n", start - 1) + 1;
  const line = value.slice(from, start);
  const m = /^(\s*)([-*+] \[[ xX]\] |[-*+] |(\d+)([.)]) |> )/.exec(line);
  if (!m) return null;
  if (line.trim() === m[2]!.trim()) {
    // Empty item: remove the marker and stop the list.
    return edit(value.slice(0, from) + value.slice(start), from);
  }
  let marker = m[2]!;
  if (m[3]) marker = `${Number(m[3]) + 1}${m[4]} `;
  else if (/\[[ xX]\]/.test(marker)) marker = marker.replace(/\[[xX]\]/, "[ ]");
  const insert = `\n${m[1]}${marker}`;
  return edit(value.slice(0, start) + insert + value.slice(end), start + insert.length);
}

/** Rough plain text for previews (inbox excerpts, activity quotes). */
export function markdownToPlainText(md: string): string {
  return md
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=$|[^\w*])/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
