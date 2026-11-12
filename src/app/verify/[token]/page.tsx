"use client";

/**
 * Public staff ID verification, opened by scanning the QR code printed on an
 * employee ID card. Shows only what is printed on the card plus its validity.
 */
import { useParams } from "next/navigation";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { fmtDate } from "@/lib/dates";
import { useApi } from "@/lib/client";
import { Spinner } from "@/components/ui";

interface Verification {
  valid: boolean;
  reason: string | null;
  business?: { name: string; logoUrl: string | null; phone: string | null };
  employee?: { fullName: string; designation: string | null; department: string | null; employeeCode: string; photoUrl: string | null };
  card?: { cardNumber: string; validUntil: string } | null;
}

export default function VerifyPage() {
  const { token } = useParams<{ token: string }>();
  const v = useApi<Verification>(`/public/verify/${token}`);

  if (!v.data && !v.error) return <Spinner label="Verifying" />;
  const d: Verification = v.data ?? { valid: false, reason: v.error?.status === 429 ? "Too many attempts. Please try again in a minute." : "Verification is unavailable right now. Please try again." };

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-8">
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div role="status" className={`flex items-center gap-3 px-5 py-4 ${d.valid ? "bg-emerald-700" : "bg-red-700"} text-white`}>
          {d.valid ? <ShieldCheck className="h-8 w-8 shrink-0" aria-hidden /> : <ShieldAlert className="h-8 w-8 shrink-0" aria-hidden />}
          <div>
            <p className="text-lg font-semibold">{d.valid ? "Verified staff member" : "Not verified"}</p>
            <p className="text-sm text-white/90">{d.valid ? "This ID card is valid." : d.reason}</p>
          </div>
        </div>

        {d.employee && d.business && (
          <div className="p-5">
            <div className="flex items-center gap-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {d.employee.photoUrl ? <img src={d.employee.photoUrl} alt={`Photograph of ${d.employee.fullName}`} className="h-24 w-20 rounded-lg border border-slate-200 object-cover" /> : <span className="flex h-24 w-20 items-center justify-center rounded-lg border border-dashed border-slate-300 text-xs text-slate-400">No photo</span>}
              <div className="min-w-0">
                <p className="text-lg font-semibold text-slate-900">{d.employee.fullName}</p>
                {d.employee.designation && <p className="text-sm text-slate-700">{d.employee.designation}</p>}
                {d.employee.department && <p className="text-sm text-slate-500">{d.employee.department}</p>}
                <p className="mt-1 font-mono text-sm text-slate-700">{d.employee.employeeCode}</p>
              </div>
            </div>
            <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 border-t border-slate-100 pt-4 text-sm">
              <dt className="text-slate-500">Employer</dt><dd className="font-medium text-slate-900">{d.business.name}</dd>
              {d.business.phone && <><dt className="text-slate-500">Contact</dt><dd><a className="underline" href={`tel:${d.business.phone}`}>{d.business.phone}</a></dd></>}
              {d.card && <><dt className="text-slate-500">Card no.</dt><dd className="font-mono">{d.card.cardNumber}</dd><dt className="text-slate-500">Valid until</dt><dd>{fmtDate(d.card.validUntil)}</dd></>}
            </dl>
          </div>
        )}
      </div>
      <p className="mt-4 text-center text-[11px] text-slate-400">Staff verification by SMARTAUTO FLEX</p>
    </main>
  );
}
