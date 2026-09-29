"use client";

import type { CreateEmployeeInput, CreateEmployeeRequest, Employee } from "@hr/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { EmployeeForm } from "@/components/employees/employee-form";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiRequestError } from "@/lib/api";
import { fullName } from "@/lib/format";
import { queryKeys, useEmployee, useUpdateEmployee } from "@/lib/queries";

function toFormValues(e: Employee): CreateEmployeeInput {
  return {
    firstName: e.firstName,
    lastName: e.lastName,
    email: e.email,
    phone: e.phone ?? "",
    dateOfBirth: e.dateOfBirth,
    jobTitle: e.jobTitle,
    departmentId: e.department?.id ?? "",
    managerId: e.manager?.id ?? null,
    location: e.location,
    joiningDate: e.joiningDate,
    employmentType: e.employmentType,
    status: e.status === "ARCHIVED" ? "ACTIVE" : e.status,
  };
}

/** Only the fields that changed, so the audit log records a precise diff. */
function changedFields(original: CreateEmployeeRequest, values: CreateEmployeeRequest) {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([key, value]) => (original[key as keyof CreateEmployeeRequest] ?? null) !== (value ?? null),
    ),
  ) as Partial<CreateEmployeeRequest>;
}

export default function EditEmployeePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const employee = useEmployee(id);
  const updateEmployee = useUpdateEmployee(id);

  if (employee.error) return <QueryError error={employee.error} />;
  if (!employee.data) return <Skeleton className="mx-auto h-96 max-w-3xl" />;

  const current = employee.data;
  if (current.status === "ARCHIVED") {
    return (
      <QueryError error={new ApiRequestError(409, "Archived employees can't be edited. Reactivate them first.")} />
    );
  }

  const original = toFormValues(current) as CreateEmployeeRequest;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={`Edit ${fullName(current)}`} description={current.employeeCode} />
      <EmployeeForm
        key={current.version}
        defaultValues={toFormValues(current)}
        employeeId={current.id}
        submitLabel="Save changes"
        onCancel={() => router.push(`/employees/${id}`)}
        onSubmit={async (values) => {
          const changes = changedFields({ ...original, phone: original.phone || null }, values);
          if (Object.keys(changes).length === 0) {
            toast.info("No changes to save");
            return;
          }
          try {
            await updateEmployee.mutateAsync({ ...changes, version: current.version });
          } catch (error) {
            // Someone else saved first: reload the latest version into the form.
            if (error instanceof ApiRequestError && error.status === 409) {
              void queryClient.invalidateQueries({ queryKey: queryKeys.employee(id) });
            }
            throw error;
          }
          toast.success("Changes saved");
          router.push(`/employees/${id}`);
        }}
      />
    </div>
  );
}
