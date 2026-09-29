"use client";

import { DOCUMENT_TYPE_LABELS, type EmployeeDocument } from "@hr/contracts";
import { CheckCircle2, Eye, Flag } from "lucide-react";
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
import { useOpenDocument, useReviewDocument } from "@/lib/document-queries";
import { formatDateTime, fullName } from "@/lib/format";
import { useCan } from "@/lib/session";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function DocumentTable({
  documents,
  showEmployee = true,
  emptyMessage,
}: {
  documents: EmployeeDocument[] | undefined;
  showEmployee?: boolean;
  emptyMessage: string;
}) {
  const can = useCan();
  const review = useReviewDocument();
  const openDocument = useOpenDocument();
  const [flagging, setFlagging] = useState<EmployeeDocument | null>(null);
  const columns = showEmployee ? 5 : 4;

  async function verify(doc: EmployeeDocument) {
    try {
      await review.mutateAsync({ id: doc.id, action: "verify" });
      toast.success(`${DOCUMENT_TYPE_LABELS[doc.type]} verified`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function view(doc: EmployeeDocument) {
    try {
      await openDocument(doc);
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
              <TableHead>Document</TableHead>
              <TableHead className="hidden md:table-cell">Uploaded</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {!documents &&
              Array.from({ length: 3 }, (_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={columns}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {documents?.length === 0 && (
              <TableRow>
                <TableCell colSpan={columns} className="h-20 text-center text-muted-foreground">
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
            {documents?.map((d) => (
              <TableRow key={d.id}>
                {showEmployee && (
                  <TableCell>
                    {can("employee:read") ? (
                      <Link href={`/employees/${d.employee.id}`} className="font-medium hover:underline">
                        {fullName(d.employee)}
                      </Link>
                    ) : (
                      <span className="font-medium">{fullName(d.employee)}</span>
                    )}
                    <div className="text-xs text-muted-foreground">{d.employee.employeeCode}</div>
                  </TableCell>
                )}
                <TableCell>
                  <div className="font-medium">{DOCUMENT_TYPE_LABELS[d.type]}</div>
                  <div className="max-w-56 truncate text-xs text-muted-foreground" title={d.fileName}>
                    {d.fileName} · {formatBytes(d.sizeBytes)}
                  </div>
                </TableCell>
                <TableCell className="hidden text-sm md:table-cell">
                  {formatDateTime(d.uploadedAt)}
                  <div className="text-xs text-muted-foreground">by {d.uploadedBy.name}</div>
                </TableCell>
                <TableCell className="max-w-64">
                  <StatusBadge status={d.status} />
                  {d.reviewNote && (
                    <p className="mt-1 text-xs whitespace-normal text-muted-foreground">{d.reviewNote}</p>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button size="sm" variant="ghost" onClick={() => view(d)} aria-label={`View ${d.fileName}`}>
                      <Eye />
                      View
                    </Button>
                    {d.canReview && d.status !== "VERIFIED" && (
                      <Button size="sm" onClick={() => verify(d)} disabled={review.isPending}>
                        <CheckCircle2 />
                        Verify
                      </Button>
                    )}
                    {d.canReview && d.status !== "FLAGGED" && (
                      <Button size="sm" variant="outline" onClick={() => setFlagging(d)}>
                        <Flag />
                        Flag
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <FlagDialog doc={flagging} onClose={() => setFlagging(null)} />
    </>
  );
}

function FlagDialog({ doc, onClose }: { doc: EmployeeDocument | null; onClose: () => void }) {
  const review = useReviewDocument();
  const [note, setNote] = useState("");

  async function submit() {
    if (!doc) return;
    try {
      await review.mutateAsync({ id: doc.id, action: "flag", note: note.trim() });
      toast.success(`${DOCUMENT_TYPE_LABELS[doc.type]} flagged for follow-up`);
      setNote("");
      onClose();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Dialog open={doc !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Flag document</DialogTitle>
          {doc && (
            <DialogDescription>
              {DOCUMENT_TYPE_LABELS[doc.type]} for {fullName(doc.employee)}. Flagged documents stay on
              file and need a corrected upload.
            </DialogDescription>
          )}
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="flag-note">What needs fixing?</Label>
          <Textarea
            id="flag-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Name on the bank letter doesn't match the employee record"
            maxLength={500}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={submit} disabled={!note.trim() || review.isPending}>
            Flag
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
