"use client";

import type { EmployeeAccess, Role, TemporaryPasswordResponse } from "@hr/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api";
import { useAccessToken } from "./session";

const accessKey = (employeeId: string) => ["access", employeeId] as const;

export function useEmployeeAccess(employeeId: string, enabled = true) {
  const token = useAccessToken();
  return useQuery({
    queryKey: accessKey(employeeId),
    queryFn: () => apiFetch<EmployeeAccess>(token, `/employees/${employeeId}/access`),
    enabled: !!token && enabled,
  });
}

function useAccessMutation<TVars, TResult extends EmployeeAccess | TemporaryPasswordResponse>(
  employeeId: string,
  request: (token: string | undefined, vars: TVars) => Promise<TResult>,
) {
  const token = useAccessToken();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: TVars) => request(token, vars),
    onSuccess: (result) => {
      queryClient.setQueryData(accessKey(employeeId), "access" in result ? result.access : result);
      void queryClient.invalidateQueries({ queryKey: ["audit", "Employee", employeeId] });
    },
  });
}

export function useGrantAccess(employeeId: string) {
  return useAccessMutation(employeeId, (token, role: Role) =>
    apiFetch<TemporaryPasswordResponse>(token, `/employees/${employeeId}/access`, { method: "POST", body: { role } }),
  );
}

export function useUpdateAccess(employeeId: string) {
  return useAccessMutation(employeeId, (token, body: { role?: Role; isActive?: boolean }) =>
    apiFetch<EmployeeAccess>(token, `/employees/${employeeId}/access`, { method: "PATCH", body }),
  );
}

export function useResetPassword(employeeId: string) {
  return useAccessMutation<void, TemporaryPasswordResponse>(employeeId, (token) =>
    apiFetch<TemporaryPasswordResponse>(token, `/employees/${employeeId}/access/reset-password`, { method: "POST" }),
  );
}
