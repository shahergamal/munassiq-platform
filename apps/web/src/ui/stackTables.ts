/**
 * Phones: plain tables (form lines, detail tables) turn each row into a labelled block instead of scrolling
 * sideways. This gives every cell the text of its column header (`data-label`) and marks the table `is-stacked`;
 * the layout itself is CSS (shell.css). Tables whose meaning is their grid keep the grid: accounting statements,
 * the permission matrix, the printable invoice, and any table marked `no-stack`.
 */
const SKIP = ".no-stack, .acc-report, .ca-perm-matrix, .inv-lines";

function headerLabels(table: HTMLTableElement): string[] {
  const labels: string[] = [];
  for (const th of Array.from(table.tHead?.rows[0]?.cells ?? [])) {
    // A header that only exists for screen readers ("حذف", "إجراءات") gives no visible label.
    const text = (th.textContent ?? "").trim();
    const hiddenOnly = th.querySelector(".sr-only")?.textContent?.trim() === text;
    for (let i = 0; i < th.colSpan; i++) labels.push(hiddenOnly ? "" : text);
  }
  return labels;
}

function label(table: HTMLTableElement) {
  if (table.matches(SKIP)) return;
  const labels = headerLabels(table);
  if (!labels.length) return;
  table.classList.add("is-stacked");
  for (const section of [...Array.from(table.tBodies), ...(table.tFoot ? [table.tFoot] : [])]) {
    for (const row of Array.from(section.rows)) {
      let col = 0;
      for (const cell of Array.from(row.cells)) {
        const text = cell.colSpan > 1 ? "" : labels[col] ?? "";
        if (cell.dataset.label !== text) cell.dataset.label = text;
        col += cell.colSpan;
      }
    }
  }
}

export function stackTablesOnPhones() {
  if (typeof MutationObserver === "undefined") return;
  let queued = false;
  const run = () => { queued = false; document.querySelectorAll<HTMLTableElement>("table.data-table").forEach(label); };
  new MutationObserver(() => { if (!queued) { queued = true; requestAnimationFrame(run); } })
    .observe(document.body, { childList: true, subtree: true });
  run();
}
