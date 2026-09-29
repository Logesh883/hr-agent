"use client";

import type {
  AttendanceCorrection,
  CorrectionSearchParams,
  DailyAttendance,
  MonthlyAttendance,
  Paginated,
  ProposeCorrectionBody,
} from "@hr/contracts";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api";
import { useAccessToken } from "./session";

export const attendanceKeys = {
  all: ["attendance"] as const,
  daily: (date: string, departmentId?: string) => ["attendance", "daily", date, departmentId ?? null] as const,
  monthly: (month: string, filters: { departmentId?: string; employeeId?: string }) =>
    ["attendance", "monthly", month, filters] as const,
  corrections: (params: CorrectionSearchParams) => ["attendance", "corrections", params] as const,
};

export function useDailyAttendance(date: string, departmentId?: string) {
  const token = useAccessToken();
  return useQuery({
    queryKey: attendanceKeys.daily(date, departmentId),
    queryFn: () =>
      apiFetch<DailyAttendance>(token, "/attendance/daily", { query: { date, departmentId } }),
    enabled: !!token && !!date,
    placeholderData: keepPreviousData,
  });
}

export function useMonthlyAttendance(
  month: string,
  filters: { departmentId?: string; employeeId?: string } = {},
  enabled = true,
) {
  const token = useAccessToken();
  return useQuery({
    queryKey: attendanceKeys.monthly(month, filters),
    queryFn: () =>
      apiFetch<MonthlyAttendance>(token, "/attendance/monthly", { query: { month, ...filters } }),
    enabled: !!token && !!month && enabled,
    placeholderData: keepPreviousData,
  });
}

export function useCorrections(params: CorrectionSearchParams, enabled = true) {
  const token = useAccessToken();
  return useQuery({
    queryKey: attendanceKeys.corrections(params),
    queryFn: () =>
      apiFetch<Paginated<AttendanceCorrection>>(token, "/attendance/corrections", { query: { ...params } }),
    enabled: !!token && enabled,
    placeholderData: keepPreviousData,
  });
}

function useInvalidateAttendance() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
}

export function useProposeCorrection() {
  const token = useAccessToken();
  const onSuccess = useInvalidateAttendance();
  return useMutation({
    mutationFn: (body: ProposeCorrectionBody) =>
      apiFetch<AttendanceCorrection>(token, "/attendance/corrections", { method: "POST", body }),
    onSuccess,
  });
}

export function useReviewCorrection() {
  const token = useAccessToken();
  const onSuccess = useInvalidateAttendance();
  return useMutation({
    mutationFn: ({ id, action, text }: { id: string; action: "approve" | "reject"; text?: string }) =>
      apiFetch<AttendanceCorrection>(token, `/attendance/corrections/${id}/${action}`, {
        method: "POST",
        body: action === "approve" ? { comment: text } : { reason: text },
      }),
    onSuccess,
  });
}
