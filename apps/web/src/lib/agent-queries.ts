"use client";

import type { ApprovalDecision, RunList, RunStatus, RunView } from "@hr/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { aiFetch, streamRunEvents, type StreamedEvent } from "./ai";
import { useAccessToken } from "./session";

export const agentKeys = {
  all: ["agent"] as const,
  runs: (status?: RunStatus) => ["agent", "runs", status ?? "any"] as const,
  run: (id: string) => ["agent", "run", id] as const,
};

/** The user's own runs, newest first. `waiting` is their inbox. */
export function useRuns(status?: RunStatus, { poll = false }: { poll?: boolean } = {}) {
  const token = useAccessToken();
  return useQuery({
    queryKey: agentKeys.runs(status),
    queryFn: () => aiFetch<RunList>(token, "/agent/runs", { query: { status, limit: 50 } }),
    enabled: !!token,
    refetchInterval: poll ? 15_000 : false,
    retry: 1,
  });
}

/** One run with its progress; refreshed while it's running. */
export function useRun(id: string) {
  const token = useAccessToken();
  return useQuery({
    queryKey: agentKeys.run(id),
    queryFn: () => aiFetch<RunView>(token, `/agent/runs/${id}`),
    enabled: !!token,
    refetchInterval: (query) => (query.state.data?.status === "running" ? 2_000 : false),
    retry: 1,
  });
}

export function useStartRun() {
  const token = useAccessToken();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: string) =>
      aiFetch<RunView>(token, "/agent/runs", { method: "POST", body: { request } }),
    onSuccess: (run) => {
      queryClient.setQueryData(agentKeys.run(run.id), run);
      void queryClient.invalidateQueries({ queryKey: ["agent", "runs"] });
    },
  });
}

/** Answer a run's question: text, an approval decision, or nothing (continue). */
export function useResumeRun(id: string) {
  const token = useAccessToken();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (answer: string | ApprovalDecision | null) =>
      aiFetch<RunView>(token, `/agent/runs/${id}/resume`, { method: "POST", body: { answer } }),
    onSuccess: (run) => {
      queryClient.setQueryData<RunView>(agentKeys.run(id), (old) =>
        old ? { ...old, status: run.status, question: null } : run,
      );
      void queryClient.invalidateQueries({ queryKey: ["agent", "runs"] });
    },
  });
}

/** Events that change what GET /agent/runs/:id shows. */
const REFRESHING = new Set(["waiting", "finished", "failed", "approval_decided", "verified", "tool_finished"]);

/**
 * T4.7: the run's timeline, live. Replays everything so far, then follows new events
 * while the run is running; reconnects (after the last event seen) when it starts again
 * after an answer. HR data the run may have changed is refreshed when it ends.
 */
export function useRunTimeline(id: string, status: RunStatus | undefined) {
  const token = useAccessToken();
  const queryClient = useQueryClient();
  const [events, setEvents] = useState<StreamedEvent[]>([]);
  const [error, setError] = useState<unknown>(null);
  const lastId = useRef(0);

  useEffect(() => {
    if (!token || !status) return;
    const controller = new AbortController();
    streamRunEvents(
      token,
      id,
      lastId.current,
      (event) => {
        if (event.id <= lastId.current) return;
        lastId.current = event.id;
        setEvents((all) => [...all, event]);
        if (REFRESHING.has(event.event.event)) {
          void queryClient.invalidateQueries({ queryKey: agentKeys.run(id) });
        }
        if (event.event.event === "finished" || event.event.event === "failed") {
          void queryClient.invalidateQueries({ queryKey: ["agent", "runs"] });
          // The agent may have changed HR records shown elsewhere.
          for (const key of ["employees", "employee", "leave", "onboarding", "attendance", "audit"]) {
            void queryClient.invalidateQueries({ queryKey: [key] });
          }
        }
      },
      controller.signal,
    )
      .then(() => setError(null))
      .catch(setError);
    return () => controller.abort();
    // Reopen whenever the run (re)starts; a finished stream stays closed.
  }, [token, id, status === "running", queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  return { events, error };
}
