import { describe, expect, it } from "vitest";
import { activeMentionQuery, findMentions, mentionedUserIds } from "./mentions.ts";

const people = [
  { id: "maya", name: "Maya Chen" },
  { id: "ann", name: "Ann" },
  { id: "annlee", name: "Ann Lee" },
  { id: "jose", name: "José" },
];

describe("mentions", () => {
  it("matches full names case-insensitively with positions", () => {
    const body = "Thanks @maya chen, can you look?";
    expect(findMentions(body, people)).toEqual([{ userId: "maya", start: 7, end: 17 }]);
    expect(body.slice(7, 17)).toBe("@maya chen");
  });

  it("prefers the longest matching name", () => {
    expect(mentionedUserIds("@Ann Lee and @Ann", people)).toEqual(["annlee", "ann"]);
  });

  it("ignores emails, partial names and non-members", () => {
    expect(findMentions("mail ann@x.com", people)).toEqual([]);
    expect(findMentions("@Annabel", people)).toEqual([]);
    expect(findMentions("@Maya", people)).toEqual([]);
    expect(findMentions("@Somebody Else", people)).toEqual([]);
  });

  it("handles punctuation, start of text, accents and duplicates", () => {
    expect(mentionedUserIds("@José, (@Maya Chen). @josé!", people)).toEqual(["jose", "maya"]);
  });

  it("finds the mention being typed", () => {
    expect(activeMentionQuery("Hi @Ma")).toEqual({ query: "Ma", start: 3 });
    expect(activeMentionQuery("@")).toEqual({ query: "", start: 0 });
    expect(activeMentionQuery("Hi @Maya C")).toEqual({ query: "Maya C", start: 3 });
    expect(activeMentionQuery("a@b")).toBeNull();
    expect(activeMentionQuery("Hi @Maya Chen thanks")).toBeNull();
  });
});
