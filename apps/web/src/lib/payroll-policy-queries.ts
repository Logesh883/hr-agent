"use client";

import type { PayrollReport, Policy, PolicyCategory, PolicyVersion } from "@hr/contracts";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiUpload } from "./api";
import { useAccessToken } from "./session";

export function usePayrollReport(month: string) {
  const token = useAccessToken();
  return useQuery({
    queryKey: ["payroll", month],
    queryFn: () => apiFetch<PayrollReport>(token, "/payroll/preparation", { query: { month } }),
    enabled: !!token && !!month,
    placeholderData: keepPreviousData,
  });
}

export function usePolicies() {
  const token = useAccessToken();
  return useQuery({
    queryKey: ["policies"],
    queryFn: () => apiFetch<Policy[]>(token, "/policies"),
    enabled: !!token,
  });
}

export function usePublishPolicy() {
  const token = useAccessToken();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      title: string;
      category: PolicyCategory;
      effectiveFrom: string;
      summary?: string;
      file: File;
    }) => {
      const form = new FormData();
      form.append("title", input.title);
      form.append("category", input.category);
      form.append("effectiveFrom", input.effectiveFrom);
      if (input.summary) form.append("summary", input.summary);
      form.append("file", input.file);
      return apiUpload<PolicyVersion>(token, "/policies", form);
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["policies"] }),
  });
}
