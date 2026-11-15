import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { loadEnv } from "./env.js";

function app(): App {
  const existing = getApps()[0];
  if (existing) return existing;
  const env = loadEnv();
  const options = {
    projectId: env.FIREBASE_PROJECT_ID,
    storageBucket: env.FIREBASE_STORAGE_BUCKET,
  };
  // With FIRESTORE_EMULATOR_HOST set, no credentials are needed.
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const credential = cert(JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON) as Record<string, string>);
    return initializeApp({ ...options, credential });
  }
  return initializeApp(options);
}

export const db = () => getFirestore(app());
export const auth = () => getAuth(app());
export const storage = () => getStorage(app());
