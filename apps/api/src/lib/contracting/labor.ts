import { allocateProportionally, type Halalas } from "../money.ts";

// Allocating payroll to projects, pure. An employee's cost for the month (pay after penalties, employer GOSI and the
// end-of-service accrual) is shared among the projects by the hours recorded on each, over the hours the employee
// worked that month (attendance), or over the project hours when they are more. What is not on a project stays where
// the payroll put it (the employee's own cost center). Amounts in halalas; per-project totals only leave this module.

export interface EmployeeMonth { cost: Halalas; attendanceHours: number; projectHours: Record<string, number> }

export function allocateLabor(employees: EmployeeMonth[]) {
  const byProject = new Map<string, { amount: Halalas; hours: number }>();
  let allocated = 0;
  let unallocated = 0;
  for (const e of employees) {
    const ids = Object.keys(e.projectHours).filter((p) => e.projectHours[p]! > 0);
    const onProjects = ids.reduce((a, p) => a + e.projectHours[p]!, 0);
    const base = Math.max(e.attendanceHours, onProjects);
    if (!ids.length || base <= 0 || e.cost <= 0) { unallocated += Math.max(0, e.cost); continue; }
    const share = Math.round((e.cost * onProjects) / base);
    const parts = allocateProportionally(share, ids.map((p) => e.projectHours[p]!));
    ids.forEach((p, i) => {
      const cur = byProject.get(p) ?? { amount: 0, hours: 0 };
      byProject.set(p, { amount: cur.amount + parts[i]!, hours: cur.hours + e.projectHours[p]! });
    });
    allocated += share;
    unallocated += e.cost - share;
  }
  return { byProject, allocated, unallocated };
}
