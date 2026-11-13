"use client";

import Link from "next/link";
import { notFound, useParams } from "next/navigation";
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { PRODUCTS, isProductCode } from "@/config/catalog";
import { api, useApi } from "@/lib/client";
import { PlanCompare, type FeatureRow, type PlanInfo } from "@/components/plan-compare";
import { themeVars } from "@/components/shell";
import { Button, Card, Field, Loadable, Notice, Select, Textarea, toastError } from "@/components/ui";

export default function ActivatePage() {
  const { product } = useParams<{ product: string }>();
  if (!isProductCode(product)) notFound();
  const catalog = useApi<{ product: { name: string; tagline: string; description: string }; plans: PlanInfo[]; features: FeatureRow[] }>(`/catalog/${product}`);
  const me = useApi<{ user: { isTenantOwner: boolean } }>("/me");
  const [tier, setTier] = useState("BASIC");
  const [billingCycle, setCycle] = useState("MONTHLY");
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const request = async () => {
    setBusy(true);
    try {
      const r = await api<{ ticketNo: number }>(`/catalog/${product}/request`, { body: { tier, billingCycle, message } });
      setSent(r.ticketNo);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={themeVars(PRODUCTS[product].theme)} className="mx-auto max-w-4xl px-4 py-8">
      <Link href="/" className="inline-flex items-center gap-1 text-sm font-medium text-slate-600 hover:text-slate-900"><ArrowLeft className="h-4 w-4" /> All applications</Link>
      <Loadable state={catalog}>
        {(c) => (
          <>
            <p className="mt-6 text-xs font-semibold uppercase tracking-wider text-brand">Not subscribed</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">{c.product.name}</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-600">{c.product.description}</p>
            <div className="mt-6"><PlanCompare plans={c.plans} features={c.features} /></div>
            <Card className="mt-6" title={`Activate ${c.product.name}`} subtitle="SmartAutoFlex will set it up on your existing account - same login, same business.">
              {sent ? (
                <Notice tone="good" title="Request sent">Ticket #{sent} has been raised. Our team will contact you to complete activation.</Notice>
              ) : !me.data?.user.isTenantOwner ? (
                <Notice tone="info">Only the business owner can request a new application. Please ask your manager.</Notice>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Plan">
                    <Select value={tier} onChange={(e) => setTier(e.target.value)}>{c.plans.map((p) => <option key={p.id} value={p.tier}>{p.name}</option>)}</Select>
                  </Field>
                  <Field label="Billing">
                    <Select value={billingCycle} onChange={(e) => setCycle(e.target.value)}>
                      <option value="MONTHLY">Monthly maintenance</option>
                      <option value="ANNUAL">Annual advance payment</option>
                    </Select>
                  </Field>
                  <Field label="Message (optional)" className="sm:col-span-2"><Textarea value={message} maxLength={1000} onChange={(e) => setMessage(e.target.value)} /></Field>
                  <div className="sm:col-span-2"><Button variant="primary" loading={busy} onClick={request}>Request activation</Button></div>
                </div>
              )}
            </Card>
          </>
        )}
      </Loadable>
    </div>
  );
}
