"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { RunDetail } from "@/components/agent/run-detail";
import { QueryError } from "@/components/query-error";
import { Skeleton } from "@/components/ui/skeleton";
import { useRun } from "@/lib/agent-queries";

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const run = useRun(id);

  return (
    <div className="mx-auto max-w-6xl">
      <Link
        href="/assistant"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        AI assistant
      </Link>
      {run.error ? (
        <QueryError error={run.error} />
      ) : !run.data ? (
        <div className="space-y-4">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <RunDetail run={run.data} />
      )}
    </div>
  );
}
