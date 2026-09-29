"use client";

import type { LeaveRequest } from "@hr/contracts";
import { Check, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/api";
import { formatDateRange, fullName, leaveTypeLabels } from "@/lib/format";
import { useApproveLeave, useCancelLeave, useRejectLeave } from "@/lib/leave-queries";
import { useCan } from "@/lib/session";

export function LeaveTable({
  requests,
  showEmployee = true,
  emptyMessage,
}: {
  requests: LeaveRequest[] | undefined;
  showEmployee?: boolean;
  emptyMessage: string;
}) {
  const can = useCan();
  const approve = useApproveLeave();
  const cancel = useCancelLeave();
  const [rejecting, setRejecting] = useState<LeaveRequest | null>(null);
  const columns = showEmployee ? 7 : 6;

  async function run(action: Promise<LeaveRequest>, success: string) {
    try {
      await action;
      toast.success(success);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              {showEmployee && <TableHead>Employee</TableHead>}
              <TableHead>Type</TableHead>
              <TableHead>Dates</TableHead>
              <TableHead className="text-right">Days</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden lg:table-cell">Details</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {!requests &&
              Array.from({ length: 3 }, (_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={columns}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {requests?.length === 0 && (
              <TableRow>
                <TableCell colSpan={columns} className="h-20 text-center text-muted-foreground">
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
            {requests?.map((r) => (
              <TableRow key={r.id}>
                {showEmployee && (
                  <TableCell>
                    {can("employee:read") ? (
                      <Link href={`/employees/${r.employee.id}`} className="font-medium hover:underline">
                        {fullName(r.employee)}
                      </Link>
                    ) : (
                      <span className="font-medium">{fullName(r.employee)}</span>
                    )}
                  </TableCell>
                )}
                <TableCell>{leaveTypeLabels[r.type]}</TableCell>
                <TableCell className="whitespace-nowrap">{formatDateRange(r.startDate, r.endDate)}</TableCell>
                <TableCell className="text-right tabular-nums">{r.days}</TableCell>
                <TableCell>
                  <StatusBadge status={r.status} />
                </TableCell>
                <TableCell className="hidden max-w-xs text-sm text-muted-foreground lg:table-cell">
                  {r.reason && <p className="truncate">{r.reason}</p>}
                  {r.decidedBy && (
                    <p className="truncate">
                      {r.status === "REJECTED" ? "Rejected" : "Approved"} by {r.decidedBy.name}
                      {r.decisionComment && `: “${r.decisionComment}”`}
                    </p>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    {r.canDecide && (
                      <>
                        <Button
                          size="sm"
                          onClick={() =>
                            run(approve.mutateAsync({ id: r.id }), `Approved ${fullName(r.employee)}'s leave`)
                          }
                          disabled={approve.isPending}
                        >
                          <Check />
                          Approve
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setRejecting(r)}>
                          <X />
                          Reject
                        </Button>
                      </>
                    )}
                    {r.canCancel && !r.canDecide && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => run(cancel.mutateAsync(r.id), "Leave cancelled")}
                        disabled={cancel.isPending}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <RejectDialog request={rejecting} onClose={() => setRejecting(null)} />
    </>
  );
}

function RejectDialog({ request, onClose }: { request: LeaveRequest | null; onClose: () => void }) {
  const reject = useRejectLeave();
  const [reason, setReason] = useState("");

  async function submit() {
    if (!request) return;
    try {
      await reject.mutateAsync({ id: request.id, reason: reason.trim() });
      toast.success(`Rejected ${fullName(request.employee)}'s leave`);
      setReason("");
      onClose();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject leave request</DialogTitle>
          {request && (
            <DialogDescription>
              {fullName(request.employee)} · {leaveTypeLabels[request.type]} ·{" "}
              {formatDateRange(request.startDate, request.endDate)}
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reject-reason">Reason (shared with the employee)</Label>
          <Textarea
            id="reject-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={submit} disabled={!reason.trim() || reject.isPending}>
            Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
