"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  createDepartmentSchema,
  type CreateDepartmentInput,
  type CreateDepartmentRequest,
  type Department,
  type DepartmentStatus,
} from "@hr/contracts";
import { Loader2, Pencil, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { errorMessage } from "@/lib/api";
import { fullName } from "@/lib/format";
import {
  useCreateDepartment,
  useDepartments,
  useEmployeeOptions,
  useUpdateDepartment,
} from "@/lib/queries";
import { useCan } from "@/lib/session";

const NO_MANAGER = "none";

type DialogState = { mode: "create" } | { mode: "edit"; department: Department } | null;

export default function DepartmentsPage() {
  const can = useCan();
  const departments = useDepartments();
  const [dialog, setDialog] = useState<DialogState>(null);
  const canManage = can("department:manage");
  const canReadEmployees = can("employee:read");

  return (
    <>
      <PageHeader
        title="Departments"
        description={departments.data && `${departments.data.length} departments`}
        actions={
          canManage && (
            <Button onClick={() => setDialog({ mode: "create" })}>
              <Plus />
              New department
            </Button>
          )
        }
      />

      {departments.error ? (
        <QueryError error={departments.error} />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Department</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Manager</TableHead>
                <TableHead className="text-right">Employees</TableHead>
                <TableHead>Status</TableHead>
                {canManage && <TableHead className="w-12" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {!departments.data &&
                Array.from({ length: 4 }, (_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={6}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                ))}
              {departments.data?.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">{d.name}</TableCell>
                  <TableCell className="font-mono text-xs">{d.code}</TableCell>
                  <TableCell>
                    {d.manager ? (
                      canReadEmployees ? (
                        <Link href={`/employees/${d.manager.id}`} className="hover:underline">
                          {fullName(d.manager)}
                        </Link>
                      ) : (
                        fullName(d.manager)
                      )
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {canReadEmployees ? (
                      <Link href={`/employees?departmentId=${d.id}`} className="hover:underline">
                        {d.employeeCount}
                      </Link>
                    ) : (
                      d.employeeCount
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={d.status} />
                  </TableCell>
                  {canManage && (
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${d.name}`}
                        onClick={() => setDialog({ mode: "edit", department: d })}
                      >
                        <Pencil />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          {dialog && (
            <DepartmentForm
              key={dialog.mode === "edit" ? dialog.department.id : "new"}
              department={dialog.mode === "edit" ? dialog.department : undefined}
              onDone={() => setDialog(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function DepartmentForm({
  department,
  onDone,
}: {
  department?: Department;
  onDone: () => void;
}) {
  const createDepartment = useCreateDepartment();
  const updateDepartment = useUpdateDepartment(department?.id ?? "");
  const managers = useEmployeeOptions();
  const [status, setStatus] = useState<DepartmentStatus>(department?.status ?? "ACTIVE");

  const form = useForm<CreateDepartmentInput, unknown, CreateDepartmentRequest>({
    resolver: zodResolver(createDepartmentSchema),
    defaultValues: {
      name: department?.name ?? "",
      code: department?.code ?? "",
      managerId: department?.manager?.id ?? null,
    },
  });
  const { errors, isSubmitting } = form.formState;

  async function submit(values: CreateDepartmentRequest) {
    try {
      if (department) {
        await updateDepartment.mutateAsync({ ...values, status });
        toast.success(`${values.name} updated`);
      } else {
        await createDepartment.mutateAsync(values);
        toast.success(`${values.name} created`);
      }
      onDone();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <form onSubmit={form.handleSubmit(submit)} className="space-y-4" noValidate>
      <DialogHeader>
        <DialogTitle>{department ? `Edit ${department.name}` : "New department"}</DialogTitle>
      </DialogHeader>

      <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" aria-invalid={!!errors.name} {...form.register("name")} />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="code">Code</Label>
          <Input
            id="code"
            className="uppercase"
            aria-invalid={!!errors.code}
            {...form.register("code")}
          />
          {errors.code && <p className="text-sm text-destructive">{errors.code.message}</p>}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="managerId">Manager</Label>
        <Controller
          control={form.control}
          name="managerId"
          render={({ field }) => (
            <Select
              value={field.value ?? NO_MANAGER}
              onValueChange={(v) => field.onChange(v === NO_MANAGER ? null : v)}
            >
              <SelectTrigger id="managerId" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_MANAGER}>No manager</SelectItem>
                {managers.data?.items.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {fullName(e)} · {e.jobTitle}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </div>

      {department && (
        <div className="space-y-2">
          <Label htmlFor="status">Status</Label>
          <Select value={status} onValueChange={(v) => setStatus(v as DepartmentStatus)}>
            <SelectTrigger id="status" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ACTIVE">Active</SelectItem>
              <SelectItem value="ARCHIVED">Archived</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="animate-spin" />}
          {department ? "Save" : "Create"}
        </Button>
      </DialogFooter>
    </form>
  );
}
