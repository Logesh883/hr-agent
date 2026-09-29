"use client";

import type { AuditLogEntry } from "@hr/contracts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { employmentTypeLabels, formatDateTime } from "@/lib/format";
import { useAuditLog, useDepartments, useEmployeeOptions } from "@/lib/queries";

const actionLabels: Record<string, string> = {
  "employee.created": "Created",
  "employee.updated": "Updated",
  "employee.archived": "Archived",
  "employee.reactivated": "Reactivated",
};

const fieldLabels: Record<string, string> = {
  firstName: "First name",
  lastName: "Last name",
  email: "Email",
  phone: "Phone",
  dateOfBirth: "Date of birth",
  jobTitle: "Job title",
  location: "Location",
  joiningDate: "Joining date",
  employmentType: "Employment type",
  status: "Status",
  departmentId: "Department",
  managerId: "Manager",
  reason: "Reason",
};

/** Audit trail for one employee: who changed what, and when. */
export function ChangeHistory({ employeeId }: { employeeId: string }) {
  const audit = useAuditLog("Employee", employeeId);
  const departments = useDepartments();
  const employees = useEmployeeOptions();

  const departmentNames = new Map(departments.data?.map((d) => [d.id, d.name]));
  const employeeNames = new Map(
    employees.data?.items.map((e) => [e.id, `${e.firstName} ${e.lastName}`]),
  );

  function display(field: string, value: unknown): string {
    if (value === null || value === undefined || value === "") return "—";
    if (field === "departmentId") return departmentNames.get(String(value)) ?? "Unknown department";
    if (field === "managerId") return employeeNames.get(String(value)) ?? "Former employee";
    if (field === "employmentType") {
      return employmentTypeLabels[value as keyof typeof employmentTypeLabels] ?? String(value);
    }
    return String(value);
  }

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Change history</CardTitle>
      </CardHeader>
      <CardContent>
        {!audit.data && <Skeleton className="h-24 w-full" />}
        {audit.data?.items.length === 0 && (
          <p className="text-sm text-muted-foreground">No recorded changes yet.</p>
        )}
        <ol className="space-y-4">
          {audit.data?.items.map((entry) => (
            <li key={entry.id} className="border-l-2 pl-4">
              <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                <span className="font-medium">{actionLabels[entry.action] ?? entry.action}</span>
                <span className="text-muted-foreground">
                  by {entry.actorName ?? entry.actorType} · {formatDateTime(entry.timestamp)}
                </span>
              </div>
              <Changes entry={entry} display={display} />
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function Changes({
  entry,
  display,
}: {
  entry: AuditLogEntry;
  display: (field: string, value: unknown) => string;
}) {
  if (entry.action === "employee.created") return null;
  const fields = Object.keys(entry.after ?? {});
  if (fields.length === 0) return null;

  return (
    <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
      {fields.map((field) => (
        <li key={field}>
          {fieldLabels[field] ?? field}:{" "}
          {entry.before && field in entry.before && (
            <>
              <span className="line-through">{display(field, entry.before[field])}</span> →{" "}
            </>
          )}
          <span className="text-foreground">{display(field, entry.after?.[field])}</span>
        </li>
      ))}
    </ul>
  );
}
