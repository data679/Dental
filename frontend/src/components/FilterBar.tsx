import type { ApplicationStatus, ApplicationType, Lender, LocationOption } from "../lib/api";

export interface Filters {
  locationId?: number;
  dateFrom: string;
  dateTo: string;
  applicationType?: ApplicationType;
  status?: ApplicationStatus;
  lender?: Lender;
  newPatientsOnly: boolean;
}

const LENDERS: Array<{ value: Lender; label: string }> = [
  { value: "care_credit", label: "CareCredit" },
  { value: "alphaeon", label: "Alphaeon" },
  { value: "cherry", label: "Cherry" },
  { value: "proceed", label: "Proceed" },
  { value: "sunbit", label: "Sunbit" },
  { value: "hfd", label: "HFD" },
  { value: "covered_care", label: "Covered Care" },
  { value: "eve", label: "Eve" },
  { value: "fortiva", label: "Fortiva" },
  { value: "access", label: "Access" },
];

interface FilterBarProps {
  filters: Filters;
  locations: LocationOption[];
  onChange: (next: Filters) => void;
}

const selectClass =
  "rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-700 focus:border-blue-500 focus:outline-none";

export function FilterBar({ filters, locations, onChange }: FilterBarProps) {
  return (
    <div className="mb-6 grid grid-cols-2 gap-4 rounded-lg border border-gray-200 bg-white p-4 sm:grid-cols-3 lg:grid-cols-6">
      <div>
        <label className="mb-1 block text-xs font-medium text-gray-500">Practice Name</label>
        <select
          className={`${selectClass} w-full`}
          value={filters.locationId ?? ""}
          onChange={(e) =>
            onChange({ ...filters, locationId: e.target.value ? Number(e.target.value) : undefined })
          }
        >
          <option value="">All</option>
          {locations.map((loc) => (
            <option key={loc.id} value={loc.id}>
              {loc.name}
            </option>
          ))}
        </select>
      </div>

      <div className="col-span-2">
        <label className="mb-1 block text-xs font-medium text-gray-500">Select Date Range</label>
        <div className="flex items-center gap-2">
          <input
            type="date"
            className={`${selectClass} w-full`}
            value={filters.dateFrom}
            onChange={(e) => onChange({ ...filters, dateFrom: e.target.value })}
          />
          <span className="text-gray-400">to</span>
          <input
            type="date"
            className={`${selectClass} w-full`}
            value={filters.dateTo}
            onChange={(e) => onChange({ ...filters, dateTo: e.target.value })}
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-gray-500">Prime vs SubPrime</label>
        <select
          className={`${selectClass} w-full`}
          value={filters.applicationType ?? ""}
          onChange={(e) =>
            onChange({
              ...filters,
              applicationType: (e.target.value || undefined) as ApplicationType | undefined,
            })
          }
        >
          <option value="">All</option>
          <option value="primary">Prime</option>
          <option value="subprime">SubPrime</option>
        </select>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-gray-500">Status Filter</label>
        <select
          className={`${selectClass} w-full`}
          value={filters.status ?? ""}
          onChange={(e) =>
            onChange({ ...filters, status: (e.target.value || undefined) as ApplicationStatus | undefined })
          }
        >
          <option value="">All</option>
          <option value="submitted">Submitted</option>
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="declined">Declined</option>
        </select>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-gray-500">Lender</label>
        <select
          className={`${selectClass} w-full`}
          value={filters.lender ?? ""}
          onChange={(e) => onChange({ ...filters, lender: (e.target.value || undefined) as Lender | undefined })}
        >
          <option value="">All</option>
          {LENDERS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </div>

      <div className="col-span-2 sm:col-span-1">
        <label className="mb-1 block text-xs font-medium text-gray-500" title="New Patients = patients whose first completed visit falls inside the selected date range. A booked appointment alone doesn't count.">
          Patient Type
        </label>
        <div className="inline-flex rounded-md border border-gray-300 bg-gray-50 p-0.5">
          {(
            [
              { label: "All", value: false },
              { label: "New Patients", value: true },
            ] as const
          ).map((opt) => (
            <button
              key={opt.label}
              type="button"
              onClick={() => onChange({ ...filters, newPatientsOnly: opt.value })}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                filters.newPatientsOnly === opt.value
                  ? "bg-gray-900 text-white"
                  : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
