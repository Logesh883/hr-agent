import { Fragment, type ReactNode } from "react";

type Block =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; lines: string[] }
  | { kind: "list"; ordered: boolean; items: { text: string; depth: number }[] };

const LIST_ITEM = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/;
const HEADING = /^#{1,6}\s+(.*)$/;
/** A line that is only bold text ("**What was checked:**") reads as a heading. */
const BOLD_LINE = /^\*\*([^*]+)\*\*:?$/;

/**
 * The agent's answers use a little Markdown: paragraphs, "-"/"*"/"1." lists (nested by
 * indent), **bold**, `code`, headings, and [citations]. Parsed line by line, so a heading
 * followed straight by a list renders as both. Plain elements only: no HTML from the model
 * is trusted.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className ?? "space-y-3 text-sm leading-relaxed"}>
      {parse(text).map((block, i) => {
        if (block.kind === "heading") {
          return (
            <h3 key={i} className="pt-1 text-sm font-semibold text-foreground first:pt-0">
              <Inline text={block.text} />
            </h3>
          );
        }
        if (block.kind === "list") return <List key={i} block={block} />;
        return (
          <p key={i}>
            {block.lines.map((line, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                <Inline text={line} />
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function parse(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] | null = null;
  let list: Extract<Block, { kind: "list" }> | null = null;

  for (const raw of text.trim().split("\n")) {
    const line = raw.trimEnd();
    const item = LIST_ITEM.exec(line);
    if (!line.trim()) {
      paragraph = null;
      list = null;
      continue;
    }
    if (item) {
      paragraph = null;
      if (!list) {
        list = { kind: "list", ordered: /\d/.test(item[2]), items: [] };
        blocks.push(list);
      }
      list.items.push({ text: item[3], depth: Math.min(2, Math.floor(item[1].length / 2)) });
      continue;
    }
    const heading = HEADING.exec(line.trim()) ?? BOLD_LINE.exec(line.trim());
    if (heading) {
      paragraph = null;
      list = null;
      blocks.push({ kind: "heading", text: heading[1].replace(/:$/, "") });
      continue;
    }
    if (list && /^\s+/.test(raw) && list.items.length > 0) {
      // A wrapped continuation of the previous list item.
      list.items[list.items.length - 1].text += ` ${line.trim()}`;
      continue;
    }
    list = null;
    if (!paragraph) {
      paragraph = [];
      blocks.push({ kind: "paragraph", lines: paragraph });
    }
    paragraph.push(line.trim());
  }
  return blocks;
}

function List({ block }: { block: Extract<Block, { kind: "list" }> }) {
  return (
    <ul className="space-y-1.5">
      {block.items.map((item, i) => {
        const number = block.ordered && item.depth === 0
          ? block.items.slice(0, i + 1).filter((it) => it.depth === 0).length
          : null;
        return (
          <li key={i} className="flex gap-2" style={{ paddingLeft: `${item.depth * 1.25}rem` }}>
            {number !== null ? (
              <span className="w-4 shrink-0 text-right font-medium text-muted-foreground tabular-nums">
                {number}.
              </span>
            ) : (
              <span className="mt-[0.55em] size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
            )}
            <span className="min-w-0">
              <Inline text={item.text} />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]\n]{3,}\])/g);
  return (
    <>
      {parts.map((part, i): ReactNode => {
        if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
          return (
            <strong key={i} className="font-semibold text-foreground">
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
          return (
            <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
              {part.slice(1, -1)}
            </code>
          );
        }
        if (part.startsWith("[") && part.endsWith("]")) {
          // A citation: a policy section or a step's result.
          return (
            <span
              key={i}
              className="mx-0.5 inline-block rounded border bg-muted/60 px-1.5 align-baseline text-[11px] leading-5 text-muted-foreground"
            >
              {part.slice(1, -1)}
            </span>
          );
        }
        return <Fragment key={i}>{part}</Fragment>;
      })}
    </>
  );
}
