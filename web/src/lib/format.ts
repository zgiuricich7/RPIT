export const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export const pct = (part: number, whole: number) => (whole ? (part / whole) * 100 : 0);

/** A calendar date ("YYYY-MM-DD") as "Mar 14", with the year when it isn't this year. */
export const formatDate = (date: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString([], {
    month: "short",
    day: "numeric",
    ...(y !== new Date().getFullYear() ? { year: "numeric" } : {}),
  });
};
