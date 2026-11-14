export const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export const pct = (part: number, whole: number) => (whole ? (part / whole) * 100 : 0);
