"use client";

import { ATTENDANCE_STATUSES, type AttendanceStatus, type EmployeeRef } from "@hr/contracts";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
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
import { useProposeCorrection } from "@/lib/attendance-queries";
import { formatDate, fullName } from "@/lib/format";

export interface CorrectionTarget {
  employee: EmployeeRef;
  date: string;
  current: { status: AttendanceStatus; checkIn: string | null; checkOut: string | null } | null;
}

const statusLabels: Record<AttendanceStatus, string> = {
  PRESENT: "Present",
  HALF_DAY: "Half day",
  ABSENT: "Absent",
};

export function ProposeCorrectionDialog({
  target,
  onClose,
}: {
  target: CorrectionTarget | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {target && <CorrectionForm key={`${target.employee.id}:${target.date}`} target={target} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function CorrectionForm({ target, onClose }: { target: CorrectionTarget; onClose: () => void }) {
  const propose = useProposeCorrection();
  const [status, setStatus] = useState<AttendanceStatus>(target.current?.status ?? "PRESENT");
  const [checkIn, setCheckIn] = useState(target.current?.checkIn ?? "09:30");
  const [checkOut, setCheckOut] = useState(target.current?.checkOut ?? "");
  const [reason, setReason] = useState("");
  const absent = status === "ABSENT";
  const issues = propose.error instanceof ApiRequestError ? propose.error.issues ?? [] : [];

  async function submit() {
    try {
      await propose.mutateAsync({
        employeeId: target.employee.id,
        date: target.date,
        status,
        checkIn: absent ? null : checkIn || null,
        checkOut: absent ? null : checkOut || null,
        reason: reason.trim(),
      });
      toast.success("Correction sent to HR for approval");
      onClose();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Propose attendance correction</DialogTitle>
        <DialogDescription>
          {fullName(target.employee)} · {formatDate(target.date)}. The record only changes once HR approves.
        </DialogDescription>
      </DialogHeader>

      {target.current && (
        <p className="text-sm text-muted-foreground">
          Currently: {statusLabels[target.current.status]}
          {target.current.checkIn && `, in ${target.current.checkIn}`}
          {target.current.checkOut ? `, out ${target.current.checkOut}` : target.current.checkIn ? ", no check-out" : ""}
        </p>
      )}

      <div className="grid gap-4">
        <div className="space-y-2">
          <Label htmlFor="correction-status">Should be</Label>
          <Select value={status} onValueChange={(v) => setStatus(v as AttendanceStatus)}>
            <SelectTrigger id="correction-status" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ATTENDANCE_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {statusLabels[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {!absent && (
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="correction-in">Check-in</Label>
              <Input id="correction-in" type="time" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="correction-out">Check-out</Label>
              <Input id="correction-out" type="time" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
            </div>
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="correction-reason">Reason</Label>
          <Textarea
            id="correction-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Badge reader was down; confirmed with the team"
            maxLength={500}
          />
        </div>
        {issues.length > 0 && (
          <ul className="text-sm text-destructive">
            {issues.map((i) => (
              <li key={i.path}>{i.message}</li>
            ))}
          </ul>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!reason.trim() || propose.isPending}>
          {propose.isPending && <Loader2 className="animate-spin" />}
          Send for approval
        </Button>
      </DialogFooter>
    </>
  );
}
