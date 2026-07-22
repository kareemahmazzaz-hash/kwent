// Firebase Realtime Database connection for Kwent's Online Mode.
// Swap in your project's config below (Firebase console -> Project settings
// -> your web app -> SDK setup and configuration -> Config).
import { initializeApp } from "firebase/app";
import { getDatabase, ref, get, set } from "firebase/database";

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

// Realtime DB keys can't contain '.', '#', '$', '[', ']' — the "kwent:CODE:role"
// keys used by online mode only use ':' as a separator, which is safe as-is.

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
