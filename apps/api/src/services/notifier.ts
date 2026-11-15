import { Timestamp, type Firestore } from "firebase-admin/firestore";
import type { Notifier, NotifyEvent } from "../context.js";

/**
 * WhatsApp alerts go to the n8n webhook (never directly to ChakraHQ). Every attempt is logged in
 * `notificationsLog`; a `dedupKey` makes a repeated alert a no-op. A failed alert never breaks the request.
 */
export function createN8nNotifier(db: Firestore, webhookUrl: string | undefined, clock: () => Date, fetchFn: typeof fetch = fetch): Notifier {
  return {
    async send(event: NotifyEvent): Promise<void> {
      try {
        const col = db.collection("notificationsLog");
        const ref = event.dedupKey ? col.doc(event.dedupKey.replace(/\//g, "_")) : col.doc();
        try {
          await ref.create({ ...event, status: "pending", at: Timestamp.fromDate(clock()) });
        } catch (err) {
          const code = (err as { code?: number | string }).code;
          if (code === 6 || code === "already-exists") return; // already sent
          throw err;
        }
        const emp = await db.collection("employees").doc(event.toEmployeeId).get();
        const mobile = emp.exists ? (emp.data() as { mobile: string }).mobile : null;
        if (!mobile) {
          await ref.update({ status: "skipped", error: "recipient not found" });
          return;
        }
        if (!webhookUrl) {
          await ref.update({ status: "skipped", error: "N8N_WEBHOOK_URL not set" });
          return;
        }
        const res = await fetchFn(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ template: event.template, phone: `+91${mobile}`, params: event.params }),
        });
        await ref.update(res.ok ? { status: "sent" } : { status: "failed", error: `HTTP ${res.status}` });
      } catch (err) {
        console.error("[notifier] failed", err instanceof Error ? err.message : err);
      }
    },
  };
}

/** Test/no-op notifier that records events. */
export function createMemoryNotifier(): Notifier & { events: NotifyEvent[] } {
  const events: NotifyEvent[] = [];
  return {
    events,
    async send(event) {
      if (event.dedupKey && events.some((e) => e.dedupKey === event.dedupKey)) return;
      events.push(event);
    },
  };
}
