export interface PageParams {
  page: number;
  pageSize: number;
  offset: number;
}

export function parsePage(query: { page?: unknown; pageSize?: unknown }, maxPageSize = 100): PageParams {
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const pageSize = Math.min(maxPageSize, Math.max(1, Math.floor(Number(query.pageSize) || 25)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function pageMeta(p: PageParams, total: number) {
  return { page: p.page, pageSize: p.pageSize, total, totalPages: Math.max(1, Math.ceil(total / p.pageSize)) };
}

/** Escape LIKE wildcards so user input is matched literally. */
export function likePattern(input: string): string {
  return `%${input.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export const MAX_SORT_LEVELS = 3;

/**
 * Multi-column ORDER BY from `?sort=supplierName:asc,total:desc`. Only names in `allowed` (the endpoint's own
 * output column aliases) are accepted; anything else is dropped, so the client can never reach an input column.
 * Returns the items followed by ", " so the endpoint's own ordering stays as the final tie-breaker.
 */
export function sortSql(raw: unknown, allowed: readonly string[]): string {
  if (typeof raw !== "string" || !raw) return "";
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const item of raw.split(",")) {
    const [key = "", dir] = item.split(":");
    if (!allowed.includes(key) || seen.has(key)) continue;
    seen.add(key);
    parts.push(`"${key}" ${dir === "desc" ? "DESC" : "ASC"} NULLS LAST`);
    if (parts.length === MAX_SORT_LEVELS) break;
  }
  return parts.length ? `${parts.join(", ")}, ` : "";
}
