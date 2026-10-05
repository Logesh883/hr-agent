"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { StreamedEvent } from "@/lib/ai";
import { cn } from "@/lib/utils";
import { describeEvent, type Tone } from "./labels";

const dots: Record<Tone, string> = {
  positive: "bg-emerald-500",
  warning: "bg-amber-500",
  negative: "bg-red-500",
  info: "bg-sky-500",
  neutral: "bg-muted-foreground/40",
};

/** Node start/finish markers are noise next to the tool calls; shown on request. */
const QUIET = new Set(["node_started", "node_finished"]);

/** T4.6/T4.7: the execution timeline, as the events arrive. */
export function RunTimeline({ events, live }: { events: StreamedEvent[]; live: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? events : events.filter((e) => !QUIET.has(e.event.event));

  return (
    <div className="space-y-2">
      <ol className="relative">
        {shown.map(({ id, event }, i) => {
          const line = describeEvent(event);
          const last = i === shown.length - 1 && !live;
          return (
            <li key={id} className="relative flex gap-3 pb-3 text-sm last:pb-0">
              {!last && <span className="absolute top-3 bottom-0 left-[3.5px] w-px bg-border" aria-hidden />}
              <span className={cn("relative mt-1.5 size-2 shrink-0 rounded-full ring-2 ring-card", dots[line.tone])} />
              <div className="min-w-0">
                <span className={cn("text-[13px]", line.tone === "neutral" && "text-muted-foreground")}>
                  {line.text}
                </span>
                {line.detail && (
                  <p className="line-clamp-2 text-xs break-words text-muted-foreground">{line.detail}</p>
                )}
              </div>
            </li>
          );
        })}
        {live && (
          <li className="relative flex items-center gap-3 text-sm text-muted-foreground">
            <span className="size-2 animate-pulse rounded-full bg-sky-500" />
            Working…
          </li>
        )}
      </ol>
      {events.some((e) => QUIET.has(e.event.event)) && (
        <Button variant="link" size="sm" className="h-auto px-0 text-xs" onClick={() => setAll(!all)}>
          {all ? "Hide graph steps" : "Show every graph step"}
        </Button>
      )}
    </div>
  );
}
