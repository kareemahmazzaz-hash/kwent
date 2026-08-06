import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { dbGet, dbSet, dbUpdate, dbListen, setNetBackend } from "./net.js";
import { setLanServerUrl, getLastHello } from "./lan.js";

/* =======================================================================
   KWENT PROTOTYPE — v3 (Hotseat + vs AI focus; Online kept but deferred to v4)
   -----------------------------------------------------------------------
   What's in v3:
   - Real power values, rows/sections, and card types for all 236 unit
     cards + 22 leaders (5 each for Monsters/Nilfgaard/Northern Realms/
     Scoia'tael, 2 for Skellige), pulled from the finished card database.
   - Full ability engine: Muster (leader/sibling + mutual group variants),
     Medic (Heroes excluded), Decoy, Spy, Scorch (row / global / threshold,
     Heroes excluded), Tight Bond (scales by copy count), Morale Boost
     (flat +1 per other Morale card in the section), Commander's Horn
     (incl. Dandelion's built-in horn, which doesn't double itself),
     Weather (affects the row on BOTH sides) + Clear Weather (both sides),
     Hero full immunity, real Berserker -> Transformed Vildkaarl swaps
     (incl. Ermion's on-play Mardroeme in his own row), and Summon Avenger
     (Cow -> Bovine Defense Force, Kambi -> Hemdall).
   - All 22 Leader abilities implemented as a once-per-game activated
     power during your turn (consumes the turn, same as playing a card).
   - Automatic per-faction abilities: Northern Realms draws on a round
     win; Monsters keep one random unit on the board into the next round;
     Nilfgaard wins tied rounds outright (unless both sides are Nilfgaard);
     Skellige raises 2 random non-hero units from discard at the start of
     Round 3; Scoia'tael skips the coin toss and simply choose who opens
     (unless both sides are Scoia'tael, in which case the coin toss runs
     as normal).
   - Coin flip: the winner of the toss automatically opens Round 1 (no
     choice) — just an OK to acknowledge before mulligan.
   - Agile cards (Melee/Ranged flex units) prompt a row choice on play.
   - Card art: wired to load from IMAGE_BASE_URL + the card's image
     filename, with a graceful text-tile fallback if no base URL is set
     yet or an image fails to load (see the constant below).
   - Hand/pool cards sort by power (highest at the top of the deck-builder
     pool, highest on the right in your in-game hand). A flash-highlight +
     toast calls out the most recently played card on either side, and
     opponent Pass is called out with a banner.

   V7 update: Skellige's two leaders are now confirmed and fully implemented
   (see LEADERS array, ids L21/L22):
   - Crach an Craite: shuffles both graveyards back into their owners' decks.
   - King Bran: passive — his own board only loses half Strength (instead
     of dropping to 1) when a Weather card is active on a row.
   ======================================================================= */

// jsDelivr mirrors the public GitHub repo with proper cross-origin headers
// and CDN caching, which is more reliable for hotlinking into a web app
// than raw.githubusercontent.com directly. We still keep the raw GitHub URL
// as an automatic fallback in case a path hasn't propagated to the CDN yet.
const IMAGE_BASE_URL = "https://cdn.jsdelivr.net/gh/kareemahmazzaz-hash/kwent@main/";
const IMAGE_FALLBACK_BASE_URL = "https://raw.githubusercontent.com/kareemahmazzaz-hash/kwent/main/";
// Safari detection for the handful of fixes that can't be done in pure CSS
// (e.g. removing a table row). Matches desktop + mobile Safari, excludes
// Chrome/Edge/Firefox/Android WebViews which also mention "Safari" in UA.
const IS_SAFARI =
  typeof navigator !== "undefined" &&
  /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
// The real Gwent board-shelf texture, in the repo's Neutral folder. It's one
// image covering all 6 rows (3 opponent + 3 mine, stacked, split by a divider
// line dead-center) — see BOARD_HALF background rules below for how each
// half crops its own 3-row half out of it via background-size/position.
const BOARD_TEXTURE_URL = IMAGE_BASE_URL + "Board/board.jpg";
const LEADER_UNUSED_ICON_URL = IMAGE_BASE_URL + "Board/bluecrown.jpg";
const LEADER_UNUSED_ICON_FALLBACK_URL = IMAGE_FALLBACK_BASE_URL + "Board/bluecrown.jpg";
// Top-bar "life gem" assets: backgem.png is the socket, always visible and
// left behind even after a gem breaks; 1.png is the intact gem shown on top
// of it; breaking.gif plays once (13 frames @100ms = 1300ms) over the socket
// the instant a gem breaks, then gives way to the bare socket for good.
const GEM_BACK_URL = IMAGE_BASE_URL + "Board/backgem.png";
const GEM_BACK_FALLBACK_URL = IMAGE_FALLBACK_BASE_URL + "Board/backgem.png";
const GEM_FRONT_URL = IMAGE_BASE_URL + "Board/1.png";
const GEM_FRONT_FALLBACK_URL = IMAGE_FALLBACK_BASE_URL + "Board/1.png";
const GEM_BREAK_URL = IMAGE_BASE_URL + "Board/breaking.gif";
const GEM_BREAK_FALLBACK_URL = IMAGE_FALLBACK_BASE_URL + "Board/breaking.gif";
const GEM_BREAK_ANIM_MS = 1300;
// Board/*.jpg cell textures (leader frames, row/horn shelves, deck/discard
// frames, weather frame, badge plaques) — filenames have spaces, hence %20.
const boardImg = (name) => `url('${IMAGE_BASE_URL}Board/${encodeURIComponent(name)}.jpg')`;

/* ------------------------------ SOUND ----------------------------------- */
// Every clip lives in /sounds at repo root, served the same way as card art.
const SOUND_BASE_URL = IMAGE_BASE_URL + "sounds/";
const SOUND_FALLBACK_BASE_URL = IMAGE_FALLBACK_BASE_URL + "sounds/";
const SOUND_FILES = {
  bond: "bond.m4a",
  clearWeather: "clear_weather.m4a",
  crachAnCraite: "crach_an_craite.m4a",
  decoy: "decoy.m4a",
  fog: "fog.m4a",
  frost: "frost.m4a",
  gameLoss: "game_loss.m4a",
  gettingAHero: "getting_a_hero.m4a",
  horn: "horn.m4a",
  leader: "leader.m4a",
  mardroeme: "mardroeme.m4a",
  morale: "moral.m4a",
  muster: "muster.m4a",
  playingBasic: "playing_basic.m4a",
  playingHero: "playing_hero.m4a",
  rain: "rain.m4a",
  revival: "revival.m4a",
  roundLoss: "round_loss.m4a",
  scorch: "scorch.m4a",
  spy: "spy.m4a",
  startingWithBasic: "starting_with_basic.m4a",
  wonGame: "won_game.m4a",
  wonRound: "won_round.m4a",
};
// Exact clip lengths (ms), measured with ffprobe against the actual files —
// used to gate move pacing (see soundBusyUntil below) so the next card can't
// land until the current sound has actually finished playing.
const SOUND_DURATIONS_MS = {
  bond: 1947, clearWeather: 3378, crachAnCraite: 2285, decoy: 1966, fog: 3000,
  frost: 2798, gameLoss: 3180, gettingAHero: 2754, horn: 2102, leader: 2459,
  mardroeme: 1878, morale: 1262, muster: 4337, playingBasic: 679,
  playingHero: 2638, rain: 1806, revival: 2449, roundLoss: 2756, scorch: 1759,
  spy: 2667, startingWithBasic: 1148, wonGame: 5119, wonRound: 2649,
};
// A tiny pool of reusable <audio> elements per clip so rapid-fire triggers
// (e.g. Muster fetching several siblings) don't get cut off by one another —
// each play() call grabs whichever pooled element is currently free, or
// clones a fresh one if the pool is momentarily exhausted.
const _soundPools = {};
// Kicks off the network fetch for every clip once, well before it's ever
// needed, so the very first play of a given sound isn't held up waiting on
// a cold fetch (that stall was the "delay between the card landing and the
// sound playing" — playback itself was always immediate, it was the browser
// fetching the file for the first time that was slow). Safe to call
// repeatedly; browser HTTP cache + our pool both dedupe the actual work.
function preloadAllSounds() {
  if (typeof Audio === "undefined") return;
  Object.entries(SOUND_FILES).forEach(([key, file]) => {
    let pool = _soundPools[key];
    if (!pool) { pool = []; _soundPools[key] = pool; }
    if (pool.length) return;
    const el = new Audio();
    el.preload = "auto";
    el.src = SOUND_BASE_URL + file;
    el.onerror = () => { el.onerror = null; el.src = SOUND_FALLBACK_BASE_URL + file; };
    try { el.load(); } catch (e) { /* non-fatal */ }
    pool.push(el);
  });
}
// Tracks when the currently-queued sound(s) will actually finish, so moves
// can be paced to not step on each other's audio (see soundGate below).
// Module-level on purpose — pacing is a global "is anything audible right
// now" concept, not something scoped to one component instance.
let soundBusyUntil = 0;
function markSoundBusy(durationMs) {
  soundBusyUntil = Math.max(soundBusyUntil, Date.now() + (durationMs || 1400));
}
function soundGateRemainingMs() {
  return Math.max(0, soundBusyUntil - Date.now());
}
function playSound(key) {
  const file = SOUND_FILES[key];
  if (!file || typeof Audio === "undefined") return;
  // TEMP diagnostic — every sound call logs its key + a stack trace. Once we
  // have a real capture of the muster/starting_with_basic report this can
  // come back out; for now it's the fastest way to get hard evidence
  // instead of another guess. Open devtools console, reproduce it, and send
  // the "[kwent sound]" lines around the moment you hear it.
  if (typeof console !== "undefined") console.trace("[kwent sound] play:", key);
  try {
    let pool = _soundPools[key];
    if (!pool) { pool = []; _soundPools[key] = pool; }
    let el = pool.find((a) => a.paused || a.ended);
    if (!el) {
      el = new Audio(SOUND_BASE_URL + file);
      el.onerror = () => { el.onerror = null; el.src = SOUND_FALLBACK_BASE_URL + file; el.play().catch(() => {}); };
      if (pool.length < 4) pool.push(el);
    } else {
      el.currentTime = 0;
    }
    // el.play() returns a Promise that only resolves once playback has
    // ACTUALLY started — not when play() was called. There are two things
    // that need to be true at once, and they pull in different directions:
    //   1. Move pacing (soundGateRemainingMs, read synchronously by the AI's
    //      move-scheduler and by onPlayCard's click-gate) needs the busy
    //      window set IMMEDIATELY, in the same tick as this call — the
    //      promise resolving is a microtask, which runs strictly after the
    //      current render commit, so anything that reads the gate
    //      synchronously during that same commit (e.g. AIGame's "it's my
    //      turn" effect) would otherwise see a stale, not-yet-updated
    //      window and schedule its next move off the flat 1300ms floor
    //      regardless of how long the actual clip is — this was the "no
    //      delay between moves" bug.
    //   2. If a clip is still genuinely buffering (plausible for the very
    //      first sound of a session, e.g. starting_with_basic right at the
    //      mulligan screen), audible playback can start later than
    //      call-time — so the window also needs correcting once we know
    //      playback truly began, or a later move's sound could still end up
    //      overlapping the tail end of a delayed one.
    // Doing both — mark immediately, then re-mark (via the same Math.max)
    // once the promise resolves — covers both without regressing either.
    const durationMs = SOUND_DURATIONS_MS[key];
    markSoundBusy(durationMs);
    const playPromise = el.play();
    if (playPromise && typeof playPromise.then === "function") {
      playPromise.then(() => markSoundBusy(durationMs)).catch(() => {});
    }
  } catch (e) { /* non-fatal — sound is decoration, never block gameplay on it */ }
}
// Ability -> sound key, for the layered "base play sound, then ability sound"
// rule. Abilities not listed here (e.g. plain units, berserker/summonAvenger
// which have no distinct clip yet) just get the base playingBasic/playingHero.
const ABILITY_SOUND_KEY = {
  tightBond: "bond",
  moraleBoost: "morale",
  horn: "horn",
  mardroeme: "mardroeme",
  decoy: "decoy",
  spy: "spy",
  muster: "muster",
  scorchRow: "scorch",
  scorchGlobal: "scorch",
  scorchRowThreshold: "scorch",
  clearWeather: "clearWeather",
  // "weather" itself is ambiguous (fog/frost/rain depend on abilityMeta.row)
  // and "medic" is being reworked into its own two-step flow (v38) — both
  // are resolved with dedicated logic at the call site instead of this table.
};
function weatherSoundKeyForRow(row) {
  if (row === "close") return "frost";
  if (row === "ranged") return "fog";
  if (row === "siege") return "rain";
  return null;
}
// Bond/Morale/Muster only make noise when their ability actually *does*
// something — a lone Bond unit with no matching sibling in its row, a
// Morale card played into an empty/all-Hero row, or a Muster card with no
// siblings left to fetch are silent no-ops and shouldn't sound like they
// triggered. Every other ability always "does something" the instant it's
// played, so this only needs to special-case these three. `batchIds` is the
// full list of card ids that landed on the board in this same diff pass —
// used only for Muster, to check whether any siblings actually arrived
// alongside it.
function abilityActuallyActivates(card, board, row, batchIds) {
  if (card.ability === "muster") {
    const fetch = musterFetchIds(card.id);
    return !!(batchIds && batchIds.some((id) => id !== card.id && fetch.includes(id)));
  }
  if (!board || !row) return true;
  if (card.ability === "tightBond") {
    const base = bondBaseName(card.name);
    const count = board[row].filter((id) => {
      const c = cardById(id);
      return c && c.ability === "tightBond" && bondBaseName(c.name) === base;
    }).length;
    return count >= 2;
  }
  if (card.ability === "moraleBoost") {
    const affected = board[row].filter((id) => id !== card.id && cardById(id)?.cardType !== "Hero").length;
    return affected >= 1;
  }
  return true;
}
// Abilities that get ONLY their own dedicated sound, with no playing_basic/
// playing_hero base layered under them — unlike every other special card
// (Decoy, Muster, Scorch, Spy, Medic), which do get the base sound first.
const NO_BASE_SOUND_ABILITIES = new Set(["weather", "clearWeather", "horn"]);
// Plays a card's base "someone played a card" sound (skipped for weather/
// horn — see NO_BASE_SOUND_ABILITIES above), then layers its ability-
// specific sound on top if the ability actually has an effect (see
// abilityActuallyActivates above). `board`/`row`/`batchIds` are optional
// context used only for the Bond/Morale/Muster activation checks.
function playCardSounds(card, board, row, batchIds) {
  if (!card) return;
  if (!NO_BASE_SOUND_ABILITIES.has(card.ability)) {
    playSound(card.cardType === "Hero" ? "playingHero" : "playingBasic");
  }
  let abilityKey = ABILITY_SOUND_KEY[card.ability];
  if (card.ability === "weather") abilityKey = weatherSoundKeyForRow(Array.isArray(card.abilityMeta?.row) ? card.abilityMeta.row[0] : card.abilityMeta?.row) || null;
  // Skellige Storm covers both ranged (fog) and siege (rain) — no dedicated
  // clip exists for it, so both layer in together as the closest fit.
  const isStorm = card.ability === "weather" && Array.isArray(card.abilityMeta?.row) && card.abilityMeta.row.length > 1;
  if ((abilityKey || isStorm) && abilityActuallyActivates(card, board, row, batchIds)) {
    if (isStorm) { playSound("fog"); playSound("rain"); }
    else playSound(abilityKey);
  }
}
// Finds which row array (if any) currently holds this card id, for the
// Bond/Morale activation check above.
function rowOfCardInBoard(board, id) {
  return ROWS.find((r) => board[r].includes(id)) || null;
}
// Guards starting_with_basic so it can only ever fire once for the whole
// game, no matter how many times a MulliganPanel instance happens to mount —
// reset by resetStartingBasicGuard() whenever a brand new game is started.
let startingBasicFiredThisGame = false;
function resetStartingBasicGuard() { startingBasicFiredThisGame = false; }
function playStartingBasicOnce() {
  if (startingBasicFiredThisGame) return;
  startingBasicFiredThisGame = true;
  playSound("startingWithBasic");
}

/* ----------------------------- META ------------------------------------ */

const FACTION_META = {
  monsters:        { label: "Monsters",           short: "MON", color: "#7a4b96" },
  nilfgaard:       { label: "Nilfgaardian Empire", short: "NIL", color: "#c9a23a" },
  northern_realms: { label: "Northern Realms",     short: "NR",  color: "#3d6aa0" },
  scoiatael:       { label: "Scoia'tael",          short: "ST",  color: "#4c8a4f" },
  skellige:        { label: "Skellige",            short: "SK",  color: "#5a8894" },
  neutral:         { label: "Neutral",             short: "NEU", color: "#938d78" },
};

const FACTIONS = ["monsters", "nilfgaard", "northern_realms", "scoiatael", "skellige"];
const FACTIONS_WITH_LEADERS = ["monsters", "nilfgaard", "northern_realms", "scoiatael", "skellige"];

// Repo folder names differ slightly from our internal faction keys/labels
// (matches the exact folder names uploaded to the GitHub image repo).
const FACTION_IMAGE_FOLDER = {
  monsters: "Monesters",
  nilfgaard: "Nilfgaardian Empire",
  northern_realms: "Northern Realms",
  scoiatael: "Scoia'tael",
  skellige: "Skellige",
  neutral: "Neutral",
};

const ROWS = ["close", "ranged", "siege"];
const ROW_META = {
  close:  { label: "Close Combat",  short: "CC", color: "#7a3232" },
  ranged: { label: "Ranged Combat", short: "RC", color: "#8a6a2e" },
  siege:  { label: "Siege",         short: "SG", color: "#3f5566" },
};

const DECK_SIZE = 22;
const HAND_SIZE = 10;
const MAX_MULLIGAN = 2;
const CARD_ASPECT = 0.537; // width:height, matches real card art

const CARDS = [
{id:"c001",name:"Arachas Behemoth",faction:"monsters",power:6.0,row:"siege",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Arachas Behemoth.png"},
{id:"c002",name:"Arachas (1)",faction:"monsters",power:4.0,row:"close",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Arachas1.png"},
{id:"c003",name:"Arachas (2)",faction:"monsters",power:4.0,row:"close",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Arachas2.png"},
{id:"c004",name:"Arachas (3)",faction:"monsters",power:4.0,row:"close",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Arachas3.png"},
{id:"c005",name:"Botchling",faction:"monsters",power:4.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Botchling.png"},
{id:"c006",name:"Celaeno Harpy",faction:"monsters",power:2.0,row:"agile",cardType:"Basic",ability:null,abilityMeta:{},img:"Celaeno Harpy.png"},
{id:"c007",name:"Cockatrice",faction:"monsters",power:2.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Cockatrice.png"},
{id:"c008",name:"Crone: Brewess",faction:"monsters",power:6.0,row:"close",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Crone% Brewess.png"},
{id:"c009",name:"Crone: Weavess",faction:"monsters",power:6.0,row:"close",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Crone% Weavess.png"},
{id:"c010",name:"Crone: Whispess",faction:"monsters",power:6.0,row:"close",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Crone% Whispess.png"},
{id:"c011",name:"Draug",faction:"monsters",power:10.0,row:"close",cardType:"Hero",ability:null,abilityMeta:{},img:"Draug.png"},
{id:"c012",name:"Earth Elemental",faction:"monsters",power:6.0,row:"siege",cardType:"Basic",ability:null,abilityMeta:{},img:"Earth Elemental.png"},
{id:"c013",name:"Endrega",faction:"monsters",power:2.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Endrega.png"},
{id:"c014",name:"Fiend",faction:"monsters",power:6.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Fiend.png"},
{id:"c015",name:"Fire Elemental",faction:"monsters",power:6.0,row:"siege",cardType:"Basic",ability:null,abilityMeta:{},img:"Fire Elemental.png"},
{id:"c016",name:"Foglet",faction:"monsters",power:2.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Foglet.png"},
{id:"c017",name:"Forktail",faction:"monsters",power:5.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Forktail.png"},
{id:"c018",name:"Frightener",faction:"monsters",power:5.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Frightener.png"},
{id:"c019",name:"Gargoyle",faction:"monsters",power:2.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Gargoyle.png"},
{id:"c020",name:"Ghoul (1)",faction:"monsters",power:1.0,row:"close",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Ghoul1.png"},
{id:"c021",name:"Ghoul (2)",faction:"monsters",power:1.0,row:"close",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Ghoul2.png"},
{id:"c022",name:"Ghoul (3)",faction:"monsters",power:1.0,row:"close",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Ghoul3.png"},
{id:"c023",name:"Grave Hag",faction:"monsters",power:5.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Grave Hag.png"},
{id:"c024",name:"Griffin",faction:"monsters",power:5.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Griffin.png"},
{id:"c025",name:"Harpy",faction:"monsters",power:2.0,row:"agile",cardType:"Basic",ability:null,abilityMeta:{},img:"Harpy.png"},
{id:"c026",name:"Ice Giant",faction:"monsters",power:5.0,row:"siege",cardType:"Basic",ability:null,abilityMeta:{},img:"Ice Giant.png"},
{id:"c027",name:"Imlerith",faction:"monsters",power:10.0,row:"close",cardType:"Hero",ability:null,abilityMeta:{},img:"Imlerith.png"},
{id:"c028",name:"Kayran",faction:"monsters",power:8.0,row:"agile",cardType:"Hero",ability:"moraleBoost",abilityMeta:{},img:"Kayran.png"},
{id:"c029",name:"Leshen",faction:"monsters",power:10.0,row:"ranged",cardType:"Hero",ability:null,abilityMeta:{},img:"Leshen.png"},
{id:"c030",name:"Nekker (1)",faction:"monsters",power:2.0,row:"close",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Nekker1.png"},
{id:"c031",name:"Nekker (2)",faction:"monsters",power:2.0,row:"close",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Nekker2.png"},
{id:"c032",name:"Nekker (3)",faction:"monsters",power:2.0,row:"close",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Nekker3.png"},
{id:"c033",name:"Plague Maiden",faction:"monsters",power:5.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Plague Maiden.png"},
{id:"c034",name:"Toad",faction:"monsters",power:7.0,row:"ranged",cardType:"Basic",ability:"scorchRow",abilityMeta:{},img:"Toad.png"},
{id:"c035",name:"Vampire: Bruxa",faction:"monsters",power:4.0,row:"close",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Vampire% Bruxa.png"},
{id:"c036",name:"Vampire: Ekimmara",faction:"monsters",power:4.0,row:"close",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Vampire% Ekimmara.png"},
{id:"c037",name:"Vampire: Fleder",faction:"monsters",power:4.0,row:"close",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Vampire% Fleder.png"},
{id:"c038",name:"Vampire: Garkain",faction:"monsters",power:4.0,row:"close",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Vampire% Garkain.png"},
{id:"c039",name:"Vampire: Katakan",faction:"monsters",power:5.0,row:"close",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Vampire% Katakan.png"},
{id:"c040",name:"Werewolf",faction:"monsters",power:5.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Werewolf.png"},
{id:"c041",name:"Wyvern",faction:"monsters",power:2.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Wyvern.png"},
{id:"c042",name:"Biting Frost (1)",faction:"neutral",power:0.0,row:null,cardType:"Special",ability:"weather",abilityMeta:{"row": "close"},img:"Biting Frost1.png"},
{id:"c043",name:"Biting Frost (2)",faction:"neutral",power:0.0,row:null,cardType:"Special",ability:"weather",abilityMeta:{"row": "close"},img:"Biting Frost2.png"},
{id:"c044",name:"Biting Frost (3)",faction:"neutral",power:0.0,row:null,cardType:"Special",ability:"weather",abilityMeta:{"row": "close"},img:"Biting Frost3.png"},
{id:"c045",name:"Cirilla Fiona Elen Riannon",faction:"neutral",power:15.0,row:"close",cardType:"Hero",ability:null,abilityMeta:{},img:"Cirilla Fiona Elen Riannon.png"},
{id:"c046",name:"Clear Weather (1)",faction:"neutral",power:0.0,row:null,cardType:"Special",ability:"clearWeather",abilityMeta:{},img:"Clear Weather1.png"},
{id:"c047",name:"Clear Weather (2)",faction:"neutral",power:0.0,row:null,cardType:"Special",ability:"clearWeather",abilityMeta:{},img:"Clear Weather2.png"},
{id:"c048",name:"Clear Weather (3)",faction:"neutral",power:0.0,row:null,cardType:"Special",ability:"clearWeather",abilityMeta:{},img:"Clear Weather3.png"},
{id:"c049",name:"Commander's Horn (1)",faction:"neutral",power:0.0,row:null,cardType:"Special",ability:"horn",abilityMeta:{},img:"Commander\u2019s Horn1.png"},
{id:"c050",name:"Commander's Horn (2)",faction:"neutral",power:0.0,row:null,cardType:"Special",ability:"horn",abilityMeta:{},img:"Commander\u2019s Horn2.png"},
{id:"c051",name:"Commander's Horn (3)",faction:"neutral",power:0.0,row:null,cardType:"Special",ability:"horn",abilityMeta:{},img:"Commander\u2019s Horn3.png"},
{id:"c052",name:"Cow",faction:"neutral",power:0.0,row:"ranged",cardType:"Basic",ability:"summonAvenger",abilityMeta:{"summons": "Bovine Defense Force", "summonsId": "c235"},img:"Cow.png"},
{id:"c053",name:"Dandelion",faction:"neutral",power:2.0,row:"close",cardType:"Basic",ability:"horn",abilityMeta:{},img:"Dandelion.png"},
{id:"c054",name:"Decoy (1)",faction:"neutral",power:0.0,row:null,cardType:"Special",ability:"decoy",abilityMeta:{},img:"Decoy1.png"},
{id:"c055",name:"Decoy (2)",faction:"neutral",power:0.0,row:null,cardType:"Special",ability:"decoy",abilityMeta:{},img:"Decoy2.png"},
{id:"c056",name:"Decoy (3)",faction:"neutral",power:0.0,row:null,cardType:"Special",ability:"decoy",abilityMeta:{},img:"Decoy3.png"},
{id:"c057",name:"Emiel Regis Rohellec Terzieff",faction:"neutral",power:5.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Emiel Regis Rohellec Terzieff.png"},
{id:"c058",name:"Gaunter O'Dimm: Darkness (1)",faction:"neutral",power:4.0,row:"ranged",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Gaunter O\u2019Dimm% Darkness1.png"},
{id:"c059",name:"Gaunter O'Dimm: Darkness (2)",faction:"neutral",power:4.0,row:"ranged",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Gaunter O\u2019Dimm% Darkness2.png"},
{id:"c060",name:"Gaunter O'Dimm: Darkness (3)",faction:"neutral",power:4.0,row:"ranged",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Gaunter O\u2019Dimm% Darkness3.png"},
{id:"c061",name:"Gaunter O'Dimm",faction:"neutral",power:2.0,row:"siege",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Gaunter O\u2019Dimm.png"},
{id:"c062",name:"Geralt of Rivia",faction:"neutral",power:15.0,row:"close",cardType:"Hero",ability:null,abilityMeta:{},img:"Geralt of Rivia.png"},
{id:"c063",name:"Impenetrable Fog (1)",faction:"neutral",power:0.0,row:null,cardType:"Special",ability:"weather",abilityMeta:{"row": "ranged"},img:"Impenetrable Fog1.png"},
{id:"c064",name:"Impenetrable Fog (2)",faction:"neutral",power:0.0,row:null,cardType:"Special",ability:"weather",abilityMeta:{"row": "ranged"},img:"Impenetrable Fog2.png"},
{id:"c065",name:"Impenetrable Fog (3)",faction:"neutral",power:0.0,row:null,cardType:"Special",ability:"weather",abilityMeta:{"row": "ranged"},img:"Impenetrable Fog3.png"},
{id:"c066",name:"Mysterious Elf",faction:"neutral",power:0.0,row:"close",cardType:"Hero",ability:"spy",abilityMeta:{},img:"Mysterious Elf.png"},
{id:"c067",name:"Olgierd von Everec",faction:"neutral",power:6.0,row:"agile",cardType:"Basic",ability:"moraleBoost",abilityMeta:{},img:"Olgierd von Everec.png"},
{id:"c068",name:"Scorch (1)",faction:"neutral",power:0.0,row:null,cardType:"Special",ability:"scorchGlobal",abilityMeta:{},img:"Scorch1.png"},
{id:"c069",name:"Scorch (2)",faction:"neutral",power:0.0,row:null,cardType:"Special",ability:"scorchGlobal",abilityMeta:{},img:"Scorch2.png"},
{id:"c070",name:"Scorch (3)",faction:"neutral",power:0.0,row:null,cardType:"Special",ability:"scorchGlobal",abilityMeta:{},img:"Scorch3.png"},
{id:"c071",name:"Skellige Storm (1)",faction:"neutral",power:0,row:null,cardType:"Special",ability:"weather",abilityMeta:{"row": ["ranged", "siege"]},img:"Skellige Storm1.png"},
{id:"c072",name:"Skellige Storm (2)",faction:"neutral",power:0,row:null,cardType:"Special",ability:"weather",abilityMeta:{"row": ["ranged", "siege"]},img:"Skellige Storm2.png"},
{id:"c073",name:"Skellige Storm (3)",faction:"neutral",power:0,row:null,cardType:"Special",ability:"weather",abilityMeta:{"row": ["ranged", "siege"]},img:"Skellige Storm3.png"},
{id:"c074",name:"Torrential Rain (1)",faction:"neutral",power:0.0,row:null,cardType:"Special",ability:"weather",abilityMeta:{"row": "siege"},img:"Torrential Rain1.png"},
{id:"c075",name:"Torrential Rain (2)",faction:"neutral",power:0.0,row:null,cardType:"Special",ability:"weather",abilityMeta:{"row": "siege"},img:"Torrential Rain2.png"},
{id:"c076",name:"Torrential Rain (3)",faction:"neutral",power:0.0,row:null,cardType:"Special",ability:"weather",abilityMeta:{"row": "siege"},img:"Torrential Rain3.png"},
{id:"c077",name:"Triss Merigold",faction:"neutral",power:7.0,row:"close",cardType:"Hero",ability:null,abilityMeta:{},img:"Triss Merigold.png"},
{id:"c078",name:"Vesemir",faction:"neutral",power:6.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Vesemir.png"},
{id:"c079",name:"Villentretenmerth",faction:"neutral",power:7.0,row:"close",cardType:"Basic",ability:"scorchRowThreshold",abilityMeta:{"row": "close", "threshold": 10},img:"Villentretenmerth.png"},
{id:"c080",name:"Yennefer of Vengerberg",faction:"neutral",power:7.0,row:"ranged",cardType:"Hero",ability:"medic",abilityMeta:{},img:"Yennefer of Vengerberg.png"},
{id:"c081",name:"Zoltan Chivay",faction:"neutral",power:5.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Zoltan Chivay.png"},
{id:"c082",name:"Albrich",faction:"nilfgaard",power:2.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Albrich.png"},
{id:"c083",name:"Assire var Anahid",faction:"nilfgaard",power:6.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Assire var Anahid.png"},
{id:"c084",name:"Black Infantry Archer (1)",faction:"nilfgaard",power:10.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Black Infantry Archer1.png"},
{id:"c085",name:"Black Infantry Archer (2)",faction:"nilfgaard",power:10.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Black Infantry Archer2.png"},
{id:"c086",name:"Cahir Mawr Dyffryn aep Ceallach",faction:"nilfgaard",power:6.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Cahir Mawr Dyffryn aep Ceallach.png"},
{id:"c087",name:"Cynthia",faction:"nilfgaard",power:4.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Cynthia.png"},
{id:"c088",name:"Etolian Auxiliary Archers (1)",faction:"nilfgaard",power:1.0,row:"ranged",cardType:"Basic",ability:"medic",abilityMeta:{},img:"Etolian Auxiliary Archers1.png"},
{id:"c089",name:"Etolian Auxiliary Archers (2)",faction:"nilfgaard",power:1.0,row:"ranged",cardType:"Basic",ability:"medic",abilityMeta:{},img:"Etolian Auxiliary Archers2.png"},
{id:"c090",name:"Fringilla Vigo",faction:"nilfgaard",power:6.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Fringilla Vigo.png"},
{id:"c091",name:"Heavy Zerrikanian Fire Scorpion",faction:"nilfgaard",power:10.0,row:"siege",cardType:"Basic",ability:null,abilityMeta:{},img:"Heavy Zerrikanian Fire Scorpion.png"},
{id:"c092",name:"Impera Brigade Guard (1)",faction:"nilfgaard",power:3.0,row:"close",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Impera Brigade Guard1.png"},
{id:"c093",name:"Impera Brigade Guard (2)",faction:"nilfgaard",power:3.0,row:"close",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Impera Brigade Guard2.png"},
{id:"c094",name:"Impera Brigade Guard (3)",faction:"nilfgaard",power:3.0,row:"close",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Impera Brigade Guard3.png"},
{id:"c095",name:"Impera Brigade Guard (4)",faction:"nilfgaard",power:3.0,row:"close",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Impera Brigade Guard4.png"},
{id:"c096",name:"Letho of Gulet",faction:"nilfgaard",power:10.0,row:"close",cardType:"Hero",ability:null,abilityMeta:{},img:"Letho of Gulet.png"},
{id:"c097",name:"Menno Coehorn",faction:"nilfgaard",power:10.0,row:"close",cardType:"Hero",ability:"medic",abilityMeta:{},img:"Menno Coehorn.png"},
{id:"c098",name:"Morteisen",faction:"nilfgaard",power:3.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Morteisen.png"},
{id:"c099",name:"Morvran Voorhis",faction:"nilfgaard",power:10.0,row:"siege",cardType:"Hero",ability:null,abilityMeta:{},img:"Morvran Voorhis.png"},
{id:"c100",name:"Nausicaa Cavalry Rider (1)",faction:"nilfgaard",power:2.0,row:"close",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Nausicaa Cavalry Rider1.png"},
{id:"c101",name:"Nausicaa Cavalry Rider (2)",faction:"nilfgaard",power:2.0,row:"close",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Nausicaa Cavalry Rider2.png"},
{id:"c102",name:"Nausicaa Cavalry Rider (3)",faction:"nilfgaard",power:2.0,row:"close",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Nausicaa Cavalry Rider3.png"},
{id:"c103",name:"Puttkammer",faction:"nilfgaard",power:3.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Puttkammer.png"},
{id:"c104",name:"Rainfarn",faction:"nilfgaard",power:4.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Rainfarn.png"},
{id:"c105",name:"Renuald aep Matsen",faction:"nilfgaard",power:5.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Renuald aep Matsen.png"},
{id:"c106",name:"Rotten Mangonel",faction:"nilfgaard",power:3.0,row:"siege",cardType:"Basic",ability:null,abilityMeta:{},img:"Rotten Mangonel.png"},
{id:"c107",name:"Shilard Fitz-Oesterlen",faction:"nilfgaard",power:7.0,row:"close",cardType:"Basic",ability:"spy",abilityMeta:{},img:"Shilard Fitz-Oesterlen.png"},
{id:"c108",name:"Siege Engineer",faction:"nilfgaard",power:6.0,row:"siege",cardType:"Basic",ability:null,abilityMeta:{},img:"Siege Engineer.png"},
{id:"c109",name:"Siege Technician",faction:"nilfgaard",power:0.0,row:"siege",cardType:"Basic",ability:"medic",abilityMeta:{},img:"Siege Technician.png"},
{id:"c110",name:"Stefan Skellen",faction:"nilfgaard",power:9.0,row:"close",cardType:"Basic",ability:"spy",abilityMeta:{},img:"Stefan Skellen.png"},
{id:"c111",name:"Sweers",faction:"nilfgaard",power:2.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Sweers.png"},
{id:"c112",name:"Tibor Eggebracht",faction:"nilfgaard",power:10.0,row:"ranged",cardType:"Hero",ability:null,abilityMeta:{},img:"Tibor Eggebracht.png"},
{id:"c113",name:"Vanhemar",faction:"nilfgaard",power:4.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Vanhemar.png"},
{id:"c114",name:"Vattier de Rideaux",faction:"nilfgaard",power:4.0,row:"close",cardType:"Basic",ability:"spy",abilityMeta:{},img:"Vattier de Rideaux.png"},
{id:"c115",name:"Vreemde",faction:"nilfgaard",power:2.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Vreemde.png"},
{id:"c116",name:"Young Emissary (1)",faction:"nilfgaard",power:5.0,row:"close",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Young Emissary1.png"},
{id:"c117",name:"Young Emissary (2)",faction:"nilfgaard",power:5.0,row:"close",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Young Emissary2.png"},
{id:"c118",name:"Zerrikanian Fire Scorpion",faction:"nilfgaard",power:5.0,row:"siege",cardType:"Basic",ability:null,abilityMeta:{},img:"Zerrikanian Fire Scorpion.png"},
{id:"c119",name:"Ballista (1)",faction:"northern_realms",power:6.0,row:"siege",cardType:"Basic",ability:null,abilityMeta:{},img:"Ballista1.png"},
{id:"c120",name:"Ballista (2)",faction:"northern_realms",power:6.0,row:"siege",cardType:"Basic",ability:null,abilityMeta:{},img:"Ballista2.png"},
{id:"c121",name:"Blue Stripes Commando (1)",faction:"northern_realms",power:4.0,row:"close",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Blue Stripes Commando1.png"},
{id:"c122",name:"Blue Stripes Commando (2)",faction:"northern_realms",power:4.0,row:"close",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Blue Stripes Commando2.png"},
{id:"c123",name:"Blue Stripes Commando (3)",faction:"northern_realms",power:4.0,row:"close",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Blue Stripes Commando3.png"},
{id:"c124",name:"Catapult (1)",faction:"northern_realms",power:8.0,row:"siege",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Catapult1.png"},
{id:"c125",name:"Catapult (2)",faction:"northern_realms",power:8.0,row:"siege",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Catapult2.png"},
{id:"c126",name:"Crinfrid Reavers Dragon Hunter (1)",faction:"northern_realms",power:5.0,row:"ranged",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Crinfrid Reavers Dragon Hunter1.png"},
{id:"c127",name:"Crinfrid Reavers Dragon Hunter (2)",faction:"northern_realms",power:5.0,row:"ranged",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Crinfrid Reavers Dragon Hunter2.png"},
{id:"c128",name:"Crinfrid Reavers Dragon Hunter (3)",faction:"northern_realms",power:5.0,row:"ranged",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Crinfrid Reavers Dragon Hunter3.png"},
{id:"c129",name:"Dethmold",faction:"northern_realms",power:6.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Dethmold.png"},
{id:"c130",name:"Dun Banner Medic",faction:"northern_realms",power:5.0,row:"siege",cardType:"Basic",ability:"medic",abilityMeta:{},img:"Dun Banner Medic.png"},
{id:"c131",name:"Esterad Thyssen",faction:"northern_realms",power:10.0,row:"close",cardType:"Hero",ability:null,abilityMeta:{},img:"Esterad Thyssen.png"},
{id:"c132",name:"John Natalis",faction:"northern_realms",power:10.0,row:"close",cardType:"Hero",ability:null,abilityMeta:{},img:"John Natalis.png"},
{id:"c133",name:"Kaedweni Siege Expert (1)",faction:"northern_realms",power:1.0,row:"siege",cardType:"Basic",ability:"moraleBoost",abilityMeta:{},img:"Kaedweni Siege Expert1.png"},
{id:"c134",name:"Kaedweni Siege Expert (2)",faction:"northern_realms",power:1.0,row:"siege",cardType:"Basic",ability:"moraleBoost",abilityMeta:{},img:"Kaedweni Siege Expert2.png"},
{id:"c135",name:"Kaedweni Siege Expert (3)",faction:"northern_realms",power:1.0,row:"siege",cardType:"Basic",ability:"moraleBoost",abilityMeta:{},img:"Kaedweni Siege Expert3.png"},
{id:"c136",name:"Keira Metz",faction:"northern_realms",power:5.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Keira Metz.png"},
{id:"c137",name:"Philippa Eilhart",faction:"northern_realms",power:10.0,row:"ranged",cardType:"Hero",ability:null,abilityMeta:{},img:"Philippa Eilhart.png"},
{id:"c138",name:"Poor Fucking Infantry (1)",faction:"northern_realms",power:1.0,row:"close",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Poor Fucking Infantry1.png"},
{id:"c139",name:"Poor Fucking Infantry (2)",faction:"northern_realms",power:1.0,row:"close",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Poor Fucking Infantry2.png"},
{id:"c140",name:"Poor Fucking Infantry (3)",faction:"northern_realms",power:1.0,row:"close",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Poor Fucking Infantry3.png"},
{id:"c141",name:"Poor Fucking Infantry (4)",faction:"northern_realms",power:1.0,row:"close",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Poor Fucking Infantry4.png"},
{id:"c142",name:"Prince Stennis",faction:"northern_realms",power:5.0,row:"close",cardType:"Basic",ability:"spy",abilityMeta:{},img:"Prince Stennis.png"},
{id:"c143",name:"Redanian Foot Soldier (1)",faction:"northern_realms",power:1.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Redanian Foot Soldier1.png"},
{id:"c144",name:"Redanian Foot Soldier (2)",faction:"northern_realms",power:1.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Redanian Foot Soldier2.png"},
{id:"c145",name:"Sabrina Glevissig",faction:"northern_realms",power:4.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Sabrina Glevissig.png"},
{id:"c146",name:"Sheldon Skaggs",faction:"northern_realms",power:4.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Sheldon Skaggs.png"},
{id:"c147",name:"Siege Tower",faction:"northern_realms",power:6.0,row:"siege",cardType:"Basic",ability:null,abilityMeta:{},img:"Siege Tower.png"},
{id:"c148",name:"Siegfried of Denesle",faction:"northern_realms",power:5.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Siegfried of Denesle.png"},
{id:"c149",name:"Sigismund Dijkstra",faction:"northern_realms",power:4.0,row:"close",cardType:"Basic",ability:"spy",abilityMeta:{},img:"Sigismund Dijkstra.png"},
{id:"c150",name:"S\u00edle de Tansarville",faction:"northern_realms",power:5.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"S\u00edle de Tansarville.png"},
{id:"c151",name:"Thaler",faction:"northern_realms",power:1.0,row:"siege",cardType:"Basic",ability:"spy",abilityMeta:{},img:"Thaler.png"},
{id:"c152",name:"Trebuchet (1)",faction:"northern_realms",power:6.0,row:"siege",cardType:"Basic",ability:null,abilityMeta:{},img:"Trebuchet1.png"},
{id:"c153",name:"Trebuchet (2)",faction:"northern_realms",power:6.0,row:"siege",cardType:"Basic",ability:null,abilityMeta:{},img:"Trebuchet2.png"},
{id:"c154",name:"Vernon Roche",faction:"northern_realms",power:10.0,row:"close",cardType:"Hero",ability:null,abilityMeta:{},img:"Vernon Roche.png"},
{id:"c155",name:"Ves",faction:"northern_realms",power:5.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Ves.png"},
{id:"c156",name:"Yarpen Zigrin",faction:"northern_realms",power:2.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Yarpen Zigrin.png"},
{id:"c157",name:"Barclay Els",faction:"scoiatael",power:6.0,row:"agile",cardType:"Basic",ability:null,abilityMeta:{},img:"Barclay Els.png"},
{id:"c158",name:"Ciaran aep Easnillien",faction:"scoiatael",power:3.0,row:"agile",cardType:"Basic",ability:null,abilityMeta:{},img:"Ciaran aep Easnillien.png"},
{id:"c159",name:"Dennis Cranmer",faction:"scoiatael",power:6.0,row:"agile",cardType:"Basic",ability:null,abilityMeta:{},img:"Dennis Cranmer.png"},
{id:"c160",name:"Dol Blathanna Archer",faction:"scoiatael",power:4.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Dol Blathanna Archer.png"},
{id:"c161",name:"Dol Blathanna Scout (1)",faction:"scoiatael",power:6.0,row:"agile",cardType:"Basic",ability:null,abilityMeta:{},img:"Dol Blathanna Scout1.png"},
{id:"c162",name:"Dol Blathanna Scout (2)",faction:"scoiatael",power:6.0,row:"agile",cardType:"Basic",ability:null,abilityMeta:{},img:"Dol Blathanna Scout2.png"},
{id:"c163",name:"Dol Blathanna Scout (3)",faction:"scoiatael",power:6.0,row:"agile",cardType:"Basic",ability:null,abilityMeta:{},img:"Dol Blathanna Scout3.png"},
{id:"c164",name:"Dwarven Skirmisher (1)",faction:"scoiatael",power:3.0,row:"close",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Dwarven Skirmisher1.png"},
{id:"c165",name:"Dwarven Skirmisher (2)",faction:"scoiatael",power:3.0,row:"close",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Dwarven Skirmisher2.png"},
{id:"c166",name:"Dwarven Skirmisher (3)",faction:"scoiatael",power:3.0,row:"close",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Dwarven Skirmisher3.png"},
{id:"c167",name:"Eithn\u00e9",faction:"scoiatael",power:10.0,row:"ranged",cardType:"Hero",ability:null,abilityMeta:{},img:"Eithn\u00e9.png"},
{id:"c168",name:"Elven Skirmisher (1)",faction:"scoiatael",power:2.0,row:"ranged",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Elven Skirmisher1.png"},
{id:"c169",name:"Elven Skirmisher (2)",faction:"scoiatael",power:2.0,row:"ranged",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Elven Skirmisher2.png"},
{id:"c170",name:"Elven Skirmisher (3)",faction:"scoiatael",power:2.0,row:"ranged",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Elven Skirmisher3.png"},
{id:"c171",name:"Filavandrel aen Fidhail",faction:"scoiatael",power:6.0,row:"agile",cardType:"Basic",ability:null,abilityMeta:{},img:"Filavandrel aen Fidhail.png"},
{id:"c172",name:"Havekar Healer (1)",faction:"scoiatael",power:0.0,row:"ranged",cardType:"Basic",ability:"medic",abilityMeta:{},img:"Havekar Healer1.png"},
{id:"c173",name:"Havekar Healer (2)",faction:"scoiatael",power:0.0,row:"ranged",cardType:"Basic",ability:"medic",abilityMeta:{},img:"Havekar Healer2.png"},
{id:"c174",name:"Havekar Healer (3)",faction:"scoiatael",power:0.0,row:"ranged",cardType:"Basic",ability:"medic",abilityMeta:{},img:"Havekar Healer3.png"},
{id:"c175",name:"Havekar Smuggler (1)",faction:"scoiatael",power:5.0,row:"close",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Havekar Smuggler1.png"},
{id:"c176",name:"Havekar Smuggler (2)",faction:"scoiatael",power:5.0,row:"close",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Havekar Smuggler2.png"},
{id:"c177",name:"Havekar Smuggler (3)",faction:"scoiatael",power:5.0,row:"close",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Havekar Smuggler3.png"},
{id:"c178",name:"Ida Emean aep Sivney",faction:"scoiatael",power:6.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Ida Emean aep Sivney.png"},
{id:"c179",name:"Iorveth",faction:"scoiatael",power:10.0,row:"ranged",cardType:"Hero",ability:null,abilityMeta:{},img:"Iorveth.png"},
{id:"c180",name:"Isengrim Faoiltiarna",faction:"scoiatael",power:6.0,row:"close",cardType:"Hero",ability:"moraleBoost",abilityMeta:{},img:"Isengrim Faoiltiarna.png"},
{id:"c181",name:"Mahakaman Defender (1)",faction:"scoiatael",power:5.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Mahakaman Defender1.png"},
{id:"c182",name:"Mahakaman Defender (2)",faction:"scoiatael",power:5.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Mahakaman Defender2.png"},
{id:"c183",name:"Mahakaman Defender (3)",faction:"scoiatael",power:5.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Mahakaman Defender3.png"},
{id:"c184",name:"Mahakaman Defender (4)",faction:"scoiatael",power:5.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Mahakaman Defender4.png"},
{id:"c185",name:"Mahakaman Defender (5)",faction:"scoiatael",power:5.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Mahakaman Defender5.png"},
{id:"c186",name:"Milva",faction:"scoiatael",power:10.0,row:"ranged",cardType:"Basic",ability:"moraleBoost",abilityMeta:{},img:"Milva.png"},
{id:"c187",name:"Riordain",faction:"scoiatael",power:1.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Riordain.png"},
{id:"c188",name:"Saesenthessis",faction:"scoiatael",power:10.0,row:"ranged",cardType:"Hero",ability:null,abilityMeta:{},img:"Saesenthessis.png"},
{id:"c189",name:"Schirru",faction:"scoiatael",power:8.0,row:"siege",cardType:"Basic",ability:"scorchRow",abilityMeta:{},img:"Schirru.png"},
{id:"c190",name:"Toruviel",faction:"scoiatael",power:2.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Toruviel.png"},
{id:"c191",name:"Vrihedd Brigade Recruit (1)",faction:"scoiatael",power:4.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Vrihedd Brigade Recruit1.png"},
{id:"c192",name:"Vrihedd Brigade Recruit (2)",faction:"scoiatael",power:4.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Vrihedd Brigade Recruit2.png"},
{id:"c193",name:"Vrihedd Brigade Recruit (3)",faction:"scoiatael",power:4.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Vrihedd Brigade Recruit3.png"},
{id:"c194",name:"Yaevinn",faction:"scoiatael",power:6.0,row:"agile",cardType:"Basic",ability:null,abilityMeta:{},img:"Yaevinn.png"},
{id:"c195",name:"Berserker",faction:"skellige",power:4.0,row:"close",cardType:"Basic",ability:"berserker",abilityMeta:{},img:"Berserker.png"},
{id:"c196",name:"Birna Bran",faction:"skellige",power:2.0,row:"close",cardType:"Basic",ability:"medic",abilityMeta:{},img:"Birna Bran.png"},
{id:"c197",name:"Blueboy Lugos",faction:"skellige",power:6.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Blueboy Lugos.png"},
{id:"c198",name:"Cerys",faction:"skellige",power:10.0,row:"close",cardType:"Hero",ability:"muster",abilityMeta:{},img:"Cerys.png"},
{id:"c199",name:"Clan An Craite Warrior (1)",faction:"skellige",power:6.0,row:"close",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Clan An Craite Warrior1.png"},
{id:"c200",name:"Clan An Craite Warrior (2)",faction:"skellige",power:6.0,row:"close",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Clan An Craite Warrior2.png"},
{id:"c201",name:"Clan An Craite Warrior (3)",faction:"skellige",power:6.0,row:"close",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Clan An Craite Warrior3.png"},
{id:"c202",name:"Clan Brokvar Archer (1)",faction:"skellige",power:6.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Clan Brokvar Archer1.png"},
{id:"c203",name:"Clan Brokvar Archer (2)",faction:"skellige",power:6.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Clan Brokvar Archer2.png"},
{id:"c204",name:"Clan Brokvar Archer (3)",faction:"skellige",power:6.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Clan Brokvar Archer3.png"},
{id:"c205",name:"Clan Dimun Pirate",faction:"skellige",power:6.0,row:"close",cardType:"Basic",ability:"scorchGlobal",abilityMeta:{},img:"Clan Dimun Pirate.png"},
{id:"c206",name:"Clan Drummond Shield Maiden (1)",faction:"skellige",power:4.0,row:"close",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Clan Drummond Shield Maiden1.png"},
{id:"c207",name:"Clan Drummond Shield Maiden (2)",faction:"skellige",power:4.0,row:"close",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Clan Drummond Shield Maiden2.png"},
{id:"c208",name:"Clan Drummond Shield Maiden (3)",faction:"skellige",power:4.0,row:"close",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Clan Drummond Shield Maiden3.png"},
{id:"c209",name:"Clan Heymaey Skald",faction:"skellige",power:4.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Clan Heymaey Skald.png"},
{id:"c210",name:"Clan Tordarroch Armorsmith",faction:"skellige",power:4.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Clan Tordarroch Armorsmith.png"},
{id:"c212",name:"Donar an Hindar",faction:"skellige",power:4.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Donar an Hindar.png"},
{id:"c213",name:"Draig Bon-Dhu",faction:"skellige",power:2.0,row:"siege",cardType:"Basic",ability:"horn",abilityMeta:{},img:"Draig Bon-Dhu.png"},
{id:"c214",name:"Ermion",faction:"skellige",power:8.0,row:"close",cardType:"Hero",ability:"mardroeme",abilityMeta:{},img:"Ermion.png"},
{id:"c215",name:"Hjalmar",faction:"skellige",power:10.0,row:"ranged",cardType:"Hero",ability:null,abilityMeta:{},img:"Hjalmar.png"},
{id:"c216",name:"Holger Blackhand",faction:"skellige",power:4.0,row:"ranged",cardType:"Basic",ability:null,abilityMeta:{},img:"Holger Blackhand.png"},
{id:"c217",name:"Kambi",faction:"skellige",power:0.0,row:"close",cardType:"Basic",ability:"summonAvenger",abilityMeta:{"summons": "Hemdall", "summonsId": "c236"},img:"Kambi.png"},
{id:"c219",name:"Light Longship (1)",faction:"skellige",power:4.0,row:"ranged",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Light Longship1.png"},
{id:"c220",name:"Light Longship (2)",faction:"skellige",power:4.0,row:"ranged",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Light Longship2.png"},
{id:"c221",name:"Light Longship (3)",faction:"skellige",power:4.0,row:"ranged",cardType:"Basic",ability:"muster",abilityMeta:{},img:"Light Longship3.png"},
{id:"c222",name:"Madman Lugos",faction:"skellige",power:6.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Madman Lugos.png"},
{id:"c223",name:"Mardroeme (1)",faction:"skellige",power:0,row:null,cardType:"Special",ability:"mardroeme",abilityMeta:{},img:"Mardroeme1.png"},
{id:"c224",name:"Mardroeme (2)",faction:"skellige",power:0,row:null,cardType:"Special",ability:"mardroeme",abilityMeta:{},img:"Mardroeme2.png"},
{id:"c225",name:"Mardroeme (3)",faction:"skellige",power:0,row:null,cardType:"Special",ability:"mardroeme",abilityMeta:{},img:"Mardroeme3.png"},
{id:"c226",name:"Olaf",faction:"skellige",power:12.0,row:"agile",cardType:"Basic",ability:"moraleBoost",abilityMeta:{},img:"Olaf.png"},
{id:"c227",name:"Svanrige",faction:"skellige",power:4.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Svanrige.png"},
{id:"c228",name:"Udalryk",faction:"skellige",power:4.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Udalryk.png"},
{id:"c229",name:"War Longship (1)",faction:"skellige",power:6.0,row:"siege",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"War Longship1.png"},
{id:"c230",name:"War Longship (2)",faction:"skellige",power:6.0,row:"siege",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"War Longship2.png"},
{id:"c231",name:"War Longship (3)",faction:"skellige",power:6.0,row:"siege",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"War Longship3.png"},
{id:"c232",name:"Young Berserker (1)",faction:"skellige",power:2.0,row:"ranged",cardType:"Basic",ability:"berserker",abilityMeta:{},img:"Young Berserker1.png"},
{id:"c233",name:"Young Berserker (2)",faction:"skellige",power:2.0,row:"ranged",cardType:"Basic",ability:"berserker",abilityMeta:{},img:"Young Berserker2.png"},
{id:"c234",name:"Young Berserker (3)",faction:"skellige",power:2.0,row:"ranged",cardType:"Basic",ability:"berserker",abilityMeta:{},img:"Young Berserker3.png"},
{id:"c237",name:"Transformed Young Vildkaarl",faction:"skellige",power:8.0,row:"ranged",cardType:"Basic",ability:"tightBond",abilityMeta:{undraftable:true},img:"Transformed Young Vildkaarl.png"},
{id:"c238",name:"Transformed Vildkaarl",faction:"skellige",power:14.0,row:"close",cardType:"Basic",ability:"moraleBoost",abilityMeta:{undraftable:true},img:"Transformed Vildkaarl.png"},
{id:"c235",name:"Bovine Defense Force",faction:"neutral",power:8.0,row:"close",cardType:"Basic",ability:"unsummonable",abilityMeta:{},img:"Bovine Defense Force.png"},
{id:"c236",name:"Hemdall",faction:"skellige",power:11.0,row:"close",cardType:"Hero",ability:"unsummonable",abilityMeta:{},img:"Hemdall.png"}
];
const LEADERS = [
{id:"L01",name:"Eredin Br\u00e9acc Glas: The Treacherous",faction:"monsters",cardType:"Leader",ability:"Doubles the strength of all Spy cards (affects both players).",img:"Eredin Br\u00e9acc Glas% The Treacherous.png"},
{id:"L02",name:"Eredin: Bringer of Death",faction:"monsters",cardType:"Leader",ability:"Medic",img:"Eredin% Bringer of Death.png"},
{id:"L03",name:"Eredin: Commander of the Red Riders",faction:"monsters",cardType:"Leader",ability:"Horn Close Combat",img:"Eredin% Commander of the Red Riders.png"},
{id:"L04",name:"Eredin: Destroyer of Worlds",faction:"monsters",cardType:"Leader",ability:"Discard 2 draw 1",img:"Eredin% Destroyer of Worlds.png"},
{id:"L05",name:"Eredin: King of the Wild Hunt",faction:"monsters",cardType:"Leader",ability:"Pick any weather",img:"Eredin% King of the Wild Hunt.png"},
{id:"L06",name:"Emhyr var Emreis: Emperor of Nilfgaard",faction:"nilfgaard",cardType:"Leader",ability:"Look at 3 Opp Cards",img:"Emhyr var Emreis% Emperor of Nilfgaard.png"},
{id:"L07",name:"Emhyr var Emreis: His Imperial Majesty",faction:"nilfgaard",cardType:"Leader",ability:"Pick a Torrential Rain card directly from your deck and play it instantly.",img:"Emhyr var Emreis% His Imperial Majesty.png"},
{id:"L08",name:"Emhyr var Emreis: Invader of the North",faction:"nilfgaard",cardType:"Leader",ability:"Every revive ability, on both sides, brings back a random unit instead of a chosen one.",img:"Emhyr var Emreis% Invader of the North.png"},
{id:"L09",name:"Emhyr var Emreis: The Relentless",faction:"nilfgaard",cardType:"Leader",ability:"Take a non-Hero card from opponent's discard and play it instantly.",img:"Emhyr var Emreis% The Relentless.png"},
{id:"L10",name:"Emhyr var Emreis: The White Flame",faction:"nilfgaard",cardType:"Leader",ability:"Instantly cancels your opponent's Leader Ability.",img:"Emhyr var Emreis% The White Flame.png"},
{id:"L11",name:"Foltest: King of Temeria",faction:"northern_realms",cardType:"Leader",ability:"Fog",img:"Foltest% King of Temeria.png"},
{id:"L12",name:"Foltest: Lord Commander of the North",faction:"northern_realms",cardType:"Leader",ability:"Clear Weather",img:"Foltest% Lord Commander of the North.png"},
{id:"L13",name:"Foltest: Son of Medell",faction:"northern_realms",cardType:"Leader",ability:"Destroys enemy's strongest Ranged unit(s) if the combined strength of all their Ranged units is 10 or more.",img:"Foltest% Son of Medell.png"},
{id:"L14",name:"Foltest: The Siegemaster",faction:"northern_realms",cardType:"Leader",ability:"Horn on Siege",img:"Foltest% The Siegemaster.png"},
{id:"L15",name:"Foltest: The Steel-Forged",faction:"northern_realms",cardType:"Leader",ability:"Scorch Siege if +10",img:"Foltest% The Steel-Forged.png"},
{id:"L16",name:"Francesca Findabair: Daisy of the Valley",faction:"scoiatael",cardType:"Leader",ability:"Draw extra card",img:"Francesca Findabair% Daisy of the Valley.png"},
{id:"L17",name:"Francesca Findabair: Hope of the Aen Seidhe",faction:"scoiatael",cardType:"Leader",ability:"Automatically moves your Agile units to whichever valid row maximizes their current strength, avoiding units already in their optimal position.",img:"Francesca Findabair% Hope of the Aen Seidhe.png"},
{id:"L18",name:"Francesca Findabair: Pureblood Elf",faction:"scoiatael",cardType:"Leader",ability:"Frost",img:"Francesca Findabair% Pureblood Elf.png"},
{id:"L19",name:"Francesca Findabair: Queen of Dol Blathanna",faction:"scoiatael",cardType:"Leader",ability:"Destroys enemy's strongest Close Combat unit(s) if the combined strength of all their Close Combat units is 10 or more.",img:"Francesca Findabair% Queen of Dol Blathanna.png"},
{id:"L20",name:"Francesca Findabair: The Beautiful",faction:"scoiatael",cardType:"Leader",ability:"Horn on Ranged",img:"Francesca Findabair% The Beautiful.png"},
// CONFIRMED by Kareem (V7): Skellige's two Leaders (Crach an Craite, King Bran).
{id:"L21",name:"Crach an Craite",faction:"skellige",cardType:"Leader",ability:"Shuffles both graveyards back into their owners' decks.",img:"Crach an Craite.png"},
{id:"L22",name:"King Bran",faction:"skellige",cardType:"Leader",ability:"Your units only lose half their Strength to weather, instead of dropping to 1.",img:"King Bran.png"}
];
/* ------------------------- CARD INDEX / POOLS --------------------------- */

const CARD_INDEX = {};
CARDS.forEach((c) => { CARD_INDEX[c.id] = c; });
LEADERS.forEach((l) => { CARD_INDEX[l.id] = l; });

function cardById(id) { return CARD_INDEX[id] || null; }

// Shared display sort: power first, alphabetical by name as the tiebreak.
// desc=false -> lowest power first (used for hand); desc=true -> highest power first (used for discard/deck lists).
function sortIdsByPower(ids, { desc = false } = {}) {
  return [...ids].sort((a, b) => {
    const ca = cardById(a), cb = cardById(b);
    const pa = ca?.power ?? 0, pb = cb?.power ?? 0;
    if (pa !== pb) return desc ? pb - pa : pa - pb;
    return (ca?.name || "").localeCompare(cb?.name || "");
  });
}

// Cards that only ever enter play via another card's ability (Bovine Defense
// Force, Hemdall) or only ever appear via a transformation (Transformed
// Vildkaarl variants) are excluded from deck pools — they can't be drafted.
function poolForFaction(factionKey) {
  return CARDS.filter(
    (c) =>
      (c.faction === factionKey || c.faction === "neutral") &&
      c.ability !== "unsummonable" &&
      !(c.abilityMeta && c.abilityMeta.undraftable)
  );
}

function leadersForFaction(factionKey) {
  return LEADERS.filter((l) => l.faction === factionKey);
}

function imgSrc(card, base = IMAGE_BASE_URL) {
  if (!card || !card.img || !base) return null;
  const folder = FACTION_IMAGE_FOLDER[card.faction] || "";
  const path = folder ? folder + "/" + card.img : card.img;
  // Encode each path segment separately so real slashes in the folder name survive.
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return base + encoded;
}

// Every faction folder in the repo carries its own back.png. Neutral cards
// are dealt from whichever faction the opponent is actually playing, so a
// Neutral card in an opponent's hand should show THAT faction's back, not
// a "neutral" one — callers pass the opponent's real faction key here.
function backImgSrc(factionKey, base = IMAGE_BASE_URL) {
  const folder = FACTION_IMAGE_FOLDER[factionKey] || FACTION_IMAGE_FOLDER.neutral;
  const path = folder + "/back.png";
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return base + encoded;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ============================ SAVED DECKS =============================
   Persisted locally in the browser (per-device, not synced online) so
   players can build a deck once and reuse it across sessions. */
const SAVED_DECKS_KEY = "kwentSavedDecks";

function loadSavedDecks() {
  try {
    const raw = localStorage.getItem(SAVED_DECKS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function persistSavedDecks(decks) {
  try {
    localStorage.setItem(SAVED_DECKS_KEY, JSON.stringify(decks));
  } catch (e) {
    // Storage unavailable (private browsing, quota, etc.) — fail silently.
  }
}

function makeRoomCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  let s = "";
  for (let i = 0; i < 4; i++) s += letters[Math.floor(Math.random() * letters.length)];
  return s;
}

function flipCoin() {
  return Math.random() < 0.5 ? "heads" : "tails";
}

/* ------------------------- CORE GAME LOGIC ------------------------------
   State shape (shared by all three modes):
   state = {
     phase, round, turn, roundWins, lastRoundScore, gameWinner, log,
     coinFlip: { caller, call, result, callerWon, starter, resolved },
     players: { p1: PlayerState, p2: PlayerState }
   }
   PlayerState.board = {
     close: [ids], ranged: [ids], siege: [ids],           // real scoring units
     weather: { close, ranged, siege } -> cardId|null,    // opponent-cast weather affecting THIS board
     horns:   { close, ranged, siege } -> integer count,  // active horn doublings on THIS board
     mardroeme: { close, ranged, siege } -> boolean,      // Mardroeme active on THIS board's row
     specials: [{ cardId, label }],                       // log-only record of special cards played, for display
   }
   -------------------------------------------------------------------- */

function emptyBoard() {
  return {
    close: [], ranged: [], siege: [],
    weather: { close: null, ranged: null, siege: null },
    horns: { close: 0, ranged: 0, siege: 0 },
    hornCards: { close: [], ranged: [], siege: [] }, // cardIds of true Horn specials (not Dandelion) played per row, for display
    mardroeme: { close: false, ranged: false, siege: false },
    mardroemeCards: { close: [], ranged: [], siege: [] }, // cardIds of true Mardroeme specials (not Ermion) played per row, for display
    specials: [],
    halveWeather: false, // set true for a King Bran-led board — weather halves Strength on THIS board instead of flattening it to 1
  };
}

function makePlayer({ name, faction, leaderId, deckIds, isAI }) {
  return {
    name, faction, leaderId, isAI: !!isAI,
    deck: deckIds, hand: [], board: emptyBoard(), discard: [],
    mulliganSwaps: 0, mulliganDone: false, passed: false,
    leaderUsed: false, leaderBlocked: false, leaderReveal: null,
    forceRandomRevive: false, // set true for Emhyr: Invader of the North
    pendingChoice: null,
  };
}

function dealHand(player) {
  const shuffled = shuffle(player.deck);
  return { ...player, hand: shuffled.slice(0, HAND_SIZE), deck: shuffled.slice(HAND_SIZE) };
}

/* Effective power of a single card sitting on `board` in row `row`.
   Heroes are fully immune to every modifier, good or bad.
   `spyDoubled` reflects whether either player in the match is leading
   with Eredin Bréacc Glas: The Treacherous, whose passive doubles every
   Spy card's strength for both sides. */
// Bond/Tight Bond copies share a base name but differ by a trailing
// " (1)" / " (2)" / ... numbering suffix (e.g. "Impera Brigade Guard (1)",
// "Impera Brigade Guard (2)"). Strip that suffix so same-unit copies are
// recognized as one bond family regardless of their exact numbered name.
function bondBaseName(name) {
  return name.replace(/\s*\(\d+\)\s*$/, "").trim();
}

function unitEffectivePower(cardId, board, row, spyDoubled) {
  const card = cardById(cardId);
  if (!card) return 0;
  if (card.cardType === "Hero") return card.power;

  // Weather is a flat override: an affected row's units are reduced to
  // exactly 1 power, full stop — Tight Bond, Morale Boost, and Horn no
  // longer apply on top of that (that's the entire point of weather).
  // A card whose printed power is already 0 stays at 0 — weather can't
  // raise a unit's power, only cap it, so there's nothing to "reduce to 1".
  if (board.weather[row]) {
    if (card.power === 0) return 0;
    // King Bran's passive: this board's units only lose half their Strength
    // (rounded so the loss favors the unit) instead of being flattened to 1.
    if (board.halveWeather) return Math.max(1, Math.ceil(card.power / 2));
    return 1;
  }

  let value = card.power;

  if (card.ability === "tightBond") {
    const base = bondBaseName(card.name);
    const count = board[row].filter((id) => {
      const c = cardById(id);
      return c && c.ability === "tightBond" && bondBaseName(c.name) === base;
    }).length;
    value = value * Math.max(count, 1);
  }

  const moraleSources = board[row].filter(
    (id) => id !== cardId && cardById(id)?.ability === "moraleBoost"
  ).length;
  value += moraleSources;

  if (card.ability === "spy" && spyDoubled) value = value * 2;

  // A unit that itself carries the horn ability (e.g. Dandelion) contributes
  // to the row's horn count but must not double its own power from that
  // contribution — it still benefits fully from any *other* horn source
  // (Commander's Horn, a leader horn, etc.) played in the same row.
  const selfHornContribution = card.ability === "horn" && card.row ? 1 : 0;
  const hornStacks = Math.max((board.horns[row] || 0) - selfHornContribution, 0);
  value = value * Math.pow(2, hornStacks);
  return value;
}

function rowTotal(board, row, spyDoubled) {
  return board[row].reduce((sum, id) => sum + unitEffectivePower(id, board, row, spyDoubled), 0);
}
function boardTotal(board, spyDoubled) {
  return ROWS.reduce((sum, r) => sum + rowTotal(board, r, spyDoubled), 0);
}
function matchHasLeader(state, leaderId) {
  return state.players.p1.leaderId === leaderId || state.players.p2.leaderId === leaderId;
}

// Heroes are immune to everything, including the GOOD stuff — Horn and
// Weather both pass right through them (fixed power, no doubling, no
// flattening). Any formula estimating "how much would doubling/freezing
// this row actually change" needs to sum only the non-Hero units, or it
// credits/blames a row for power that will never actually move.
function rowNonHeroPower(board, row, spyDoubled) {
  return board[row].reduce((sum, id) => {
    const c = cardById(id);
    if (!c || c.cardType === "Hero") return sum;
    return sum + unitEffectivePower(id, board, row, spyDoubled);
  }, 0);
}

function strongestInRow(board, row, spyDoubled) {
  const units = board[row].filter((id) => cardById(id)?.cardType !== "Hero");
  if (units.length === 0) return [];
  const powers = units.map((id) => unitEffectivePower(id, board, row, spyDoubled));
  const max = Math.max(...powers);
  if (max <= 0) return [];
  return units.filter((id, i) => powers[i] === max);
}

/* Global Scorch destroys the strongest non-Hero unit(s) across the ENTIRE
   battlefield — both players' boards combined — not just the opponent's
   side. `boardA` belongs to `sideA`, `boardB` to `sideB`; returns hits
   tagged with whichever side they came from so the caller can route each
   destroyed id to the correct player's discard pile. */
function strongestAcrossBoards(boardA, sideA, boardB, sideB, spyDoubled) {
  let max = 0;
  let hits = [];
  [{ side: sideA, board: boardA }, { side: sideB, board: boardB }].forEach(({ side, board }) => {
    ROWS.forEach((row) => {
      board[row].forEach((id) => {
        const card = cardById(id);
        if (!card || card.cardType === "Hero") return;
        const p = unitEffectivePower(id, board, row, spyDoubled);
        if (p > max) { max = p; hits = [{ side, id, row }]; }
        else if (p === max && p > 0) { hits.push({ side, id, row }); }
      });
    });
  });
  return hits;
}

/* Used when an Agile card needs a row decided automatically rather than via
   a player prompt — e.g. a Medic ability reviving an Agile card from the
   discard pile. Picks whichever row isn't weathered, or the lower-power
   row if both/neither are. */
function autoPlacementRow(card, board) {
  if (card.row !== "agile") return card.row;
  const closeWeathered = !!board.weather.close;
  const rangedWeathered = !!board.weather.ranged;
  if (closeWeathered && !rangedWeathered) return "ranged";
  if (!closeWeathered && rangedWeathered) return "close";
  return rowTotal(board, "close") <= rowTotal(board, "ranged") ? "close" : "ranged";
}

/* ---------------------------- ABILITY ENGINE -----------------------------
   `resolvePlayCard` is the single entry point every mode uses to play a
   card. It expects any choice the ability needs (agile row, decoy target,
   horn/mardroeme row, medic revive pick) to already be present in
   `options` — the UI layer is responsible for collecting that via a small
   picker *before* dispatching, so this function itself stays a plain,
   predictable state transform with no intermediate "waiting for input"
   state to track.
   -------------------------------------------------------------------- */

function otherKey(k) { return k === "p1" ? "p2" : "p1"; }
function withPlayer(state, key, updater) {
  return { ...state, players: { ...state.players, [key]: updater(state.players[key]) } };
}

function removeFromRow(board, cardId) {
  for (const row of ROWS) {
    if (board[row].includes(cardId)) {
      return { row, board: { ...board, [row]: board[row].filter((id) => id !== cardId) } };
    }
  }
  return { row: null, board };
}

function addToRow(board, row, cardId) {
  return { ...board, [row]: [...board[row], cardId] };
}

/* Destroys (moves to discard) the given card ids from `victimKey`'s board,
   triggering Summon Avenger replacements where relevant. Hero cards are
   filtered out by the callers (strongestInRow / strongestAcrossBoards
   already exclude them), so no immunity check is needed here. */
function destroyCards(state, victimKey, ids, log) {
  let ns = state;
  ids.forEach((id) => {
    const card = cardById(id);
    let victim = ns.players[victimKey];
    const { row, board } = removeFromRow(victim.board, id);
    victim = { ...victim, board, discard: [...victim.discard, id] };
    ns = withPlayer(ns, victimKey, () => victim);
    log.push(`${card.name} is destroyed.`);
    if (row && card.ability === "summonAvenger" && card.abilityMeta.summonsId) {
      ns = withPlayer(ns, victimKey, (p) => ({ ...p, board: addToRow(p.board, row, card.abilityMeta.summonsId) }));
      log.push(`${cardById(card.abilityMeta.summonsId).name} rises to take its place!`);
    }
  });
  return ns;
}

/* Berserker (Young Berserker / Berserker) transform into their named,
   stronger forms when Mardroeme is played in their row. */
function berserkerTransformTarget(card) {
  if (!card || card.ability !== "berserker") return null;
  if (card.name.startsWith("Young Berserker")) return cardById("c237"); // Transformed Young Vildkaarl
  if (card.name === "Berserker") return cardById("c238"); // Transformed Vildkaarl
  return null;
}

/* --------------------------- MUSTER GROUPS -------------------------------
   Muster used to simply match cards by identical name, but most muster
   families use numbered variants ("Nekker (1)", "Nekker (2)"...) that don't
   share an exact name string, and a few families have a distinctly-named
   "leader" card that behaves asymmetrically:
     - Playing the leader fetches every sibling.
     - Playing any sibling fetches only the OTHER siblings — never the leader.
   Every other muster family is a simple mutual group: playing any member
   fetches all the other members, with no separate leader. */
const MUSTER_GROUPS = [
  { leader: "c001", siblings: ["c002", "c003", "c004"] },                 // Arachas Behemoth -> Arachas
  { leader: "c061", siblings: ["c058", "c059", "c060"] },                 // Gaunter O'Dimm -> O'Dimm: Darkness
  { leader: "c039", siblings: ["c035", "c036", "c037", "c038"] },         // Vampire: Katakan -> other Vampires
  { leader: "c198", siblings: ["c206", "c207", "c208"] },                 // Cerys -> Clan Drummond Shield Maidens
  { leader: null, siblings: ["c008", "c009", "c010"] },                   // Crones (no leader — mutual)
  { leader: null, siblings: ["c020", "c021", "c022"] },                   // Ghouls (no leader — mutual)
  { leader: null, siblings: ["c030", "c031", "c032"] },                   // Nekkers
  { leader: null, siblings: ["c164", "c165", "c166"] },                   // Dwarven Skirmisher
  { leader: null, siblings: ["c168", "c169", "c170"] },                   // Elven Skirmisher
  { leader: null, siblings: ["c175", "c176", "c177"] },                   // Havekar Smuggler
  { leader: null, siblings: ["c219", "c220", "c221"] },                   // Light Longship
];

function musterFetchIds(playedId) {
  for (const g of MUSTER_GROUPS) {
    if (g.leader === playedId) return [...g.siblings];
    if (g.siblings.includes(playedId)) return g.siblings.filter((id) => id !== playedId);
  }
  return [];
}

function resolvePlayCard(state, actingKey, cardId, options = {}) {
  const spyDoubled = matchHasLeader(state, "L01");
  const card = cardById(cardId);
  const oppKey = otherKey(actingKey);
  if (!card) return state;
  const actor = state.players[actingKey];
  if (!actor.hand.includes(cardId)) return state;

  // Resolve the actual row this card lands in — handles Agile cards (which
  // need a chosen row) uniformly for every ability branch below, not just
  // the plain-unit default case.
  const targetRow = card.row === "agile" ? options.chosenRow : card.row;

  let ns = withPlayer(state, actingKey, (p) => ({ ...p, hand: p.hand.filter((id) => id !== cardId) }));
  const log = [];

  switch (card.ability) {
    case "weather": {
      const rows = Array.isArray(card.abilityMeta.row) ? card.abilityMeta.row : [card.abilityMeta.row];
      ns = withPlayer(ns, actingKey, (p) => {
        const weather = { ...p.board.weather };
        rows.forEach((r) => { weather[r] = { name: card.name, cardId }; });
        return { ...p, board: { ...p.board, weather, specials: [...p.board.specials, { cardId, label: card.name }] } };
      });
      ns = withPlayer(ns, oppKey, (p) => {
        const weather = { ...p.board.weather };
        rows.forEach((r) => { weather[r] = { name: card.name, cardId }; });
        return { ...p, board: { ...p.board, weather } };
      });
      log.push(`${actor.name} plays ${card.name}, freezing both sides' ${rows.map((r) => ROW_META[r].label).join(" & ")} row to 1 power.`);
      break;
    }
    case "clearWeather": {
      ns = withPlayer(ns, actingKey, (p) => ({
        ...p,
        board: { ...p.board, weather: { close: null, ranged: null, siege: null }, specials: [...p.board.specials, { cardId, label: card.name }] },
      }));
      ns = withPlayer(ns, oppKey, (p) => ({
        ...p,
        board: { ...p.board, weather: { close: null, ranged: null, siege: null } },
      }));
      log.push(`${actor.name} plays Clear Weather — both sides' boards thaw out.`);
      break;
    }
    case "horn": {
      const row = card.row || options.chosenRow; // Dandelion has a fixed row; Commander's Horn needs a choice
      // A row can only carry one row-boosting special effect at a time — Horn and Mardroeme are
      // mutually exclusive per row, same as real Gwent. The UI already blocks this pick, but guard
      // here too in case of stale state.
      if (state.players[actingKey].board.mardroeme[row]) { ns = withPlayer(ns, actingKey, (p) => ({ ...p, hand: [...p.hand, cardId] })); break; }
      ns = withPlayer(ns, actingKey, (p) => {
        const board = card.row ? addToRow(p.board, row, cardId) : { ...p.board, specials: [...p.board.specials, { cardId, label: card.name }] };
        const hornCards = card.row ? board.hornCards : { ...board.hornCards, [row]: [...board.hornCards[row], cardId] };
        return { ...p, board: { ...board, horns: { ...board.horns, [row]: (board.horns[row] || 0) + 1 }, hornCards } };
      });
      log.push(`${actor.name} plays ${card.name}, doubling their ${ROW_META[row].label} row.`);
      break;
    }
    case "mardroeme": {
      const row = card.row || options.chosenRow; // Ermion has a fixed row; Mardroeme (special) needs a choice
      // Same mutual exclusion as above, the other direction.
      if (state.players[actingKey].board.horns[row] > 0) { ns = withPlayer(ns, actingKey, (p) => ({ ...p, hand: [...p.hand, cardId] })); break; }
      ns = withPlayer(ns, actingKey, (p) => {
        let board = card.row ? addToRow(p.board, row, cardId) : { ...p.board, specials: [...p.board.specials, { cardId, label: card.name }] };
        const transformedRow = board[row].map((id) => {
          const target = berserkerTransformTarget(cardById(id));
          return target ? target.id : id;
        });
        const mardroemeCards = card.row ? board.mardroemeCards : { ...board.mardroemeCards, [row]: [...board.mardroemeCards[row], cardId] };
        return {
          ...p,
          board: { ...board, [row]: transformedRow, mardroeme: { ...board.mardroeme, [row]: true }, mardroemeCards },
        };
      });
      log.push(`${actor.name} plays Mardroeme — Berserkers in ${ROW_META[row].label} transform!`);
      break;
    }
    case "decoy": {
      const targetId = options.targetId;
      const { row } = removeFromRow(state.players[actingKey].board, targetId);
      if (!row) { ns = withPlayer(ns, actingKey, (p) => ({ ...p, hand: [...p.hand, cardId] })); break; } // invalid target, refund
      const targetCard = cardById(targetId);
      ns = withPlayer(ns, actingKey, (p) => {
        const afterRemove = removeFromRow(p.board, targetId).board;
        return { ...p, board: addToRow(afterRemove, row, cardId), hand: [...p.hand, targetId] };
      });
      log.push(`${actor.name} swaps Decoy for ${targetCard.name}, returning it to hand.`);
      break;
    }
    case "spy": {
      ns = withPlayer(ns, oppKey, (p) => ({ ...p, board: addToRow(p.board, targetRow, cardId) }));
      ns = withPlayer(ns, actingKey, (p) => {
        const drawn = p.deck.slice(0, 2);
        return { ...p, deck: p.deck.slice(2), hand: [...p.hand, ...drawn] };
      });
      log.push(`${actor.name} plays ${card.name} on ${state.players[oppKey].name}'s side and draws 2 cards.`);
      break;
    }
    case "muster": {
      ns = withPlayer(ns, actingKey, (p) => ({ ...p, board: addToRow(p.board, targetRow, cardId) }));
      const fetchIds = musterFetchIds(cardId);
      const foundInDeck = state.players[actingKey].deck.filter((id) => fetchIds.includes(id));
      const foundInHand = ns.players[actingKey].hand.filter((id) => fetchIds.includes(id));
      const found = [...foundInDeck, ...foundInHand];
      if (found.length) {
        ns = withPlayer(ns, actingKey, (p) => ({
          ...p,
          deck: p.deck.filter((id) => !foundInDeck.includes(id)),
          hand: p.hand.filter((id) => !foundInHand.includes(id)),
          board: found.reduce((b, id) => addToRow(b, cardById(id).row, id), p.board),
        }));
        log.push(`${actor.name} plays ${card.name} — Muster fetches ${found.length} more (deck & hand).`);
      } else {
        log.push(`${actor.name} plays ${card.name}.`);
      }
      break;
    }
    case "medic": {
      ns = withPlayer(ns, actingKey, (p) => ({ ...p, board: addToRow(p.board, targetRow, cardId) }));
      // Chain: if the revived card is itself a Medic, it immediately revives
      // another card too, and so on, until either the discard has nothing
      // eligible left or a link in the chain isn't a Medic. Only the very
      // first pick can come from `options.reviveId` (player's choice);
      // everything after that in the chain is automatic for now — v38's
      // interactive two-step rework will make each link player-chosen.
      let chainState = ns;
      let chainCount = 0;
      let preferredId = options.reviveId;
      let chaining = true;
      while (chaining) {
        const eligible = chainState.players[actingKey].discard.filter((id) => {
          const c = cardById(id);
          return c && c.cardType !== "Hero" && c.cardType !== "Special" && c.row;
        });
        if (!eligible.length) {
          if (chainCount === 0) log.push(`${actor.name} plays ${card.name} (Medic) — no eligible card in the discard pile.`);
          break;
        }
        const reviveId = actor.forceRandomRevive ? eligible[Math.floor(Math.random() * eligible.length)] : (preferredId && eligible.includes(preferredId) ? preferredId : eligible[0]);
        preferredId = null;
        const reviveCard = cardById(reviveId);
        if (reviveCard.ability === "spy") {
          // Reviving a Spy through Medic plays it exactly like a normal Spy:
          // it goes on the OPPONENT's side, and the medic's controller still
          // draws the usual 2 cards for it.
          chainState = withPlayer(chainState, oppKey, (p) => ({
            ...p,
            board: addToRow(p.board, autoPlacementRow(reviveCard, p.board), reviveId),
          }));
          chainState = withPlayer(chainState, actingKey, (p) => {
            const drawn = p.deck.slice(0, 2);
            return {
              ...p,
              discard: p.discard.filter((id) => id !== reviveId),
              deck: p.deck.slice(2),
              hand: [...p.hand, ...drawn],
            };
          });
          log.push(`${actor.name}'s Medic revives ${reviveCard.name} — as a Spy it's placed on ${state.players[oppKey].name}'s side, drawing 2 cards.`);
        } else {
          chainState = withPlayer(chainState, actingKey, (p) => ({
            ...p,
            discard: p.discard.filter((id) => id !== reviveId),
            board: addToRow(p.board, autoPlacementRow(reviveCard, p.board), reviveId),
          }));
          log.push(`${actor.name}'s Medic revives ${reviveCard.name} from the discard pile.`);
        }
        chainCount++;
        chaining = reviveCard.ability === "medic";
      }
      ns = chainState;
      break;
    }
    case "scorchGlobal": {
      const isUnitCard = !!card.row;
      if (isUnitCard) ns = withPlayer(ns, actingKey, (p) => ({ ...p, board: addToRow(p.board, targetRow, cardId) }));
      else ns = withPlayer(ns, actingKey, (p) => ({ ...p, discard: [...p.discard, cardId] }));
      const hits = strongestAcrossBoards(ns.players[actingKey].board, actingKey, ns.players[oppKey].board, oppKey, spyDoubled);
      log.push(`${actor.name} plays ${card.name} — Scorch hits the strongest unit(s) on the whole battlefield (both sides).`);
      const hitsBySide = { [actingKey]: [], [oppKey]: [] };
      hits.forEach((h) => hitsBySide[h.side].push(h.id));
      if (hitsBySide[oppKey].length) ns = destroyCards(ns, oppKey, hitsBySide[oppKey], log);
      if (hitsBySide[actingKey].length) ns = destroyCards(ns, actingKey, hitsBySide[actingKey], log);
      break;
    }
    case "scorchRow": {
      ns = withPlayer(ns, actingKey, (p) => ({ ...p, board: addToRow(p.board, targetRow, cardId) }));
      const hits = strongestInRow(state.players[oppKey].board, targetRow, spyDoubled);
      log.push(`${actor.name} plays ${card.name} — Scorch hits ${ROW_META[targetRow].label}.`);
      ns = destroyCards(ns, oppKey, hits, log);
      break;
    }
    case "scorchRowThreshold": {
      ns = withPlayer(ns, actingKey, (p) => ({ ...p, board: addToRow(p.board, targetRow, cardId) }));
      const scorchTargetRow = card.abilityMeta.row;
      const total = rowTotal(state.players[oppKey].board, scorchTargetRow, spyDoubled);
      log.push(`${actor.name} plays ${card.name}.`);
      if (total >= (card.abilityMeta.threshold || 10)) {
        const hits = strongestInRow(state.players[oppKey].board, scorchTargetRow, spyDoubled);
        log.push(`${ROW_META[scorchTargetRow].label} total was ${total} — Scorch triggers!`);
        ns = destroyCards(ns, oppKey, hits, log);
      }
      break;
    }
    case "summonAvenger":
    default: {
      // Berserkers played into a row where Mardroeme is already active
      // transform immediately on entry (not just units present at cast time).
      const berserkerTarget = card.ability === "berserker" ? berserkerTransformTarget(card) : null;
      ns = withPlayer(ns, actingKey, (p) => {
        const landId = berserkerTarget && p.board.mardroeme[targetRow] ? berserkerTarget.id : cardId;
        return { ...p, board: addToRow(p.board, targetRow, landId) };
      });
      log.push(
        berserkerTarget && ns.players[actingKey].board[targetRow].slice(-1)[0] === berserkerTarget.id
          ? `${actor.name} plays ${card.name} — it transforms into ${berserkerTarget.name} on arrival!`
          : `${actor.name} plays ${card.name} (${ROW_META[targetRow]?.label || "?"}).`
      );
      break;
    }
  }

  ns = { ...ns, log: [...ns.log, ...log] };
  ns = withPlayer(ns, actingKey, (p) => ({ ...p, passed: p.hand.length === 0 ? true : p.passed }));
  return ns;
}

/* ---------------------------- LEADER ENGINE ------------------------------
   21 of the 22 leaders are a once-per-game activated power the acting
   player triggers on their own turn (a "Use Leader Ability" button).
   Two are passive instead and never produce a visible effect through
   this function directly:
     - L01 Eredin Bréacc Glas: The Treacherous — handled inside the power
       engine itself (spyDoubled, see above).
     - L08 Emhyr var Emreis: Invader of the North — handled by setting
       forceRandomRevive on BOTH players at game setup (it affects every
       Medic-style revive in the match, not just its owner's), which the
       Medic branch of resolvePlayCard already checks.
   L22 King Bran is click-to-activate like the rest: his case below sets
   board.halveWeather on his own board when the player uses his ability,
   which unitEffectivePower already checks.
   -------------------------------------------------------------------- */

function leaderNeedsOptions(leaderId) {
  return leaderId === "L04" || leaderId === "L09"; // L04: discard 2, pick which. L09: pick a card from opp discard.
}

function resolveLeaderAbility(state, actingKey, options = {}) {
  const actor = state.players[actingKey];
  const oppKey = otherKey(actingKey);
  if (actor.leaderUsed || actor.leaderBlocked) return state;
  const leader = cardById(actor.leaderId);
  if (!leader) return withPlayer(state, actingKey, (p) => ({ ...p, leaderUsed: true })); // no leader to use — mark used so nothing can retry this forever

  let ns = withPlayer(state, actingKey, (p) => ({ ...p, leaderUsed: true }));
  const log = [`${actor.name} activates ${leader.name}: ${leader.ability}`];

  switch (actor.leaderId) {
    case "L04": { // Discard 2, draw 1
      const discardIds = (options.discardIds || []).filter((id) => actor.hand.includes(id)).slice(0, 2);
      ns = withPlayer(ns, actingKey, (p) => {
        const drawn = p.deck.slice(0, 1);
        return {
          ...p,
          hand: p.hand.filter((id) => !discardIds.includes(id)).concat(drawn),
          discard: [...p.discard, ...discardIds],
          deck: p.deck.slice(1),
        };
      });
      break;
    }
    case "L05": { // Pick any weather card from deck, play instantly
      const weatherCards = actor.deck.filter((id) => cardById(id)?.ability === "weather");
      if (weatherCards.length) {
        const pick = options.weatherId && weatherCards.includes(options.weatherId) ? options.weatherId : weatherCards[0];
        ns = withPlayer(ns, actingKey, (p) => ({ ...p, deck: p.deck.filter((id) => id !== pick), hand: [...p.hand, pick] }));
        ns = resolvePlayCard(ns, actingKey, pick, {});
      }
      break;
    }
    case "L02": { // Medic effect, instantly (as if a Medic unit were played, minus the body)
      const eligible = actor.discard.filter((id) => { const c = cardById(id); return c && c.cardType !== "Hero" && c.cardType !== "Special" && c.row; });
      if (eligible.length) {
        const reviveId = actor.forceRandomRevive ? eligible[Math.floor(Math.random() * eligible.length)] : (options.reviveId && eligible.includes(options.reviveId) ? options.reviveId : eligible[0]);
        const reviveCard = cardById(reviveId);
        if (reviveCard.ability === "spy") {
          ns = withPlayer(ns, oppKey, (p) => ({ ...p, board: addToRow(p.board, autoPlacementRow(reviveCard, p.board), reviveId) }));
          ns = withPlayer(ns, actingKey, (p) => {
            const drawn = p.deck.slice(0, 2);
            return { ...p, discard: p.discard.filter((id) => id !== reviveId), deck: p.deck.slice(2), hand: [...p.hand, ...drawn] };
          });
          log.push(`Revives ${reviveCard.name} — as a Spy it's placed on ${state.players[oppKey].name}'s side, drawing 2 cards.`);
        } else {
          ns = withPlayer(ns, actingKey, (p) => ({ ...p, discard: p.discard.filter((id) => id !== reviveId), board: addToRow(p.board, autoPlacementRow(reviveCard, p.board), reviveId) }));
          log.push(`Revives ${reviveCard.name} from the discard pile.`);
        }
      }
      break;
    }
    case "L03": { // Horn on Close Combat, instantly
      ns = withPlayer(ns, actingKey, (p) => ({ ...p, board: { ...p.board, horns: { ...p.board.horns, close: p.board.horns.close + 1 }, hornCards: { ...p.board.hornCards, close: [...p.board.hornCards.close, "c049"] } } }));
      break;
    }
    case "L06": { // Look at 3 opponent cards (from their deck)
      const oppDeck = state.players[oppKey].deck;
      const shown = shuffle(oppDeck).slice(0, 3);
      ns = withPlayer(ns, actingKey, (p) => ({ ...p, leaderReveal: shown }));
      break;
    }
    case "L07": { // Fetch + play Torrential Rain
      const found = actor.deck.find((id) => cardById(id)?.name?.startsWith("Torrential Rain"));
      if (found) {
        ns = withPlayer(ns, actingKey, (p) => ({ ...p, deck: p.deck.filter((id) => id !== found), hand: [...p.hand, found] }));
        ns = resolvePlayCard(ns, actingKey, found, {});
      }
      break;
    }
    case "L09": { // Take a non-Hero card from opponent's discard and play it instantly
      const oppDiscard = state.players[oppKey].discard.filter((id) => cardById(id)?.cardType !== "Hero");
      if (oppDiscard.length) {
        const pick = options.pickId && oppDiscard.includes(options.pickId) ? options.pickId : oppDiscard[Math.floor(Math.random() * oppDiscard.length)];
        const pickCard = cardById(pick);
        ns = withPlayer(ns, oppKey, (p) => ({ ...p, discard: p.discard.filter((id) => id !== pick) }));
        ns = withPlayer(ns, actingKey, (p) => ({ ...p, hand: [...p.hand, pick] }));
        log.push(`Takes ${pickCard.name} from the discard pile and plays it instantly.`);
        ns = { ...ns, log: [...ns.log, ...log] };
        ns = resolvePlayCard(ns, actingKey, pick, pickCard.row === "agile" ? { chosenRow: autoPlacementRow(pickCard, ns.players[actingKey].board) } : {});
        return ns;
      }
      break;
    }
    case "L10": { // Cancel opponent's leader ability
      ns = withPlayer(ns, oppKey, (p) => ({ ...p, leaderBlocked: true }));
      break;
    }
    case "L11": { // Fog — Impenetrable Fog on both sides' Ranged row
      ns = withPlayer(ns, actingKey, (p) => ({ ...p, board: { ...p.board, weather: { ...p.board.weather, ranged: { name: leader.name, cardId: "c063" } } } }));
      ns = withPlayer(ns, oppKey, (p) => ({ ...p, board: { ...p.board, weather: { ...p.board.weather, ranged: { name: leader.name, cardId: "c063" } } } }));
      break;
    }
    case "L12": { // Clear Weather, instantly — affects both sides, since weather itself now does
      ns = withPlayer(ns, actingKey, (p) => ({ ...p, board: { ...p.board, weather: { close: null, ranged: null, siege: null } } }));
      ns = withPlayer(ns, oppKey, (p) => ({ ...p, board: { ...p.board, weather: { close: null, ranged: null, siege: null } } }));
      break;
    }
    case "L13": { // Foltest: Son of Medell — scorch Ranged if total >= 10
      const total = rowTotal(state.players[oppKey].board, "ranged", matchHasLeader(state, "L01"));
      if (total >= 10) {
        const hits = strongestInRow(state.players[oppKey].board, "ranged", matchHasLeader(state, "L01"));
        ns = destroyCards(ns, oppKey, hits, log);
      }
      break;
    }
    case "L14": { // Horn on Siege, instantly
      ns = withPlayer(ns, actingKey, (p) => ({ ...p, board: { ...p.board, horns: { ...p.board.horns, siege: p.board.horns.siege + 1 }, hornCards: { ...p.board.hornCards, siege: [...p.board.hornCards.siege, "c049"] } } }));
      break;
    }
    case "L15": { // Scorch Siege if total >= 10
      const total = rowTotal(state.players[oppKey].board, "siege", matchHasLeader(state, "L01"));
      if (total >= 10) {
        const hits = strongestInRow(state.players[oppKey].board, "siege", matchHasLeader(state, "L01"));
        ns = destroyCards(ns, oppKey, hits, log);
      }
      break;
    }
    case "L16": { // Draw an extra card
      ns = withPlayer(ns, actingKey, (p) => ({ ...p, hand: [...p.hand, ...p.deck.slice(0, 1)], deck: p.deck.slice(1) }));
      break;
    }
    case "L17": { // Francesca: Hope of the Aen Seidhe — reposition Agile units for max value
      ns = withPlayer(ns, actingKey, (p) => {
        let board = p.board;
        const agileIds = [...board.close, ...board.ranged].filter((id) => cardById(id)?.row === "agile");
        agileIds.forEach((id) => {
          const { row: curRow, board: removed } = removeFromRow(board, id);
          const closeVal = unitEffectivePower(id, addToRow(removed, "close", id), "close", false);
          const rangedVal = unitEffectivePower(id, addToRow(removed, "ranged", id), "ranged", false);
          const bestRow = rangedVal > closeVal ? "ranged" : "close";
          board = addToRow(removed, bestRow, id);
        });
        return { ...p, board };
      });
      break;
    }
    case "L18": { // Frost — Biting Frost on both sides' Close Combat row
      ns = withPlayer(ns, actingKey, (p) => ({ ...p, board: { ...p.board, weather: { ...p.board.weather, close: { name: leader.name, cardId: "c042" } } } }));
      ns = withPlayer(ns, oppKey, (p) => ({ ...p, board: { ...p.board, weather: { ...p.board.weather, close: { name: leader.name, cardId: "c042" } } } }));
      break;
    }
    case "L19": { // Francesca: Queen of Dol Blathanna — scorch Close Combat if total >= 10
      const total = rowTotal(state.players[oppKey].board, "close", matchHasLeader(state, "L01"));
      if (total >= 10) {
        const hits = strongestInRow(state.players[oppKey].board, "close", matchHasLeader(state, "L01"));
        ns = destroyCards(ns, oppKey, hits, log);
      }
      break;
    }
    case "L20": { // Horn on Ranged, instantly
      ns = withPlayer(ns, actingKey, (p) => ({ ...p, board: { ...p.board, horns: { ...p.board.horns, ranged: p.board.horns.ranged + 1 }, hornCards: { ...p.board.hornCards, ranged: [...p.board.hornCards.ranged, "c049"] } } }));
      break;
    }
    case "L21": { // Crach an Craite — shuffle both players' graveyards back into their decks
      ns = withPlayer(ns, actingKey, (p) => ({ ...p, deck: shuffle([...p.deck, ...p.discard]), discard: [] }));
      ns = withPlayer(ns, oppKey, (p) => ({ ...p, deck: shuffle([...p.deck, ...p.discard]), discard: [] }));
      log.push(`Shuffles both graveyards back into their decks.`);
      break;
    }
    case "L22": { // King Bran — on activation, this board's weather softens to half Strength instead of flattening to 1
      ns = withPlayer(ns, actingKey, (p) => ({ ...p, board: { ...p.board, halveWeather: true } }));
      break;
    }

    default: break;
  }

  ns = { ...ns, log: [...ns.log, ...log] };
  return ns;
}

/* ------------------------- ROUND SCORING & REDUCER ----------------------- */

/* Splits a batch of departing board-card ids into the ids that actually go
   to discard, plus any Summon Avenger tokens that should rise to take their
   place. Summon Avenger (Cow -> Bovine Defense Force, Kambi -> Hemdall)
   triggers on ANY removal from the battlefield, including the normal
   end-of-round clear — not just mid-round destruction. */
function processSummonAvengerOnExit(ids) {
  const discard = [];
  const summoned = [];
  ids.forEach((id) => {
    const card = cardById(id);
    discard.push(id);
    if (card && card.ability === "summonAvenger" && card.abilityMeta.summonsId && card.row && card.row !== "agile") {
      summoned.push({ row: card.row, id: card.abilityMeta.summonsId });
    }
  });
  return { discard, summoned };
}

function clearBoardToDiscard(player) {
  const allIds = [...player.board.close, ...player.board.ranged, ...player.board.siege, ...player.board.specials.map((s) => s.cardId)];
  const { discard: discardedIds, summoned } = processSummonAvengerOnExit(allIds);
  let board = emptyBoard();
  summoned.forEach(({ row, id }) => { board = addToRow(board, row, id); });
  return { ...player, board, discard: [...player.discard, ...discardedIds] };
}

/* Shared "keep exactly one random unit on the battlefield" mechanic:
   - Monsters use this at the end of EVERY round.
   - Skellige uses this specifically heading into Round 3 (their faction
     ability leaves one random card undiscarded for the final round,
     rather than the whole board surviving).
   Weather/horns/Mardroeme still reset as normal for everyone. */
function clearBoardWithOneRandomRetained(player) {
  const candidates = ROWS.flatMap((r) => player.board[r].map((id) => ({ id, row: r })));
  if (candidates.length === 0) return clearBoardToDiscard(player);
  const keep = candidates[Math.floor(Math.random() * candidates.length)];
  const toDiscardIds = [
    ...player.board.close, ...player.board.ranged, ...player.board.siege, ...player.board.specials.map((s) => s.cardId),
  ].filter((id) => id !== keep.id);
  const { discard: discardedIds, summoned } = processSummonAvengerOnExit(toDiscardIds);
  let board = { ...emptyBoard(), [keep.row]: [keep.id] };
  summoned.forEach(({ row, id }) => { board = addToRow(board, row, id); });
  return { ...player, board, discard: [...player.discard, ...discardedIds] };
}

function finishRound(state) {
  const spyDoubled = matchHasLeader(state, "L01");
  const p1total = boardTotal(state.players.p1.board, spyDoubled);
  const p2total = boardTotal(state.players.p2.board, spyDoubled);
  const p1IsNilfgaard = state.players.p1.faction === "nilfgaard";
  const p2IsNilfgaard = state.players.p2.faction === "nilfgaard";

  let roundWins = { ...state.roundWins };
  let winnerKey = null; // "p1" | "p2" | null (a true, unbroken tie — both score)
  let nilfgaardBrokeTie = false;

  if (p1total > p2total) winnerKey = "p1";
  else if (p2total > p1total) winnerKey = "p2";
  else if (p1IsNilfgaard !== p2IsNilfgaard) {
    // Nilfgaardian Empire faction ability: always wins a tied round, unless both sides are Nilfgaard.
    winnerKey = p1IsNilfgaard ? "p1" : "p2";
    nilfgaardBrokeTie = true;
  }

  if (winnerKey) roundWins[winnerKey] += 1;
  else { roundWins.p1 += 1; roundWins.p2 += 1; } // true tie: both players score a point

  const gameOver = roundWins.p1 >= 2 || roundWins.p2 >= 2;
  const gameWinner = gameOver ? (roundWins.p1 > roundWins.p2 ? "p1" : roundWins.p2 > roundWins.p1 ? "p2" : "draw") : null;

  const logLines = [`Round ${state.round} ends — ${state.players.p1.name} ${p1total} : ${p2total} ${state.players.p2.name}.`];
  if (nilfgaardBrokeTie) logLines.push(`${state.players[winnerKey].name}'s Nilfgaardian Empire claims the tied round!`);
  else if (!winnerKey) logLines.push("It's a tie — both players score a point.");

  let ns = {
    ...state,
    phase: gameOver ? "gameEnd" : "roundEnd",
    roundWins,
    lastRoundScore: { p1: p1total, p2: p2total },
    gameWinner,
    log: [...state.log, ...logLines],
  };

  // Northern Realms faction ability: the round winner draws a random card from their deck.
  if (winnerKey && ns.players[winnerKey].faction === "northern_realms" && ns.players[winnerKey].deck.length > 0) {
    ns = withPlayer(ns, winnerKey, (p) => {
      const [drawn, ...rest] = shuffle(p.deck);
      return { ...p, hand: [...p.hand, drawn], deck: rest };
    });
    ns = { ...ns, log: [...ns.log, `${ns.players[winnerKey].name}'s Northern Realms rally draws a card from the deck.`] };
  }

  return ns;
}

function startNextRound(state) {
  const loserKey = state.lastRoundScore.p1 <= state.lastRoundScore.p2 ? "p1" : "p2";
  const nextRound = state.round + 1;
  const logExtra = [];

  function clearFor(player) {
    if (player.faction === "monsters") return clearBoardWithOneRandomRetained(player);
    if (player.faction === "skellige" && nextRound === 3) {
      const hadUnits = ROWS.some((r) => player.board[r].length > 0);
      const cleared = clearBoardWithOneRandomRetained(player);
      if (hadUnits) logExtra.push(`${player.name}'s Skellige clansmen refuse to fall — one card stays on the battlefield for the final round!`);
      return cleared;
    }
    return clearBoardToDiscard(player);
  }

  let ns = {
    ...state,
    phase: "play",
    round: nextRound,
    turn: loserKey, // loser of the previous round opens the next one
    players: {
      p1: { ...clearFor(state.players.p1), passed: false },
      p2: { ...clearFor(state.players.p2), passed: false },
    },
  };

  if (logExtra.length) ns = { ...ns, log: [...ns.log, ...logExtra] };

  return ns;
}

/* ------------------------------ COIN FLIP -------------------------------- */

function coinCall(state, callerKey, call) {
  return { ...state, coinFlip: { ...state.coinFlip, caller: callerKey, call, resolved: false } };
}

function coinFlipResolve(state) {
  const cf = state.coinFlip;
  const result = flipCoin();
  const callerWon = cf.call === result;
  const starter = callerWon ? cf.caller : otherKey(cf.caller);
  return {
    ...state,
    coinFlip: { ...cf, result, callerWon, starter, resolved: true },
    log: [...state.log, `The coin lands on ${result}. ${callerWon ? "The call was right!" : "The call was wrong."} ${state.players[starter].name} won the toss and will open Round 1.`],
  };
}

function coinChooseStarter(state, starterKey) {
  return {
    ...state,
    phase: "mulligan",
    turn: starterKey,
    coinFlip: { ...state.coinFlip, starter: starterKey },
    log: [...state.log, `${state.players[starterKey].name} will open Round 1.`],
  };
}

/* -------------------------------- REDUCER -------------------------------- */

function gameReducer(state, action) {
  switch (action.type) {
    case "COIN_CALL":
      return coinCall(state, action.player, action.call);
    case "COIN_FLIP":
      return coinFlipResolve(state);
    case "COIN_ACK":
      // The coin toss no longer offers a choice — the winner automatically
      // starts. This just acknowledges the result and moves on to mulligan.
      return coinChooseStarter(state, state.coinFlip.starter);
    case "SCOIA_CHOOSE_STARTER":
      // Scoia'tael faction ability: skips the coin toss entirely.
      return coinChooseStarter(state, action.starter);

    case "MULLIGAN_SWAP": {
      const { player, cardId } = action;
      return withPlayer(state, player, (p) => {
        if (p.mulliganSwaps >= MAX_MULLIGAN || !p.hand.includes(cardId) || p.deck.length === 0) return p;
        const [replacement, ...restDeck] = shuffle(p.deck);
        return {
          ...p,
          hand: p.hand.map((id) => (id === cardId ? replacement : id)),
          deck: shuffle([...restDeck, cardId]),
          mulliganSwaps: p.mulliganSwaps + 1,
        };
      });
    }
    case "MULLIGAN_DONE": {
      let ns = withPlayer(state, action.player, (p) => ({ ...p, mulliganDone: true }));
      const bothDone = ns.players.p1.mulliganDone && ns.players.p2.mulliganDone;
      if (bothDone) ns = { ...ns, phase: "play" };
      return ns;
    }

    case "PLAY_CARD": {
      let ns = resolvePlayCard(state, action.player, action.cardId, action.options || {});
      if (ns.players.p1.passed && ns.players.p2.passed) return finishRound(ns);
      const nextKey = otherKey(action.player);
      ns = { ...ns, turn: ns.players[nextKey].passed ? action.player : nextKey };
      return ns;
    }
    case "USE_LEADER": {
      if (action.options && action.options.ackReveal) {
        return withPlayer(state, action.player, (p) => ({ ...p, leaderReveal: null }));
      }
      let ns = resolveLeaderAbility(state, action.player, action.options || {});
      // Using a leader ability consumes a turn, same as playing a card or a weather effect.
      const nextKey = otherKey(action.player);
      ns = { ...ns, turn: ns.players[nextKey].passed ? action.player : nextKey };
      return ns;
    }
    case "PASS": {
      let ns = withPlayer(state, action.player, (p) => ({ ...p, passed: true }));
      if (ns.players.p1.passed && ns.players.p2.passed) return finishRound(ns);
      const nextKey = otherKey(action.player);
      ns = { ...ns, turn: ns.players[nextKey].passed ? action.player : nextKey };
      return ns;
    }
    case "CONTINUE_ROUND":
      return startNextRound(state);

    case "FORFEIT": {
      const winnerKey = otherKey(action.player);
      const roundWins = { ...state.roundWins, [winnerKey]: 2 };
      return {
        ...state,
        phase: "gameEnd",
        roundWins,
        gameWinner: winnerKey,
        log: [...state.log, `${state.players[action.player].name} forfeits — ${state.players[winnerKey].name} wins the game!`],
      };
    }

    default:
      return state;
  }
}

/* ------------------------------ GAME INIT -------------------------------- */

function initGame(p1cfg, p2cfg) {
  resetStartingBasicGuard(); // a brand new game means the opening-hand sound can fire again
  let p1 = dealHand(makePlayer(p1cfg));
  let p2 = dealHand(makePlayer(p2cfg));
  // L08 Invader of the North affects Medic-style revives for BOTH players
  // in the match, no matter which side is leading with it.
  if (p1cfg.leaderId === "L08" || p2cfg.leaderId === "L08") {
    p1 = { ...p1, forceRandomRevive: true };
    p2 = { ...p2, forceRandomRevive: true };
  }
  // L22 King Bran: no longer auto-applied at setup — his ability now
  // activates like any other leader, via resolveLeaderAbility (case "L22"),
  // which sets board.halveWeather on his own board at that point.

  // Scoia'tael faction ability: if exactly one side is Scoia'tael, that
  // player chooses who opens Round 1 — no coin toss needed. If both sides
  // (or neither) are Scoia'tael, the coin toss proceeds as normal.
  const p1Scoia = p1cfg.faction === "scoiatael";
  const p2Scoia = p2cfg.faction === "scoiatael";
  const scoiaChooser = p1Scoia !== p2Scoia ? (p1Scoia ? "p1" : "p2") : null;

  return {
    phase: scoiaChooser ? "scoiaChoice" : "coinflip",
    scoiaChooser,
    round: 1,
    turn: null,
    roundWins: { p1: 0, p2: 0 },
    lastRoundScore: null,
    gameWinner: null,
    coinFlip: { caller: null, call: null, result: null, callerWon: null, starter: null, resolved: false },
    log: scoiaChooser
      ? [`${(scoiaChooser === "p1" ? p1 : p2).name}'s Scoia'tael scouts choose who opens Round 1 — no coin toss needed.`]
      : ["A new game begins. Call the coin toss to decide who opens Round 1."],
    players: { p1, p2 },
  };
}

/* ------------------------- AUTO-OPTIONS (AI + smart defaults) ------------ */

function autoOptionsForCard(card, board, discard = [], deck = []) {
  if (card.ability === "medic") {
    const eligible = discard.filter((id) => {
      const c = cardById(id);
      return c && c.cardType !== "Hero" && c.cardType !== "Special" && c.row;
    });
    if (!eligible.length) return {};
    const best = [...eligible].sort((a, b) => (cardById(b)?.power || 0) - (cardById(a)?.power || 0))[0];
    return { reviveId: best };
  }
  if (card.row === "agile") {
    const closeWeathered = !!board.weather.close;
    const rangedWeathered = !!board.weather.ranged;
    let chosenRow = "close";
    if (closeWeathered && !rangedWeathered) chosenRow = "ranged";
    else if (!closeWeathered && rangedWeathered) chosenRow = "close";
    else chosenRow = rowTotal(board, "close") <= rowTotal(board, "ranged") ? "close" : "ranged";
    return { chosenRow };
  }
  if (card.ability === "horn" && !card.row) {
    // Heroes don't benefit from Horn at all — picking the row with the
    // highest RAW total (including Hero power) picked a row that was
    // entirely a Hero more than once in self-play (Philippa Eilhart,
    // Tibor Eggebracht), doubling nothing for zero net gain. Rank by the
    // non-Hero power actually being doubled instead.
    let best = "close", bestVal = -1;
    ROWS.forEach((r) => { const v = rowNonHeroPower(board, r); if (v > bestVal) { bestVal = v; best = r; } });
    return { chosenRow: best };
  }
  if (card.ability === "mardroeme") {
    let best = "close", bestCount = -1;
    ROWS.forEach((r) => {
      const count = board[r].filter((id) => cardById(id)?.ability === "berserker").length;
      if (count > bestCount) { bestCount = count; best = r; }
    });
    return { chosenRow: best };
  }
  if (card.ability === "decoy") {
    const candidates = ROWS.flatMap((r) => board[r].map((id) => ({ id, row: r, card: cardById(id) })))
      .filter((x) => x.card && x.card.cardType !== "Hero" && x.card.row);
    if (!candidates.length) return null; // no legal target — caller should skip this card
    // Prefer recycling a unit whose on-play ability ACTUALLY pays out again
    // when replayed — not just any unit tagged spy/medic/muster. A Medic
    // with an empty discard, or a Muster card whose siblings are all already
    // on the board, gains nothing from being replayed; treating those as
    // "recyclable" was why the AI kept bouncing spent cards for zero value
    // (logs showed it decoying an already-fired Toad, or replaying a
    // Trebuchet right back into the same slot, both dead turns). Only a
    // genuinely eligible target gets the priority boost.
    const REPLAY_PRIORITY = { spy: 3, medic: 2, muster: 1 };
    const isEligibleReplay = (c) => {
      if (c.ability === "spy") return true; // always draws 2 more, no precondition
      if (c.ability === "medic") {
        return discard.some((id) => {
          const dc = cardById(id);
          return dc && dc.cardType !== "Hero" && dc.cardType !== "Special" && dc.row;
        });
      }
      if (c.ability === "muster") {
        return musterFetchIds(c.id).some((id) => deck.includes(id));
      }
      return false;
    };
    const recyclable = candidates.filter((x) => REPLAY_PRIORITY[x.card.ability] && isEligibleReplay(x.card));
    if (recyclable.length) {
      recyclable.sort((a, b) => REPLAY_PRIORITY[b.card.ability] - REPLAY_PRIORITY[a.card.ability]);
      return { targetId: recyclable[0].id };
    }
    candidates.sort((a, b) => unitEffectivePower(a.id, board, a.row) - unitEffectivePower(b.id, board, b.row));
    return { targetId: candidates[0].id };
  }
  return {};
}

// A row sitting at 10+ power, well clear of the AI's other rows, is exactly
// the shape a Scorch or a threshold-triggered leader (Francesca, Foltest,
// Villentretenmerth) is built to punish in one hit. This used to only guard
// the generic flat-power fallback at the bottom of estimateCardImpact — every
// special-ability branch (muster, tightBond, moraleBoost, scorchRow) returns
// early and skipped it entirely, which is exactly backwards: a Muster chain
// dumping 3 cards into one row at once is the single riskiest shape of all.
// Self-play logs showed this cost two full board wipes (a Crone chain piling
// 18 power into Close Combat, punished by an unused Francesca leader) plus a
// Villentretenmerth played into an already-15 Close Combat row. Scales with
// both how far past the threshold the row ends up AND how much of that came
// from this one play — a single card tipping it over is less alarming than a
// whole chain doing it at once.
function stackingPenalty(board, row, addedPower, spyDoubled) {
  if (!row || !ROWS.includes(row)) return 0;
  const rowAfter = rowTotal(board, row, spyDoubled) + addedPower;
  const otherRowsMax = Math.max(0, ...ROWS.filter((r) => r !== row).map((r) => rowTotal(board, r, spyDoubled)));
  if (rowAfter >= 10 && rowAfter > otherRowsMax + 6) {
    return -Math.min(6, (rowAfter - 10) * 0.4 + addedPower * 0.15);
  }
  return 0;
}

/* Estimates how much a card is actually worth playing right now, accounting
   for its ability instead of just its printed power — a lone Tight Bond
   card looks weak by power alone but is worth much more once a stack is
   already down, a Muster card is worth its whole fetch chain, Morale Boost
   buffs every other unit in the row, Horn is worth roughly the row it
   doubles, and Weather/Scorch are only worth playing when they actually
   hurt the opponent more than they cost. */
function estimateCardImpact(card, me, opp, spyDoubled) {
  const board = me.board;

  if (card.ability === "muster") {
    const chain = musterFetchIds(card.id).filter((id) => me.hand.includes(id) || me.deck.includes(id));
    const chainPower = chain.reduce((sum, id) => sum + (cardById(id)?.power || 0), 0);
    // Only the siblings landing in the SAME row as this card count toward the
    // stacking risk — a muster group split across rows doesn't pile onto one
    // Scorch-able target the way same-row copies (e.g. all three Crones into
    // Close Combat) do.
    const sameRowChainPower = chain.reduce((sum, id) => {
      const c = cardById(id);
      return c && c.row === card.row ? sum + c.power : sum;
    }, 0);
    return card.power + chainPower + stackingPenalty(board, card.row, card.power + sameRowChainPower, spyDoubled);
  }

  if (card.ability === "tightBond" && card.row) {
    const base = bondBaseName(card.name);
    const already = (board[card.row] || []).filter((id) => {
      const c = cardById(id);
      return c && c.ability === "tightBond" && bondBaseName(c.name) === base;
    }).length;
    // Growing an existing bond stack re-values every copy already down, so
    // it's worth much more than a flat card of the same printed power.
    const gain = card.power * (already + 1) + card.power * already;
    return gain + stackingPenalty(board, card.row, gain, spyDoubled);
  }

  if (card.ability === "moraleBoost" && card.row) {
    const others = (board[card.row] || []).filter((id) => cardById(id)?.cardType !== "Hero").length;
    // This card benefits from any Morale Boost already sitting in the row
    // too, same as every other non-Hero unit there — forgetting that
    // undervalues playing a second Morale source into an existing stack.
    const existingMoraleSources = (board[card.row] || []).filter((id) => cardById(id)?.ability === "moraleBoost").length;
    const gain = card.power + existingMoraleSources + others;
    return gain + stackingPenalty(board, card.row, gain, spyDoubled);
  }

  if (card.ability === "horn") {
    const targetRow = card.row || (autoOptionsForCard(card, board) || {}).chosenRow;
    // Heroes don't double — count only the non-Hero power actually affected.
    return card.power + (targetRow ? rowNonHeroPower(board, targetRow, spyDoubled) : 0);
  }

  if (card.ability === "weather") {
    const rows = Array.isArray(card.abilityMeta.row) ? card.abilityMeta.row : [card.abilityMeta.row];
    // Heroes are immune to weather too — a row anchored by one looks like a
    // big juicy target by raw total but won't actually lose any power.
    const oppHit = rows.reduce((sum, r) => sum + rowNonHeroPower(opp.board, r, spyDoubled), 0);
    const selfHit = rows.reduce((sum, r) => sum + rowNonHeroPower(me.board, r, spyDoubled), 0);
    // No floor here on purpose: if selfHit outweighs oppHit this should come
    // back NEGATIVE, not clamp to a fake "harmless" 0 — a weather that hurts
    // our own board more than theirs is an active mistake, not a safe dump.
    return oppHit - selfHit - 3;
  }

  if (card.ability === "scorchRow" && card.row) {
    const hits = strongestInRow(opp.board, card.row, spyDoubled);
    const gain = card.power + hits.reduce((sum, id) => sum + unitEffectivePower(id, opp.board, card.row, spyDoubled), 0);
    return gain + stackingPenalty(board, card.row, card.power, spyDoubled);
  }

  if (card.ability === "scorchGlobal") {
    const hits = strongestAcrossBoards(me.board, "me", opp.board, "opp", spyDoubled);
    let gain = 0, selfLoss = 0;
    hits.forEach((h) => {
      const v = unitEffectivePower(h.id, h.side === "me" ? me.board : opp.board, h.row, spyDoubled);
      if (h.side === "opp") gain += v; else selfLoss += v;
    });
    return gain - selfLoss;
  }

  if (card.ability === "scorchRowThreshold") {
    const r = card.abilityMeta.row;
    const total = rowTotal(opp.board, r, spyDoubled);
    if (total >= (card.abilityMeta.threshold || 10)) {
      const hits = strongestInRow(opp.board, r, spyDoubled);
      const gain = card.power + hits.reduce((sum, id) => sum + unitEffectivePower(id, opp.board, r, spyDoubled), 0);
      return gain + stackingPenalty(board, card.row, card.power, spyDoubled);
    }
    return card.power + stackingPenalty(board, card.row, card.power, spyDoubled);
  }

  if (card.ability === "decoy") {
    const opts = autoOptionsForCard(card, board, me.discard, me.deck);
    const target = opts && opts.targetId ? cardById(opts.targetId) : null;
    if (!target) return -99; // shouldn't happen (caller filters unplayable cards), but never force it
    const targetRow = ROWS.find((r) => board[r].includes(opts.targetId));
    // Decoy is a 0-power card that takes the returned unit's spot — playing
    // it costs the target's current power on THIS turn's board total. That
    // cost is real and immediate; the payoff (if any) only lands on some
    // later turn when the recycled card gets replayed. Ignoring that cost
    // was why the AI kept bouncing cards for a flat "positive" score even
    // when it had nothing to gain — e.g. decoying an already-fired Toad
    // with the opponent's row already empty, or a plain Trebuchet with no
    // ability at all, straight loss of board power for a wasted turn.
    const immediateCost = targetRow ? unitEffectivePower(opts.targetId, board, targetRow, spyDoubled) : target.power;
    let replayValue = 0;
    if (target.ability === "spy") replayValue = 6; // reliably banks another 2-card draw
    else if (target.ability === "medic") replayValue = 5; // eligibility already verified by autoOptionsForCard
    else if (target.ability === "muster") replayValue = 3; // eligibility already verified by autoOptionsForCard
    return replayValue - immediateCost;
  }

  if (card.ability === "spy") {
    // The card itself goes on the OPPONENT's board — it adds nothing to our
    // own total this turn, and worse, hands them its printed power. A flat
    // constant here treated a 0-power Mysterious Elf identically to a
    // 9-power Stefan Skellen, when the latter is a real gift to their board.
    // The 2-card draw is still valuable enough that this rarely goes
    // negative, but a high-power spy should score well below a cheap one.
    return 6 - card.power * 0.6;
  }

  if (card.ability === "medic") {
    const opts = autoOptionsForCard(card, me.board, me.discard);
    const reviveCard = opts && opts.reviveId ? cardById(opts.reviveId) : null;
    return card.power + (reviveCard ? reviveCard.power : 0);
  }

  // Flat power play — lightly discourage stacking one row far past a
  // typical Scorch-row threshold (~10) when there's no Horn/immune backup,
  // since a single opposing Scorch can wipe the whole row at once. Cheap
  // stand-in for real lookahead: don't put all the eggs in one basket.
  if (card.row && ROWS.includes(card.row)) {
    const rowAfter = rowTotal(board, card.row, spyDoubled) + card.power;
    const otherRowsMax = Math.max(0, ...ROWS.filter((r) => r !== card.row).map((r) => rowTotal(board, r, spyDoubled)));
    if (rowAfter >= 10 && rowAfter > otherRowsMax + 6) {
      return card.power - 1.5;
    }
  }

  return card.power;
}

/* ---------------------------- AI DECK BUILDING ---------------------------
   The AI used to just grab a random faction and a random 22-card slice of
   its pool with a random leader — no wonder it played badly, it was often
   holding a deck with no coherent plan. Instead, score every card in the
   pool for how useful it generally is (raw power plus a bonus for value-add
   abilities) and keep the strongest DECK_SIZE, then pick whichever leader
   in that faction is most consistently strong. A little randomness is kept
   among close scores so the AI isn't 100% deterministic every game. */
function evaluateCardBaseValue(card) {
  let v = card.power || 0;
  if (card.cardType === "Hero") v += 3; // immune to removal/weather — always reliable
  switch (card.ability) {
    case "muster": v += 2.5; break; // usually pulls 2-3 more cards down with it
    case "medic": v += 2.5; break; // refills board + fills the hand's card advantage
    case "moraleBoost": v += 2; break;
    case "horn": v += 3; break; // doubles a whole row
    case "tightBond": v += 1.5; break;
    case "decoy": v += 1; break;
    case "scorchGlobal": case "scorchRow": case "scorchRowThreshold": v += 2; break;
    case "weather": v += 1.2; break;
    case "clearWeather": v += 0.3; break;
    case "spy": v -= 0.5; break; // gives opponent a body, though the 2-card draw offsets most of it
    default: break;
  }
  return v;
}

// Rough ranking of each faction's leaders from most to least reliably useful
// for a heuristic (non-lookahead) AI — favors leaders with an unconditional,
// always-good effect (extra horn, extra card, guaranteed medic) over
// situational ones (info reveals, narrow scorch thresholds).
const LEADER_PRIORITY = {
  monsters: ["L05", "L04", "L03", "L02", "L01"],
  nilfgaard: ["L07", "L10", "L09", "L06", "L08"],
  northern_realms: ["L14", "L12", "L11", "L15", "L13"],
  scoiatael: ["L16", "L20", "L17", "L18", "L19"],
  skellige: ["L21", "L22"],
};

// Special-card "families" used to cap how many near-duplicate effects the
// AI is allowed to stack in one deck — otherwise the flat top-N sort just
// grabs every weather/horn/scorch it can find and never touches a Decoy.
function specialFamily(card) {
  if (card.ability === "weather") return "weather";
  if (card.ability === "clearWeather") return "clearWeather";
  if (card.ability === "horn") return "horn";
  if (card.ability === "decoy") return "decoy";
  if (card.ability === "scorchGlobal" || card.ability === "scorchRow" || card.ability === "scorchRowThreshold") return "scorch";
  return "other";
}

function chooseAiDeck(aiFaction) {
  const pool = poolForFaction(aiFaction);
  const isUnit = (c) => c.cardType === "Basic" || c.cardType === "Hero";
  const scored = pool
    .map((c) => ({ card: c, value: evaluateCardBaseValue(c) + Math.random() * 1.5 })) // small jitter so it's not identical every game
    .sort((a, b) => b.value - a.value);

  // --- Units: draft per-row instead of one flat global sort, so the AI
  // can't end up with (for example) four Close Combat units and nothing
  // in Ranged or Siege. Agile units count toward whichever row is thinner
  // at the time they're picked. Split into roughly even row quotas, then
  // fill any leftover slots (Heroes, odd counts) with the next-best units
  // regardless of row.
  const unitPool = scored.filter((s) => isUnit(s.card));
  const baseQuota = Math.floor(DECK_SIZE / ROWS.length);
  const quota = { close: baseQuota, ranged: baseQuota, siege: baseQuota };
  let remainder = DECK_SIZE - baseQuota * ROWS.length;
  ROWS.forEach((r) => { if (remainder > 0) { quota[r] += 1; remainder--; } });

  const rowCount = { close: 0, ranged: 0, siege: 0 };
  const unitIds = [];
  const leftover = [];
  for (const s of unitPool) {
    const row = s.card.row;
    if (row === "agile") {
      // Slot into whichever of Close/Ranged still needs it more.
      const target = rowCount.close <= rowCount.ranged ? "close" : "ranged";
      if (rowCount[target] < quota[target]) { rowCount[target]++; unitIds.push(s.card.id); continue; }
    } else if (ROWS.includes(row)) {
      if (rowCount[row] < quota[row]) { rowCount[row]++; unitIds.push(s.card.id); continue; }
    }
    leftover.push(s.card.id);
  }
  // Any row that came up short (faction pool too thin in that row) gets
  // backfilled from the leftover pile, best-value first, until DECK_SIZE.
  let i = 0;
  while (unitIds.length < DECK_SIZE && i < leftover.length) { unitIds.push(leftover[i]); i++; }

  // --- Specials: cap per family so weather/horn/scorch can't crowd out
  // everything else, and guarantee at least one Decoy if the pool has one.
  const specialCandidates = scored.filter((s) => !isUnit(s.card));
  const FAMILY_CAP = { weather: 2, horn: 2, scorch: 2, decoy: 2, clearWeather: 1, other: 3 };
  const familyCount = {};
  const specialIds = [];
  for (const s of specialCandidates) {
    if (specialIds.length >= 6) break;
    const fam = specialFamily(s.card);
    const used = familyCount[fam] || 0;
    if (used >= (FAMILY_CAP[fam] ?? 2)) continue;
    familyCount[fam] = used + 1;
    specialIds.push(s.card.id);
  }
  // If nothing from the Decoy family made the cut but the pool has one,
  // swap it in for the weakest pick — Decoy is too useful to skip entirely.
  if (!(familyCount.decoy > 0)) {
    const decoyOption = specialCandidates.find((s) => specialFamily(s.card) === "decoy");
    if (decoyOption && specialIds.length >= 6) {
      specialIds[specialIds.length - 1] = decoyOption.card.id;
    } else if (decoyOption) {
      specialIds.push(decoyOption.card.id);
    }
  }

  const deckIds = [...unitIds, ...specialIds];

  const leaders = leadersForFaction(aiFaction);
  const priority = LEADER_PRIORITY[aiFaction] || leaders.map((l) => l.id);
  const topChoices = priority.filter((id) => leaders.some((l) => l.id === id)).slice(0, 2);
  const aiLeaderId = (topChoices.length ? topChoices[Math.floor(Math.random() * topChoices.length)] : leaders[0]?.id) || null;

  return { deckIds, aiLeaderId };
}

/* ---------------------------- SIMPLE HEURISTIC AI ------------------------ */

// Leaders whose effect is unconditionally useful even on an empty board /
// empty discard, so firing them turn 1 round 1 never wastes them: extra
// card draw, instant Horn, info reveal, denying the opponent their own
// leader, etc. Every other leader has a real precondition (needs weather
// on the board, a scorch-row total ≥10, a non-empty discard pile, an
// Agile unit already down, ...) that literally cannot be true on turn 1
// with an empty board — firing those unconditionally just burns the
// leader for a permanent no-op, so they're checked live instead below.
// L05/L07 fetch-and-play a weather card instantly — unlike L03's instant Horn
// (a standing multiplier that's genuinely fine to pre-commit turn 1, since it
// just buffs whatever gets played into that row later), firing these on a
// completely empty board freezes a row nothing is in yet. Self-play logs
// caught this twice (08-08-39, 08-03-38): "freezing both sides' Siege row to
// 1 power" as the literal opening move, before either side had a single Siege
// card down. It's not purely wasted (weather is a standing effect that will
// suppress future plays in that row too), but locking a row before either
// side has committed to it is a coin flip that can just as easily deny the
// AI's OWN plan as the opponent's — moved to leaderConditionMet so it fires
// once there's an actual, favorable target instead of blindly turn 1.
const LEADER_ALWAYS_GOOD_EARLY = new Set(["L03", "L04", "L06", "L10", "L11", "L14", "L16", "L18", "L20", "L22"]);

function leaderConditionMet(state, aiKey, leaderId) {
  const me = state.players[aiKey];
  const oppKey = otherKey(aiKey);
  const opp = state.players[oppKey];
  switch (leaderId) {
    case "L02": // Medic revive — needs an eligible (non-Hero, non-Special) card in own discard
      return me.discard.some((id) => { const c = cardById(id); return c && c.cardType !== "Hero" && c.cardType !== "Special" && c.row; });
    case "L09": // Take a non-Hero card from opponent's discard
      return opp.discard.some((id) => cardById(id)?.cardType !== "Hero");
    case "L12": // Clear Weather — needs weather actually present on either side
      return ROWS.some((r) => me.board.weather[r] || opp.board.weather[r]);
    case "L07": { // Fetch + play Torrential Rain (Siege) — wait for the opponent
      // to actually have Siege power worth freezing, and don't do it if we're
      // the one ahead in that row (we'd just be freezing our own lead).
      const spy = matchHasLeader(state, "L01");
      const oppSiege = rowTotal(opp.board, "siege", spy);
      const meSiege = rowTotal(me.board, "siege", spy);
      return oppSiege > 0 && oppSiege >= meSiege;
    }
    case "L05": { // Pick any weather — same idea, generalized: only worth
      // casting once the opponent has actually put real power somewhere.
      const spy = matchHasLeader(state, "L01");
      return boardTotal(opp.board, spy) >= 6;
    }
    case "L13": // Foltest — Scorch Ranged if total >= 10
      return rowTotal(opp.board, "ranged", matchHasLeader(state, "L01")) >= 10;
    case "L15": // Scorch Siege if total >= 10
      return rowTotal(opp.board, "siege", matchHasLeader(state, "L01")) >= 10;
    case "L19": // Francesca — Scorch Close Combat if total >= 10
      return rowTotal(opp.board, "close", matchHasLeader(state, "L01")) >= 10;
    case "L17": // Francesca — reposition Agile units, needs one on the board
      return [...me.board.close, ...me.board.ranged].some((id) => cardById(id)?.row === "agile");
    case "L21": // Crach an Craite — shuffle graveyards, needs at least one non-empty
      return me.discard.length > 0 || opp.discard.length > 0;
    default:
      return true;
  }
}

function computeAIAction(state, aiKey) {
  const me = state.players[aiKey];
  const oppKey = otherKey(aiKey);
  const opp = state.players[oppKey];
  const spyDoubled = matchHasLeader(state, "L01");

  // Fire the leader ability as soon as it can do something real: the
  // always-good leaders go off turn 1 like before, everything else waits
  // until its actual precondition is met (checked fresh every AI turn).
  if (me.leaderId && !me.leaderUsed && !me.leaderBlocked) {
    const isOpeningTurn = state.round === 1 && me.board.close.length === 0 && me.board.ranged.length === 0 && me.board.siege.length === 0;
    const shouldFire = LEADER_ALWAYS_GOOD_EARLY.has(me.leaderId) ? isOpeningTurn : leaderConditionMet(state, aiKey, me.leaderId);
    if (shouldFire) {
      const options = me.leaderId === "L04" ? { discardIds: [...me.hand].sort((a, b) => cardById(a).power - cardById(b).power).slice(0, 2) } : {};
      return { type: "USE_LEADER", player: aiKey, options };
    }
  }

  if (me.hand.length === 0 || me.passed) return { type: "PASS", player: aiKey };

  // Filter out cards the AI can't currently resolve (e.g. Decoy with no target),
  // and rank the rest by actual battlefield impact rather than raw power.
  const ranked = me.hand
    .map(cardById)
    .filter((c) => autoOptionsForCard(c, me.board, me.discard, me.deck) !== null)
    .map((c) => ({ card: c, impact: estimateCardImpact(c, me, opp, spyDoubled) }))
    .sort((a, b) => b.impact - a.impact);

  if (ranked.length === 0) return { type: "PASS", player: aiKey };

  const myTotal = boardTotal(me.board, spyDoubled);
  const oppTotal = boardTotal(opp.board, spyDoubled);

  const play = (card) => ({ type: "PLAY_CARD", player: aiKey, cardId: card.id, options: autoOptionsForCard(card, me.board, me.discard, me.deck) || {} });

  // Round-conceding strategy: a real Gwent player often lets a round go
  // rather than burning their whole hand to win it — especially once
  // already ahead in the match, or holding more cards than the opponent
  // (spending them here would throw away that advantage for rounds 2-3).
  // CRITICAL: never do this if the opponent already has 1 round win — losing
  // this round too would hand them the match immediately (2 wins = game over).
  const cardEdge = me.hand.length - opp.hand.length;
  const losingThisRound = myTotal < oppTotal;
  const winningThisRound = myTotal > oppTotal;
  const oppAtMatchPoint = state.roundWins[oppKey] >= 1;
  const margin = Math.abs(myTotal - oppTotal);

  // How many cards the AI has actually committed THIS round — proxy is the
  // board, since it's wiped between rounds. Concede/bank decisions require
  // a minimum commitment first: without this, the AI could (and did) decide
  // to give up a round on turn 1 with a full hand and nothing played yet,
  // purely off a fragile early card-count difference or a lead it didn't
  // even build itself (e.g. an opponent Spy landing on its board).
  const committed = me.board.close.length + me.board.ranged.length + me.board.siege.length + (me.board.specials?.length || 0);
  const minCommitmentMet = committed >= 2;

  // Round 1 while the match is still 0-0 is the classic round to sacrifice —
  // losing it costs nothing structurally (both sides still need 2 of 3
  // either way), so it shouldn't need the same hand-lead proof that rounds
  // 2+ require. Self-play logs showed the AI dumping its entire hand into a
  // losing round 1 game after game because cardEdge>=3 almost never happens
  // this early when both sides are trading cards roughly evenly — it only
  // banked when it had stockpiled a huge card lead, and just kept feeding
  // cards into an unwinnable round otherwise. A mild edge (>=1), or a big
  // enough board deficit that catching up would cost several more cards
  // anyway, is reason enough to let round 1 go.
  const roundOneIsFree = state.round === 1 && state.roundWins[aiKey] === 0 && state.roundWins[oppKey] === 0;

  const canAffordToConcede =
    losingThisRound &&
    minCommitmentMet &&
    state.round < 3 &&
    !oppAtMatchPoint &&
    (state.roundWins[aiKey] > state.roundWins[oppKey] ||
      cardEdge >= 3 ||
      (roundOneIsFree && (cardEdge >= 1 || margin >= 20)));

  if (opp.passed) {
    if (myTotal > oppTotal) return { type: "PASS", player: aiKey };
    // Being locked in a one-sided race doesn't mean fighting is free — a
    // hopeless, cheap-to-give-up round (round 1, tied 0-0, opponent way
    // ahead) is still worth banking cards instead of dumping the hand
    // chasing it, exactly like the normal concede logic below. Without this
    // check, this branch bypassed that logic entirely through a side door.
    if (canAffordToConcede) return { type: "PASS", player: aiKey };
    const need = oppTotal - myTotal;
    const enough = [...ranked].reverse().find((r) => r.impact >= need) || ranked[0];
    // Same guard the losing-and-still-contested branch below has: never
    // force through an actively harmful card just because the opponent
    // can't punish it back. If nothing helps, keep the card for next round.
    if (enough.impact < 0) return { type: "PASS", player: aiKey };
    return play(enough.card);
  }

  // Under match-point pressure, never gamble a random pass while ahead —
  // keep playing to protect the lead instead of risking the whole match.
  // CRITICAL: only bank when hand size is at least even with the opponent.
  // A lead is only safe to freeze if the opponent doesn't have more cards
  // left than us to simply keep playing and overtake it — this is especially
  // true when the "lead" was inflated by the opponent's own Spy cards
  // landing on our board, which costs them nothing to keep doing.
  const canAffordToBank = winningThisRound && minCommitmentMet && !oppAtMatchPoint && cardEdge >= 0;

  // Scale the roll by how real the lead/deficit actually is — a 2-point
  // margin barely moves the needle, a 20+ point margin is close to certain.
  // Without this, a tiny/illusory lead (or deficit) triggered the exact
  // same coinflip as a commanding one. BUT a big card-count edge is its own
  // form of conviction independent of the current point margin — being up
  // 5 cards while only down 1 point is still a great spot to bank, since
  // that hand advantage will crush rounds 2-3. Self-play logs showed the AI
  // stuck at ~4% pass chance in exactly this situation (huge card lead,
  // razor-thin point margin) and just kept dumping cards instead of banking
  // the lead it had already earned. Take the stronger of the two signals.
  const marginScale = Math.min(1, margin / 15);
  const cardEdgeScale = Math.min(1, Math.max(cardEdge, 0) / 3);
  const conviction = Math.max(marginScale, cardEdgeScale);

  // Single random decision per turn (was two independent coinflips before,
  // which could compound into erratic-looking play) — at most one of these
  // situations applies on any given turn anyway.
  const passChance = (canAffordToConcede ? 0.6 : canAffordToBank ? 0.55 : 0) * conviction;
  if (passChance > 0 && Math.random() < passChance) {
    return { type: "PASS", player: aiKey };
  }

  // Even while behind, never force through an actively harmful card (e.g. a
  // global Scorch that would torch our own strongest unit for a worse trade
  // than it costs the opponent). If the best-ranked option is still
  // negative, passing keeps the card for a later round instead of digging
  // the hole deeper for nothing.
  if (myTotal <= oppTotal) {
    if (ranked[0].impact >= 0) return play(ranked[0].card);
    return { type: "PASS", player: aiKey };
  }

  // Protecting a lead: dump the lowest-impact card, but never one with a
  // NEGATIVE impact (self-harming Scorch when the opponent's board is
  // empty, a weather that guts our own row worse than theirs, etc). A
  // negative score means "actively bad," not "safe filler" — if the worst
  // non-harmful option doesn't exist, passing is strictly better than
  // hurting ourselves for no reason.
  const safeDump = [...ranked].reverse().find((r) => r.impact >= 0);
  if (!safeDump) return { type: "PASS", player: aiKey };
  return play(safeDump.card);
}

/* ============================ UI PIECES ================================ */

const ABILITY_LABEL = {
  muster: "Muster", medic: "Medic", decoy: "Decoy", spy: "Spy",
  tightBond: "Tight Bond", moraleBoost: "Morale Boost", horn: "Horn",
  weather: "Weather", clearWeather: "Clear Weather", scorchGlobal: "Scorch",
  scorchRow: "Scorch", scorchRowThreshold: "Scorch", berserker: "Berserker",
  mardroeme: "Mardroeme", summonAvenger: "Summon Avenger",
};

const ABILITY_DESCRIPTIONS = {
  muster: "Muster: calls every kin card from your deck and hand onto the battlefield beside it, free of charge.",
  medic: "Medic: drags one fallen comrade from the graveyard back onto the battlefield, alive and fighting again.",
  decoy: "Decoy: swaps for one of your units, pulling it safely back to your hand to be replayed.",
  spy: "Spy: infiltrates the enemy ranks, fighting for them — but hands you 2 fresh cards in return.",
  tightBond: "Tight Bond: brothers-in-arms — power multiplies with every copy standing beside it in the row.",
  moraleBoost: "Morale Boost: a rousing warcry, granting +1 power to every other unit sharing its row.",
  horn: "Horn: doubles the total power of every unit standing in the row it sounds for.",
  weather: "Weather: a storm freezes the matching row on both sides, crushing units down to 1 power each.",
  clearWeather: "Clear Weather: breaks every storm at once, lifting all weather effects from the battlefield.",
  scorchGlobal: "Scorch: fire sweeps the whole battlefield, incinerating the strongest non-Hero unit(s) on either side.",
  scorchRow: "Scorch (Row): fire hits one enemy row, incinerating whichever non-Hero unit(s) stand strongest there.",
  scorchRowThreshold: "Scorch (Threshold): fire strikes an enemy row only once its power hits 10 — then burns the strongest.",
  berserker: "Berserker: a warrior teetering on the edge of rage, waiting for Mardroeme to unleash their true form.",
  mardroeme: "Mardroeme: ignites battle-rage, transforming every Berserker in the row into its towering Vildkaarl form.",
  summonAvenger: "Summon Avenger: sworn to vengeance — falling in battle or the round ending summons a stronger replacement.",
  unsummonable: "Unsummonable: never played by hand — only rises onto the battlefield as a Summon Avenger's replacement.",
};

function abilityDescriptionFor(card) {
  if (!card) return "";
  if (card.cardType === "Leader") return card.ability || "";
  const heroNote = card.cardType === "Hero" ? "Hero: immune to everything — weather, Horn, Morale, Bond, Medic, and Scorch all pass right through." : "";
  const abilityNote = card.ability && ABILITY_DESCRIPTIONS[card.ability] ? ABILITY_DESCRIPTIONS[card.ability] : "";
  if (heroNote && abilityNote) return heroNote + " " + abilityNote;
  if (heroNote) return heroNote;
  if (abilityNote) return abilityNote;
  return "A plain unit, valued purely on its printed power.";
}

function CardTile({ card, size = "md", onClick, disabled, selected, faded, justPlayed }) {
  const [artStage, setArtStage] = useState(0); // 0 = primary CDN, 1 = raw GitHub fallback, 2 = give up
  const [zoomed, setZoomed] = useState(false);
  const isHovered = useRef(false);
  const touchTimer = useRef(null);
  if (!card) return null;
  const fmeta = FACTION_META[card.faction] || FACTION_META.neutral;
  const rmeta = ROW_META[card.row];
  const isLeader = card.cardType === "Leader";
  const isSpecial = card.cardType === "Special";
  const src = artStage === 0 ? imgSrc(card, IMAGE_BASE_URL) : artStage === 1 ? imgSrc(card, IMAGE_FALLBACK_BASE_URL) : null;
  const abilityLabel = card.ability && ABILITY_LABEL[card.ability];
  const fitStyle = { "--accent": fmeta.color, "--row-accent": rmeta ? rmeta.color : fmeta.color };

  const clearTouchTimer = () => { if (touchTimer.current) { clearTimeout(touchTimer.current); touchTimer.current = null; } };
  // Desktop: hover over the card, then press "i" to zoom (no more waiting on a hover timer).
  const handleMouseEnter = () => { isHovered.current = true; };
  const handleMouseLeave = () => { isHovered.current = false; };
  // Touch devices have no keyboard, so keep a long-press as the equivalent trigger.
  const handleTouchStart = () => {
    clearTouchTimer();
    touchTimer.current = setTimeout(() => setZoomed(true), 500);
  };
  const handleTouchEnd = () => { clearTouchTimer(); };

  useEffect(() => {
    const onKeyDown = (e) => {
      if ((e.key === "i" || e.key === "I") && isHovered.current && !zoomed) {
        setZoomed(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [zoomed]);

  return (
    <>
      <button
        type="button"
        className={
          "card-tile card-" + size +
          (disabled ? " is-disabled" : "") +
          (selected ? " is-selected" : "") +
          (faded ? " is-faded" : "") +
          (justPlayed ? " card-just-played" : "") +
          (card.cardType === "Hero" ? " is-hero" : "") +
          (artStage === 2 ? " no-art" : "")
        }
        style={fitStyle}
        onClick={disabled ? undefined : onClick}
        aria-disabled={disabled || undefined}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {src ? (
          <img
            className="card-art"
            src={src}
            alt={card.name}
            decoding="async"
            loading="eager"
            onError={() => setArtStage((s) => s + 1)}
          />
        ) : null}
        {artStage === 2 && (
          <div className="card-tile-inner">
            {!isLeader && card.power != null && <span className="card-power">{card.power}</span>}
            {!isLeader && rmeta && <span className="card-row-tag">{rmeta.short}</span>}
            {isSpecial && !rmeta && <span className="card-row-tag">SPC</span>}
            <span className="card-name">{card.name}</span>
            <span className="card-faction">
              {fmeta.short}{isLeader ? " · LEADER" : ""}
              {abilityLabel ? " · " + abilityLabel : ""}
            </span>
          </div>
        )}
      </button>
      {zoomed && (
        <div className="card-zoom-overlay" onClick={(e) => { e.stopPropagation(); setZoomed(false); }}>
          <div className="card-zoom-content" onClick={(e) => e.stopPropagation()}>
            <div className="card-zoom-art-wrap">
              {src ? (
                <img className="card-zoom-art" src={src} alt={card.name} decoding="async" loading="eager" />
              ) : (
                <div className="card-zoom-fallback">{card.name}</div>
              )}
            </div>
            <div className="card-zoom-caption">
              <div className="card-zoom-title">
                {card.name}
                {card.power != null && !isLeader ? <span className="card-zoom-power">{card.power}</span> : null}
              </div>
              <div className="card-zoom-meta">
                {fmeta.short}{isLeader ? " · Leader" : ""}{rmeta ? " · " + rmeta.label : ""}{abilityLabel ? " · " + abilityLabel : ""}
              </div>
              <p className="card-zoom-desc">{abilityDescriptionFor(card)}</p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* All card sizing is now pure CSS (%-based), controlled directly in the
   stylesheet — .row-card-slot, .hand-card-slot, .card-back-wrap, and
   .card-tile.card-fit. No JS measurement, no ResizeObserver, no computed px. */

// Opponent's hand, shown as their faction's card back laid down face-down
// in front of them — like they've fanned their hand out on the table.
// Neutral cards drawn into that hand still show the OPPONENT's real
// faction back (there's no separate "neutral" back in the repo).
function CardBackStack({ count, faction }) {
  const [artStage, setArtStage] = useState(0);
  const src = artStage === 0 ? backImgSrc(faction, IMAGE_BASE_URL) : artStage === 1 ? backImgSrc(faction, IMAGE_FALLBACK_BASE_URL) : null;
  if (count <= 0) return <span className="hint">No cards left.</span>;
  // Pure CSS, height-driven — no JS measurement. The row's ancestor chain
  // resolves to a definite height via the table row, so each card-back-wrap
  // just sets height:100% and lets aspect-ratio derive width.
  return (
    <div className="card-back-row">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card-back-wrap" style={{ zIndex: i }}>
          {src ? (
            <img className="card-back-img" src={src} alt="Opponent card back" decoding="async" loading="eager" onError={() => setArtStage((s) => s + 1)} />
          ) : (
            <div className="card-back-fallback" />
          )}
        </div>
      ))}
    </div>
  );
}

// A small face-down stack representing the draw deck. Shows a count
// underneath, and disappears entirely once the deck is empty.
function DeckPile({ count, faction, hideCount }) {
  const [artStage, setArtStage] = useState(0);
  if (!count || count <= 0) return null;
  const src = artStage === 0 ? backImgSrc(faction, IMAGE_BASE_URL) : artStage === 1 ? backImgSrc(faction, IMAGE_FALLBACK_BASE_URL) : null;
  return (
    <div className="deck-pile">
      <div className="deck-pile-stack">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="deck-pile-card"
            style={{ transform: `translate(${i * 2}px, ${-i * 2}px)`, zIndex: i }}
          >
            {src ? (
              <img
                className="card-back-img"
                src={src}
                alt="Deck"
                decoding="async"
                loading="eager"
                onError={i === 0 ? () => setArtStage((s) => s + 1) : undefined}
              />
            ) : (
              <div className="card-back-fallback" />
            )}
          </div>
        ))}
      </div>
      {!hideCount && <span className="deck-pile-count">{count}</span>}
    </div>
  );
}

// Standalone deck-count number — used when "deck" and "deck count" are two
// separate grid cells (layout.xlsx splits them apart) instead of the count
// living inside the deck-pile stack itself.
function DeckCountCell({ count }) {
  if (!count || count <= 0) return null;
  return <span className="deck-count-standalone">{count}</span>;
}

// The most recently discarded card, shown face-up for the viewer's own
// discard pile (clickable to open the full DiscardPanel). Hidden entirely
// when the discard pile is empty.
function DiscardTopCard({ discard, onClick }) {
  if (!discard || discard.length === 0) return null;
  const topId = discard[discard.length - 1];
  return (
    <div className="discard-pile">
      <CardTile card={cardById(topId)} size="fit" onClick={onClick} disabled={!onClick} />
    </div>
  );
}

// Same idea, but for the opponent's discard — shown face-down since the
// viewer shouldn't get free info about exactly which card it is.
function DiscardTopBack({ discard, faction }) {
  const [artStage, setArtStage] = useState(0);
  if (!discard || discard.length === 0) return null;
  const src = artStage === 0 ? backImgSrc(faction, IMAGE_BASE_URL) : artStage === 1 ? backImgSrc(faction, IMAGE_FALLBACK_BASE_URL) : null;
  return (
    <div className="discard-pile discard-pile-back">
      {src ? (
        <img className="card-back-img" src={src} alt="Discarded card" decoding="async" loading="eager" onError={() => setArtStage((s) => s + 1)} />
      ) : (
        <div className="card-back-fallback" />
      )}
    </div>
  );
}

// Shown next to a leader card while that player's leader ability is still
// available; disappears the moment it's been used.
function LeaderUnusedBadge({ show }) {
  const [artStage, setArtStage] = useState(0);
  if (!show || artStage === 2) return null;
  const src = artStage === 0 ? LEADER_UNUSED_ICON_URL : LEADER_UNUSED_ICON_FALLBACK_URL;
  return <img className="leader-unused-badge" src={src} alt="Leader ability available" decoding="async" loading="eager" onError={() => setArtStage((s) => s + 1)} />;
}

// The board no longer groups siege/ranged/close into one PlayerBoard block —
// each row is split into three independently-positioned grid cells (label,
// horn/mardroeme markers, cards), matching layout.xlsx exactly. Weather is
// shown once centrally (WeatherCenterCell) since it now hits both sides'
// same row identically, so it isn't repeated per-row anymore.

// Background texture layer for a close-row/close-horn cell — sits behind
// the live RowCardsCell/RowHornCell content (via z-index) and is shrunk to
// leave a gap on the side facing the weather divider. Uses position:absolute
// + height:% rather than margin:%, since margin percentages resolve against
// the CONTAINING BLOCK'S WIDTH even for vertical margins (a real CSS quirk,
// not a bug) — height% correctly resolves against the td's height instead.
function RowBgFill({ src, anchor }) {
  return <div className={"row-bg-fill row-bg-fill-" + anchor} style={{ backgroundImage: src }} />;
}


function RowLabelCell({ board, rowKey, spyDoubled }) {
  const total = rowTotal(board, rowKey, spyDoubled);
  return (
    <div className="row-label">
      <span className="row-total">{total}</span>
    </div>
  );
}

// "Horn card" cell — shows the actual Commander's Horn card art (per row,
// per side) plus mardroeme markers. Dandelion doubles a row too, but since
// it's a normal row unit (not a special), it never lands in hornCards —
// its own card art already sits in the row itself, so this cell stays
// empty for it, exactly like the request specifies.
function RowHornCell({ board, rowKey }) {
  const hornCardIds = board.hornCards?.[rowKey] || [];
  const mardroemeCardIds = board.mardroemeCards?.[rowKey] || [];
  if (!hornCardIds.length && !mardroemeCardIds.length) return null;
  return (
    <div className="row-markers">
      {hornCardIds.map((id, i) => (
        <div key={"h-" + id + "-" + i} className="horn-card-slot">
          <CardTile card={cardById(id)} size="fit" />
        </div>
      ))}
      {mardroemeCardIds.map((id, i) => (
        <div key={"m-" + id + "-" + i} className="horn-card-slot mardroeme-card-slot">
          <CardTile card={cardById(id)} size="fit" />
        </div>
      ))}
    </div>
  );
}

// The row's actual cards (renamed from the old BoardRow's inline JSX).
function RowCardsCell({ board, rowKey, onClickCard, selectableIds, flashId }) {
  const meta = ROW_META[rowKey];
  const cardIds = board[rowKey];
  const weathered = !!board.weather[rowKey];
  return (
    <div className={"row-cards row-" + rowKey + (weathered ? " row-weathered" : "")} style={{ "--row-accent": meta.color }}>
      {cardIds.length === 0 && <span className="row-empty">no units</span>}
      {cardIds.length > 0 && cardIds.map((id) => (
        <div key={id} className="row-card-slot">
          <CardTile
            card={cardById(id)}
            size="fit"
            onClick={onClickCard ? () => onClickCard(id, rowKey) : undefined}
            disabled={selectableIds ? !selectableIds.includes(id) : !onClickCard}
            justPlayed={id === flashId}
          />
        </div>
      ))}
    </div>
  );
}

// Central "weather cards" cell — weather now hits both boards' same row
// identically, so this reads off either side's board.weather (they're kept
// in sync) instead of showing a per-side/per-row marker.
function WeatherCenterCell({ board }) {
  const rows = ["siege", "ranged", "close"];
  const activeCardIds = [...new Set(rows.filter((r) => board.weather[r] && board.weather[r].cardId).map((r) => board.weather[r].cardId))];
  // Skellige Storm is Fog + Rain combined (it weathers Ranged & Siege at once),
  // so show those two component cards instead of the storm card itself.
  const displayCardIds = [...new Set(activeCardIds.flatMap((cid) => {
    const c = cardById(cid);
    return c && c.name.startsWith("Skellige Storm") ? ["c063", "c074"] : [cid];
  }))];
  if (displayCardIds.length === 0) return <span className="hint weather-clear">Clear skies</span>;
  return (
    <div className="weather-center-list">
      {displayCardIds.map((cid) => (
        <div key={cid} className="weather-card-slot">
          <CardTile card={cardById(cid)} size="fit" />
        </div>
      ))}
    </div>
  );
}

// A single gem socket. `broken` is the settled state (socket art only, gem
// gone for good); `breaking` is true only for the brief window right after
// a loss, while breaking.gif plays over the socket.
function GemPip({ broken, breaking }) {
  const [backStage, setBackStage] = useState(0);
  const [frontStage, setFrontStage] = useState(0);
  const [breakStage, setBreakStage] = useState(0);
  const backSrc = backStage === 0 ? GEM_BACK_URL : GEM_BACK_FALLBACK_URL;
  const frontSrc = frontStage === 0 ? GEM_FRONT_URL : GEM_FRONT_FALLBACK_URL;
  const breakSrc = breakStage === 0 ? GEM_BREAK_URL : GEM_BREAK_FALLBACK_URL;
  return (
    <span className="gem-pip">
      <img className="gem-img gem-back" src={backSrc} alt="" decoding="async" loading="eager" onError={() => setBackStage(1)} />
      {!broken && !breaking && (
        <img className="gem-img gem-front" src={frontSrc} alt="" decoding="async" loading="eager" onError={() => setFrontStage(1)} />
      )}
      {breaking && (
        <img className="gem-img gem-crack" src={breakSrc} alt="" decoding="async" loading="eager" onError={() => setBreakStage(1)} />
      )}
    </span>
  );
}

// Two life gems for one player. `losses` is how many rounds this player has
// lost so far (0, 1, or 2) — the first loss breaks the left gem, the second
// breaks the right gem and ends the game. Tracks the previous loss count so
// only the gem that *just* broke plays the crack animation; anything broken
// from an earlier round (or from loading mid-game) shows the settled socket
// straightaway with no replay.
function GemPair({ losses }) {
  const prevLossesRef = useRef(losses);
  const [breakingIdx, setBreakingIdx] = useState(null);
  useEffect(() => {
    const prev = prevLossesRef.current;
    prevLossesRef.current = losses;
    if (losses > prev) {
      const idx = losses - 1;
      setBreakingIdx(idx);
      const t = setTimeout(() => setBreakingIdx((cur) => (cur === idx ? null : cur)), GEM_BREAK_ANIM_MS);
      return () => clearTimeout(t);
    }
  }, [losses]);
  return (
    <span className="gem-pair">
      {[0, 1].map((i) => (
        <GemPip key={i} broken={i < losses && breakingIdx !== i} breaking={breakingIdx === i} />
      ))}
    </span>
  );
}

function TopBar({ p1, p2, round, turnLabel }) {
  return (
    <div className="top-bar">
      <div className="tb-side">
        <span className="tb-name">{p1.name}</span>
        <GemPair losses={p1.losses} />
      </div>
      <div className="tb-center">
        <span className="tb-round">ROUND {round}</span>
        <span className="tb-turn">{turnLabel}</span>
      </div>
      <div className="tb-side tb-side-right">
        <GemPair losses={p2.losses} />
        <span className="tb-name">{p2.name}</span>
      </div>
    </div>
  );
}

function DiscardPanel({ cardIds, onClose }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="round-banner" onClick={(e) => e.stopPropagation()}>
        <div className="ribbon">YOUR DISCARD ({cardIds.length})</div>
        <div className="pool-grid">
          {cardIds.map((id, i) => <CardTile key={id + "-" + i} card={cardById(id)} size="sm" disabled />)}
          {cardIds.length === 0 && <span className="hint">Nothing here yet.</span>}
        </div>
        <button type="button" className="btn btn-gold" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function RoundBanner({ round, score, roundWinnerName, onContinue, isGameEnd, gameWinnerName, hideButton, isTie, viewerName }) {
  // Fires once per round-end banner shown (keyed on round number so it
  // doesn't replay on unrelated rerenders). Ties don't have a clear
  // winner/loser, so no round win/loss clip plays for them. Skipped
  // entirely when no viewerName is supplied (Hotseat — shared device,
  // no single "you" to judge the outcome against).
  const firedRef = useRef(null);
  useEffect(() => {
    if (!viewerName || isTie || isGameEnd || firedRef.current === round) return;
    firedRef.current = round;
    playSound(roundWinnerName === viewerName ? "wonRound" : "roundLoss");
  }, [round, isTie, isGameEnd, roundWinnerName, viewerName]);
  return (
    <div className="overlay overlay-clear">
      <div className="round-banner">
        <div className="ribbon">{isGameEnd ? "VICTORY" : "ROUND " + round + " COMPLETE"}</div>
        {score && (
          <div className="banner-score">
            <span>{score.p1}</span>
            <span className="vs">–</span>
            <span>{score.p2}</span>
          </div>
        )}
        <div className="banner-sub">
          {isGameEnd ? `${gameWinnerName} wins the game!` : isTie ? "It's a tie — both players score a point!" : roundWinnerName ? `${roundWinnerName} takes the round.` : "The round is a draw."}
        </div>
        {hideButton && <div className="hint">Next round starting…</div>}
        {!hideButton && <button type="button" className="btn btn-gold" onClick={onContinue}>{isGameEnd ? "See results" : "Continue"}</button>}
      </div>
    </div>
  );
}

// Online mode builds its game-over banner inline (see OnlineGame) rather
// than through GameOverPanel, so it gets this tiny sibling instead of
// duplicating GameOverPanel's fire-once sound logic inline there.
function OnlineGameOverSound({ iWon, isDraw }) {
  const firedRef = useRef(false);
  useEffect(() => {
    if (isDraw || firedRef.current) return;
    firedRef.current = true;
    playSound(iWon ? "wonGame" : "gameLoss");
  }, [iWon, isDraw]);
  return null;
}

function GameOverPanel({ state, onExit, onPlayAgain, gameLog, viewerRole }) {
  const winnerName = state.gameWinner === "draw" ? null : state.players[state.gameWinner].name;
  // Same fire-once pattern as RoundBanner. Draws don't have a clip; skipped
  // when viewerRole isn't supplied (Hotseat/Online-spectator-ish contexts
  // where "you" isn't well defined here yet).
  const firedRef = useRef(false);
  useEffect(() => {
    if (!viewerRole || state.gameWinner === "draw" || firedRef.current) return;
    firedRef.current = true;
    playSound(state.gameWinner === viewerRole ? "wonGame" : "gameLoss");
  }, [viewerRole, state.gameWinner]);

  function downloadLog() {
    const payload = {
      startedAt: gameLog?.startedAt || null,
      finishedAt: new Date().toISOString(),
      players: {
        p1: { name: state.players.p1.name, faction: state.players.p1.faction, leaderId: state.players.p1.leaderId },
        p2: { name: state.players.p2.name, faction: state.players.p2.faction, leaderId: state.players.p2.leaderId },
      },
      roundWins: state.roundWins,
      winner: state.gameWinner === "draw" ? "draw" : state.gameWinner,
      // Per-decision snapshots captured as the AI acted, for later review of its play.
      aiDecisions: (gameLog && gameLog.decisions) || [],
      // Full narrative event log shown in-game.
      eventLog: state.log,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `kwent-game-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="overlay overlay-clear">
      <div className="round-banner gameover">
        <div className="ribbon">GAME OVER</div>
        <div className="banner-sub big">
          {winnerName ? `${winnerName} wins ${state.roundWins.p1} – ${state.roundWins.p2}!` : `It's a draw, ${state.roundWins.p1} – ${state.roundWins.p2}!`}
        </div>
        <div style={{ display: "flex", gap: "10px", justifyContent: "center", flexWrap: "wrap" }}>
          {onPlayAgain && <button type="button" className="btn btn-gold" onClick={onPlayAgain}>Play again</button>}
          <button type="button" className="btn" onClick={onExit}>Back to menu</button>
          <button type="button" className="btn" onClick={downloadLog}>Download game log</button>
        </div>
      </div>
    </div>
  );
}

const ABILITY_FILTERS = [
  { key: "muster", label: "Muster", symbol: "\u2694" },
  { key: "medic", label: "Medic", symbol: "\u271A" },
  { key: "decoy", label: "Decoy", symbol: "\u21BB" },
  { key: "spy", label: "Spy", symbol: "\u2694\uFE0E" },
  { key: "tightBond", label: "Bond", symbol: "\u26D3" },
  { key: "moraleBoost", label: "Morale", symbol: "\u2605" },
  { key: "horn", label: "Horn", symbol: "\u{1F4EF}" },
  { key: "weather", label: "Weather", symbol: "\u2601" },
  { key: "clearWeather", label: "Clear Weather", symbol: "\u2600" },
  { key: "scorch", label: "Scorch", symbol: "\u{1F525}", match: ["scorchGlobal", "scorchRow", "scorchRowThreshold"] },
  { key: "berserker", label: "Berserker", symbol: "\u{1F43A}" },
  { key: "mardroeme", label: "Mardroeme", symbol: "\u26A1" },
  { key: "summonAvenger", label: "Avenger", symbol: "\u{1F6E1}" },
];
function cardMatchesAbilityFilter(card, filterKey) {
  if (!filterKey) return true;
  const group = ABILITY_FILTERS.find((f) => f.key === filterKey);
  if (!group) return true;
  return group.match ? group.match.includes(card.ability) : card.ability === filterKey;
}

function DeckBuilder({ playerLabel, faction, onFactionChange, lockFaction, selectedIds, onToggleCard, leaderId, onSelectLeader, onConfirm, busyLabel, onRandomize, savedDecks, onSaveDeck, onLoadDeck, onDeleteDeck, onBack }) {
  const [query, setQuery] = useState("");
  const [abilityFilter, setAbilityFilter] = useState(null);
  const [deckName, setDeckName] = useState("");
  const [selectedSavedDeck, setSelectedSavedDeck] = useState("");
  const pool = useMemo(() => poolForFaction(faction), [faction]);
  const availableFilterKeys = useMemo(() => new Set(pool.map((c) => c.ability).filter(Boolean)), [pool]);
  const activeFilters = useMemo(
    () => ABILITY_FILTERS.filter((f) => (f.match ? f.match.some((m) => availableFilterKeys.has(m)) : availableFilterKeys.has(f.key))),
    [availableFilterKeys]
  );
  const filtered = useMemo(
    () =>
      pool
        .filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
        .filter((c) => cardMatchesAbilityFilter(c, abilityFilter))
        .slice()
        .sort((a, b) => {
          const pa = a.power ?? 0, pb = b.power ?? 0;
          if (pa !== pb) return pb - pa;
          return (a.name || "").localeCompare(b.name || "");
        }),
    [pool, query, abilityFilter]
  );
  useEffect(() => { setAbilityFilter(null); }, [faction]);

  const leaders = useMemo(() => leadersForFaction(faction), [faction]);
  const count = selectedIds.length;
  const unitCount = useMemo(
    () => selectedIds.filter((id) => { const c = cardById(id); return c && (c.cardType === "Basic" || c.cardType === "Hero"); }).length,
    [selectedIds]
  );
  const needsLeader = leaders.length > 0;
  const canConfirm = unitCount >= DECK_SIZE && (!needsLeader || !!leaderId);

  return (
    <div className="screen deckbuilder">
      {onBack && <button type="button" className="btn btn-sm deckbuilder-back" onClick={onBack}>← Back</button>}
      <h2 className="screen-title">{playerLabel}: build your deck</h2>

      {!lockFaction && (
        <div className="faction-picker">
          {FACTIONS.map((f) => (
            <button
              key={f}
              type="button"
              className={"faction-pill" + (faction === f ? " active" : "")}
              style={{ "--accent": FACTION_META[f].color }}
              onClick={() => onFactionChange(f)}
            >
              {FACTION_META[f].label}
            </button>
          ))}
        </div>
      )}
      {lockFaction && <div className="faction-locked">Faction: <strong>{FACTION_META[faction].label}</strong></div>}

      <div className="leader-picker">
        <span className="section-label">Leader</span>
        {needsLeader ? (
          <div className="leader-row">
            {leaders.map((l) => (
              <CardTile key={l.id} card={l} size="md" selected={leaderId === l.id} onClick={() => onSelectLeader(l.id)} />
            ))}
          </div>
        ) : (
          <p className="hint">No leader cards are available for {FACTION_META[faction].label} yet — this faction will play without one.</p>
        )}
      </div>

      <div className="deck-count">
        Selected: <strong>{count}</strong> cards — <strong>{unitCount}</strong> / {DECK_SIZE} minimum unit cards
        {onRandomize && (
          <button type="button" className="btn btn-sm random-deck-btn" onClick={onRandomize}>
            🎲 Random deck
          </button>
        )}
      </div>

      {onSaveDeck && (
        <div className="saved-decks-row">
          <input
            className="search-input deck-name-input"
            placeholder="Deck name…"
            value={deckName}
            onChange={(e) => setDeckName(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-sm"
            disabled={!deckName.trim() || count < 1}
            onClick={() => { if (onSaveDeck(deckName)) setDeckName(""); }}
          >
            💾 Save deck
          </button>
          {savedDecks && savedDecks.length > 0 && (
            <>
              <select
                className="search-input saved-deck-select"
                value={selectedSavedDeck}
                onChange={(e) => setSelectedSavedDeck(e.target.value)}
              >
                <option value="">Load saved deck…</option>
                {savedDecks.map((d) => (
                  <option key={d.name} value={d.name}>
                    {d.name} ({FACTION_META[d.faction]?.label || d.faction})
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-sm"
                disabled={!selectedSavedDeck}
                onClick={() => onLoadDeck(selectedSavedDeck)}
              >
                Load
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={!selectedSavedDeck}
                onClick={() => { onDeleteDeck(selectedSavedDeck); setSelectedSavedDeck(""); }}
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}

      <input
        className="search-input"
        placeholder="Search cards…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="ability-filter-row">
        {activeFilters.map((f) => (
          <button
            key={f.key}
            type="button"
            title={f.label}
            aria-label={`Filter: ${f.label}`}
            className={"ability-filter-btn" + (abilityFilter === f.key ? " active" : "")}
            onClick={() => setAbilityFilter(abilityFilter === f.key ? null : f.key)}
          >
            <span className="ability-filter-symbol">{f.symbol}</span>
            <span className="ability-filter-label">{f.label}</span>
          </button>
        ))}
        {abilityFilter && (
          <button type="button" className="ability-filter-btn ability-filter-clear" onClick={() => setAbilityFilter(null)}>
            Clear
          </button>
        )}
      </div>

      <div className="pool-grid">
        {filtered.map((c) => (
          <CardTile
            key={c.id}
            card={c}
            size="sm"
            selected={selectedIds.includes(c.id)}
            onClick={() => onToggleCard(c.id)}
          />
        ))}
      </div>

      <div className="deckbuilder-footer">
        <button type="button" className="btn btn-gold btn-lg" disabled={!canConfirm} onClick={onConfirm}>
          {busyLabel || "Confirm deck"}
        </button>
        {!canConfirm && <span className="hint">Pick at least {DECK_SIZE} unit cards (weather, decoys, horns etc. don't count){needsLeader ? " and a leader" : ""}.</span>}
      </div>
    </div>
  );
}

function MulliganPanel({ playerLabel, hand, swapsUsed, onSwap, onDone, waitingLabel }) {
  // Plays once, right when the very first hand is dealt (mulligan only ever
  // happens at the start of Round 1 — see the single "phase: mulligan" site
  // in gameReducer — so "on mount, before any swaps" reliably means "the
  // opening hand"). Zero Heroes -> starting_with_basic (guarded to fire only
  // once for the whole game, no matter how many times this component
  // mounts). One or more Heroes -> getting_a_hero, once per Hero, same as
  // any other hero-gain moment.
  const firedRef = useRef(false);
  const prevHandRef = useRef(hand || []);
  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    const heroes = (hand || []).filter((id) => cardById(id)?.cardType === "Hero");
    if (heroes.length) heroes.forEach(() => playSound("gettingAHero"));
    else playStartingBasicOnce();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Subsequent hand changes are swap-drawn replacement cards — if a swap
  // draws a Hero, that's its own getting_a_hero moment too.
  useEffect(() => {
    if (!firedRef.current) return; // skip the run that coincides with the mount effect above
    const prev = prevHandRef.current;
    const newHeroes = (hand || []).filter((id) => !prev.includes(id) && cardById(id)?.cardType === "Hero");
    newHeroes.forEach(() => playSound("gettingAHero"));
    prevHandRef.current = hand || [];
  }, [hand]);
  const remaining = MAX_MULLIGAN - swapsUsed;
  const sortedHand = sortIdsByPower(hand);
  return (
    <div className="screen mulligan">
      <h2 className="screen-title">{playerLabel}: opening hand</h2>
      <p className="mulligan-hint">Tap up to {MAX_MULLIGAN} cards to swap them for random cards from your deck. Swaps left: <strong>{remaining}</strong></p>
      <div className="hand-grid">
        {sortedHand.map((id) => {
          const c = cardById(id);
          return (
            <CardTile
              key={id}
              card={c}
              size="md"
              disabled={remaining <= 0}
              onClick={() => remaining > 0 && onSwap(id)}
            />
          );
        })}
      </div>
      <div className="deckbuilder-footer">
        <button type="button" className="btn btn-gold btn-lg" onClick={onDone}>Ready</button>
        {waitingLabel && <span className="hint">{waitingLabel}</span>}
      </div>
    </div>
  );
}

/* Pre-game coin toss. One player calls heads/tails, then anyone flips the
   coin; whoever called it right chooses who opens Round 1. */
function CoinFlipPanel({ coinFlip, myKey, oppName, myName, isMyCallTurn, onCall, onFlip, onAck, singleDeviceLabel }) {
  const { caller, call, result, callerWon, starter, resolved } = coinFlip;

  if (!caller) {
    return (
      <div className="screen coinflip">
        <h2 className="screen-title">Coin toss</h2>
        <p className="mulligan-hint">{singleDeviceLabel || `${myName}, call it in the air.`}</p>
        <div className="coin-call-row">
          <button type="button" className="btn btn-gold btn-lg" onClick={() => onCall("heads")}>Heads</button>
          <button type="button" className="btn btn-gold btn-lg" onClick={() => onCall("tails")}>Tails</button>
        </div>
      </div>
    );
  }

  if (!resolved) {
    return (
      <div className="screen coinflip">
        <h2 className="screen-title">Coin toss</h2>
        <p className="mulligan-hint">{caller === myKey ? "You" : oppName} called <strong>{call}</strong>.</p>
        <div className={"coin" + (resolved ? " coin-landed" : "")} />
        {onFlip ? (
          <button type="button" className="btn btn-gold btn-lg" onClick={onFlip}>Flip the coin</button>
        ) : (
          <p className="hint">Waiting for {oppName} to flip…</p>
        )}
      </div>
    );
  }

  const starterIsMe = starter === myKey;

  return (
    <div className="screen coinflip">
      <h2 className="screen-title">Coin toss</h2>
      <p className="mulligan-hint">
        The coin landed on <strong>{result}</strong> — {caller === myKey ? "your" : `${oppName}'s`} call was {callerWon ? "right" : "wrong"}.
        {" "}{starterIsMe ? "You" : oppName} won the toss and will open Round 1.
      </p>
      {onAck ? (
        <button type="button" className="btn btn-gold btn-lg" onClick={onAck}>OK</button>
      ) : (
        <p className="hint">Waiting for {oppName}…</p>
      )}
    </div>
  );
}

function ScoiaChoicePanel({ chooserName, oppName, onChoose }) {
  return (
    <div className="screen coinflip">
      <h2 className="screen-title">Scoia'tael scouts</h2>
      <p className="mulligan-hint">{chooserName}'s Scoia'tael scouts have already sized up the field — no coin toss needed. Choose who opens Round 1.</p>
      <div className="coin-call-row">
        <button type="button" className="btn btn-gold btn-lg" onClick={() => onChoose("self")}>We'll start</button>
        <button type="button" className="btn btn-gold btn-lg" onClick={() => onChoose("opp")}>{oppName} starts</button>
      </div>
    </div>
  );
}

function PassDeviceGate({ name, onContinue }) {
  return (
    <div className="overlay pass-gate" onClick={onContinue}>
      <div className="round-banner">
        <div className="ribbon">PASS THE DEVICE</div>
        <div className="banner-sub big">to {name}</div>
        <button type="button" className="btn btn-gold" onClick={onContinue}>I'm {name} — reveal my hand</button>
      </div>
    </div>
  );
}

/* Full play board, shared by all three modes. Viewer sees their own hand
   face-up; the opponent's hand is shown as a card-back count only.
   Handles the small follow-up choices some abilities need (which row for
   an Agile unit / Commander's Horn / Mardroeme, which board card a Decoy
   swaps for, which discard-pile card a Medic revives) before dispatching
   the actual PLAY_CARD action with those options attached. */
const FORFEIT_HOLD_MS = 3000;

/* Press-and-hold forfeit button: has to be held for FORFEIT_HOLD_MS straight,
   with a visible fill so it's obvious the hold is registering (and can't be
   triggered by a stray click). Releasing early cancels and resets. */
function HoldToForfeitButton({ onForfeit, disabled }) {
  const [holding, setHolding] = useState(false);
  const [progress, setProgress] = useState(0); // 0-100
  const rafRef = useRef(null);
  const startRef = useRef(null);
  const doneRef = useRef(false);

  const stop = () => {
    setHolding(false);
    setProgress(0);
    doneRef.current = false;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  };

  const tick = () => {
    const elapsed = Date.now() - startRef.current;
    const pct = Math.min(100, (elapsed / FORFEIT_HOLD_MS) * 100);
    setProgress(pct);
    if (pct >= 100) {
      if (!doneRef.current) {
        doneRef.current = true;
        onForfeit && onForfeit();
      }
      stop();
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  };

  const start = (e) => {
    if (disabled) return;
    e.preventDefault();
    setHolding(true);
    startRef.current = Date.now();
    rafRef.current = requestAnimationFrame(tick);
  };

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  if (!onForfeit) return null;

  return (
    <button
      type="button"
      className={"btn btn-forfeit" + (holding ? " holding" : "")}
      disabled={disabled}
      style={{ "--forfeit-progress": progress + "%" }}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      title="Hold for 3 seconds to forfeit the game"
    >
      <span className="forfeit-fill" />
      <span className="forfeit-label">{holding ? "Hold to forfeit…" : "Forfeit"}</span>
    </button>
  );
}

function PlayBoard({
  state, viewerRole, opponentRole, viewerName, opponentName,
  isMyTurn, onPlayCard: onPlayCardRaw, onPass: onPassRaw, onForfeit, onUseLeader: onUseLeaderRaw, canAct: canActRaw, opponentThinking,
}) {
  const [showDiscard, setShowDiscard] = useState(false);
  const [pending, setPending] = useState(null);
  // Move pacing: don't let the next card/leader/pass action fire until
  // whatever sound is currently playing has actually finished — otherwise
  // rapid-fire plays cut each other's audio off mid-clip. Re-renders every
  // 150ms while something's playing purely so the "can I act yet" gate
  // (and any disabled-button styling that depends on canAct) stays current;
  // idle the rest of the time.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (soundGateRemainingMs() <= 0) return;
    const t = setInterval(() => {
      forceTick((n) => n + 1);
      if (soundGateRemainingMs() <= 0) clearInterval(t);
    }, 150);
    return () => clearInterval(t);
  });
  const soundGated = soundGateRemainingMs() > 0;
  const canAct = canActRaw && !soundGated;
  const onPlayCard = (...args) => { if (soundGateRemainingMs() > 0) return; onPlayCardRaw(...args); };
  const onUseLeader = (...args) => { if (soundGateRemainingMs() > 0) return; onUseLeaderRaw(...args); };
  const onPass = (...args) => { if (soundGateRemainingMs() > 0) return; onPassRaw(...args); };
  const me = state.players[viewerRole];
  const opp = state.players[opponentRole];
  const myLeader = cardById(me.leaderId);
  const oppLeader = cardById(opp.leaderId);
  const spyDoubled = matchHasLeader(state, "L01");
  const myTotal = boardTotal(me.board, spyDoubled);
  const oppTotal = boardTotal(opp.board, spyDoubled);

  // Track the most recently played card on each side so it can be flash-highlighted —
  // makes it obvious what the opponent (or AI) just did, since turns can otherwise fly by.
  const prevIdsRef = useRef({ me: null, opp: null });
  const [flash, setFlash] = useState({ me: null, opp: null });
  const flashTimers = useRef({});
  useEffect(() => {
    const curOppIds = [...opp.board.close, ...opp.board.ranged, ...opp.board.siege, ...opp.board.specials.map((s) => s.cardId)];
    const curMeIds = [...me.board.close, ...me.board.ranged, ...me.board.siege, ...me.board.specials.map((s) => s.cardId)];
    if (prevIdsRef.current.opp) {
      const newOppIds = curOppIds.filter((id) => !prevIdsRef.current.opp.includes(id));
      if (newOppIds.length) {
        setFlash((f) => ({ ...f, opp: newOppIds[0] }));
        clearTimeout(flashTimers.current.opp);
        flashTimers.current.opp = setTimeout(() => setFlash((f) => ({ ...f, opp: null })), 2200);
      }
    }
    if (prevIdsRef.current.me) {
      const newMeIds = curMeIds.filter((id) => !prevIdsRef.current.me.includes(id));
      if (newMeIds.length) {
        setFlash((f) => ({ ...f, me: newMeIds[0] }));
        clearTimeout(flashTimers.current.me);
        flashTimers.current.me = setTimeout(() => setFlash((f) => ({ ...f, me: null })), 2200);
      }
    }
    prevIdsRef.current = { opp: curOppIds, me: curMeIds };
  }, [opp.board, me.board]);
  useEffect(() => () => { clearTimeout(flashTimers.current.opp); clearTimeout(flashTimers.current.me); }, []);

  // --- Sound: card plays, weather, leader activation, round/game outcome ---
  // Kept as its own effect (separate from the flash-highlight one above) so
  // sound logic doesn't get tangled up with the flash-timer bookkeeping.
  // Uses the same "diff against previous state" approach: reliable across
  // hotseat/AI/online since it only reacts to state actually changing, and
  // naturally skips replays/rerenders that don't add anything new.
  const soundPrevRef = useRef(null);
  useEffect(() => {
    const snapshot = {
      meIds: [...me.board.close, ...me.board.ranged, ...me.board.siege, ...me.board.specials.map((s) => s.cardId)],
      oppIds: [...opp.board.close, ...opp.board.ranged, ...opp.board.siege, ...opp.board.specials.map((s) => s.cardId)],
      meHand: me.hand,
      oppHand: opp.hand,
      meWeather: me.board.weather,
      meLeaderUsed: me.leaderUsed,
      oppLeaderUsed: opp.leaderUsed,
      meLeaderId: me.leaderId,
      oppLeaderId: opp.leaderId,
    };
    const prev = soundPrevRef.current;
    if (prev) {
      // The whole block is wrapped, not just the per-id forEach above — ANY
      // throw in here (weather/leader detection included) must not be able
      // to skip the soundPrevRef.current write at the bottom of this effect,
      // for the same reason: a skipped write means next diff compares
      // against a stale snapshot and old, already-played cards can look
      // "new" again.
      try {
      // Newly played cards (on either side) — base sound + layered ability sound.
      const newMineIds = snapshot.meIds.filter((id) => !prev.meIds.includes(id));
      const newOppOnlyIds = snapshot.oppIds.filter((id) => !prev.oppIds.includes(id));
      // Note: a Spy card I play lands on the OPPONENT's board array, not mine
      // (that's the whole point of Spy) — so it's picked up here via
      // newOppOnlyIds, not newMineIds, and only ever appears in one of the
      // two lists, so there's no risk of it playing twice.
      // Wrapped per-id: one bad card must not be able to throw and abort the
      // rest of this effect — that would skip every sound after it in this
      // batch (a very plausible reason Spy could go silent) AND, worse,
      // prevent soundPrevRef.current from ever being updated at the bottom
      // of this effect, leaving the next diff comparing against a stale,
      // several-moves-old snapshot — which could make an old card look
      // "new" again and refire an unrelated sound entirely.
      newMineIds.forEach((id) => {
        try { playCardSounds(cardById(id), me.board, rowOfCardInBoard(me.board, id), newMineIds); }
        catch (e) { console.error("[kwent sound] playCardSounds failed for me id", id, e); }
      });
      newOppOnlyIds.forEach((id) => {
        try { playCardSounds(cardById(id), opp.board, rowOfCardInBoard(opp.board, id), newOppOnlyIds); }
        catch (e) { console.error("[kwent sound] playCardSounds failed for opp id", id, e); }
      });
      // Hero drawn into hand — mulligan swap, Spy's 2-card draw, a leader's
      // draw, an automatic per-faction draw (e.g. Northern Realms on a round
      // win), etc. All treated the same way regardless of *why* the hand
      // grew: any newly-present Hero id plays its own overlapping instance
      // of the sound, so several at once naturally get louder together. The
      // very first hand (before any swap) is intentionally NOT covered here —
      // MulliganPanel owns that moment on its own (see playStartingBasicOnce/
      // its own getting_a_hero check), so it isn't double counted against
      // this diff's baseline once PlayBoard first mounts.
      const newHeroesMine = snapshot.meHand.filter((id) => !prev.meHand.includes(id) && cardById(id)?.cardType === "Hero");
      const newHeroesOpp = snapshot.oppHand.filter((id) => !prev.oppHand.includes(id) && cardById(id)?.cardType === "Hero");
      [...newHeroesMine, ...newHeroesOpp].forEach(() => playSound("gettingAHero"));
      // Weather changing per row -> fog/frost/rain; all-clear -> clearWeather.
      // (Checked once — since a weather card is also caught by the play-sound
      // pass above via its own ability, we only need the *ability-less* board
      // paths here, e.g. a leader picking weather from deck with no card play.)
      ROWS.forEach((r) => {
        const before = prev.meWeather?.[r]?.cardId ?? null;
        const after = snapshot.meWeather?.[r]?.cardId ?? null;
        if (before !== after && after && newMineIds.includes(after) === false && newOppOnlyIds.includes(after) === false) {
          const key = weatherSoundKeyForRow(r);
          if (key) playSound(key);
        }
      });
      const wasClear = prev.meWeather && (prev.meWeather.close || prev.meWeather.ranged || prev.meWeather.siege);
      const isClear = !(snapshot.meWeather.close || snapshot.meWeather.ranged || snapshot.meWeather.siege);
      if (wasClear && isClear) playSound("clearWeather");
      // Leader activation — leaderUsed flipping false -> true.
      if (!prev.meLeaderUsed && snapshot.meLeaderUsed) playSound(snapshot.meLeaderId === "L21" ? "crachAnCraite" : "leader");
      if (!prev.oppLeaderUsed && snapshot.oppLeaderUsed) playSound(snapshot.oppLeaderId === "L21" ? "crachAnCraite" : "leader");
      } catch (e) {
        console.error("[kwent sound] sound-diff effect threw — snapshot still committed below", e);
      }
    }
    soundPrevRef.current = snapshot;
  }, [me.board, opp.board, me.hand, opp.hand, me.leaderUsed, opp.leaderUsed, me.leaderId, opp.leaderId]);

  const sortedHand = sortIdsByPower(me.hand);
  const sortedMyDiscard = sortIdsByPower(me.discard, { desc: true });

  // Computed unconditionally (not just while pending) so it can also gate
  // whether Decoy is playable from hand at all — Decoy needs at least one
  // of your own non-Hero row units on the board to swap with.
  const decoyTargets = ROWS.flatMap((r) => me.board[r].filter((id) => cardById(id)?.cardType !== "Hero" && cardById(id)?.row));

  const startPlay = (id) => {
    const card = cardById(id);
    if (card.row === "agile") return setPending({ kind: "agile", cardId: id });
    if (card.ability === "decoy") {
      if (!decoyTargets.length) return; // nothing on board to swap with — not playable
      return setPending({ kind: "decoy", cardId: id });
    }
    if (card.ability === "horn" && !card.row) return setPending({ kind: "horn", cardId: id });
    if (card.ability === "mardroeme" && !card.row) return setPending({ kind: "mardroeme", cardId: id });
    // Dandelion/Ermion have a fixed row and act as Horn/Mardroeme respectively — a row can't carry both.
    if (card.ability === "horn" && card.row && me.board.mardroeme[card.row]) return;
    if (card.ability === "mardroeme" && card.row && me.board.horns[card.row] > 0) return;
    if (card.ability === "medic" && !me.forceRandomRevive) {
      const eligible = me.discard.filter((did) => { const c = cardById(did); return c && c.cardType !== "Hero" && c.cardType !== "Special" && c.row; });
      if (eligible.length) return setPending({ kind: "medic", cardId: id, eligible });
    }
    onPlayCard(id, {});
  };

  const confirmRow = (row) => { onPlayCard(pending.cardId, { chosenRow: row }); setPending(null); };
  const confirmDecoy = (targetId) => { onPlayCard(pending.cardId, { targetId }); setPending(null); };
  const confirmMedic = (reviveId) => { onPlayCard(pending.cardId, { reviveId }); setPending(null); };

  const startLeader = () => {
    if (me.leaderId === "L04") return setPending({ kind: "leaderDiscard2", selected: [] });
    if (me.leaderId === "L09" && opp.discard.some((id) => cardById(id)?.cardType !== "Hero")) return setPending({ kind: "leaderPickDiscard" });
    if (me.leaderId === "L05") {
      const seen = new Set();
      const options = [];
      me.deck.forEach((id) => {
        const c = cardById(id);
        if (c && c.ability === "weather") {
          const key = c.name.replace(/\s*\(\d+\)$/, "");
          if (!seen.has(key)) { seen.add(key); options.push(id); }
        }
      });
      if (options.length) return setPending({ kind: "leaderPickWeather", options });
    }
    onUseLeader({});
  };
  const toggleDiscardPick = (id) => {
    setPending((p) => {
      const already = p.selected.includes(id);
      const selected = already ? p.selected.filter((x) => x !== id) : p.selected.length < 2 ? [...p.selected, id] : p.selected;
      return { ...p, selected };
    });
  };
  const confirmLeaderDiscard = () => { onUseLeader({ discardIds: pending.selected }); setPending(null); };
  const confirmLeaderPick = (pickId) => { onUseLeader({ pickId }); setPending(null); };
  const confirmLeaderPickWeather = (weatherId) => { onUseLeader({ weatherId }); setPending(null); };

  const myLeaderDisabled = !canAct || me.leaderUsed || me.leaderBlocked;

  // While Decoy is pending, clicking anywhere that isn't a valid target
  // cancels it — same "click away to back out" behavior as the other
  // pending choices (agile row / horn / mardroeme / medic), which use a
  // dedicated overlay. Decoy's targets are live board cards rather than
  // modal buttons, so instead this listens on the whole screen and relies
  // on valid-target clicks already calling confirmDecoy (harmless if this
  // also fires afterward, since cancelling an already-cleared pending is a no-op).
  const cancelDecoyOnStrayClick = () => { if (pending?.kind === "decoy") setPending(null); };

  return (
    <>
      <div className="screen play-board" onClick={cancelDecoyOnStrayClick}>
      <div className="board-frame">
        <div className="hand-strip-cards opp-hand-strip" style={{ position: "absolute" }}>
          <CardBackStack count={opp.hand.length} faction={opp.faction} />
        </div>
        <table className="board-table">
          <colgroup>
            <col style={{ width: "10%" }} />
            <col style={{ width: "6%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "4%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "4%" }} />
            <col style={{ width: "150%" }} />
            <col style={{ width: "20%" }} />
          </colgroup>
          <tbody>
            {/* Row 1: 3 empty (col1-3), opp hand cell now empty — hand-strip-cards
                moved out of the table to an absolutely-positioned sibling of
                .board-frame (rendered before <table>) so it no longer occupies
                table flow / rowspan. Safari/Mac-only: this row is dropped
                entirely (confirmed fix for the whole board sitting low on
                Mac) since table-layout:fixed locks all rows to equal height,
                so shrinking it via CSS has no effect there — removing it is
                the only lever. Left in place elsewhere to avoid re-testing
                row-to-background-texture alignment on other browsers. */}
            {!IS_SAFARI && (
              <tr>
                <td colSpan={3}></td>
                <td></td>
              </tr>
            )}

            {/* Row 2: opp pass status (col1-3); col4-8 no longer covered by a rowspan */}
            <tr>
              <td colSpan={3} className="cell-opp-pass-status">
                {opp.passed && <div className="passed-banner">Passed</div>}
                {!opp.passed && opponentThinking && <div className="passed-banner thinking-banner">{opponentName} is thinking…</div>}
                {flash.opp && <div className="last-played-toast">{opponentName} played {cardById(flash.opp)?.name}</div>}
              </td>
            </tr>

            {/* Row 3: leader (rowspan3, shifted to col1), siege label/horn/row, blank filler */}
            <tr>
              <td rowSpan={3} className="cell-opp-leader"><CardTile card={oppLeader} size="xs" disabled /></td>
              <td></td>
              <td></td>
              <td rowSpan={2} className="cell-opp-siege-label"><RowLabelCell board={opp.board} rowKey="siege" spyDoubled={spyDoubled} /></td>
              <td colSpan={2} rowSpan={2} className="cell-opp-siege-horn"><RowHornCell board={opp.board} rowKey="siege" /></td>
              <td rowSpan={2} className="cell-opp-siege-row"><RowCardsCell board={opp.board} rowKey="siege" flashId={flash.opp} /></td>
              <td></td>
            </tr>

            {/* Row 4: leader badge (shifted to col2), opp discard (rowspan2) */}
            <tr>
              <td className="cell-opp-leader-badge"><LeaderUnusedBadge show={!!oppLeader && !opp.leaderUsed} /></td>
              <td></td>
              <td rowSpan={2} className="cell-opp-discard"><DiscardTopBack discard={opp.discard} faction={opp.faction} /></td>
            </tr>

            {/* Row 5: leader (last row, blank), ranged label/horn/row */}
            <tr>
              <td></td>
              <td></td>
              <td rowSpan={2} className="cell-opp-ranged-label"><RowLabelCell board={opp.board} rowKey="ranged" spyDoubled={spyDoubled} /></td>
              <td rowSpan={2} colSpan={2} className="cell-opp-ranged-horn"><RowHornCell board={opp.board} rowKey="ranged" /></td>
              <td rowSpan={2} className="cell-opp-ranged-row"><RowCardsCell board={opp.board} rowKey="ranged" flashId={flash.opp} /></td>
            </tr>

            {/* Row 6: name, score, deck */}
            <tr>
              <td rowSpan={2} colSpan={2} className="cell-opp-name">
                <span className="side-name">{opponentName}</span>
                <GemPair losses={state.roundWins[viewerRole]} />
              </td>
              <td rowSpan={2} className="cell-opp-score"><span className="score-badge score-opp"><span className={oppTotal > myTotal ? "score-leading" : ""}>{oppTotal}</span></span></td>
              <td rowSpan={2} className="cell-opp-deck"><DeckPile count={opp.deck.length} faction={opp.faction} hideCount /></td>
            </tr>

            {/* Row 7: close label/horn/row */}
            <tr>
              <td rowSpan={2} className="cell-opp-close-label"><RowLabelCell board={opp.board} rowKey="close" spyDoubled={spyDoubled} /></td>
              <td rowSpan={2} colSpan={2} className="cell-opp-close-horn">
                <RowBgFill src={boardImg("opp close horn")} anchor="top" />
                <RowHornCell board={opp.board} rowKey="close" />
              </td>
              <td rowSpan={2} className="cell-opp-close-row">
                <RowBgFill src={boardImg("opp close")} anchor="top" />
                <RowCardsCell board={opp.board} rowKey="close" flashId={flash.opp} />
              </td>
            </tr>

            {/* Row 8: opp deck count (weather now rendered as an overlay outside the table, see below) */}
            <tr>
              <td></td><td></td><td></td>
              <td className="cell-opp-deck-count"><DeckCountCell count={opp.deck.length} /></td>
            </tr>

            {/* Row 9: my close label/horn/row, 3 leading + 1 trailing blank filler */}
            <tr>
              <td></td><td></td><td></td>
              <td rowSpan={2} className="cell-my-close-label"><RowLabelCell board={me.board} rowKey="close" spyDoubled={spyDoubled} /></td>
              <td rowSpan={2} colSpan={2} className="cell-my-close-horn">
                <RowBgFill src={boardImg("my close horn")} anchor="bottom" />
                <RowHornCell board={me.board} rowKey="close" />
              </td>
              <td rowSpan={2} className="cell-my-close-row">
                <RowBgFill src={boardImg("my close")} anchor="bottom" />
                <RowCardsCell
                  board={me.board}
                  rowKey="close"
                  onClickCard={pending?.kind === "decoy" ? (id) => decoyTargets.includes(id) && confirmDecoy(id) : undefined}
                  selectableIds={pending?.kind === "decoy" ? decoyTargets : undefined}
                  flashId={flash.me}
                />
              </td>
              <td></td>
            </tr>

            {/* Row 10: my name, score, my deck (moved up one row) */}
            <tr>
              <td rowSpan={2} colSpan={2} className="cell-my-name">
                <span className="side-name">{viewerName}</span>
                <GemPair losses={state.roundWins[opponentRole]} />
              </td>
              <td rowSpan={2} className="cell-my-score"><span className="score-badge score-me"><span className={myTotal > oppTotal ? "score-leading" : ""}>{myTotal}</span></span></td>
              <td rowSpan={2} className="cell-my-deck"><DeckPile count={me.deck.length} faction={me.faction} hideCount /></td>
            </tr>

            {/* Row 11: my ranged label/horn/row, blank filler */}
            <tr>
              <td rowSpan={2} className="cell-my-ranged-label"><RowLabelCell board={me.board} rowKey="ranged" spyDoubled={spyDoubled} /></td>
              <td rowSpan={2} colSpan={2} className="cell-my-ranged-horn"><RowHornCell board={me.board} rowKey="ranged" /></td>
              <td rowSpan={2} className="cell-my-ranged-row">
                <RowCardsCell
                  board={me.board}
                  rowKey="ranged"
                  onClickCard={pending?.kind === "decoy" ? (id) => decoyTargets.includes(id) && confirmDecoy(id) : undefined}
                  selectableIds={pending?.kind === "decoy" ? decoyTargets : undefined}
                  flashId={flash.me}
                />
              </td>
              <td></td>
            </tr>

            {/* Row 12: my leader (rowspan3, shifted to col1) starts, my deck count (moved up one row) */}
            <tr>
              <td rowSpan={3} className="cell-my-leader"><CardTile card={myLeader} size="xs" onClick={startLeader} disabled={myLeaderDisabled} /></td>
              <td></td>
              <td></td>
              <td className="cell-my-deck-count"><DeckCountCell count={me.deck.length} /></td>
            </tr>

            {/* Row 13: my leader badge (shifted to col2), siege label/horn/row, my discard (moved up one row) */}
            <tr>
              <td className="cell-my-leader-badge"><LeaderUnusedBadge show={!!myLeader && !me.leaderUsed} /></td>
              <td></td>
              <td rowSpan={2} className="cell-my-siege-label"><RowLabelCell board={me.board} rowKey="siege" spyDoubled={spyDoubled} /></td>
              <td rowSpan={2} colSpan={2} className="cell-my-siege-horn"><RowHornCell board={me.board} rowKey="siege" /></td>
              <td rowSpan={2} className="cell-my-siege-row">
                <RowCardsCell
                  board={me.board}
                  rowKey="siege"
                  onClickCard={pending?.kind === "decoy" ? (id) => decoyTargets.includes(id) && confirmDecoy(id) : undefined}
                  selectableIds={pending?.kind === "decoy" ? decoyTargets : undefined}
                  flashId={flash.me}
                />
              </td>
              <td rowSpan={2} className="cell-my-discard"><DiscardTopCard discard={me.discard} onClick={() => setShowDiscard(true)} /></td>
            </tr>

            {/* Row 14: my leader (last row, blank) */}
            <tr>
              <td></td>
              <td></td>
              <td></td>
            </tr>

            {/* Row 15: spacer row */}
            <tr>
              <td></td><td></td><td></td><td></td><td></td><td></td>
            </tr>

            {/* Row 16: pass button, positioned via inline style */}
            <tr>
              <td colSpan={3} className="cell-pass-button" style={{ overflow: "visible", margin: "-37.5% 0 0 115%" }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "6px" }}>
                  <button type="button" className="btn btn-pass" disabled={!canAct || me.passed} onClick={onPass}>
                    {me.passed ? "You passed" : "Pass"}
                  </button>
                  <HoldToForfeitButton onForfeit={onForfeit} disabled={false} />
                </div>
              </td>
            </tr>
          </tbody>
        </table>

        {/* Weather is now an absolutely-positioned overlay on .board-frame
            instead of a table cell, so it isn't constrained by the table's
            colspan/rowspan grid occupancy. */}
        <div className="weather-overlay"><WeatherCenterCell board={me.board} /></div>

        {/* My hand is rendered outside the table (sibling of .board-table)
            instead of inside a table cell. */}
        <div className="hand-strip-cards">
          {me.hand.length === 0 ? (
            <span className="hint">No cards left.</span>
          ) : (
            <div
              className="hand-fit"
              style={(() => {
                const slotWidthPct = 9;   // must match .hand-card-slot width
                const baseMarginPct = -1; // default overlap (matches old fixed value)
                const n = sortedHand.length;
                let overlapPct = baseMarginPct;
                if (n > 1) {
                  const naturalTotal = slotWidthPct * n + baseMarginPct * (n - 1);
                  if (naturalTotal > 100) {
                    overlapPct = (100 - slotWidthPct * n) / (n - 1);
                  }
                }
                return { "--hand-overlap": `${overlapPct}%` };
              })()}
            >
              {sortedHand.map((id) => (
                <div key={id} className="hand-card-slot">
                  <CardTile
                    card={cardById(id)}
                    size="fit"
                    disabled={!canAct || !isMyTurn || me.passed || !!pending || (cardById(id)?.ability === "decoy" && !decoyTargets.length)}
                    onClick={() => startPlay(id)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>



      {pending && (pending.kind === "agile" || pending.kind === "horn" || pending.kind === "mardroeme") && (
        <div className="overlay" onClick={() => setPending(null)}>
          <div className="round-banner" onClick={(e) => e.stopPropagation()}>
            <div className="ribbon">CHOOSE A ROW</div>
            <div className="coin-call-row">
              {(pending.kind === "agile" ? ["close", "ranged"] : ROWS).map((r) => {
                const blocked =
                  (pending.kind === "horn" && me.board.mardroeme[r]) ||
                  (pending.kind === "mardroeme" && me.board.horns[r] > 0);
                return (
                  <button
                    key={r}
                    type="button"
                    className="btn btn-gold"
                    disabled={blocked}
                    title={blocked ? "A row can only carry one of Horn / Mardroeme at a time" : undefined}
                    onClick={() => !blocked && confirmRow(r)}
                  >
                    {ROW_META[r].label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {pending?.kind === "decoy" && (
        <div className="hint pending-hint">Pick one of your own units on the board to swap with Decoy. Click anywhere else to cancel.</div>
      )}

      {pending?.kind === "medic" && (
        <div className="overlay" onClick={() => setPending(null)}>
          <div className="round-banner" onClick={(e) => e.stopPropagation()}>
            <div className="ribbon">MEDIC — REVIVE A CARD</div>
            <div className="pool-grid">
              {pending.eligible.map((id) => (
                <CardTile key={id} card={cardById(id)} size="sm" onClick={() => confirmMedic(id)} />
              ))}
            </div>
          </div>
        </div>
      )}

      {pending?.kind === "leaderDiscard2" && (
        <div className="overlay" onClick={() => setPending(null)}>
          <div className="round-banner" onClick={(e) => e.stopPropagation()}>
            <div className="ribbon">DISCARD 2, DRAW 1</div>
            <div className="pool-grid">
              {me.hand.map((id) => (
                <CardTile key={id} card={cardById(id)} size="sm" selected={pending.selected.includes(id)} onClick={() => toggleDiscardPick(id)} />
              ))}
            </div>
            <button type="button" className="btn btn-gold" disabled={pending.selected.length !== 2} onClick={confirmLeaderDiscard}>Confirm</button>
          </div>
        </div>
      )}

      {pending?.kind === "leaderPickDiscard" && (
        <div className="overlay" onClick={() => setPending(null)}>
          <div className="round-banner" onClick={(e) => e.stopPropagation()}>
            <div className="ribbon">CHOOSE A CARD TO TAKE &amp; PLAY</div>
            <div className="pool-grid">
              {opp.discard.filter((id) => cardById(id)?.cardType !== "Hero").map((id) => (
                <CardTile key={id} card={cardById(id)} size="sm" onClick={() => confirmLeaderPick(id)} />
              ))}
            </div>
          </div>
        </div>
      )}

      {pending?.kind === "leaderPickWeather" && (
        <div className="overlay" onClick={() => setPending(null)}>
          <div className="round-banner" onClick={(e) => e.stopPropagation()}>
            <div className="ribbon">CHOOSE A WEATHER CARD</div>
            <div className="pool-grid">
              {pending.options.map((id) => (
                <CardTile key={id} card={cardById(id)} size="sm" onClick={() => confirmLeaderPickWeather(id)} />
              ))}
            </div>
          </div>
        </div>
      )}

      {me.leaderReveal && (
        <div className="overlay" onClick={() => onUseLeader({ ackReveal: true })}>
          <div className="round-banner" onClick={(e) => e.stopPropagation()}>
            <div className="ribbon">CARDS REVEALED</div>
            <div className="pool-grid">
              {me.leaderReveal.map((id) => <CardTile key={id} card={cardById(id)} size="sm" disabled />)}
            </div>
            <button type="button" className="btn btn-gold" onClick={() => onUseLeader({ ackReveal: true })}>Close</button>
          </div>
        </div>
      )}

      {showDiscard && <DiscardPanel cardIds={sortedMyDiscard} onClose={() => setShowDiscard(false)} />}
      </div>
    </>
  );
}

/* ============================== HOME =================================== */

function Home({ onSelect, onlineAvailable }) {
  return (
    <div className="screen home">
      <div className="home-hero">
        <span className="eyebrow">A CARD GAME PROTOTYPE</span>
        <h1>Kwent</h1>
        <p>Build a 22-card deck, choose a leader, call the coin toss, and win two rounds of power before your opponent.</p>
      </div>
      <div className="mode-grid">
        <button type="button" className="mode-card" onClick={() => onSelect("hotseat")}>
          <span className="mode-title">Hotseat</span>
          <span className="mode-desc">Two players, one device. Pass it back and forth each turn.</span>
        </button>
        <button type="button" className="mode-card" onClick={() => onSelect("ai")}>
          <span className="mode-title">Vs. AI</span>
          <span className="mode-desc">Play solo against a simple computer opponent.</span>
        </button>
        <button
          type="button"
          className={"mode-card" + (onlineAvailable ? "" : " is-disabled")}
          onClick={() => onlineAvailable && onSelect("online")}
          disabled={!onlineAvailable}
        >
          <span className="mode-title">Online</span>
          <span className="mode-desc">
            {onlineAvailable ? "Host or join a room and play from two devices." : "Requires artifact storage — unavailable here."}
          </span>
        </button>
      </div>
      <p className="home-note">v3: real power values, sections and abilities for all 236 units + 22 leaders, per-faction automatic abilities, and a pre-game coin toss (or Scoia'tael's own call).</p>
    </div>
  );
}

/* ============================ HOTSEAT MODE ============================= */

function randomDeckIds(faction) {
  const pool = poolForFaction(faction);
  const isUnit = (c) => c.cardType === "Basic" || c.cardType === "Hero";
  const units = pool.filter(isUnit).sort(() => Math.random() - 0.5).slice(0, DECK_SIZE);
  const specials = pool.filter((c) => !isUnit(c)).sort(() => Math.random() - 0.5).slice(0, 6);
  return [...units, ...specials].map((c) => c.id);
}

function randomLeaderId(faction) {
  const leaders = leadersForFaction(faction);
  if (!leaders.length) return null;
  return leaders[Math.floor(Math.random() * leaders.length)].id;
}

function useDeckBuilderState() {
  const [faction, setFaction] = useState(FACTIONS[0]);
  const [selected, setSelected] = useState([]);
  const [leaderId, setLeaderId] = useState(null);
  const [savedDecks, setSavedDecks] = useState(() => loadSavedDecks());
  function toggle(id) {
    setSelected((sel) => sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
  }
  function changeFaction(f) {
    setFaction(f);
    setSelected([]);
    setLeaderId(null);
  }
  function randomize() {
    setSelected(randomDeckIds(faction));
    setLeaderId(randomLeaderId(faction));
  }
  // Saves (or overwrites, if the name matches an existing save) the current
  // faction/leader/card selection to localStorage. Returns true on success
  // so the caller can e.g. clear a name input.
  function saveDeck(name) {
    const trimmed = (name || "").trim();
    if (!trimmed) return false;
    const entry = { name: trimmed, faction, leaderId, deckIds: selected, savedAt: Date.now() };
    const next = [...savedDecks.filter((d) => d.name !== trimmed), entry];
    setSavedDecks(next);
    persistSavedDecks(next);
    return true;
  }
  function loadDeck(name) {
    const found = savedDecks.find((d) => d.name === name);
    if (!found) return;
    setFaction(found.faction);
    setSelected(found.deckIds);
    setLeaderId(found.leaderId);
  }
  function deleteDeck(name) {
    const next = savedDecks.filter((d) => d.name !== name);
    setSavedDecks(next);
    persistSavedDecks(next);
  }
  return {
    faction, setFaction: changeFaction, selected, toggle, leaderId, setLeaderId, randomize,
    savedDecks, saveDeck, loadDeck, deleteDeck,
  };
}

function HotseatGame({ onExit }) {
  const [step, setStep] = useState("deck1"); // deck1, gateTo2, deck2, game
  const [p1Config, setP1Config] = useState(null);
  const [state, setState] = useState(null);
  const [revealedTurn, setRevealedTurn] = useState(null);
  const [revealedMulligan, setRevealedMulligan] = useState("p1");
  const [coinGate, setCoinGate] = useState(null); // tracks which player currently has the device during coin-flip setup

  const builder1 = useDeckBuilderState();
  const builder2 = useDeckBuilderState();

  function confirmP1() {
    setP1Config({ name: "Player 1", faction: builder1.faction, leaderId: builder1.leaderId, deckIds: builder1.selected, isAI: false });
    setStep("gateTo2");
  }
  function confirmP2() {
    const cfg = { name: "Player 2", faction: builder2.faction, leaderId: builder2.leaderId, deckIds: builder2.selected, isAI: false };
    const initial = initGame(p1Config, cfg);
    setState(initial);
    setStep("game");
  }

  if (step === "deck1") {
    return <DeckBuilder playerLabel="Player 1" faction={builder1.faction} onFactionChange={builder1.setFaction}
      lockFaction={false} selectedIds={builder1.selected} onToggleCard={builder1.toggle}
      leaderId={builder1.leaderId} onSelectLeader={builder1.setLeaderId} onConfirm={confirmP1} onRandomize={builder1.randomize}
      savedDecks={builder1.savedDecks} onSaveDeck={builder1.saveDeck} onLoadDeck={builder1.loadDeck} onDeleteDeck={builder1.deleteDeck}
      onBack={onExit} />;
  }
  if (step === "gateTo2") {
    return <PassDeviceGate name="Player 2" onContinue={() => setStep("deck2")} />;
  }
  if (step === "deck2") {
    return <DeckBuilder playerLabel="Player 2" faction={builder2.faction} onFactionChange={builder2.setFaction}
      lockFaction={false} selectedIds={builder2.selected} onToggleCard={builder2.toggle}
      leaderId={builder2.leaderId} onSelectLeader={builder2.setLeaderId} onConfirm={confirmP2} onRandomize={builder2.randomize}
      savedDecks={builder2.savedDecks} onSaveDeck={builder2.saveDeck} onLoadDeck={builder2.loadDeck} onDeleteDeck={builder2.deleteDeck}
      onBack={() => setStep("deck1")} />;
  }
  if (!state) return null;

  if (state.phase === "scoiaChoice") {
    const chooserKey = state.scoiaChooser;
    if (coinGate !== chooserKey) {
      return <PassDeviceGate name={state.players[chooserKey].name} onContinue={() => setCoinGate(chooserKey)} />;
    }
    return (
      <ScoiaChoicePanel
        chooserName={state.players[chooserKey].name}
        oppName={state.players[otherKey(chooserKey)].name}
        onChoose={(which) => {
          const starter = which === "self" ? chooserKey : otherKey(chooserKey);
          setState((s) => gameReducer(s, { type: "SCOIA_CHOOSE_STARTER", starter }));
          setRevealedMulligan(starter);
        }}
      />
    );
  }

  if (state.phase === "coinflip") {
    const { caller, resolved, starter } = state.coinFlip;

    // Step 1: nobody has called yet — gate to Player 1 (who calls by convention), then show the call screen.
    if (!caller) {
      if (coinGate !== "p1") return <PassDeviceGate name={state.players.p1.name} onContinue={() => setCoinGate("p1")} />;
      return (
        <CoinFlipPanel
          coinFlip={state.coinFlip}
          myKey="p1"
          myName={state.players.p1.name}
          oppName={state.players.p2.name}
          onCall={(call) => setState((s) => gameReducer(s, { type: "COIN_CALL", player: "p1", call }))}
        />
      );
    }

    // Step 2: called but not flipped — anyone can flip, no gating needed.
    if (!resolved) {
      return (
        <CoinFlipPanel
          coinFlip={state.coinFlip}
          myKey={caller}
          myName={state.players[caller].name}
          oppName={state.players[otherKey(caller)].name}
          onFlip={() => setState((s) => gameReducer(s, { type: "COIN_FLIP" }))}
        />
      );
    }

    // Step 3: resolved — the winner automatically starts; gate to them just to reveal the result, then acknowledge.
    if (coinGate !== starter) {
      return <PassDeviceGate name={state.players[starter].name} onContinue={() => setCoinGate(starter)} />;
    }
    return (
      <CoinFlipPanel
        coinFlip={state.coinFlip}
        myKey={starter}
        myName={state.players[starter].name}
        oppName={state.players[otherKey(starter)].name}
        onAck={() => { setState((s) => gameReducer(s, { type: "COIN_ACK" })); setRevealedMulligan(starter); }}
      />
    );
  }

  if (state.phase === "mulligan") {
    const activeKey = revealedMulligan;
    const active = state.players[activeKey];
    if (active.mulliganDone) {
      const nextKey = otherKey(activeKey);
      if (!state.players[nextKey].mulliganDone) {
        return <PassDeviceGate name={state.players[nextKey].name} onContinue={() => setRevealedMulligan(nextKey)} />;
      }
    }
    return (
      <MulliganPanel
        playerLabel={active.name}
        hand={active.hand}
        swapsUsed={active.mulliganSwaps}
        onSwap={(cardId) => setState((s) => gameReducer(s, { type: "MULLIGAN_SWAP", player: activeKey, cardId }))}
        onDone={() => setState((s) => gameReducer(s, { type: "MULLIGAN_DONE", player: activeKey }))}
      />
    );
  }

  if (state.phase === "play") {
    if (revealedTurn !== state.turn) {
      return <PassDeviceGate name={state.players[state.turn].name} onContinue={() => setRevealedTurn(state.turn)} />;
    }
    const me = state.turn;
    const opp = otherKey(me);
    return (
      <PlayBoard
        state={state}
        viewerRole={me}
        opponentRole={opp}
        viewerName={state.players[me].name}
        opponentName={state.players[opp].name}
        isMyTurn={true}
        canAct={true}
        onPlayCard={(cardId, options) => setState((s) => gameReducer(s, { type: "PLAY_CARD", player: me, cardId, options }))}
        onPass={() => setState((s) => gameReducer(s, { type: "PASS", player: me }))}
        onForfeit={() => setState((s) => gameReducer(s, { type: "FORFEIT", player: me }))}
        onUseLeader={(options) => setState((s) => gameReducer(s, { type: "USE_LEADER", player: me, options }))}
      />
    );
  }

  if (state.phase === "roundEnd" || state.phase === "gameEnd") {
    const me = state.turn;
    const opp = otherKey(me);
    const isTie = state.phase === "roundEnd" && state.lastRoundScore.p1 === state.lastRoundScore.p2;
    return (
      <>
        <PlayBoard
          state={state}
          viewerRole={me}
          opponentRole={opp}
          viewerName={state.players[me].name}
          opponentName={state.players[opp].name}
          isMyTurn={false}
          canAct={false}
          onPlayCard={() => {}}
          onPass={() => {}}
          onUseLeader={() => {}}
        />
        {state.phase === "roundEnd" && (
          <RoundBanner
            round={state.round}
            score={state.lastRoundScore}
            isTie={isTie}
            roundWinnerName={isTie ? null : (state.lastRoundScore.p1 > state.lastRoundScore.p2 ? state.players.p1.name : state.players.p2.name)}
            onContinue={() => { setState((s) => gameReducer(s, { type: "CONTINUE_ROUND" })); setRevealedTurn(null); }}
          />
        )}
        {state.phase === "gameEnd" && <GameOverPanel state={state} onExit={onExit} />}
      </>
    );
  }

  return null;
}

/* ================================ AI MODE =============================== */

function AIGame({ onExit }) {
  const [step, setStep] = useState("deck"); // deck, coinflip, mulligan, play
  const [state, setState] = useState(null);
  const builder = useDeckBuilderState();
  const aiTimerRef = useRef(null);
  const gameLogRef = useRef({ startedAt: null, decisions: [] });

  function confirmDeck() {
    const p1cfg = { name: "You", faction: builder.faction, leaderId: builder.leaderId, deckIds: builder.selected, isAI: false };
    const aiFactionPool = FACTIONS.filter((f) => f !== builder.faction);
    const aiFaction = aiFactionPool[Math.floor(Math.random() * aiFactionPool.length)] || FACTIONS[0];
    const { deckIds: aiPool, aiLeaderId } = chooseAiDeck(aiFaction);
    const p2cfg = { name: "AI Opponent", faction: aiFaction, leaderId: aiLeaderId, deckIds: aiPool, isAI: true };
    const initial = initGame(p1cfg, p2cfg);
    gameLogRef.current = {
      startedAt: new Date().toISOString(),
      you: { faction: p1cfg.faction, leaderId: p1cfg.leaderId },
      aiOpponent: { faction: p2cfg.faction, leaderId: p2cfg.leaderId },
      decisions: [],
    };
    setState(initial);
    setStep("coinflip");
  }

  function playAgain() {
    clearTimeout(aiTimerRef.current);
    setState(null);
    gameLogRef.current = { startedAt: null, decisions: [] };
    setStep("deck");
  }

  // AI auto-decides during Scoia'tael's pre-game starter choice, if the AI is the chooser.
  useEffect(() => {
    if (!state || state.phase !== "scoiaChoice") return;
    if (state.scoiaChooser !== "p2") return;
    const t = setTimeout(() => {
      const starter = Math.random() < 0.5 ? "p1" : "p2";
      setState((s) => gameReducer(s, { type: "SCOIA_CHOOSE_STARTER", starter }));
    }, 700);
    return () => clearTimeout(t);
  }, [state]);

  // AI auto-acknowledges the coin flip result so the human isn't blocked on it.
  useEffect(() => {
    if (!state || state.phase !== "coinflip") return;
    const { resolved, starter } = state.coinFlip;
    if (resolved && starter === "p2") {
      const t = setTimeout(() => setState((s) => gameReducer(s, { type: "COIN_ACK" })), 700);
      return () => clearTimeout(t);
    }
  }, [state]);

  useEffect(() => {
    if (!state) return;
    if (state.phase === "mulligan" && !state.players.p2.mulliganDone) {
      const weakest = [...state.players.p2.hand].map(cardById).sort((a, b) => a.power - b.power).slice(0, MAX_MULLIGAN);
      let s = state;
      weakest.forEach((c) => { s = gameReducer(s, { type: "MULLIGAN_SWAP", player: "p2", cardId: c.id }); });
      s = gameReducer(s, { type: "MULLIGAN_DONE", player: "p2" });
      setState(s);
    }
  }, [state && state.phase]);

  useEffect(() => {
    if (!state) return;
    if (state.phase === "play" && state.turn === "p2" && !state.players.p2.passed) {
      // Wait at least the usual "thinking" beat, but never fire before the
      // last move's sound has actually finished (see soundGateRemainingMs).
      const delay = Math.max(1300, soundGateRemainingMs());
      aiTimerRef.current = setTimeout(() => {
        const action = computeAIAction(state, "p2");
        const me = state.players.p2;
        const opp = state.players.p1;
        gameLogRef.current.decisions.push({
          round: state.round,
          myBoardTotal: boardTotal(me.board, matchHasLeader(state, "L01")),
          oppBoardTotal: boardTotal(opp.board, matchHasLeader(state, "L01")),
          myHandSize: me.hand.length,
          oppHandSize: opp.hand.length,
          action: action.type === "PLAY_CARD" ? `played ${cardById(action.cardId)?.name}` : action.type.toLowerCase(),
        });
        setState((s) => gameReducer(s, action));
      }, delay);
      return () => clearTimeout(aiTimerRef.current);
    }
  }, [state]);

  if (step === "deck") {
    return <DeckBuilder playerLabel="You" faction={builder.faction} onFactionChange={builder.setFaction}
      lockFaction={false} selectedIds={builder.selected} onToggleCard={builder.toggle}
      leaderId={builder.leaderId} onSelectLeader={builder.setLeaderId} onConfirm={confirmDeck} onRandomize={builder.randomize}
      savedDecks={builder.savedDecks} onSaveDeck={builder.saveDeck} onLoadDeck={builder.loadDeck} onDeleteDeck={builder.deleteDeck}
      onBack={onExit} />;
  }
  if (!state) return null;

  if (state.phase === "scoiaChoice") {
    if (state.scoiaChooser === "p1") {
      return (
        <ScoiaChoicePanel
          chooserName="You"
          oppName="AI Opponent"
          onChoose={(which) => {
            const starter = which === "self" ? "p1" : "p2";
            setState((s) => gameReducer(s, { type: "SCOIA_CHOOSE_STARTER", starter }));
          }}
        />
      );
    }
    return (
      <div className="screen coinflip">
        <h2 className="screen-title">Scoia'tael scouts</h2>
        <p className="mulligan-hint">AI Opponent's Scoia'tael scouts are choosing who opens Round 1…</p>
      </div>
    );
  }

  if (state.phase === "coinflip") {
    const { caller, resolved, starter } = state.coinFlip;
    if (!caller) {
      return <CoinFlipPanel coinFlip={state.coinFlip} myKey="p1" myName="You" oppName="AI Opponent"
        onCall={(call) => setState((s) => gameReducer(s, { type: "COIN_CALL", player: "p1", call }))} />;
    }
    if (!resolved) {
      return <CoinFlipPanel coinFlip={state.coinFlip} myKey={caller} myName="You" oppName="AI Opponent"
        onFlip={() => setState((s) => gameReducer(s, { type: "COIN_FLIP" }))} />;
    }
    if (starter === "p1") {
      return <CoinFlipPanel coinFlip={state.coinFlip} myKey="p1" myName="You" oppName="AI Opponent"
        onAck={() => setState((s) => gameReducer(s, { type: "COIN_ACK" }))} />;
    }
    return <CoinFlipPanel coinFlip={state.coinFlip} myKey="p2" myName="You" oppName="AI Opponent" />;
  }

  if (state.phase === "mulligan") {
    const me = state.players.p1;
    return (
      <MulliganPanel
        playerLabel="You"
        hand={me.hand}
        swapsUsed={me.mulliganSwaps}
        onSwap={(cardId) => setState((s) => gameReducer(s, { type: "MULLIGAN_SWAP", player: "p1", cardId }))}
        onDone={() => setState((s) => gameReducer(s, { type: "MULLIGAN_DONE", player: "p1" }))}
      />
    );
  }

  if (state.phase === "play") {
    return (
      <PlayBoard
        state={state}
        viewerRole="p1"
        opponentRole="p2"
        viewerName="You"
        opponentName="AI Opponent"
        isMyTurn={state.turn === "p1"}
        canAct={state.turn === "p1"}
        onPlayCard={(cardId, options) => setState((s) => gameReducer(s, { type: "PLAY_CARD", player: "p1", cardId, options }))}
        onPass={() => setState((s) => gameReducer(s, { type: "PASS", player: "p1" }))}
        onForfeit={() => setState((s) => gameReducer(s, { type: "FORFEIT", player: "p1" }))}
        onUseLeader={(options) => setState((s) => gameReducer(s, { type: "USE_LEADER", player: "p1", options }))}
        opponentThinking={state.turn === "p2" && !state.players.p2.passed}
      />
    );
  }

  if (state.phase === "roundEnd" || state.phase === "gameEnd") {
    const isTie = state.phase === "roundEnd" && state.lastRoundScore.p1 === state.lastRoundScore.p2;
    return (
      <>
        <PlayBoard
          state={state}
          viewerRole="p1"
          opponentRole="p2"
          viewerName="You"
          opponentName="AI Opponent"
          isMyTurn={false}
          canAct={false}
          onPlayCard={() => {}}
          onPass={() => {}}
          onUseLeader={() => {}}
        />
        {state.phase === "roundEnd" && (
          <RoundBanner
            round={state.round}
            score={state.lastRoundScore}
            isTie={isTie}
            roundWinnerName={isTie ? null : (state.lastRoundScore.p1 > state.lastRoundScore.p2 ? "You" : "AI Opponent")}
            viewerName="You"
            onContinue={() => setState((s) => gameReducer(s, { type: "CONTINUE_ROUND" }))}
          />
        )}
        {state.phase === "gameEnd" && <GameOverPanel state={state} onExit={onExit} onPlayAgain={playAgain} gameLog={gameLogRef.current} viewerRole="p1" />}
      </>
    );
  }

  return null;
}

/* ================================ ONLINE MODE =============================
   Refactored in v2 to share the exact same `gameReducer` as Hotseat/AI mode.
   Whichever client acts composes the full {meta + p1 + p2} state, runs it
   through the reducer locally, then writes all three storage keys back.
   This is a deliberate change from v1 (which had each client only write its
   own slice): several v2 abilities cross the board (Spy places on the
   opponent's side, Weather/Scorch/leader powers target the opponent), so a
   client needs to be able to write the opponent's slice for those to work
   at all. This is still a trust-based prototype with no server validation,
   consistent with the original design — just extended to cover more cases. */

function metaKey(code) { return "kwent:" + code + ":meta"; }
function playerKey(code, role) { return "kwent:" + code + ":" + role; }
function presenceKey(code, role) { return "kwent:" + code + ":presence:" + role; }

/* Firebase Realtime Database has no real concept of an empty array or a
   null leaf value — writing either one is treated as deleting that key.
   So any field that starts out as [] (board.specials, board.hornCards.*,
   discard, etc.) or null (board.weather.*) comes back from the database
   as `undefined` once it round-trips, even though the local reducer always
   guarantees an array/object there. Downstream code (e.g. PlayBoard's
   flash-tracking effect, which does board.specials.map(...) unconditionally)
   assumes the reducer's shape and crashes on that undefined — this is what
   caused the online-only white screen right after mulligan. Patch the
   shape back into every player object the instant it comes off the wire. */
function normalizePlayer(p) {
  if (!p) return p;
  const b = p.board || {};
  return {
    ...p,
    hand: p.hand || [],
    deck: p.deck || [],
    discard: p.discard || [],
    board: {
      ...emptyBoard(),
      ...b,
      close: b.close || [],
      ranged: b.ranged || [],
      siege: b.siege || [],
      specials: b.specials || [],
      weather: { close: null, ranged: null, siege: null, ...(b.weather || {}) },
      horns: { close: 0, ranged: 0, siege: 0, ...(b.horns || {}) },
      hornCards: {
        close: (b.hornCards && b.hornCards.close) || [],
        ranged: (b.hornCards && b.hornCards.ranged) || [],
        siege: (b.hornCards && b.hornCards.siege) || [],
      },
      mardroeme: { close: false, ranged: false, siege: false, ...(b.mardroeme || {}) },
      mardroemeCards: {
        close: (b.mardroemeCards && b.mardroemeCards.close) || [],
        ranged: (b.mardroemeCards && b.mardroemeCards.ranged) || [],
        siege: (b.mardroemeCards && b.mardroemeCards.siege) || [],
      },
    },
  };
}

async function readJSON(key) {
  return dbGet(key);
}
async function readPlayerJSON(key) {
  return normalizePlayer(await dbGet(key));
}
async function writeJSON(key, value) {
  return dbSet(key, value);
}

const EMPTY_META = {
  phase: "deckbuild", round: 1, turn: null,
  roundWins: { p1: 0, p2: 0 }, lastRoundScore: null, gameWinner: null,
  coinFlip: { caller: null, call: null, result: null, callerWon: null, starter: null, resolved: false },
  log: [],
};

function composeState(meta, mine, theirs, role, oppRole) {
  return { ...meta, players: { [role]: mine, [oppRole]: theirs } };
}

const HEARTBEAT_INTERVAL_MS = 4000;
const DISCONNECT_FORFEIT_MS = 15000;

// LAN mode reuses whatever host:port served the page itself — both players
// load index.html from the same lan-server, so its address is already
// exactly the WebSocket relay address. No manual IP entry needed.
function lanWsUrl() {
  return (window.location.protocol === "https:" ? "wss://" : "ws://") + window.location.host;
}

function OnlineGame({ onExit }) {
  const [phase, setPhase] = useState("choose"); // choose, deckbuild, waiting-deck, synced
  const [role, setRole] = useState(null); // p1 (host) | p2 (guest)
  const [roomCode, setRoomCode] = useState("");
  const [joinInput, setJoinInput] = useState("");
  const [joinError, setJoinError] = useState("");
  const [netMode, setNetMode] = useState("internet"); // "internet" | "lan"
  const [lanStatus, setLanStatus] = useState("idle"); // idle, connecting, error
  const [meta, setMeta] = useState(null);
  const [mine, setMine] = useState(null);
  const [theirs, setTheirs] = useState(null);
  const [oppDisconnected, setOppDisconnected] = useState(false);
  const builder = useDeckBuilderState();
  const listenersRef = useRef([]);
  const transitionGuard = useRef({});
  const heartbeatRef = useRef(null);
  const watchdogRef = useRef(null);
  const theirLastSeenRef = useRef(null);
  const forfeitFiredRef = useRef(false);

  const oppRole = role === "p1" ? "p2" : "p1";

  // Real-time subscriptions: each key pushes updates the instant the server
  // sees a change, instead of waiting on a fixed polling interval.
  const startListening = useCallback((code, myRole) => {
    listenersRef.current.forEach((unsub) => unsub());
    const otherRole = myRole === "p1" ? "p2" : "p1";
    listenersRef.current = [
      dbListen(metaKey(code), (m) => { if (m) setMeta(m); }),
      dbListen(playerKey(code, myRole), (p) => { if (p) setMine(normalizePlayer(p)); }),
      dbListen(playerKey(code, otherRole), (p) => { setTheirs(p ? normalizePlayer(p) : null); }),
      dbListen(presenceKey(code, otherRole), (ts) => { theirLastSeenRef.current = ts; if (ts) setOppDisconnected(false); }),
    ];
  }, []);

  useEffect(() => () => { listenersRef.current.forEach((unsub) => unsub()); }, []);

  // Heartbeat: while in an active room, ping our own presence key every few
  // seconds so the opponent's client can tell we're still connected.
  useEffect(() => {
    if (!roomCode || !role) return;
    const ping = () => writeJSON(presenceKey(roomCode, role), Date.now());
    ping();
    heartbeatRef.current = setInterval(ping, HEARTBEAT_INTERVAL_MS);
    return () => { if (heartbeatRef.current) clearInterval(heartbeatRef.current); };
  }, [roomCode, role]);

  // Watchdog: once we've seen the opponent's presence at least once, if it
  // goes stale for DISCONNECT_FORFEIT_MS, whoever notices first forfeits
  // them by writing straight to meta (no need to run it through the reducer).
  useEffect(() => {
    if (!roomCode || !role) return;
    forfeitFiredRef.current = false;
    watchdogRef.current = setInterval(() => {
      const lastSeen = theirLastSeenRef.current;
      if (!lastSeen) return; // opponent hasn't connected yet — nothing to watch
      const staleFor = Date.now() - lastSeen;
      setOppDisconnected(staleFor > DISCONNECT_FORFEIT_MS);
      if (staleFor <= DISCONNECT_FORFEIT_MS) return;
      if (forfeitFiredRef.current) return;
      if (!meta || meta.phase === "gameEnd") return;
      forfeitFiredRef.current = true;
      (async () => {
        const freshMeta = await readJSON(metaKey(roomCode));
        if (!freshMeta || freshMeta.phase === "gameEnd") return;
        const newMeta = {
          ...freshMeta,
          phase: "gameEnd",
          gameWinner: role,
          log: [...freshMeta.log, `${oppRole === "p1" ? "Host" : "Guest"} disconnected for over 15s — forfeit.`],
        };
        await writeJSON(metaKey(roomCode), newMeta);
        setMeta(newMeta);
      })();
    }, 2000);
    return () => { if (watchdogRef.current) clearInterval(watchdogRef.current); };
  }, [roomCode, role, meta, oppRole]);

  // Connects to whichever backend is currently selected before any db call
  // is made. For LAN, both players loaded this page from the lan-server
  // itself, so its own address doubles as the relay address.
  async function connectBackend() {
    setNetBackend(netMode);
    if (netMode !== "lan") return true;
    setLanStatus("connecting");
    try {
      await setLanServerUrl(lanWsUrl());
      setLanStatus("idle");
      return true;
    } catch (e) {
      setLanStatus("error");
      setJoinError("Could not reach the LAN server. Is node server.js still running?");
      return false;
    }
  }

  async function hostGame() {
    if (!(await connectBackend())) return;
    const code = makeRoomCode();
    await writeJSON(metaKey(code), { ...EMPTY_META, log: ["Room " + code + " created."], createdAt: Date.now() });
    setRoomCode(code);
    setRole("p1");
    startListening(code, "p1");
    setPhase("deckbuild");
  }

  async function joinGame() {
    if (!(await connectBackend())) return;
    const code = joinInput.trim().toUpperCase();
    if (!code) return;
    const m = await readJSON(metaKey(code));
    if (!m) { setJoinError("Room not found. Check the code and try again."); return; }
    setJoinError("");
    setRoomCode(code);
    setRole("p2");
    startListening(code, "p2");
    setPhase("deckbuild");
  }

  async function confirmDeckOnline() {
    const payload = makePlayer({
      name: role === "p1" ? "Host" : "Guest",
      faction: builder.faction, leaderId: builder.leaderId, deckIds: builder.selected, isAI: false,
    });
    payload.deck = builder.selected;
    payload.ready = true;
    await writeJSON(playerKey(roomCode, role), payload);
    setMine(payload);
    setPhase("waiting-deck");
  }

  // Leaves the room entirely (tears down listeners/timers and any in-flight
  // presence state) and drops back to the host/join chooser. Used by the
  // deck screen's Back button so a stale room isn't left dangling in Firebase
  // while the player picks a different mode.
  function backToChoose() {
    listenersRef.current.forEach((unsub) => unsub());
    listenersRef.current = [];
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    if (watchdogRef.current) clearInterval(watchdogRef.current);
    theirLastSeenRef.current = null;
    forfeitFiredRef.current = false;
    transitionGuard.current = {};
    setRoomCode("");
    setRole(null);
    setMeta(null);
    setMine(null);
    setTheirs(null);
    setOppDisconnected(false);
    setJoinError("");
    setPhase("choose");
  }

  // Both decks ready -> deal hands -> move to coin flip.
  useEffect(() => {
    if (phase !== "waiting-deck" && phase !== "deckbuild") return;
    if (!mine || !mine.ready || !theirs || !theirs.ready) return;
    if (transitionGuard.current.dealt) return;
    transitionGuard.current.dealt = true;
    (async () => {
      const dealt = dealHand(mine);
      const theirLeader = theirs?.leaderId;
      const dealtWithLeaderMod = (mine.leaderId === "L08" || theirLeader === "L08")
        ? { ...dealt, forceRandomRevive: true }
        : dealt;
      await writeJSON(playerKey(roomCode, role), dealtWithLeaderMod);
      setMine(dealtWithLeaderMod);
      const m = await readJSON(metaKey(roomCode));
      if (m && m.phase === "deckbuild") {
        await writeJSON(metaKey(roomCode), { ...m, phase: "coinflip", log: [...m.log, "Both decks locked in. Coin toss!"] });
      }
      setPhase("synced");
    })();
  }, [phase, mine, theirs, roomCode, role]);

  // Generic action dispatcher: compose full state fresh from storage, run the
  // shared reducer, write all three keys back, and update local state.
  async function applyAction(action) {
    const [m, mineNow, theirsNow] = await Promise.all([
      readJSON(metaKey(roomCode)),
      readPlayerJSON(playerKey(roomCode, role)),
      readPlayerJSON(playerKey(roomCode, oppRole)),
    ]);
    if (!m || !mineNow || !theirsNow) return;
    const full = composeState(m, mineNow, theirsNow, role, oppRole);
    const ns = gameReducer(full, action);
    const { players, ...newMeta } = ns;
    const ok = await dbUpdate({
      [metaKey(roomCode)]: newMeta,
      [playerKey(roomCode, role)]: players[role],
      [playerKey(roomCode, oppRole)]: players[oppRole],
    });
    if (!ok) return;
    setMeta(newMeta);
    setMine(players[role]);
    setTheirs(players[oppRole]);
  }

  // Auto-advance to the next round a few seconds after round end (either client can trigger it).
  const metaPhase = meta ? meta.phase : null;
  const metaRound = meta ? meta.round : null;
  useEffect(() => {
    if (metaPhase !== "roundEnd") { transitionGuard.current.roundAdvanced = false; return; }
    if (transitionGuard.current.roundAdvanced) return;
    transitionGuard.current.roundAdvanced = true;
    const t = setTimeout(() => { applyAction({ type: "CONTINUE_ROUND" }); }, 3200);
    return () => clearTimeout(t);
  }, [metaPhase, metaRound]);

  if (phase === "choose") {
    const lastHello = getLastHello();
    return (
      <div className="screen online-lobby">
        <button type="button" className="btn btn-sm deckbuilder-back" onClick={onExit}>← Back</button>
        <h2 className="screen-title">Online</h2>
        <div className="net-mode-toggle" style={{ display: "flex", gap: "8px", marginBottom: "10px" }}>
          <button
            type="button"
            className={"btn btn-sm" + (netMode === "internet" ? " btn-gold" : "")}
            onClick={() => setNetMode("internet")}
          >
            Internet
          </button>
          <button
            type="button"
            className={"btn btn-sm" + (netMode === "lan" ? " btn-gold" : "")}
            onClick={() => setNetMode("lan")}
          >
            LAN (no internet)
          </button>
        </div>
        {netMode === "internet" ? (
          <p className="mulligan-hint">Prototype-grade online play: no server validation, real-time synced via a shared database. Keep both tabs open.</p>
        ) : (
          <p className="mulligan-hint">
            LAN mode: one player runs the local server (see lan-server/README.md in the repo), then both
            players open that server's address in a browser on the same network — no internet needed.
            {lastHello && lastHello.addresses && lastHello.addresses.length > 0 && (
              <> Server address{lastHello.addresses.length > 1 ? "es" : ""}: <strong>{lastHello.addresses.map((a) => `${a}:${lastHello.port}`).join(", ")}</strong></>
            )}
          </p>
        )}
        {lanStatus === "connecting" && <p className="mulligan-hint">Connecting to LAN server…</p>}
        <div className="lobby-actions">
          <button type="button" className="btn btn-gold btn-lg" onClick={hostGame}>Host a game</button>
          <div className="join-row">
            <input className="search-input" placeholder="Room code" value={joinInput} onChange={(e) => setJoinInput(e.target.value)} />
            <button type="button" className="btn btn-lg" onClick={joinGame}>Join</button>
          </div>
          {joinError && <p className="hint error">{joinError}</p>}
        </div>
      </div>
    );
  }

  if (phase === "deckbuild") {
    return (
      <>
        {role === "p1" && <div className="room-code-badge">Room code: <strong>{roomCode}</strong> — share it with your opponent</div>}
        <DeckBuilder
          playerLabel={role === "p1" ? "Host" : "Guest"}
          faction={builder.faction} onFactionChange={builder.setFaction} lockFaction={false}
          selectedIds={builder.selected} onToggleCard={builder.toggle}
          leaderId={builder.leaderId} onSelectLeader={builder.setLeaderId}
          onConfirm={confirmDeckOnline}
          onRandomize={builder.randomize}
          savedDecks={builder.savedDecks} onSaveDeck={builder.saveDeck} onLoadDeck={builder.loadDeck} onDeleteDeck={builder.deleteDeck}
          onBack={backToChoose}
        />
      </>
    );
  }

  if (phase === "waiting-deck") {
    return (
      <div className="screen online-lobby">
        <h2 className="screen-title">Waiting for opponent…</h2>
        {role === "p1" && <div className="room-code-badge">Room code: <strong>{roomCode}</strong></div>}
        <p className="mulligan-hint">Your deck is locked in. Waiting for the other player to finish building theirs.</p>
      </div>
    );
  }

  if (!meta) return <div className="screen online-lobby"><p className="mulligan-hint">Connecting…</p></div>;

  if (meta.phase === "scoiaChoice") {
    if (!mine || !theirs) return <div className="screen online-lobby"><p className="mulligan-hint">Syncing…</p></div>;
    const myName = role === "p1" ? "You (Host)" : "You (Guest)";
    const oppName = role === "p1" ? "Guest" : "Host";
    if (meta.scoiaChooser === role) {
      return (
        <ScoiaChoicePanel
          chooserName={myName}
          oppName={oppName}
          onChoose={(which) => applyAction({ type: "SCOIA_CHOOSE_STARTER", starter: which === "self" ? role : oppRole })}
        />
      );
    }
    return <div className="screen online-lobby"><p className="mulligan-hint">{oppName}'s Scoia'tael scouts are choosing who opens Round 1…</p></div>;
  }

  if (meta.phase === "coinflip") {
    if (!mine || !theirs) return <div className="screen online-lobby"><p className="mulligan-hint">Syncing…</p></div>;
    const { caller, resolved, starter } = meta.coinFlip;
    const myName = role === "p1" ? "You (Host)" : "You (Guest)";
    const oppName = role === "p1" ? "Guest" : "Host";
    if (!caller) {
      // Host calls by convention.
      if (role === "p1") {
        return <CoinFlipPanel coinFlip={meta.coinFlip} myKey={role} myName={myName} oppName={oppName}
          onCall={(call) => applyAction({ type: "COIN_CALL", player: role, call })} />;
      }
      return <div className="screen online-lobby"><p className="mulligan-hint">Waiting for the host to call heads or tails…</p></div>;
    }
    if (!resolved) {
      // Only the non-caller flips — otherwise both clients could each roll their
      // own independent Math.random() result and briefly disagree before the
      // database catches up.
      const iAmCaller = caller === role;
      return <CoinFlipPanel coinFlip={meta.coinFlip} myKey={role} myName={myName} oppName={oppName}
        onFlip={iAmCaller ? undefined : () => applyAction({ type: "COIN_FLIP" })} />;
    }
    if (starter === role) {
      return <CoinFlipPanel coinFlip={meta.coinFlip} myKey={role} myName={myName} oppName={oppName}
        onAck={() => applyAction({ type: "COIN_ACK" })} />;
    }
    return <CoinFlipPanel coinFlip={meta.coinFlip} myKey={role} myName={myName} oppName={oppName} />;
  }

  if (meta.phase === "mulligan") {
    if (!mine || !mine.hand) return <div className="screen online-lobby"><p className="mulligan-hint">Dealing hands…</p></div>;
    return (
      <MulliganPanel
        playerLabel={mine.mulliganDone ? "Waiting for opponent" : "Your opening hand"}
        hand={mine.hand}
        swapsUsed={mine.mulliganSwaps}
        onSwap={(cardId) => applyAction({ type: "MULLIGAN_SWAP", player: role, cardId })}
        onDone={() => applyAction({ type: "MULLIGAN_DONE", player: role })}
        waitingLabel={mine.mulliganDone ? "Waiting for the other player to finish their mulligan…" : ""}
      />
    );
  }

  if (meta.phase === "play") {
    if (!mine || !theirs) return <div className="screen online-lobby"><p className="mulligan-hint">Syncing…</p></div>;
    return (
      <>
        {oppDisconnected && (
          <div className="disconnect-banner">
            {(oppRole === "p1" ? "Host" : "Guest")} has disconnected — forfeiting the game if they don't reconnect…
          </div>
        )}
        <PlayBoard
          state={composeState(meta, mine, theirs, role, oppRole)}
          viewerRole={role}
          opponentRole={oppRole}
          viewerName={role === "p1" ? "You (Host)" : "You (Guest)"}
          opponentName={role === "p1" ? "Guest" : "Host"}
          isMyTurn={meta.turn === role}
          canAct={meta.turn === role}
          onPlayCard={(cardId, options) => applyAction({ type: "PLAY_CARD", player: role, cardId, options })}
          onPass={() => applyAction({ type: "PASS", player: role })}
          onForfeit={() => applyAction({ type: "FORFEIT", player: role })}
          onUseLeader={(options) => applyAction({ type: "USE_LEADER", player: role, options })}
        />
      </>
    );
  }

  if (meta.phase === "roundEnd" || meta.phase === "gameEnd") {
    if (!mine || !theirs) return <div className="screen online-lobby"><p className="mulligan-hint">Syncing…</p></div>;

    let roundBannerEl = null;
    if (meta.phase === "roundEnd") {
      const p1s = meta.lastRoundScore ? meta.lastRoundScore.p1 : 0;
      const p2s = meta.lastRoundScore ? meta.lastRoundScore.p2 : 0;
      const isTie = p1s === p2s;
      let winnerName = null;
      if (!isTie) {
        const p1Won = p1s > p2s;
        const iAmP1 = role === "p1";
        winnerName = p1Won === iAmP1 ? "You" : "Opponent";
      }
      roundBannerEl = <RoundBanner round={meta.round} score={meta.lastRoundScore} roundWinnerName={winnerName} isTie={isTie} hideButton viewerName="You" />;
    }

    let gameOverEl = null;
    if (meta.phase === "gameEnd") {
      const iWon = meta.gameWinner === role;
      const isDraw = meta.gameWinner === "draw";
      gameOverEl = (
        <>
          <OnlineGameOverSound iWon={iWon} isDraw={isDraw} />
          <div className="overlay overlay-clear">
            <div className="round-banner gameover">
              <div className="ribbon">GAME OVER</div>
              <div className="banner-sub big">{isDraw ? "It's a draw." : iWon ? "You win!" : "Your opponent wins."} {meta.roundWins.p1} – {meta.roundWins.p2}</div>
              <button type="button" className="btn btn-gold" onClick={() => { setNetBackend("internet"); onExit(); }}>Back to menu</button>
            </div>
          </div>
        </>
      );
    }

    return (
      <>
        <PlayBoard
          state={composeState(meta, mine, theirs, role, oppRole)}
          viewerRole={role}
          opponentRole={oppRole}
          viewerName={role === "p1" ? "You (Host)" : "You (Guest)"}
          opponentName={role === "p1" ? "Guest" : "Host"}
          isMyTurn={false}
          canAct={false}
          onPlayCard={() => {}}
          onPass={() => {}}
          onUseLeader={() => {}}
        />
        {roundBannerEl}
        {gameOverEl}
      </>
    );
  }

  return <div className="screen online-lobby"><p className="mulligan-hint">Connecting…</p></div>;
}

const CSS = `@import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@500;600;700&family=Crimson+Text:ital,wght@0,400;0,600;1,400&family=JetBrains+Mono:wght@500;700&display=swap');

.gwent-root {
  --bg-void: #0d0f0a;
  --bg-panel: #171a12;
  --bg-panel-2: #1f2318;
  --line: #3a3f2c;
  --gold: #c9a24b;
  --gold-dim: #8a7238;
  --parchment: #ece2c6;
  --ink: #1b1a15;
  --muted: #9aa085;
  --danger: #b23b3b;
  --good: #6f9a5f;
  --font-display: 'Cinzel', serif;
  --font-body: 'Crimson Text', Georgia, serif;
  --font-mono: 'JetBrains Mono', monospace;

  background: radial-gradient(ellipse at top, #1a1f14 0%, #0d0f0a 70%);
  color: var(--parchment);
  font-family: var(--font-body);
  min-height: 100vh;
  width: 100%;
  box-sizing: border-box;
  padding: 0;
  position: relative;
  z-index: 0; /* Establishes its own stacking context. */
  overflow-x: hidden;
}
.gwent-root *, .gwent-root *::before, .gwent-root *::after { box-sizing: border-box; }
html, body { min-height: 100%; margin: 0; background: #0d0f0a; }

.screen { padding: 18px 16px 28px; max-width: 720px; margin: 0 auto; min-height: 480px; }
.screen-title { font-family: var(--font-display); font-weight: 600; letter-spacing: 0.03em; font-size: 1.3rem; margin: 4px 0 14px; color: var(--gold); text-transform: uppercase; }
.deckbuilder-back { margin-bottom: 10px; }

/* ---- Home ---- */
.home-hero { text-align: center; padding: 28px 8px 8px; }
.eyebrow { font-family: var(--font-mono); font-size: 0.7rem; letter-spacing: 0.18em; color: var(--gold-dim); }
.home-hero h1 { font-family: var(--font-display); font-size: 2.4rem; margin: 8px 0; color: var(--gold); text-shadow: 0 2px 12px rgba(201,162,75,0.25); }
.home-hero p { color: var(--muted); max-width: 480px; margin: 0 auto; }
.mode-grid { display: grid; gap: 12px; margin: 26px 0; }
.mode-card { background: linear-gradient(180deg, var(--bg-panel-2), var(--bg-panel)); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; text-align: left; cursor: pointer; color: var(--parchment); transition: border-color .15s, transform .15s; }
.mode-card:hover:not(.is-disabled) { border-color: var(--gold); transform: translateY(-2px); }
.mode-card.is-disabled { opacity: 0.45; cursor: not-allowed; }
.mode-title { display: block; font-family: var(--font-display); font-size: 1.05rem; color: var(--gold); margin-bottom: 4px; }
.mode-desc { display: block; font-size: 0.88rem; color: var(--muted); }
.home-note { text-align: center; font-size: 0.78rem; color: var(--muted); opacity: 0.8; margin-top: 30px; }

/* ---- Buttons ---- */
.btn { font-family: var(--font-display); background: var(--bg-panel-2); border: 1px solid var(--line); color: var(--parchment); padding: 9px 16px; border-radius: 7px; cursor: pointer; letter-spacing: 0.02em; }
.btn:hover:not(:disabled) { border-color: var(--gold); }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-gold { background: linear-gradient(180deg, #d8b25e, var(--gold)); color: #241d0e; border-color: var(--gold); font-weight: 600; }
.btn-lg { padding: 12px 22px; font-size: 1rem; }
.btn-sm { padding: 5px 10px; font-size: 0.78rem; }
.btn-ghost { background: transparent; }
.btn-pass { font-family: var(--font-display); background: var(--danger); border: 1px solid #7a2323; color: #f4e6e6; padding: 8px 18px; border-radius: 20px; cursor: pointer; white-space: nowrap; }
.btn-pass:disabled { opacity: 0.35; cursor: not-allowed; }
.btn-forfeit {
  position: relative;
  white-space: nowrap;
  overflow: hidden;
  font-family: var(--font-display);
  background: #1c1a1a;
  border: 1px solid #4a4444;
  color: #b8afaf;
  padding: 6px 16px;
  border-radius: 18px;
  cursor: pointer;
  font-size: 85%;
  user-select: none;
  touch-action: none;
  transition: color 0.15s, border-color 0.15s;
}
.btn-forfeit:disabled { opacity: 0.35; cursor: not-allowed; }
.btn-forfeit .forfeit-fill {
  position: absolute;
  inset: 0;
  width: var(--forfeit-progress, 0%);
  background: linear-gradient(90deg, #7a2323, #c23c3c);
  transition: width 0.05s linear;
  z-index: 0;
}
.btn-forfeit .forfeit-label { position: relative; z-index: 1; }
.btn-forfeit.holding {
  color: #fff;
  border-color: #c23c3c;
  box-shadow: 0 0 10px rgba(194, 60, 60, 0.6);
}

/* ---- Card tiles ---- */
.card-tile { position: relative; display: flex; flex-direction: column; justify-content: flex-end; text-align: left; background: linear-gradient(160deg, var(--parchment), #d8cba3); color: var(--ink); border: none; border-left: 4px solid var(--accent); border-radius: 6px; padding: 6px 7px 6px; cursor: pointer; box-shadow: 0 2px 4px rgba(0,0,0,0.4); overflow: hidden; }
.card-tile.card-xs { width: 50px; height: 93px; padding: 3px 4px; }
.card-tile.card-sm { width: 76px; height: 141px; }
.card-tile.card-md { width: 112px; height: 209px; }
/* Pure-CSS fit sizing — no JS measurement. Height comes from the slot
   (.row-card-slot / .hand-card-slot, both %-based below), width derives
   from the card art aspect ratio. Tune slot widths/margins directly. */
.card-tile.card-fit { height: 100%; width: auto; aspect-ratio: 0.537 / 1; }
.card-tile .card-power { position: absolute; top: 4px; right: 5px; font-family: var(--font-mono); font-weight: 700; font-size: 0.8rem; background: var(--gold); color: #241d0e; border-radius: 50%; width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; }
.card-tile.card-xs .card-power, .card-tile.card-sm .card-power { width: 16px; height: 16px; font-size: 0.62rem; top: 3px; right: 3px; }
.card-tile .card-row-tag { position: absolute; top: 4px; left: 5px; font-family: var(--font-mono); font-size: 0.55rem; letter-spacing: 0.05em; background: var(--row-accent); color: #f4ecd8; padding: 1px 4px; border-radius: 3px; }
.card-tile .card-name { font-size: 0.66rem; line-height: 1.05; font-weight: 600; margin-top: 14px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.card-tile.card-xs .card-name { font-size: 0.55rem; -webkit-line-clamp: 2; margin-top: 10px; }
.card-tile .card-faction { font-family: var(--font-mono); font-size: 0.52rem; opacity: 0.65; margin-top: 2px; }
.card-tile.is-selected { outline: 2px solid var(--gold); outline-offset: 1px; }
.card-tile.is-disabled { opacity: 0.45; cursor: not-allowed; }
.card-tile.is-faded { opacity: 0.5; }


/* ---- Deck builder ---- */
.faction-picker { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.faction-pill { font-family: var(--font-display); font-size: 0.78rem; padding: 6px 12px; border-radius: 16px; border: 1px solid var(--accent); background: transparent; color: var(--parchment); cursor: pointer; opacity: 0.6; }
.faction-pill.active { opacity: 1; background: var(--accent); color: #12140d; font-weight: 700; }
.faction-locked { font-size: 0.9rem; color: var(--muted); margin-bottom: 10px; }
.section-label { font-family: var(--font-mono); font-size: 0.7rem; letter-spacing: 0.12em; color: var(--gold-dim); display: block; margin-bottom: 6px; }
.leader-picker { margin-bottom: 14px; }
.leader-row { display: flex; flex-wrap: wrap; gap: 8px; }
.deck-count { font-family: var(--font-mono); margin-bottom: 8px; color: var(--gold); display: flex; align-items: center; gap: 10px; }
.random-deck-btn { margin-left: 4px; }
.search-input { width: 100%; padding: 9px 12px; border-radius: 7px; border: 1px solid var(--line); background: var(--bg-panel-2); color: var(--parchment); font-family: var(--font-body); margin-bottom: 12px; }
.ability-filter-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.ability-filter-btn { display: flex; align-items: center; gap: 5px; padding: 5px 10px; border-radius: 999px; border: 1px solid var(--line); background: var(--bg-panel-2); color: var(--parchment); cursor: pointer; font-family: var(--font-body); font-size: 0.78rem; transition: background 0.15s, border-color 0.15s, transform 0.1s; }
.ability-filter-btn:hover { border-color: var(--gold); transform: translateY(-1px); }
.ability-filter-btn.active { background: var(--gold); color: #201603; border-color: var(--gold); font-weight: 600; }
.ability-filter-symbol { font-size: 1rem; line-height: 1; }
.ability-filter-clear { opacity: 0.8; font-style: italic; }
.pool-grid { display: flex; flex-wrap: wrap; gap: 7px; max-height: 46vh; overflow-y: auto; padding: 6px; background: rgba(0,0,0,0.2); border-radius: 8px; border: 1px solid var(--line); }
.deckbuilder-footer { display: flex; align-items: center; gap: 12px; margin-top: 16px; flex-wrap: wrap; }
.saved-decks-row { display: flex; align-items: center; gap: 8px; margin: 10px 0; flex-wrap: wrap; }
.deck-name-input { max-width: 180px; }
.saved-deck-select { max-width: 220px; }
.btn-danger { background: #6b1f1f; border-color: #8a2b2b; color: #f1d9d9; }
.btn-danger:hover:not(:disabled) { background: #822828; }
.disconnect-banner {
  position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
  background: #6b1f1f; color: #f6dede; border: 1px solid #a33; border-radius: 8px;
  padding: 8px 16px; font-size: 0.85rem; font-weight: 600; z-index: 50;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}
.hint { color: var(--muted); font-size: 0.82rem; }
.hint.error { color: #e08a8a; }

/* ---- Mulligan ---- */
.mulligan-hint { color: var(--muted); margin-bottom: 14px; }
.hand-grid { display: flex; flex-wrap: wrap; gap: 8px; }

/* ---- Pass gate / overlays / banners ---- */
.overlay { position: fixed; inset: 0; background: rgba(6,7,4,0.86); display: flex; align-items: center; justify-content: center; z-index: 40; padding: 16px; }
.overlay-clear { background: transparent; pointer-events: none; }
.overlay-clear .round-banner { pointer-events: auto; }
@keyframes bannerPop {
  0% { transform: scale(0.7); opacity: 0; }
  70% { transform: scale(1.06); opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}
.round-banner { text-align: center; background: linear-gradient(180deg, var(--bg-panel-2), var(--bg-panel)); border: 1px solid var(--gold-dim); border-radius: 14px; padding: 34px 28px; max-width: 380px; animation: bannerPop 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) both; }
.round-banner .ribbon { font-family: var(--font-display); letter-spacing: 0.14em; color: var(--gold); font-size: 1.1rem; margin-bottom: 14px; }
.banner-score { font-family: var(--font-mono); font-size: 2.4rem; display: flex; gap: 14px; justify-content: center; align-items: center; margin-bottom: 10px; }
.banner-score .vs { color: var(--muted); font-size: 1.2rem; }
.banner-sub { color: var(--parchment); margin-bottom: 18px; }
.banner-sub.big { font-size: 1.2rem; font-family: var(--font-display); color: var(--gold); }
.pass-gate { cursor: pointer; }

/* ---- Play board ----
   Everything below is sized to fit one viewport with no scrolling: the
   board is a flex column pinned to the viewport height, and every card
   (board rows, your hand, the opponent's card-back fan, deck/discard
   piles) is sized with plain %/aspect-ratio CSS — no JS measurement. */
.play-board {
  max-width: 100%; margin: 0 auto; padding: 0;
  height: 100vh; height: 100dvh; display: flex; flex-direction: column; gap: 4px;
  overflow: hidden; box-sizing: border-box;
}
.top-bar { display: flex; align-items: center; gap: 10px; padding: 6px 10px; background: var(--bg-panel-2); border: 1px solid var(--line); border-radius: 8px; position: relative; flex: 0 0 auto; }
.tb-side { display: flex; align-items: center; gap: 6px; font-size: 0.85rem; }
.tb-side-right { margin-left: auto; }
.tb-center { flex: 1; text-align: center; }
.tb-round { display: block; font-family: var(--font-display); color: var(--gold); font-size: 0.85rem; letter-spacing: 0.08em; }
.tb-turn { display: block; font-size: 0.75rem; color: var(--muted); }
.gem-pair { display: inline-flex; gap: 5px; margin: -15% 0% 0 -12%; }
.gem-pip { position: relative; display: inline-block; width: 6cqh; height: 5cqh; }
.gem-img { position: absolute; inset: 0; width: 270%; height: 300%; object-fit: contain; pointer-events: none; margin: -60% 0 0 0%; }
.gem-back { z-index: 0; }
.gem-front { z-index: 1; }
.gem-crack { z-index: 2; }

/* boardls.png is the single full-board texture (both players' shelves +
   center divider) rendered once behind everything. .board-frame is a
   14-column x 16-row CSS Grid — this shape and every slot's grid-row /
   grid-column below come straight from the merged cells in layout.xlsx, so
   the DOM structure mirrors that spreadsheet cell-for-cell. Nudge a slot by
   editing its grid-row/grid-column (not transform) in DevTools and send
   back the final values. */
/* boardls.png sits as the table's own background (border-collapse means the
   image shows through every cell seam) so the DOM is a literal <table>
   mirroring the layout.xlsx / hand-authored HTML structure cell-for-cell —
   rowSpan/colSpan in the JSX must match that HTML exactly. Nudge a cell by
   adjusting its <col> width % (for column width) — row heights are locked
   equal (16 even rows) since board rows have no independent height lever
   in a table; if a specific row needs to be taller/shorter later we'll
   split that into its own <colgroup>-less concern via CSS on that row's
   <tr> instead. */
.board-frame {
  position: relative; width: 100%; margin: 0 auto;
  aspect-ratio: 956.8 / 460.28;
  container-type: size;
}
.board-table {
  width: 100%; height: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  background-image: url('${BOARD_TEXTURE_URL}'); background-size: 100% 100%; background-repeat: no-repeat; background-position: center;
}
.board-table tr { height: 6.25%; } /* 1/16 each, 16 rows total */
.board-table td, .board-table th { height: 6.25%; padding: 0; margin: 0; border: none; overflow: hidden; vertical-align: top; }
.board-table td[rowspan="2"] { height: 12.5%; }
.board-table td[rowspan="3"] { height: 18.75%; }

.cell-opp-leader .card-tile, .cell-my-leader .card-tile { width: 80%; height: 65%; margin: 30% 0 0 17%; }
.cell-opp-leader .card-art, .cell-my-leader .card-art { height: 137.5%; }

/* ===== Board/*.jpg cell textures =====
   Portrait/icon assets (leader art, weather icon, deck/discard backs) are
   meant to be seen whole, not cropped — background-size:contain shows the
   full image, centered, letterboxed inside the cell. Row/horn shelf and
   badge-plaque textures are meant to fill the cell edge-to-edge, so they
   use cover (crops as needed, never stretches/distorts). */
.cell-opp-leader        { background-image: ${boardImg("opp leader")}; background-size: contain; background-repeat: no-repeat; background-position: center; }
.cell-my-leader          { background-image: ${boardImg("my leader")}; background-size: contain; background-repeat: no-repeat; background-position: center; }
.cell-opp-leader-badge   { background-image: ${boardImg("opp badge")}; background-size: auto 70%; background-repeat: no-repeat; background-position: left; }
.cell-my-leader-badge    { background-image: ${boardImg("my badge")}; background-size: auto 70%; background-repeat: no-repeat; background-position: left; }
.cell-opp-siege-horn     { background-image: ${boardImg("opp siege horn")}; background-size: cover; background-repeat: no-repeat; background-position: center; }
.cell-my-siege-horn      { background-image: ${boardImg("my siege horn")}; background-size: cover; background-repeat: no-repeat; background-position: center; }
.cell-opp-siege-row      { background-image: ${boardImg("opp siege")}; background-size: cover; background-repeat: no-repeat; background-position: center; }
.cell-my-siege-row       { background-image: ${boardImg("my siege")}; background-size: cover; background-repeat: no-repeat; background-position: center; }
.cell-opp-ranged-horn    { background-image: ${boardImg("opp range horn")}; background-size: cover; background-repeat: no-repeat; background-position: center; }
.cell-my-ranged-horn     { background-image: ${boardImg("my range horn")}; background-size: cover; background-repeat: no-repeat; background-position: center; }
.cell-opp-ranged-row     { background-image: ${boardImg("opp range")}; background-size: cover; background-repeat: no-repeat; background-position: center; }
.cell-my-ranged-row      { background-image: ${boardImg("my range")}; background-size: cover; background-repeat: no-repeat; background-position: center; }
.cell-opp-deck           { background-image: ${boardImg("opp deck")}; background-size: contain; background-repeat: no-repeat; background-position: left; }
.cell-my-deck            { background-image: ${boardImg("my deck")}; background-size: contain; background-repeat: no-repeat; background-position: left; }
.cell-opp-discard        { background-image: ${boardImg("opp discard")}; background-size: contain; background-repeat: no-repeat; background-position: left; position: relative; }
.cell-my-discard         { background-image: ${boardImg("my discard")}; background-size: contain; background-repeat: no-repeat; background-position: left; }

/* Close-row/close-horn cells get their texture from a background layer
   div (RowBgFill) instead of a direct td background, so the image can be
   shrunk with a tunable gap facing the weather divider. See RowBgFill
   comment above for why height:% is used instead of margin:%. */
.cell-opp-close-row, .cell-opp-close-horn,
.cell-my-close-row, .cell-my-close-horn {
  position: relative;
}
.row-bg-fill {
  position: absolute;
  left: 0; width: 100%;
  height: 89%;   /* tune me — smaller % = bigger gap */
  z-index: 0;
  box-sizing: border-box;
  background-size: cover;
  background-repeat: no-repeat;
  background-position: center;
}
.row-bg-fill-top { top: 0; }       /* opp side — gap falls at the bottom, toward the weather divider */
.row-bg-fill-bottom { bottom: 0; } /* my side — gap falls at the top, toward the weather divider */

/* Row label / horn / cards cells are plain <td> content now — no wrapper
   div needed, the <td> itself is the positioned box. */
.row-label { position: relative; display: flex; align-items: center; justify-content: flex-end; font-family: var(--font-mono); font-size: 95%; color: var(--muted); width: 100%; height: 100%; }
.row-total { color: var(--gold); font-weight: 700; }
.row-markers { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; width: 100%; height: 100%; }
.marker { font-family: var(--font-mono); font-size: 0.6rem; color: var(--muted); white-space: nowrap; }
.marker-weather { color: #8fd0ff; }
.marker-horn { color: var(--gold); }
.marker-mardroeme { color: #d98cff; }
.horn-card-slot { position: relative; flex: 1 1 0; min-height: 0; width: auto; max-width: 100%; }
.horn-card-slot .card-tile { height: 150%; width: 120%; margin: 15% 0 0 -5%; }
.weather-card-slot { position: relative; flex: 1 1 0; min-height: 0; width: 100%; max-width: 100%; height: 100%; }
.row-cards { position: relative; z-index: 1; display: flex; align-items: flex-start; justify-content: flex-start; width: 100%; height: 100%; overflow: hidden; }
.row-cards.row-close { display: flex; align-items: flex-end; }
.cell-opp-close-row .row-cards.row-close { align-items: flex-start; }
.row-cards.row-ranged, .row-cards.row-siege { display: flex; align-items: center; }

/* Weather hue overlays — tint the row background when its weather is
   active (frost on close, fog on ranged, rain on siege). Applied as a
   ::before layer so it paints behind the card slots (which follow it in
   DOM order) instead of washing over the card artwork itself. */
.row-cards.row-weathered::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
}
.row-cards.row-close.row-weathered::before   { background-color: rgba(150, 200, 235, 0.28); }  /* frost — light blue */
.row-cards.row-ranged.row-weathered::before  { background-color: rgba(55, 58, 62, 0.4); }       /* fog — dark grey */
.row-cards.row-siege.row-weathered::before   { background-color: rgba(180, 195, 215, 0.28); }   /* rain — light grey-blue */
/* Close rows draw their board texture through a separate RowBgFill layer
   clipped to 89% height (leaving a gap toward the weather divider) instead
   of a full-bleed td background like ranged/siege — match that footprint
   so the frost tint doesn't spill into the untextured gap. */
.cell-opp-close-row .row-cards.row-weathered::before { top: 0; bottom: auto; height: 89%; }
.cell-my-close-row .row-cards.row-weathered::before { top: auto; bottom: 0; height: 89%; }

.row-card-slot { position: relative; height: 90%; width: 7%; flex: 0 0 auto; margin-left: -1%; }
.row-card-slot:first-child { margin-left: 0; }
.row-empty { color: var(--muted); font-size: 0.75rem; opacity: 0.6; align-self: center; margin: auto; }

.leader-unused-badge { width: 75%; height: 75%; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.5)); margin: 0 0 -40% 3%; }
.cell-opp-leader-badge .leader-unused-badge { transform: rotate(180deg); }

.side-name { font-family: var(--font-display); font-size: 95%; color: var(--gold); letter-spacing: 0.04em; display: flex; justify-content: center; width: 100%; height: 30%; align-items: flex-start; }
.board-table td.cell-opp-score, .board-table td.cell-my-score { overflow: visible; }
.score-badge { font-size: 135%; color: var(--gold); font-weight: 700; line-height: 1; display: flex; justify-content: center; width: 100%; height: 100%; align-items: flex-start; }
.score-leading {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.7em;
  min-height: 1.7em;
  padding: 0 0.15em;
  box-sizing: border-box;
  color: #1a1206;
  background: radial-gradient(ellipse at center, #ffe27a 0%, #ffb930 70%, #d98c0f 100%);
  border-radius: 50%;
  box-shadow: 0 0 0 3px #ffdd7a, 0 0 18px 4px rgba(255, 200, 60, 0.85), inset 0 0 6px rgba(255, 255, 255, 0.6);
  font-size: 90%;
  animation: score-leading-pulse 1.6s ease-in-out infinite;
}
@keyframes score-leading-pulse {
  0%, 100% { box-shadow: 0 0 0 3px #ffdd7a, 0 0 18px 4px rgba(255, 200, 60, 0.85), inset 0 0 6px rgba(255, 255, 255, 0.6); }
  50% { box-shadow: 0 0 0 3px #ffdd7a, 0 0 26px 8px rgba(255, 200, 60, 1), inset 0 0 8px rgba(255, 255, 255, 0.8); }
}

.cell-weather-center { display: flex; background-image: ${boardImg("weather")}; background-size: contain; background-repeat: no-repeat; background-position: center; }
.weather-center-list { display: flex; align-items: center; justify-content: center; gap: 2px; width: 82%; height: 67%; margin: 13% auto auto auto; flex-direction: row; }
.weather-clear { display: flex; justify-content: center; align-self: center; margin: 30% 0 0 0; opacity: 0.6; }

/* Weather overlay: absolutely positioned on .board-frame instead of a td
   background, so it can be placed/sized independently of the table's
   colspan/rowspan grid occupancy. */
.weather-overlay {
  position: absolute;
  top: 40%;
  left: 0.5%;
  width: 10%;
  height: 15%;
  background-image: ${boardImg("weather")};
  background-size: contain;
  background-repeat: no-repeat;
  background-position: center;
  pointer-events: none;
  z-index: 1;
}

.hand-strip-cards { display: flex; align-items: center; flex: 1 1 auto; min-width: 0; min-height: 0; height: 30%; width: 97%; position: relative; z-index: 5; }
.opp-hand-strip { top: -6.75%; }
.hand-fit { display: flex; width: calc(100% - 13.5%); height: 100%; align-items: center; justify-content: center; flex: 1 1 auto; min-height: 0; margin: -11% 0% 0 13.5%; transition: margin-top 0.25s ease; }
.hand-strip-cards:hover .hand-fit { margin-top: -30%; }
.hand-card-slot { position: relative; height: 100%; width: 9%; flex: 0 0 auto; margin-left: var(--hand-overlap, -1%); }
.hand-card-slot:first-child { margin-left: 0; }
.card-back-row { display: flex; width: 100%; height: 100%; align-items: center; justify-content: center; margin-left: 13.5%; }
.card-back-wrap { position: relative; height: 100%; width: 9%; aspect-ratio: 0.537 / 1; border-radius: 5px; overflow: hidden; border: 1px solid var(--gold-dim); flex: 0 0 auto; margin-top: -12.5%; }
.card-back-wrap:first-child { margin-left: 0; }
.card-back-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.card-back-fallback { width: 100%; height: 100%; background: repeating-linear-gradient(45deg, #2a2f1e, #2a2f1e 4px, #343a24 4px, #343a24 8px); }

.deck-pile { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 2px; flex: 0 0 auto; margin: 0 0 0 8%; height: 100%; }
.deck-pile-stack { position: relative; flex: 0 0 auto; height: 90%; width: auto; aspect-ratio: 0.537 / 1; }
.deck-pile-card { position: absolute; inset: 0; border-radius: 5px; overflow: hidden; border: 1px solid var(--gold-dim); box-shadow: 0 2px 4px rgba(0,0,0,0.4); }
.deck-pile-count { font-family: var(--font-mono); font-size: 0.62rem; color: var(--muted); white-space: nowrap; line-height: 1; }
.deck-count-standalone { font-family: var(--font-mono); font-size: 85%; color: var(--muted); display: flex; align-items: flex-start; justify-content: flex-start; margin-left: 18%; width: 100%; height: 100%; }
.discard-pile { display: flex; position: relative; flex: 0 0 auto; margin: 0; height: 100%; width: 48%; justify-content: center; }
.discard-pile-back { position: absolute; top: 50%; right: 59.5%; transform: translateY(-50%); height: 12cqh; width: auto; aspect-ratio: 0.537 / 1; border-radius: 5px; overflow: hidden; border: 1px solid var(--gold-dim); box-shadow: 0 2px 4px rgba(0,0,0,0.4); }

.cell-pass-button { display: flex; align-items: center; justify-content: center; }



/* ---- Online ---- */
.online-lobby { text-align: center; }
.lobby-actions { display: flex; flex-direction: column; align-items: center; gap: 16px; margin-top: 20px; }
.join-row { display: flex; gap: 8px; }
.join-row .search-input { width: 160px; text-align: center; letter-spacing: 0.1em; text-transform: uppercase; }
.room-code-badge { text-align: center; font-family: var(--font-mono); background: var(--bg-panel-2); border: 1px solid var(--gold-dim); border-radius: 8px; padding: 8px; margin: 10px auto; max-width: 420px; }

@media (max-width: 520px) {
  .home-hero h1 { font-size: 1.9rem; }
  .banner-score { font-size: 1.8rem; }
}

/* ---- v2 additions ---- */
.card-tile { position: relative; }
.card-art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center; z-index: 0; }
.card-tile.no-art .card-art { display: none; }
.card-tile-inner { position: relative; z-index: 1; display: flex; flex-direction: column; justify-content: flex-end; height: 100%; }
.card-tile.is-hero { border-left-color: var(--gold) !important; box-shadow: 0 0 0 1px var(--gold), 0 2px 4px rgba(0,0,0,0.4); }

.pending-hint { position: fixed; bottom: 90px; left: 0; right: 0; text-align: center; z-index: 41; background: rgba(0,0,0,0.75); padding: 6px; }

/* ---- Coin flip ---- */
.screen.coinflip { text-align: center; }
.coin-call-row { display: flex; gap: 12px; justify-content: center; margin-top: 18px; flex-wrap: wrap; }
.coin { width: 84px; height: 84px; border-radius: 50%; margin: 18px auto; background: radial-gradient(circle at 35% 30%, #f0d896, var(--gold) 60%, var(--gold-dim) 100%); border: 3px solid var(--gold-dim); box-shadow: 0 4px 10px rgba(0,0,0,0.5); animation: coin-spin 0.9s ease-in-out; }
@keyframes coin-spin { 0% { transform: rotateY(0deg); } 100% { transform: rotateY(1080deg); } }

/* ---- v3 additions: hover-zoom explainer, play animation, passed banner, discard view ---- */
.card-zoom-overlay {
  position: fixed; inset: 0; z-index: 60; background: rgba(6,7,4,0.82);
  display: flex; align-items: center; justify-content: center; padding: 24px;
  animation: zoom-fade-in 0.18s ease-out;
}
@keyframes zoom-fade-in { 0% { opacity: 0; } 100% { opacity: 1; } }
.card-zoom-content {
  display: flex; flex-direction: column; align-items: center; gap: 14px;
  height: 90vh; width: auto; max-width: 92vw;
  overflow-y: auto;
}
.card-zoom-art-wrap {
  height: 72vh; width: auto; aspect-ratio: 0.537; border-radius: 10px; overflow: hidden;
  box-shadow: 0 10px 40px rgba(0,0,0,0.7), 0 0 0 2px var(--gold-dim);
  background: linear-gradient(160deg, var(--parchment), #d8cba3);
  flex-shrink: 0;
  max-width: 92vw;
}
.card-zoom-art { width: 100%; height: 100%; object-fit: cover; display: block; }
.card-zoom-fallback { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--ink); font-family: var(--font-display); text-align: center; padding: 12px; }
.card-zoom-caption { text-align: center; color: var(--parchment); }
.card-zoom-title { font-family: var(--font-display); font-size: 1.15rem; color: var(--gold); display: flex; align-items: center; justify-content: center; gap: 8px; }
.card-zoom-power { font-family: var(--font-mono); background: var(--gold); color: #241d0e; border-radius: 50%; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.85rem; }
.card-zoom-meta { font-family: var(--font-mono); font-size: 0.72rem; color: var(--muted); margin-top: 4px; letter-spacing: 0.03em; }
.card-zoom-desc { font-size: 0.9rem; line-height: 1.4; color: var(--parchment); margin-top: 10px; max-width: 480px; }
@media (max-width: 520px) {
  .card-zoom-content { max-width: 96vw; height: 88vh; }
  .card-zoom-art-wrap { height: 58vh; max-width: 96vw; }
}

@keyframes card-appear { 0% { opacity: 0; transform: scale(0.75) translateY(8px); } 100% { opacity: 1; transform: scale(1) translateY(0); } }
.row-cards .card-tile { animation: card-appear 0.32s ease-out; }

@keyframes card-flash {
  0%, 100% { box-shadow: 0 0 0 2px var(--gold), 0 2px 4px rgba(0,0,0,0.4); }
  50% { box-shadow: 0 0 0 4px var(--gold), 0 0 18px 4px rgba(230, 190, 90, 0.8); }
}
.card-tile.card-just-played { animation: card-flash 1.1s ease-in-out 2; z-index: 2; }

.passed-banner {
  position: absolute; top: 6%; left: 2.5%; z-index: 5;
  background: rgba(120, 20, 20, 0.85); border: 1px solid var(--gold-dim); color: #f4ecd8;
  font-family: var(--font-mono); font-size: 0.7rem; letter-spacing: 0.04em; padding: 3px 12px; border-radius: 12px;
}
.passed-banner.thinking-banner { background: rgba(30, 30, 40, 0.85); }
.last-played-toast {
  position: absolute; top: 6px; right: 8px; z-index: 5; max-width: 60%;
  background: rgba(20, 16, 10, 0.9); border: 1px solid var(--gold-dim); color: var(--parchment);
  font-size: 0.68rem; padding: 4px 10px; border-radius: 10px; animation: toast-fade 2.2s ease-in-out;
}
@keyframes toast-fade { 0% { opacity: 0; } 12% { opacity: 1; } 82% { opacity: 1; } 100% { opacity: 0; } }

/* Safari/Mac-only overrides. @supports (-webkit-hyphens: none) is true in
   Safari (desktop + iOS) and false in Chrome/Firefox/Edge, so these only
   apply there. (The top-row deletion for this same fix set lives in JS via
   IS_SAFARI, since @supports can't remove DOM elements.) */
@supports (-webkit-hyphens: none) {
  .leader-unused-badge { height: 15%; }
  .side-name { font-size: 90%; }
  .weather-overlay { top: 41%; }
  .opp-hand-strip { top: -12.75%; }
  .hand-fit { margin: -6% 0% 0 13.5%; }
}
`;

/* ================================ APP ==================================== */

export default function App() {
  const [mode, setMode] = useState(null);
  const [resetKey, setResetKey] = useState(0);
  const onlineAvailable = true; // backed by Firebase Realtime Database now

  // Fire off the network fetch for every sound clip as soon as the app
  // loads, well before any of them are actually needed — see
  // preloadAllSounds' comment for why this matters.
  useEffect(() => { preloadAllSounds(); }, []);

  function exitToMenu() {
    setMode(null);
    setResetKey((k) => k + 1);
  }

  let content;
  if (!mode) content = <Home onSelect={setMode} onlineAvailable={onlineAvailable} />;
  else if (mode === "hotseat") content = <HotseatGame key={"hs" + resetKey} onExit={exitToMenu} />;
  else if (mode === "ai") content = <AIGame key={"ai" + resetKey} onExit={exitToMenu} />;
  else if (mode === "online") content = <OnlineGame key={"on" + resetKey} onExit={exitToMenu} />;

  return (
    <div className="gwent-root">
      <style>{CSS}</style>
      {content}
    </div>
  );
}
