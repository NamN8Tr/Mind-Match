/** Formats a server-timed duration as m:ss.t (tenths). Negative values clamp to zero. */
export function formatTime(milliseconds: number): string {
  const totalTenths = Math.max(0, Math.floor(milliseconds / 100));
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${totalTenths % 10}`;
}
