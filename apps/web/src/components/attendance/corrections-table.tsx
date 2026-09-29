"use client";

import type { AttendanceCorrection, AttendanceEntry } from "@hr/contracts";
import { ArrowRight, Check, X } from "lucide-react";
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
import { useReviewCorrection } from "@/lib/attendance-queries";
import { formatDate, fullName } from "@/lib/format";

function Entry({ entry }: { entry: AttendanceEntry | null }) {
  if (!entry) return <span className="text-muted-foreground">No record</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <StatusBadge status={entry.status} />
      {entry.checkIn && (
        <span className="text-xs tabular-nums">
          {entry.checkIn}–{entry.checkOut ?? "?"}
        </span>
      )}
    </span>
  );
}

export function CorrectionsTable({
  corrections,
  emptyMessage,
}: {
  corrections: AttendanceCorrection[] | undefined;
  emptyMessage: string;
}) {
  const review = useReviewCorrection();
  const [rejecting, setRejecting] = useState<AttendanceCorrection | null>(null);

  async function approve(c: AttendanceCorrection) {
    try {
      await review.mutateAsync({ id: c.id, action: "approve" });
      toast.success(`Correction applied to ${fullName(c.employee)}'s attendance`);
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
              <TableHead>Employee</TableHead>
              <TableHead>Day</TableHead>
              <TableHead>Change</TableHead>
              <TableHead className="hidden lg:table-cell">Reason</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {!corrections &&
              Array.from({ length: 2 }, (_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={6}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {corrections?.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="h-20 text-center text-muted-foreground">
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
            {corrections?.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{fullName(c.employee)}</TableCell>
                <TableCell className="whitespace-nowrap">{formatDate(c.date)}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-2">
                    <Entry entry={c.previous} />
                    <ArrowRight className="size-3.5 text-muted-foreground" />
                    <Entry entry={c.proposed} />
                  </div>
                </TableCell>
                <TableCell className="hidden max-w-xs text-sm text-muted-foreground lg:table-cell">
                  <p className="whitespace-normal">{c.reason}</p>
                  <p className="text-xs">Proposed by {c.proposedBy.name}</p>
                  {c.reviewedBy && (
                    <p className="text-xs">
                      {c.status === "APPROVED" ? "Approved" : "Rejected"} by {c.reviewedBy.name}
                      {c.reviewComment && `: “${c.reviewComment}”`}
                    </p>
                  )}
                </TableCell>
                <TableCell>
                  <StatusBadge status={c.status} />
                </TableCell>
                <TableCell>
                  {c.canReview && (
                    <div className="flex justify-end gap-1">
                      <Button size="sm" onClick={() => approve(c)} disabled={review.isPending}>
                        <Check />
                        Approve
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setRejecting(c)}>
                        <X />
                        Reject
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <RejectDialog correction={rejecting} onClose={() => setRejecting(null)} />
    </>
  );
}

function RejectDialog({ correction, onClose }: { correction: AttendanceCorrection | null; onClose: () => void }) {
  const review = useReviewCorrection();
  const [reason, setReason] = useState("");

  async function submit() {
    if (!correction) return;
    try {
      await review.mutateAsync({ id: correction.id, action: "reject", text: reason.trim() });
      toast.success("Correction rejected");
      setReason("");
      onClose();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Dialog open={correction !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reject correction</DialogTitle>
          {correction && (
            <DialogDescription>
              {fullName(correction.employee)} · {formatDate(correction.date)}. The attendance record stays as it is.
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="correction-reject">Reason</Label>
          <Textarea id="correction-reject" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={submit} disabled={!reason.trim() || review.isPending}>
            Reject
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
