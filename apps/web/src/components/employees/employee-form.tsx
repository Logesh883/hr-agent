"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  createEmployeeSchema,
  EMPLOYMENT_TYPES,
  type CreateEmployeeInput,
  type CreateEmployeeRequest,
} from "@hr/contracts";
import { Loader2 } from "lucide-react";
import { Controller, useForm, type Path, type UseFormSetError } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiRequestError, errorMessage } from "@/lib/api";
import { employmentTypeLabels, fullName } from "@/lib/format";
import { useDepartments, useEmployeeOptions } from "@/lib/queries";

const NO_MANAGER = "none";

export const emptyEmployee: CreateEmployeeInput = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  dateOfBirth: null,
  jobTitle: "",
  departmentId: "",
  managerId: null,
  location: "",
  joiningDate: "",
  employmentType: "FULL_TIME",
  status: "PROBATION",
};

interface EmployeeFormProps {
  defaultValues: CreateEmployeeInput;
  /** The employee being edited; excluded from the manager list. */
  employeeId?: string;
  submitLabel: string;
  onSubmit: (values: CreateEmployeeRequest) => Promise<void>;
  onCancel: () => void;
}

/** Shared by create and edit. Validates with the same schema the API uses. */
export function EmployeeForm({
  defaultValues,
  employeeId,
  submitLabel,
  onSubmit,
  onCancel,
}: EmployeeFormProps) {
  const form = useForm<CreateEmployeeInput, unknown, CreateEmployeeRequest>({
    resolver: zodResolver(createEmployeeSchema),
    defaultValues,
  });
  const { errors, isSubmitting } = form.formState;

  const departments = useDepartments();
  const managers = useEmployeeOptions();
  const activeDepartments = departments.data?.filter(
    (d) => d.status === "ACTIVE" || d.id === defaultValues.departmentId,
  );
  const managerOptions = managers.data?.items.filter((e) => e.id !== employeeId);

  async function submit(values: CreateEmployeeRequest) {
    try {
      await onSubmit(values);
    } catch (error) {
      applyServerErrors(error, form.setError);
      toast.error(errorMessage(error));
    }
  }

  const field = (name: Path<CreateEmployeeInput>, label: string, props: React.ComponentProps<typeof Input> = {}) => (
    <div className="space-y-2">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} aria-invalid={!!errors[name as keyof typeof errors]} {...props} {...form.register(name)} />
      <FieldError message={errors[name as keyof typeof errors]?.message} />
    </div>
  );

  return (
    <form onSubmit={form.handleSubmit(submit)} className="space-y-6" noValidate>
      <Card>
        <CardHeader>
          <CardTitle>Personal details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {field("firstName", "First name", { autoComplete: "off" })}
          {field("lastName", "Last name", { autoComplete: "off" })}
          {field("email", "Work email", { type: "email", autoComplete: "off" })}
          {field("phone", "Phone (optional)", { type: "tel" })}
          <div className="space-y-2">
            <Label htmlFor="dateOfBirth">Date of birth (optional)</Label>
            <Input
              id="dateOfBirth"
              type="date"
              aria-invalid={!!errors.dateOfBirth}
              {...form.register("dateOfBirth", { setValueAs: (v: string) => v || null })}
            />
            <FieldError message={errors.dateOfBirth?.message} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Employment</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {field("jobTitle", "Job title")}
          {field("location", "Location")}

          <div className="space-y-2">
            <Label htmlFor="departmentId">Department</Label>
            <Controller
              control={form.control}
              name="departmentId"
              render={({ field: f }) => (
                <Select value={f.value || undefined} onValueChange={f.onChange}>
                  <SelectTrigger id="departmentId" className="w-full" aria-invalid={!!errors.departmentId}>
                    <SelectValue placeholder="Select a department" />
                  </SelectTrigger>
                  <SelectContent>
                    {activeDepartments?.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <FieldError message={errors.departmentId?.message} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="managerId">Reports to</Label>
            <Controller
              control={form.control}
              name="managerId"
              render={({ field: f }) => (
                <Select
                  value={f.value ?? NO_MANAGER}
                  onValueChange={(v) => f.onChange(v === NO_MANAGER ? null : v)}
                >
                  <SelectTrigger id="managerId" className="w-full" aria-invalid={!!errors.managerId}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_MANAGER}>No manager</SelectItem>
                    {managerOptions?.map((e) => (
                      <SelectItem key={e.id} value={e.id}>
                        {fullName(e)} · {e.jobTitle}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <FieldError message={errors.managerId?.message} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="joiningDate">Joining date</Label>
            <Input id="joiningDate" type="date" aria-invalid={!!errors.joiningDate} {...form.register("joiningDate")} />
            <FieldError message={errors.joiningDate?.message} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="employmentType">Employment type</Label>
            <Controller
              control={form.control}
              name="employmentType"
              render={({ field: f }) => (
                <Select value={f.value} onValueChange={f.onChange}>
                  <SelectTrigger id="employmentType" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EMPLOYMENT_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {employmentTypeLabels[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="status">Status</Label>
            <Controller
              control={form.control}
              name="status"
              render={({ field: f }) => (
                <Select value={f.value} onValueChange={f.onChange}>
                  <SelectTrigger id="status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PROBATION">On probation</SelectItem>
                    <SelectItem value="ACTIVE">Active</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="animate-spin" />}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function FieldError({ message }: { message?: string }) {
  return message ? <p className="text-sm text-destructive">{message}</p> : null;
}

/** Shows API validation issues next to the matching fields. */
function applyServerErrors(error: unknown, setError: UseFormSetError<CreateEmployeeInput>) {
  if (!(error instanceof ApiRequestError)) return;
  for (const issue of error.issues ?? []) {
    if (issue.path in emptyEmployee) {
      setError(issue.path as Path<CreateEmployeeInput>, { message: issue.message });
    }
  }
  if (error.status === 409 && /email/i.test(error.message)) {
    setError("email", { message: error.message });
  }
}
