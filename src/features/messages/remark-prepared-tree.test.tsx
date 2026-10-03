import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type { Plugin } from "unified";
import type { Root } from "mdast";
import { describe, expect, it } from "vitest";
import { prepareMarkdown } from "./markdown-preparation";
import { remarkPreparedTree } from "./remark-prepared-tree";

function compare(source: string, renderedSource = source) {
  const prepared = prepareMarkdown(source);
  if (prepared.kind !== "markdown") throw new Error("expected Markdown");
  const originalTree = structuredClone(prepared.tree);
  let parses = 0;
  const countParser: Plugin<[], Root> = function () {
    const parse = this.parser;
    if (!parse) throw new Error("missing Markdown parser");
    this.parser = (document, file) => {
      parses++;
      return parse(document, file);
    };
  };
  const baseline = renderToStaticMarkup(
    <Markdown remarkPlugins={[remarkGfm, remarkBreaks]}>
      {renderedSource}
    </Markdown>,
  );
  const render = () =>
    renderToStaticMarkup(
      <Markdown
        remarkPlugins={[
          remarkGfm,
          remarkBreaks,
          countParser,
          [remarkPreparedTree, prepared],
        ]}
      >
        {renderedSource}
      </Markdown>,
    );
  expect(render()).toBe(baseline);
  expect(render()).toBe(baseline);
  expect(prepared.tree).toEqual(originalTree);
  return parses;
}

describe("prepared Markdown tree rendering", () => {
  it.each([
    "Mixed height message content. Mixed height message content.",
    "# Heading\nfirst\nsecond\n\n- one\n- two\n\n> quote",
    "**bold** and _emphasis_ with `code`",
    "```js\nconst x = 1;\n```",
    "<script>alert(1)</script>\n\nordinary text",
  ])("preserves rendering without a second parse: %s", (content) => {
    expect(compare(content)).toBe(0);
  });

  it.each([
    "~~deleted~~",
    "ordinary &amp; entities",
    "| left | right |\n| --- | --- |\n| one | two |",
    "- [x] done\n- [ ] next",
    "note[^1]\n\n[^1]: footnote",
    "https://example.com and www.example.com",
    "person@example.com",
    "[label](https://example.com)",
    "https&colon;//example.com",
    "www\\.example.com",
    "www&period;example.com",
    "person&commat;example.com",
  ])(
    "preserves the full parser for potentially different GFM: %s",
    (content) => {
      expect(compare(content)).toBe(2);
    },
  );

  it("uses the parser when protection changes the prepared source", () => {
    expect(compare("plain text", "protected replacement")).toBe(2);
  });
});
