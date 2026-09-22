import type { Lender } from "./api";

// Categorical colors assigned by lender identity, fixed order (never cycled/reassigned
// by rank) — see the dataviz skill's palette.md categorical theme. Reused across both
// by-lender charts so a given lender is always the same color.
export const LENDER_COLORS: Record<Lender, string> = {
  alphaeon: "#2a78d6", // slot 1 blue
  care_credit: "#eb6834", // slot 2 orange
  proceed: "#1baf7a", // slot 3 aqua
  fortiva: "#eda100", // slot 4 yellow
  access: "#e87ba4", // slot 5 magenta
  sunbit: "#008300", // slot 6 green
  cherry: "#4a3aa7", // slot 7 violet
  covered_care: "#e34948", // slot 8 red
  hfd: "#2a78d6",
  eve: "#eb6834",
};

// Fallback labels; the live list (and which tiers each lender runs) comes from GET /api/lenders.
export const LENDER_LABELS: Record<Lender, string> = {
  hfd: "HFD",
  alphaeon: "Alphaeon",
  cherry: "Cherry",
  care_credit: "CareCredit",
  proceed: "Proceed",
  covered_care: "Covered Care",
  eve: "Eve",
  sunbit: "Sunbit",
  fortiva: "Fortiva",
  access: "Access",
};
