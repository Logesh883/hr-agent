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
      <ol className="space-y-2">
        {shown.map(({ id, event }) => {
          const line = describeEvent(event);
          return (
            <li key={id} className="flex gap-3 text-sm">
              <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", dots[line.tone])} />
              <div className="min-w-0">
                <span className={cn(line.tone === "neutral" && "text-muted-foreground")}>{line.text}</span>
                {line.detail && (
                  <p className="text-xs break-words text-muted-foreground">{line.detail}</p>
                )}
              </div>
            </li>
          );
        })}
        {live && (
          <li className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="size-2 animate-pulse rounded-full bg-sky-500" />
            Working…
          </li>
        )}
      </ol>
      {events.some((e) => QUIET.has(e.event.event)) && (
        <Button variant="link" size="sm" className="h-auto px-0" onClick={() => setAll(!all)}>
          {all ? "Hide graph steps" : "Show every graph step"}
        </Button>
      )}
    </div>
  );
}
