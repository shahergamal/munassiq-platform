// Overall equipment effectiveness of one work center over a period, pure. The inputs come from what the system
// records; the definitions are stated so the numbers can be checked by hand:
//   planned time   = the center's hours per day × the period's days (every day counts: no shift calendar yet)
//   downtime       = maintenance downtime on the center's machines (breakdowns and preventive stops)
//   availability   = (planned − downtime) ÷ planned
//   performance    = standard minutes earned (planned minutes of the operation × produced ÷ ordered) ÷ minutes worked
//   quality        = good output ÷ (good + scrap) of the orders the center worked on
//   OEE            = availability × performance × quality
//   utilization    = minutes worked ÷ (planned − downtime): how loaded the center was (not part of OEE)

export interface OeeInput { plannedMinutes: number; downtimeMinutes: number; runMinutes: number; standardMinutes: number; good: number; scrap: number }

const r4 = (n: number) => Math.round(n * 10000) / 10000;

export function oee(x: OeeInput) {
  const available = Math.max(0, x.plannedMinutes - x.downtimeMinutes);
  const availability = x.plannedMinutes > 0 ? available / x.plannedMinutes : 0;
  const performance = x.runMinutes > 0 ? x.standardMinutes / x.runMinutes : 0;
  const quality = x.good + x.scrap > 0 ? x.good / (x.good + x.scrap) : 0;
  return {
    availability: r4(availability), performance: r4(performance), quality: r4(quality),
    oee: r4(availability * performance * quality),
    utilization: available > 0 ? r4(x.runMinutes / available) : 0,
  };
}
