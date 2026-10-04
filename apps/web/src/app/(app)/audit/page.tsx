"use client";

import {
  ACTOR_TYPES,
  AUDIT_ENTITY_TYPES,
  TOOL_NAMES,
  type AuditLogEntry,
  type AuditSearchParams,
} from "@hr/contracts";
import { Bot, ChevronLeft, ChevronRight, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, Suspense, useState } from "react";
import { BeforeAfter } from "@/components/agent/before-after";
import { humanize } from "@/components/agent/labels";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import { useAuditSearch } from "@/lib/queries";
import { useCurrentUser } from "@/lib/session";

const ANY = "any";
const PAGE_SIZE = 25;
const FILTERS = ["entityType", "actorType", "toolName", "agentRunId", "entityId", "from", "to"] as const;

export default function AuditPage() {
  return (
    <Suspense>
      <AuditView />
    </Suspense>
  );
}

/** T4.5: every recorded change, by people and by the AI assistant, with before → after. */
function AuditView() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const params: AuditSearchParams = {
    ...Object.fromEntries(FILTERS.map((key) => [key, searchParams.get(key) || undefined])),
    page: Number(searchParams.get("page") ?? 1),
    pageSize: PAGE_SIZE,
  };
  const audit = useAuditSearch(params);
  const [open, setOpen] = useState<string | null>(null);

  function setFilter(key: (typeof FILTERS)[number] | "page", value: string | undefined) {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    router.replace(`${pathname}?${next}`, { scroll: false });
  }

  const total = audit.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = FILTERS.some((key) => searchParams.get(key));

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every change to HR records: who made it, when, and what it changed. Changes the AI assistant made for someone are marked AI, with its run and tool."
      />

      <div className="mb-4 flex flex-wrap items-end gap-2">
        <FilterSelect
          label="Record"
          value={params.entityType}
          options={AUDIT_ENTITY_TYPES.map((t) => [t, humanize(t.replace(/([a-z])([A-Z])/g, "$1 $2"))])}
          onChange={(v) => setFilter("entityType", v)}
        />
        <FilterSelect
          label="Made by"
          value={params.actorType}
          options={ACTOR_TYPES.map((t) => [t, t === "AI" ? "AI assistant" : humanize(t.toLowerCase())])}
          onChange={(v) => setFilter("actorType", v)}
        />
        <FilterSelect
          label="Tool"
          value={params.toolName}
          options={TOOL_NAMES.map((t) => [t, humanize(t)])}
          onChange={(v) => setFilter("toolName", v)}
        />
        <label className="space-y-1 text-xs text-muted-foreground">
          From
          <Input type="date" className="w-40" value={params.from ?? ""} onChange={(e) => setFilter("from", e.target.value)} />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          To
          <Input type="date" className="w-40" value={params.to ?? ""} onChange={(e) => setFilter("to", e.target.value)} />
        </label>
        {filtered && (
          <Button variant="ghost" onClick={() => router.replace(pathname, { scroll: false })}>
            <X />
            Clear
          </Button>
        )}
      </div>
      {params.agentRunId && (
        <p className="mb-4 text-sm text-muted-foreground">
          Showing changes made by AI run <span className="font-mono text-xs">{params.agentRunId}</span>.
        </p>
      )}

      {audit.error ? (
        <QueryError error={audit.error} />
      ) : !audit.data ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Who</TableHead>
                  <TableHead>What</TableHead>
                  <TableHead>Record</TableHead>
                  <TableHead className="text-right">Changes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {audit.data.items.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                      No changes match.
                    </TableCell>
                  </TableRow>
                )}
                {audit.data.items.map((entry) => (
                  <Fragment key={entry.id}>
                    <TableRow>
                      <TableCell className="whitespace-nowrap">{formatDateTime(entry.timestamp)}</TableCell>
                      <TableCell>
                        <Actor entry={entry} />
                      </TableCell>
                      <TableCell>
                        {humanize(entry.action.replace(".", " "))}
                        {entry.toolName && (
                          <span className="block text-xs text-muted-foreground">via {entry.toolName}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <RecordLink entry={entry} />
                      </TableCell>
                      <TableCell className="text-right">
                        {(entry.before || entry.after) && (
                          <Button variant="ghost" size="sm" onClick={() => setOpen(open === entry.id ? null : entry.id)}>
                            {open === entry.id ? "Hide" : "Show"}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                    {open === entry.id && (
                      <TableRow className="bg-muted/30 hover:bg-muted/30">
                        <TableCell colSpan={5} className="whitespace-normal">
                          <BeforeAfter before={entry.before} after={entry.after} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
            <span>{total.toLocaleString("en-IN")} changes</span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                aria-label="Previous page"
                disabled={(params.page ?? 1) <= 1}
                onClick={() => setFilter("page", String((params.page ?? 1) - 1))}
              >
                <ChevronLeft />
              </Button>
              <span className="tabular-nums">
                {params.page} / {pages}
              </span>
              <Button
                variant="outline"
                size="icon"
                aria-label="Next page"
                disabled={(params.page ?? 1) >= pages}
                onClick={() => setFilter("page", String((params.page ?? 1) + 1))}
              >
                <ChevronRight />
              </Button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | undefined;
  options: [string, string][];
  onChange: (value: string | undefined) => void;
}) {
  return (
    <label className="space-y-1 text-xs text-muted-foreground">
      {label}
      <Select value={value ?? ANY} onValueChange={(v) => onChange(v === ANY ? undefined : v)}>
        <SelectTrigger className="w-44" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>Any</SelectItem>
          {options.map(([key, text]) => (
            <SelectItem key={key} value={key}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

function Actor({ entry }: { entry: AuditLogEntry }) {
  const user = useCurrentUser();
  const name = entry.actorName ?? (entry.actorType === "SYSTEM" ? "System" : "Unknown");
  if (entry.actorType !== "AI") return <>{name}</>;
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1.5">
        <Badge variant="secondary" className="gap-1 bg-violet-500/10 text-violet-700 dark:text-violet-400">
          <Bot className="size-3" />
          AI
        </Badge>
        <span>for {name}</span>
      </div>
      {entry.agentRunId &&
        (entry.actorId === user?.id ? (
          <Link href={`/assistant/runs/${entry.agentRunId}`} className="text-xs underline-offset-4 hover:underline">
            Open the run
          </Link>
        ) : (
          <Link href={`/audit?agentRunId=${entry.agentRunId}`} className="text-xs underline-offset-4 hover:underline">
            Everything this run changed
          </Link>
        ))}
    </div>
  );
}

function RecordLink({ entry }: { entry: AuditLogEntry }) {
  const label = entry.entityType.replace(/([a-z])([A-Z])/g, "$1 $2");
  if (entry.entityType === "Employee") {
    return (
      <Link href={`/employees/${entry.entityId}`} className="underline-offset-4 hover:underline">
        {label}
      </Link>
    );
  }
  return (
    <Link href={`/audit?entityId=${entry.entityId}`} className="underline-offset-4 hover:underline">
      {label}
    </Link>
  );
}
