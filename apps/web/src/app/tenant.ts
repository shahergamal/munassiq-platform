import { useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { TenantContext } from "../api/types";
import { useCan, useTenantContext } from "./session";

/**
 * The tenant for pages under /w/$tenantId. The id only selects which tenant to ASK for: the server
 * checks membership on every request (X-Tenant-Id), so a guessed URL returns 403, never data.
 */
export function useTenant() {
  const { tenantId } = useParams({ strict: false }) as { tenantId: string };
  const ctx = useTenantContext(tenantId);
  const can = useCan(ctx.data);
  const data = ctx.data as TenantContext;
  // Writes are hidden when the tenant is not operational or in a read-only support session; the server refuses them anyway.
  const writable = Boolean(data?.operational && !data?.readOnlySupport);
  // The business decides a few words and fields (a factory's "items" are a restaurant's "ingredients").
  const sector = data?.tenant.sector ?? "restaurants";
  return { tenantId, ctx: data, can, writable, sector, factory: sector === "manufacturing" };
}

/** Invalidate every cached query of this tenant under a prefix, e.g. ["ingredients"]. */
export function useInvalidate(tenantId: string) {
  const qc = useQueryClient();
  return useCallback((...keys: string[]) => Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: ["t", tenantId, k] }))), [qc, tenantId]);
}
