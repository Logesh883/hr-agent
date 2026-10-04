"use client";

import type { RunView } from "@hr/contracts";
import { Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { RunStatusBadge } from "@/components/agent/badges";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/api";
import { useRuns, useStartRun } from "@/lib/agent-queries";
import { formatDateTime } from "@/lib/format";

const EXAMPLES = [
  "Onboard Priya as a Software Engineer joining October 12, reporting to Rahul in Bangalore.",
  "Compare Sneha's and Arun's leave balances.",
  "Apply casual leave for me on 2026-11-20.",
  "Can unused annual leave be carried over to next year?",
  "Who had attendance anomalies last month?",
];

/** T4.6: the AI Command Center. Ask in plain words; the agent plans, asks, and acts as you. */
export default function AssistantPage() {
  const router = useRouter();
  const start = useStartRun();
  const runs = useRuns(undefined, { poll: true });
  const [request, setRequest] = useState("");

  function submit(text: string) {
    if (!text.trim()) return;
    start.mutate(text.trim(), {
      onSuccess: (run) => router.push(`/assistant/runs/${run.id}`),
      onError: (error) => toast.error(errorMessage(error)),
    });
  }

  return (
    <>
      <PageHeader
        title="AI assistant"
        description="Ask for HR work in plain words. It acts with your permissions, shows its plan and evidence, and waits for you before anything sensitive."
      />
      <Card className="mb-6">
        <CardContent className="space-y-3 pt-6">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit(request);
            }}
          >
            <Textarea
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(request);
              }}
              placeholder="What do you need done?"
              rows={3}
              maxLength={4000}
              aria-label="Request"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">⌘/Ctrl + Enter to send</span>
              <Button type="submit" disabled={start.isPending || !request.trim()}>
                <Sparkles />
                {start.isPending ? "Starting…" : "Ask"}
              </Button>
            </div>
          </form>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <Button
                key={example}
                variant="outline"
                size="sm"
                className="h-auto max-w-full py-1 text-left whitespace-normal"
                onClick={() => setRequest(example)}
              >
                {example}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your recent requests</CardTitle>
        </CardHeader>
        <CardContent>
          {runs.error ? (
            <QueryError error={runs.error} />
          ) : !runs.data ? (
            <Skeleton className="h-24 w-full" />
          ) : runs.data.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet. Ask for something above.</p>
          ) : (
            <ul className="divide-y">
              {runs.data.items.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function RunRow({ run }: { run: RunView }) {
  return (
    <li>
      <Link
        href={`/assistant/runs/${run.id}`}
        className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 hover:bg-muted/50"
      >
        <RunStatusBadge status={run.status} />
        <span className="min-w-0 flex-1 truncate text-sm">{run.request}</span>
        <span className="text-xs text-muted-foreground">{formatDateTime(run.started_at)}</span>
      </Link>
    </li>
  );
}
