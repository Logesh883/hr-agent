"use client";

import Link from "next/link";
import { QuestionPanel } from "@/components/agent/question-panel";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useRuns } from "@/lib/agent-queries";
import { formatDateTime } from "@/lib/format";

/**
 * T4.4: the approval inbox. Everything the AI assistant is holding for you: actions that
 * need your approval, and questions it needs answered before it can go on.
 */
export default function ApprovalsPage() {
  const waiting = useRuns("waiting", { poll: true });
  const items = waiting.data?.items ?? [];
  const approvals = items.filter((run) => run.question?.type === "approval");
  const questions = items.filter((run) => run.question && run.question.type !== "approval");

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Actions the AI assistant is holding until you decide, and questions it needs answered. Approving runs exactly what's shown; rejecting stops the rest of that request."
      />
      {waiting.error ? (
        <QueryError error={waiting.error} />
      ) : !waiting.data ? (
        <Skeleton className="h-40 w-full" />
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Nothing is waiting for you.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8">
          {[
            { title: "Waiting for your approval", runs: approvals },
            { title: "Waiting for your answer", runs: questions },
          ]
            .filter((group) => group.runs.length > 0)
            .map((group) => (
              <section key={group.title} className="space-y-4">
                <h2 className="text-sm font-medium text-muted-foreground">
                  {group.title} ({group.runs.length})
                </h2>
                {group.runs.map((run) => (
                  <div key={run.id} className="space-y-2">
                    <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                      <span className="min-w-0">
                        “{run.request}”{" "}
                        <span className="text-xs text-muted-foreground">· {formatDateTime(run.started_at)}</span>
                      </span>
                      <Button asChild variant="link" size="sm" className="h-auto px-0">
                        <Link href={`/assistant/runs/${run.id}`}>Plan and evidence</Link>
                      </Button>
                    </div>
                    <QuestionPanel runId={run.id} question={run.question!} compact />
                  </div>
                ))}
              </section>
            ))}
        </div>
      )}
    </>
  );
}
