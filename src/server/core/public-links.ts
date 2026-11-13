import { HttpError } from "../http/errors";

/**
 * Public customer links (invoices, order tracking) carry the customer's name
 * and phone number, so they stop working PUBLIC_LINK_DAYS (default 90) after
 * the document was issued. Staff can still reprint from the app at any time.
 */
export function assertPublicLinkFresh(issuedAt: Date | null | undefined, now = Date.now()) {
  const days = Math.max(1, Number(process.env.PUBLIC_LINK_DAYS || 90));
  if (issuedAt && now - issuedAt.getTime() > days * 86_400_000)
    throw new HttpError(410, "LINK_EXPIRED", "This link has expired. Please ask the business for a new copy.");
}
