"use client";

import { useEffect, useState, type RefObject } from "react";
import { ChevronDown } from "lucide-react";
import { formatINR } from "@/lib/money";

/**
 * Phones only (below lg): on POS screens the bill sits under the item list, so
 * this bar stays at the bottom of the screen with the item count and total and
 * jumps to the bill. It hides while the bill itself is on screen.
 */
export function MobileBillBar({ count, total, target }: { count: number; total: number; target: RefObject<HTMLElement | null> }) {
  const [billVisible, setBillVisible] = useState(false);
  useEffect(() => {
    const el = target.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setBillVisible(e.isIntersecting), { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, [target]);

  if (count <= 0) return null;
  return (
    <>
      {/* Room at the end of the page so the bar never covers the last controls. */}
      <div className="h-20 lg:hidden" aria-hidden />
      {!billVisible && (
        <div className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-[0_-4px_12px_rgba(15,23,42,0.08)] backdrop-blur lg:hidden">
          <button
            type="button"
            onClick={() => target.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
            className="flex h-12 w-full items-center justify-between rounded-xl bg-brand px-4 text-brand-ink"
          >
            <span className="text-sm font-medium">{count} item{count === 1 ? "" : "s"} · <span className="tnum font-semibold">{formatINR(total)}</span></span>
            <span className="inline-flex items-center gap-1 text-sm font-semibold">View bill <ChevronDown className="h-4 w-4" aria-hidden /></span>
          </button>
        </div>
      )}
    </>
  );
}
