/** Published DeepSeek Flash tariff, verified 2026-10-07. Prices are nano-USD per token. */
export const PRICING_VERSION = "deepseek-flash-2026-09-10";
export const USD_NANOS = 1000000000,
  CREDIT_NANOS = 1000000,
  BASE_WEEKLY_CREDITS = 1000;
export const OFF_PEAK = { input: 150, cache: 3, output: 600 },
  PEAK = { input: 300, cache: 6, output: 1200 };
export const PRICE_SOURCE =
  "https://api-docs.deepseek.com/quick_start/pricing/";
export const HOLIDAY_SOURCE =
  "https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html";
const ranges2026 = [
  ["01-01", "01-03"],
  ["02-15", "02-23"],
  ["04-04", "04-06"],
  ["05-01", "05-05"],
  ["06-19", "06-21"],
  ["09-25", "09-27"],
  ["10-01", "10-07"],
];
export function isHoliday(date) {
  const day = date.toISOString().slice(0, 10);
  return (
    day.startsWith("2026-") &&
    ranges2026.some(([a, b]) => day >= "2026-" + a && day <= "2026-" + b)
  );
}
export function ratesAt(ms) {
  if (!Number.isSafeInteger(ms)) throw new Error("PRICING_CLOCK_INVALID");
  const date = new Date(ms),
    weekday = date.getUTCDay(),
    hour = date.getUTCHours();
  const window = (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10),
    peak = weekday >= 1 && weekday <= 5 && window && !isHoliday(date);
  return {
    version: PRICING_VERSION,
    band: peak ? "peak" : "off_peak",
    ...(peak ? PEAK : OFF_PEAK),
    calendarVerified: date.getUTCFullYear() === 2026,
  };
}
export function ratesForWindow(from, to) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from)
    throw new Error("PRICING_CLOCK_INVALID");
  const start = new Date(from),
    first = Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth(),
      start.getUTCDate(),
    );
  if (to - from > 366 * 86400000)
    return {
      version: PRICING_VERSION,
      band: "peak",
      ...PEAK,
      calendarVerified: false,
    };
  for (let day = first; day <= to; day += 86400000) {
    const d = new Date(day),
      weekday = d.getUTCDay();
    if (weekday === 0 || weekday === 6 || isHoliday(d)) continue;
    for (const [a, b] of [
      [1, 4],
      [6, 10],
    ])
      if (from < day + b * 3600000 && to >= day + a * 3600000)
        return {
          version: PRICING_VERSION,
          band: "peak",
          ...PEAK,
          calendarVerified: d.getUTCFullYear() === 2026,
        };
  }
  return ratesAt(from);
}
export function nanoCost(usage, rates) {
  for (const value of [
    usage.input,
    usage.cacheRead,
    usage.cacheWrite,
    usage.output,
  ])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("INVALID_USAGE");
  const value =
    (usage.input + usage.cacheWrite) * rates.input +
    usage.cacheRead * rates.cache +
    usage.output * rates.output;
  if (!Number.isSafeInteger(value)) throw new Error("COST_OVERFLOW");
  return value;
}
export function credits(nanos) {
  return nanos / CREDIT_NANOS;
}
