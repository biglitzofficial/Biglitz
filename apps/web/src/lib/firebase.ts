import { initializeApp } from "firebase/app";
import { getAuth, signInWithCustomToken, signOut, onAuthStateChanged, type User } from "firebase/auth";

const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "",
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? "",
});

export const auth = getAuth(app);

export const signInWithToken = (token: string) => signInWithCustomToken(auth, token);
export const signOutUser = () => signOut(auth);
export const watchAuth = (cb: (u: User | null) => void) => onAuthStateChanged(auth, cb);
export const currentIdToken = async (): Promise<string | null> => (auth.currentUser ? auth.currentUser.getIdToken() : null);
