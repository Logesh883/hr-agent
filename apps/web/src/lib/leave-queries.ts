"use client";

import type {
  Holiday,
  LeaveBalance,
  LeavePreview,
  LeaveRequest,
  LeaveRequestBody,
  LeaveSearchParams,
  Paginated,
} from "@hr/contracts";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api";
import { useAccessToken } from "./session";

export const leaveKeys = {
  all: ["leave"] as const,
  list: (params: LeaveSearchParams) => ["leave", "list", params] as const,
  balances: (employeeId: string, year: number) => ["leave", "balances", employeeId, year] as const,
  preview: (body: LeaveRequestBody) => ["leave", "preview", body] as const,
  holidays: (year: number) => ["holidays", year] as const,
};

export function useLeaveRequests(params: LeaveSearchParams, enabled = true) {
  const token = useAccessToken();
  return useQuery({
    queryKey: leaveKeys.list(params),
    queryFn: () =>
      apiFetch<Paginated<LeaveRequest>>(token, "/leave-requests", { query: { ...params } }),
    enabled: !!token && enabled,
    placeholderData: keepPreviousData,
  });
}

export function useLeaveBalances(employeeId: string | null | undefined, year: number, enabled = true) {
  const token = useAccessToken();
  return useQuery({
    queryKey: leaveKeys.balances(employeeId ?? "", year),
    queryFn: () =>
      apiFetch<LeaveBalance[]>(token, `/employees/${employeeId}/leave-balances`, { query: { year } }),
    enabled: !!token && !!employeeId && enabled,
  });
}

/** Server-side dry run of a request: working days, balance after, and problems. */
export function useLeavePreview(body: LeaveRequestBody | null) {
  const token = useAccessToken();
  return useQuery({
    queryKey: leaveKeys.preview(body ?? ({} as LeaveRequestBody)),
    queryFn: () =>
      apiFetch<LeavePreview>(token, "/leave-requests/preview", { method: "POST", body }),
    enabled: !!token && !!body,
    staleTime: 0,
    placeholderData: keepPreviousData,
  });
}

export function useHolidays(year: number) {
  const token = useAccessToken();
  return useQuery({
    queryKey: leaveKeys.holidays(year),
    queryFn: () => apiFetch<Holiday[]>(token, "/holidays", { query: { year } }),
    enabled: !!token,
    staleTime: 60 * 60_000,
  });
}

function useLeaveMutation<TVars>(request: (token: string | undefined, vars: TVars) => Promise<LeaveRequest>) {
  const token = useAccessToken();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: TVars) => request(token, vars),
    onSuccess: (leave) => {
      void queryClient.invalidateQueries({ queryKey: leaveKeys.all });
      void queryClient.invalidateQueries({ queryKey: ["audit", "LeaveRequest", leave.id] });
    },
  });
}

export function useCreateLeave() {
  return useLeaveMutation((token, body: LeaveRequestBody) =>
    apiFetch<LeaveRequest>(token, "/leave-requests", { method: "POST", body }),
  );
}

export function useApproveLeave() {
  return useLeaveMutation((token, { id, comment }: { id: string; comment?: string }) =>
    apiFetch<LeaveRequest>(token, `/leave-requests/${id}/approve`, { method: "POST", body: { comment } }),
  );
}

export function useRejectLeave() {
  return useLeaveMutation((token, { id, reason }: { id: string; reason: string }) =>
    apiFetch<LeaveRequest>(token, `/leave-requests/${id}/reject`, { method: "POST", body: { reason } }),
  );
}

export function useCancelLeave() {
  return useLeaveMutation((token, id: string) =>
    apiFetch<LeaveRequest>(token, `/leave-requests/${id}/cancel`, { method: "POST" }),
  );
}
