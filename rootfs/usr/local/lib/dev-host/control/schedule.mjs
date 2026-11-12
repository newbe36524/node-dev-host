export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function scheduleState(until, now = Date.now()) {
  if (!until) return { state: 'none', until: null, daysLeft: null };
  const expiry = Date.parse(until);
  if (!Number.isFinite(expiry)) return { state: 'none', until: null, daysLeft: null };
  if (expiry <= now) return { state: 'ended', until, daysLeft: null };
  return { state: 'active', until, daysLeft: Math.ceil((expiry - now) / 86_400_000) };
}

export function extendWindow(until, now = Date.now()) {
  const next = now + WEEK_MS;
  const current = Date.parse(until || '');
  return new Date(Math.max(Number.isFinite(current) ? current : 0, next)).toISOString();
}

export function clearWindow() {
  return null;
}
