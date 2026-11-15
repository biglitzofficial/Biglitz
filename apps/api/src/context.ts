import type { Firestore } from "firebase-admin/firestore";
import type { Env } from "./env.js";

export interface TokenService {
  mint(uid: string, claims: Record<string, unknown>): Promise<string>;
  /** Returns the uid (employeeId) or throws. */
  verify(token: string): Promise<string>;
}

export interface FileService {
  uploadUrl(path: string, contentType: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  downloadUrl(path: string): Promise<string>;
  save(path: string, data: Buffer | Uint8Array, contentType: string): Promise<void>;
}

export interface NotifyEvent {
  /** n8n/ChakraHQ template key. */
  template: string;
  /** Employee id to alert; the notifier resolves the phone. */
  toEmployeeId: string;
  params: Record<string, string | number>;
  /** Dedup key so the same alert is never sent twice. */
  dedupKey?: string;
}

export interface Notifier {
  send(event: NotifyEvent): Promise<void>;
}

export interface AppContext {
  env: Env;
  db: Firestore;
  tokens: TokenService;
  files: FileService;
  notifier: Notifier;
  clock: () => Date;
  /** bcrypt cost; low in tests. */
  bcryptCost: number;
}
