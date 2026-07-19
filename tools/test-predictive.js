// Predictive Analytics (lib/predictive.js): real deterministic forecasting — ordinary
// least-squares linear regression over real daily-bucketed history, out-of-sample backtested
// accuracy, and the "too little real data → null, never a fabricated forecast" discipline.
const { assert, done } = require('./test-util');
const predictive = require('../lib/predictive');
const { MIN_POINTS, linearRegression, bucketDaily, forecastFromDaily, backtestAccuracy } = predictive;

(async () => {
  // --- linearRegression(): a perfect line is fit exactly, R²=1
  const perfectLine = [{ x: 0, y: 3 }, { x: 1, y: 5 }, { x: 2, y: 7 }, { x: 3, y: 9 }]; // y = 2x + 3
  const fit1 = linearRegression(perfectLine);
  assert(Math.abs(fit1.slope - 2) < 1e-9, `perfect line: slope≈2 (got ${fit1.slope})`);
  assert(Math.abs(fit1.intercept - 3) < 1e-9, `perfect line: intercept≈3 (got ${fit1.intercept})`);
  assert(Math.abs(fit1.r2 - 1) < 1e-9, `perfect line: R²≈1 (got ${fit1.r2})`);

  // --- linearRegression(): a flat (zero-variance) series never NaNs — R²=1 by convention (no residual to explain)
  const flat = [{ x: 0, y: 5 }, { x: 1, y: 5 }, { x: 2, y: 5 }];
  const fit2 = linearRegression(flat);
  assert(fit2.slope === 0 && fit2.r2 === 1 && !Number.isNaN(fit2.r2), `flat series: slope=0, R²=1, never NaN (got ${JSON.stringify(fit2)})`);

  // --- linearRegression(): a noisy series produces R² strictly between 0 and 1, never NaN/negative
  const noisy = [{ x: 0, y: 1 }, { x: 1, y: 8 }, { x: 2, y: 2 }, { x: 3, y: 9 }, { x: 4, y: 3 }];
  const fit3 = linearRegression(noisy);
  assert(fit3.r2 >= 0 && fit3.r2 <= 1 && !Number.isNaN(fit3.r2), `noisy series: R² in [0,1] (got ${fit3.r2})`);

  // --- bucketDaily(): fills every day in the window (including days with zero real records), sums correctly
  const now = Date.now();
  const records = [
    { timestamp: new Date(now).toISOString(), val: 10 },
    { timestamp: new Date(now).toISOString(), val: 5 }, // same day, second record — must sum, not overwrite
    { timestamp: new Date(now - 2 * 86400000).toISOString(), val: 7 },
  ];
  const buckets = bucketDaily(records, 5, (r) => r.val);
  assert(buckets.length === 5, `bucketDaily returns exactly \`days\` buckets (got ${buckets.length})`);
  assert(buckets[buckets.length - 1].value === 15, `today's bucket sums same-day records (got ${buckets[buckets.length - 1].value})`);
  assert(buckets[buckets.length - 3].value === 7, `a 2-day-old record lands in the correct bucket (got ${buckets[buckets.length - 3].value})`);
  assert(buckets[0].value === 0, `a day with no real records is a real 0, not a gap (got ${buckets[0].value})`);
  assert(buckets.every((b, i) => b.x === i), 'bucket x indices are 0-based and sequential, matching linearRegression\'s expected input shape');

  // --- forecastFromDaily(): too few real data points → null, never a fabricated forecast
  const tooFew = bucketDaily([{ timestamp: new Date().toISOString() }], 2, () => 1);
  assert(forecastFromDaily(tooFew) === null, `fewer than MIN_POINTS (${MIN_POINTS}) buckets → null, not a guess`);

  // --- forecastFromDaily(): real history exists but is too sparse (mostly zero days) → null
  const sparse = Array.from({ length: 10 }, (_, x) => ({ day: `d${x}`, value: x === 9 ? 5 : 0, x }));
  assert(forecastFromDaily(sparse) === null, 'a series with only one non-zero day (below MIN_POINTS) is too sparse to trend → null');

  // --- forecastFromDaily(): a genuine upward trend forecasts up, with current/predicted matching real math
  const upSeries = Array.from({ length: 14 }, (_, x) => ({ day: `d${x}`, value: 10 + x * 2, x })); // 10,12,14,...,36
  const upForecast = forecastFromDaily(upSeries, { periodsAhead: 7 });
  assert(upForecast !== null, 'a real 14-day upward series produces a forecast, not null');
  assert(upForecast.trend === 'up', `upward series forecasts trend:'up' (got ${upForecast.trend})`);
  assert(upForecast.predicted > upForecast.current, `predicted (${upForecast.predicted}) exceeds current (${upForecast.current}) for a real upward trend`);
  const expectedCurrent = upSeries.slice(-7).reduce((s, p) => s + p.value, 0);
  assert(upForecast.current === expectedCurrent, `current is the REAL sum of the last 7 real days, not a derived/rounded estimate (expected ${expectedCurrent}, got ${upForecast.current})`);
  assert(upForecast.dataPoints === 14, `dataPoints reports the real series length (got ${upForecast.dataPoints})`);

  // --- forecastFromDaily(): a genuine downward trend forecasts down
  const downSeries = Array.from({ length: 14 }, (_, x) => ({ day: `d${x}`, value: Math.max(0, 40 - x * 3), x }));
  const downForecast = forecastFromDaily(downSeries, { periodsAhead: 7 });
  assert(downForecast.trend === 'down', `downward series forecasts trend:'down' (got ${downForecast.trend})`);
  assert(downForecast.predicted < downForecast.current, `predicted (${downForecast.predicted}) is below current (${downForecast.current}) for a real downward trend`);

  // --- forecastFromDaily(): predicted never goes negative even on a steep downward trend
  const crashSeries = Array.from({ length: 10 }, (_, x) => ({ day: `d${x}`, value: Math.max(0.1, 50 - x * 8), x }));
  const crashForecast = forecastFromDaily(crashSeries, { periodsAhead: 7 });
  assert(crashForecast.predicted >= 0, `a steep downward trend still floors predicted at 0, never negative (got ${crashForecast.predicted})`);

  // --- forecastFromDaily(): confidence is always clamped to [0.3, 0.95], never NaN or out of range
  for (const f of [upForecast, downForecast, crashForecast]) {
    assert(f.confidence >= 0.3 && f.confidence <= 0.95 && !Number.isNaN(f.confidence), `confidence stays in [0.3, 0.95] (got ${f.confidence})`);
  }

  // --- backtestAccuracy(): too few points for a train/test split → null
  assert(backtestAccuracy(bucketDaily([], 5)) === null, 'fewer than MIN_POINTS*2 buckets → null, not a fabricated accuracy');

  // --- backtestAccuracy(): a real perfect linear series backtests to ~100% (genuinely out-of-sample, not just in-sample R²)
  const perfectSeries = Array.from({ length: 20 }, (_, x) => ({ day: `d${x}`, value: 5 + x * 3, x }));
  const perfectAcc = backtestAccuracy(perfectSeries);
  assert(perfectAcc !== null && perfectAcc >= 95, `a real perfect linear trend backtests to ~100% accuracy (got ${perfectAcc})`);

  // --- backtestAccuracy(): a real noisy series backtests to something strictly between 0 and 100, never NaN
  const noisySeries = Array.from({ length: 20 }, (_, x) => ({ day: `d${x}`, value: x % 2 === 0 ? 5 : 45, x }));
  const noisyAcc = backtestAccuracy(noisySeries);
  assert(noisyAcc !== null && noisyAcc >= 0 && noisyAcc <= 100 && !Number.isNaN(noisyAcc), `a real noisy series backtests to a valid 0-100 accuracy, never NaN (got ${noisyAcc})`);
  assert(noisyAcc < perfectAcc, `a genuinely noisy series backtests LOWER than a perfect trend — accuracy reflects real out-of-sample fit, not just optimism (noisy=${noisyAcc}, perfect=${perfectAcc})`);

  done();
})().catch((e) => { console.error('FAIL: suite crashed —', e.message); process.exitCode = 1; done(); });
