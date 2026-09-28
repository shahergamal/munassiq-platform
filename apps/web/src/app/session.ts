import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { api, ApiError, setCsrfToken } from "../api/client";
import type { Me, Permission, TenantContext } from "../api/types";

export const meKey = ["me"] as const;

/** Current session. Resolves to null when logged out (401), never throws for that case. */
export async function fetchMe(): Promise<Me | null> {
  try {
    const me = await api<Me>("GET", "/auth/me");
    setCsrfToken(me.csrfToken);
    return me;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      setCsrfToken(null);
      return null;
    }
    throw err;
  }
}

export function useMe() {
  return useQuery({ queryKey: meKey, queryFn: fetchMe, staleTime: 60_000, retry: false });
}

export function useLogout() {
  const qc = useQueryClient();
  return useCallback(async () => {
    await api("POST", "/auth/logout").catch(() => undefined);
    setCsrfToken(null);
    qc.clear();
    window.location.assign("/login");
  }, [qc]);
}

export const contextKey = (tenant: string) => ["t", tenant, "context"] as const;

/** Role, permissions, subscription and settings for one tenant, decided by the server for THIS user. */
export function useTenantContext(tenant: string) {
  return useQuery({
    queryKey: contextKey(tenant),
    queryFn: () => api<TenantContext>("GET", "/t/context", { tenant }),
    staleTime: 30_000,
  });
}

/** UI hint only (hide what the user cannot do). The server enforces every permission on every request. */
export function useCan(ctx: TenantContext | undefined) {
  return useCallback((p: Permission) => Boolean(ctx?.permissions.includes(p)), [ctx]);
}

/**
 * One Idempotency-Key per logical operation. It survives retries of the SAME submission (network error,
 * double click), and is renewed only after success or when the user starts a new operation.
 * (The old UI generated a new key on every click, so a retry could create a duplicate order.)
 */
export function useIdempotencyKey(): [string, () => void] {
  const [key, setKey] = useState(() => crypto.randomUUID());
  return [key, useCallback(() => setKey(crypto.randomUUID()), [])];
}
