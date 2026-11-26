/**
 * Day book as a PDF (A4): the daily closing report sent to the owner's
 * WhatsApp, and the download on the Day book screen for any date range.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { fmtDate, fmtDateTime } from "@/lib/dates";
import { humanize } from "@/shared/fields";
import type { DayBook } from "./daybook";

const W = 595.28;
const H = 841.89;
const M = 40;
const INK = rgb(0.08, 0.1, 0.14);
const MUTED = rgb(0.42, 0.46, 0.52);
const LINE = rgb(0.86, 0.88, 0.9);
const BRAND = rgb(0.004, 0.498, 0.486);
const BAD = rgb(0.75, 0.15, 0.15);

/** Standard PDF fonts only cover WinAnsi (no rupee sign). */
function safe(s: string | null | undefined): string {
  return (s ?? "").replace(/\u20B9/g, "Rs ").replace(/[\u2012-\u2015\u2212]/g, "-").replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2000-\u200B\u202F]/g, " ").replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}

/** "UPI", "Cash", "Gas fuel". */
const label = (v: string) => (v === "UPI" ? "UPI" : humanize(v));

const inr = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function pdfMoney(paise: number): string {
  return `${paise < 0 ? "-" : ""}Rs ${inr.format(Math.abs(paise) / 100)}`;
}

interface Col { label: string; width: number; align?: "right" }

class Writer {
  doc!: PDFDocument;
  page!: PDFPage;
  font!: PDFFont;
  bold!: PDFFont;
  y = 0;
  footer = "";

  static async create(footer: string) {
    const w = new Writer();
    w.doc = await PDFDocument.create();
    w.font = await w.doc.embedFont(StandardFonts.Helvetica);
    w.bold = await w.doc.embedFont(StandardFonts.HelveticaBold);
    w.footer = footer;
    w.newPage();
    return w;
  }

  newPage() {
    this.page = this.doc.addPage([W, H]);
    this.y = H - M;
    this.page.drawText(safe(this.footer), { x: M, y: 22, size: 7.5, font: this.font, color: MUTED });
  }

  ensure(space: number) {
    if (this.y - space < 50) this.newPage();
  }

  fit(text: string, font: PDFFont, size: number, max: number) {
    let t = safe(text);
    if (font.widthOfTextAtSize(t, size) <= max) return t;
    while (t.length > 1 && font.widthOfTextAtSize(`${t}..`, size) > max) t = t.slice(0, -1);
    return `${t}..`;
  }

  text(t: string, o: { x?: number; size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; max?: number } = {}) {
    const size = o.size ?? 10;
    const font = o.bold ? this.bold : this.font;
    this.page.drawText(this.fit(t, font, size, o.max ?? W - 2 * M), { x: o.x ?? M, y: this.y, size, font, color: o.color ?? INK });
  }

  heading(t: string) {
    this.ensure(40);
    this.y -= 18;
    this.text(t, { size: 12, bold: true });
    this.y -= 6;
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: W - M, y: this.y }, thickness: 0.8, color: LINE });
    this.y -= 14;
  }

  table(cols: Col[], rows: string[][], o: { totalRow?: string[] } = {}) {
    const draw = (cells: string[], bold: boolean, color = INK) => {
      this.ensure(16);
      let x = M;
      cells.forEach((c, i) => {
        const col = cols[i];
        const font = bold ? this.bold : this.font;
        const t = this.fit(c, font, 9, col.width - 6);
        const tx = col.align === "right" ? x + col.width - font.widthOfTextAtSize(t, 9) - 2 : x + 2;
        this.page.drawText(t, { x: tx, y: this.y, size: 9, font, color });
        x += col.width;
      });
      this.y -= 15;
    };
    draw(cols.map((c) => c.label), true, MUTED);
    for (const r of rows) draw(r, false);
    if (o.totalRow) {
      this.page.drawLine({ start: { x: M, y: this.y + 11 }, end: { x: W - M, y: this.y + 11 }, thickness: 0.5, color: LINE });
      draw(o.totalRow, true);
    }
  }
}

export async function dayBookPdf(book: DayBook, meta: { businessName: string; productName: string; branchName?: string | null; generatedAt?: Date }): Promise<Uint8Array> {
  const single = book.from === book.to;
  const period = single ? fmtDate(book.from) : `${fmtDate(book.from)} to ${fmtDate(book.to)}`;
  const w = await Writer.create(`${meta.productName} - generated ${fmtDateTime(meta.generatedAt ?? new Date())} IST by SAF Flow`);
  const t = book.totals;

  // Header band
  w.page.drawRectangle({ x: 0, y: H - 92, width: W, height: 92, color: BRAND });
  w.page.drawText(w.fit(meta.businessName, w.bold, 18, W - 2 * M), { x: M, y: H - 42, size: 18, font: w.bold, color: rgb(1, 1, 1) });
  w.page.drawText(safe(`${single ? "Daily closing report" : "Sales & expenses report"} - ${period}`), { x: M, y: H - 62, size: 11, font: w.font, color: rgb(1, 1, 1) });
  w.page.drawText(safe(`${meta.productName}${meta.branchName ? ` - ${meta.branchName}` : ""}  |  Business hours ${book.hours.openingTime} - ${book.hours.closingTime}`), { x: M, y: H - 78, size: 8.5, font: w.font, color: rgb(0.9, 0.97, 0.97) });
  w.y = H - 120;

  // Key figures
  const kpis: [string, string, ReturnType<typeof rgb>?][] = [
    [book.product === "stay" ? "Payments received" : "Total sales", pdfMoney(t.sales)],
    [book.countLabel, String(t.count)],
    ["Expenses", pdfMoney(t.expenses)],
    ["Sales less expenses", pdfMoney(t.net), t.net < 0 ? BAD : undefined],
  ];
  const boxW = (W - 2 * M - 3 * 10) / 4;
  kpis.forEach(([label, value, color], i) => {
    const x = M + i * (boxW + 10);
    w.page.drawRectangle({ x, y: w.y - 44, width: boxW, height: 52, borderColor: LINE, borderWidth: 0.8 });
    w.page.drawText(safe(label), { x: x + 8, y: w.y - 6, size: 8.5, font: w.font, color: MUTED });
    w.page.drawText(w.fit(value, w.bold, 13, boxW - 14), { x: x + 8, y: w.y - 30, size: 13, font: w.bold, color: color ?? INK });
  });
  w.y -= 62;
  const extra = [
    book.product !== "stay" && t.count ? `Average ${book.product === "dine" ? "order" : "bill"} ${pdfMoney(t.avgTicket)}` : "",
    t.discount ? `Discounts ${pdfMoney(t.discount)}` : "",
    t.tax ? `GST collected ${pdfMoney(t.tax)}` : "",
    t.cancelled ? `${book.product === "bill" ? "Voided bills" : book.product === "dine" ? "Cancelled orders" : "Cancellations"} ${t.cancelled}` : "",
  ].filter(Boolean).join("   |   ");
  if (extra) { w.text(extra, { size: 9, color: MUTED }); w.y -= 4; }

  if (!single) {
    w.heading("Day by day");
    w.table(
      [{ label: "Date", width: 140 }, { label: book.countLabel, width: 70, align: "right" }, { label: "Sales", width: 105, align: "right" }, { label: "Expenses", width: 100, align: "right" }, { label: "Net", width: 100, align: "right" }],
      book.daily.map((d) => [fmtDate(d.date), String(d.count), pdfMoney(d.sales), pdfMoney(d.expenses), pdfMoney(d.net)]),
      { totalRow: ["Total", String(t.count), pdfMoney(t.sales), pdfMoney(t.expenses), pdfMoney(t.net)] },
    );
  }

  if (book.branches.length > 1) {
    w.heading("By branch");
    w.table(
      [{ label: "Branch", width: 200 }, { label: book.countLabel, width: 80, align: "right" }, { label: "Sales", width: 118, align: "right" }, { label: "Expenses", width: 117, align: "right" }],
      book.branches.map((b) => [b.name, String(b.count), pdfMoney(b.sales), pdfMoney(b.expenses)]),
    );
  }

  w.heading("Payments by method");
  if (book.byMethod.length) {
    w.table([{ label: "Method", width: 300 }, { label: "Amount", width: 215, align: "right" }], book.byMethod.map((m) => [label(m.method), pdfMoney(m.amount)]), { totalRow: ["Total", pdfMoney(t.sales)] });
  } else { w.text("No sales recorded.", { size: 9, color: MUTED }); w.y -= 12; }

  if (book.topItems.length) {
    w.heading(book.product === "dine" ? "Top dishes" : "Top products");
    w.table([{ label: "Item", width: 300 }, { label: "Qty", width: 80, align: "right" }, { label: "Revenue", width: 135, align: "right" }], book.topItems.map((i) => [i.name, String(i.qty), pdfMoney(i.revenue)]));
  }

  w.heading("Expenses");
  if (book.expenses.length) {
    w.table(
      [...(single ? [] : [{ label: "Date", width: 70 }]), { label: "Category", width: 95 }, { label: "Description", width: single ? 220 : 160 }, { label: "Paid by", width: 60 }, { label: "Paid to", width: single ? 70 : 60 }, { label: "Amount", width: 70, align: "right" as const }],
      book.expenses.map((e) => [...(single ? [] : [fmtDate(e.date).slice(0, 6)]), humanize(e.category), e.description, label(e.method), e.paidTo ?? "", pdfMoney(e.amount)]),
      { totalRow: [...(single ? [] : [""]), "Total", "", "", "", pdfMoney(t.expenses)] },
    );
    if (book.expensesByCategory.length > 1) {
      w.y -= 6;
      w.text(book.expensesByCategory.map((c) => `${humanize(c.category)} ${pdfMoney(c.amount)}`).join("   |   "), { size: 8.5, color: MUTED });
    }
  } else { w.text("No expenses recorded.", { size: 9, color: MUTED }); w.y -= 12; }

  return w.doc.save();
}
