import { Fragment } from "react";
import { humanize } from "./labels";

function show(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** A before → after table of the fields that differ (or every field when there's no before). */
export function BeforeAfter({
  before,
  after,
}: {
  before: Record<string, unknown> | null | undefined;
  after: Record<string, unknown> | null | undefined;
}) {
  const fields = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
  if (fields.length === 0) return <p className="text-sm text-muted-foreground">No field changes.</p>;
  return (
    <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1.5 text-sm">
      {fields.map((field) => {
        const was = before?.[field];
        const now = after?.[field];
        const changed = before && JSON.stringify(was) !== JSON.stringify(now);
        return (
          <Fragment key={field}>
            <dt className="text-muted-foreground">{humanize(field)}</dt>
            <dd className="min-w-0 break-words">
              {before && field in before && (
                <>
                  <span className={changed ? "text-muted-foreground line-through" : "text-muted-foreground"}>
                    {show(was)}
                  </span>
                  {changed && " → "}
                </>
              )}
              {(!before || changed || !(field in before)) && <span className="font-medium">{show(now)}</span>}
            </dd>
          </Fragment>
        );
      })}
    </dl>
  );
}
