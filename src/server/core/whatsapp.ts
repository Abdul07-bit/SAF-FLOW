/**
 * WhatsApp Business Cloud API (Meta): sends a PDF to a phone number.
 *
 * A business may message a customer outside a 24-hour chat window only with
 * an approved template, so the daily report goes out as a template whose
 * header is a DOCUMENT and whose body has four variables:
 *   {{1}} business name, {{2}} date, {{3}} sales, {{4}} expenses
 * e.g. "Daily report for {{1}} on {{2}}: sales {{3}}, expenses {{4}}. The PDF is attached."
 *
 * Configuration (server-side only):
 *   WHATSAPP_TOKEN            permanent access token of the system user
 *   WHATSAPP_PHONE_NUMBER_ID  the sending number's id (not the number itself)
 *   WHATSAPP_REPORT_TEMPLATE  template name (default daily_sales_report)
 *   WHATSAPP_TEMPLATE_LANG    template language code (default en)
 *   WHATSAPP_API_VERSION      Graph API version (default v21.0)
 *   WHATSAPP_PAYABLES_TEMPLATE supplier credit alerts template (optional; see below)
 */

export class WhatsAppNotConfigured extends Error {
  constructor() {
    super("WhatsApp sending is not set up on this server (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID).");
  }
}

export interface ReportMessage {
  to: string;
  pdf: Uint8Array;
  filename: string;
  /** Body variables, in template order. */
  params: string[];
}

export type WhatsAppSender = (m: ReportMessage) => Promise<{ messageId: string | null }>;

export function whatsappConfigured(): boolean {
  return !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

/** Digits with the country code; 10-digit Indian numbers get 91. */
export function waNumber(phone: string | null | undefined): string | null {
  const digits = (phone || "").replace(/\D/g, "");
  const n = digits.length === 10 ? `91${digits}` : digits.replace(/^0+/, "");
  return n.length >= 11 && n.length <= 15 ? n : null;
}

async function graph(path: string, init: RequestInit): Promise<any> {
  const version = process.env.WHATSAPP_API_VERSION || "v21.0";
  const res = await fetch(`https://graph.facebook.com/${version}/${path}`, {
    ...init,
    headers: { authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Meta's error message (never the token) is kept for the report history.
    const msg = body?.error?.message || `HTTP ${res.status}`;
    throw new Error(`WhatsApp: ${String(msg).slice(0, 300)}`);
  }
  return body;
}

const cloudApiSender: WhatsAppSender = async (m) => {
  if (!whatsappConfigured()) throw new WhatsAppNotConfigured();
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID!;
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", "application/pdf");
  form.append("file", new Blob([Buffer.from(m.pdf)], { type: "application/pdf" }), m.filename);
  const media = await graph(`${phoneId}/media`, { method: "POST", body: form });

  const sent = await graph(`${phoneId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: m.to,
      type: "template",
      template: {
        name: process.env.WHATSAPP_REPORT_TEMPLATE || "daily_sales_report",
        language: { code: process.env.WHATSAPP_TEMPLATE_LANG || "en" },
        components: [
          { type: "header", parameters: [{ type: "document", document: { id: media.id, filename: m.filename } }] },
          { type: "body", parameters: m.params.map((text) => ({ type: "text", text: text.slice(0, 200) })) },
        ],
      },
    }),
  });
  return { messageId: sent?.messages?.[0]?.id ?? null };
};

let sender: WhatsAppSender = cloudApiSender;

export function sendReportOnWhatsApp(m: ReportMessage) {
  return sender(m);
}

/** Tests replace the network call; pass null to restore the real sender. */
export function setWhatsAppSender(s: WhatsAppSender | null) {
  sender = s ?? cloudApiSender;
}

// ---------------------------------------------------------------------------
// Text-only template messages (supplier credit alerts).
// Template WHATSAPP_PAYABLES_TEMPLATE (utility, approved in WhatsApp Manager),
// body with three variables: {{1}} business name, {{2}} alert title, {{3}} details.
// ---------------------------------------------------------------------------

export interface TemplateMessage {
  to: string;
  template: string;
  params: string[];
}

export type WhatsAppTemplateSender = (m: TemplateMessage) => Promise<{ messageId: string | null }>;

/** WhatsApp alerts for supplier credit are possible only with the credentials and an approved template. */
export function payablesWhatsAppReady(): boolean {
  return whatsappConfigured() && !!process.env.WHATSAPP_PAYABLES_TEMPLATE;
}

const cloudTemplateSender: WhatsAppTemplateSender = async (m) => {
  if (!whatsappConfigured()) throw new WhatsAppNotConfigured();
  const sent = await graph(`${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: m.to,
      type: "template",
      template: {
        name: m.template,
        language: { code: process.env.WHATSAPP_TEMPLATE_LANG || "en" },
        // WhatsApp refuses newlines, tabs and long runs of spaces inside variables.
        components: [{ type: "body", parameters: m.params.map((t) => ({ type: "text", text: t.replace(/\s+/g, " ").trim().slice(0, 900) })) }],
      },
    }),
  });
  return { messageId: sent?.messages?.[0]?.id ?? null };
};

let templateSender: WhatsAppTemplateSender = cloudTemplateSender;

export function sendTemplateOnWhatsApp(m: TemplateMessage) {
  return templateSender(m);
}

/** Tests replace the network call; pass null to restore the real sender. */
export function setWhatsAppTemplateSender(s: WhatsAppTemplateSender | null) {
  templateSender = s ?? cloudTemplateSender;
}
