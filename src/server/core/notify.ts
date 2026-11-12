import type { Tx } from "../db";

/**
 * In-app notifications (bell icon). Renewal reminders and support replies are
 * delivered here; WhatsApp deep links are generated in the UI where useful.
 * To add e-mail/SMS later, fan out from this single function.
 */
export async function notify(
  db: Tx,
  n: { tenantId: string; userId?: string | null; productCode?: string | null; kind: string; title: string; body: string; link?: string },
) {
  await db.notification.create({
    data: {
      tenantId: n.tenantId,
      userId: n.userId ?? null,
      productCode: n.productCode ?? null,
      kind: n.kind,
      title: n.title,
      body: n.body,
      link: n.link ?? null,
    },
  });
}

/** wa.me deep link with a prefilled message (no WhatsApp API keys required). */
export function whatsappLink(phone: string | null | undefined, text: string): string {
  const digits = (phone || "").replace(/\D/g, "");
  const normalized = digits.length === 10 ? `91${digits}` : digits;
  return `https://wa.me/${normalized}?text=${encodeURIComponent(text)}`;
}
