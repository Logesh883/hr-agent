"use client";

import type {
  ArchiveEmployeeRequest,
  AuditEntityType,
  AuditLogEntry,
  AuditSearchParams,
  CreateDepartmentRequest,
  CreateEmployeeRequest,
  Department,
  Employee,
  EmployeeSearchParams,
  Paginated,
  UpdateDepartmentRequest,
  UpdateEmployeeRequest,
} from "@hr/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api";
import { useAccessToken } from "./session";

export const queryKeys = {
  employees: (params?: EmployeeSearchParams) => ["employees", params ?? {}] as const,
  employee: (id: string) => ["employee", id] as const,
  departments: ["departments"] as const,
  audit: (entityType: AuditEntityType, entityId: string) =>
    ["audit", entityType, entityId] as const,
  auditSearch: (params: AuditSearchParams) => ["audit", "search", params] as const,
};

// ---- Queries ---------------------------------------------------------------

export function useEmployees(params: EmployeeSearchParams, enabled = true) {
  const token = useAccessToken();
  return useQuery({
    queryKey: queryKeys.employees(params),
    queryFn: () =>
      apiFetch<Paginated<Employee>>(token, "/employees", { query: { ...params } }),
    enabled: !!token && enabled,
    placeholderData: (previous) => previous,
  });
}

export function useEmployee(id: string) {
  const token = useAccessToken();
  return useQuery({
    queryKey: queryKeys.employee(id),
    queryFn: () => apiFetch<Employee>(token, `/employees/${id}`),
    enabled: !!token && !!id,
  });
}

/** Active employees for manager pickers (demo scale: one page of 100). */
export function useEmployeeOptions(enabled = true) {
  return useEmployees({ pageSize: 100 }, enabled);
}

export function useDepartments() {
  const token = useAccessToken();
  return useQuery({
    queryKey: queryKeys.departments,
    queryFn: () => apiFetch<Department[]>(token, "/departments"),
    enabled: !!token,
  });
}

export function useAuditLog(entityType: AuditEntityType, entityId: string, enabled = true) {
  const token = useAccessToken();
  return useQuery({
    queryKey: queryKeys.audit(entityType, entityId),
    queryFn: () =>
      apiFetch<Paginated<AuditLogEntry>>(token, "/audit-logs", {
        query: { entityType, entityId, pageSize: 50 },
      }),
    enabled: !!token && enabled,
  });
}

/** T4.5: the whole audit log, filtered. */
export function useAuditSearch(params: AuditSearchParams) {
  const token = useAccessToken();
  return useQuery({
    queryKey: queryKeys.auditSearch(params),
    queryFn: () =>
      apiFetch<Paginated<AuditLogEntry>>(token, "/audit-logs", { query: { ...params } }),
    enabled: !!token,
    placeholderData: (previous) => previous,
  });
}

// ---- Mutations -------------------------------------------------------------

function useInvalidateEmployees() {
  const queryClient = useQueryClient();
  return (employee: Employee) => {
    queryClient.setQueryData(queryKeys.employee(employee.id), employee);
    void queryClient.invalidateQueries({ queryKey: ["employees"] });
    void queryClient.invalidateQueries({ queryKey: queryKeys.departments });
    void queryClient.invalidateQueries({ queryKey: ["audit", "Employee", employee.id] });
  };
}

export function useCreateEmployee() {
  const token = useAccessToken();
  const onSuccess = useInvalidateEmployees();
  return useMutation({
    mutationFn: (body: CreateEmployeeRequest) =>
      apiFetch<Employee>(token, "/employees", { method: "POST", body }),
    onSuccess,
  });
}

export function useUpdateEmployee(id: string) {
  const token = useAccessToken();
  const onSuccess = useInvalidateEmployees();
  return useMutation({
    mutationFn: (body: UpdateEmployeeRequest) =>
      apiFetch<Employee>(token, `/employees/${id}`, { method: "PATCH", body }),
    onSuccess,
  });
}

export function useSetEmployeeArchived(id: string) {
  const token = useAccessToken();
  const onSuccess = useInvalidateEmployees();
  return useMutation({
    mutationFn: ({ archived, ...body }: ArchiveEmployeeRequest & { archived: boolean }) =>
      apiFetch<Employee>(token, `/employees/${id}/${archived ? "archive" : "reactivate"}`, {
        method: "POST",
        body,
      }),
    onSuccess,
  });
}

function useInvalidateDepartments() {
  const queryClient = useQueryClient();
  return (department: Department) => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.departments });
    void queryClient.invalidateQueries({ queryKey: ["employees"] });
    void queryClient.invalidateQueries({ queryKey: ["audit", "Department", department.id] });
  };
}

export function useCreateDepartment() {
  const token = useAccessToken();
  const onSuccess = useInvalidateDepartments();
  return useMutation({
    mutationFn: (body: CreateDepartmentRequest) =>
      apiFetch<Department>(token, "/departments", { method: "POST", body }),
    onSuccess,
  });
}

export function useUpdateDepartment(id: string) {
  const token = useAccessToken();
  const onSuccess = useInvalidateDepartments();
  return useMutation({
    mutationFn: (body: UpdateDepartmentRequest) =>
      apiFetch<Department>(token, `/departments/${id}`, { method: "PATCH", body }),
    onSuccess,
  });
}
