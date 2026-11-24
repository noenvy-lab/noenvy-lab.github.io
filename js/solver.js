// Fair rent division: who gets which room, and what each person pays, so that
// nobody would rather have someone else's room at its price ("envy-free").
//
// Pure functions, no DOM, no dependencies. Money is in integer minor units
// (cents). The method is the maximin envy-free solution (Gal, Mash, Procaccia,
// Zick, "Which Is the Fairest (Rent Division) of Them All?", 2016), refined
// lexicographically so that the answer is unique.
//
// Designed and built by an AI agent (Anthropic's Claude), operated by a human.

const EPS = 1e-9;
export const MAX_PEOPLE = 8;

// Tolerances for the rent calculation, in units of money. The amounts are whole units, so two
// different outcomes differ by far more than these; and at the largest total allowed (ten million)
// the rounding noise of the arithmetic stays far below them. They used to be fractions of the total
// rent, where one unit of a ten-million total is 1e-7: a sheet of nearly equal amounts was then
// sometimes refused as having no fair split (found by tools/fuzz-large.mjs, 2026-11-24).
const MISSED_BY_NOISE = 1e-5; // a constraint missed by less than this is rounding noise
const SAME_GAIN = 1e-5;       // two gains closer than this are the same gain
const SLACK = 1e-7;

// ---------------------------------------------------------------- validation

export function validate(input) {
  const bad = (reason, field) => ({ ok: false, reason, field });
  if (!input || typeof input !== "object") return bad("Missing input.", "input");
  const { total, bids } = input;
  const unit = input.unit ?? 1;
  if (!Number.isSafeInteger(total) || total <= 0) {
    return bad("The total rent must be a whole number of cents above zero.", "total");
  }
  if (!Number.isSafeInteger(unit) || unit <= 0 || total % unit !== 0) {
    return bad("The rounding unit must divide the total rent exactly.", "unit");
  }
  if (!Array.isArray(bids) || bids.length < 2 || bids.length > MAX_PEOPLE) {
    return bad(`There must be between 2 and ${MAX_PEOPLE} people.`, "bids");
  }
  const n = bids.length;
  for (let i = 0; i < n; i++) {
    const row = bids[i];
    if (!Array.isArray(row) || row.length !== n) {
      return bad(`Person ${i + 1} must give one amount for each of the ${n} rooms.`, `bids.${i}`);
    }
    let sum = 0;
    for (let j = 0; j < n; j++) {
      if (!Number.isSafeInteger(row[j]) || row[j] < 0) {
        return bad(`Person ${i + 1}'s amount for room ${j + 1} must be a whole number of cents, zero or more.`, `bids.${i}.${j}`);
      }
      sum += row[j];
    }
    if (sum !== total) {
      return bad(`Person ${i + 1}'s amounts add up to ${sum}, but they must add up to the total rent, ${total}.`, `bids.${i}`);
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------- assignment

// The room assignment with the highest total value. Every envy-free outcome
// uses such an assignment. Ties go to the assignment that gives the earliest
// person the lowest-numbered room, so the same input always gives the same
// answer. Returns roomOf[person].
export function bestAssignment(bids) {
  const n = bids.length;
  const size = 1 << n;
  // best[i][mask]: best value for people i..n-1 when the rooms in mask are taken.
  const best = Array.from({ length: n + 1 }, () => new Float64Array(size).fill(-Infinity));
  best[n][size - 1] = 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let mask = 0; mask < size; mask++) {
      if (bitCount(mask) !== i) continue;
      let top = -Infinity;
      for (let j = 0; j < n; j++) {
        if (mask & (1 << j)) continue;
        const value = bids[i][j] + best[i + 1][mask | (1 << j)];
        if (value > top) top = value;
      }
      best[i][mask] = top;
    }
  }
  const roomOf = new Array(n);
  let mask = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (mask & (1 << j)) continue;
      if (bids[i][j] + best[i + 1][mask | (1 << j)] === best[i][mask]) {
        roomOf[i] = j;
        mask |= 1 << j;
        break;
      }
    }
  }
  return roomOf;
}

function bitCount(x) {
  let count = 0;
  for (; x; x &= x - 1) count++;
  return count;
}

// ------------------------------------------------------------ linear program

// Maximize c.x subject to A x <= b, Aeq x = beq, x >= 0.
// Two-phase tableau simplex with Bland's rule. Sized for a handful of variables.
// tolerance: how far the right-hand sides may be missed before the problem counts as infeasible.
export function simplex(c, A, b, Aeq = [], beq = [], tolerance = 1e-7) {
  const tie = tolerance * 1e-2;
  const n = c.length;
  const mLe = A.length;
  const m = mLe + Aeq.length;
  const rows = [];
  const needsArtificial = [];
  for (let r = 0; r < m; r++) {
    const isLe = r < mLe;
    const src = isLe ? A[r] : Aeq[r - mLe];
    const rhs = isLe ? b[r] : beq[r - mLe];
    const sign = rhs < 0 ? -1 : 1;
    rows.push({ coef: src.map((v) => v * sign), rhs: rhs * sign, slack: isLe ? sign : 0 });
    needsArtificial.push(!isLe || sign < 0);
  }
  const artCount = needsArtificial.filter(Boolean).length;
  const width = n + mLe + artCount;
  const T = [];
  const basis = new Array(m);
  let art = 0;
  for (let r = 0; r < m; r++) {
    const line = new Float64Array(width + 1);
    for (let j = 0; j < n; j++) line[j] = rows[r].coef[j];
    if (r < mLe) line[n + r] = rows[r].slack;
    if (needsArtificial[r]) {
      line[n + mLe + art] = 1;
      basis[r] = n + mLe + art;
      art++;
    } else {
      basis[r] = n + r;
    }
    line[width] = rows[r].rhs;
    T.push(line);
  }
  const firstArt = n + mLe;

  const run = (cost, allowed) => {
    for (let guard = 0; guard < 20000; guard++) {
      let enter = -1;
      for (let j = 0; j < allowed; j++) {
        let reduced = cost[j];
        for (let r = 0; r < m; r++) reduced -= cost[basis[r]] * T[r][j];
        if (reduced > EPS) { enter = j; break; }
      }
      if (enter < 0) return "optimal";
      let leave = -1;
      let bestRatio = Infinity;
      for (let r = 0; r < m; r++) {
        if (T[r][enter] <= EPS) continue;
        const ratio = T[r][width] / T[r][enter];
        if (ratio < bestRatio - tie || (ratio < bestRatio + tie && (leave < 0 || basis[r] < basis[leave]))) {
          bestRatio = ratio;
          leave = r;
        }
      }
      if (leave < 0) return "unbounded";
      pivot(T, basis, leave, enter, width);
    }
    throw new Error("simplex: iteration limit reached");
  };

  if (artCount > 0) {
    const phase1 = new Float64Array(width);
    for (let j = firstArt; j < width; j++) phase1[j] = -1;
    run(phase1, width);
    let infeasibility = 0;
    for (let r = 0; r < m; r++) if (basis[r] >= firstArt) infeasibility += T[r][width];
    if (infeasibility > tolerance) return { status: "infeasible" };
    for (let r = 0; r < m; r++) {
      if (basis[r] < firstArt) continue;
      for (let j = 0; j < firstArt; j++) {
        if (Math.abs(T[r][j]) > 1e-7) { pivot(T, basis, r, j, width); break; }
      }
    }
  }
  const cost = new Float64Array(width);
  for (let j = 0; j < n; j++) cost[j] = c[j];
  const status = run(cost, firstArt);
  if (status !== "optimal") return { status };
  const x = new Array(n).fill(0);
  for (let r = 0; r < m; r++) if (basis[r] < n) x[basis[r]] = T[r][width];
  let value = 0;
  for (let j = 0; j < n; j++) value += c[j] * x[j];
  return { status: "optimal", x, value };
}

function pivot(T, basis, row, col, width) {
  const p = T[row][col];
  for (let j = 0; j <= width; j++) T[row][j] /= p;
  for (let r = 0; r < T.length; r++) {
    if (r === row) continue;
    const f = T[r][col];
    if (f === 0) continue;
    for (let j = 0; j <= width; j++) T[r][j] -= f * T[row][j];
  }
  basis[row] = col;
}

// -------------------------------------------------------------------- prices

// Each person's gain: what they said their room is worth, minus what they pay.
// Returns the gains (in units of money, not yet rounded) of the envy-free outcome
// whose smallest gain is as large as possible, then the next smallest, and so
// on. Returns null when no outcome satisfies the constraints.
function leximinGains(bids, roomOf, total, nonNegativePrices) {
  const n = bids.length;
  const own = roomOf.map((room, i) => bids[i][room]);
  const surplus = own.reduce((a, v) => a + v, 0) - total;

  // Variables: gain of each person (0..n-1), then t (n).
  const baseA = [];
  const baseB = [];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      if (i === k) continue;
      // i does not envy k:  gain_k - gain_i <= own_k - (i's value for k's room)
      const row = new Array(n + 1).fill(0);
      row[k] = 1;
      row[i] = -1;
      baseA.push(row);
      baseB.push(own[k] - bids[i][roomOf[k]]);
    }
    if (nonNegativePrices) {
      const row = new Array(n + 1).fill(0);
      row[i] = 1;
      baseA.push(row);
      baseB.push(own[i]);
    }
  }
  const sumRow = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i++) sumRow[i] = 1;

  const fixed = new Array(n).fill(null);
  for (;;) {
    const free = [];
    for (let i = 0; i < n; i++) if (fixed[i] === null) free.push(i);
    if (free.length === 0) break;

    const Aeq = [sumRow];
    const beq = [surplus];
    for (let i = 0; i < n; i++) {
      if (fixed[i] === null) continue;
      const row = new Array(n + 1).fill(0);
      row[i] = 1;
      Aeq.push(row);
      beq.push(fixed[i]);
    }

    const A1 = baseA.slice();
    const b1 = baseB.slice();
    for (const i of free) {
      const row = new Array(n + 1).fill(0);
      row[n] = 1;
      row[i] = -1;
      A1.push(row);
      b1.push(0);
    }
    const objective = new Array(n + 1).fill(0);
    objective[n] = 1;
    const first = simplex(objective, A1, b1, Aeq, beq, MISSED_BY_NOISE);
    if (first.status !== "optimal") return null;
    const floor = first.value;

    // Who is stuck at this floor in every such outcome?
    const A2 = baseA.slice();
    const b2 = baseB.slice();
    for (const i of free) {
      const row = new Array(n + 1).fill(0);
      row[i] = -1;
      A2.push(row);
      b2.push(-(floor - SLACK));
    }
    const reach = [];
    for (const i of free) {
      const goal = new Array(n + 1).fill(0);
      goal[i] = 1;
      const result = simplex(goal, A2, b2, Aeq, beq, MISSED_BY_NOISE);
      reach.push(result.status === "optimal" ? result.value : floor);
    }
    let any = false;
    free.forEach((i, index) => {
      if (reach[index] <= floor + SAME_GAIN) { fixed[i] = floor; any = true; }
    });
    if (!any) {
      let lowest = 0;
      for (let index = 1; index < free.length; index++) if (reach[index] < reach[lowest]) lowest = index;
      fixed[free[lowest]] = floor;
    }
  }
  return fixed;
}

// Round prices to whole units so that they still add up to the total exactly.
// Plain rounding can leave someone a unit better off in another room, so this
// looks at every whole-unit price list within two units of the exact prices and
// keeps the one with the least envy; among those, the one whose worst-off
// person gains most (then the next worst-off, and so on); among those, the
// first in room order. With nonNegativePrices, no price goes below zero.
// The same input therefore always gives the same prices.
function roundToUnit(bids, roomOf, exact, total, unit, nonNegativePrices) {
  const n = exact.length;
  const target = Math.round(total / unit);
  const base = exact.map((p) => Math.floor(p / unit + 1e-7));
  const current = new Array(n);
  let best = null;
  const consider = () => {
    if (nonNegativePrices && current.some((q) => q < 0)) return;
    let maxEnvy = 0;
    const gains = new Array(n);
    for (let i = 0; i < n; i++) {
      const mine = bids[i][roomOf[i]] - current[roomOf[i]] * unit;
      gains[i] = mine;
      for (let j = 0; j < n; j++) {
        const envy = bids[i][j] - current[j] * unit - mine;
        if (envy > maxEnvy) maxEnvy = envy;
      }
    }
    gains.sort((a, b) => a - b);
    if (best !== null) {
      if (maxEnvy > best.maxEnvy) return;
      if (maxEnvy === best.maxEnvy) {
        let better = false;
        for (let k = 0; k < n; k++) {
          if (gains[k] !== best.gains[k]) { better = gains[k] > best.gains[k]; break; }
        }
        if (!better) return;
      }
    }
    best = { maxEnvy, gains, prices: current.slice() };
  };
  const walk = (room, sum) => {
    if (room === n - 1) {
      const last = target - sum;
      if (last < base[room] - 1 || last > base[room] + 2) return;
      current[room] = last;
      consider();
      return;
    }
    for (let step = -1; step <= 2; step++) {
      current[room] = base[room] + step;
      walk(room + 1, sum + current[room]);
    }
  };
  walk(0, 0);
  return best.prices.map((q) => q * unit);
}

// --------------------------------------------------------------------- solve

// input: { total, bids[person][room], unit = 1, nonNegativePrices = false }
// On success: { ok: true, roomOf, personOf, prices[room], pays[person],
//               exactPrices[room], check }
// where check is verify()'s independent report on the rounded prices.
export function solve(input) {
  const valid = validate(input);
  if (!valid.ok) return valid;
  const { total, bids } = input;
  const unit = input.unit ?? 1;
  const nonNegativePrices = Boolean(input.nonNegativePrices);
  const n = bids.length;

  const roomOf = bestAssignment(bids);
  const personOf = new Array(n);
  roomOf.forEach((room, person) => { personOf[room] = person; });

  const gains = leximinGains(bids, roomOf, total, nonNegativePrices);
  if (gains === null) {
    return {
      ok: false,
      reason: nonNegativePrices
        ? "With these amounts, no split keeps every room's rent at zero or more and leaves nobody preferring another room. Allow a negative rent, or revisit the amounts."
        : "No envy-free split was found for these amounts.",
      field: "bids",
    };
  }
  const exactPrices = new Array(n);
  for (let room = 0; room < n; room++) {
    const person = personOf[room];
    exactPrices[room] = bids[person][room] - gains[person];
  }
  const prices = roundToUnit(bids, roomOf, exactPrices, total, unit, nonNegativePrices);
  const pays = roomOf.map((room) => prices[room]);
  const check = verify({ total, bids }, roomOf, prices);
  return { ok: true, roomOf, personOf, prices, pays, exactPrices, unit, check };
}

// -------------------------------------------------------------------- verify

// An independent check that shares no code with the price calculation.
// table[person][room] = that person's amount for the room minus its rent.
// envy[person] = how much better off (in cents) the person would be in their
// favourite other room at its rent; 0 means no envy.
export function verify(input, roomOf, prices) {
  const { total, bids } = input;
  const n = bids.length;
  const sum = prices.reduce((a, v) => a + v, 0);
  const seen = new Set(roomOf);
  const table = bids.map((row) => row.map((value, room) => value - prices[room]));
  const envy = [];
  const wouldSwapTo = [];
  for (let i = 0; i < n; i++) {
    const mine = table[i][roomOf[i]];
    let worst = 0;
    let target = null;
    for (let j = 0; j < n; j++) {
      if (j === roomOf[i]) continue;
      if (table[i][j] - mine > worst) { worst = table[i][j] - mine; target = j; }
    }
    envy.push(worst);
    wouldSwapTo.push(target);
  }
  const gains = roomOf.map((room, i) => table[i][room]);
  return {
    sumMatchesTotal: sum === total,
    everyRoomTaken: seen.size === n && roomOf.every((r) => Number.isInteger(r) && r >= 0 && r < n),
    table,
    gains,
    envy,
    wouldSwapTo,
    maxEnvy: Math.max(...envy),
    lowestPrice: Math.min(...prices),
  };
}
