import { describe, expect, it } from "vitest";
import { applyMarkdownFormat, continueList, markdownToPlainText, type MarkdownFormat } from "./markdown.ts";

/** Write the selection as [brackets] for readable tests: "say [hi] there". */
function run(marked: string, format: MarkdownFormat) {
  const start = marked.indexOf("[");
  const end = marked.indexOf("]") - 1;
  const value = marked.replace("[", "").replace("]", "");
  const r = applyMarkdownFormat(value, start, end, format);
  return r.value.slice(0, r.selectionStart) + "[" + r.value.slice(r.selectionStart, r.selectionEnd) + "]" + r.value.slice(r.selectionEnd);
}

describe("inline formats", () => {
  it("wraps the selection and keeps it selected", () => {
    expect(run("say [hi] there", "bold")).toBe("say **[hi]** there");
    expect(run("say [hi] there", "italic")).toBe("say _[hi]_ there");
    expect(run("say [hi] there", "code")).toBe("say `[hi]` there");
    expect(run("say [hi] there", "strike")).toBe("say ~~[hi]~~ there");
  });

  it("toggles off when already wrapped", () => {
    expect(run("say **[hi]** there", "bold")).toBe("say [hi] there");
    expect(run("say [**hi**] there", "bold")).toBe("say [hi] there");
  });

  it("inserts a selected placeholder when nothing is selected", () => {
    expect(run("say []", "bold")).toBe("say **[bold text]**");
  });

  it("keeps surrounding whitespace outside the markers", () => {
    expect(run("say [hi ]there", "bold")).toBe("say **[hi]** there");
  });
});

describe("links", () => {
  it("wraps text and selects the URL", () => {
    expect(run("see [docs]", "link")).toBe("see [docs]([https://])");
  });
  it("turns a selected URL into a link and selects the text", () => {
    expect(run("see [https://x.dev]", "link")).toBe("see [[link text]](https://x.dev)");
  });
});

describe("line formats", () => {
  it("prefixes every selected line, numbering ordered lists", () => {
    expect(run("[a\nb]", "bullet")).toBe("[- a\n- b]");
    expect(run("[a\nb\nc]", "numbered")).toBe("[1. a\n2. b\n3. c]");
    expect(run("[a]", "task")).toBe("[- [ ] a]");
    expect(run("[a]", "quote")).toBe("[> a]");
    expect(run("[a]", "heading")).toBe("[### a]");
  });

  it("expands a partial selection to whole lines and leaves other lines alone", () => {
    expect(run("x\nal[pha\nbe]ta\ny", "bullet")).toBe("x\n[- alpha\n- beta]\ny");
  });

  it("removes the prefix when every line has it", () => {
    expect(run("[- a\n- b]", "bullet")).toBe("[a\nb]");
    expect(run("[1. a\n2. b]", "numbered")).toBe("[a\nb]");
  });

  it("switches between list types", () => {
    expect(run("[- a\n- b]", "numbered")).toBe("[1. a\n2. b]");
    // Task boxes contain brackets, so select explicitly instead of using the [marker] helper.
    expect(applyMarkdownFormat("- [ ] a", 0, 7, "bullet").value).toBe("- a");
    expect(applyMarkdownFormat("- a", 0, 3, "task").value).toBe("- [ ] a");
  });

  it("keeps the caret in place for a single line", () => {
    expect(run("ab[]c", "bullet")).toBe("- ab[]c");
  });
});

describe("code block", () => {
  it("fences the selected lines", () => {
    expect(run("[let x = 1]", "codeblock")).toBe("```\n[let x = 1]\n```");
    expect(run("[]", "codeblock")).toBe("```\n[code]\n```");
  });
});

describe("continueList", () => {
  const at = (v: string) => continueList(v, v.length, v.length)?.value ?? null;
  it("continues bullets, numbers, tasks and quotes", () => {
    expect(at("- one")).toBe("- one\n- ");
    expect(at("1. one")).toBe("1. one\n2. ");
    expect(at("- [x] done")).toBe("- [x] done\n- [ ] ");
    expect(at("> quote")).toBe("> quote\n> ");
    expect(at("  - nested")).toBe("  - nested\n  - ");
  });
  it("ends the list on an empty item and ignores plain text", () => {
    expect(at("- one\n- ")).toBe("- one\n");
    expect(at("plain")).toBeNull();
  });
});

describe("markdownToPlainText", () => {
  it("strips common syntax", () => {
    expect(markdownToPlainText("## Title\n\n**Bold** and _it_ with [a link](http://x) and `code`\n- item")).toBe(
      "Title\nBold and it with a link and code\nitem",
    );
  });
});
