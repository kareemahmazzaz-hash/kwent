import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
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
// Pinned to an exact commit SHA rather than a floating branch (@main).
// jsDelivr's GitHub-branch CDN mode ("gh") turned out to ignore query
// strings entirely for its cache key — confirmed by testing ?v= busting
// directly and it still served stale content — so query-string cache-
// busting was never going to work here. A commit-pinned URL is treated as
// immutable by jsDelivr, so this guarantees fresh, correct content with no
// caching ambiguity, permanently. Trade-off: the site now only picks up
// whatever was in the repo AT this commit — bump KWENT_PINNED_COMMIT to the
// latest commit SHA whenever new assets need to actually go live.
const KWENT_PINNED_COMMIT = "e02f1e92d041ed32b01de0180e501a18c8160264";
const IMAGE_BASE_URL = `https://cdn.jsdelivr.net/gh/kareemahmazzaz-hash/kwent@${KWENT_PINNED_COMMIT}/`;
const IMAGE_FALLBACK_BASE_URL = `https://raw.githubusercontent.com/kareemahmazzaz-hash/kwent/${KWENT_PINNED_COMMIT}/`;
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
// Shown instead of the blue crown when the leader is unused but firing it
// right now would do nothing (its live precondition isn't met yet) — see
// leaderConditionMet / LEADER_ALWAYS_GOOD_EARLY, reused here for players too.
const LEADER_NOOP_ICON_URL = IMAGE_BASE_URL + "Board/redcrown.png";
const LEADER_NOOP_ICON_FALLBACK_URL = IMAGE_FALLBACK_BASE_URL + "Board/redcrown.png";
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
// No per-asset versioning needed anymore — the base URL itself is now
// pinned to an exact commit (see KWENT_PINNED_COMMIT above), which is what
// actually guarantees freshness for every asset, sounds included.
const SOUND_FILES = {
  bond: "bond.m4a",
  clearWeather: "clear_weather.m4a",
  coin: "coin.m4a",
  crachAnCraite: "crach_an_craite.m4a",
  decoy: "decoy.m4a",
  fog: "fog.m4a",
  frost: "frost.m4a",
  gameLoss: "game_loss.m4a",
  gettingAHero: "getting_a_hero.m4a",
  horn: "horn.m4a",
  leader: "leader.m4a",
  mardroeme: "mardroeme.m4a",
  mardroemeAlone: "mardroeme_alone.m4a",
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
// land until the current sound has actually finished playing. Also used
// directly by CoinFlipPanel to time the spin animation/result reveal.
const SOUND_DURATIONS_MS = {
  bond: 1947, clearWeather: 3378, coin: 1208, crachAnCraite: 2285, decoy: 1966, fog: 3000,
  frost: 2798, gameLoss: 3180, gettingAHero: 2754, horn: 2102, leader: 2459,
  mardroeme: 1878, mardroemeAlone: 1604, morale: 1262, muster: 1238, playingBasic: 679,
  playingHero: 2638, rain: 1806, revival: 1542, roundLoss: 2756, scorch: 1759,
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
function soundUrl(file) { return SOUND_BASE_URL + file; }
function soundFallbackUrl(file) { return SOUND_FALLBACK_BASE_URL + file; }
function preloadAllSounds() {
  if (typeof Audio === "undefined") return;
  Object.entries(SOUND_FILES).forEach(([key, file]) => {
    let pool = _soundPools[key];
    if (!pool) { pool = []; _soundPools[key] = pool; }
    if (pool.length) return;
    const el = new Audio();
    el.preload = "auto";
    el.src = soundUrl(file);
    el.onerror = () => { el.onerror = null; el.src = soundFallbackUrl(file); };
    try { el.load(); } catch (e) { /* non-fatal */ }
    pool.push(el);
  });
}
// Tracks when the currently-queued sound(s) will actually finish, so moves
// can be paced to not step on each other's audio (see soundGate below).
// Module-level on purpose — pacing is a global "is anything audible right
// now" concept, not something scoped to one component instance.
let soundBusyUntil = 0;
// Extra breathing room after a clip's measured end before the gate opens —
// otherwise the next move lands the instant the last sound stops, which
// reads as rushed. Padding lives here (not per-call) so every markSoundBusy
// caller gets it uniformly, and layered sounds (base + ability, revival +
// spy, etc.) still only pay it once since Math.max collapses to the single
// latest end-time across the whole batch, not once per sound in it.
const SOUND_GATE_PADDING_MS = 500;
function markSoundBusy(durationMs) {
  soundBusyUntil = Math.max(soundBusyUntil, Date.now() + (durationMs || 1400) + SOUND_GATE_PADDING_MS);
}
function soundGateRemainingMs() {
  return Math.max(0, soundBusyUntil - Date.now());
}
// Pause before GameOverPanel appears on the game-ending round — long enough
// for the round win/loss clip (see RoundBanner, now played on that round
// too instead of being skipped) to finish, and for the board-sweep
// animation (see PlayBoard's gameEnd effect) to have long since landed —
// the sweep now starts almost immediately alongside the round clip rather
// than waiting for it, so this value's job is purely to keep GameOverPanel's
// own separate win/loss clip from crowding either of them. Ties skip the
// round clip entirely (no winner/loser to announce), so they get a shorter
// pause.
const GAME_END_REVEAL_DELAY_MS = SOUND_DURATIONS_MS.roundLoss + SOUND_GATE_PADDING_MS + 1300;
const GAME_END_REVEAL_DELAY_TIE_MS = 900 + 1300;
function playSound(key) {
  const file = SOUND_FILES[key];
  if (!file || typeof Audio === "undefined") return;
  try {
    let pool = _soundPools[key];
    if (!pool) { pool = []; _soundPools[key] = pool; }
    let el = pool.find((a) => a.paused || a.ended);
    if (!el) {
      el = new Audio(soundUrl(file));
      el.onerror = () => { el.onerror = null; el.src = soundFallbackUrl(file); el.play().catch(() => {}); };
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
  clearWeather: "clearWeather",
  // "weather" itself is ambiguous (fog/frost/rain depend on abilityMeta.row)
  // and "medic" is being reworked into its own two-step flow (v38) — both
  // are resolved with dedicated logic at the call site instead of this table.
};
// L03/L14/L20 apply Horn to a fixed row instantly, no card involved — used
// by the leader-activation branch below to give them the same "horn" sound
// + row glow a card-played Horn gets via ABILITY_SOUND_KEY/triggerAbilityFx.
const LEADER_HORN_ROW = { L03: "close", L14: "siege", L20: "ranged" };
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
// triggered. Scorch (all three variants) no longer runs through this path
// at all — see pendingBurn/lastScorchCast, which decide its sound/visual
// off the actual hit list computed in the reducer instead of a board diff.
// `batchIds` is the full list of ids that landed on the board in this diff
// pass (for Muster).
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
// playing_hero base layered under them — unlike the rest of the special
// cards (Decoy, Muster, Scorch, Spy, Medic), which do get the base sound
// first. Muster deliberately kept OUT of this set: playing_basic before
// muster.m4a is the wanted behavior.
const NO_BASE_SOUND_ABILITIES = new Set(["weather", "clearWeather", "horn"]);
// Plays a card's base "someone played a card" sound (skipped for weather/
// horn — see NO_BASE_SOUND_ABILITIES above), then layers its ability-
// specific sound on top if the ability actually has an effect (see
// abilityActuallyActivates above). `board`/`row`/`batchIds` are optional
// context used only for the Bond/Morale/Muster activation checks.
// `ownRemovedIds`/`opposingRemovedIds` are ids that vanished from this
// card's own side / the other side in this same diff pass — used for
// Mardroeme (did a Berserker on MY side actually transform?) and row Scorch
// (did anything on the OPPONENT's side actually die?) respectively.
function playCardSounds(card, board, row, batchIds, ownRemovedIds, opposingRemovedIds) {
  if (!card) return;
  if (!NO_BASE_SOUND_ABILITIES.has(card.ability)) {
    playSound(card.cardType === "Hero" ? "playingHero" : "playingBasic");
  }
  if (card.ability === "mardroeme") {
    // A transform necessarily replaces a Berserker's board id with its
    // Transformed-variant id in the same row — which shows up as that old
    // id vanishing from this side's board in this very diff pass. No
    // vanished id on this side means nothing transformed.
    const transformed = !!(ownRemovedIds && ownRemovedIds.length > 0);
    playSound(transformed ? "mardroeme" : "mardroemeAlone");
    return;
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
{id:"c180",name:"Isengrim Faoiltiarna",faction:"scoiatael",power:10.0,row:"close",cardType:"Hero",ability:"moraleBoost",abilityMeta:{},img:"Isengrim Faoiltiarna.png"},
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
{id:"c205",name:"Clan Dimun Pirate",faction:"skellige",power:6.0,row:"ranged",cardType:"Basic",ability:"scorchRow",abilityMeta:{},img:"Clan Dimun Pirate.png"},
{id:"c206",name:"Clan Drummond Shield Maiden (1)",faction:"skellige",power:4.0,row:"close",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Clan Drummond Shield Maiden1.png"},
{id:"c207",name:"Clan Drummond Shield Maiden (2)",faction:"skellige",power:4.0,row:"close",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Clan Drummond Shield Maiden2.png"},
{id:"c208",name:"Clan Drummond Shield Maiden (3)",faction:"skellige",power:4.0,row:"close",cardType:"Basic",ability:"tightBond",abilityMeta:{},img:"Clan Drummond Shield Maiden3.png"},
{id:"c209",name:"Clan Heymaey Skald",faction:"skellige",power:4.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Clan Heymaey Skald.png"},
{id:"c210",name:"Clan Tordarroch Armorsmith",faction:"skellige",power:4.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Clan Tordarroch Armorsmith.png"},
{id:"c212",name:"Donar an Hindar",faction:"skellige",power:4.0,row:"close",cardType:"Basic",ability:null,abilityMeta:{},img:"Donar an Hindar.png"},
{id:"c213",name:"Draig Bon-Dhu",faction:"skellige",power:2.0,row:"siege",cardType:"Basic",ability:"horn",abilityMeta:{},img:"Draig Bon-Dhu.png"},
{id:"c214",name:"Ermion",faction:"skellige",power:8.0,row:"ranged",cardType:"Hero",ability:"mardroeme",abilityMeta:{},img:"Ermion.png"},
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

/* Test Mode's rigged version of dealHand: hand and the front of the deck
   are exactly what was hand-picked (and in the picked order for the deck,
   so draw effects that read straight off the top — spy scans, Northern
   Realms' round-win draw, etc. — come out predictably). Anything from the
   pool that wasn't picked for either just gets shuffled in behind the
   picked draw order, so the player only has to specify what they actually
   care about testing. */
function dealHandFixed(player, fixedHand, fixedOrder) {
  const picked = new Set([...fixedHand, ...fixedOrder]);
  const rest = shuffle(player.deck.filter((id) => !picked.has(id)));
  return { ...player, hand: fixedHand, deck: [...fixedOrder, ...rest] };
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

  // A row is either doubled or it isn't — multiple stacked Horn sources (a fixed-row unit like
  // Draig Bon-Dhu/Dandelion plus a Commander's Horn special, say) never compound into 4x/8x for
  // regular units; it's capped to a single doubling. The one place stacking still matters is the
  // horn-carrying unit's OWN power: it doesn't double from its own presence alone (that's just it
  // existing), but it DOES double once some other horn source is also active on the row —
  // capped the same way, so a second stacked source still only gets it to a single double, not
  // a redouble on top of that.
  const selfHornContribution = card.ability === "horn" && card.row ? 1 : 0;
  const externalHornsForThisCard = Math.max((board.horns[row] || 0) - selfHornContribution, 0);
  if (externalHornsForThisCard > 0) value = value * 2;
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

// Cards a Medic-style revive is allowed to target: any non-Hero, non-Special
// card that actually has a row (i.e. a real unit, not a Leader/weather/etc).
// Shared by the reducer (initial play + each RESOLVE_MEDIC_REVIVE link), the
// AI's auto-pick heuristic, and the picker UI so eligibility never drifts
// between the three.
function medicEligible(discard) {
  return discard.filter((id) => {
    const c = cardById(id);
    return c && c.cardType !== "Hero" && c.cardType !== "Special" && c.row;
  });
}
// AI's revive heuristic: always grab the highest-power eligible card.
function bestMedicRevive(discard) {
  const eligible = medicEligible(discard);
  if (!eligible.length) return null;
  return [...eligible].sort((a, b) => (cardById(b)?.power || 0) - (cardById(a)?.power || 0))[0];
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
  // One-shot marker (mirrors lastMedicRevive) for the sound/animation diff
  // effect in PlayBoard: records the id of the card the player actually
  // played, distinct from any Muster siblings it fetches. Cleared here at
  // the top of every play so a stale value from an earlier turn can never
  // leak into this one; the "muster" case below overwrites it when it
  // applies.
  ns = { ...ns, lastMusterPlayed: null };
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
      // mutually exclusive per row, same as real Gwent. But that cross-ability block only applies
      // to CHOICE-row specials (Commander's Horn) — a fixed-row unit (Dandelion/Draig Bon-Dhu) has
      // nowhere else to go, so it's exempt from both the cross-ability block AND the same-ability
      // stacking block; it just must not compound the horn count (capped below), or it'd quadruple
      // the row via Math.pow(2, hornStacks) — the original two-horns-one-row bug.
      // Same-ability stacking (a second Horn on an already-horned row) is only blocked for the
      // choice-row special (Commander's Horn) — it's a 0-power card with no value beyond the
      // effect, so replaying it into an already-horned row is pure waste. A fixed-row unit's own
      // contribution to horns[row] doesn't count toward this — hornCards[row] tracks specials
      // specifically, so Draig Bon-Dhu/Dandelion sitting on the row never blocks a following
      // Commander's Horn; it still has genuine value there (doubling the unit's own power for the
      // first time).
      const rowBoardH = state.players[actingKey].board;
      // Units are units, not specials — they never trigger or get blocked by cross-exclusion,
      // regardless of play order. Cross-check only true Mardroeme specials (mardroemeCards);
      // same-ability check only true Horn specials (hornCards) — both exclude unit contributions.
      if (!card.row && ((rowBoardH.mardroemeCards[row] || []).length > 0 || (rowBoardH.hornCards[row] || []).length > 0)) { ns = withPlayer(ns, actingKey, (p) => ({ ...p, hand: [...p.hand, cardId] })); break; }
      ns = withPlayer(ns, actingKey, (p) => {
        const board = card.row ? addToRow(p.board, row, cardId) : { ...p.board, specials: [...p.board.specials, { cardId, label: card.name }] };
        const hornCards = card.row ? board.hornCards : { ...board.hornCards, [row]: [...board.hornCards[row], cardId] };
        // Increment normally, uncapped — unitEffectivePower's selfHornContribution already
        // subtracts Dandelion's own +1 from HIS power calc so he doesn't double himself, while
        // still counting a prior external Horn (Commander's Horn) toward his own doubling. Capping
        // this count (as a previous version of this fix did) broke that: it kept horns[row] frozen
        // at 1 even after Dandelion joined an already-horned row, so his self-subtraction zeroed out
        // the external Horn's effect on him too, leaving his power un-doubled.
        return { ...p, board: { ...board, horns: { ...board.horns, [row]: (board.horns[row] || 0) + 1 }, hornCards } };
      });
      log.push(`${actor.name} plays ${card.name}, doubling their ${ROW_META[row].label} row.`);
      break;
    }
    case "mardroeme": {
      const row = card.row || options.chosenRow; // Ermion has a fixed row; Mardroeme (special) needs a choice
      // Same mutual exclusion as above, the other direction. Same-ability stacking is only
      // blocked for a second choice-row Mardroeme special — mardroemeCards[row] tracks specials
      // specifically, so Ermion sitting on the row (which flips the boolean mardroeme[row] flag
      // too) never blocks a following Mardroeme special.
      const rowBoardM = state.players[actingKey].board;
      // Units are units, not specials — they never trigger or get blocked by cross-exclusion,
      // regardless of play order. Cross-check only true Horn specials (hornCards); same-ability
      // check only true Mardroeme specials (mardroemeCards) — both exclude unit contributions.
      if (!card.row && ((rowBoardM.hornCards[row] || []).length > 0 || (rowBoardM.mardroemeCards[row] || []).length > 0)) { ns = withPlayer(ns, actingKey, (p) => ({ ...p, hand: [...p.hand, cardId] })); break; }
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
      ns = { ...ns, lastMusterPlayed: { player: actingKey, cardId } };
      break;
    }
    case "medic": {
      // Step 1 of 2: just place the Medic unit itself. The revive (and any
      // chain that follows if the revived card is itself a Medic) is now a
      // separate, player-chosen step — see RESOLVE_MEDIC_REVIVE below. If
      // there's nothing eligible in the discard, awaitingMedicRevive never
      // gets set and the move ends here, same as before.
      ns = withPlayer(ns, actingKey, (p) => ({ ...p, board: addToRow(p.board, targetRow, cardId) }));
      log.push(`${actor.name} plays ${card.name}.`);
      const eligible = medicEligible(ns.players[actingKey].discard);
      if (eligible.length) ns = { ...ns, awaitingMedicRevive: { player: actingKey } };
      else log.push(`${actor.name}'s Medic finds no eligible card in the discard pile.`);
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
      // Scorch no longer removes its victims immediately — see pendingBurn
      // below. The card(s) it hit stay on the board, flagged for the burn
      // animation/sound (see PlayBoard's pendingBurn effect), and only
      // actually get destroyed once RESOLVE_SCORCH_BURN fires a beat later.
      // lastScorchCast always records the cast (scorchGlobal plays its sound
      // regardless of whether it found a target, same as before) even when
      // there's nothing to burn.
      ns = { ...ns, lastScorchCast: { cardId } };
      if (hitsBySide[oppKey].length || hitsBySide[actingKey].length) {
        ns = { ...ns, pendingBurn: { actingPlayer: actingKey, victims: hitsBySide } };
      }
      break;
    }
    case "scorchRow": {
      ns = withPlayer(ns, actingKey, (p) => ({ ...p, board: addToRow(p.board, targetRow, cardId) }));
      const hits = strongestInRow(state.players[oppKey].board, targetRow, spyDoubled);
      log.push(`${actor.name} plays ${card.name} — Scorch hits ${ROW_META[targetRow].label}.`);
      if (hits.length) {
        ns = { ...ns, lastScorchCast: { cardId }, pendingBurn: { actingPlayer: actingKey, victims: { [oppKey]: hits, [actingKey]: [] } } };
      }
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
        if (hits.length) {
          ns = { ...ns, lastScorchCast: { cardId }, pendingBurn: { actingPlayer: actingKey, victims: { [oppKey]: hits, [actingKey]: [] } } };
        }
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

/* Step 2 of 2 for Medic: resolves exactly one revive link. Called once per
   pick — either from the player's tap on the picker (`reviveId` given) or
   from an automatic pick (AI, or forceRandomRevive under L08) with a random/
   best id already chosen by the caller. If the revived card is itself a
   Medic with further eligible targets, awaitingMedicRevive is re-armed for
   another round instead of clearing, which is what makes the chain player-
   choosable link by link rather than auto-resolving in one shot. Sets
   `lastMedicRevive` — a transient marker (not gameplay state, purely for the
   sound/animation diff effect in PlayBoard) recording which id just came
   back and whether it revived as a Spy, so that id gets the dedicated
   revival cue instead of the generic "card was played" one. */
function resolveMedicRevive(state, actingKey, reviveId) {
  if (!state.awaitingMedicRevive || state.awaitingMedicRevive.player !== actingKey) return state;
  const actor = state.players[actingKey];
  const oppKey = otherKey(actingKey);
  const eligible = medicEligible(actor.discard);
  if (!eligible.length) return { ...state, awaitingMedicRevive: null };
  const pick = actor.forceRandomRevive
    ? eligible[Math.floor(Math.random() * eligible.length)]
    : (reviveId && eligible.includes(reviveId) ? reviveId : eligible[0]);
  const reviveCard = cardById(pick);
  let ns = state;
  const log = [];
  if (reviveCard.ability === "spy") {
    // Reviving a Spy through Medic plays it exactly like a normal Spy: it
    // goes on the OPPONENT's side, and the medic's controller still draws
    // the usual 2 cards for it.
    ns = withPlayer(ns, oppKey, (p) => ({ ...p, board: addToRow(p.board, autoPlacementRow(reviveCard, p.board), pick) }));
    ns = withPlayer(ns, actingKey, (p) => {
      const drawn = p.deck.slice(0, 2);
      return { ...p, discard: p.discard.filter((id) => id !== pick), deck: p.deck.slice(2), hand: [...p.hand, ...drawn] };
    });
    log.push(`${actor.name}'s Medic revives ${reviveCard.name} — as a Spy it's placed on ${state.players[oppKey].name}'s side, drawing 2 cards.`);
  } else {
    ns = withPlayer(ns, actingKey, (p) => ({
      ...p,
      discard: p.discard.filter((id) => id !== pick),
      board: addToRow(p.board, autoPlacementRow(reviveCard, p.board), pick),
    }));
    log.push(`${actor.name}'s Medic revives ${reviveCard.name} from the discard pile.`);
  }
  const stillChaining = reviveCard.ability === "medic" && medicEligible(ns.players[actingKey].discard).length > 0;
  ns = {
    ...ns,
    log: [...ns.log, ...log],
    awaitingMedicRevive: stillChaining ? { player: actingKey } : null,
    lastMedicRevive: { player: actingKey, cardId: pick, isSpy: reviveCard.ability === "spy" },
  };
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
        // Same one-shot marker the card-Medic path sets (see
        // resolveMedicRevive/lastMedicRevive) — drives the revival sound and
        // fly-in ghost off the same shared PlayBoard effect, instead of only
        // getting the generic leader-activation sound.
        ns = { ...ns, lastMedicRevive: { player: actingKey, cardId: reviveId, isSpy: reviveCard.ability === "spy" } };
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
        // Deferred, same as card Scorch (see scorchRow/scorchRowThreshold) —
        // victims stay on the board flagged for the burn sound/animation and
        // only actually get destroyed once RESOLVE_SCORCH_BURN fires.
        if (hits.length) ns = { ...ns, pendingBurn: { actingPlayer: actingKey, victims: { [oppKey]: hits, [actingKey]: [] } } };
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
        // Deferred, same as card Scorch — see L13 above.
        if (hits.length) ns = { ...ns, pendingBurn: { actingPlayer: actingKey, victims: { [oppKey]: hits, [actingKey]: [] } } };
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
        // Deferred, same as card Scorch — see L13 above.
        if (hits.length) ns = { ...ns, pendingBurn: { actingPlayer: actingKey, victims: { [oppKey]: hits, [actingKey]: [] } } };
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
  // Skipped when this round win ends the game — no next round to use the card in.
  if (!gameOver && winnerKey && ns.players[winnerKey].faction === "northern_realms" && ns.players[winnerKey].deck.length > 0) {
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

// Shared by PLAY_CARD and RESOLVE_MEDIC_REVIVE: ends the acting player's
// turn (and checks for round-end) UNLESS a Medic revive is still awaiting
// the next pick — in which case the turn stays put so the chain can
// continue without handing control to the opponent mid-resolution.
function finishTurnAfterMove(ns, actingPlayer) {
  if (ns.awaitingMedicRevive) return ns;
  // Scorch's victims are still sitting on the board mid-burn (see
  // pendingBurn) — hold the turn here too, same as a Medic chain, so the
  // opponent can't act while the fire's still playing out.
  if (ns.pendingBurn) return ns;
  if (ns.players.p1.passed && ns.players.p2.passed) return finishRound(ns);
  const nextKey = otherKey(actingPlayer);
  return { ...ns, turn: ns.players[nextKey].passed ? actingPlayer : nextKey };
}

function gameReducer(state, action) {
  // lastMedicRevive is a one-shot marker for the sound/animation diff effect
  // — it should only ever describe the card revived by the MOST RECENT
  // action. Left uncleared, a later unrelated action that happens to bring
  // that same card id back onto a board (e.g. Decoy swapping it out and back
  // in) would wrongly replay the revival cue instead of its normal sound.
  // Clearing it here, for every action except the one that just set it,
  // keeps it valid for exactly one render.
  if (state?.lastMedicRevive && action.type !== "RESOLVE_MEDIC_REVIVE") {
    state = { ...state, lastMedicRevive: null };
  }
  // lastMusterPlayed is the same kind of one-shot marker, already reset at
  // the top of resolvePlayCard on every PLAY_CARD — this just guards against
  // it lingering into some later, unrelated action (e.g. a card leaving and
  // returning to the board via Decoy) the same way lastMedicRevive is
  // guarded above.
  if (state?.lastMusterPlayed && action.type !== "PLAY_CARD") {
    state = { ...state, lastMusterPlayed: null };
  }
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
      const ns = resolvePlayCard(state, action.player, action.cardId, action.options || {});
      return finishTurnAfterMove(ns, action.player);
    }
    // Step 2 of Medic's two-step flow (see resolveMedicRevive) — one
    // dispatch per revive link, so it can be re-fired for a chained Medic
    // without switching the turn out from under the player mid-chain.
    case "RESOLVE_MEDIC_REVIVE": {
      const ns = resolveMedicRevive(state, action.player, action.reviveId);
      return finishTurnAfterMove(ns, action.player);
    }
    // Step 2 of Scorch's two-step flow (see the scorchGlobal/scorchRow/
    // scorchRowThreshold cases in resolvePlayCard): actually removes the
    // cards pendingBurn flagged, once PlayBoard's burn animation/sound has
    // had time to play out. Guarded so a stray double-dispatch (e.g. both
    // clients in Online mode racing) is a harmless no-op.
    case "RESOLVE_SCORCH_BURN": {
      if (!state.pendingBurn) return state;
      const { victims, actingPlayer } = state.pendingBurn;
      let ns = state;
      const log = [];
      Object.entries(victims).forEach(([key, ids]) => {
        if (ids && ids.length) ns = destroyCards(ns, key, ids, log);
      });
      ns = { ...ns, pendingBurn: null, log: [...ns.log, ...log] };
      return finishTurnAfterMove(ns, actingPlayer);
    }
    case "USE_LEADER": {
      if (action.options && action.options.ackReveal) {
        return withPlayer(state, action.player, (p) => ({ ...p, leaderReveal: null }));
      }
      let ns = resolveLeaderAbility(state, action.player, action.options || {});
      // Using a leader ability consumes a turn, same as playing a card or a
      // weather effect — but a scorch leader (L13/L15/L19) can leave
      // pendingBurn set, same as card Scorch, so route through the shared
      // helper to hold the turn until the burn actually resolves instead of
      // handing control to the opponent mid-animation.
      return finishTurnAfterMove(ns, action.player);
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
    awaitingMedicRevive: null,
    lastMedicRevive: null,
    lastMusterPlayed: null,
    pendingBurn: null,
    lastScorchCast: null,
    log: scoiaChooser
      ? [`${(scoiaChooser === "p1" ? p1 : p2).name}'s Scoia'tael scouts choose who opens Round 1 — no coin toss needed.`]
      : ["A new game begins. Call the coin toss to decide who opens Round 1."],
    players: { p1, p2 },
  };
}

/* Test Mode's version of initGame: both hands/decks are rigged via
   dealHandFixed instead of the random dealHand, and the pre-game starter
   choice always goes to the human (p1) — no coin toss, no faction gate —
   mirroring the Scoia'tael "choose who opens" flow regardless of faction. */
function initTestGame(p1cfg, p2cfg, p1Hand, p1Order, p2Hand, p2Order) {
  resetStartingBasicGuard();
  let p1 = dealHandFixed(makePlayer(p1cfg), p1Hand, p1Order);
  let p2 = dealHandFixed(makePlayer(p2cfg), p2Hand, p2Order);
  if (p1cfg.leaderId === "L08" || p2cfg.leaderId === "L08") {
    p1 = { ...p1, forceRandomRevive: true };
    p2 = { ...p2, forceRandomRevive: true };
  }
  return {
    phase: "scoiaChoice",
    scoiaChooser: "p1",
    round: 1,
    turn: null,
    roundWins: { p1: 0, p2: 0 },
    lastRoundScore: null,
    gameWinner: null,
    coinFlip: { caller: null, call: null, result: null, callerWon: null, starter: null, resolved: false },
    awaitingMedicRevive: null,
    lastMedicRevive: null,
    lastMusterPlayed: null,
    pendingBurn: null,
    lastScorchCast: null,
    log: ["Test Mode: choose who opens Round 1."],
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
  if (card.ability === "horn") {
    // Fixed-row units (Dandelion/Draig Bon-Dhu) are exempt entirely — units are units, not
    // specials, and never trigger or get blocked by exclusion regardless of play order. For the
    // choice-row special (Commander's Horn), both same-ability stacking (a second Horn is
    // worthless once doubling is active) and cross-ability exclusion (vs. Mardroeme) rule out a
    // row, but only against a true SPECIAL occupying it — hornCards[r]/mardroemeCards[r] track
    // specials specifically, so a fixed-row unit's own contribution never counts against either.
    const legalRows = ROWS.filter((r) => card.row || (!((board.mardroemeCards[r] || []).length > 0) && !((board.hornCards[r] || []).length > 0)));
    if (card.row) return legalRows.includes(card.row) ? {} : null;
    if (!legalRows.length) return null;
    // Heroes don't benefit from Horn at all — picking the row with the
    // highest RAW total (including Hero power) picked a row that was
    // entirely a Hero more than once in self-play (Philippa Eilhart,
    // Tibor Eggebracht), doubling nothing for zero net gain. Rank by the
    // non-Hero power actually being doubled instead.
    let best = legalRows[0], bestVal = -1;
    legalRows.forEach((r) => { const v = rowNonHeroPower(board, r); if (v > bestVal) { bestVal = v; best = r; } });
    return { chosenRow: best };
  }
  if (card.ability === "mardroeme") {
    // Same split as Horn above: fixed-row units (Ermion) are exempt entirely; the choice-row
    // special is blocked only by a true SPECIAL in the row (hornCards[r]/mardroemeCards[r]), so
    // a unit's own ability contribution never counts against it either way.
    const legalRows = ROWS.filter((r) => card.row || (!((board.hornCards[r] || []).length > 0) && !((board.mardroemeCards[r] || []).length > 0)));
    if (card.row) return legalRows.includes(card.row) ? {} : null;
    if (!legalRows.length) return null;
    let best = legalRows[0], bestCount = -1;
    legalRows.forEach((r) => {
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
const LEADER_ALWAYS_GOOD_EARLY = new Set(["L03", "L04", "L06", "L10", "L11", "L14", "L16", "L18", "L20"]);

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
    case "L22": // King Bran — only matters if a unit on our OWN board is actually
      // being weathered (flattened to 1); Heroes are weather-immune and a
      // printed-0-power card has nothing to lose, so neither counts.
      return ROWS.some((r) => me.board.weather[r] && me.board[r].some((id) => {
        const c = cardById(id);
        return c && c.cardType !== "Hero" && c.power > 0;
      }));
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

// ==========================================================================
// Ability icon SVGs (Muster & Morale) — popped up over a card via
// .anim-ability-icon-pop when triggerAbilityFx sets that card's fxClass.
// ==========================================================================

// Muster Icon: Twin Knights (game-icons.net "buddy knight" design, CC
// Attribution). Original 850x650 artwork uniformly scaled + centered into
// the shared 0 0 100 100 ability-icon viewBox; a mask carves the same
// front-visor cutout the source SVG uses to separate the two helmets.
// Note: the source path data for the chainmail/visor grid texture on the
// helmets was corrupted in the copy Kareem supplied (stray characters break
// a few path commands), so that texture is omitted here — silhouette reads
// fine at ability-icon size regardless.
function MusterIconSVG() {
  return (
    <svg viewBox="0 0 100 100" className="ability-icon-svg" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <mask id="musterAbilityCutout">
          <path fill="#fff" d="M0 0h850v650H0z" />
          <path fill="none" stroke="#000" strokeLinecap="round" strokeLinejoin="round" strokeWidth="50" d="M442 435c55 15 70 115 70 215" />
        </mask>
      </defs>
      <g filter="drop-shadow(0px 3px 6px rgba(0,0,0,0.9))" transform="translate(0 11.7647) scale(0.117647)">
        <g mask="url(#musterAbilityCutout)" fill="#FFFFFF" stroke="#1A1A1A" strokeWidth="21">
          <path d="M604.8 92.8c-29.157 0-58.611 10.746-111.976 32h223.952c-53.366-21.254-82.82-32-111.976-32m-128.525 44.8L451.2 438.4c44.8 22.4 89.6 25.2 134.4 25.55V272h-96v-38.4H720V272h-96v191.95c44.8-.35 89.6-3.15 134.4-25.55l-25.075-300.8zM598.4 272v192" />
          <path d="M456 428c-44 12-56 92-56 172h409.6c0-80-12-160-56-172-41.6 52-89.6 76-148.8 76S497.6 480 456 428" />
        </g>
        <path fill="#FFFFFF" stroke="#1A1A1A" strokeWidth="21" d="M256 16c-36.446 0-73.264 13.433-139.97 40h279.94C329.263 29.433 292.445 16 256 16M95.344 72 64 448c56 28 112 31.5 168 31.938V240H112v-48h288v48H280v239.938C336 479.5 392 476 448 448L416.656 72zM248 240v240" />
        <path fill="#FFFFFF" stroke="#1A1A1A" strokeWidth="21" d="M70 435C15 450 0 550 0 650h512c0-100-15-200-70-215-52 65-112 95-186 95s-134-30-186-95" />
      </g>
    </svg>
  );
}

// Morale Icon: White Cross Flanked by Double Chevrons (< + >)
function MoraleIconSVG() {
  return (
    <svg viewBox="0 0 100 100" className="ability-icon-svg" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g filter="drop-shadow(0px 3px 6px rgba(0,0,0,0.9))">
        <path d="M18 38 L10 50 L18 62 M28 38 L20 50 L28 62" stroke="#FFFFFF" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M42 32 H58 V42 H68 V58 H58 V68 H42 V58 H32 V42 H42 Z" fill="#FFFFFF" stroke="#1A1A1A" strokeWidth="2.5" />
        <path d="M72 38 L80 50 L72 62 M82 38 L90 50 L82 62" stroke="#FFFFFF" strokeWidth="5.5" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

// Bond Icon: Clasped Handshake, popped up over the card the same way as
// Muster/Morale via .anim-ability-icon-pop when a card-bond-glow fx fires.
// Path data is a vaadin-icons handshake glyph (Apache License 2.0,
// https://github.com/vaadin/vaadin-icons), svgo-optimized and uniformly
// scaled from its native 16x16 viewBox up into the shared 0 0 100 100
// ability-icon viewBox, with a matching dark outline added so it reads
// consistently with MusterIconSVG/MoraleIconSVG when popped up over card art.
function BondIconSVG() {
  return (
    <svg viewBox="0 0 100 100" className="ability-icon-svg" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g filter="drop-shadow(0px 3px 6px rgba(0,0,0,0.9))" transform="scale(6.25)">
        <path fill="#FFFFFF" stroke="#1A1A1A" strokeWidth="0.26" strokeLinejoin="round" d="M13 3a5.4 5.4 0 0 1-1.902 1.178c-.748.132-2.818-.828-3.838.152-.17.17-.38.34-.6.51-.48-.21-1.22-.53-1.76-.84S3 3 3 3L0 6.5s.74 1 1.2 1.66c.3.44.67 1.11.91 1.56l-.34.4a.88.88 0 0 0 .15 1 .83.83 0 0 0 1.002-.002.62.62 0 0 0 .077.881 1 1 0 0 0 1.006-.002.806.806 0 0 0-.003 1.005 1.01 1.01 0 0 0 .892-.114.82.82 0 0 0 .187.912 1.1 1.1 0 0 0 1.054-.092l.516-.467c.472.47 1.123.761 1.842.761l.061-.001a1.31 1.31 0 0 0 1.094-.791c.146.056.312.094.488.094.236 0 .455-.068.64-.185.585-.387.445-.687.445-.687a1.07 1.07 0 0 0 1.229-.279.996.996 0 0 0 .138-1.215.04.04 0 0 0 .021.005c.421 0 .787-.232.978-.574a1.56 1.56 0 0 0-.191-1.48l.003.005c.82-.16.79-.57 1.19-1.17a4.7 4.7 0 0 1 1.387-1.208zm-.05 7.06c-.44.44-.78.25-1.53-.32S9.18 8.1 9.18 8.1c.061.305.202.57.401.781.319.359 1.269 1.179 1.719 1.599.28.26 1 .78.58 1.18s-.75 0-1.44-.56-2.23-1.94-2.23-1.94l-.002.059c0 .258.104.491.272.661.17.2 1.12 1.12 1.52 1.54s.75.67.41 1-1.03-.19-1.41-.58c-.59-.57-1.76-1.63-1.76-1.63l-.001.053c0 .284.098.544.263.75.288.378.848.868 1.188 1.248s.54.7 0 1-1.34-.44-1.69-.8v-.002a.4.4 0 0 0-.1-.269.9.9 0 0 0-.906-.188A.61.61 0 0 0 6 11.1a.754.754 0 0 0-.912.001.61.61 0 0 0-.085-.95 1 1 0 0 0-1.174.08.66.66 0 0 0-.068-.911 1 1 0 0 0-1.186-.128L1.91 8.069c-.46-.73-1-1.49-1-1.49l2.28-2.77s.81.5 1.48.88c.33.19.9.44 1.33.64-.68.51-1.25 1-1.08 1.34a1.83 1.83 0 0 0 2.087.036 2.4 2.4 0 0 1 1.343-.403c.347 0 .677.072.976.203.554.374 1.574 1.294 2.504 1.874 1.17.85 1.4 1.4 1.12 1.68z" />
      </g>
    </svg>
  );
}

// ==========================================================================
// Scorch fire overlay — rendered inside CardTile whenever fxClass is
// "card-burning", on top of the existing cardBurn char/darken animation
// (see the CSS block). Flame tongues + rising embers + escaping smoke.
// ==========================================================================
function ScorchFireOverlay({ emberCount = 14 }) {
  const embers = React.useMemo(() => Array.from({ length: emberCount }, (_, i) => ({
    left: 10 + (i / emberCount) * 80 + (Math.random() * 6 - 3),
    animationDelay: (i % 7) * 0.13,
    animationDuration: 0.75 + (i % 4) * 0.18,
    size: 3 + (i % 3),
  })), [emberCount]);
  return (
    <div className="scorch-card-container">
      <div className="scorch-char-mask" />
      <div className="scorch-fire-core" />
      <div className="scorch-top-smoke" />
      <svg className="flame-layer flame-layer-back" viewBox="0 0 100 120" preserveAspectRatio="none">
        <path
          d="M0 120 L0 70 C10 50, 15 80, 25 40 C35 70, 40 30, 50 60 C60 20, 70 65, 75 35 C85 75, 90 45, 100 65 L100 120 Z"
          fill="url(#fireGradientBack)"
        />
        <defs>
          <linearGradient id="fireGradientBack" x1="0%" y1="100%" x2="0%" y2="0%">
            <stop offset="0%" stopColor="#ff1a00" stopOpacity="1" />
            <stop offset="50%" stopColor="#ff6600" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#cc0000" stopOpacity="0" />
          </linearGradient>
        </defs>
      </svg>
      <svg className="flame-layer flame-layer-front" viewBox="0 0 100 120" preserveAspectRatio="none">
        <path
          d="M5 120 L5 80 C15 65, 20 90, 30 50 C40 85, 48 40, 58 75 C68 35, 78 80, 85 50 C92 80, 95 65, 95 120 Z"
          fill="url(#fireGradientFront)"
        />
        <defs>
          <linearGradient id="fireGradientFront" x1="0%" y1="100%" x2="0%" y2="0%">
            <stop offset="0%" stopColor="#ffff00" stopOpacity="1" />
            <stop offset="45%" stopColor="#ff9900" stopOpacity="0.95" />
            <stop offset="85%" stopColor="#ff3300" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#ff0000" stopOpacity="0" />
          </linearGradient>
        </defs>
      </svg>
      {embers.map((e, i) => (
        <div
          key={i}
          className="ember-particle"
          style={{
            left: `${e.left}%`,
            animationDelay: `${e.animationDelay}s`,
            animationDuration: `${e.animationDuration}s`,
            width: `${e.size}px`,
            height: `${e.size}px`,
          }}
        />
      ))}
    </div>
  );
}

// ==========================================================================
// Continuous weather overlays (rows & active weather-card slots)
// ==========================================================================

function RainOverlay({ streakCount = 20 }) {
  const streaks = React.useMemo(() => Array.from({ length: streakCount }, (_, i) => ({
    left: (i / streakCount) * 100 + (Math.random() * 4 - 2),
    animationDelay: (i % 5) * 0.08,
    animationDuration: 0.36 + (i % 3) * 0.08,
  })), [streakCount]);
  return (
    <div className="weather-rain-container">
      {streaks.map((s, i) => (
        <div
          key={i}
          className="rain-streak"
          style={{
            left: `${s.left}%`,
            animationDelay: `${s.animationDelay}s`,
            animationDuration: `${s.animationDuration}s`
          }}
        />
      ))}
    </div>
  );
}

function FrostOverlay({ flakeCount = 14 }) {
  const flakes = ['❄', '❅', '❆'];
  const particles = React.useMemo(() => Array.from({ length: flakeCount }, (_, i) => ({
    left: (i / flakeCount) * 100 + (Math.random() * 3 - 1.5),
    animationDelay: (i % 5) * 0.45,
    animationDuration: 2.2 + (i % 4) * 0.3,
  })), [flakeCount]);
  return (
    <div className="weather-frost-container">
      {particles.map((p, i) => (
        <div
          key={i}
          className="snowflake-particle"
          style={{
            left: `${p.left}%`,
            animationDelay: `${p.animationDelay}s`,
            animationDuration: `${p.animationDuration}s`
          }}
        >
          {flakes[i % 3]}
        </div>
      ))}
    </div>
  );
}

// Impenetrable Fog — volumetric swirling vortex, replacing the old sliding
// gradient-band version. Three independent SVG stroke-swirls rotate/drift
// at different speeds and opacities so it reads as wispy rolling mist
// instead of a flat strip sliding across the row.
function SwirlingFogOverlay() {
  return (
    <div className="weather-fog-swirl-container">
      <svg className="fog-vortex-layer fog-vortex-1" viewBox="0 0 200 200">
        <g fill="none" stroke="rgba(220, 235, 245, 0.45)" strokeWidth="18" strokeLinecap="round">
          <path d="M 100,100 A 30,30 0 0,1 130,100 A 55,55 0 0,1 75,130 A 80,80 0 0,1 40,60" />
          <path d="M 100,100 A 25,25 0 0,0 75,100 A 50,50 0 0,0 125,70 A 75,75 0 0,0 160,140" />
        </g>
      </svg>
      <svg className="fog-vortex-layer fog-vortex-2" viewBox="0 0 200 200">
        <g fill="none" stroke="rgba(180, 200, 215, 0.5)" strokeWidth="22" strokeLinecap="round">
          <path d="M 100,100 A 35,35 0 0,0 100,135 A 65,65 0 0,0 150,60 A 90,90 0 0,0 50,40" />
          <path d="M 100,100 A 20,20 0 0,1 120,100 A 45,45 0 0,1 70,140 A 70,70 0 0,1 30,80" />
        </g>
      </svg>
      <svg className="fog-vortex-layer fog-vortex-3" viewBox="0 0 200 200">
        <g fill="none" stroke="rgba(235, 245, 250, 0.35)" strokeWidth="28" strokeLinecap="round">
          <path d="M 100,100 A 45,45 0 0,1 145,100 A 75,75 0 0,1 60,165 A 100,100 0 0,1 20,60" />
        </g>
      </svg>
    </div>
  );
}

// Row key -> matching continuous overlay component. Only used for the
// actual board rows now — the center "weather cards" slot shows plain
// card art with no animated overlay (see WeatherCenterCell).
const WEATHER_OVERLAY_BY_ROW = { close: FrostOverlay, ranged: SwirlingFogOverlay, siege: RainOverlay };

function CardTile({ card, size = "md", onClick, disabled, selected, faded, justPlayed, justRevived, arriving, sweeping, fxClass, thumbOverride, style, side }) {
  const [artStage, setArtStage] = useState(0); // 0 = primary CDN, 1 = raw GitHub fallback, 2 = give up — art shown on the face-up tile itself
  // thumbOverride lets a caller (e.g. the horn/mardroeme row-marker slot) show a generic
  // stand-in image on the tile face while the zoom-in modal still shows the real card's
  // own art. When absent, zoom art is identical to tile art, same as before this existed.
  const [zoomArtStage, setZoomArtStage] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  const touchTimer = useRef(null);
  if (!card) return null;
  const fmeta = FACTION_META[card.faction] || FACTION_META.neutral;
  const rmeta = ROW_META[card.row];
  const isLeader = card.cardType === "Leader";
  const isSpecial = card.cardType === "Special";
  const thumbCard = thumbOverride || card;
  const src = artStage === 0 ? imgSrc(thumbCard, IMAGE_BASE_URL) : artStage === 1 ? imgSrc(thumbCard, IMAGE_FALLBACK_BASE_URL) : null;
  const zoomSrc = !thumbOverride
    ? src
    : (zoomArtStage === 0 ? imgSrc(card, IMAGE_BASE_URL) : zoomArtStage === 1 ? imgSrc(card, IMAGE_FALLBACK_BASE_URL) : null);
  const abilityLabel = card.ability && ABILITY_LABEL[card.ability];
  const fitStyle = { "--accent": fmeta.color, "--row-accent": rmeta ? rmeta.color : fmeta.color, ...style };
  // Kept in the DOM (and in its normal layout slot — MedicRevivalGhost
  // measures this exact element's rect as its landing target) but invisible
  // until the ghost clone actually arrives, so the player never sees the
  // real card and the flying ghost at the same time.
  if (arriving || sweeping) fitStyle.opacity = 0;

  const clearTouchTimer = () => { if (touchTimer.current) { clearTimeout(touchTimer.current); touchTimer.current = null; } };
  // Desktop: press and hold the card for 2s to zoom.
  const handleMouseDown = () => {
    clearTouchTimer();
    touchTimer.current = setTimeout(() => setZoomed(true), 2000);
  };
  const handleMouseUp = () => { clearTouchTimer(); };
  const handleMouseLeave = () => { clearTouchTimer(); };
  // Touch devices: keep the long-press as the equivalent trigger.
  const handleTouchStart = () => {
    clearTouchTimer();
    touchTimer.current = setTimeout(() => setZoomed(true), 500);
  };
  const handleTouchEnd = () => { clearTouchTimer(); };

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
          (justRevived ? " card-just-revived" : "") +
          (card.cardType === "Hero" ? " is-hero" : "") +
          (artStage === 2 ? " no-art" : "") +
          (fxClass ? " " + fxClass : "") +
          ((fxClass === "card-muster-pop" || fxClass === "card-muster-glow") ? " anim-muster-summon-glow" : "")
        }
        style={fitStyle}
        data-card-id={card.id}
        data-card-side={side}
        onClick={disabled ? undefined : onClick}
        aria-disabled={disabled || undefined}
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {src ? (
          <div className="card-art-clip">
            <img
              className="card-art"
              src={src}
              alt={card.name}
              decoding="async"
              loading="eager"
              onError={() => setArtStage((s) => s + 1)}
            />
          </div>
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
        {fxClass === "card-burning" && <ScorchFireOverlay />}
        {fxClass === "card-muster-pop" && (
          <div className="anim-ability-icon-pop"><MusterIconSVG /></div>
        )}
        {fxClass === "card-morale-boost" && (
          <div className="anim-ability-icon-pop"><MoraleIconSVG /></div>
        )}
        {fxClass === "card-morale-plus-one" && (
          <div className="anim-morale-plus-one">+1</div>
        )}
        {fxClass === "card-bond-glow" && (
          <div className="anim-ability-icon-pop"><BondIconSVG /></div>
        )}
      </button>
      {zoomed && createPortal(
        <div className="card-zoom-overlay" onClick={(e) => { e.stopPropagation(); setZoomed(false); }}>
          <div className="card-zoom-content" onClick={(e) => e.stopPropagation()}>
            <div className="card-zoom-art-wrap">
              {zoomSrc ? (
                <img
                  className="card-zoom-art"
                  src={zoomSrc}
                  alt={card.name}
                  decoding="async"
                  loading="eager"
                  onError={thumbOverride ? () => setZoomArtStage((s) => s + 1) : undefined}
                />
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
        </div>,
        document.querySelector(".gwent-root") || document.body
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
// available; disappears the moment it's been used. Turns red (via `noop`)
// when the ability is technically available but its live precondition isn't
// met right now, so firing it would just burn it for nothing — see
// leaderConditionMet, shared with the AI's own fire-timing logic.
function LeaderUnusedBadge({ show, noop }) {
  const [artStage, setArtStage] = useState(0);
  if (!show || artStage === 2) return null;
  const url = noop ? LEADER_NOOP_ICON_URL : LEADER_UNUSED_ICON_URL;
  const fallbackUrl = noop ? LEADER_NOOP_ICON_FALLBACK_URL : LEADER_UNUSED_ICON_FALLBACK_URL;
  const src = artStage === 0 ? url : fallbackUrl;
  return (
    <img
      className="leader-unused-badge"
      src={src}
      alt={noop ? "Leader ability available, but nothing to target right now" : "Leader ability available"}
      title={noop ? "This leader wouldn't do anything if used right now" : undefined}
      decoding="async"
      loading="eager"
      onError={() => setArtStage((s) => s + 1)}
    />
  );
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
// Generic stand-in art shown on the row-marker slot itself — the real numbered
// copy (Commander's Horn 1/2/3, Mardroeme 1/2/3) still shows up when the
// marker is clicked/long-pressed to zoom, via CardTile's thumbOverride.
const HORN_PLACED_THUMB = { faction: "neutral", img: "horn_placed.jpg" };
const MARDROEME_PLACED_THUMB = { faction: "skellige", img: "mardroeme_placed.jpg" };

// Per-side, per-row vertical nudge for the horn/mardroeme marker's own
// card art (overrides the slot's general .horn-card-slot-my/-opp margin via
// inline style, since "my" siege/ranged and "opp" siege/ranged each need a
// slightly different nudge — tuned live in DevTools, see chat history).
const HORN_CARD_MARGIN_TOP = {
  my: { siege: "10%", ranged: "10%" },
  opp: { siege: "9%", ranged: "5%" },
};

function RowHornCell({ board, rowKey, side, hiddenIds }) {
  const hornCardIds = board.hornCards?.[rowKey] || [];
  const mardroemeCardIds = board.mardroemeCards?.[rowKey] || [];
  if (!hornCardIds.length && !mardroemeCardIds.length) return null;
  const slotClass = "horn-card-slot" + (side ? " horn-card-slot-" + side : "");
  const marginTop = side ? HORN_CARD_MARGIN_TOP[side]?.[rowKey] : undefined;
  const cardStyle = marginTop ? { marginTop } : undefined;
  return (
    <div className="row-markers">
      {hornCardIds.map((id, i) => (
        <div key={"h-" + id + "-" + i} className={slotClass}>
          <CardTile card={cardById(id)} size="fit" sweeping={!!hiddenIds?.has(id)} thumbOverride={HORN_PLACED_THUMB} style={cardStyle} />
        </div>
      ))}
      {mardroemeCardIds.map((id, i) => (
        <div key={"m-" + id + "-" + i} className={slotClass + " mardroeme-card-slot"}>
          <CardTile card={cardById(id)} size="fit" sweeping={!!hiddenIds?.has(id)} thumbOverride={MARDROEME_PLACED_THUMB} style={cardStyle} />
        </div>
      ))}
    </div>
  );
}

// The row's actual cards (renamed from the old BoardRow's inline JSX).
function RowCardsCell({ board, rowKey, onClickCard, selectableIds, flashId, revivedId, arrivingId, cardFx, side, hornGlow, hiddenIds }) {
  const meta = ROW_META[rowKey];
  const cardIds = board[rowKey];
  const weathered = !!board.weather[rowKey];
  const WeatherOverlay = weathered ? WEATHER_OVERLAY_BY_ROW[rowKey] : null;
  return (
    <div
      className={
        "row-cards row-" + rowKey +
        (hornGlow ? " row-horn-glow" : "")
      }
      style={{ "--row-accent": meta.color }}
    >
      {WeatherOverlay && <WeatherOverlay />}
      {cardIds.length === 0 && <span className="row-empty">no units</span>}
      {cardIds.length > 0 && cardIds.map((id) => {
        const fxKey = side + ":" + id;
        return (
        <div key={id} className="row-card-slot">
          <CardTile
            card={cardById(id)}
            size="fit"
            side={side}
            onClick={onClickCard ? () => onClickCard(id, rowKey) : undefined}
            disabled={cardFx?.[fxKey] === "card-burning" ? true : (selectableIds ? !selectableIds.includes(id) : !onClickCard)}
            justPlayed={id === flashId}
            justRevived={id === revivedId}
            arriving={id === arrivingId}
            sweeping={!!hiddenIds?.has(id)}
            fxClass={cardFx ? cardFx[fxKey] : null}
          />
        </div>
        );
      })}
    </div>
  );
}

/* Medic revival's actual "flies from the discard pile to the row" motion —
   a fixed-size ghost clone, absolutely positioned as a sibling of the board
   table (see .medic-ghost-layer, rendered directly inside .board-frame) so
   it's never inside any row's own overflow:hidden box and never gets
   clipped mid-flight the way animating the real in-row tile did.
   `frameRef` locates the destination card (already landed, real, and
   fully rendered — see data-card-id on CardTile) and measures its rect
   relative to .board-frame on mount; `fromRect` (the discard pile's rect,
   same coordinate space) was already captured by the caller. Classic FLIP:
   render at the DESTINATION rect from frame 1, apply an inverse
   translate+scale so it visually sits at the origin, then clear that
   transform next frame and let the transition animate it home. Unmounts
   itself via onDone once landed — by then it's pixel-identical to the real
   tile sitting underneath it, so the swap is invisible. */
function MedicRevivalGhost({ card, fromRect, cardId, frameRef, onDone }) {
  const [toRect, setToRect] = useState(null);
  const [flying, setFlying] = useState(false);
  useEffect(() => {
    const el = document.querySelector(`[data-card-id="${cardId}"]`);
    const frame = frameRef.current;
    if (!el || !frame) { onDone && onDone(); return; }
    const elRect = el.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    setToRect({ left: elRect.left - frameRect.left, top: elRect.top - frameRect.top, width: elRect.width, height: elRect.height });
    const raf = requestAnimationFrame(() => setFlying(true));
    const t = setTimeout(() => onDone && onDone(), 620);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId]);
  if (!card || !toRect) return null;
  const dx = fromRect.left - toRect.left;
  const dy = fromRect.top - toRect.top;
  const sx = fromRect.width / toRect.width;
  const sy = fromRect.height / toRect.height;
  return (
    <div
      className="medic-ghost-card"
      style={{
        left: toRect.left, top: toRect.top, width: toRect.width, height: toRect.height,
        transformOrigin: "top left",
        transform: flying ? "translate(0px, 0px) scale(1, 1)" : `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
        transition: flying ? "transform 0.55s cubic-bezier(0.2, 0.7, 0.3, 1)" : "none",
      }}
    >
      <CardTile card={card} size="fit" />
    </div>
  );
}

/* Round-end / game-end "sweep" ghost — cards flying off the board into a
   pile (discard on a normal round end, deck on the game-ending round; see
   PlayBoard's sweep state + trigger effect). Unlike MedicRevivalGhost this
   flies AWAY from a real rendered card rather than TO one, so there's no
   destination tile to snap onto — it just fades out once it lands instead
   of unmounting into a real card underneath it. `fromRect`/`toRect` are
   both already relative to .board-frame (captured by the trigger effect via
   lastPlaySnapshotRef and the discard-/deck-pile elements respectively).
   `flip` (deck sweep only) swaps the face for the card-back art partway
   through the flight via a scaleX squash — a cheap 2D stand-in for a real
   3D flip that's plenty convincing at this size and doesn't need a
   duplicate back-face element mirrored under the front one. */
function SweepGhost({ card, faction, fromRect, toRect, flip, faceDown, delayMs }) {
  const [flying, setFlying] = useState(false);
  const [showBack, setShowBack] = useState(!!faceDown);
  useEffect(() => {
    const t1 = setTimeout(() => setFlying(true), delayMs || 0);
    const t2 = flip ? setTimeout(() => setShowBack(true), (delayMs || 0) + 330) : null;
    return () => { clearTimeout(t1); if (t2) clearTimeout(t2); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!fromRect || !toRect) return null;
  const back = backImgSrc(faction, IMAGE_BASE_URL);
  return (
    <div
      className="sweep-ghost-card"
      style={{
        left: flying ? toRect.left : fromRect.left,
        top: flying ? toRect.top : fromRect.top,
        width: flying ? toRect.width : fromRect.width,
        height: flying ? toRect.height : fromRect.height,
        opacity: flying ? 0 : 1,
      }}
    >
      <div className={"sweep-ghost-inner" + (flip ? " sweep-ghost-flip" : "")}>
        {showBack || !card ? (
          <img className="card-back-img" src={back} alt="" />
        ) : (
          <CardTile card={card} size="fit" />
        )}
      </div>
    </div>
  );
}

/* Lobe config for each smoke type — several irregular, offset, rotated
   "puffs" (not one flat gradient) so the smoke reads as billowing and
   asymmetric, per-type color palette. Same idea as the reference snippet's
   GreySmokeOverlay/RedSmokeOverlay, generalized to data + one renderer so
   spy/decoy/transform all share the same billow mechanics and only the
   colors/rotation direction differ. */
const SMOKE_LOBE_CONFIG = {
  spy: {
    animClass: "anim-smoke-billow-grey",
    core: "radial-gradient(circle, #121315 0%, #3a3d42 60%, #1a1c1e 100%)",
    lobes: [
      { top: "-5%", left: "-10%", width: "85%", height: "85%", background: "radial-gradient(circle, #4a4e54 0%, #1e2023 70%)", borderRadius: "40% 60% 50% 50%", blur: "6px", rotate: "20deg" },
      { bottom: "-8%", right: "-10%", width: "90%", height: "85%", background: "radial-gradient(circle, #5a5f66 0%, #25282c 75%)", borderRadius: "60% 40% 70% 30%", blur: "7px", rotate: "-35deg" },
      { top: "-8%", right: "-5%", width: "80%", height: "80%", background: "radial-gradient(circle, #34373c 0%, #111214 80%)", borderRadius: "50%", blur: "5px" },
      { bottom: "-5%", left: "-5%", width: "75%", height: "75%", background: "radial-gradient(circle, #2d3035 0%, #161719 75%)", borderRadius: "50% 50% 30% 70%", blur: "6px" },
    ],
    highlight: "radial-gradient(circle, rgba(115, 120, 130, 0.9) 0%, transparent 70%)",
  },
  decoy: {
    animClass: "anim-smoke-billow-grey",
    core: "radial-gradient(circle, #d4d6d9 0%, #f0f1f2 60%, #c6c8cc 100%)",
    lobes: [
      { top: "-5%", left: "-10%", width: "85%", height: "85%", background: "radial-gradient(circle, #eceef0 0%, #cfd1d5 70%)", borderRadius: "40% 60% 50% 50%", blur: "6px", rotate: "20deg" },
      { bottom: "-8%", right: "-10%", width: "90%", height: "85%", background: "radial-gradient(circle, #f5f6f7 0%, #d8dade 75%)", borderRadius: "60% 40% 70% 30%", blur: "7px", rotate: "-35deg" },
      { top: "-8%", right: "-5%", width: "80%", height: "80%", background: "radial-gradient(circle, #e0e2e5 0%, #c2c4c8 80%)", borderRadius: "50%", blur: "5px" },
      { bottom: "-5%", left: "-5%", width: "75%", height: "75%", background: "radial-gradient(circle, #dadcdf 0%, #bfc1c5 75%)", borderRadius: "50% 50% 30% 70%", blur: "6px" },
    ],
    highlight: "radial-gradient(circle, rgba(255, 255, 255, 0.95) 0%, transparent 70%)",
  },
  transform: {
    animClass: "anim-smoke-billow-red",
    core: "radial-gradient(circle, #2b0000 0%, #8b0000 55%, #150000 100%)",
    lobes: [
      { top: "-12%", left: "0%", width: "90%", height: "85%", background: "radial-gradient(circle, #a80a0a 0%, #3d0202 75%)", borderRadius: "50% 50% 40% 60%", blur: "6px", rotate: "-15deg" },
      { bottom: "-12%", right: "-12%", width: "90%", height: "90%", background: "radial-gradient(circle, #6b0404 0%, #1a0000 80%)", borderRadius: "60% 40% 50% 50%", blur: "7px", rotate: "40deg" },
      { top: "-5%", right: "-5%", width: "75%", height: "75%", background: "radial-gradient(circle, #800000 0%, #200000 80%)", borderRadius: "50%", blur: "5px" },
      { bottom: "-5%", left: "-5%", width: "80%", height: "80%", background: "radial-gradient(circle, #400000 0%, #0a0000 85%)", borderRadius: "50%", blur: "6px" },
    ],
    highlight: "radial-gradient(circle, rgba(225, 30, 30, 0.85) 0%, transparent 65%)",
  },
};

/* Spy / Decoy / Mardroeme's smoke cloud — same escape-the-clipping trick as
   MedicRevivalGhost above, but simpler: the card doesn't move, so this just
   measures the real tile's rect once on mount (relative to .board-frame)
   and paints an oversized, unclipped, opaque billowing cloud on top of it
   (several offset/rotated lobes, not one flat gradient — see
   SMOKE_LOBE_CONFIG), then unmounts itself via onDone after `ms` (the exact
   sound duration it's synced to — see SOUND_DURATIONS_MS / triggerAbilityFx).
   Duration is passed through as a CSS custom property rather than
   hardcoded per-type keyframe timings, so it always stays exactly in
   lockstep with the sound regardless of which of the three types it is. */
function AbilitySmokeGhost({ cardId, side, type, ms, frameRef, onDone }) {
  const [rect, setRect] = useState(null);
  useEffect(() => {
    // Scoped by side as well as id — the same card id can exist on both
    // boards (or twice on one, via Bond) at once, and an id-only selector
    // would grab whichever matching tile happens to come first in the DOM.
    const el = document.querySelector(`[data-card-id="${cardId}"][data-card-side="${side}"]`);
    const frame = frameRef.current;
    if (!el || !frame) { onDone && onDone(); return; }
    const elRect = el.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    setRect({ left: elRect.left - frameRect.left, top: elRect.top - frameRect.top, width: elRect.width, height: elRect.height });
    const t = setTimeout(() => onDone && onDone(), ms);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId]);
  if (!rect) return null;
  const cfg = SMOKE_LOBE_CONFIG[type];
  if (!cfg) return null;
  return (
    <div className="smoke-cloud-anchor" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
      <div className={"smoke-viewport-unclipped " + cfg.animClass} style={{ "--smoke-dur": (ms / 1000) + "s" }}>
        <div className="smoke-lobe smoke-core" style={{ background: cfg.core }} />
        {cfg.lobes.map((l, i) => (
          <div
            key={i}
            className="smoke-lobe"
            style={{
              top: l.top, left: l.left, bottom: l.bottom, right: l.right,
              width: l.width, height: l.height, background: l.background,
              borderRadius: l.borderRadius, filter: `blur(${l.blur})`,
              transform: l.rotate ? `rotate(${l.rotate})` : undefined,
            }}
          />
        ))}
        <div className="smoke-lobe smoke-highlight" style={{ background: cfg.highlight }} />
      </div>
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
  // no single "you" to judge the outcome against). Used to also skip
  // whenever isGameEnd was true, which silently ate the round win/loss
  // clip on the round that actually ends the match — now it always plays
  // here too; the board-sweep animation (see PlayBoard) waits for this
  // clip to actually finish before it starts.
  const firedRef = useRef(null);
  useEffect(() => {
    if (!viewerName || isTie || firedRef.current === round) return;
    firedRef.current = round;
    playSound(roundWinnerName === viewerName ? "wonRound" : "roundLoss");
  }, [round, isTie, roundWinnerName, viewerName]);
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
        {hideButton && <div className="hint">{isGameEnd ? "Revealing results…" : "Next round starting…"}</div>}
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

/* Test Mode: pick cards from a pool, in click order. Used both for rigging
   a starting hand (exactly HAND_SIZE) and for rigging the draw order (any
   count, 0..pool.length). Clicking a picked card in the strip un-picks it;
   everything else in `pool` stays choosable. */
function CardPickerPanel({ playerLabel, instruction, pool, picked, onPick, onUnpick, minCount, maxCount, onDone, onBack }) {
  const [query, setQuery] = useState("");
  const available = useMemo(
    () => pool.filter((id) => !picked.includes(id) && (cardById(id)?.name || "").toLowerCase().includes(query.toLowerCase())),
    [pool, picked, query]
  );
  const atMax = maxCount != null && picked.length >= maxCount;
  const canDone = picked.length >= (minCount ?? 0) && (maxCount == null || picked.length <= maxCount);
  return (
    <div className="screen deckbuilder">
      {onBack && <button type="button" className="btn btn-sm deckbuilder-back" onClick={onBack}>← Back</button>}
      <h2 className="screen-title">{playerLabel}</h2>
      <p className="mulligan-hint">{instruction}</p>
      <div className="deck-count">
        Picked: <strong>{picked.length}</strong>{maxCount != null ? ` / ${maxCount}` : ""}
      </div>
      {picked.length > 0 && (
        <div className="hand-grid">
          {picked.map((id, i) => (
            <div key={id} style={{ position: "relative" }}>
              <span
                style={{
                  position: "absolute", top: 2, left: 2, zIndex: 2,
                  background: "var(--accent, #c9a227)", color: "#000",
                  borderRadius: "50%", width: 20, height: 20, fontSize: 12,
                  display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700,
                }}
              >
                {i + 1}
              </span>
              <CardTile card={cardById(id)} size="sm" selected onClick={() => onUnpick(id)} />
            </div>
          ))}
        </div>
      )}
      <input
        className="search-input"
        placeholder="Search cards…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="pool-grid">
        {available.map((id) => (
          <CardTile key={id} card={cardById(id)} size="sm" disabled={atMax} onClick={() => !atMax && onPick(id)} />
        ))}
      </div>
      <div className="deckbuilder-footer">
        <button type="button" className="btn btn-gold btn-lg" disabled={!canDone} onClick={onDone}>Confirm</button>
        {!canDone && minCount > 0 && <span className="hint">Pick at least {minCount} card{minCount === 1 ? "" : "s"}.</span>}
      </div>
    </div>
  );
}

/* Pre-game coin toss. One player calls heads/tails, then anyone flips the
   coin; whoever called it right chooses who opens Round 1. */
function CoinFlipPanel({ coinFlip, myKey, oppName, myName, isMyCallTurn, onCall, onFlip, onAck, singleDeviceLabel }) {
  const { caller, call, result, callerWon, starter, resolved } = coinFlip;

  // The coin should visually spin (and play coin.m4a) only once the flip has
  // actually happened — not while just sitting there waiting for someone to
  // press "Flip the coin". `resolved` in game state flips true the instant
  // the flip is dispatched (no artificial delay there — other logic reads
  // it too), so the reveal delay lives here in the UI instead: catch
  // `resolved` going false -> true, play the sound, and hold off showing the
  // result text for exactly as long as the clip runs. This is keyed off the
  // state transition rather than the raw click, so in online mode the
  // player who ISN'T the one clicking (they just see "Waiting for X to
  // flip…") gets the same synced spin+sound the instant it resolves on
  // their screen too, not just the one who pressed the button.
  const [showResult, setShowResult] = useState(false);
  // Fires whenever `resolved` is true and hasn't been "played" yet, rather
  // than only catching a false->true transition. If this panel unmounts and
  // remounts already-resolved (e.g. a PassDeviceGate gets interposed between
  // the flip and the reveal when the device needs to change hands), a
  // transition-only check would never fire and the coin would spin forever.
  const playedRef = useRef(false);
  useEffect(() => {
    if (resolved && !playedRef.current) {
      playedRef.current = true;
      playSound("coin");
      const t = setTimeout(() => setShowResult(true), SOUND_DURATIONS_MS.coin);
      return () => clearTimeout(t);
    }
    if (!resolved) playedRef.current = false;
  }, [resolved]);

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
        <div className="coin" />
        {onFlip ? (
          <button type="button" className="btn btn-gold btn-lg" onClick={onFlip}>Flip the coin</button>
        ) : (
          <p className="hint">Waiting for {oppName} to flip…</p>
        )}
      </div>
    );
  }

  if (!showResult) {
    return (
      <div className="screen coinflip">
        <h2 className="screen-title">Coin toss</h2>
        <p className="mulligan-hint">{caller === myKey ? "You" : oppName} called <strong>{call}</strong>.</p>
        <div className="coin coin-spinning" />
        <p className="hint">Flipping…</p>
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
// Grace window: releasing doesn't immediately zero the hold — the elapsed
// time is banked and only hard-reset after this many ms with no resuming
// pointerdown. This absorbs mouse switch chatter (rapid phantom
// release/re-press while the button is still physically held down).
const FORFEIT_GRACE_MS = 120;

/* Press-and-hold forfeit button: has to be held for FORFEIT_HOLD_MS straight,
   with a visible fill so it's obvious the hold is registering (and can't be
   triggered by a stray click). Releasing early cancels and resets.

   The rAF tick loop, once started on the first pointerdown, runs
   continuously every frame until a real reset or completion — it is never
   cancelled/rescheduled by individual pointerup/pointerdown events. Those
   events just flip a ref the loop reads. A chattering switch that fires many
   up/down pairs within a single physical press previously cancelled and
   restarted the loop on every blip, which (if the chatter was faster than
   one frame) meant tick() never got to actually run — the bar only ever
   flashed once, at the very end, when the chatter stopped and one final
   frame finally got through. Decoupling the loop from the raw events fixes
   that: it just keeps ticking regardless of how noisy the up/down signal is. */
function HoldToForfeitButton({ onForfeit, disabled }) {
  const [holding, setHolding] = useState(false);
  const [progress, setProgress] = useState(0); // 0-100
  const rafRef = useRef(null);
  const isDownRef = useRef(false); // physically pressed right now
  const segmentStartRef = useRef(null); // Date.now() when the current down segment began
  const pausedElapsedRef = useRef(0); // ms banked from completed down segments
  const graceDeadlineRef = useRef(null); // Date.now() timestamp after which an up becomes a real stop
  const doneRef = useRef(false);

  const hardStop = () => {
    setHolding(false);
    setProgress(0);
    doneRef.current = false;
    isDownRef.current = false;
    segmentStartRef.current = null;
    pausedElapsedRef.current = 0;
    graceDeadlineRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  };

  const tick = () => {
    let elapsed;
    if (isDownRef.current) {
      elapsed = pausedElapsedRef.current + (Date.now() - segmentStartRef.current);
    } else {
      elapsed = pausedElapsedRef.current; // frozen while up, waiting out the grace window
      if (graceDeadlineRef.current != null && Date.now() >= graceDeadlineRef.current) {
        hardStop();
        return;
      }
    }
    const pct = Math.min(100, (elapsed / FORFEIT_HOLD_MS) * 100);
    setProgress(pct);
    if (pct >= 100) {
      if (!doneRef.current) {
        doneRef.current = true;
        onForfeit && onForfeit();
      }
      hardStop();
      return;
    }
    rafRef.current = requestAnimationFrame(tick);
  };

  const start = (e) => {
    if (disabled) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    isDownRef.current = true;
    graceDeadlineRef.current = null;
    segmentStartRef.current = Date.now();
    setHolding(true);
    if (!rafRef.current) rafRef.current = requestAnimationFrame(tick);
  };

  const release = () => {
    if (!isDownRef.current) return; // duplicate/stray up, ignore
    isDownRef.current = false;
    pausedElapsedRef.current += Date.now() - segmentStartRef.current;
    segmentStartRef.current = null;
    graceDeadlineRef.current = Date.now() + FORFEIT_GRACE_MS;
    // Loop keeps running — it'll hard-stop itself once the grace window
    // passes with no resuming pointerdown.
  };

  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

  if (!onForfeit) return null;

  return (
    <button
      type="button"
      className={"btn btn-forfeit" + (holding ? " holding" : "")}
      disabled={disabled}
      style={{ "--forfeit-progress": progress / 100 }}
      onPointerDown={start}
      onPointerUp={release}
      onPointerCancel={release}
      title="Hold for 3 seconds to forfeit the game"
    >
      <span className="forfeit-fill" />
      <span className="forfeit-label">{holding ? "Hold to forfeit…" : "Forfeit"}</span>
    </button>
  );
}

function PlayBoard({
  state, viewerRole, opponentRole, viewerName, opponentName,
  isMyTurn, onPlayCard: onPlayCardRaw, onPass: onPassRaw, onForfeit, onUseLeader: onUseLeaderRaw,
  onResolveMedicRevive: onResolveMedicReviveRaw, onResolveScorchBurn: onResolveScorchBurnRaw, canAct: canActRaw, opponentThinking,
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
  const onPlayCard = (...args) => { if (soundGateRemainingMs() > 0) return; onPlayCardRaw(...args); };
  const onUseLeader = (...args) => { if (soundGateRemainingMs() > 0) return; onUseLeaderRaw(...args); };
  const onPass = (...args) => { if (soundGateRemainingMs() > 0) return; onPassRaw(...args); };
  const onResolveMedicRevive = (...args) => { if (soundGateRemainingMs() > 0) return; onResolveMedicReviveRaw && onResolveMedicReviveRaw(...args); };
  const me = state.players[viewerRole];
  const opp = state.players[opponentRole];
  // True while it's specifically MY Medic chain waiting on its next pick —
  // gates every other action (pass, play, leader) the same way the old
  // single-shot `pending` overlay used to, just driven off shared game state
  // now instead of local UI state (so it survives reloads/online sync).
  const medicChainPending = !!(state.awaitingMedicRevive && state.awaitingMedicRevive.player === viewerRole);
  const scorchBurnPending = !!state.pendingBurn;
  const canAct = canActRaw && !soundGated && !medicChainPending && !scorchBurnPending;

  // forceRandomRevive (L08 Invader of the North) skips the picker entirely —
  // each link auto-resolves with a random eligible target instead of
  // waiting on a tap, but still goes through its own RESOLVE_MEDIC_REVIVE
  // dispatch (paced behind the current sound) so the sound/animation stays
  // one-link-at-a-time instead of collapsing back into a single instant
  // batch. AI's own chain (p2 with no PlayBoard mounted) is driven from
  // AIGame's turn effect instead — this only covers a human-controlled seat.
  const medicAutoTimerRef = useRef(null);
  useEffect(() => {
    if (!medicChainPending || !me.forceRandomRevive) return;
    const delay = Math.max(700, soundGateRemainingMs());
    medicAutoTimerRef.current = setTimeout(() => {
      const eligible = medicEligible(me.discard);
      if (!eligible.length) return;
      const pick = eligible[Math.floor(Math.random() * eligible.length)];
      onResolveMedicRevive(pick);
    }, delay);
    return () => clearTimeout(medicAutoTimerRef.current);
  }, [medicChainPending, me.forceRandomRevive, me.discard]);
  const myLeader = cardById(me.leaderId);
  const oppLeader = cardById(opp.leaderId);
  // Redcrown: same "would this leader actually do anything" check the AI
  // uses to decide when to fire (leaderConditionMet) — always-good leaders
  // never flag as a no-op since they're useful the instant they're played.
  const myLeaderNoop = !!(myLeader && !me.leaderUsed && !me.leaderBlocked
    && !LEADER_ALWAYS_GOOD_EARLY.has(me.leaderId) && !leaderConditionMet(state, viewerRole, me.leaderId));
  const oppLeaderNoop = !!(oppLeader && !opp.leaderUsed && !opp.leaderBlocked
    && !LEADER_ALWAYS_GOOD_EARLY.has(opp.leaderId) && !leaderConditionMet(state, opponentRole, opp.leaderId));
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

  // Distinct "brought back from the discard" highlight for Medic revives —
  // layered on top of (not instead of) the generic flash above, set from
  // within the sound-diff effect below since that's where lastMedicRevive
  // gets matched against the ids that actually landed in this pass.
  const [revived, setRevived] = useState({ me: null, opp: null });
  // Ghost clone state for the "flies in from the discard pile" motion — see
  // MedicRevivalGhost. Separate from `revived` (which only drives the
  // in-place glow on the real, already-landed tile) since the ghost has its
  // own lifecycle (measures its own landing rect on mount, then unmounts
  // itself once the flight finishes).
  const [ghost, setGhost] = useState({ me: null, opp: null });
  const boardFrameRef = useRef(null);
  const revivedTimers = useRef({});

  /* --------------------------- v41 board sweep -----------------------------
     Cards flying off the board at the end of a round: to the discard pile
     on a normal round end, to the deck (with a flip) on the game-ending
     round. State (board.close/ranged/siege/specials, board.hornCards,
     board.mardroemeCards) is already cleared to discard by the time the
     "roundEnd"/"gameEnd" render happens — see clearBoardToDiscard — so
     there's no "from" position left in the DOM to animate from by then.
     lastPlaySnapshotRef sidesteps this: it's refreshed on every render
     while state.phase === "play" (i.e. every render up to and including the
     very last one before the clear), so by the time phase flips it's
     already holding exactly the pre-clear layout, frozen, ready to use. */
  const lastPlaySnapshotRef = useRef({ me: [], opp: [], myHand: [], oppHandRect: null, oppHandCount: 0 });
  // Tracks phase independently of prevSweepPhaseRef below (that one belongs
  // to the passive effect and updates AFTER this layout effect already ran
  // for the same commit). Needed to skip re-capturing on the exact render
  // where phase flips roundEnd -> play: on that commit the board has
  // already been cleared, so capturing here would clobber the frozen
  // pre-clear snapshot moments before the sweep-trigger effect (below)
  // reads it — which is exactly why the round-end sweep never fired.
  const prevSnapshotPhaseRef = useRef(state.phase);
  useLayoutEffect(() => {
    const prevPhase = prevSnapshotPhaseRef.current;
    prevSnapshotPhaseRef.current = state.phase;
    if (state.phase !== "play") return;
    if (prevPhase !== "play") return;
    const frame = boardFrameRef.current;
    if (!frame) return;
    const frameRect = frame.getBoundingClientRect();
    const relRect = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left - frameRect.left, top: r.top - frameRect.top, width: r.width, height: r.height };
    };
    const collect = (selector) => Array.from(frame.querySelectorAll(selector))
      .map((el) => ({ id: el.getAttribute("data-card-id"), rect: relRect(el) }))
      .filter((c) => c.id);
    const meSel = ".cell-my-close-row [data-card-id], .cell-my-ranged-row [data-card-id], .cell-my-siege-row [data-card-id],"
      + " .cell-my-close-horn [data-card-id], .cell-my-ranged-horn [data-card-id], .cell-my-siege-horn [data-card-id]";
    const oppSel = ".cell-opp-close-row [data-card-id], .cell-opp-ranged-row [data-card-id], .cell-opp-siege-row [data-card-id],"
      + " .cell-opp-close-horn [data-card-id], .cell-opp-ranged-horn [data-card-id], .cell-opp-siege-horn [data-card-id]";
    const myHandSel = ".hand-strip-cards:not(.opp-hand-strip) [data-card-id]";
    const oppHandEl = frame.querySelector(".opp-hand-strip");
    lastPlaySnapshotRef.current = {
      me: collect(meSel),
      opp: collect(oppSel),
      myHand: collect(myHandSel),
      oppHandRect: oppHandEl ? relRect(oppHandEl) : null,
      oppHandCount: opp.hand.length,
    };
  });

  const [sweep, setSweep] = useState(null); // { cards: [{id, rect, to, side, flip, faceDown}] }
  const sweepFiredRef = useRef(null);
  // gameEnd only: which real board-tile ids to keep hidden underneath the
  // sweep ghosts. This used to be derived straight from `sweep`, but `sweep`
  // self-clears on a short ghost-animation timer (see below) while the real
  // board state is NEVER cleared for a game-ending round (GameOverPanel just
  // covers it later, after a much longer GAME_END_REVEAL_DELAY_MS). That
  // mismatch meant the real cards popped back into view the moment the
  // ghost layer cleared, well before GameOverPanel arrived to cover them —
  // reading as the swept cards "teleporting back" onto the rows. Giving this
  // its own state, lifetime-matched to the gameEnd phase itself rather than
  // to the ghost animation, keeps the real tiles hidden for the whole gap.
  const [gameEndHiddenIds, setGameEndHiddenIds] = useState(null);
  // Ids still physically on a board after the clear (e.g. Monsters/Skellige
  // "keep exactly one card" retention) shouldn't also get a sweep ghost —
  // that card is still sitting right there in its row, so flying a second
  // copy of it into the discard would just look like a duplicate glitch.
  const boardResidentIds = (b) => new Set([
    ...b.close, ...b.ranged, ...b.siege,
    ...Object.values(b.hornCards || {}).flat(),
    ...Object.values(b.mardroemeCards || {}).flat(),
  ]);
  // finishRound() sets phase to "roundEnd"/"gameEnd" WITHOUT clearing the
  // board — the board only actually gets swept to discard inside
  // startNextRound() (fired by CONTINUE_ROUND), which flips phase straight
  // from "roundEnd" back to "play" (next round) in the same reducer call.
  // So there's never a render where phase === "roundEnd" and the board is
  // actually empty — watching phase === "roundEnd" directly (as this used
  // to) means every card is still resident and the sweep never fires.
  // Instead, watch for the roundEnd -> play transition itself (the render
  // right after CONTINUE_ROUND clears the board) and diff against that.
  const prevSweepPhaseRef = useRef(state.phase);
  useEffect(() => {
    const pileRect = (selector) => {
      const frame = boardFrameRef.current;
      const el = frame && frame.querySelector(selector);
      if (!frame || !el) return null;
      const frameRect = frame.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return { left: r.left - frameRect.left, top: r.top - frameRect.top, width: r.width, height: r.height };
    };
    const prevPhase = prevSweepPhaseRef.current;
    prevSweepPhaseRef.current = state.phase;
    if (state.phase === "play" && prevPhase === "roundEnd") {
      // Board just cleared via CONTINUE_ROUND/startNextRound this render —
      // me.board/opp.board below already reflect the post-clear (next
      // round's) board, so residency filtering (Monster/Skellige "keep one
      // card" retention) is correct here, unlike on phase === "roundEnd".
      const key = "round-" + (state.round - 1);
      if (sweepFiredRef.current === key) return;
      sweepFiredRef.current = key;
      const snap = lastPlaySnapshotRef.current;
      // Target the actual card-shaped element inside the pile cell, not
      // the whole rowSpan={2} <td> (which is a much bigger, non-card
      // aspect ratio and was making the ghost land stretched/oversized).
      const meTo = pileRect(".cell-my-discard .card-tile");
      const oppTo = pileRect(".cell-opp-discard .discard-pile-back");
      const meResident = boardResidentIds(me.board);
      const oppResident = boardResidentIds(opp.board);
      const cards = [
        ...snap.me.filter((c) => !meResident.has(c.id)).map((c) => ({ ...c, to: meTo, side: "me" })),
        ...snap.opp.filter((c) => !oppResident.has(c.id)).map((c) => ({ ...c, to: oppTo, side: "opp" })),
      ].filter((c) => c.to);
      if (cards.length) setSweep({ cards });
    } else if (state.phase === "gameEnd") {
      const key = "game-" + state.round + "-" + state.gameWinner;
      if (sweepFiredRef.current === key) return;
      sweepFiredRef.current = key;
      const isTie = state.lastRoundScore && state.lastRoundScore.p1 === state.lastRoundScore.p2;
      // Starts right alongside the round win/loss clip (see RoundBanner)
      // instead of waiting for it to finish — with the old wait, the
      // round-sound had already gone quiet well before the sweep even
      // started, and the sweep's tail ended up landing right next to
      // GameOverPanel's separate win/loss clip (see GAME_END_REVEAL_DELAY_MS
      // below) instead, so the sweep visually read as paired with that
      // "final" sound rather than the round one. A short delay here just
      // gives the roundEnd/gameEnd banner a moment to actually paint before
      // measuring pile positions.
      const delay = isTie ? 200 : 150;
      const t = setTimeout(() => {
        const snap = lastPlaySnapshotRef.current;
        const meTo = pileRect(".cell-my-deck .deck-pile-stack");
        const oppTo = pileRect(".cell-opp-deck .deck-pile-stack");
        // Unlike roundEnd, the board is NEVER cleared in state for a
        // game-ending round (GameOverPanel just replaces PlayBoard
        // wholesale afterward) — so every snapshotted board card is still
        // "resident" and a residency filter here would wrongly drop all of
        // them. Sweep every board card unconditionally instead.
        const boardCards = [
          ...snap.me.map((c) => ({ ...c, to: meTo, side: "me", flip: true })),
          ...snap.opp.map((c) => ({ ...c, to: oppTo, side: "opp", flip: true })),
        ];
        // Hand cards (either side) stay in hand at game end — only board
        // cards sweep to the deck. (Opponent hand ghosts used to fan a
        // matching count of face-down ghosts out of the hand-strip stack
        // here; removed for the same reason.)
        const cards = boardCards.filter((c) => c.to);
        if (cards.length) {
          setSweep({ cards });
          setGameEndHiddenIds(new Set(cards.map((c) => c.id)));
        }
      }, delay);
      return () => clearTimeout(t);
    } else {
      sweepFiredRef.current = null;
      setGameEndHiddenIds(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, state.round, state.gameWinner]);

  // Game-end only: the board is never cleared in state for the final round
  // (see the gameEnd branch above), so the real tiles stay mounted and
  // fully visible right under the flying sweep ghosts unless hidden
  // explicitly — otherwise it reads as the ghost being a duplicate clone
  // while the "real" card just sits there. Round-end doesn't need this:
  // the board is already cleared to empty by the time that sweep runs, so
  // there's nothing real left underneath to double up with.
  // Sourced from gameEndHiddenIds (its own state, not `sweep` itself) since
  // `sweep` self-clears on the short ghost-animation timer below, well
  // before GameOverPanel's much longer reveal delay actually covers the
  // board — using `sweep` here used to make the real cards pop back into
  // view in that gap, reading as the swept cards teleporting back onto
  // the rows.
  const sweepHiddenIds = state.phase === "gameEnd" ? gameEndHiddenIds : null;

  // Auto-clears the whole sweep layer once every ghost's had time to land,
  // rather than wiring up an onDone per-ghost — simpler, and just as
  // invisible since by then every ghost has faded to opacity 0 anyway.
  useEffect(() => {
    if (!sweep) return;
    const total = sweep.cards.length * 30 + 900;
    const t = setTimeout(() => setSweep(null), total);
    return () => clearTimeout(t);
  }, [sweep]);

  /* ------------------------------- v39 FX ---------------------------------
     Ability animations, synced to the same sounds already firing above.
     `cardFx` is a "side:id" -> class-name map for every per-card effect:
     burn, hero shine, bond glow, morale +1, mardroeme's red cloud, spy fog,
     decoy shimmer, muster pop. It's keyed by side as well as id (not id
     alone) because card database ids are NOT globally unique across boards
     — the same card can legally sit on both sides at once (mirrored/neutral
     cards) or appear twice on one side (Bond copies), and a flat id-only key
     made every tile sharing that id flash together whenever any one of them
     landed. `rowFx` covers the two effects that apply to a whole row instead
     of one card: horn's glow (own side only) and each weather type's
     entrance sweep (both sides, since weather always mirrors onto both
     boards identically). `sunlight` is board-wide, for Clear Weather.
     `leaderGlow` is per-side, for leader activation. Every one of these
     auto-clears itself via its own timer, keyed to the exact clip duration
     it's syncing to (see SOUND_DURATIONS_MS). */
  const [cardFx, setCardFx] = useState({});
  const cardFxTimers = useRef({});
  const setCardFxFor = (side, id, cls, ms) => {
    if (!id) return;
    const key = side + ":" + id;
    setCardFx((f) => ({ ...f, [key]: cls }));
    clearTimeout(cardFxTimers.current[key]);
    cardFxTimers.current[key] = setTimeout(() => {
      setCardFx((f) => { if (f[key] !== cls) return f; const nf = { ...f }; delete nf[key]; return nf; });
    }, ms);
  };
  const [rowFx, setRowFx] = useState({ me: { close: null, ranged: null, siege: null }, opp: { close: null, ranged: null, siege: null } });
  const rowFxTimers = useRef({});
  const setRowFxFor = (side, row, cls, ms) => {
    const key = side + ":" + row;
    setRowFx((f) => ({ ...f, [side]: { ...f[side], [row]: cls } }));
    clearTimeout(rowFxTimers.current[key]);
    rowFxTimers.current[key] = setTimeout(() => {
      setRowFx((f) => ({ ...f, [side]: { ...f[side], [row]: null } }));
    }, ms);
  };
  const [sunlight, setSunlight] = useState(false);
  const sunlightTimer = useRef(null);
  // Fires the board-wide sunbeam sweep unconditionally — used for both the
  // Clear Weather card and the L12 leader ability, regardless of whether
  // weather was actually present on the board to clear. Previously this was
  // gated on an actual weathered->clear board-state transition, which meant
  // playing Clear Weather into an already-clear board (fully legal, just a
  // no-op play) showed nothing at all. Now it's tied to the card/ability
  // actually being used, matching the sound (which already fires
  // unconditionally via playCardSounds' abilityKey path for the card case).
  const triggerSunlight = () => {
    setSunlight(true);
    clearTimeout(sunlightTimer.current);
    sunlightTimer.current = setTimeout(() => setSunlight(false), SOUND_DURATIONS_MS.clearWeather);
  };
  const [leaderGlow, setLeaderGlow] = useState({ me: false, opp: false });
  const leaderGlowTimers = useRef({});
  const setLeaderGlowFor = (side, ms) => {
    setLeaderGlow((g) => ({ ...g, [side]: true }));
    clearTimeout(leaderGlowTimers.current[side]);
    leaderGlowTimers.current[side] = setTimeout(() => setLeaderGlow((g) => ({ ...g, [side]: false })), ms);
  };
  useEffect(() => () => {
    Object.values(cardFxTimers.current).forEach(clearTimeout);
    Object.values(rowFxTimers.current).forEach(clearTimeout);
    Object.values(leaderGlowTimers.current).forEach(clearTimeout);
    clearTimeout(sunlightTimer.current);
  }, []);

  /* ------------------------------ v39.2 FX ---------------------------------
     Spy/Decoy/Mardroeme's smoke clouds need to visibly spill out past the
     card's own edges (top/bottom/all around) — but the real card tile lives
     inside `.row-cards` / the board `<td>`, both of which are hard
     `overflow: hidden` (load-bearing for the table's %-height layout, same
     reason MedicRevivalGhost exists). So the smoke itself is rendered as a
     separate portal layer, a sibling inside `.board-frame` (see
     AbilitySmokeGhost / .smoke-fx-layer below) — it measures the real card's
     rect once on mount and paints an oversized, opaque, billowing cloud on
     top of it, immune to any row/cell clipping. The card itself goes fully
     opaque too (art AND text hidden, swapped for a flat color — grey/red)
     via a simple in-place class on the tile, since that never exceeds the
     card's own box and doesn't need to escape anything. */
  // Guards triggerAbilityFx against firing twice for the same physical card
  // if the board diff ever sees its id go "new" twice within a short window
  // — e.g. a transient/incomplete synced board snapshot (a row briefly
  // missing before the real update lands) makes an already-placed card look
  // like it just disappeared and reappeared. A permanent per-id block would
  // be wrong here: Decoy can legitimately return a card to hand and it gets
  // replayed later, and that SHOULD get its landing fx again. A short window
  // only catches the same-instant glitch, not a genuine replay turns later.
  const recentAbilityFxRef = useRef({});
  const ABILITY_FX_DEDUP_MS = 2000;
  const triggerAbilityFxDeduped = (...args) => {
    const id = args[1];
    const now = Date.now();
    if (id && now - (recentAbilityFxRef.current[id] || 0) < ABILITY_FX_DEDUP_MS) return;
    if (id) recentAbilityFxRef.current[id] = now;
    triggerAbilityFx(...args);
  };
  const [smokeFx, setSmokeFx] = useState({});
  const smokeFxKeyRef = useRef(0);
  const setSmokeFxFor = (side, id, type, ms) => {
    if (!id) return;
    smokeFxKeyRef.current += 1;
    const key = side + ":" + id;
    setSmokeFx((f) => ({ ...f, [key]: { cardId: id, side, type, ms, key: smokeFxKeyRef.current } }));
  };
  const clearSmokeFxFor = (side, id) => {
    const key = side + ":" + id;
    setSmokeFx((f) => { if (!f[key]) return f; const nf = { ...f }; delete nf[key]; return nf; });
  };

  // One card landing can trigger several of the above at once (e.g. a Hero
  // with Tight Bond) — this just fans a freshly-landed id out to whichever
  // effects actually apply, using the same board/row/batchIds context the
  // sound-diff effect already computed for it. Pure visual — never touches
  // game state, so it's safe to call unconditionally for every new id.
  function triggerAbilityFx(side, id, card, board, row, batchIds) {
    if (!card) return;
    if (card.cardType === "Hero") setCardFxFor(side, id, "card-hero-shine", SOUND_DURATIONS_MS.playingHero);
    if (card.abilityMeta?.undraftable) {
      setCardFxFor(side, id, "card-transform-cloud", SOUND_DURATIONS_MS.mardroeme);
      setSmokeFxFor(side, id, "transform", SOUND_DURATIONS_MS.mardroeme);
    }
    if (card.ability === "decoy") {
      setCardFxFor(side, id, "card-decoy-swap", SOUND_DURATIONS_MS.decoy);
      setSmokeFxFor(side, id, "decoy", SOUND_DURATIONS_MS.decoy);
    }
    if (card.ability === "spy") {
      setCardFxFor(side, id, "card-spy-fog", SOUND_DURATIONS_MS.spy);
      setSmokeFxFor(side, id, "spy", SOUND_DURATIONS_MS.spy);
    }
    if (card.ability === "muster" && abilityActuallyActivates(card, board, row, batchIds)) {
      // Only the card the player actually played gets the icon pop —
      // Muster siblings fetched alongside it also have ability === "muster"
      // and would otherwise trip this same branch and each get their own
      // icon. They still get the gold "just arrived" glow (see the
      // card-muster-glow case below and its shared CSS with
      // card-muster-pop), just without the icon on top.
      const isThePlayedCard = state.lastMusterPlayed?.cardId === id;
      setCardFxFor(side, id, isThePlayedCard ? "card-muster-pop" : "card-muster-glow", SOUND_DURATIONS_MS.muster);
    }
    if (card.ability === "horn" && board) {
      // Commander's Horn (Special, chosen row) never lands in a row array
      // itself, so `row` (from rowOfCardInBoard) is null for it — the
      // actual boosted row lives in board.hornCards instead. A fixed-row
      // Horn unit is the opposite (never added to hornCards, always has a
      // real `row`), so falling back to `row` covers that case.
      const hornRow = ROWS.find((r) => board.hornCards[r].includes(id)) || row;
      if (hornRow) setRowFxFor(side, hornRow, "row-horn-glow", SOUND_DURATIONS_MS.horn);
    }
    if (!board || !row) return;
    if (card.ability === "tightBond" && abilityActuallyActivates(card, board, row, batchIds)) {
      const base = bondBaseName(card.name);
      board[row].filter((bid) => { const c = cardById(bid); return c && c.ability === "tightBond" && bondBaseName(c.name) === base; })
        .forEach((bid) => setCardFxFor(side, bid, "card-bond-glow", SOUND_DURATIONS_MS.bond));
    }
    if (card.ability === "moraleBoost" && abilityActuallyActivates(card, board, row, batchIds)) {
      setCardFxFor(side, id, "card-morale-boost", SOUND_DURATIONS_MS.morale);
      board[row].filter((mid) => mid !== id && cardById(mid)?.cardType !== "Hero")
        .forEach((mid) => setCardFxFor(side, mid, "card-morale-plus-one", SOUND_DURATIONS_MS.morale));
    }
  }

  // Scorch's burn: fires once per fresh pendingBurn object (set by the
  // reducer the instant a scorch card resolves with at least one victim —
  // see resolvePlayCard). Flags every victim id with the burn class (they're
  // still sitting in their normal row slot, untouched by the reducer until
  // RESOLVE_SCORCH_BURN), plays the sound, then — after the burn has had
  // time to actually play out — dispatches the follow-up that does the real
  // removal. Every mounted PlayBoard (both clients in Online mode included)
  // independently detects the same pendingBurn and fires this locally, so
  // sound/visual always plays for whoever's watching; the resolve dispatch
  // itself is safe to fire from more than one place since the reducer's
  // `if (!state.pendingBurn) return state;` guard makes a second one a
  // harmless no-op.
  const pendingBurnRef = useRef(null);
  const burnTimerRef = useRef(null);
  useEffect(() => {
    const pb = state.pendingBurn;
    if (pb && pb !== pendingBurnRef.current) {
      const victimEntries = Object.entries(pb.victims || {});
      const ids = victimEntries.flatMap(([, v]) => v);
      if (ids.length) {
        playSound("scorch");
        // victims is keyed by player key (actingPlayer/opponent), not
        // viewer-relative side — map each to "me"/"opp" the same way the
        // Medic revive ghost above does, so the burn fx lands on the
        // correct board's tile when a scorched id happens to also exist
        // on the other board (mirrored/neutral card, or a Bond copy).
        victimEntries.forEach(([playerKey, vids]) => {
          const side = viewerRole === playerKey ? "me" : "opp";
          vids.forEach((id) => setCardFxFor(side, id, "card-burning", SOUND_DURATIONS_MS.scorch + 400));
        });
        clearTimeout(burnTimerRef.current);
        burnTimerRef.current = setTimeout(() => {
          onResolveScorchBurnRaw && onResolveScorchBurnRaw();
        }, SOUND_DURATIONS_MS.scorch + 300);
      }
    }
    pendingBurnRef.current = pb;
  }, [state.pendingBurn]);
  useEffect(() => () => clearTimeout(burnTimerRef.current), []);

  // scorchGlobal plays its sound even with no target (see lastScorchCast) —
  // the burn effect above only fires when there's actually something to
  // burn, so this covers the "cast but missed" case on its own.
  const lastScorchRef = useRef(null);
  useEffect(() => {
    const cast = state.lastScorchCast;
    if (cast && cast !== lastScorchRef.current && !state.pendingBurn) {
      playSound("scorch");
    }
    lastScorchRef.current = cast;
  }, [state.lastScorchCast]);
  useEffect(() => () => { clearTimeout(revivedTimers.current.opp); clearTimeout(revivedTimers.current.me); }, []);
  // Reveals the (until now hidden-via-opacity) real in-row tile and starts
  // its glow — called once the ghost has actually landed, never before, so
  // the reveal and the glow's own fade-in are the only "arrival" the player
  // ever sees.
  const revealRevived = (side, cardId) => {
    setRevived((r) => ({ ...r, [side]: cardId }));
    clearTimeout(revivedTimers.current[side]);
    revivedTimers.current[side] = setTimeout(() => setRevived((r) => ({ ...r, [side]: null })), 2200);
  };

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
      meDiscard: me.discard,
      oppDiscard: opp.discard,
      meWeather: me.board.weather,
      meLeaderUsed: me.leaderUsed,
      oppLeaderUsed: opp.leaderUsed,
      meLeaderId: me.leaderId,
      oppLeaderId: opp.leaderId,
      meMardroeme: me.board.mardroeme,
      oppMardroeme: opp.board.mardroeme,
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
      // Ids that vanished from each side's board in this same pass — used to
      // tell whether row Scorch actually killed something (opponent's side)
      // and whether Mardroeme actually transformed a Berserker (this side's
      // own board, since a transform swaps the old id for a new one in the
      // same row).
      const removedMineIds = prev.meIds.filter((id) => !snapshot.meIds.includes(id));
      const removedOppIds = prev.oppIds.filter((id) => !snapshot.oppIds.includes(id));
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
      // A Berserker played straight into a row where Mardroeme is ALREADY
      // active transforms on arrival (see the "berserker" default-case
      // reducer logic) — its board id lands directly as the Transformed
      // Vildkaarl/Young Vildkaarl variant, so by the time this diff sees it
      // it just looks like a plain tightBond/moraleBoost unit and gets no
      // distinct transform sound. Detected here via the undraftable
      // Transformed-variant flag landing in a row whose mardroeme flag was
      // ALREADY true in the previous snapshot (as opposed to just having
      // been flipped true by a Mardroeme card played in this very diff,
      // which already gets its own dedicated mardroeme/mardroemeAlone sound
      // via the card.ability === "mardroeme" branch of playCardSounds).
      const arrivalTransformSound = (id, board, prevMardroeme) => {
        const c = cardById(id);
        if (!c?.abilityMeta?.undraftable) return;
        const row = rowOfCardInBoard(board, id);
        if (row && prevMardroeme?.[row]) playSound("mardroeme");
      };
      // Medic revive (see resolveMedicRevive): the revived card gets its own
      // dedicated cue — revival.m4a, plus spy.m4a layered on top if it came
      // back as a Spy — instead of the generic playingBasic/Hero(+ability)
      // treatment every other new id gets below. Guarded on the id actually
      // being fresh in THIS diff pass so a stale lastMedicRevive left over
      // from a prior action can't replay itself.
      const revive = state.lastMedicRevive;
      const revivedMineFresh = revive && newMineIds.includes(revive.cardId) ? revive.cardId : null;
      const revivedOppFresh = revive && newOppOnlyIds.includes(revive.cardId) ? revive.cardId : null;
      if (revivedMineFresh || revivedOppFresh) {
        playSound("revival");
        if (revive.isSpy) playSound("spy");
        const toSide = revivedMineFresh ? "me" : "opp";
        const cid = revivedMineFresh || revivedOppFresh;
        // Fly-in origin: always the ACTING player's discard pile (revive.player)
        // — for a Spy revive that lands on the opponent's board, that's a
        // different side than the card lands on, so this is computed
        // separately from toSide rather than reusing it.
        const fromSide = viewerRole === revive.player ? "me" : "opp";
        // NOTE: the real in-row tile for `cid` stays hidden (opacity:0, via
        // RowCardsCell's arrivingId prop) for as long as ghost[toSide] is
        // set — it only gets revealed (and only THEN starts its glow, via
        // `revived`) from the ghost's own onDone callback below, once it's
        // actually landed. Setting `revived` here too would start the glow
        // animation on a card the player can't see yet, and — worse — the
        // animation's own opacity keyframes would fight the inline
        // opacity:0 used to hide it, causing exactly the "two cards at once"
        // glitch this whole rework exists to avoid.
        try {
          const frameEl = boardFrameRef.current;
          const fromEl = document.querySelector(fromSide === "me" ? ".cell-my-discard" : ".cell-opp-discard");
          if (frameEl && fromEl) {
            const frameRect = frameEl.getBoundingClientRect();
            const fromRect = fromEl.getBoundingClientRect();
            // Stored relative to .board-frame (not the viewport) since the
            // ghost renders as an absolutely-positioned child of it — see
            // .medic-ghost-layer / MedicRevivalGhost.
            setGhost((g) => ({
              ...g,
              [toSide]: {
                cardId: cid,
                card: cardById(cid),
                fromRect: { left: fromRect.left - frameRect.left, top: fromRect.top - frameRect.top, width: fromRect.width, height: fromRect.height },
              },
            }));
          } else {
            // Couldn't measure — no ghost, so reveal immediately instead of
            // leaving the real card hidden forever with nothing to unhide it.
            revealRevived(toSide, cid);
          }
        } catch (e) {
          revealRevived(toSide, cid);
        }
      }
      newMineIds.forEach((id) => {
        try {
          if (id === revivedMineFresh) return; // already got its own revival cue above
          playCardSounds(cardById(id), me.board, rowOfCardInBoard(me.board, id), newMineIds, removedMineIds, removedOppIds);
          arrivalTransformSound(id, me.board, prev.meMardroeme);
          triggerAbilityFxDeduped("me", id, cardById(id), me.board, rowOfCardInBoard(me.board, id), newMineIds);
          if (cardById(id)?.ability === "clearWeather") triggerSunlight();
        }
        catch (e) { console.error("[kwent sound] playCardSounds failed for me id", id, e); }
      });
      newOppOnlyIds.forEach((id) => {
        try {
          if (id === revivedOppFresh) return; // already got its own revival cue above
          playCardSounds(cardById(id), opp.board, rowOfCardInBoard(opp.board, id), newOppOnlyIds, removedOppIds, removedMineIds);
          arrivalTransformSound(id, opp.board, prev.oppMardroeme);
          triggerAbilityFxDeduped("opp", id, cardById(id), opp.board, rowOfCardInBoard(opp.board, id), newOppOnlyIds);
          if (cardById(id)?.ability === "clearWeather") triggerSunlight();
        }
        catch (e) { console.error("[kwent sound] playCardSounds failed for opp id", id, e); }
      });
      // scorchGlobal special cards (Scorch (1)/(2)/(3)) never touch the
      // board at all when played — no row, no board.specials entry, they go
      // straight to the discard pile — so the board-diff pass above can
      // never see them land. Caught here instead, off the discard pile diff.
      // This only plays the base playing_basic cue now — the "scorch" sound
      // itself (always, regardless of whether a target was found) and the
      // burn visual are both handled below, off lastScorchCast/pendingBurn.
      const newMineDiscards = snapshot.meDiscard.filter((id) => !prev.meDiscard.includes(id));
      const newOppDiscards = snapshot.oppDiscard.filter((id) => !prev.oppDiscard.includes(id));
      newMineDiscards.forEach((id) => {
        const c = cardById(id);
        if (c?.ability === "scorchGlobal") playCardSounds(c, null, null, null, null, null);
      });
      newOppDiscards.forEach((id) => {
        const c = cardById(id);
        if (c?.ability === "scorchGlobal") playCardSounds(c, null, null, null, null, null);
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
        if (before !== after && after) {
          const key = weatherSoundKeyForRow(r);
          // Sound only for the ability-less path (a card-driven change
          // already got its sound above, via playCardSounds). The visual
          // side is now a persistent overlay driven straight off
          // board.weather in RowCardsCell/WeatherCenterCell, so there's no
          // separate one-shot fx to trigger here anymore.
          if (key && newMineIds.includes(after) === false && newOppOnlyIds.includes(after) === false) playSound(key);
        }
      });
      // Leader activation — leaderUsed flipping false -> true. L12 (Clear
      // Weather) additionally fires the sunbeam sweep, unconditionally, same
      // as the card case above — replaces the old board-diff-gated check
      // that used to live here (wasClear/isClear off prev/snapshot.meWeather),
      // which both missed the no-weather-present case AND double-fired the
      // clearWeather sound on top of the one playCardSounds already plays
      // for the card path.
      if (!prev.meLeaderUsed && snapshot.meLeaderUsed) {
        const key = snapshot.meLeaderId === "L21" ? "crachAnCraite" : "leader";
        playSound(key);
        setLeaderGlowFor("me", SOUND_DURATIONS_MS[key]);
        if (snapshot.meLeaderId === "L12") triggerSunlight();
        const hornRow = LEADER_HORN_ROW[snapshot.meLeaderId];
        if (hornRow) { playSound("horn"); setRowFxFor("me", hornRow, "row-horn-glow", SOUND_DURATIONS_MS.horn); }
      }
      if (!prev.oppLeaderUsed && snapshot.oppLeaderUsed) {
        const key = snapshot.oppLeaderId === "L21" ? "crachAnCraite" : "leader";
        playSound(key);
        setLeaderGlowFor("opp", SOUND_DURATIONS_MS[key]);
        if (snapshot.oppLeaderId === "L12") triggerSunlight();
        const hornRow = LEADER_HORN_ROW[snapshot.oppLeaderId];
        if (hornRow) { playSound("horn"); setRowFxFor("opp", hornRow, "row-horn-glow", SOUND_DURATIONS_MS.horn); }
      }
      } catch (e) {
        console.error("[kwent sound] sound-diff effect threw — snapshot still committed below", e);
      }
    }
    soundPrevRef.current = snapshot;
  }, [me.board, opp.board, me.hand, opp.hand, me.discard, opp.discard, me.leaderUsed, opp.leaderUsed, me.leaderId, opp.leaderId]);

  // Medic's "choose a card" picker shouldn't pop up over the top of the
  // medic unit's own landing sound (or, for a chained link, the previous
  // revival's sound) — it should wait for that sound to actually finish.
  // Declared AFTER the sound-diff effect above so it always runs second
  // within the same commit: by the time this reads soundGateRemainingMs(),
  // that effect has already called playSound/markSoundBusy for whatever
  // just landed, so the remaining time here is accurate for THIS link, not
  // a stale one. Keyed on state.awaitingMedicRevive itself (a fresh object
  // each time the reducer (re-)arms it, even for consecutive links for the
  // same player) rather than the derived medicChainPending boolean, since
  // that boolean can stay continuously true across a chain link with no
  // false-in-between for an effect dependency to catch.
  const [medicPickerReady, setMedicPickerReady] = useState(false);
  useEffect(() => {
    if (!state.awaitingMedicRevive || state.awaitingMedicRevive.player !== viewerRole) {
      setMedicPickerReady(false);
      return;
    }
    const remaining = soundGateRemainingMs();
    if (remaining <= 0) { setMedicPickerReady(true); return; }
    setMedicPickerReady(false);
    const t = setTimeout(() => setMedicPickerReady(true), remaining + 30);
    return () => clearTimeout(t);
  }, [state.awaitingMedicRevive, viewerRole]);

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
    // Dandelion/Draig Bon-Dhu/Ermion have a fixed row and act as Horn/Mardroeme respectively.
    // Unlike the choice-row specials, these are real units with board presence, so neither an
    // already-horned/mardroeme'd row of the SAME ability, NOR the opposite ability already
    // active on their row (cross-ability exclusion), blocks them — they have nowhere else to
    // go, so they always enter play (reducer caps the horn count so it can't compound).
    // Medic no longer needs a pre-play picker here — the card just gets
    // played normally, and the revive (if any) opens as its own step driven
    // by state.awaitingMedicRevive (see the medicChainPending render block
    // below), which also covers every subsequent link in a Medic-revives-
    // Medic chain, not just the first.
    onPlayCard(id, {});
  };

  const confirmRow = (row) => { onPlayCard(pending.cardId, { chosenRow: row }); setPending(null); };
  const confirmDecoy = (targetId) => { onPlayCard(pending.cardId, { targetId }); setPending(null); };

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

  const myLeaderDisabled = !canAct || me.leaderUsed || me.leaderBlocked || myLeaderNoop;

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
      <div className="board-frame" ref={boardFrameRef}>
        {sunlight && <div className="sunlight-ray-layer"><div className="sunlight-ray" /></div>}
        {(ghost.me || ghost.opp) && (
          <div className="medic-ghost-layer">
            {ghost.me && (
              <MedicRevivalGhost
                key={"me-" + ghost.me.cardId}
                card={ghost.me.card}
                cardId={ghost.me.cardId}
                fromRect={ghost.me.fromRect}
                frameRef={boardFrameRef}
                onDone={() => { setGhost((g) => ({ ...g, me: null })); revealRevived("me", ghost.me.cardId); }}
              />
            )}
            {ghost.opp && (
              <MedicRevivalGhost
                key={"opp-" + ghost.opp.cardId}
                card={ghost.opp.card}
                cardId={ghost.opp.cardId}
                fromRect={ghost.opp.fromRect}
                frameRef={boardFrameRef}
                onDone={() => { setGhost((g) => ({ ...g, opp: null })); revealRevived("opp", ghost.opp.cardId); }}
              />
            )}
          </div>
        )}
        {sweep && sweep.cards.length > 0 && (
          <div className="sweep-ghost-layer">
            {sweep.cards.map((c, i) => (
              <SweepGhost
                key={c.side + "-" + c.id + "-" + i}
                card={c.faceDown ? null : cardById(c.id)}
                faction={c.side === "me" ? me.faction : opp.faction}
                fromRect={c.rect}
                toRect={c.to}
                flip={!!c.flip}
                faceDown={!!c.faceDown}
                delayMs={i * 30}
              />
            ))}
          </div>
        )}
        {Object.keys(smokeFx).length > 0 && (
          <div className="smoke-fx-layer">
            {Object.entries(smokeFx).map(([key, cfg]) => (
              <AbilitySmokeGhost
                key={key + "-" + cfg.key}
                cardId={cfg.cardId}
                side={cfg.side}
                type={cfg.type}
                ms={cfg.ms}
                frameRef={boardFrameRef}
                onDone={() => clearSmokeFxFor(cfg.side, cfg.cardId)}
              />
            ))}
          </div>
        )}
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
              <td rowSpan={3} className="cell-opp-leader"><CardTile card={oppLeader} size="xs" disabled fxClass={leaderGlow.opp ? "card-leader-cast" : null} /></td>
              <td></td>
              <td></td>
              <td rowSpan={2} className="cell-opp-siege-label"><RowLabelCell board={opp.board} rowKey="siege" spyDoubled={spyDoubled} /></td>
              <td colSpan={2} rowSpan={2} className="cell-opp-siege-horn"><RowHornCell board={opp.board} rowKey="siege" side="opp" hiddenIds={sweepHiddenIds} /></td>
              <td rowSpan={2} className="cell-opp-siege-row"><RowCardsCell side="opp" board={opp.board} rowKey="siege" flashId={flash.opp} revivedId={revived.opp} arrivingId={ghost.opp?.cardId} cardFx={cardFx} hornGlow={!!rowFx.opp.siege} hiddenIds={sweepHiddenIds} /></td>
              <td></td>
            </tr>

            {/* Row 4: leader badge (shifted to col2), opp discard (rowspan2) */}
            <tr>
              <td className="cell-opp-leader-badge"><LeaderUnusedBadge show={!!oppLeader && !opp.leaderUsed && !opp.leaderBlocked} noop={oppLeaderNoop} /></td>
              <td></td>
              <td rowSpan={2} className="cell-opp-discard"><DiscardTopBack discard={opp.discard} faction={opp.faction} /></td>
            </tr>

            {/* Row 5: leader (last row, blank), ranged label/horn/row */}
            <tr>
              <td></td>
              <td></td>
              <td rowSpan={2} className="cell-opp-ranged-label"><RowLabelCell board={opp.board} rowKey="ranged" spyDoubled={spyDoubled} /></td>
              <td rowSpan={2} colSpan={2} className="cell-opp-ranged-horn"><RowHornCell board={opp.board} rowKey="ranged" side="opp" hiddenIds={sweepHiddenIds} /></td>
              <td rowSpan={2} className="cell-opp-ranged-row"><RowCardsCell side="opp" board={opp.board} rowKey="ranged" flashId={flash.opp} revivedId={revived.opp} arrivingId={ghost.opp?.cardId} cardFx={cardFx} hornGlow={!!rowFx.opp.ranged} hiddenIds={sweepHiddenIds} /></td>
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
                <RowHornCell board={opp.board} rowKey="close" side="opp" hiddenIds={sweepHiddenIds} />
              </td>
              <td rowSpan={2} className="cell-opp-close-row">
                <RowBgFill src={boardImg("opp close")} anchor="top" />
                <RowCardsCell side="opp" board={opp.board} rowKey="close" flashId={flash.opp} revivedId={revived.opp} arrivingId={ghost.opp?.cardId} cardFx={cardFx} hornGlow={!!rowFx.opp.close} hiddenIds={sweepHiddenIds} />
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
                <RowHornCell board={me.board} rowKey="close" side="my" hiddenIds={sweepHiddenIds} />
              </td>
              <td rowSpan={2} className="cell-my-close-row">
                <RowBgFill src={boardImg("my close")} anchor="bottom" />
                <RowCardsCell
                  board={me.board}
                  side="me"
                  rowKey="close"
                  onClickCard={pending?.kind === "decoy" ? (id) => decoyTargets.includes(id) && confirmDecoy(id) : undefined}
                  selectableIds={pending?.kind === "decoy" ? decoyTargets : undefined}
                  flashId={flash.me}
                  revivedId={revived.me}
                  arrivingId={ghost.me?.cardId}
                  cardFx={cardFx}
                  hornGlow={!!rowFx.me.close}
                  hiddenIds={sweepHiddenIds}
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
              <td rowSpan={2} colSpan={2} className="cell-my-ranged-horn"><RowHornCell board={me.board} rowKey="ranged" side="my" hiddenIds={sweepHiddenIds} /></td>
              <td rowSpan={2} className="cell-my-ranged-row">
                <RowCardsCell
                  board={me.board}
                  side="me"
                  rowKey="ranged"
                  onClickCard={pending?.kind === "decoy" ? (id) => decoyTargets.includes(id) && confirmDecoy(id) : undefined}
                  selectableIds={pending?.kind === "decoy" ? decoyTargets : undefined}
                  flashId={flash.me}
                  revivedId={revived.me}
                  arrivingId={ghost.me?.cardId}
                  cardFx={cardFx}
                  hornGlow={!!rowFx.me.ranged}
                  hiddenIds={sweepHiddenIds}
                />
              </td>
              <td></td>
            </tr>

            {/* Row 12: my leader (rowspan3, shifted to col1) starts, my deck count (moved up one row) */}
            <tr>
              <td rowSpan={3} className="cell-my-leader"><CardTile card={myLeader} size="xs" onClick={startLeader} disabled={myLeaderDisabled} fxClass={leaderGlow.me ? "card-leader-cast" : null} /></td>
              <td></td>
              <td></td>
              <td className="cell-my-deck-count"><DeckCountCell count={me.deck.length} /></td>
            </tr>

            {/* Row 13: my leader badge (shifted to col2), siege label/horn/row, my discard (moved up one row) */}
            <tr>
              <td className="cell-my-leader-badge"><LeaderUnusedBadge show={!!myLeader && !me.leaderUsed && !me.leaderBlocked} noop={myLeaderNoop} /></td>
              <td></td>
              <td rowSpan={2} className="cell-my-siege-label"><RowLabelCell board={me.board} rowKey="siege" spyDoubled={spyDoubled} /></td>
              <td rowSpan={2} colSpan={2} className="cell-my-siege-horn"><RowHornCell board={me.board} rowKey="siege" side="my" hiddenIds={sweepHiddenIds} /></td>
              <td rowSpan={2} className="cell-my-siege-row">
                <RowCardsCell
                  board={me.board}
                  side="me"
                  rowKey="siege"
                  onClickCard={pending?.kind === "decoy" ? (id) => decoyTargets.includes(id) && confirmDecoy(id) : undefined}
                  selectableIds={pending?.kind === "decoy" ? decoyTargets : undefined}
                  flashId={flash.me}
                  revivedId={revived.me}
                  arrivingId={ghost.me?.cardId}
                  cardFx={cardFx}
                  hornGlow={!!rowFx.me.siege}
                  hiddenIds={sweepHiddenIds}
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
                  (pending.kind === "horn" && ((me.board.mardroemeCards[r] || []).length > 0 || (me.board.hornCards[r] || []).length > 0)) ||
                  (pending.kind === "mardroeme" && ((me.board.hornCards[r] || []).length > 0 || (me.board.mardroemeCards[r] || []).length > 0));
                return (
                  <button
                    key={r}
                    type="button"
                    className="btn btn-gold"
                    disabled={blocked}
                    title={blocked ? "This row already has a Horn or Mardroeme active — a row can only carry one" : undefined}
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

      {medicChainPending && !me.forceRandomRevive && medicPickerReady && (
        <div className="overlay">
          <div className="round-banner">
            <div className="ribbon">MEDIC — REVIVE A CARD</div>
            <div className="pool-grid">
              {medicEligible(me.discard).map((id) => (
                <CardTile key={id} card={cardById(id)} size="sm" onClick={() => onResolveMedicRevive(id)} />
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
        <button type="button" className="mode-card" onClick={() => onSelect("test")}>
          <span className="mode-title">Test Mode</span>
          <span className="mode-desc">Rig both hands and draw order, then play out a match vs. AI.</span>
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
  // Gates GameOverPanel behind the round win/loss banner+sound+sweep on the
  // game-ending round (see GAME_END_REVEAL_DELAY_MS) instead of cutting
  // straight to the results screen the instant gameEnd phase is entered.
  const [revealGameOver, setRevealGameOver] = useState(false);

  const builder1 = useDeckBuilderState();
  const builder2 = useDeckBuilderState();

  useEffect(() => {
    if (!state || state.phase !== "gameEnd") { setRevealGameOver(false); return; }
    const isTie = state.lastRoundScore && state.lastRoundScore.p1 === state.lastRoundScore.p2;
    const t = setTimeout(() => setRevealGameOver(true), isTie ? GAME_END_REVEAL_DELAY_TIE_MS : GAME_END_REVEAL_DELAY_MS);
    return () => clearTimeout(t);
  }, [state?.phase, state?.round]);

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

  if (state.phase === "play" && revealedTurn !== state.turn) {
    return <PassDeviceGate name={state.players[state.turn].name} onContinue={() => setRevealedTurn(state.turn)} />;
  }

  // play/roundEnd/gameEnd all render through this single shared shape now —
  // PlayBoard used to be returned bare on "play" but wrapped in a fragment
  // with sibling banners on "roundEnd"/"gameEnd", so React saw a different
  // tree shape at that position on every phase change and remounted
  // PlayBoard from scratch each time. That wiped its internal
  // prevSweepPhaseRef (see PlayBoard's v41 sweep effect) before it ever got
  // to observe the roundEnd -> play transition, so the round-end sweep to
  // discard could never fire. Keeping PlayBoard in the same fragment
  // position across every phase (banners just render null when not
  // applicable) means it now stays mounted the whole game, so that ref
  // survives and the sweep works.
  if (state.phase === "play" || state.phase === "roundEnd" || state.phase === "gameEnd") {
    const isPlay = state.phase === "play";
    const me = state.turn;
    const opp = otherKey(me);
    const isTie = state.lastRoundScore && state.lastRoundScore.p1 === state.lastRoundScore.p2;
    return (
      <>
        <PlayBoard
          state={state}
          viewerRole={me}
          opponentRole={opp}
          viewerName={state.players[me].name}
          opponentName={state.players[opp].name}
          isMyTurn={isPlay}
          canAct={isPlay}
          onPlayCard={(cardId, options) => setState((s) => gameReducer(s, { type: "PLAY_CARD", player: me, cardId, options }))}
          onPass={() => setState((s) => gameReducer(s, { type: "PASS", player: me }))}
          onForfeit={() => setState((s) => gameReducer(s, { type: "FORFEIT", player: me }))}
          onUseLeader={(options) => setState((s) => gameReducer(s, { type: "USE_LEADER", player: me, options }))}
          onResolveMedicRevive={(reviveId) => setState((s) => gameReducer(s, { type: "RESOLVE_MEDIC_REVIVE", player: me, reviveId }))}
          onResolveScorchBurn={() => setState((s) => gameReducer(s, { type: "RESOLVE_SCORCH_BURN" }))}
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
        {/* Game-ending round: same round-complete banner first (shared
            device, so still no viewerName — see RoundBanner — meaning no
            round win/loss clip plays here either, same as any other
            Hotseat round-end), giving the board-sweep animation in
            PlayBoard room to run before GameOverPanel cuts in. */}
        {state.phase === "gameEnd" && !revealGameOver && (
          <RoundBanner
            round={state.round}
            score={state.lastRoundScore}
            isTie={isTie}
            isGameEnd
            gameWinnerName={state.gameWinner === "draw" ? null : state.players[state.gameWinner].name}
            hideButton
          />
        )}
        {state.phase === "gameEnd" && revealGameOver && <GameOverPanel state={state} onExit={onExit} />}
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
  // Gates GameOverPanel behind the round win/loss banner+sound+sweep on the
  // game-ending round — see GAME_END_REVEAL_DELAY_MS / HotseatGame's twin.
  const [revealGameOver, setRevealGameOver] = useState(false);

  useEffect(() => {
    if (!state || state.phase !== "gameEnd") { setRevealGameOver(false); return; }
    const isTie = state.lastRoundScore && state.lastRoundScore.p1 === state.lastRoundScore.p2;
    const t = setTimeout(() => setRevealGameOver(true), isTie ? GAME_END_REVEAL_DELAY_TIE_MS : GAME_END_REVEAL_DELAY_MS);
    return () => clearTimeout(t);
  }, [state?.phase, state?.round]);

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

  // AI's own Medic chain: each link resolves as its own paced dispatch
  // (rather than the reducer looping through the whole chain in one shot)
  // so the sound/animation for a revived card lands separately from the
  // Medic unit's own landing sound, same as the human-controlled side.
  useEffect(() => {
    if (!state) return;
    if (state.phase === "play" && state.awaitingMedicRevive?.player === "p2") {
      const delay = Math.max(900, soundGateRemainingMs());
      aiTimerRef.current = setTimeout(() => {
        const pick = bestMedicRevive(state.players.p2.discard);
        setState((s) => gameReducer(s, { type: "RESOLVE_MEDIC_REVIVE", player: "p2", reviveId: pick }));
      }, delay);
      return () => clearTimeout(aiTimerRef.current);
    }
  }, [state]);

  useEffect(() => {
    if (!state) return;
    if (state.phase === "play" && state.turn === "p2" && !state.players.p2.passed && !state.awaitingMedicRevive && !state.pendingBurn) {
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
    return <CoinFlipPanel coinFlip={state.coinFlip} myKey="p1" myName="You" oppName="AI Opponent"
      onAck={() => setState((s) => gameReducer(s, { type: "COIN_ACK" }))} />;
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

  if (state.phase === "play" || state.phase === "roundEnd" || state.phase === "gameEnd") {
    // play/roundEnd/gameEnd all render through this single shared shape now
    // (see HotseatGame for the full rationale) — PlayBoard used to be bare
    // on "play" but fragment-wrapped with sibling banners on
    // "roundEnd"/"gameEnd", so React remounted it on every phase change and
    // lost the ref that detects the roundEnd -> play transition, which
    // silently broke the round-end discard sweep. Keeping the same fragment
    // shape (and PlayBoard always first in it) across all three phases
    // keeps it mounted for the whole game.
    const isTie = state.lastRoundScore && state.lastRoundScore.p1 === state.lastRoundScore.p2;
    return (
      <>
        <PlayBoard
          state={state}
          viewerRole="p1"
          opponentRole="p2"
          viewerName="You"
          opponentName="AI Opponent"
          isMyTurn={state.phase === "play" && state.turn === "p1"}
          canAct={state.phase === "play" && state.turn === "p1"}
          onPlayCard={(cardId, options) => setState((s) => gameReducer(s, { type: "PLAY_CARD", player: "p1", cardId, options }))}
          onPass={() => setState((s) => gameReducer(s, { type: "PASS", player: "p1" }))}
          onForfeit={() => setState((s) => gameReducer(s, { type: "FORFEIT", player: "p1" }))}
          onUseLeader={(options) => setState((s) => gameReducer(s, { type: "USE_LEADER", player: "p1", options }))}
          onResolveMedicRevive={(reviveId) => setState((s) => gameReducer(s, { type: "RESOLVE_MEDIC_REVIVE", player: "p1", reviveId }))}
          onResolveScorchBurn={() => setState((s) => gameReducer(s, { type: "RESOLVE_SCORCH_BURN" }))}
          opponentThinking={state.phase === "play" && state.turn === "p2" && !state.players.p2.passed}
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
        {state.phase === "gameEnd" && !revealGameOver && (
          <RoundBanner
            round={state.round}
            score={state.lastRoundScore}
            isTie={isTie}
            isGameEnd
            gameWinnerName={state.gameWinner === "draw" ? null : (state.gameWinner === "p1" ? "You" : "AI Opponent")}
            viewerName="You"
            hideButton
          />
        )}
        {state.phase === "gameEnd" && revealGameOver && <GameOverPanel state={state} onExit={onExit} onPlayAgain={playAgain} gameLog={gameLogRef.current} viewerRole="p1" />}
      </>
    );
  }

  return null;
}

/* ============================= TEST MODE ================================
   Rig both starting hands, both decks' draw order, and who opens — then
   play out a normal Vs. AI match (AI drives its own side exactly as in
   AIGame). Coin toss and mulligan are skipped entirely: a simple "who
   starts" choice (like Scoia'tael's) always runs instead, and both hands
   are marked mulligan-done the instant play would otherwise begin. */
function TestGame({ onExit }) {
  const [step, setStep] = useState("deck1"); // deck1, deck2, hand1, hand2, order1, order2, play
  const [state, setState] = useState(null);
  const p1builder = useDeckBuilderState();
  const p2builder = useDeckBuilderState();
  const [p1Hand, setP1Hand] = useState([]);
  const [p2Hand, setP2Hand] = useState([]);
  const [p1Order, setP1Order] = useState([]);
  const [p2Order, setP2Order] = useState([]);
  const aiTimerRef = useRef(null);
  const gameLogRef = useRef({ startedAt: null, decisions: [] });
  const [revealGameOver, setRevealGameOver] = useState(false);

  useEffect(() => {
    if (!state || state.phase !== "gameEnd") { setRevealGameOver(false); return; }
    const isTie = state.lastRoundScore && state.lastRoundScore.p1 === state.lastRoundScore.p2;
    const t = setTimeout(() => setRevealGameOver(true), isTie ? GAME_END_REVEAL_DELAY_TIE_MS : GAME_END_REVEAL_DELAY_MS);
    return () => clearTimeout(t);
  }, [state?.phase, state?.round]);

  function startGame(p2HandFinal, p2OrderFinal) {
    const p1cfg = { name: "You", faction: p1builder.faction, leaderId: p1builder.leaderId, deckIds: p1builder.selected, isAI: false };
    const p2cfg = { name: "AI Opponent", faction: p2builder.faction, leaderId: p2builder.leaderId, deckIds: p2builder.selected, isAI: true };
    const initial = initTestGame(p1cfg, p2cfg, p1Hand, p1Order, p2HandFinal, p2OrderFinal);
    gameLogRef.current = {
      startedAt: new Date().toISOString(),
      you: { faction: p1cfg.faction, leaderId: p1cfg.leaderId },
      aiOpponent: { faction: p2cfg.faction, leaderId: p2cfg.leaderId },
      decisions: [],
    };
    setState(initial);
    setStep("play");
  }

  function playAgain() {
    clearTimeout(aiTimerRef.current);
    setState(null);
    gameLogRef.current = { startedAt: null, decisions: [] };
    setP1Hand([]); setP2Hand([]); setP1Order([]); setP2Order([]);
    setStep("deck1");
  }

  // Skip mulligan entirely — both hands were already hand-picked, so mark
  // them done the instant the reducer would otherwise show the mulligan
  // screen. Coin toss is likewise never entered (initTestGame starts on
  // "scoiaChoice" unconditionally).
  useEffect(() => {
    if (!state || state.phase !== "mulligan") return;
    let s = state;
    if (!s.players.p1.mulliganDone) s = gameReducer(s, { type: "MULLIGAN_DONE", player: "p1" });
    if (!s.players.p2.mulliganDone) s = gameReducer(s, { type: "MULLIGAN_DONE", player: "p2" });
    setState(s);
  }, [state]);

  useEffect(() => {
    if (!state) return;
    if (state.phase === "play" && state.awaitingMedicRevive?.player === "p2") {
      const delay = Math.max(900, soundGateRemainingMs());
      aiTimerRef.current = setTimeout(() => {
        const pick = bestMedicRevive(state.players.p2.discard);
        setState((s) => gameReducer(s, { type: "RESOLVE_MEDIC_REVIVE", player: "p2", reviveId: pick }));
      }, delay);
      return () => clearTimeout(aiTimerRef.current);
    }
  }, [state]);

  useEffect(() => {
    if (!state) return;
    if (state.phase === "play" && state.turn === "p2" && !state.players.p2.passed && !state.awaitingMedicRevive && !state.pendingBurn) {
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

  if (step === "deck1") {
    return <DeckBuilder playerLabel="You: build your deck" faction={p1builder.faction} onFactionChange={p1builder.setFaction}
      lockFaction={false} selectedIds={p1builder.selected} onToggleCard={p1builder.toggle}
      leaderId={p1builder.leaderId} onSelectLeader={p1builder.setLeaderId} onConfirm={() => setStep("deck2")} onRandomize={p1builder.randomize}
      savedDecks={p1builder.savedDecks} onSaveDeck={p1builder.saveDeck} onLoadDeck={p1builder.loadDeck} onDeleteDeck={p1builder.deleteDeck}
      onBack={onExit} />;
  }
  if (step === "deck2") {
    return <DeckBuilder playerLabel="AI Opponent: build its deck" faction={p2builder.faction} onFactionChange={p2builder.setFaction}
      lockFaction={false} selectedIds={p2builder.selected} onToggleCard={p2builder.toggle}
      leaderId={p2builder.leaderId} onSelectLeader={p2builder.setLeaderId} onConfirm={() => setStep("hand1")} onRandomize={p2builder.randomize}
      savedDecks={p2builder.savedDecks} onSaveDeck={p2builder.saveDeck} onLoadDeck={p2builder.loadDeck} onDeleteDeck={p2builder.deleteDeck}
      onBack={() => setStep("deck1")} />;
  }
  if (step === "hand1") {
    return <CardPickerPanel playerLabel="You: pick your starting hand" instruction={`Pick exactly ${HAND_SIZE} cards, in whatever order — this becomes your opening hand.`}
      pool={p1builder.selected} picked={p1Hand}
      onPick={(id) => setP1Hand((h) => [...h, id])} onUnpick={(id) => setP1Hand((h) => h.filter((x) => x !== id))}
      minCount={HAND_SIZE} maxCount={HAND_SIZE} onDone={() => setStep("hand2")} onBack={() => setStep("deck2")} />;
  }
  if (step === "hand2") {
    return <CardPickerPanel playerLabel="AI Opponent: pick its starting hand" instruction={`Pick exactly ${HAND_SIZE} cards, in whatever order — this becomes the AI's opening hand.`}
      pool={p2builder.selected} picked={p2Hand}
      onPick={(id) => setP2Hand((h) => [...h, id])} onUnpick={(id) => setP2Hand((h) => h.filter((x) => x !== id))}
      minCount={HAND_SIZE} maxCount={HAND_SIZE} onDone={() => setStep("order1")} onBack={() => setStep("hand1")} />;
  }
  if (step === "order1") {
    const remaining = p1builder.selected.filter((id) => !p1Hand.includes(id));
    return <CardPickerPanel playerLabel="You: pick your draw order" instruction="Click cards in the order you want them drawn from your deck (round draws, card effects that pull from the deck, etc). Anything left unpicked gets shuffled in behind these."
      pool={remaining} picked={p1Order}
      onPick={(id) => setP1Order((o) => [...o, id])} onUnpick={(id) => setP1Order((o) => o.filter((x) => x !== id))}
      minCount={0} maxCount={remaining.length} onDone={() => setStep("order2")} onBack={() => setStep("hand2")} />;
  }
  if (step === "order2") {
    const remaining = p2builder.selected.filter((id) => !p2Hand.includes(id));
    return <CardPickerPanel playerLabel="AI Opponent: pick its draw order" instruction="Click cards in the order you want them drawn from the AI's deck. Anything left unpicked gets shuffled in behind these."
      pool={remaining} picked={p2Order}
      onPick={(id) => setP2Order((o) => [...o, id])} onUnpick={(id) => setP2Order((o) => o.filter((x) => x !== id))}
      minCount={0} maxCount={remaining.length} onDone={() => startGame(p2Hand, p2Order)} onBack={() => setStep("order1")} />;
  }

  if (!state) return null;

  if (state.phase === "scoiaChoice") {
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

  if (state.phase === "play" || state.phase === "roundEnd" || state.phase === "gameEnd") {
    const isTie = state.lastRoundScore && state.lastRoundScore.p1 === state.lastRoundScore.p2;
    return (
      <>
        <PlayBoard
          state={state}
          viewerRole="p1"
          opponentRole="p2"
          viewerName="You"
          opponentName="AI Opponent"
          isMyTurn={state.phase === "play" && state.turn === "p1"}
          canAct={state.phase === "play" && state.turn === "p1"}
          onPlayCard={(cardId, options) => setState((s) => gameReducer(s, { type: "PLAY_CARD", player: "p1", cardId, options }))}
          onPass={() => setState((s) => gameReducer(s, { type: "PASS", player: "p1" }))}
          onForfeit={() => setState((s) => gameReducer(s, { type: "FORFEIT", player: "p1" }))}
          onUseLeader={(options) => setState((s) => gameReducer(s, { type: "USE_LEADER", player: "p1", options }))}
          onResolveMedicRevive={(reviveId) => setState((s) => gameReducer(s, { type: "RESOLVE_MEDIC_REVIVE", player: "p1", reviveId }))}
          onResolveScorchBurn={() => setState((s) => gameReducer(s, { type: "RESOLVE_SCORCH_BURN" }))}
          opponentThinking={state.phase === "play" && state.turn === "p2" && !state.players.p2.passed}
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
        {state.phase === "gameEnd" && !revealGameOver && (
          <RoundBanner
            round={state.round}
            score={state.lastRoundScore}
            isTie={isTie}
            isGameEnd
            gameWinnerName={state.gameWinner === "draw" ? null : (state.gameWinner === "p1" ? "You" : "AI Opponent")}
            viewerName="You"
            hideButton
          />
        )}
        {state.phase === "gameEnd" && revealGameOver && <GameOverPanel state={state} onExit={onExit} onPlayAgain={playAgain} gameLog={gameLogRef.current} viewerRole="p1" />}
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
  pendingBurn: null, lastScorchCast: null,
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
  // Gates the GAME OVER overlay behind the round win/loss banner+sound+sweep
  // on the game-ending round — see GAME_END_REVEAL_DELAY_MS / HotseatGame's
  // twin. Runs independently on each connected client off the synced meta,
  // so both sides reveal at roughly the same real time.
  const [revealGameOver, setRevealGameOver] = useState(false);

  useEffect(() => {
    if (!meta || meta.phase !== "gameEnd") { setRevealGameOver(false); return; }
    const isTie = meta.lastRoundScore && meta.lastRoundScore.p1 === meta.lastRoundScore.p2;
    const t = setTimeout(() => setRevealGameOver(true), isTie ? GAME_END_REVEAL_DELAY_TIE_MS : GAME_END_REVEAL_DELAY_MS);
    return () => clearTimeout(t);
  }, [meta?.phase, meta?.round]);

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

  if (meta.phase === "play" || meta.phase === "roundEnd" || meta.phase === "gameEnd") {
    if (!mine || !theirs) return <div className="screen online-lobby"><p className="mulligan-hint">Syncing…</p></div>;
    const isPlay = meta.phase === "play";

    // play/roundEnd/gameEnd all render through this single shared shape now
    // (see HotseatGame for the full rationale) — PlayBoard used to be
    // fragment-wrapped differently on "play" (optional disconnect-banner +
    // PlayBoard) vs "roundEnd"/"gameEnd" (PlayBoard + banner slots), so
    // React remounted it on every phase change and lost the ref that
    // detects the roundEnd -> play transition, which silently broke the
    // round-end discard sweep. Keeping the same fragment shape (disconnect
    // banner, then PlayBoard, then the round/game banner slots — each null
    // when not applicable) across all three phases keeps it mounted for the
    // whole game.
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

    let gameEndBannerEl = null;
    let gameOverEl = null;
    if (meta.phase === "gameEnd") {
      const p1s = meta.lastRoundScore ? meta.lastRoundScore.p1 : 0;
      const p2s = meta.lastRoundScore ? meta.lastRoundScore.p2 : 0;
      const isTie = p1s === p2s;
      let roundWinnerName = null;
      if (!isTie) {
        const p1Won = p1s > p2s;
        const iAmP1 = role === "p1";
        roundWinnerName = p1Won === iAmP1 ? "You" : "Opponent";
      }
      const iWon = meta.gameWinner === role;
      const isDraw = meta.gameWinner === "draw";
      // Same round-complete banner (and its win/loss clip) as any other
      // round-end first, giving the board-sweep animation in PlayBoard room
      // to run — see revealGameOver / GAME_END_REVEAL_DELAY_MS — before the
      // GAME OVER overlay (and its own won/lost clip) cuts in.
      if (!revealGameOver) {
        gameEndBannerEl = (
          <RoundBanner
            round={meta.round}
            score={meta.lastRoundScore}
            isTie={isTie}
            roundWinnerName={roundWinnerName}
            isGameEnd
            gameWinnerName={isDraw ? null : (iWon ? "You" : "Opponent")}
            hideButton
            viewerName="You"
          />
        );
      } else {
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
    }

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
          isMyTurn={isPlay && meta.turn === role}
          canAct={isPlay && meta.turn === role}
          onPlayCard={(cardId, options) => applyAction({ type: "PLAY_CARD", player: role, cardId, options })}
          onPass={() => applyAction({ type: "PASS", player: role })}
          onForfeit={() => applyAction({ type: "FORFEIT", player: role })}
          onUseLeader={(options) => applyAction({ type: "USE_LEADER", player: role, options })}
          onResolveMedicRevive={(reviveId) => applyAction({ type: "RESOLVE_MEDIC_REVIVE", player: role, reviveId })}
          onResolveScorchBurn={() => applyAction({ type: "RESOLVE_SCORCH_BURN" })}
        />
        {roundBannerEl}
        {gameEndBannerEl}
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
  width: 100%;
  transform: scaleX(var(--forfeit-progress, 0));
  transform-origin: left center;
  background: linear-gradient(90deg, #7a2323, #c23c3c);
  transition: transform 0.05s linear;
  z-index: 0;
  will-change: transform;
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
.horn-card-slot-my .card-tile { height: 90%; width: 147%; margin: 15% 0 0 -20%; aspect-ratio: 0.55 / 1; }
.horn-card-slot-opp .card-tile { height: 90%; width: 147%; margin: -2% 0 0 -20%; aspect-ratio: 0.55 / 1; }
.weather-card-slot { position: relative; flex: 1 1 0; min-height: 0; width: 100%; max-width: 100%; height: 100%; }
.row-cards { position: relative; z-index: 1; display: flex; align-items: flex-start; justify-content: flex-start; width: 100%; height: 100%; overflow: hidden; }
.row-cards.row-close { display: flex; align-items: flex-end; }
.cell-opp-close-row .row-cards.row-close { align-items: flex-start; height: 90%;}
.row-cards.row-ranged, .row-cards.row-siege { display: flex; align-items: center; }

/* ---------------------------- v39 ANIMATIONS -----------------------------
   Ability visuals, synced from PlayBoard to the exact sound clip each one
   is layered under (see SOUND_DURATIONS_MS / triggerAbilityFx). These all
   need to paint outside the card's own box (glows, floating text) so
   overflow is opened back up just for the duration each class is applied.
   Art clipping no longer depends on this staying "hidden" — .card-art-clip
   (see above) clips the art independently and permanently, so oversized art
   (e.g. the leader portrait) can never spill out during these animations
   in any slot, no per-context exceptions needed. */
.card-tile.card-burning, .card-tile.card-hero-shine, .card-tile.card-transform-cloud,
.card-tile.card-spy-fog, .card-tile.card-bond-glow, .card-tile.card-morale-boost,
.card-tile.card-morale-plus-one, .card-tile.card-muster-pop, .card-tile.card-muster-glow, .card-tile.card-decoy-swap,
.card-tile.card-leader-cast {
  overflow: visible;
}
@keyframes fxFadeInOut { 0% { opacity: 0; } 20% { opacity: 1; } 70% { opacity: 0.8; } 100% { opacity: 0; } }

/* Scorch — burns in place, in its own row slot, right up until the delayed
   RESOLVE_SCORCH_BURN dispatch actually removes it from the board (see
   PlayBoard's pendingBurn effect) — so the fire finishes before the card
   itself ever disappears. */
@keyframes cardBurn {
  0%   { filter: brightness(1) saturate(1); }
  15%  { filter: brightness(1.25) saturate(1.4); }
  40%  { filter: brightness(1.1) saturate(1.6) sepia(0.3); }
  70%  { filter: brightness(0.9) saturate(1.8) sepia(0.55); }
  100% { filter: brightness(0.35) saturate(0.25) grayscale(0.65); opacity: 0.2; transform: scale(0.92); }
}
.card-tile.card-burning { animation: cardBurn 1.75s ease-in forwards; z-index: 4; pointer-events: none; }
.card-tile.card-burning::after {
  content: "";
  position: absolute; inset: -8%;
  background: radial-gradient(circle at 50% 62%, rgba(255,170,60,0.9), rgba(255,80,10,0.55) 45%, rgba(120,20,0,0) 75%);
  mix-blend-mode: screen;
  animation: cardBurn-glow 1.75s ease-in forwards;
  pointer-events: none;
  z-index: 1;
}
@keyframes cardBurn-glow { 0% { opacity: 0; } 20% { opacity: 0.9; } 60% { opacity: 0.75; } 100% { opacity: 0; } }

/* Detailed flame/ember/smoke overlay, layered on top of the char/darken
   animation above via ScorchFireOverlay. */
.scorch-card-container {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: visible;
  border-radius: inherit;
  z-index: 100;
}
.scorch-char-mask {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background:
    radial-gradient(circle at 50% 90%, rgba(255, 60, 0, 0.45) 0%, transparent 60%),
    radial-gradient(circle at 50% 100%, rgba(0, 0, 0, 0.88) 15%, rgba(20, 5, 0, 0.75) 50%, transparent 85%);
  mix-blend-mode: multiply;
  animation: charDarkening 0.8s ease-out forwards;
}
@keyframes charDarkening { 0% { opacity: 0; } 100% { opacity: 1; } }
.scorch-fire-core {
  position: absolute;
  bottom: -10%;
  left: -10%;
  width: 120%;
  height: 70%;
  background: radial-gradient(ellipse at bottom, #ffe600 0%, #ff5500 40%, #8b0000 75%, transparent 100%);
  filter: blur(8px);
  mix-blend-mode: screen;
  animation: fireCorePulse 0.15s ease-in-out infinite alternate;
}
@keyframes fireCorePulse {
  0% { transform: scaleY(0.95) scaleX(0.98); opacity: 0.85; }
  100% { transform: scaleY(1.08) scaleX(1.03); opacity: 1; }
}
@keyframes flameTongueDanceA {
  0%   { transform: scaleY(1) scaleX(1) skewX(0deg); opacity: 0.9; }
  25%  { transform: scaleY(1.2) scaleX(0.9) skewX(-4deg); opacity: 1; }
  50%  { transform: scaleY(0.95) scaleX(1.1) skewX(3deg); opacity: 0.85; }
  75%  { transform: scaleY(1.25) scaleX(0.85) skewX(-2deg); opacity: 0.95; }
  100% { transform: scaleY(1) scaleX(1) skewX(0deg); opacity: 0.9; }
}
@keyframes flameTongueDanceB {
  0%   { transform: scaleY(1.1) scaleX(0.95) skewX(3deg); opacity: 0.85; }
  30%  { transform: scaleY(0.9) scaleX(1.15) skewX(-5deg); opacity: 0.95; }
  60%  { transform: scaleY(1.3) scaleX(0.85) skewX(4deg); opacity: 1; }
  100% { transform: scaleY(1.1) scaleX(0.95) skewX(3deg); opacity: 0.85; }
}
.flame-layer {
  position: absolute;
  bottom: -15px;
  width: 100%;
  height: 120%;
  transform-origin: bottom center;
  pointer-events: none;
}
.flame-layer-back { animation: flameTongueDanceB 0.22s ease-in-out infinite alternate; filter: drop-shadow(0 0 12px #ff3300); }
.flame-layer-front { animation: flameTongueDanceA 0.18s ease-in-out infinite alternate; filter: drop-shadow(0 0 8px #ffaa00); }
@keyframes emberRiseAndSway {
  0% { transform: translateY(0) translateX(0) scale(1); opacity: 1; }
  50% { transform: translateY(-80px) translateX(-14px) scale(0.8); opacity: 0.85; }
  100% { transform: translateY(-160px) translateX(18px) scale(0.2); opacity: 0; }
}
.ember-particle {
  position: absolute;
  bottom: 10%;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #fff580;
  box-shadow: 0 0 6px #ff6600, 0 0 10px #ff3300;
  animation: emberRiseAndSway 0.9s cubic-bezier(0.25, 0.46, 0.45, 0.94) infinite;
}
@keyframes smokeWispRise {
  0% { transform: translateY(0) scaleX(1); opacity: 0; }
  30% { opacity: 0.4; }
  100% { transform: translateY(-70px) scaleX(1.8); opacity: 0; }
}
.scorch-top-smoke {
  position: absolute;
  top: -20px;
  left: 10%;
  width: 80%;
  height: 40px;
  background: radial-gradient(ellipse at center, rgba(80, 70, 65, 0.6) 0%, transparent 75%);
  filter: blur(8px);
  animation: smokeWispRise 1.2s ease-out infinite;
}

/* Hero landing — a spark travels once around the card border like a lit
   fuse, trailed by a fading echo dot, over a soft ambient bloom that
   breathes underneath so the card doesn't go dark between passes. Timed
   to SOUND_DURATIONS_MS.playingHero (2.6s). */
@keyframes cardHeroAmbient {
  0%, 100% { box-shadow: 0 0 0 rgba(255,225,140,0); filter: brightness(1); }
  50%      { box-shadow: 0 0 14px 5px rgba(255,205,110,0.55); filter: brightness(1.08); }
}
.card-tile.card-hero-shine { animation: cardHeroAmbient 2.6s ease-in-out 1; z-index: 3; }
@keyframes cardHeroSparkTravel {
  0%   { offset-distance: 0%; opacity: 0; }
  4%   { opacity: 1; }
  92%  { opacity: 1; }
  100% { offset-distance: 100%; opacity: 0; }
}
.card-tile.card-hero-shine::before, .card-tile.card-hero-shine::after {
  content: "";
  position: absolute;
  top: 0; left: 0;
  width: 9px; height: 9px;
  margin: -4.5px;
  border-radius: 50%;
  background: #fff8dd;
  box-shadow: 0 0 8px 3px rgba(255,220,120,0.95), 0 0 16px 7px rgba(255,180,60,0.6);
  offset-path: inset(0 round 6px);
  animation: cardHeroSparkTravel 2.6s linear 1;
  pointer-events: none;
  z-index: 6;
}
.card-tile.card-hero-shine::after {
  width: 7px; height: 7px;
  margin: -3.5px;
  opacity: 0.55;
  animation-delay: -0.09s;
  filter: blur(0.5px);
}

/* Mardroeme / Spy / Decoy — the card itself goes fully opaque (art + text
   both hidden, swapped for a flat color) for the duration of the effect —
   NOT a translucent tint. z-index 10 puts it above .card-tile-inner's text
   layer (z-index 1) and .card-art (z-index 0) so the whole card disappears
   under the flat color, not just the artwork. The actual smoke/fog CLOUD
   that spills out around and beyond the card is handled separately by
   AbilitySmokeGhost + .smoke-fx-layer (rendered as a portal directly inside
   .board-frame, escaping the row/cell's hard overflow:hidden) — see the
   "v39.2 smoke" block further down. */
@keyframes cardTransformCloud { 0% { opacity: 0; } 18% { opacity: 1; } 65% { opacity: 1; } 100% { opacity: 0; } }
.card-tile.card-transform-cloud::before {
  content: "";
  position: absolute; inset: 0;
  background: #5c0808;
  animation: cardTransformCloud 1.878s ease-in-out 1;
  pointer-events: none;
  border-radius: inherit;
  z-index: 10;
}

/* Spy — the card goes fully opaque, dark sooty grey, as it lands on the
   opponent's side. */
.card-tile.card-spy-fog::before {
  content: "";
  position: absolute; inset: 0;
  background: #26292d;
  animation: fxFadeInOut 2.667s ease-in-out 1;
  pointer-events: none;
  border-radius: inherit;
  z-index: 10;
}

/* Bond — every sibling in the group pulses gold together, not just the one
   just played. */
@keyframes cardBondGlow { 0%, 100% { box-shadow: 0 0 0 rgba(255,205,90,0); } 50% { box-shadow: 0 0 16px 6px rgba(255,205,90,0.75); } }
.card-tile.card-bond-glow { animation: cardBondGlow 1.9s ease-in-out 1; z-index: 3; }

/* Morale & Muster — an ability icon pops/bounces up over the card, and
   (Muster only) the freshly-fetched sibling gets a pulsing gold glow for
   the duration of its cardFx entry. */
.card-tile.card-morale-boost, .card-tile.card-muster-pop, .card-tile.card-muster-glow, .card-tile.card-morale-plus-one { z-index: 3; }
@keyframes iconPopAndBounce {
  0% { transform: translate(-50%, -50%) scale(0) rotate(-10deg); opacity: 0; }
  35% { transform: translate(-50%, -50%) scale(1.35) rotate(5deg); opacity: 1; }
  65% { transform: translate(-50%, -50%) scale(0.95) rotate(0deg); opacity: 1; }
  82% { transform: translate(-50%, -50%) scale(1.08); opacity: 1; }
  100% { transform: translate(-50%, -50%) scale(1); opacity: 0; }
}
.anim-ability-icon-pop {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 105%;
  height: 105%;
  z-index: 150;
  pointer-events: none;
  animation: iconPopAndBounce 1.1s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards;
}
.anim-ability-icon-pop .ability-icon-svg { width: 100%; height: 100%; display: block; }
@keyframes moralePlusOneFloat {
  0%   { transform: translate(-50%, -35%) scale(0.6); opacity: 0; }
  20%  { transform: translate(-50%, -60%) scale(1.15); opacity: 1; }
  35%  { transform: translate(-50%, -70%) scale(1); opacity: 1; }
  80%  { transform: translate(-50%, -110%) scale(1); opacity: 1; }
  100% { transform: translate(-50%, -135%) scale(0.9); opacity: 0; }
}
.anim-morale-plus-one {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 150;
  pointer-events: none;
  font-weight: 800;
  font-size: 1.3rem;
  color: #ffe27a;
  text-shadow: 0 0 6px rgba(255, 205, 90, 0.95), 0 0 12px rgba(255, 170, 50, 0.7), 0 1px 2px rgba(0,0,0,0.8);
  animation: moralePlusOneFloat 1.4s cubic-bezier(0.2, 0.7, 0.3, 1) forwards;
  white-space: nowrap;
}
@keyframes musterGatherGlow {
  0% { box-shadow: 0 0 4px #ffc107; transform: scale(1); }
  50% { box-shadow: 0 0 24px #ffb300, 0 0 12px #ffe082; transform: scale(1.04); }
  100% { box-shadow: 0 0 4px #ffc107; transform: scale(1); }
}
.anim-muster-summon-glow {
  animation: musterGatherGlow 1s ease-in-out infinite alternate;
  border-radius: 6px;
}

/* Decoy — the card goes fully opaque, very light grey, as the swap lands. */
.card-tile.card-decoy-swap::before {
  content: "";
  position: absolute; inset: 0;
  background: #d6d8db;
  animation: fxFadeInOut 1.966s ease-in-out 1;
  pointer-events: none;
  border-radius: inherit;
  z-index: 10;
}

/* Leader cast — a pulsing gold aura around the portrait itself. */
@keyframes cardLeaderCast { 0%, 100% { box-shadow: 0 0 0 rgba(255,215,120,0); } 50% { box-shadow: 0 0 20px 8px rgba(255,215,120,0.85); } }
.card-tile.card-leader-cast { animation: cardLeaderCast 2.4s ease-in-out 1; z-index: 3; }

/* Horn — a pulsing gold aura across the whole boosted row (own side only). */
@keyframes rowHornGlow { 0%, 100% { box-shadow: inset 0 0 0 rgba(255,205,90,0); } 50% { box-shadow: inset 0 0 26px 10px rgba(255,205,90,0.55); } }
.row-cards.row-horn-glow { animation: rowHornGlow 2.1s ease-in-out 1; }

/* ==========================================================================
   CONTINUOUS WEATHER EFFECTS (Rows & Weather Cards)
   ========================================================================== */
/* --- Torrential Rain (Siege Row & Active Rain Card) --- */
.weather-rain-container {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  z-index: 0;
  border-radius: inherit;
  border: 1.5px solid rgba(90, 130, 160, 0.4);
  box-shadow: inset 0 0 16px rgba(70, 110, 140, 0.3);
  background: rgba(120, 150, 175, 0.10);
}
@keyframes continuousRainDrop {
  0% { transform: translateY(-100%) translateX(0); opacity: 0; }
  20% { opacity: 0.9; }
  85% { opacity: 0.9; }
  100% { transform: translateY(115%) translateX(-22px); opacity: 0; }
}
.rain-streak {
  position: absolute;
  width: 2px;
  height: 28px;
  background: linear-gradient(to bottom, transparent, rgba(185, 230, 255, 0.95));
  animation: continuousRainDrop 0.45s linear infinite;
  filter: drop-shadow(0 0 2px rgba(0, 150, 255, 0.6));
}
/* --- Biting Frost (Close Combat Row & Active Frost Card) --- */
.weather-frost-container {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  z-index: 0;
  border-radius: inherit;
  border: 1.5px solid rgba(0, 229, 255, 0.5);
  box-shadow: inset 0 0 16px rgba(0, 229, 255, 0.35);
  background: rgba(140, 210, 255, 0.10);
}
.cell-my-close-row .weather-frost-container {
  transform: translateY(10%);
}
@keyframes continuousSnowflakeSway {
  0% { transform: translateY(-20%) translateX(0) rotate(0deg); opacity: 0; }
  20% { opacity: 0.95; }
  80% { opacity: 0.95; }
  100% { transform: translateY(120%) translateX(16px) rotate(360deg); opacity: 0; }
}
.snowflake-particle {
  position: absolute;
  color: #e0f7fa;
  font-size: 13px;
  text-shadow: 0 0 6px rgba(0, 229, 255, 0.9);
  animation: continuousSnowflakeSway 2.6s ease-in-out infinite;
}
/* --- Impenetrable Fog (Ranged Row) — volumetric swirling vortex instead
   of sliding gradient bands. Base tint kept light/transparent (0.13) so it
   reads as haze, not a solid cloud; the rotating stroke-swirls carry most
   of the visual weight. --- */
.weather-fog-swirl-container {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  z-index: 0;
  border-radius: inherit;
  background: rgba(150, 155, 160, 0.10);
}
@keyframes fogSwirlCW {
  0%   { transform: rotate(0deg) scale(1) translateX(0px); }
  50%  { transform: rotate(180deg) scale(1.2) translateX(25px); }
  100% { transform: rotate(360deg) scale(1) translateX(0px); }
}
@keyframes fogSwirlCCW {
  0%   { transform: rotate(0deg) scale(1.15) translateY(0px); }
  50%  { transform: rotate(-180deg) scale(0.9) translateY(-20px); }
  100% { transform: rotate(-360deg) scale(1.15) translateY(0px); }
}
@keyframes fogHorizontalDrift {
  0%   { transform: translateX(-20%); }
  50%  { transform: translateX(10%); }
  100% { transform: translateX(-20%); }
}
.fog-vortex-layer {
  position: absolute;
  width: 160%;
  height: 220%;
  top: -60%;
  left: -30%;
  opacity: 0.55;
  filter: blur(10px);
  mix-blend-mode: screen;
}
.fog-vortex-1 { animation: fogSwirlCW 12s linear infinite, fogHorizontalDrift 18s ease-in-out infinite; }
.fog-vortex-2 { animation: fogSwirlCCW 9s linear infinite, fogHorizontalDrift 14s ease-in-out infinite reverse; opacity: 0.45; }
.fog-vortex-3 { animation: fogSwirlCW 15s linear infinite; opacity: 0.35; }

/* Clear Weather — a sunbeam sweeps across the whole board once both sides
   have thawed out. */
.sunlight-ray-layer { position: absolute; inset: 0; z-index: 55; pointer-events: none; overflow: hidden; }
@keyframes sunlightSweep {
  0%   { opacity: 0; transform: translateX(-60%) rotate(18deg); }
  15%  { opacity: 0.9; }
  70%  { opacity: 0.7; }
  100% { opacity: 0; transform: translateX(60%) rotate(18deg); }
}
.sunlight-ray {
  position: absolute;
  top: -40%; left: 50%;
  width: 45%; height: 180%;
  background: linear-gradient(90deg, rgba(255,240,180,0) 0%, rgba(255,240,180,0.55) 45%, rgba(255,250,220,0.85) 50%, rgba(255,240,180,0.55) 55%, rgba(255,240,180,0) 100%);
  animation: sunlightSweep 3.4s ease-in-out 1;
  mix-blend-mode: screen;
}


.row-card-slot { position: relative; z-index: 2; height: 90%; width: 7%; flex: 0 0 auto; margin-left: 0%; }
.row-card-slot:first-of-type { margin-left: 0; }
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
/* Always-clipped independent of .card-tile's own overflow — see the v39
   ANIMATIONS comment below. This is what keeps oversized art (e.g. the
   137.5%-height leader portrait) from spilling past the tile whenever an
   fx class opens .card-tile's overflow back up for a glow/effect. */
.card-art-clip { position: absolute; inset: 0; overflow: hidden; border-radius: inherit; }
.card-art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: center; z-index: 0; }
.card-tile.no-art .card-art-clip { display: none; }
.card-tile-inner { position: relative; z-index: 1; display: flex; flex-direction: column; justify-content: flex-end; height: 100%; }
.card-tile.is-hero { border-left-color: var(--gold) !important; box-shadow: 0 0 0 1px var(--gold), 0 2px 4px rgba(0,0,0,0.4); }

.pending-hint { position: fixed; bottom: 90px; left: 0; right: 0; text-align: center; z-index: 41; background: rgba(0,0,0,0.75); padding: 6px; }

/* ---- Coin flip ---- */
.screen.coinflip { text-align: center; }
.coin-call-row { display: flex; gap: 12px; justify-content: center; margin-top: 18px; flex-wrap: wrap; }
.coin { width: 84px; height: 84px; border-radius: 50%; margin: 18px auto; background: radial-gradient(circle at 35% 30%, #f0d896, var(--gold) 60%, var(--gold-dim) 100%); border: 3px solid var(--gold-dim); box-shadow: 0 4px 10px rgba(0,0,0,0.5); }
.coin-spinning { animation: coin-spin 1.208s ease-in-out; }
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
  max-height: 90vh; width: auto; max-width: 92vw;
  overflow-y: auto;
}
.card-zoom-art-wrap {
  height: auto; width: auto; aspect-ratio: 0.537; border-radius: 10px; overflow: hidden;
  box-shadow: 0 10px 40px rgba(0,0,0,0.7), 0 0 0 2px var(--gold-dim);
  background: linear-gradient(160deg, var(--parchment), #d8cba3);
  flex: 1 1 auto;
  min-height: 0;
  max-height: 72vh;
  max-width: 92vw;
}
.card-zoom-art { width: 100%; height: 100%; object-fit: cover; display: block; }
.card-zoom-fallback { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--ink); font-family: var(--font-display); text-align: center; padding: 12px; }
.card-zoom-caption { text-align: center; color: var(--parchment); flex-shrink: 0; }
.card-zoom-title { font-family: var(--font-display); font-size: 1.15rem; color: var(--gold); display: flex; align-items: center; justify-content: center; gap: 8px; }
.card-zoom-power { font-family: var(--font-mono); background: var(--gold); color: #241d0e; border-radius: 50%; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.85rem; }
.card-zoom-meta { font-family: var(--font-mono); font-size: 0.72rem; color: var(--muted); margin-top: 4px; letter-spacing: 0.03em; }
.card-zoom-desc { font-size: 0.9rem; line-height: 1.4; color: var(--parchment); margin-top: 10px; max-width: 480px; }
@media (max-width: 520px) {
  .card-zoom-content { max-width: 96vw; max-height: 88vh; }
  .card-zoom-art-wrap { height: auto; max-height: 58vh; max-width: 96vw; }
}

@keyframes card-appear { 0% { opacity: 0; transform: scale(0.75) translateY(8px); } 100% { opacity: 1; transform: scale(1) translateY(0); } }
.row-cards .card-tile { animation: card-appear 0.32s ease-out; height:145%;}

@keyframes card-flash {
  0%, 100% { box-shadow: 0 0 0 2px var(--gold), 0 2px 4px rgba(0,0,0,0.4); }
  50% { box-shadow: 0 0 0 4px var(--gold), 0 0 18px 4px rgba(230, 190, 90, 0.8); }
}
.card-tile.card-just-played { animation: card-flash 1.1s ease-in-out 2; z-index: 2; }

/* Medic revival (in-place glow only — the actual "flies in from the discard
   pile" motion is a separate fixed-position ghost clone, see
   MedicRevivalGhost, since a translate on the real in-row tile gets clipped
   by that row's own overflow:hidden long before it reaches this box). Green
   to read as "brought back" rather than "freshly played", distinct from
   card-just-played on purpose. */
@keyframes card-revive {
  0% { opacity: 0; transform: scale(0.85); box-shadow: 0 0 0 2px #4caf6e, 0 2px 4px rgba(0,0,0,0.4); }
  35% { opacity: 1; transform: scale(1.06); box-shadow: 0 0 0 3px #4caf6e, 0 0 20px 6px rgba(76, 175, 110, 0.75); }
  70% { box-shadow: 0 0 0 3px #4caf6e, 0 0 20px 6px rgba(76, 175, 110, 0.75); }
  100% { opacity: 1; transform: scale(1); box-shadow: 0 0 0 2px #4caf6e, 0 2px 4px rgba(0,0,0,0.4); }
}
.card-tile.card-just-revived { animation: card-revive 1.3s ease-out 1; z-index: 3; }

/* Fixed-position ghost that carries the actual "from discard to row" motion
   (see MedicRevivalGhost + .medic-ghost-layer). Lives above everything —
   including any row's overflow:hidden, which it never enters since it's an
   absolutely-positioned sibling of the board table, not a descendant of any
   row. transform-origin top-left because its left/top/width/height are set
   to the LANDED (destination) rect, and the initial translate+scale is what
   visually places it at the discard pile instead — see the component. */
.medic-ghost-layer { position: absolute; inset: 0; pointer-events: none; z-index: 60; }
.medic-ghost-card { position: absolute; will-change: transform; }

/* Round-end / game-end sweep — cards flying off the board into the discard
   or deck pile (see SweepGhost). The outer element animates position/size
   via a plain CSS transition (left/top/width/height, set from JS once
   "flying" flips true) since — unlike the Medic ghost — there's no fixed
   destination rect known up front to invert-transform from; the inner
   element carries the optional flip as its own independent keyframe
   animation so the two motions (flight path, face-down flip) don't fight
   over the same transform property. */
.sweep-ghost-layer { position: absolute; inset: 0; pointer-events: none; z-index: 61; }
.sweep-ghost-card {
  position: absolute;
  transition: left 0.75s cubic-bezier(0.3, 0.6, 0.3, 1), top 0.75s cubic-bezier(0.3, 0.6, 0.3, 1),
    width 0.75s cubic-bezier(0.3, 0.6, 0.3, 1), height 0.75s cubic-bezier(0.3, 0.6, 0.3, 1), opacity 0.45s ease-in 0.35s;
  will-change: left, top, width, height, opacity;
}
.sweep-ghost-inner { width: 100%; height: 100%; }
.sweep-ghost-flip { animation: sweep-ghost-flip 0.75s ease-in-out 1; }
@keyframes sweep-ghost-flip {
  0% { transform: scaleX(1); }
  48% { transform: scaleX(0.04); }
  52% { transform: scaleX(0.04); }
  100% { transform: scaleX(1); }
}

/* ------------------------------ v39.2 smoke -------------------------------
   Spy fog / Decoy swap / Mardroeme's transform cloud — the actual billowing
   smoke, as opposed to the in-place opaque card cover above. Rendered by
   AbilitySmokeGhost as a portal directly inside .board-frame (same escape
   as the Medic ghost layer just above), anchored to the real card's
   measured rect, so it's free to spill top-to-bottom and all around the
   card without being cut off by the row's or board cell's overflow:hidden.
   Built from several irregular, offset, rotated "lobe" divs (position/size/
   color/rotation all supplied per-instance from SMOKE_LOBE_CONFIG) rather
   than one flat gradient, so it billows asymmetrically like real smoke
   instead of pulsing as a uniform blob. Duration comes in via the
   --smoke-dur custom property set inline per-instance, so it's always
   exactly as long as the sound it's synced to. */
.smoke-fx-layer { position: absolute; inset: 0; pointer-events: none; z-index: 59; }
.smoke-cloud-anchor { position: absolute; pointer-events: none; }
.smoke-viewport-unclipped {
  position: absolute;
  top: -7.5%; left: -7.5%;
  width: 115%; height: 115%;
  pointer-events: none;
  overflow: visible;
  will-change: transform, opacity;
  animation-duration: var(--smoke-dur, 2s);
  animation-fill-mode: both;
  animation-timing-function: cubic-bezier(0.25, 1, 0.5, 1);
  animation-iteration-count: 1;
}
.smoke-lobe { position: absolute; }
.smoke-lobe.smoke-core { inset: 10%; border-radius: 50%; filter: blur(8px); opacity: 1; }
.smoke-lobe.smoke-highlight { top: 22%; left: 20%; width: 60%; height: 60%; border-radius: 50%; filter: blur(4px); }
.anim-smoke-billow-grey { animation-name: smokeBillowGrey; }
.anim-smoke-billow-red { animation-name: smokeBillowRed; }
@keyframes smokeBillowGrey {
  0%   { opacity: 0; transform: scale(0.2) rotate(0deg); }
  15%  { opacity: 1; }
  75%  { opacity: 1; transform: scale(1.18) rotate(45deg); }
  100% { opacity: 0; transform: scale(1.35) rotate(70deg); }
}
@keyframes smokeBillowRed {
  0%   { opacity: 0; transform: scale(0.25) rotate(0deg); }
  15%  { opacity: 1; }
  75%  { opacity: 1; transform: scale(1.22) rotate(-50deg); }
  100% { opacity: 0; transform: scale(1.4) rotate(-85deg); }
}

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
  else if (mode === "test") content = <TestGame key={"test" + resetKey} onExit={exitToMenu} />;

  return (
    <div className="gwent-root">
      <style>{CSS}</style>
      {content}
    </div>
  );
}
