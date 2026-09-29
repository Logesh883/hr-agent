"use client";

import {
  documentLabelInSentence,
  ONBOARDING_CATEGORY_LABELS,
  type OnboardingAssignee,
  type OnboardingTask,
} from "@hr/contracts";
import { AlertTriangle, FileCheck2, Loader2, MoreHorizontal, Rocket } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { QueryError } from "@/components/query-error";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import {
  useEmployeeOnboarding,
  useStartOnboarding,
  useUpdateOnboardingTask,
} from "@/lib/onboarding-queries";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";

const assigneeLabels: Record<OnboardingAssignee, string> = {
  HR: "HR",
  MANAGER: "Manager",
  EMPLOYEE: "New hire",
  IT: "IT",
};

export function OnboardingPanel({ employeeId }: { employeeId: string }) {
  const onboarding = useEmployeeOnboarding(employeeId);
  const start = useStartOnboarding(employeeId);

  if (onboarding.error) return <QueryError error={onboarding.error} />;
  if (!onboarding.data) return <Skeleton className="h-64 w-full" />;
  const data = onboarding.data;

  async function startOnboarding() {
    try {
      const result = await start.mutateAsync();
      toast.success(`Onboarding started with ${result.progress.total} tasks`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="space-y-4">
      {!data.started ? (
        <Card>
          <CardHeader>
            <CardTitle>Onboarding hasn&apos;t started</CardTitle>
            <CardDescription>
              Starting creates the checklist from company and {data.employee.departmentName ?? "department"}{" "}
              templates, with due dates relative to the joining date ({formatDate(data.employee.joiningDate)}).
            </CardDescription>
          </CardHeader>
          {data.canStart && (
            <CardContent>
              <Button onClick={startOnboarding} disabled={start.isPending}>
                {start.isPending ? <Loader2 className="animate-spin" /> : <Rocket />}
                Start onboarding
              </Button>
            </CardContent>
          )}
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Progress</CardTitle>
            <CardDescription>
              {data.progress.done + data.progress.skipped} of {data.progress.total} tasks complete
              {data.progress.overdue > 0 && (
                <span className="text-destructive"> · {data.progress.overdue} overdue</span>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Progress value={data.progress.percent} aria-label="Onboarding progress" />
          </CardContent>
        </Card>
      )}

      {data.missingInfo.length > 0 && (
        <Alert>
          <AlertTriangle />
          <AlertTitle>Missing information</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-0.5 pl-4">
              {data.missingInfo.map((m) => (
                <li key={m.code}>{m.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {data.started && <TaskList tasks={data.tasks} />}
    </div>
  );
}

function TaskList({ tasks }: { tasks: OnboardingTask[] }) {
  const can = useCan();
  const update = useUpdateOnboardingTask();
  const [skipping, setSkipping] = useState<OnboardingTask | null>(null);

  async function setStatus(task: OnboardingTask, status: OnboardingTask["status"], notes?: string) {
    try {
      await update.mutateAsync({ id: task.id, status, notes });
      toast.success(status === "DONE" ? `Done: ${task.title}` : status === "SKIPPED" ? `Skipped: ${task.title}` : `Reopened: ${task.title}`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Checklist</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {tasks.map((task) => {
            const documentTask = !!task.requiredDocumentType;
            const closed = task.status !== "PENDING";
            return (
              <li key={task.id} className="flex items-start gap-3 py-3">
                <Checkbox
                  className="mt-0.5"
                  checked={task.status === "DONE"}
                  disabled={!task.canUpdate || documentTask || task.status === "SKIPPED" || update.isPending}
                  onCheckedChange={(checked) => setStatus(task, checked ? "DONE" : "PENDING")}
                  aria-label={task.title}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={cn("text-sm font-medium", closed && "text-muted-foreground line-through")}>
                      {task.title}
                    </span>
                    <Badge variant="outline" className="font-normal">
                      {assigneeLabels[task.assignee]}
                    </Badge>
                    <Badge variant="secondary" className="font-normal">
                      {ONBOARDING_CATEGORY_LABELS[task.category]}
                    </Badge>
                    {task.status === "SKIPPED" && <Badge variant="secondary">Skipped</Badge>}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    <span className={cn(task.isOverdue && "font-medium text-destructive")}>
                      {task.isOverdue ? "Overdue · due " : "Due "}
                      {formatDate(task.dueDate)}
                    </span>
                    {task.completedBy && closed && ` · ${task.status === "DONE" ? "done" : "skipped"} by ${task.completedBy.name}`}
                  </div>
                  {task.description && <p className="mt-1 text-xs text-muted-foreground">{task.description}</p>}
                  {documentTask && task.status === "PENDING" && (
                    <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                      <FileCheck2 className="size-3.5" />
                      Completes when the {documentLabelInSentence(task.requiredDocumentType!)} is verified.
                    </p>
                  )}
                  {task.notes && <p className="mt-1 text-xs text-muted-foreground italic">{task.notes}</p>}
                </div>
                {can("onboarding:manage") && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${task.title}`}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {task.status === "PENDING" ? (
                        <DropdownMenuItem onSelect={() => setSkipping(task)}>Skip task…</DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem onSelect={() => setStatus(task, "PENDING")}>Reopen</DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
      <SkipDialog
        task={skipping}
        onClose={() => setSkipping(null)}
        onConfirm={async (notes) => {
          if (skipping) await setStatus(skipping, "SKIPPED", notes);
          setSkipping(null);
        }}
      />
    </Card>
  );
}

function SkipDialog({
  task,
  onClose,
  onConfirm,
}: {
  task: OnboardingTask | null;
  onClose: () => void;
  onConfirm: (notes: string) => Promise<void>;
}) {
  const [notes, setNotes] = useState("");
  return (
    <Dialog open={task !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Skip task</DialogTitle>
          <DialogDescription>{task?.title}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="skip-notes">Why is it being skipped?</Label>
          <Textarea id="skip-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!notes.trim()}
            onClick={async () => {
              await onConfirm(notes.trim());
              setNotes("");
            }}
          >
            Skip task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
