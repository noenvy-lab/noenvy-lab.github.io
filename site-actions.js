// Registers what the No Envy page can do with the agent runtime.
// agent-manifest.json loads this module through "actions.module". Only the names in
// "actions.agentTools" become model tools, called website_<name>.
//
// Every action calls the same App.page operation as the page's own boxes and buttons,
// so the rules and the arithmetic live in one place (js/model.js, js/solver.js). An
// operation refuses by returning {ok: false, reason, field} and changes nothing.
// Imported by the URL index.html loads it from, so there is one page object.
import { App } from "./js/app.js";

const WHOLE = { type: "integer", minimum: 0, maximum: 10000000 };
const NAME = { type: "string", minLength: 1, maxLength: 24 };
const LEASE_HELP = Object.freeze({
  site: "Plainly",
  page: "https://sainath998.github.io/plainly-agent/",
  note: "An independent site that explains rental agreements in plain words, written for readers in India. Not part of No Envy.",
});
const NAMES = { type: "array", minItems: 2, maxItems: 8, items: NAME };

class SiteActions {
  static registerActions(actions) {
    actions.register(SiteActions.readSheet());
    actions.register(SiteActions.setPlace());
    actions.register(SiteActions.setAmounts());
    actions.register(SiteActions.setNoRentBelowZero());
    actions.register(SiteActions.findSplit());
    actions.register(SiteActions.trySplit());
  }

  // The partner site's own page. The page's link (#partner-plainly in index.html) carries
  // the same address, and a test keeps the two equal, so the assistant gives the address
  // the visitor sees and none is written into its instructions.
  static leaseHelp() {
    return { ...LEASE_HELP };
  }

  // Run one change through the page, and leave the visitor a way to take it back.
  static change(text, run) {
    const page = App.page;
    const before = page.snapshot();
    const result = run(page);
    if (result && result.ok) page.offerUndo(before, text, true);
    return result;
  }

  static readSheet() {
    return {
      name: "get_rent_sheet",
      description: "Read the rent sheet on this page: total rent, currency, people and rooms (each with its index), each person's amounts and whether they add up, what still stops a split (problems), the option, the latest split (result) if it is still current, and leaseHelp, the link to the partner site Plainly. Call it before answering about the sheet or changing it, and again in each turn that needs it: the visitor can also edit the page. isExample true means the made-up starting example. unanswered names the people who have not entered amounts yet: their row is only an even placeholder. personalCopy true means this is one housemate's copy, without the others' amounts.",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => ({ ...App.page.getState(), leaseHelp: SiteActions.leaseHelp() }),
    };
  }

  static setPlace() {
    return {
      name: "set_place",
      description: "Call it only when the visitor asks. Set any of: total monthly rent, currency sign, the people's names, the rooms' names. Give only what changes. People and rooms must be the same number (2 to 8): one room each. Changing how many there are starts everyone's amounts again from an even split; changing only the total rescales them. Returns the updated sheet, or ok false with a reason. The visitor can undo it on the page.",
      effect: "write",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          total: { type: "integer", minimum: 1, maximum: 10000000, description: "Total monthly rent as a whole number, from the visitor." },
          currency: { type: "string", maxLength: 4, description: "Currency sign such as $ or NT$, from the visitor." },
          people: { ...NAMES, description: "Every person's name, in order, from the visitor." },
          rooms: { ...NAMES, description: "Every room's name, in order, from the visitor." },
        },
      },
      execute: (args) => SiteActions.change("The assistant changed the rent, names or rooms.", (page) => page.setSetup(args)),
    };
  }

  static setAmounts() {
    return {
      name: "set_amounts",
      description: "Call it only when the visitor asks, with amounts that person gave: never make them up or adjust them yourself. Sets what each room is worth to one person. One whole number per room, in room index order; they must add up to the total rent exactly, or the site refuses and says by how much they are off. Returns the updated sheet. The visitor can undo it on the page.",
      effect: "write",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["person", "amounts"],
        properties: {
          person: { type: "integer", minimum: 0, maximum: 7, description: "The person's index from website_get_rent_sheet." },
          amounts: { type: "array", minItems: 2, maxItems: 8, items: WHOLE, description: "That person's amount for each room, in room index order." },
        },
      },
      execute: (args) => SiteActions.change("The assistant filled in one person's amounts.", (page) => page.setBids(args.person, args.amounts)),
    };
  }

  static setNoRentBelowZero() {
    return {
      name: "set_no_rent_below_zero",
      description: "Call it only when the visitor asks. Turns the page's \"No rent below zero\" option on or off. With it on, no room's rent may be negative; a split where nobody wants to swap may then not exist, and the site says so. Returns the updated sheet. The visitor can undo it on the page.",
      effect: "write",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["on"],
        properties: { on: { type: "boolean", description: "True to forbid rents below zero." } },
      },
      execute: (args) => SiteActions.change("The assistant changed the \"No rent below zero\" option.", (page) => page.setOption({ nonNegativePrices: args.on })),
    };
  }

  static findSplit() {
    return {
      name: "find_split",
      description: "Call it only when the visitor asks for the split of the sheet as it stands. The site works out who gets which room and what each pays, and shows it on the page with its checking table. Refuses, with the reason, until every person's amounts add up to the total. Returns the sheet with result: assignments (pays, valuesRoomAt, gain), rents, check (table[person][room] is that person's amount for the room minus its rent; maxEnvy 0 means nobody would rather swap), evenSplit for comparison, and notes to pass on.",
      effect: "write",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: () => App.page.solve(),
    };
  }

  static trySplit() {
    return {
      name: "try_split",
      description: "Work out a split for amounts given here, without changing the page. Use it for what-if questions, such as one person valuing a room differently: read the sheet first, copy its total and amounts, and change only what the visitor asked. Every row of bids must add up to total. Returns the same result fields as website_find_split, or ok false with a reason.",
      effect: "read",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["total", "bids"],
        properties: {
          total: { type: "integer", minimum: 1, maximum: 10000000, description: "Total rent." },
          bids: {
            type: "array",
            minItems: 2,
            maxItems: 8,
            items: { type: "array", minItems: 2, maxItems: 8, items: WHOLE },
            description: "bids[person][room]: what each room is worth to each person.",
          },
          people: { ...NAMES, description: "Names, to label the result. Optional." },
          rooms: { ...NAMES, description: "Room names, to label the result. Optional." },
          currency: { type: "string", maxLength: 4, description: "Currency sign. Optional." },
          nonNegativePrices: { type: "boolean", description: "True to forbid rents below zero." },
        },
      },
      execute: (args) => App.page.preview(args),
    };
  }
}

// The runtime calls the module's registerActions export.
export const registerActions = SiteActions.registerActions;
