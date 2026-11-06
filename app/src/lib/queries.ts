import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, type TaskStatus } from "./api";

export const ACTIVE_STATUSES: TaskStatus[] = [
  "queued",
  "scheduled",
  "running",
  "waiting_approval",
];

export function isActive(status: TaskStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: api.me,
    retry: false,
    staleTime: 60_000,
  });
}

export function useHealth() {
  return useQuery({ queryKey: ["health"], queryFn: api.health, staleTime: 60_000, retry: 1 });
}

export function useTasks() {
  return useQuery({
    queryKey: ["tasks"],
    queryFn: api.tasks,
    select: (data) => data.tasks,
    refetchInterval: (query) =>
      (query.state.data?.tasks ?? []).some((task) => isActive(task.status)) ? 2500 : false,
  });
}

export function useTask(id: string | undefined) {
  return useQuery({
    queryKey: ["task", id],
    queryFn: () => api.task(id!),
    enabled: Boolean(id),
    refetchInterval: (query) => (query.state.data && isActive(query.state.data.task.status) ? 2000 : false),
  });
}

export function useConversations() {
  return useQuery({
    queryKey: ["conversations"],
    queryFn: api.conversations,
    select: (data) => data.conversations,
    staleTime: 15_000,
  });
}

export function useMessages(id: string | undefined) {
  return useQuery({
    queryKey: ["messages", id],
    queryFn: () => api.messages(id!),
    enabled: Boolean(id),
    select: (data) => data.messages,
  });
}

export function useConnectors() {
  return useQuery({ queryKey: ["connectors"], queryFn: api.connectors });
}

export function useSignOut() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.logout,
    onSuccess: () => client.clear(),
  });
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Your session expired. Sign in again.";
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}
