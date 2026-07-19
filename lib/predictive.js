// lib/predictive.js — real deterministic forecasting from real historical data.
//
// Pure statistics (ordinary least-squares linear regression over real daily buckets), no LLM
// call, no fabricated numbers. Every series this module is handed comes from data the platform
// already records for other reasons (costLedger, the activity log's real billing events, real
// nginx-log-derived pageviews) — this module never invents a data point. A metric whose real
// history is too short or too flat to support a trend is reported as `null` by forecastFromDaily
// rather than projected from noise; callers must skip it, not paper over the gap with a guess —
// same "a sparse graph beats one padded with unfounded edges" discipline used elsewhere in this
// codebase (the knowledge-graph and marketing-hub agent personas).

const MIN_POINTS = 4; // fewer real daily buckets than this and a linear fit is noise, not a trend

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

// Ordinary least-squares fit over [{x, y}], x a 0-based day index. Returns slope/intercept plus
// R² (coefficient of determination) as a real, computed fit-quality signal — not an assumed one.
function linearRegression(points) {
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  const slope = denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const meanY = sumY / n;
  const ssTot = points.reduce((s, p) => s + (p.y - meanY) ** 2, 0);
  const ssRes = points.reduce((s, p) => { const pred = slope * p.x + intercept; return s + (p.y - pred) ** 2; }, 0);
  const r2 = ssTot === 0 ? (ssRes === 0 ? 1 : 0) : Math.max(0, 1 - ssRes / ssTot);
  return { slope, intercept, r2 };
}

// Bucket real {timestamp, ...} records into daily totals over the last `days` days (oldest first).
// Days with no records get a real 0, not a gap — the regression needs a continuous series.
function bucketDaily(records, days, valueOf = () => 1) {
  const now = Date.now();
  const buckets = new Map();
  for (let i = days - 1; i >= 0; i--) buckets.set(dayKey(now - i * 86400000), 0);
  for (const r of records) {
    const k = dayKey(r.timestamp);
    if (buckets.has(k)) buckets.set(k, buckets.get(k) + valueOf(r));
  }
  return [...buckets.entries()].map(([day, value], x) => ({ day, value, x }));
}

// Forecast the NEXT `periodsAhead`-day total from a real daily series. `current` is the real sum
// of the most recent `periodsAhead` days (not a synthetic baseline); `predicted` is the trend
// line's projection for the next `periodsAhead` days, floored at 0 (a metric can't go negative).
// Returns null when the real history is too short or too sparse to support a trend — see the
// module-level note above on why that's a hard requirement, not a soft one.
function forecastFromDaily(series, { periodsAhead = 7 } = {}) {
  if (series.length < MIN_POINTS) return null;
  const nonZeroDays = series.filter((p) => p.value > 0).length;
  if (nonZeroDays < MIN_POINTS) return null;

  const fit = linearRegression(series.map((p) => ({ x: p.x, y: p.value })));
  const lastX = series[series.length - 1].x;
  let predictedTotal = 0;
  for (let i = 1; i <= periodsAhead; i++) predictedTotal += Math.max(0, fit.slope * (lastX + i) + fit.intercept);
  const currentTotal = series.slice(-periodsAhead).reduce((s, p) => s + p.value, 0);

  // Confidence blends fit quality (R²) with sample depth — a "perfect" fit over 4 points is still
  // less trustworthy than a good fit over 30, so R² alone would overstate confidence too early.
  const depthFactor = Math.min(1, series.length / 30);
  const confidence = Math.max(0.3, Math.min(0.95, fit.r2 * 0.7 + depthFactor * 0.3));

  return {
    current: Math.round(currentTotal * 100) / 100,
    predicted: Math.round(predictedTotal * 100) / 100,
    trend: predictedTotal >= currentTotal ? 'up' : 'down',
    confidence: Math.round(confidence * 100) / 100,
    r2: Math.round(fit.r2 * 100) / 100,
    dataPoints: series.length,
  };
}

// Backtest: fit on the first ~80% of the real series, predict the real held-out last ~20%, and
// report accuracy as (1 - mean absolute percentage error), clamped to [0,1] and expressed 0-100.
// Deliberately NOT the in-sample R² from forecastFromDaily's fit — R² only measures how well the
// line matches the SAME data it was drawn from, which overstates confidence; this scores the fit
// against real points it never saw, a genuinely out-of-sample number.
function backtestAccuracy(series) {
  if (series.length < MIN_POINTS * 2) return null;
  const splitAt = Math.max(MIN_POINTS, Math.floor(series.length * 0.8));
  const train = series.slice(0, splitAt);
  const test = series.slice(splitAt);
  if (!test.length) return null;

  const fit = linearRegression(train.map((p) => ({ x: p.x, y: p.value })));
  let errSum = 0, errCount = 0;
  for (const p of test) {
    const pred = Math.max(0, fit.slope * p.x + fit.intercept);
    if (p.value === 0 && pred === 0) continue; // both zero: no real error to score
    const denom = Math.max(p.value, 1); // avoid dividing by a real zero when only the actual is 0
    errSum += Math.min(1, Math.abs(pred - p.value) / denom);
    errCount++;
  }
  if (!errCount) return null;
  return Math.round(Math.max(0, 1 - errSum / errCount) * 100);
}

module.exports = { MIN_POINTS, linearRegression, bucketDaily, forecastFromDaily, backtestAccuracy };
