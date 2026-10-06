import type { Root } from "mdast";
import type { Options } from "react-markdown";

type RemarkPlugin = Extract<
  NonNullable<Options["remarkPlugins"]>[number],
  (...args: never[]) => unknown
>;

type PreparedTree = { content: string; tree: Root | undefined };

/** Reuse preparation without changing the renderer's transforms or URL policy. */
export function remarkPreparedTree(
  this: ThisParameterType<RemarkPlugin>,
  { content, tree }: PreparedTree,
) {
  const parse = this.parser;
  if (!tree || !parse) return;
  this.parser = (document, file) =>
    // Mention/emoji/spoiler protection can change the source after preparation.
    // Those messages still need parsing with the renderer's full grammar.
    document === content ? structuredClone(tree) : parse(document, file);
  // Transforms mutate their input, so each render receives its own tree copy.
}
