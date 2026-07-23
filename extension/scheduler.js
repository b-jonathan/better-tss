const SPREAD_WEIGHT = {
  "extremely-compact": 1,
  compact: 0.6,
  neutral: 0,
  "slightly-spread-out": -0.6,
  "really-spread-out": -1,
};

const BACK_TO_BACK_GAP = 15;

function blocksOverlap(a, b) {
  return a.day === b.day && a.start < b.end && b.start < a.end;
}

function conflictsWith(blocks, occupied) {
  for (const b of blocks) {
    for (const o of occupied) {
      if (blocksOverlap(b, o)) return true;
    }
  }
  return false;
}

function allBlocks(chosen) {
  const blocks = [];
  for (const pick of chosen) {
    for (const b of pick.option.blocks) blocks.push(b);
  }
  return blocks;
}

function scheduleFitness(chosen, prefs) {
  const blocks = allBlocks(chosen);
  if (blocks.length === 0) return 0;

  const parts = [];
  const preferredStart = prefs.preferredStart ?? 0;
  const preferredEnd = prefs.preferredEnd ?? 24 * 60;

  let inWindow = 0;
  let totalMinutes = 0;
  for (const b of blocks) {
    totalMinutes += b.end - b.start;
    inWindow += Math.max(0, Math.min(b.end, preferredEnd) - Math.max(b.start, preferredStart));
  }
  parts.push({ w: 1, v: totalMinutes ? inWindow / totalMinutes : 1 });

  if (prefs.preferredDays && prefs.preferredDays.length) {
    const wanted = new Set(prefs.preferredDays);
    let onPreferred = 0;
    for (const b of blocks) if (wanted.has(b.day)) onPreferred += b.end - b.start;
    parts.push({ w: 1, v: totalMinutes ? onPreferred / totalMinutes : 1 });
  }

  const byDay = new Map();
  for (const b of blocks) {
    if (!byDay.has(b.day)) byDay.set(b.day, []);
    byDay.get(b.day).push(b);
  }
  let totalGap = 0;
  let totalSpan = 0;
  let backToBack = 0;
  let adjacencies = 0;
  for (const day of byDay.values()) {
    day.sort((x, y) => x.start - y.start);
    totalSpan += day[day.length - 1].end - day[0].start;
    for (let i = 1; i < day.length; i++) {
      const gap = day[i].start - day[i - 1].end;
      adjacencies++;
      if (gap > 0) totalGap += gap;
      if (gap <= BACK_TO_BACK_GAP) backToBack++;
    }
  }

  if (prefs.avoidBackToBack) {
    parts.push({ w: 1, v: adjacencies ? 1 - backToBack / adjacencies : 1 });
  }

  const spreadWeight = SPREAD_WEIGHT[prefs.spread] ?? 0;
  if (spreadWeight !== 0) {
    const gapRatio = totalSpan ? Math.min(1, totalGap / totalSpan) : 0;
    if (spreadWeight > 0) {
      const daysScore = 1 - (byDay.size - 1) / 4;
      parts.push({ w: spreadWeight, v: (1 - gapRatio) * 0.6 + Math.max(0, daysScore) * 0.4 });
    } else {
      parts.push({ w: -spreadWeight, v: gapRatio });
    }
  }

  const weightSum = parts.reduce((s, p) => s + p.w, 0);
  const valueSum = parts.reduce((s, p) => s + p.w * p.v, 0);
  return weightSum ? valueSum / weightSum : 0;
}

function generateSchedules(courses, prefs, options = {}) {
  const cap = options.cap ?? 500;
  const stepBudget = options.stepBudget ?? 300000;
  const order = [...courses]
    .filter((c) => c.options.length > 0)
    .sort((a, b) => a.options.length - b.options.length);

  const results = [];
  let steps = 0;
  let exhausted = true;

  function dfs(index, chosen, occupied) {
    if (results.length >= cap || steps >= stepBudget) {
      exhausted = false;
      return;
    }
    if (index === order.length) {
      results.push(chosen.slice());
      return;
    }
    for (const option of order[index].options) {
      steps++;
      if (steps >= stepBudget) {
        exhausted = false;
        return;
      }
      if (conflictsWith(option.blocks, occupied)) continue;
      chosen.push({ courseId: order[index].courseId, option });
      dfs(index + 1, chosen, occupied.concat(option.blocks));
      chosen.pop();
      if (results.length >= cap) {
        exhausted = false;
        return;
      }
    }
  }

  dfs(0, [], (prefs.busy || []).slice());

  const scored = results.map((chosen) => ({ chosen, score: scheduleFitness(chosen, prefs) }));
  scored.sort((a, b) => b.score - a.score);
  return { schedules: scored, exhausted, count: scored.length };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { generateSchedules, scheduleFitness, blocksOverlap };
}
