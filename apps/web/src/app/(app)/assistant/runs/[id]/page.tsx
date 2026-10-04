"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { RunDetail } from "@/components/agent/run-detail";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useRun } from "@/lib/agent-queries";

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const run = useRun(id);

  return (
    <>
      <PageHeader
        title="Request"
        actions={
          <Button asChild variant="ghost">
            <Link href="/assistant">
              <ArrowLeft />
              AI assistant
            </Link>
          </Button>
        }
      />
      {run.error ? (
        <QueryError error={run.error} />
      ) : !run.data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <RunDetail run={run.data} />
      )}
    </>
  );
}
