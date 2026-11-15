"use client";

/**
 * Opened by scanning the attendance QR with any phone camera. Signed-in staff
 * are checked in (or out) straight away; others are sent to sign in first by
 * the middleware and then scan again (the code is only valid for a minute).
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { CheckCircle2, XCircle } from "lucide-react";
import { isProductCode, PRODUCTS } from "@/config/catalog";
import { fmtTime } from "@/lib/dates";
import { api, errorMessage } from "@/lib/client";
import { Spinner } from "@/components/ui";

export default function AttendScanPage() {
  const { product, branch, code } = useParams<{ product: string; branch: string; code: string }>();
  const [state, setState] = useState<{ ok: boolean; title: string; text: string } | null>(null);
  const sent = useRef(false);
  const valid = isProductCode(product);

  useEffect(() => {
    if (!valid || sent.current) return;
    sent.current = true;
    api<{ action: "in" | "out"; record: { checkInAt: string; checkOutAt: string | null; status: string }; employee: { fullName: string } }>(
      `/${product}/staff/attendance/scan`, { body: { code, branchId: branch } },
    ).then(
      (r) => setState({
        ok: true,
        title: r.action === "in" ? "Checked in" : "Checked out",
        text: `${r.employee.fullName}, ${r.action === "in" ? `in at ${fmtTime(r.record.checkInAt)}${r.record.status === "LATE" ? " (late)" : ""}` : `out at ${fmtTime(r.record.checkOutAt)}`}.`,
      }),
      (e) => setState({ ok: false, title: "Attendance not recorded", text: errorMessage(e) }),
    );
  }, [valid, product, branch, code]);

  if (!valid) return <Shell><Result ok={false} title="Invalid QR" text="This is not a SAF attendance QR." /></Shell>;
  return (
    <Shell>
      {state ? <Result {...state} /> : <Spinner label="Recording attendance" />}
      <Link href={`/${product}/my-attendance`} className="mt-6 inline-block text-sm font-medium text-brand underline">Open My attendance in {PRODUCTS[product].name}</Link>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center px-6 text-center">{children}</main>;
}

function Result({ ok, title, text }: { ok: boolean; title: string; text: string }) {
  return (
    <div role="status">
      {ok ? <CheckCircle2 className="mx-auto h-16 w-16 text-emerald-600" aria-hidden /> : <XCircle className="mx-auto h-16 w-16 text-red-600" aria-hidden />}
      <h1 className="mt-3 text-xl font-semibold text-slate-900">{title}</h1>
      <p className="mt-1 text-sm text-slate-600">{text}</p>
    </div>
  );
}
