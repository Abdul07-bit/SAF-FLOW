import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";
import { fmtDate } from "@/lib/dates";
import { storage } from "../core/storage";

export interface CardData {
  businessName: string;
  businessPhone: string | null;
  businessAddress: string | null;
  logoKey: string | null;
  brandHex: string;
  employeeName: string;
  employeeCode: string;
  designation: string;
  department: string | null;
  bloodGroup: string | null;
  photoKey: string | null;
  cardNumber: string;
  validUntil: Date;
  verifyUrl: string;
}

// CR80 card, portrait: 54 x 85.6 mm
const W = 153;
const H = 243;

/** Standard PDF fonts only cover WinAnsi; replace anything else. */
function safe(s: string | null | undefined): string {
  return (s ?? "").replace(/[^\x20-\x7E -ÿ]/g, "?");
}

function hexToRgb(hex: string) {
  const v = hex.replace("#", "");
  return rgb(parseInt(v.slice(0, 2), 16) / 255, parseInt(v.slice(2, 4), 16) / 255, parseInt(v.slice(4, 6), 16) / 255);
}

async function embedStored(doc: PDFDocument, key: string | null): Promise<PDFImage | null> {
  if (!key) return null;
  const file = await storage().get(key);
  if (!file) return null;
  try {
    return file.contentType === "image/png" ? await doc.embedPng(file.body) : await doc.embedJpg(file.body);
  } catch {
    return null;
  }
}

function fitText(text: string, font: PDFFont, size: number, maxWidth: number): string {
  const full = safe(text);
  if (font.widthOfTextAtSize(full, size) <= maxWidth) return full;
  let t = full;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}..`, size) > maxWidth) t = t.slice(0, -1);
  return `${t}..`;
}

function centered(page: PDFPage, text: string, y: number, font: PDFFont, size: number, x0: number, color = rgb(0.1, 0.1, 0.12)) {
  const t = fitText(text, font, size, W - 16);
  page.drawText(t, { x: x0 + (W - font.widthOfTextAtSize(t, size)) / 2, y, size, font, color });
}

async function drawCard(doc: PDFDocument, page: PDFPage, x0: number, y0: number, c: CardData, fonts: { bold: PDFFont; reg: PDFFont }) {
  const brand = hexToRgb(c.brandHex);
  const { bold, reg } = fonts;

  // Card border + header band
  page.drawRectangle({ x: x0, y: y0, width: W, height: H, color: rgb(1, 1, 1), borderColor: rgb(0.82, 0.83, 0.86), borderWidth: 0.6 });
  page.drawRectangle({ x: x0, y: y0 + H - 46, width: W, height: 46, color: brand });

  const logo = await embedStored(doc, c.logoKey);
  let textX = x0 + 8;
  if (logo) {
    const s = 30 / Math.max(logo.width, logo.height);
    page.drawRectangle({ x: x0 + 7, y: y0 + H - 39, width: 32, height: 32, color: rgb(1, 1, 1) });
    page.drawImage(logo, { x: x0 + 8 + (30 - logo.width * s) / 2, y: y0 + H - 38 + (30 - logo.height * s) / 2, width: logo.width * s, height: logo.height * s });
    textX = x0 + 45;
  }
  const nameMax = W - (textX - x0) - 6;
  page.drawText(fitText(c.businessName.toUpperCase(), bold, 9, nameMax), { x: textX, y: y0 + H - 22, size: 9, font: bold, color: rgb(1, 1, 1) });
  page.drawText("STAFF IDENTITY CARD", { x: textX, y: y0 + H - 34, size: 6, font: reg, color: rgb(1, 1, 1) });

  // Photo
  const photo = await embedStored(doc, c.photoKey);
  const pw = 58, ph = 70, px = x0 + (W - pw) / 2, py = y0 + H - 54 - ph;
  page.drawRectangle({ x: px - 1.5, y: py - 1.5, width: pw + 3, height: ph + 3, color: brand });
  if (photo) {
    // Contain-fit (no clipping needed) on a neutral background.
    page.drawRectangle({ x: px, y: py, width: pw, height: ph, color: rgb(0.93, 0.94, 0.96) });
    const s = Math.min(pw / photo.width, ph / photo.height);
    const iw = photo.width * s, ih = photo.height * s;
    page.drawImage(photo, { x: px + (pw - iw) / 2, y: py + (ph - ih) / 2, width: iw, height: ih });
  } else {
    page.drawRectangle({ x: px, y: py, width: pw, height: ph, color: rgb(0.93, 0.94, 0.96) });
    const initials = safe(c.employeeName.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase());
    page.drawText(initials, { x: px + (pw - bold.widthOfTextAtSize(initials, 22)) / 2, y: py + ph / 2 - 8, size: 22, font: bold, color: brand });
  }

  let y = py - 15;
  centered(page, c.employeeName, y, bold, 10.5, x0);
  y -= 11;
  centered(page, c.designation + (c.department ? ` - ${c.department}` : ""), y, reg, 7.5, x0, brand);
  y -= 11;
  centered(page, `ID: ${c.employeeCode}`, y, bold, 7.5, x0);

  // QR + details
  const qrPng = await QRCode.toBuffer(c.verifyUrl, { errorCorrectionLevel: "M", margin: 1, width: 240 });
  const qr = await doc.embedPng(qrPng);
  const qs = 52;
  page.drawImage(qr, { x: x0 + 8, y: y0 + 18, width: qs, height: qs });
  const dx = x0 + 66;
  const line = (label: string, value: string, yy: number) => {
    page.drawText(label, { x: dx, y: yy, size: 5.5, font: reg, color: rgb(0.45, 0.47, 0.52) });
    page.drawText(fitText(value, bold, 6.5, W - (dx - x0) - 6), { x: dx, y: yy - 7.5, size: 6.5, font: bold, color: rgb(0.1, 0.1, 0.12) });
  };
  line("CARD NO.", c.cardNumber, y0 + 64);
  line("VALID TILL", fmtDate(c.validUntil), y0 + 46);
  if (c.bloodGroup) line("BLOOD GROUP", c.bloodGroup, y0 + 28);

  // Footer
  page.drawRectangle({ x: x0, y: y0, width: W, height: 13, color: rgb(0.95, 0.96, 0.97) });
  const footer = [c.businessPhone, c.businessAddress].filter(Boolean).join("  |  ");
  centered(page, footer || "Scan QR to verify", y0 + 4.5, reg, 5.2, x0, rgb(0.35, 0.37, 0.42));
}

/** One card per page when a single card is requested; otherwise 9 per A4 sheet with cut margins. */
export async function renderIdCards(cards: CardData[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(cards.length === 1 ? `ID card - ${safe(cards[0].employeeName)}` : "Staff ID cards");
  doc.setCreator("SmartAutoFlex");
  const fonts = { bold: await doc.embedFont(StandardFonts.HelveticaBold), reg: await doc.embedFont(StandardFonts.Helvetica) };

  if (cards.length === 1) {
    const page = doc.addPage([W, H]);
    await drawCard(doc, page, 0, 0, cards[0], fonts);
    return doc.save();
  }

  const A4 = [595.28, 841.89] as const;
  const cols = 3, rows = 3, gap = 14;
  const mx = (A4[0] - cols * W - (cols - 1) * gap) / 2;
  const my = (A4[1] - rows * H - (rows - 1) * gap) / 2;
  for (let i = 0; i < cards.length; i += cols * rows) {
    const page = doc.addPage([A4[0], A4[1]]);
    const chunk = cards.slice(i, i + cols * rows);
    for (const [j, card] of chunk.entries()) {
      const col = j % cols;
      const row = Math.floor(j / cols);
      await drawCard(doc, page, mx + col * (W + gap), A4[1] - my - (row + 1) * H - row * gap, card, fonts);
    }
  }
  return doc.save();
}
