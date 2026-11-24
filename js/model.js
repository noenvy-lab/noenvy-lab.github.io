// The rent sheet: who lives here, the rooms, what each room is worth to each
// person, and the latest split. No DOM here, so it runs under Node for tests.
// Every operation checks its whole input first and refuses by returning
// {ok: false, reason, field}; nothing changes when it refuses.
//
// Amounts are whole currency units (rent is rarely agreed in cents).

import { solve as solveSplit, verify } from "./solver.js";

export const LIMITS = Object.freeze({
  minPeople: 2,
  maxPeople: 8,
  maxTotal: 10000000,
  nameLength: 24,
  currencyLength: 4,
});

const refuse = (reason, field) => ({ ok: false, reason, field });

// total shared out as evenly as whole numbers allow.
export function evenSplit(total, n) {
  const base = Math.floor(total / n);
  const extra = total - base * n;
  return Array.from({ length: n }, (_, k) => base + (k < extra ? 1 : 0));
}

// Scale a row of amounts so that it adds up to total, keeping its proportions.
export function scaleRow(row, total) {
  const sum = row.reduce((a, v) => a + v, 0);
  if (sum === 0) return evenSplit(total, row.length);
  const exact = row.map((v) => (v * total) / sum);
  const floors = exact.map((v) => Math.floor(v + 1e-9));
  let missing = total - floors.reduce((a, v) => a + v, 0);
  const order = exact.map((v, j) => ({ j, frac: v - floors[j] })).sort((a, b) => b.frac - a.frac || a.j - b.j);
  for (let k = 0; missing > 0; k = (k + 1) % order.length, missing--) floors[order[k].j] += 1;
  return floors;
}

function inWords(names) {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// The solver's answer, but only if it passes its own independent check. A wrong answer shown with a tick
// would be worse than no answer, and a failure inside the calculation must not leave the button dead.
function checkedSplit(input) {
  let outcome;
  try {
    outcome = solveSplit(input);
  } catch {
    return refuse("The calculation could not be completed for these numbers. Nothing was changed.", "result");
  }
  if (!outcome.ok) return outcome;
  const check = outcome.check;
  const people = input.bids.length;
  // Whole-number rents can leave someone a unit short; anything beyond a few units is not rounding.
  const sound = check.sumMatchesTotal && check.everyRoomTaken !== false && check.maxEnvy <= people && !(input.nonNegativePrices && check.lowestPrice < 0);
  if (!sound) return refuse("The calculation did not pass its own check, so no split is shown. Please report the numbers you entered.", "result");
  return outcome;
}

export function money(amount, currency) {
  const digits = Math.abs(amount).toLocaleString("en-US");
  return `${amount < 0 ? "−" : ""}${currency}${digits}`;
}

function cleanNames(list, what) {
  if (!Array.isArray(list)) return refuse(`Give the ${what} as a list of names.`, what);
  if (list.length < LIMITS.minPeople || list.length > LIMITS.maxPeople) {
    return refuse(`There must be between ${LIMITS.minPeople} and ${LIMITS.maxPeople} ${what}.`, what);
  }
  const names = [];
  for (let k = 0; k < list.length; k++) {
    if (typeof list[k] !== "string") return refuse(`Each name in ${what} must be text.`, `${what}.${k}`);
    const name = list[k].trim().replace(/\s+/g, " ");
    if (name.length === 0) return refuse(`Name number ${k + 1} in ${what} is empty.`, `${what}.${k}`);
    if (name.length > LIMITS.nameLength) {
      return refuse(`"${name}" is longer than ${LIMITS.nameLength} characters.`, `${what}.${k}`);
    }
    if (names.some((other) => other.toLowerCase() === name.toLowerCase())) {
      return refuse(`"${name}" appears twice in ${what}. Give each a different name.`, `${what}.${k}`);
    }
    names.push(name);
  }
  return { ok: true, names };
}

function cleanTotal(total) {
  if (!Number.isSafeInteger(total) || total < 1 || total > LIMITS.maxTotal) {
    return refuse(`The total rent must be a whole number from 1 to ${LIMITS.maxTotal.toLocaleString("en-US")}.`, "total");
  }
  return { ok: true };
}

function cleanCurrency(currency) {
  if (typeof currency !== "string" || currency.trim().length > LIMITS.currencyLength) {
    return refuse(`The currency sign can be up to ${LIMITS.currencyLength} characters, such as $ or NT$.`, "currency");
  }
  return { ok: true, currency: currency.trim() };
}

function newId() {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 10);
}

export class Sheet {
  constructor() {
    this.id = newId();
    this.currency = "$";
    this.total = 0;
    this.people = ["Housemate 1", "Housemate 2", "Housemate 3"];
    this.rooms = ["Room 1", "Room 2", "Room 3"];
    this.bids = this.people.map(() => [0, 0, 0]);
    this.touched = this.people.map(() => false);
    // Rows that still hold the example's made-up amounts. Nobody entered those.
    this.madeUp = this.people.map(() => false);
    // True on the copy sent to one housemate: the other housemates' amounts are left out of it.
    this.personal = false;
    this.nonNegativePrices = false;
    this.isExample = false;
    this.version = 0;
    this.result = null;
  }

  static example() {
    const sheet = new Sheet();
    sheet.total = 2400;
    sheet.people = ["Ana", "Ben", "Chloe"];
    sheet.rooms = ["Big room with balcony", "Middle room", "Small room by the door"];
    sheet.bids = [
      [1200, 750, 450],
      [950, 850, 600],
      [900, 800, 700],
    ];
    sheet.touched = [true, true, true];
    sheet.madeUp = [true, true, true];
    sheet.isExample = true;
    return sheet;
  }

  get size() {
    return this.people.length;
  }

  changed() {
    this.version += 1;
    this.result = null;
  }

  // ------------------------------------------------------------ operations

  // Any of: total, currency, people, rooms. People and rooms must end up the
  // same length. Changing how many there are starts everyone's amounts again
  // from an even split; changing only the total rescales them.
  setSetup(change) {
    if (!change || typeof change !== "object") return refuse("Nothing to change.", "setup");
    let { total, currency } = this;
    let people = this.people;
    let rooms = this.rooms;
    if (change.total !== undefined) {
      const checked = cleanTotal(change.total);
      if (!checked.ok) return checked;
      total = change.total;
    }
    if (change.currency !== undefined) {
      const checked = cleanCurrency(change.currency);
      if (!checked.ok) return checked;
      currency = checked.currency;
    }
    if (change.people !== undefined) {
      const checked = cleanNames(change.people, "people");
      if (!checked.ok) return checked;
      people = checked.names;
    }
    if (change.rooms !== undefined) {
      const checked = cleanNames(change.rooms, "rooms");
      if (!checked.ok) return checked;
      rooms = checked.names;
    }
    if (people.length !== rooms.length) {
      return refuse(`There are ${people.length} people and ${rooms.length} rooms. Each person needs exactly one room, so give the same number of each.`, "rooms");
    }
    const sizeChanged = people.length !== this.size;
    const totalChanged = total !== this.total;
    const renamed = sizeChanged || people.some((name, i) => name !== this.people[i]) || rooms.some((name, j) => name !== this.rooms[j]);
    // A new currency sign alone leaves the example what it is. A new total or new names make it a real place.
    const placeChanged = totalChanged || renamed;
    if (sizeChanged) {
      this.bids = people.map(() => evenSplit(total, rooms.length));
      this.touched = people.map(() => false);
      this.madeUp = people.map(() => false);
    } else if (placeChanged) {
      // Rows that still hold the example's made-up amounts must not stay behind as if these housemates had
      // entered them: they go back to the even placeholder. Rows somebody entered keep their proportions.
      this.bids = this.bids.map((row, i) => {
        if (this.madeUp[i]) return evenSplit(total, rooms.length);
        return totalChanged ? scaleRow(row, total) : row;
      });
      this.touched = this.touched.map((flag, i) => flag && !this.madeUp[i]);
      this.madeUp = people.map(() => false);
    }
    this.total = total;
    this.currency = currency;
    this.people = people;
    this.rooms = rooms;
    if (placeChanged) this.isExample = false;
    this.changed();
    return { ok: true, ...this.getState() };
  }

  checkPerson(person) {
    if (!Number.isInteger(person) || person < 0 || person >= this.size) {
      return refuse(`There is no person number ${person}. People are numbered from 0 to ${this.size - 1}.`, "person");
    }
    return { ok: true };
  }

  // One person's complete set of amounts. They must add up to the total rent.
  setBids(person, amounts) {
    const checked = this.checkPerson(person);
    if (!checked.ok) return checked;
    if (this.total < 1) return refuse("Set the total rent first.", "total");
    if (!Array.isArray(amounts) || amounts.length !== this.size) {
      return refuse(`Give one amount for each of the ${this.size} rooms, in room order.`, "amounts");
    }
    for (let j = 0; j < amounts.length; j++) {
      if (!Number.isSafeInteger(amounts[j]) || amounts[j] < 0) {
        return refuse(`The amount for ${this.rooms[j]} must be a whole number, zero or more.`, `amounts.${j}`);
      }
    }
    const sum = amounts.reduce((a, v) => a + v, 0);
    if (sum !== this.total) {
      const gap = this.total - sum;
      return refuse(
        `${this.people[person]}'s amounts add up to ${money(sum, this.currency)}, which is ${money(Math.abs(gap), this.currency)} ${gap > 0 ? "under" : "over"} the total rent of ${money(this.total, this.currency)}. They must add up to it exactly.`,
        "amounts",
      );
    }
    this.bids[person] = amounts.slice();
    this.touched[person] = true;
    this.madeUp[person] = false;
    this.isExample = false;
    this.changed();
    return { ok: true, ...this.getState() };
  }

  // One box of the page's own form. The row may not add up yet while typing.
  setAmount(person, room, value) {
    const checked = this.checkPerson(person);
    if (!checked.ok) return checked;
    if (!Number.isInteger(room) || room < 0 || room >= this.size) return refuse("No such room.", "room");
    if (!Number.isSafeInteger(value) || value < 0 || value > LIMITS.maxTotal) {
      return refuse("An amount must be a whole number, zero or more.", "value");
    }
    this.bids[person][room] = value;
    this.touched[person] = true;
    this.madeUp[person] = false;
    this.isExample = false;
    this.changed();
    return { ok: true };
  }

  // Scale one person's amounts so that they add up, keeping their proportions.
  balance(person) {
    const checked = this.checkPerson(person);
    if (!checked.ok) return checked;
    if (this.total < 1) return refuse("Set the total rent first.", "total");
    this.bids[person] = scaleRow(this.bids[person], this.total);
    this.changed();
    return { ok: true, ...this.getState() };
  }

  setOption(options) {
    if (!options || typeof options.nonNegativePrices !== "boolean") {
      return refuse("nonNegativePrices must be true or false.", "nonNegativePrices");
    }
    this.nonNegativePrices = options.nonNegativePrices;
    this.changed();
    return { ok: true, ...this.getState() };
  }

  problems() {
    const list = [];
    if (this.total < 1) list.push({ field: "total", reason: "Enter the total rent." });
    this.people.forEach((name, i) => {
      const gap = this.total - this.bids[i].reduce((a, v) => a + v, 0);
      if (this.total >= 1 && gap !== 0) {
        list.push({
          field: `bids.${i}`,
          reason: `${name}'s amounts are ${money(Math.abs(gap), this.currency)} ${gap > 0 ? "under" : "over"} the total rent.`,
        });
      }
    });
    return list;
  }

  // Work out the split and show it. Refuses until every row adds up.
  solve() {
    const problems = this.problems();
    if (problems.length > 0) {
      return refuse(problems.map((p) => p.reason).join(" "), problems[0].field);
    }
    const outcome = checkedSplit({ total: this.total, bids: this.bids, nonNegativePrices: this.nonNegativePrices });
    if (!outcome.ok) return outcome;
    const described = Sheet.describe(outcome, this);
    const waiting = this.unanswered();
    if (waiting.length > 0) {
      described.unanswered = waiting;
      described.notes.unshift(this.personal
        ? `This copy of the sheet was sent to one housemate, so it does not carry the amounts of ${inWords(waiting)}: ${waiting.length === 1 ? "that row is" : "those rows are"} an even placeholder. The real split is found on the sheet of whoever sent the link, once the replies are in.`
        : `${inWords(waiting)} ${waiting.length === 1 ? "has" : "have"} not entered amounts yet. ${waiting.length === 1 ? "That row is" : "Those rows are"} still an even placeholder, which says they do not mind which room they get. Ask them, then find the split again.`);
    }
    this.result = { version: this.version, ...described };
    return { ok: true, ...this.getState() };
  }

  // People whose row is still the even placeholder nobody has touched.
  unanswered() {
    return this.people.filter((_, i) => !this.touched[i]);
  }

  hasMadeUpAmounts() {
    return this.madeUp.some(Boolean);
  }

  // The same calculation for amounts given as arguments. Changes nothing.
  static preview(input) {
    const people = input.people ?? input.bids?.map?.((_, i) => `Person ${i + 1}`);
    const rooms = input.rooms ?? input.bids?.map?.((_, j) => `Room ${j + 1}`);
    const outcome = checkedSplit({ total: input.total, bids: input.bids, nonNegativePrices: Boolean(input.nonNegativePrices) });
    if (!outcome.ok) return outcome;
    if (!Array.isArray(people) || !Array.isArray(rooms) || people.length !== input.bids.length || rooms.length !== input.bids.length) {
      return refuse("Give one name per person and one per room, or leave the names out.", "people");
    }
    return {
      ok: true,
      ...Sheet.describe(outcome, { total: input.total, bids: input.bids, people, rooms, currency: input.currency ?? "" }),
    };
  }

  // Turn the solver's answer into names, amounts and a plain account of it.
  static describe(outcome, sheet) {
    const { total, bids, people, rooms, currency } = sheet;
    const n = people.length;
    const assignments = outcome.roomOf.map((room, person) => ({
      person,
      personName: people[person],
      room,
      roomName: rooms[room],
      pays: outcome.prices[room],
      valuesRoomAt: bids[person][room],
      gain: bids[person][room] - outcome.prices[room],
    }));
    const rents = rooms.map((roomName, room) => ({ room, roomName, rent: outcome.prices[room], goesTo: people[outcome.personOf[room]] }));
    const even = evenSplit(total, n);
    const evenCheck = verify({ total, bids }, outcome.roomOf, even);
    const evenSplitEnvy = [];
    evenCheck.envy.forEach((amount, person) => {
      if (amount > 0) {
        evenSplitEnvy.push({ personName: people[person], wouldRatherHave: rooms[evenCheck.wouldSwapTo[person]], by: amount });
      }
    });
    const notes = [];
    if (outcome.check.maxEnvy > 0) {
      const short = outcome.check.envy.filter((amount) => amount > 0).length;
      // The rounding looks at every whole-number list of rents within two units of the exact answer, so
      // that much is what can be claimed.
      notes.push(`Rents are whole numbers, so ${short === 1 ? "one person is" : `${short} people are each`} up to ${money(outcome.check.maxEnvy, currency)} short of a perfect match. No whole-number split close to the exact answer does better.`);
    }
    if (outcome.check.lowestPrice < 0) {
      const room = outcome.prices.indexOf(outcome.check.lowestPrice);
      notes.push(`${rooms[room]} has a rent below zero: by these amounts, the others would rather pay ${people[outcome.personOf[room]]} to take it than take it themselves. If that is not acceptable, turn on "No rent below zero" or revisit the amounts.`);
    }
    return {
      assignments,
      rents,
      check: {
        // table[person][room]: what that person said the room is worth, minus its rent.
        table: outcome.check.table,
        envy: outcome.check.envy,
        maxEnvy: outcome.check.maxEnvy,
        rentsAddUpToTotal: outcome.check.sumMatchesTotal,
      },
      evenSplit: { rentEach: even, envy: evenSplitEnvy },
      notes,
      method: "Rooms go where they are valued most in total. Rents are then set so that nobody prefers another room at its rent, choosing the rents that make the least-well-off person as well off as possible.",
    };
  }

  // -------------------------------------------------------------- reading

  getState() {
    const problems = this.problems();
    return {
      version: this.version,
      currency: this.currency,
      total: this.total,
      people: this.people.map((name, index) => {
        const sum = this.bids[index].reduce((a, v) => a + v, 0);
        return {
          index,
          name,
          amounts: this.bids[index].slice(),
          sum,
          stillToAssign: this.total - sum,
          addsUp: this.total >= 1 && sum === this.total,
          hasEnteredAmounts: this.touched[index],
        };
      }),
      rooms: this.rooms.map((name, index) => ({ index, name })),
      options: { nonNegativePrices: this.nonNegativePrices },
      // Names of people whose row is still the untouched even placeholder: ask them before trusting a split.
      unanswered: this.unanswered(),
      // True on a copy sent to one housemate: the others' amounts were left out of it on purpose.
      personalCopy: this.personal,
      readyToSplit: problems.length === 0,
      problems: problems.map((p) => p.reason),
      isExample: this.isExample,
      result: this.result && this.result.version === this.version ? this.result : null,
      limits: LIMITS,
    };
  }

  // ------------------------------------------------------- saving, sharing

  toJSON() {
    return {
      v: 1,
      id: this.id,
      c: this.currency,
      t: this.total,
      p: this.people,
      r: this.rooms,
      b: this.bids,
      // Per row: 0 nobody entered it, 1 entered, 2 still the example's made-up amounts.
      d: this.touched.map((x, i) => (x ? (this.madeUp[i] ? 2 : 1) : 0)),
      n: this.nonNegativePrices ? 1 : 0,
      e: this.isExample ? 1 : 0,
      ...(this.personal ? { o: 1 } : {}),
    };
  }

  // Data from a link or from storage is checked like any other input.
  static fromJSON(data) {
    if (!data || typeof data !== "object" || data.v !== 1) return null;
    const sheet = new Sheet();
    if (typeof data.id === "string" && /^[a-z0-9]{4,16}$/.test(data.id)) sheet.id = data.id;
    const currency = cleanCurrency(data.c);
    const people = cleanNames(data.p, "people");
    const rooms = cleanNames(data.r, "rooms");
    if (!currency.ok || !people.ok || !rooms.ok || people.names.length !== rooms.names.length) return null;
    const n = people.names.length;
    if (data.t !== 0 && !cleanTotal(data.t).ok) return null;
    if (!Array.isArray(data.b) || data.b.length !== n) return null;
    for (const row of data.b) {
      if (!Array.isArray(row) || row.length !== n) return null;
      if (!row.every((v) => Number.isSafeInteger(v) && v >= 0 && v <= LIMITS.maxTotal)) return null;
    }
    sheet.currency = currency.currency;
    sheet.total = data.t;
    sheet.people = people.names;
    sheet.rooms = rooms.names;
    sheet.bids = data.b.map((row) => row.slice());
    sheet.touched = people.names.map((_, i) => Boolean(Array.isArray(data.d) && data.d[i]));
    sheet.nonNegativePrices = Boolean(data.n);
    sheet.isExample = Boolean(data.e);
    // (A sheet saved before rows were marked one by one: an untouched example is all made up.)
    sheet.madeUp = sheet.touched.map((flag, i) => flag && (data.d[i] === 2 || sheet.isExample));
    sheet.personal = Boolean(data.o);
    return sheet;
  }

  // What one housemate sends back after filling in their own amounts.
  replyFor(person) {
    return { v: 1, id: this.id, person, name: this.people[person], amounts: this.bids[person].slice(), total: this.total, rooms: this.rooms.slice() };
  }

  // The sheet as one housemate should receive it: everyone else's amounts left out, so that a later answer is
  // not shaped by the earlier ones. Their own reply carries only their own row back.
  toJSONFor(person) {
    const data = JSON.parse(JSON.stringify(this.toJSON()));
    data.b = data.b.map((row, i) => (i === person ? row : evenSplit(this.total, this.size)));
    data.d = data.d.map((flag, i) => (i === person ? flag : 0));
    data.e = 0;
    data.o = 1;
    return data;
  }

  // Take one housemate's reply into this sheet.
  acceptReply(reply) {
    if (!reply || typeof reply !== "object" || reply.v !== 1) return refuse("This link does not contain a housemate's amounts.", "reply");
    if (reply.id !== this.id) {
      return refuse("These amounts belong to a different rent sheet than the one open here.", "reply");
    }
    const checked = this.checkPerson(reply.person);
    if (!checked.ok) return checked;
    // Amounts are attached to rooms by position, so they only fit the rooms and the total they were written for.
    if (reply.total !== undefined && reply.total !== this.total) {
      return refuse("The total rent on this sheet has changed since these amounts were entered. Send that housemate their link again.", "reply");
    }
    if (reply.rooms !== undefined && (!Array.isArray(reply.rooms) || reply.rooms.length !== this.size || reply.rooms.some((name, j) => name !== this.rooms[j]))) {
      return refuse("The rooms on this sheet have changed since these amounts were entered. Send that housemate their link again.", "reply");
    }
    if (reply.name !== this.people[reply.person]) {
      return refuse(`These amounts were entered for "${String(reply.name).slice(0, LIMITS.nameLength)}", but that place on this sheet is now ${this.people[reply.person]}.`, "reply");
    }
    return this.setBids(reply.person, reply.amounts);
  }
}
