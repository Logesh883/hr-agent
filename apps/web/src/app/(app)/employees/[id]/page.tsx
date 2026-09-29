"use client";

import type { Employee } from "@hr/contracts";
import { Archive, ArchiveRestore, ArrowLeft, Pencil, Users } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { EmployeeDocuments } from "@/components/documents/employee-documents";
import { ChangeHistory } from "@/components/employees/change-history";
import { EmployeeLeave } from "@/components/leave/employee-leave";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/api";
import { employmentTypeLabels, formatDate, fullName } from "@/lib/format";
import { useEmployee, useEmployees, useSetEmployeeArchived } from "@/lib/queries";
import { useCan, useCurrentUser } from "@/lib/session";

export default function EmployeeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const can = useCan();
  const user = useCurrentUser();
  const employee = useEmployee(id);
  const reports = useEmployees({ managerId: id, pageSize: 1 });
  const [statusDialogOpen, setStatusDialogOpen] = useState(false);

  if (employee.error) return <QueryError error={employee.error} />;
  if (!employee.data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const e = employee.data;
  const archived = e.status === "ARCHIVED";
  const reportCount = reports.data?.total ?? 0;

  return (
    <>
      <Button variant="ghost" size="sm" asChild className="mb-4 -ml-2">
        <Link href="/employees">
          <ArrowLeft />
          Employees
        </Link>
      </Button>

      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            {fullName(e)}
            <StatusBadge status={e.status} />
          </span>
        }
        description={`${e.employeeCode} · ${e.jobTitle}`}
        actions={
          <>
            {can("employee:update") && !archived && (
              <Button variant="outline" asChild>
                <Link href={`/employees/${e.id}/edit`}>
                  <Pencil />
                  Edit
                </Link>
              </Button>
            )}
            {can("employee:archive") && (
              <Button
                variant={archived ? "outline" : "destructive"}
                onClick={() => setStatusDialogOpen(true)}
              >
                {archived ? <ArchiveRestore /> : <Archive />}
                {archived ? "Reactivate" : "Archive"}
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Employment</CardTitle>
          </CardHeader>
          <CardContent>
            <Details
              items={[
                ["Job title", e.jobTitle],
                ["Department", e.department?.name],
                [
                  "Reports to",
                  e.manager ? (
                    <Link href={`/employees/${e.manager.id}`} className="hover:underline">
                      {fullName(e.manager)}
                    </Link>
                  ) : (
                    "—"
                  ),
                ],
                [
                  "Direct reports",
                  reportCount > 0 ? (
                    <Link href={`/employees?managerId=${e.id}`} className="inline-flex items-center gap-1 hover:underline">
                      <Users className="size-3.5" />
                      {reportCount}
                    </Link>
                  ) : (
                    "None"
                  ),
                ],
                ["Employment type", employmentTypeLabels[e.employmentType]],
                ["Location", e.location],
                ["Joining date", formatDate(e.joiningDate)],
              ]}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Contact</CardTitle>
          </CardHeader>
          <CardContent>
            <Details
              items={[
                ["Work email", <a key="email" href={`mailto:${e.email}`} className="hover:underline">{e.email}</a>],
                ["Phone", e.phone ?? "—"],
                ["Date of birth", formatDate(e.dateOfBirth)],
              ]}
            />
          </CardContent>
        </Card>
      </div>

      {(can("leave:manage") || e.manager?.id === user?.employeeId || e.id === user?.employeeId) && (
        <EmployeeLeave employeeId={e.id} />
      )}

      {(can("document:verify") || e.id === user?.employeeId) && <EmployeeDocuments employeeId={e.id} />}

      {can("audit:read") && <ChangeHistory employeeId={e.id} />}

      <StatusDialog
        employee={e}
        open={statusDialogOpen}
        onOpenChange={setStatusDialogOpen}
      />
    </>
  );
}

function Details({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-4 gap-y-3 text-sm">
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 break-words">{value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

function StatusDialog({
  employee,
  open,
  onOpenChange,
}: {
  employee: Employee;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const archiving = employee.status !== "ARCHIVED";
  const setArchived = useSetEmployeeArchived(employee.id);
  const [reason, setReason] = useState("");

  async function confirm() {
    try {
      await setArchived.mutateAsync({
        archived: archiving,
        version: employee.version,
        reason: reason.trim() || undefined,
      });
      toast.success(`${fullName(employee)} ${archiving ? "archived" : "reactivated"}`);
      setReason("");
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {archiving ? "Archive" : "Reactivate"} {fullName(employee)}?
          </DialogTitle>
          <DialogDescription>
            {archiving
              ? "Archived employees are hidden from the directory and can't be edited. You can reactivate them later."
              : "The employee returns to the directory with Active status."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reason">Reason (recorded in the audit log)</Label>
          <Textarea
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={archiving ? "e.g. Resigned, last working day 30 Sep" : "e.g. Rehired"}
            maxLength={500}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={archiving ? "destructive" : "default"}
            onClick={confirm}
            disabled={setArchived.isPending}
          >
            {archiving ? "Archive" : "Reactivate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
