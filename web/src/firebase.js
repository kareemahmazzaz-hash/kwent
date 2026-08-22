// Firebase Realtime Database connection for Kwent's Online Mode.
// Swap in your project's config below (Firebase console -> Project settings
// -> your web app -> SDK setup and configuration -> Config).
import { initializeApp } from "firebase/app";
import { getDatabase, ref, get, set, update, onValue, off } from "firebase/database";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyAQYJCmJ3pBMO4Segc6HSzSjQr2JBSPDbc",
  authDomain: "kwent-99a36.firebaseapp.com",
  databaseURL: "https://kwent-99a36-default-rtdb.asia-southeast1.firebasedatabase.app/",
  projectId: "kwent-99a36",
  storageBucket: "kwent-99a36.firebasestorage.app",
  messagingSenderId: "109388533350",
  appId: "1:109388533350:web:7fd017e099346edbeee7a7",
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
const auth = getAuth(app);

// Silent anonymous sign-in — no login screen, just a stable per-browser UID
// the DB security rules use to confirm a write is coming from one of the
// two actual players in a room (see database.rules.json). Cached as a
// promise so every caller during startup shares the same in-flight sign-in
// instead of firing signInAnonymously() multiple times.
let uidPromise = null;
export function getUid() {
  if (!uidPromise) {
    uidPromise = new Promise((resolve, reject) => {
      const unsub = onAuthStateChanged(auth, (user) => {
        if (user) { unsub(); resolve(user.uid); }
      }, reject);
      signInAnonymously(auth).catch((e) => { unsub(); reject(e); });
    });
  }
  return uidPromise;
}

// Realtime DB keys can't contain '.', '#', '$', '[', ']'. Online-mode keys
// use '/' as the room/role separator (e.g. "kwent/CODE/meta") so each room
// is a real nested DB path — that's what lets database.rules.json scope
// read/write permission per-room via a $code wildcard, and lets joinGame()
// patch in just the guestUid field with a single-path update() call.

export async function dbGet(key) {
  try {
    const snap = await get(ref(db, key));
    return snap.exists() ? snap.val() : null;
  } catch (e) {
    return null;
  }
}

export async function dbSet(key, value) {
  try {
    await set(ref(db, key), value);
    return true;
  } catch (e) {
    return false;
  }
}

// Multi-path update: pass an object of { fullKey: value } pairs and Firebase
// writes them all in a single round trip instead of one dbSet() per key.
export async function dbUpdate(updates) {
  try {
    await update(ref(db), updates);
    return true;
  } catch (e) {
    return false;
  }
}

// Real-time subscription. Fires immediately with the current value, then
// again any time the value changes on the server — no polling delay.
// Returns an unsubscribe function.
export function dbListen(key, callback) {
  const r = ref(db, key);
  const handler = (snap) => callback(snap.exists() ? snap.val() : null);
  onValue(r, handler);
  return () => off(r, "value", handler);
}
