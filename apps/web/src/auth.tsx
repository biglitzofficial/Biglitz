import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, clearScreenCache, get } from "./lib/api";
import { signInWithToken, signOutUser, watchAuth } from "./lib/firebase";
import type { Me } from "./lib/types";

interface AuthState {
  me: Me | null;
  ready: boolean;
  login: (mobile: string, pin: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    setMe(await get<Me>("/api/me"));
  }, []);

  useEffect(
    () =>
      watchAuth((user) => {
        if (!user) {
          setMe(null);
          setReady(true);
          return;
        }
        get<Me>("/api/me")
          .then(setMe)
          .catch(() => {
            // Revoked / exited / deleted: drop the session.
            void signOutUser();
            setMe(null);
          })
          .finally(() => setReady(true));
      }),
    [],
  );

  const login = useCallback(async (mobile: string, pin: string) => {
    const portal = window.location.pathname.startsWith("/admin") ? "admin" : "app";
    const res = await api<{ token: string }>("POST", "/api/auth/login", { mobile, pin, portal }, false);
    await signInWithToken(res.token);
    setMe(await get<Me>("/api/me"));
  }, []);

  const logout = useCallback(async () => {
    clearScreenCache();
    await signOutUser();
    setMe(null);
    window.location.hash = "";
  }, []);

  return <Ctx.Provider value={{ me, ready, login, logout, refresh }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("AuthProvider missing");
  return v;
}

/** Signed-in user, guaranteed by the App shell. */
export function useMe(): Me {
  const { me } = useAuth();
  if (!me) throw new Error("Not signed in");
  return me;
}

export const hasRole = (me: Me, ...roles: string[]): boolean => me.employee.roles.some((r) => roles.includes(r));
export const isAdminish = (me: Me): boolean => hasRole(me, "admin", "superAdmin");
export const isManagerish = (me: Me): boolean => hasRole(me, "manager", "admin", "superAdmin");
export const isSuper = (me: Me): boolean => hasRole(me, "superAdmin");
