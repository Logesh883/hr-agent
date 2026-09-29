"use client";

import type { OnboardingSearchParams } from "@hr/contracts";
import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { OnboardingPanel } from "@/components/onboarding/onboarding-panel";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDate, fullName } from "@/lib/format";
import { useOnboardingList } from "@/lib/onboarding-queries";
import { useCan, useCurrentUser } from "@/lib/session";

type State = NonNullable<OnboardingSearchParams["state"]>;

export default function OnboardingPage() {
  const user = useCurrentUser();
  const can = useCan();

  // Employees only ever see their own onboarding.
  if (!can("employee:read")) {
    return (
      <>
        <PageHeader title="My onboarding" description="Your checklist for getting started." />
        {user?.employeeId ? (
          <OnboardingPanel employeeId={user.employeeId} />
        ) : (
          <p className="text-sm text-muted-foreground">Your account isn&apos;t linked to an employee record.</p>
        )}
      </>
    );
  }
  return <OnboardingList />;
}

function OnboardingList() {
  const router = useRouter();
  const can = useCan();
  const [state, setState] = useState<State>("active");
  const list = useOnboardingList({ state, pageSize: 100 });

  return (
    <>
      <PageHeader
        title="Onboarding"
        description={
          can("onboarding:manage")
            ? "New hires' checklists. Start onboarding from an employee's Onboarding tab."
            : "Your team's new hires."
        }
      />
      <Tabs value={state} onValueChange={(v) => setState(v as State)} className="mb-4">
        <TabsList>
          <TabsTrigger value="active">In progress</TabsTrigger>
          <TabsTrigger value="completed">Completed</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
      </Tabs>

      {list.error ? (
        <QueryError error={list.error} />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>New hire</TableHead>
                <TableHead className="hidden md:table-cell">Joining</TableHead>
                <TableHead className="w-48">Progress</TableHead>
                <TableHead className="hidden lg:table-cell">Next task</TableHead>
                <TableHead>Attention</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!list.data &&
                Array.from({ length: 3 }, (_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={5}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                ))}
              {list.data?.items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="h-20 text-center text-muted-foreground">
                    {state === "active" ? "No onboarding in progress." : "Nothing here yet."}
                  </TableCell>
                </TableRow>
              )}
              {list.data?.items.map((s) => (
                <TableRow
                  key={s.employee.id}
                  className="cursor-pointer"
                  onClick={() => router.push(`/employees/${s.employee.id}?tab=onboarding`)}
                >
                  <TableCell>
                    <Link
                      href={`/employees/${s.employee.id}?tab=onboarding`}
                      className="font-medium hover:underline"
                      onClick={(ev) => ev.stopPropagation()}
                    >
                      {fullName(s.employee)}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {s.employee.jobTitle}
                      {s.employee.departmentName && ` · ${s.employee.departmentName}`}
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{formatDate(s.employee.joiningDate)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Progress value={s.progress.percent} className="w-24" aria-label="Progress" />
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {s.progress.done + s.progress.skipped}/{s.progress.total}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden text-sm lg:table-cell">
                    {s.nextTask ? (
                      <>
                        {s.nextTask.title}
                        <div className={s.nextTask.isOverdue ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
                          {s.nextTask.isOverdue ? "Overdue · " : "Due "}
                          {formatDate(s.nextTask.dueDate)}
                        </div>
                      </>
                    ) : (
                      <span className="text-muted-foreground">All done</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {s.progress.overdue > 0 && (
                        <Badge variant="destructive">{s.progress.overdue} overdue</Badge>
                      )}
                      {s.missingInfoCount > 0 && (
                        <Badge variant="secondary" className="gap-1">
                          <AlertTriangle className="size-3" />
                          {s.missingInfoCount} missing
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
