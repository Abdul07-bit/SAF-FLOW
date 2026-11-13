import Link from "next/link";
import { SafLogo } from "@/components/brand";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
        <SafLogo className="mx-auto h-9" />
        <h1 className="mt-6 text-xl font-semibold text-slate-900">Page not found</h1>
        <p className="mt-2 text-sm text-slate-600">This page does not exist or has moved.</p>
        <Link href="/" className="mt-6 inline-flex h-10 items-center rounded-lg bg-brand px-5 text-sm font-semibold text-brand-ink hover:brightness-110">Go to SAF Flow</Link>
      </div>
    </main>
  );
}
