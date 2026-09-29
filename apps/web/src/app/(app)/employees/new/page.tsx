"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { EmployeeForm, emptyEmployee } from "@/components/employees/employee-form";
import { PageHeader } from "@/components/page-header";
import { useCreateEmployee } from "@/lib/queries";

export default function NewEmployeePage() {
  const router = useRouter();
  const createEmployee = useCreateEmployee();

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Add employee" description="A new employee code is assigned automatically." />
      <EmployeeForm
        defaultValues={emptyEmployee}
        submitLabel="Create employee"
        onCancel={() => router.back()}
        onSubmit={async (values) => {
          const employee = await createEmployee.mutateAsync(values);
          toast.success(`${employee.firstName} ${employee.lastName} added as ${employee.employeeCode}`);
          router.push(`/employees/${employee.id}`);
        }}
      />
    </div>
  );
}
