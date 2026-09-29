"use client";

import type {
  DocumentSearchParams,
  DocumentType,
  EmployeeDocument,
  Paginated,
} from "@hr/contracts";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, apiUpload } from "./api";
import { useOpenFile } from "./open-file";
import { useAccessToken } from "./session";

export const documentKeys = {
  all: ["documents"] as const,
  list: (params: DocumentSearchParams) => ["documents", "list", params] as const,
  employee: (employeeId: string) => ["documents", "employee", employeeId] as const,
};

export function useDocuments(params: DocumentSearchParams, enabled = true) {
  const token = useAccessToken();
  return useQuery({
    queryKey: documentKeys.list(params),
    queryFn: () =>
      apiFetch<Paginated<EmployeeDocument>>(token, "/documents", { query: { ...params } }),
    enabled: !!token && enabled,
    placeholderData: keepPreviousData,
  });
}

export function useEmployeeDocuments(employeeId: string | null | undefined, enabled = true) {
  const token = useAccessToken();
  return useQuery({
    queryKey: documentKeys.employee(employeeId ?? ""),
    queryFn: () => apiFetch<EmployeeDocument[]>(token, `/employees/${employeeId}/documents`),
    enabled: !!token && !!employeeId && enabled,
  });
}

function useInvalidateDocuments() {
  const queryClient = useQueryClient();
  return (doc: EmployeeDocument) => {
    void queryClient.invalidateQueries({ queryKey: documentKeys.all });
    void queryClient.invalidateQueries({ queryKey: ["onboarding"] });
    void queryClient.invalidateQueries({ queryKey: ["audit", "Document", doc.id] });
  };
}

export function useUploadDocument() {
  const token = useAccessToken();
  const onSuccess = useInvalidateDocuments();
  return useMutation({
    mutationFn: ({ employeeId, type, file }: { employeeId: string; type: DocumentType; file: File }) => {
      const form = new FormData();
      form.append("type", type);
      form.append("file", file);
      return apiUpload<EmployeeDocument>(token, `/employees/${employeeId}/documents`, form);
    },
    onSuccess,
  });
}

export function useReviewDocument() {
  const token = useAccessToken();
  const onSuccess = useInvalidateDocuments();
  return useMutation({
    mutationFn: ({ id, action, note }: { id: string; action: "verify" | "flag"; note?: string }) =>
      apiFetch<EmployeeDocument>(token, `/documents/${id}/${action}`, { method: "POST", body: { note } }),
    onSuccess,
  });
}

/** Opens a document in a new tab via an authenticated fetch. */
export function useOpenDocument() {
  const openFile = useOpenFile();
  return (doc: EmployeeDocument) => openFile(`/documents/${doc.id}/file`, doc.fileName);
}
