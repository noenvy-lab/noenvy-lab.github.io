// The one thing No Envy shares with other agent sites, through its action bridge:
// the fair-split calculation itself.
//
// The build names this file in bridge/agent-manifest.json. When another site's assistant
// asks this site's network, the bridge loads this module in a hidden frame on this site's
// origin. That frame has no page, so nothing here reads the page, the rent sheet a visitor
// typed, the address bar or the browser's storage. The answer depends only on the
// numbers in the call.
//
// It imports the same model code the page uses (js/model.js -> js/solver.js), which
// touches no DOM, so a partner gets exactly the arithmetic the page's own button gives.
import { Sheet } from "../js/model.js";

const WHOLE = { type: "integer", minimum: 0, maximum: 10000000 };
const NAME = { type: "string", minLength: 1, maxLength: 24 };
const NAMES = { type: "array", minItems: 2, maxItems: 8, items: NAME };

class BridgeActions {
  // Every site may call it. It is a pure calculation on the caller's own numbers: it
  // reveals nothing about this site's visitors and changes nothing anywhere.
  static CALLERS = ["*"];

  static registerActions(actions) {
    actions.register(BridgeActions.trySplit());
  }

  // Same name and input as the page's own try_split (site-actions.js), so the network's
  // instructions fit both.
  static trySplit() {
    return {
      name: "try_split",
      description: "Work out a fair split of a shared cost for amounts given here: who gets which room (or item) and what each pays, so that nobody would rather have another's at its price. Changes nothing and stores nothing. bids[person][room] is what each room is worth to each person; every row must add up to total, and there must be as many rooms as people (2 to 8). Returns assignments (pays, valuesRoomAt, gain), rents, check (table[person][room] is that person's amount for the room minus its rent; maxEnvy 0 means nobody would rather swap), evenSplit for comparison and notes to pass on, or ok false with a reason.",
      effect: "read",
      availability: "bridge",
      callerOrigins: BridgeActions.CALLERS,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["total", "bids"],
        properties: {
          total: { type: "integer", minimum: 1, maximum: 10000000, description: "Total rent or cost to share, as a whole number." },
          bids: {
            type: "array",
            minItems: 2,
            maxItems: 8,
            items: { type: "array", minItems: 2, maxItems: 8, items: WHOLE },
            description: "bids[person][room]: what each room is worth to each person.",
          },
          people: { ...NAMES, description: "Labels for the people, to name them in the result. Optional; use first names or roles only." },
          rooms: { ...NAMES, description: "Room names, to label the result. Optional." },
          currency: { type: "string", maxLength: 4, description: "Currency sign. Optional." },
          nonNegativePrices: { type: "boolean", description: "True to forbid rents below zero." },
        },
      },
      execute: (args) => Sheet.preview(args ?? {}),
    };
  }
}

// The bridge calls the module's registerActions export.
export const registerActions = BridgeActions.registerActions;
