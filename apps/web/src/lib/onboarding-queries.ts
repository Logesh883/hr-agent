"use client";

import type {
  EmployeeOnboarding,
  OnboardingSearchParams,
  OnboardingSummary,
  OnboardingTask,
  Paginated,
  UpdateOnboardingTaskBody,
} from "@hr/contracts";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./api";
import { useAccessToken } from "./session";

export const onboardingKeys = {
  all: ["onboarding"] as const,
  list: (params: OnboardingSearchParams) => ["onboarding", "list", params] as const,
  employee: (employeeId: string) => ["onboarding", "employee", employeeId] as const,
};

export function useOnboardingList(params: OnboardingSearchParams, enabled = true) {
  const token = useAccessToken();
  return useQuery({
    queryKey: onboardingKeys.list(params),
    queryFn: () =>
      apiFetch<Paginated<OnboardingSummary>>(token, "/onboarding", { query: { ...params } }),
    enabled: !!token && enabled,
    placeholderData: keepPreviousData,
  });
}

export function useEmployeeOnboarding(employeeId: string | null | undefined, enabled = true) {
  const token = useAccessToken();
  return useQuery({
    queryKey: onboardingKeys.employee(employeeId ?? ""),
    queryFn: () => apiFetch<EmployeeOnboarding>(token, `/employees/${employeeId}/onboarding`),
    enabled: !!token && !!employeeId && enabled,
  });
}

export function useStartOnboarding(employeeId: string) {
  const token = useAccessToken();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<EmployeeOnboarding>(token, `/employees/${employeeId}/onboarding`, { method: "POST" }),
    onSuccess: (data) => {
      queryClient.setQueryData(onboardingKeys.employee(employeeId), data);
      void queryClient.invalidateQueries({ queryKey: onboardingKeys.all });
      void queryClient.invalidateQueries({ queryKey: ["audit", "Employee", employeeId] });
    },
  });
}

export function useUpdateOnboardingTask() {
  const token = useAccessToken();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: UpdateOnboardingTaskBody & { id: string }) =>
      apiFetch<OnboardingTask>(token, `/onboarding/tasks/${id}`, { method: "PATCH", body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: onboardingKeys.all });
    },
  });
}
