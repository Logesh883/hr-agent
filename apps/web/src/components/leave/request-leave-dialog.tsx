"use client";

import { LEAVE_TYPES, type LeaveRequestBody, type LeaveType } from "@hr/contracts";
import { AlertCircle, CalendarCheck, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiRequestError, errorMessage } from "@/lib/api";
import { formatDate, fullName, leaveTypeLabels } from "@/lib/format";
import { useCreateLeave, useLeavePreview } from "@/lib/leave-queries";
import { useEmployeeOptions } from "@/lib/queries";
import { useCan, useCurrentUser } from "@/lib/session";

export function RequestLeaveDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const user = useCurrentUser();
  const can = useCan();
  const onBehalf = can("leave:manage");
  const employees = useEmployeeOptions(open && onBehalf);
  const createLeave = useCreateLeave();

  const [employeeId, setEmployeeId] = useState<string>(user?.employeeId ?? "");
  const [type, setType] = useState<LeaveType>("ANNUAL");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [reason, setReason] = useState("");

  // Debounce the inputs that drive the server-side preview.
  const complete = !!employeeId && !!startDate && !!endDate && endDate >= startDate;
  const draft: LeaveRequestBody | null = complete
    ? { employeeId, type, startDate, endDate }
    : null;
  const [debounced, setDebounced] = useState<LeaveRequestBody | null>(null);
  useEffect(() => {
    createLeave.reset();
    const timer = setTimeout(() => setDebounced(draft), 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- draft is derived from these
  }, [employeeId, type, startDate, endDate]);
  const preview = useLeavePreview(debounced);
  const previewCurrent = JSON.stringify(debounced) === JSON.stringify(draft);

  function reset() {
    setEmployeeId(user?.employeeId ?? "");
    setType("ANNUAL");
    setStartDate("");
    setEndDate("");
    setReason("");
  }

  async function submit() {
    if (!draft) return;
    try {
      const leave = await createLeave.mutateAsync({ ...draft, reason: reason.trim() || undefined });
      toast.success(`Leave requested: ${leave.days} working day${leave.days === 1 ? "" : "s"}`);
      reset();
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const problems =
    createLeave.error instanceof ApiRequestError && createLeave.error.problems.length
      ? createLeave.error.problems
      : (preview.data?.problems ?? []);
  const canSubmit =
    !!draft && previewCurrent && preview.isSuccess && problems.length === 0 && !createLeave.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Request leave</DialogTitle>
          <DialogDescription>Weekends and company holidays aren&apos;t counted.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {onBehalf && (
            <div className="space-y-2">
              <Label htmlFor="leave-employee">Employee</Label>
              <Select value={employeeId || undefined} onValueChange={setEmployeeId}>
                <SelectTrigger id="leave-employee" className="w-full">
                  <SelectValue placeholder="Choose an employee" />
                </SelectTrigger>
                <SelectContent>
                  {user?.employeeId && <SelectItem value={user.employeeId}>Myself</SelectItem>}
                  {employees.data?.items
                    .filter((e) => e.id !== user?.employeeId)
                    .map((e) => (
                      <SelectItem key={e.id} value={e.id}>
                        {fullName(e)} · {e.employeeCode}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="leave-type">Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as LeaveType)}>
              <SelectTrigger id="leave-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LEAVE_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {leaveTypeLabels[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="leave-start">From</Label>
              <Input
                id="leave-start"
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value);
                  if (!endDate || endDate < e.target.value) setEndDate(e.target.value);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="leave-end">To</Label>
              <Input
                id="leave-end"
                type="date"
                value={endDate}
                min={startDate || undefined}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="leave-reason">Reason (optional)</Label>
            <Textarea
              id="leave-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              rows={2}
            />
          </div>

          {draft && (
            <PreviewPanel
              loading={!previewCurrent || preview.isFetching}
              workingDays={preview.data?.workingDays}
              nonWorkingDays={preview.data?.nonWorkingDays ?? []}
              balanceAfter={preview.data?.balanceAfter ?? null}
              entitled={preview.data?.balance?.entitled ?? null}
              type={type}
              problems={problems}
              error={preview.error}
            />
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {createLeave.isPending && <Loader2 className="animate-spin" />}
            Submit request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewPanel({
  loading,
  workingDays,
  nonWorkingDays,
  balanceAfter,
  entitled,
  type,
  problems,
  error,
}: {
  loading: boolean;
  workingDays: number | undefined;
  nonWorkingDays: { date: string; reason: string }[];
  balanceAfter: number | null;
  entitled: number | null;
  type: LeaveType;
  problems: { code: string; message: string }[];
  error: unknown;
}) {
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertDescription>{errorMessage(error)}</AlertDescription>
      </Alert>
    );
  }
  if (workingDays === undefined) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Checking…
      </p>
    );
  }

  const holidays = nonWorkingDays.filter((d) => d.reason !== "Weekend");
  return (
    <div className={loading ? "opacity-60 transition-opacity" : "transition-opacity"} aria-live="polite">
      {problems.length > 0 ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>This request can&apos;t be submitted</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {problems.map((p) => (
                <li key={p.code}>{p.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <CalendarCheck />
          <AlertTitle>
            {workingDays} working day{workingDays === 1 ? "" : "s"} of {leaveTypeLabels[type].toLowerCase()}
          </AlertTitle>
          <AlertDescription>
            {balanceAfter !== null && entitled !== null && (
              <p>
                {balanceAfter} of {entitled} days left after this request.
              </p>
            )}
            {holidays.length > 0 && (
              <p>Not counted: {holidays.map((h) => `${h.reason} (${formatDate(h.date)})`).join(", ")}.</p>
            )}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

