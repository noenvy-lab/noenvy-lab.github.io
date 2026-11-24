// The page: draws the rent sheet and connects the form to it. The buttons and
// boxes call the same operations (App.page.setSetup, setBids, solve, ...) that
// an assistant would call, so there is one set of rules.

import { Sheet, money, LIMITS } from "./model.js";
import { parseFragment, sheetLink, replyLink } from "./share.js";

const STORAGE_KEY = "no-envy.sheet.v1";
const PREVIOUS_KEY = "no-envy.previous.v1";
const ME_KEY = "no-envy.me.v1";
// Holds the id of a sheet that arrived by link and replaced one of the visitor's own, until they change it.
// While it is set, the way back to their own sheet is offered again after a reload.
const OFFER_KEY = "no-envy.offer.v1";

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "chip") node.style.setProperty("--chip", `var(--room-${value % 8})`);
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children) if (child !== null && child !== undefined) node.append(child);
  return node;
}

const byId = (id) => document.getElementById(id);

// Where a copied link and what is said about it are shown: the sharing box of step 4, unless told otherwise.
const SHARE_BOX = { field: "share-output-field", status: "share-status", output: "share-output" };

function signed(amount, currency) {
  return amount > 0 ? `+${money(amount, currency)}` : money(amount, currency);
}

function listInWords(parts) {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

// "Ben and Chloe would rather have the Big room (by $100 and $200)": one phrase per room that is wished for.
function wishes(envy, currency) {
  const byRoom = new Map();
  for (const e of envy) byRoom.set(e.wouldRatherHave, [...(byRoom.get(e.wouldRatherHave) ?? []), e]);
  return [...byRoom].map(([room, list]) =>
    `${listInWords(list.map((e) => e.personName))} would rather have ${room} (by ${listInWords(list.map((e) => money(e.by, currency)))})`);
}

export class App {
  // The one page object. The assistant's actions use it too.
  static page = null;

  static start() {
    App.page = new App();
    App.page.load();
    App.page.bind();
    App.page.render();
    return App.page;
  }

  constructor() {
    this.sheet = Sheet.example();
    this.me = null;
    this.notice = null;
    this.undoStack = [];
    this.bidsKey = "";
  }

  // ---------------------------------------------------------- operations

  getState() {
    return this.sheet.getState();
  }

  setSetup(change) {
    const hadMadeUp = this.sheet.hasMadeUpAmounts();
    const result = this.sheet.setSetup(change);
    if (result.ok) {
      if (this.me !== null && this.me >= this.sheet.size) this.me = null;
      // The example's made-up amounts went with it; say so instead of leaving a silent reset.
      if (hadMadeUp && !this.sheet.hasMadeUpAmounts()) {
        this.notice = {
          text: "This is your sheet now. The example's made-up amounts are gone: every row shows an even placeholder until that housemate enters their own.",
          label: "Bring back the example",
          action: () => this.loadExample(),
        };
      }
      this.afterChange();
      this.showError("setup-error", null);
    }
    return result;
  }

  setBids(person, amounts) {
    const result = this.sheet.setBids(person, amounts);
    if (result.ok) this.afterChange();
    return result;
  }

  balance(person) {
    const result = this.sheet.balance(person);
    if (result.ok) this.afterChange();
    return result;
  }

  setOption(options) {
    const result = this.sheet.setOption(options);
    if (result.ok) this.afterChange();
    return result;
  }

  solve() {
    const result = this.sheet.solve();
    this.showError("solve-error", result.ok ? null : result.reason);
    this.renderResult();
    return result;
  }

  // The calculation for amounts given as arguments. Changes nothing on the page.
  preview(input) {
    return Sheet.preview(input);
  }

  reset() {
    this.sheet = new Sheet();
    this.me = null;
    this.notice = null;
    this.undoStack = [];
    this.afterChange();
    this.showError("setup-error", null);
    return { ok: true, ...this.getState() };
  }

  loadExample() {
    this.sheet = Sheet.example();
    this.me = null;
    this.notice = null;
    this.undoStack = [];
    this.afterChange();
    return { ok: true, ...this.getState() };
  }

  // The sheet as it is now, to come back to after a change made for the visitor.
  snapshot() {
    // A deep copy: toJSON() hands out the live lists, which later changes write into.
    return { sheet: JSON.parse(JSON.stringify(this.sheet.toJSON())), me: this.me };
  }

  // Say what changed and offer one press to take it back.
  // Undo takes back the last change. If the assistant made several in a row, pressing it again takes back
  // the one before, and so on, so nothing it did is out of reach.
  // `byAssistant`: the change came from the assistant, so the same offer is also shown next to the chat
  // (see renderNear): the notice at the top of the page is far out of sight from there.
  offerUndo(before, text, byAssistant = false) {
    this.undoStack.push({ before, text, byAssistant });
    if (this.undoStack.length > 20) this.undoStack.shift();
    this.nearChat = null;
    this.notice = { text, label: "Undo that change", undo: true, byAssistant, action: () => this.undoLast() };
    this.renderNotice();
    if (byAssistant) this.revealNear();
  }

  // The person is at the chat (its input row is on screen, or nearly): bring the line under it into view,
  // by as little as it takes. Anywhere else on the page nothing moves.
  revealNear() {
    // The line sits directly under the chat, so where it is says where the chat's input row is.
    const box = byId("assistant-change");
    const at = box && !box.hidden ? box.getBoundingClientRect?.() : null;
    if (!at) return;
    if (at.top > 0 && at.top < window.innerHeight + 170) box.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }

  undoLast() {
    const last = this.undoStack.pop();
    if (!last) return { ok: false, reason: "There is nothing to go back to.", field: "undo" };
    const result = this.restore(last.before);
    const earlier = this.undoStack[this.undoStack.length - 1];
    if (result.ok && earlier) {
      this.notice = { text: `That is undone. Before it: ${earlier.text}`, label: "Undo that too", undo: true, byAssistant: earlier.byAssistant, action: () => this.undoLast() };
    }
    // From the chat the sheet cannot be seen going back, so say there that it did.
    if (result.ok && last.byAssistant && !earlier?.byAssistant) this.nearChat = "That is undone.";
    if (result.ok) this.renderNotice();
    return result;
  }

  // The visitor changed the sheet by hand: an older Undo would now wipe that out, so it is withdrawn.
  manual() {
    this.undoStack = [];
    this.nearChat = null;
    if (this.notice?.undo) this.notice = null;
    this.renderNotice();
  }

  restore(before) {
    const sheet = Sheet.fromJSON(before?.sheet);
    if (!sheet) return { ok: false, reason: "There is nothing to go back to.", field: "undo" };
    // Versions only go up, so anything read before the undo is known to be stale.
    sheet.version = this.sheet.version + 1;
    this.sheet = sheet;
    this.me = before.me !== null && before.me < sheet.size ? before.me : null;
    this.notice = null;
    this.afterChange();
    return { ok: true, ...this.getState() };
  }

  afterChange() {
    this.settle();
    // The note about the example only makes sense while the sheet still is the example.
    if (this.notice?.example && !this.sheet.isExample) this.notice = null;
    this.showError("solve-error", null);
    this.save();
    this.render();
  }

  // ----------------------------------------------------- loading, saving

  load() {
    const stored = this.readStored(STORAGE_KEY);
    if (stored) this.sheet = stored;
    if (!this.takeLink(Boolean(stored))) {
      const remembered = this.read(ME_KEY);
      const match = /^([a-z0-9]+):([0-7])$/.exec(remembered ?? "");
      if (match && match[1] === this.sheet.id && Number(match[2]) < this.sheet.size) this.me = Number(match[2]);
    }
    if (!this.notice && this.read(OFFER_KEY) === this.sheet.id && this.readStored(PREVIOUS_KEY)) {
      this.notice = { text: "You opened a shared rent sheet earlier. The sheet you had before is still kept.", label: "Go back to my own sheet", action: () => this.restorePrevious() };
    }
    if (!this.notice && this.sheet.isExample) {
      this.notice = { text: "This is an example with made-up housemates. Try other amounts. Its amounts are cleared once you enter your own rent, names or rooms. Or", label: "start with a blank sheet", example: true, action: () => this.reset() };
    }
  }

  // Take in a shared sheet ("#s=") or a housemate's reply ("#in=") from the address. Used when the page
  // opens and again when a link is pasted into a page that is already open. Returns whether there was one.
  takeLink(hasOwnSheet) {
    const hash = window.location.hash;
    if (hash.length <= 1 || !/(^#|&)(s|in)=/.test(hash)) return false;
    const fragment = parseFragment(hash);
    const mine = this.sheet;
    this.undoStack = [];
    if (fragment.sheet) {
      const shared = Sheet.fromJSON(fragment.sheet);
      if (shared && hasOwnSheet && shared.personal && !mine.personal && shared.id === mine.id) {
        // A housemate's link opened in the browser that holds the whole sheet. Their copy leaves the others'
        // amounts out, so taking it in would blank this sheet.
        const who = fragment.me !== null && fragment.me < mine.size ? mine.people[fragment.me] : "one housemate";
        this.notice = { text: `That is the link for ${who}. This browser already holds the whole sheet, so nothing was replaced.` };
      } else if (shared) {
        const same = JSON.stringify(mine.toJSON()) === JSON.stringify(shared.toJSON());
        if (hasOwnSheet && !mine.isExample && !same) {
          // Also when it is the same sheet by id: the copy in the link may be older than what is here.
          this.write(PREVIOUS_KEY, JSON.stringify(mine.toJSON()));
          this.write(OFFER_KEY, shared.id);
          this.notice = { text: "You opened a shared rent sheet. The sheet you had before is kept.", label: "Go back to my own sheet", action: () => this.restorePrevious() };
        } else {
          this.notice = { text: "You opened a shared rent sheet." };
        }
        shared.version = mine.version + 1;
        this.sheet = shared;
        this.me = fragment.me !== null && fragment.me < shared.size ? fragment.me : null;
        if (this.me !== null && !this.notice.action) this.notice = this.welcome();
        this.write(ME_KEY, this.me === null ? "" : `${shared.id}:${this.me}`);
        this.save();
      } else {
        this.notice = { text: "That link could not be read. It may have been cut short when it was copied." };
      }
    } else if (fragment.reply) {
      if (!hasOwnSheet) {
        this.notice = { text: "This is a housemate's reply link. Open it in the browser where the rent sheet was started." };
      } else {
        const taken = mine.acceptReply(fragment.reply);
        this.notice = { text: taken.ok ? `${mine.people[fragment.reply.person]}'s amounts are in.` : taken.reason };
        if (taken.ok) this.save();
      }
    } else {
      this.notice = { text: "That link could not be read. It may have been cut short when it was copied." };
    }
    // The numbers now live in this browser. Dropping them from the address
    // keeps a reload from undoing later changes.
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    return true;
  }

  // What a housemate reads first on their own link: whose copy this is, what to do, and a way straight to it.
  welcome() {
    return {
      text: `${this.sheet.people[this.me]}, this is your copy of the rent sheet. Share out the rent across the rooms in your card, then send your reply link back.`,
      label: "Go to my card",
      action: () => document.querySelector(".person.me")?.scrollIntoView({ behavior: "smooth", block: "center" }),
    };
  }

  // Another tab of this browser saved the sheet (for example a reply link that opened in a new tab).
  // Without this, the next edit here would write this tab's older copy over it.
  takeOtherTab() {
    const stored = this.readStored(STORAGE_KEY);
    if (!stored || JSON.stringify(stored.toJSON()) === JSON.stringify(this.sheet.toJSON())) return;
    // A different sheet altogether (the other tab opened somebody's link): this browser keeps one sheet at a
    // time, so this tab follows, and says where the sheet it was showing went.
    const previous = stored.id !== this.sheet.id ? this.readStored(PREVIOUS_KEY) : null;
    const canGoBack = previous !== null && JSON.stringify(previous.toJSON()) !== JSON.stringify(stored.toJSON());
    stored.version = this.sheet.version + 1;
    this.sheet = stored;
    if (this.me !== null && this.me >= stored.size) this.me = null;
    this.undoStack = [];
    this.notice = canGoBack
      ? { text: "Another tab of this browser opened a different rent sheet, and this browser keeps one sheet at a time. The sheet you had here is kept.", label: "Go back to my own sheet", action: () => this.restorePrevious() }
      : { text: "This sheet was updated in another tab of this browser. You are looking at the newest version." };
    this.showError("solve-error", null);
    this.render();
  }

  // The visitor is working on the sheet that is open now, so the offer to go back to an older one ends.
  settle() {
    if (this.read(OFFER_KEY)) this.write(OFFER_KEY, "");
  }

  restorePrevious() {
    const previous = this.readStored(PREVIOUS_KEY);
    if (!previous) return;
    this.sheet = previous;
    this.me = null;
    this.notice = null;
    this.undoStack = [];
    this.afterChange();
  }

  read(key) {
    try { return window.localStorage.getItem(key); } catch { return null; }
  }

  write(key, value) {
    try { window.localStorage.setItem(key, value); } catch { /* private mode: the page still works */ }
  }

  readStored(key) {
    try { return Sheet.fromJSON(JSON.parse(this.read(key) ?? "null")); } catch { return null; }
  }

  save() {
    this.write(STORAGE_KEY, JSON.stringify(this.sheet.toJSON()));
  }

  // -------------------------------------------------------------- events

  bind() {
    // (Optional chaining: the test stand-in for `window` has no events.)
    window.addEventListener?.("hashchange", () => {
      if (this.takeLink(Boolean(this.readStored(STORAGE_KEY)))) this.render();
    });
    window.addEventListener?.("storage", (event) => {
      if (event.key === STORAGE_KEY) this.takeOtherTab();
    });
    byId("total").addEventListener("change", (event) => {
      this.manual();
      const value = Number(event.target.value);
      this.report("setup-error", this.setSetup({ total: Number.isFinite(value) ? Math.round(value) : 0 }));
    });
    byId("currency").addEventListener("change", (event) => {
      this.manual();
      this.report("setup-error", this.setSetup({ currency: event.target.value }));
    });
    byId("count-plus").addEventListener("click", () => this.resize(1));
    byId("count-minus").addEventListener("click", () => this.resize(-1));
    byId("solve-button").addEventListener("click", () => this.solve());
    byId("hero-solve").addEventListener("click", () => {
      this.solve();
      byId("result-heading").scrollIntoView?.({ behavior: "smooth", block: "start" });
    });
    byId("non-negative").addEventListener("change", (event) => {
      this.manual();
      this.setOption({ nonNegativePrices: event.target.checked });
    });
    byId("share-sheet").addEventListener("click", () => {
      this.offerLink(sheetLink(this.baseUrl(), this.sheet.toJSON()), "Link to the whole sheet");
    });
    byId("notice-action").addEventListener("click", () => {
      if (this.notice?.action) this.notice.action();
    });
    byId("assistant-change-undo")?.addEventListener?.("click", () => {
      if (this.notice?.undo) this.notice.action();
    });
    byId("assistant-change-show")?.addEventListener?.("click", () => {
      const shown = byId("result").childElementCount > 0;
      byId(shown ? "result-heading" : "bids-heading").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  report(errorId, result) {
    this.showError(errorId, result.ok ? null : result.reason);
    if (!result.ok) this.renderSetup();
  }

  resize(step) {
    const freshName = (list, word) => {
      for (let k = list.length + 1; ; k++) {
        const name = `${word} ${k}`;
        if (!list.some((other) => other.toLowerCase() === name.toLowerCase())) return name;
      }
    };
    this.manual();
    const before = this.snapshot();
    const hadAnswers = !this.sheet.isExample && this.sheet.touched.some(Boolean);
    const { people, rooms } = this.sheet;
    const change = step > 0
      ? { people: [...people, freshName(people, "Housemate")], rooms: [...rooms, freshName(rooms, "Room")] }
      : { people: people.slice(0, -1), rooms: rooms.slice(0, -1) };
    const result = this.setSetup(change);
    this.report("setup-error", result);
    if (result.ok && hadAnswers) this.offerUndo(before, "Changing how many housemates there are started everyone's amounts again from an even split.");
  }

  renameFrom(kind) {
    this.manual();
    const inputs = Array.from(byId(kind === "people" ? "people-list" : "rooms-list").getElementsByTagName("input"));
    this.report("setup-error", this.setSetup({ [kind]: inputs.map((input) => input.value) }));
  }

  // One box or slider of the page's own form changed.
  typeAmount(person, room, raw, source) {
    this.manual();
    this.settle();
    if (this.notice?.example) {
      this.notice = null;
      this.renderNotice();
    }
    const total = this.sheet.total;
    let value = Math.round(Number(raw));
    if (!Number.isFinite(value) || value < 0) value = 0;
    if (value > total) value = total;
    this.sheet.setAmount(person, room, value);
    this.save();
    const box = byId(`bid-${person}-${room}`);
    const slider = byId(`range-${person}-${room}`);
    if (source !== "box" || String(value) !== String(raw).trim()) {
      if (source !== "box" || Number(raw) > total || Number(raw) < 0) box.value = String(value);
    }
    if (source !== "slider") slider.value = String(value);
    this.renderSum(person);
    this.showError("solve-error", null);
    this.renderResult();
  }

  baseUrl() {
    return window.location.origin + window.location.pathname;
  }

  copyReply() {
    const state = this.getState();
    const mine = state.people[this.me];
    if (!mine) return;
    // The answer goes right under the button. (It used to go to the sharing box of step 4, which on a
    // phone is off screen: the housemate pressed the button and saw nothing happen.)
    const here = { field: "me-output-field", status: "me-status", output: "me-output" };
    if (!mine.addsUp) {
      this.offerLink(null, `${mine.name}, your amounts need to add up to ${money(state.total, state.currency)} first.`, here);
      return;
    }
    if (!mine.hasEnteredAmounts) {
      this.offerLink(null, `${mine.name}, your card still shows the even placeholder. Move a slider or type an amount first, even if you end up back at the same numbers.`, here);
      return;
    }
    this.offerLink(replyLink(this.baseUrl(), this.sheet.replyFor(this.me)), "Your reply link", here);
  }

  async offerLink(link, label, where = SHARE_BOX) {
    const ids = byId(where.field) ? where : SHARE_BOX;
    const field = byId(ids.field);
    const status = byId(ids.status);
    const output = byId(ids.output);
    field.hidden = false;
    if (link === null) {
      status.textContent = label;
      output.hidden = true;
      return;
    }
    output.hidden = false;
    output.value = link;
    try {
      await navigator.clipboard.writeText(link);
      status.textContent = `${label} copied. Paste it into a message.`;
    } catch {
      status.textContent = `Could not copy it for you. ${label} is selected in the box below: copy it from there and send it.`;
      output.focus();
      output.select();
    }
  }

  // ------------------------------------------------------------- drawing

  showError(id, reason) {
    const node = byId(id);
    node.textContent = reason ?? "";
    node.hidden = !reason;
  }

  // A housemate's own copy holds only that housemate's answer. A split worked out there would rest on
  // placeholders for everyone else, and a link sent from there would carry an incomplete sheet, so the page
  // offers neither on such a copy and says who does work out the split.
  renderGuest() {
    const guest = this.locked(this.getState());
    byId("hero-solve").hidden = guest;
    byId("solve-row").hidden = guest;
    byId("result").hidden = guest;
    byId("guest-split-note").hidden = !guest;
    byId("share-step").hidden = guest;
    // The line that points to step 4 would point at nothing there.
    byId("share-hint").hidden = guest;
  }

  render() {
    this.renderNotice();
    this.renderGuest();
    this.renderSetup();
    this.renderBids();
    this.renderResult();
    this.renderShare();
  }

  // What the assistant just changed, and the way back, next to the chat. It repeats the notice at the top
  // of the page, which a person typing in the chat cannot see.
  renderNear() {
    const box = byId("assistant-change");
    if (!box) return;
    const offer = this.notice?.undo && this.notice.byAssistant ? this.notice : null;
    const text = offer ? offer.text : this.nearChat;
    box.hidden = !text;
    if (!text) return;
    byId("assistant-change-text").textContent = text;
    const undo = byId("assistant-change-undo");
    undo.hidden = !offer;
    undo.textContent = offer ? offer.label : "";
  }

  renderNotice() {
    this.renderNear();
    const box = byId("notice");
    const action = byId("notice-action");
    box.hidden = !this.notice;
    if (!this.notice) return;
    byId("notice-text").textContent = this.notice.text;
    action.hidden = !this.notice.label;
    action.textContent = this.notice.label ?? "";
  }

  renderSetup() {
    const state = this.getState();
    const total = byId("total");
    const wanted = state.total > 0 ? String(state.total) : "";
    if (total.value !== wanted) total.value = wanted;
    if (byId("currency").value !== state.currency) byId("currency").value = state.currency;
    byId("count-value").textContent = String(state.people.length);
    byId("count-minus").disabled = state.people.length <= LIMITS.minPeople;
    byId("count-plus").disabled = state.people.length >= LIMITS.maxPeople;
    byId("non-negative").checked = state.options.nonNegativePrices;
    // A housemate's own copy: the place was set up by whoever sent the link, and a change here would only
    // make their reply refuse to fit. So the set-up is shown, not offered.
    const locked = this.locked(state);
    for (const id of ["total", "currency"]) byId(id).disabled = locked;
    if (locked) {
      byId("count-minus").disabled = true;
      byId("count-plus").disabled = true;
    }
    byId("setup-locked").hidden = !locked;
    byId("hero-solve").textContent = state.isExample ? "See the example's fair split" : "Find the fair split";
    this.syncNames("people-list", "people", state.people.map((p) => p.name), locked);
    this.syncNames("rooms-list", "rooms", state.rooms.map((r) => r.name), locked);
  }

  locked(state) {
    return Boolean(state.personalCopy) && this.me !== null;
  }

  syncNames(containerId, kind, names, locked = false) {
    const container = byId(containerId);
    const inputs = Array.from(container.getElementsByTagName("input"));
    if (inputs.length === names.length) {
      inputs.forEach((input, k) => {
        if (input.value !== names[k]) input.value = names[k];
        input.disabled = locked;
      });
      return;
    }
    const word = kind === "people" ? "Housemate" : "Room";
    container.replaceChildren(...names.map((name, k) => el("div", { class: "name-row" },
      kind === "rooms" ? el("span", { class: "chip", chip: k, "aria-hidden": "true" }) : null,
      el("input", {
        type: "text",
        id: `${kind}-name-${k}`,
        value: name,
        maxlength: LIMITS.nameLength,
        "aria-label": `${word} ${k + 1} name`,
        autocomplete: "off",
        disabled: locked,
        onchange: () => this.renameFrom(kind),
      }),
    )));
  }

  renderBids() {
    const state = this.getState();
    const key = JSON.stringify([state.total, state.currency, state.people.map((p) => p.name), state.rooms.map((r) => r.name), this.me, this.locked(state)]);
    const banner = byId("me-banner");
    banner.hidden = this.me === null;
    if (this.me !== null) {
      byId("me-text").textContent = `${state.people[this.me].name}, fill in your amounts in the outlined card, then press “Copy my reply link” under it and send that link back to whoever sent you this page.${state.personalCopy ? " Your link does not carry the other housemates' amounts." : ""}`;
    }
    if (key !== this.bidsKey) {
      this.bidsKey = key;
      byId("bids").replaceChildren(...state.people.map((person) => this.personCard(person, state)));
    } else {
      for (const person of state.people) {
        if (this.locked(state) && person.index !== this.me) continue;
        person.amounts.forEach((amount, room) => {
          const box = byId(`bid-${person.index}-${room}`);
          if (box.value !== String(amount)) box.value = String(amount);
          byId(`range-${person.index}-${room}`).value = String(amount);
        });
      }
    }
    for (const person of state.people) this.renderSum(person.index);
  }

  personCard(person, state) {
    const i = person.index;
    const step = state.total >= 2000 ? 10 : 1;
    const mine = this.me === i;
    if (this.locked(state) && !mine) {
      // Not this visitor's to fill in, and their amounts were left out of this copy on purpose.
      return el("div", { class: "person other" }, el("p", { text: `${person.name} fills in their own amounts on their own link.` }));
    }
    return el("div", { class: `person${mine ? " me" : ""}`, role: "group", "aria-labelledby": `person-title-${i}` },
      el("h3", { id: `person-title-${i}`, text: mine ? `${person.name} (you)` : person.name }),
      ...state.rooms.map((room) => el("div", { class: "amount" },
        el("label", { for: `bid-${i}-${room.index}` },
          el("span", { class: "chip", chip: room.index, "aria-hidden": "true" }),
          el("span", { text: room.name }),
        ),
        el("input", {
          type: "number",
          id: `bid-${i}-${room.index}`,
          inputmode: "numeric",
          min: 0,
          max: Math.max(state.total, 0),
          step: 1,
          value: person.amounts[room.index],
          oninput: (event) => this.typeAmount(i, room.index, event.target.value, "box"),
        }),
        el("input", {
          type: "range",
          id: `range-${i}-${room.index}`,
          chip: room.index,
          min: 0,
          max: Math.max(state.total, 1),
          step,
          value: person.amounts[room.index],
          "aria-label": `${person.name}: ${room.name}, slider`,
          oninput: (event) => this.typeAmount(i, room.index, event.target.value, "slider"),
        }),
      )),
      el("div", { class: "sum", id: `sum-${i}`, role: "status" }),
      // The one button a housemate needs, right under the amounts it sends.
      mine ? el("button", { type: "button", id: "me-copy", class: "primary reply", text: "Copy my reply link", onclick: () => this.copyReply() }) : null,
      mine ? el("label", { class: "field share-output reply-output", id: "me-output-field", hidden: true },
        el("span", { id: "me-status", role: "status" }),
        el("input", { id: "me-output", type: "text", readonly: true }),
      ) : null,
    );
  }

  renderSum(i) {
    const state = this.getState();
    const person = state.people[i];
    const node = byId(`sum-${i}`);
    if (!node) return;
    if (state.total < 1) {
      node.className = "sum off";
      node.replaceChildren(el("span", { text: "Enter the total rent first." }));
      return;
    }
    if (person.addsUp && !person.hasEnteredAmounts) {
      node.className = "sum pending";
      node.replaceChildren(el("span", { text: "Not entered yet: an even placeholder" }));
      return;
    }
    if (person.addsUp) {
      node.className = "sum ok";
      node.replaceChildren(el("span", { text: `✓ Adds up to ${money(state.total, state.currency)}` }));
      return;
    }
    const gap = person.stillToAssign;
    node.className = "sum off";
    node.replaceChildren(
      el("span", { text: gap > 0 ? `${money(gap, state.currency)} still to share out` : `${money(-gap, state.currency)} over the rent` }),
      // Says what it does: every amount of the row is scaled by the same factor.
      el("button", { type: "button", text: `Scale to ${money(state.total, state.currency)}`, title: "Keeps the proportions between the rooms", onclick: () => { this.manual(); this.balance(i); } }),
    );
  }

  renderResult() {
    const state = this.getState();
    const box = byId("result");
    const result = state.result;
    if (!result) {
      // After a refusal the reason is already in the message above: say how to fix it instead of repeating it.
      const refused = !byId("solve-error").hidden;
      const text = state.readyToSplit
        ? "Press the button to see who gets which room and what each pays."
        : refused
          ? "Press “Scale to …” under that card in step 2, or change the amounts yourself, then try again."
          : `Before splitting: ${state.problems.join(" ")}`;
      box.replaceChildren(el("p", { class: "placeholder", text }));
      return;
    }
    const c = state.currency;
    // People whose row is still the placeholder said nothing: their card must not put words in their mouth.
    const waiting = new Set(result.unanswered ?? []);
    const why = (a) => {
      if (waiting.has(a.personName)) return `Has not entered amounts yet: an even ${money(a.valuesRoomAt, c)} a room stands in.`;
      if (a.pays < 0) return `Said it is worth ${money(a.valuesRoomAt, c)}. The others would rather pay ${money(-a.pays, c)} a month than take this room themselves.`;
      return a.gain >= 0
        ? `Said it is worth ${money(a.valuesRoomAt, c)}, so comes out ${money(a.gain, c)} ahead.`
        : `Said it is worth ${money(a.valuesRoomAt, c)}, so is ${money(-a.gain, c)} behind.`;
    };
    const cards = el("div", { class: "cards" }, ...result.assignments.map((a) => el("div", { class: "card", chip: a.room },
      el("p", { class: "who", text: a.personName }),
      el("p", { class: "room", text: a.roomName }),
      a.pays < 0
        ? el("p", { class: "pays" }, el("small", { text: "gets " }), money(-a.pays, c), " ", el("small", { text: "a month" }))
        : el("p", { class: "pays" }, money(a.pays, c), " ", el("small", { text: "a month" })),
      el("p", { class: "why", text: why(a) }),
    )));

    const roomOf = result.assignments.map((a) => a.room);
    const table = el("table", {},
      el("caption", { text: "Check it yourself. Each number is what that person said the room is worth, minus its rent. The highlighted one is the room they get. If no other number in their row is bigger, they would not rather swap." }),
      el("thead", {}, el("tr", {},
        el("th", { scope: "col", text: "" }),
        ...result.rents.map((r) => el("th", { scope: "col" }, r.roomName, el("small", { text: `rent ${money(r.rent, c)}` }))),
      )),
      el("tbody", {}, ...result.assignments.map((a, person) => el("tr", {},
        el("th", { scope: "row", text: a.personName }),
        ...result.check.table[person].map((value, room) => el("td", {
          class: room === roomOf[person] ? "own" : (value > result.check.table[person][roomOf[person]] ? "envied" : null),
          text: signed(value, c),
        })),
      ))),
    );

    const perfect = result.check.maxEnvy === 0;
    // Worked out from placeholders: correct for the numbers on the sheet, but nobody's answer yet.
    const provisional = waiting.size > 0;
    const verdict = el("p", {
      class: `verdict${provisional ? " provisional" : perfect ? "" : " near"}`,
      text: provisional
        ? `Provisional: ${waiting.size === state.people.length ? "nobody has" : `${listInWords([...waiting])} ${waiting.size === 1 ? "has" : "have"} not`} entered amounts yet.`
        : perfect
          ? "✓ Nobody would rather swap, and the rents add up to the total."
          : `Within ${money(result.check.maxEnvy, c)} of a perfect match (rents are whole numbers).`,
    });

    const even = result.evenSplit;
    const evenly = even.rentEach.every((v) => v === even.rentEach[0])
      ? `${money(even.rentEach[0], c)} each`
      : `about ${money(even.rentEach[0], c)} each`;
    const isEven = result.rents.every((r) => r.rent === even.rentEach[r.room]);
    // What is said about the split above has to match its own verdict: "nobody wants to swap" only when
    // that is exactly so, the size of the gap when whole-number rents leave one, and nothing while the
    // split still rests on placeholders.
    const holds = provisional
      ? ""
      : perfect
        ? " The split above leaves nobody wanting to swap."
        : ` In the split above nobody would gain more than ${money(result.check.maxEnvy, c)} by swapping.`;
    const compare = el("p", { class: "compare", text: even.envy.length > 0
      ? `Compare an even split of ${evenly}: ${listInWords(wishes(even.envy, c))}.${holds}`
      : isEven
        // (It used to give a reason, "nobody values one room more than the others do", that is not what
        // makes an even split fair: three people who each like a different room best also end up here.)
        ? `With these numbers the fair split is the even one, ${evenly}: it already leaves nobody wanting to swap.`
        : `With these numbers, an even split of ${evenly} would also leave nobody wanting to swap. The rents above share the benefit more evenly.` });

    box.replaceChildren(
      cards,
      verdict,
      ...result.notes.map((note) => el("p", { class: "note", text: note })),
      el("div", { class: "table-wrap" }, table),
      compare,
    );
  }

  renderShare() {
    const state = this.getState();
    byId("ask-list").replaceChildren(...state.people.map((person) => el("button", {
      type: "button",
      text: `Copy link for ${person.name}`,
      // Each housemate gets the sheet without the others' amounts, so nobody's answer is shaped by another's.
      onclick: () => this.offerLink(sheetLink(this.baseUrl(), this.sheet.toJSONFor(person.index), person.index), `Link for ${person.name}`),
    })));
  }
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => App.start());
  } else {
    App.start();
  }
}
