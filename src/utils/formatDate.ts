type DateInput = string | number | Date | null | undefined;

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

function toDate(input: DateInput): Date {
  if (input == null) return new Date();
  return input instanceof Date ? input : new Date(input);
}

export function formatMonthYear(input: DateInput): string {
  const d = toDate(input);
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

export function formatDMY(input: DateInput): string {
  const d = toDate(input);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${d.getFullYear()}`;
}

export function diffMonths(a: DateInput, b: DateInput): number {
  const da = toDate(a);
  const db = toDate(b);
  return (da.getFullYear() - db.getFullYear()) * 12 +
    (da.getMonth() - db.getMonth());
}
