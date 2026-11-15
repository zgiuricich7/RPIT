/**
 * @-mentions in comment bodies.
 *
 * A mention is `@` followed by a person's full name, e.g. `@Maya Chen`, matched
 * case-insensitively against a list of candidates (the project's members).
 * The `@` must start the text or follow a non-word character (so emails like
 * a@b.com don't match), and the name must not run on into more letters.
 * When names overlap ("Ann" and "Ann Lee") the longest match wins.
 *
 * The server uses this to decide who was mentioned; the web app uses the same
 * function with the stored mentions to highlight them, so both agree.
 */

export interface MentionCandidate {
  id: string;
  name: string;
}

export interface MentionMatch {
  userId: string;
  /** Index of the `@`. */
  start: number;
  /** Index just past the name. */
  end: number;
}

const isWordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);

export function findMentions(body: string, candidates: readonly MentionCandidate[]): MentionMatch[] {
  const sorted = candidates
    .filter((c) => c.name.trim())
    .map((c) => ({ id: c.id, name: c.name.trim().toLowerCase() }))
    .sort((a, b) => b.name.length - a.name.length);
  const lower = body.toLowerCase();
  const out: MentionMatch[] = [];
  let i = lower.indexOf("@");
  while (i !== -1) {
    let next = i + 1;
    if (!isWordChar(body[i - 1])) {
      const hit = sorted.find((c) => lower.startsWith(c.name, i + 1) && !isWordChar(body[i + 1 + c.name.length]));
      if (hit) {
        const end = i + 1 + hit.name.length;
        out.push({ userId: hit.id, start: i, end });
        next = end;
      }
    }
    i = lower.indexOf("@", next);
  }
  return out;
}

/** Distinct ids of the people mentioned in `body`, in order of first mention. */
export const mentionedUserIds = (body: string, candidates: readonly MentionCandidate[]): string[] => [
  ...new Set(findMentions(body, candidates).map((m) => m.userId)),
];

/**
 * When the text before the caret ends in an unfinished mention (`@Ma`),
 * returns the query after the `@` and where the `@` is. Used for autocomplete.
 */
export function activeMentionQuery(textBeforeCaret: string): { query: string; start: number } | null {
  const m = /(^|[^\p{L}\p{N}_])@([\p{L}\p{N}_.'-]*(?: [\p{L}\p{N}_.'-]*)?)$/u.exec(textBeforeCaret);
  if (!m) return null;
  return { query: m[2]!, start: m.index + m[1]!.length };
}
