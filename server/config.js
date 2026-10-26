// App settings. Values here are the shop's business rules, kept in one place so they
// can be changed without touching the logic. Environment variables override where noted.

export const settings = {
  timeZone: 'America/Denver',

  // Shop hours on the board (24h clock, shop local time)
  openHour: 8,
  closeHour: 17,

  // Working days for pay-period pace (0 = Sunday … 6 = Saturday)
  workDays: [1, 2, 3, 4, 5],

  // Carry-over work (no booked time today) is placed from this hour, so mornings stay open
  // for incoming cars. Drag a card to plan it earlier.
  carryOverStartHour: 13,

  // Default daily capacity per tech, in sold hours
  defaultCapacityHours: 8,

  // A tech is "Near full" at or above this share of capacity
  nearFullRatio: 0.85,

  // Not-arrived appointments are flagged as possible no-shows this many minutes after their start
  noShowGraceMinutes: 60,

  // Tekmetric shop IDs → display names. Leave empty to use every shop the API key can see.
  // Example: { 1234: 'Denver', 5678: 'Littleton' }
  shopNames: {},

  // RO label rules: Toy Doctor's Tekmetric labels, exactly as named in Tekmetric.
  // Matching ignores capitals, spaces and punctuation ("Work In Progress 25%" = "work in progress 25").
  // A label not listed here counts only if the RO is promised today (or the customer hasn't arrived yet).
  labelRules: {
    // counts toward the tech's load
    active: ['Waiting On Diag/ Insp', 'Parts ETA Today', 'Parts Here WIP 0%', 'Work In Progress 25%', 'Work In Progress 50%', 'Work In Progress 75%', 'Due Today!', 'Employee/ Internal'],
    // shown as parts hold, not counted
    partsHold: ['Source/ Pull Parts', 'PART DELAYED!', 'Onsite- Parts Hold'],
    // shown as offsite, not counted
    offsite: ['Off Site-Parts Ordered', 'Off Site -Appt. Needed', 'Scheduled! Off Site'],
    // finished work
    done: ['Complete-In QC'],
    // Day – Service Advisor view: ROs waiting on the customer's OK (listed under each advisor)
    authorization: ['Pending Authorization', 'Estimating'],
    // everything else (Estimating, Pending Authorization, *MAIN CONCERN IN*, NEEDS DEPOSIT, Warranty_)
    // waits on the customer or the shop: not counted
  },
};
