import type { AppContext, FileService, TokenService } from "./context.js";
import { loadEnv } from "./env.js";
import { auth, db, storage } from "./firebase.js";
import { createN8nNotifier } from "./services/notifier.js";

const tokens: TokenService = {
  mint: (uid, claims) => auth().createCustomToken(uid, claims),
  async verify(token) {
    return (await auth().verifyIdToken(token)).uid;
  },
};

const files: FileService = {
  async uploadUrl(path, contentType) {
    const [url] = await storage().bucket().file(path).getSignedUrl({ version: "v4", action: "write", expires: Date.now() + 10 * 60_000, contentType });
    return url;
  },
  async exists(path) {
    const [exists] = await storage().bucket().file(path).exists();
    return exists;
  },
  async downloadUrl(path) {
    const [url] = await storage().bucket().file(path).getSignedUrl({ version: "v4", action: "read", expires: Date.now() + 5 * 60_000 });
    return url;
  },
  async save(path, data, contentType) {
    await storage().bucket().file(path).save(Buffer.from(data), { contentType });
  },
};

/** Production wiring: real Firestore, Firebase Auth, Cloud Storage and the n8n notifier. */
export function buildContext(): AppContext {
  const env = loadEnv();
  const clock = () => new Date();
  const database = db();
  return {
    env,
    db: database,
    tokens,
    files,
    notifier: createN8nNotifier(database, env.N8N_WEBHOOK_URL, clock),
    clock,
    bcryptCost: 10,
  };
}
