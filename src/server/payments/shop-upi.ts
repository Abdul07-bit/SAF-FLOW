import QRCode from "qrcode";
import { fileUrl } from "../core/storage";
import { upiPayLink } from "./upi";

/**
 * A business's own UPI details, used to collect payment from ITS customers
 * (restaurant, hotel and shop bills). Nothing is verified automatically: the
 * cashier checks their UPI app and settles the bill as UPI.
 */
export interface ShopUpi {
  upiId: string | null;
  payeeName: string;
  amount: number;
  /** upi://pay link with the amount filled in (only with a UPI ID). */
  link: string | null;
  /** QR image: generated with the amount (UPI ID) or the uploaded QR picture. */
  qr: string;
  /** True when the QR already carries the amount; false for an uploaded static QR. */
  amountInQr: boolean;
}

type BusinessUpiFields = { name: string; upiId: string | null; upiPayeeName: string | null; upiQrKey: string | null };

export function hasShopUpi(b: BusinessUpiFields | null | undefined): boolean {
  return !!(b && (b.upiId || b.upiQrKey));
}

/** Payment details for `amountPaise`, or null when the business has no UPI set up. */
export async function shopUpi(b: BusinessUpiFields, amountPaise: number, note: string, displayName?: string): Promise<ShopUpi | null> {
  if (amountPaise < 100) return null;
  const payeeName = b.upiPayeeName || displayName || b.name;
  if (b.upiId) {
    const link = upiPayLink({ upiId: b.upiId, payeeName, amountPaise, note });
    const qr = await QRCode.toDataURL(link, { margin: 1, width: 320, errorCorrectionLevel: "M" });
    return { upiId: b.upiId, payeeName, amount: amountPaise, link, qr, amountInQr: true };
  }
  const img = fileUrl(b.upiQrKey);
  if (!img) return null;
  return { upiId: null, payeeName, amount: amountPaise, link: null, qr: img, amountInQr: false };
}
