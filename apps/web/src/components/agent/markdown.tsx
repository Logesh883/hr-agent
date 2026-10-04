import { Fragment } from "react";

/**
 * The agent's answers use a little Markdown: paragraphs, "-"/"*"/"1." lists, **bold**,
 * `code` and ### headings. Rendered as plain elements (no HTML from the model is trusted).
 */
export function Markdown({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className="space-y-3 text-sm">
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) {
          const ordered = /^\s*\d+\./.test(lines[0]);
          const List = ordered ? "ol" : "ul";
          return (
            <List key={i} className={ordered ? "list-decimal space-y-1 pl-5" : "list-disc space-y-1 pl-5"}>
              {lines.map((l, j) => (
                <li key={j}>
                  <Inline text={l.replace(/^\s*([-*•]|\d+\.)\s+/, "")} />
                </li>
              ))}
            </List>
          );
        }
        const heading = /^#{1,6}\s+(.*)$/.exec(block);
        if (heading && lines.length === 1) {
          return (
            <p key={i} className="font-semibold">
              <Inline text={heading[1]} />
            </p>
          );
        }
        return (
          <p key={i} className="whitespace-pre-wrap">
            {lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && "\n"}
                <Inline text={l} />
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
          <strong key={i}>{part.slice(2, -2)}</strong>
        ) : part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
          <code key={i} className="rounded bg-muted px-1 text-xs">
            {part.slice(1, -1)}
          </code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
