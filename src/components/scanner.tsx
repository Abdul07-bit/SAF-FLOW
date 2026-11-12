"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, ScanLine } from "lucide-react";
import { Button, Input, Modal, Notice } from "./ui";

type Format = "qr_code" | "ean_13" | "ean_8" | "code_128" | "code_39" | "upc_a" | "upc_e";

export function cameraScanSupported(): boolean {
  return typeof window !== "undefined" && "BarcodeDetector" in window && !!navigator.mediaDevices?.getUserMedia;
}

/**
 * Camera scanning through the browser's BarcodeDetector (Chrome on Android,
 * ChromeOS and macOS). Where it is unavailable the button is hidden and the
 * text box is used instead - USB / Bluetooth scanners type into it directly.
 */
export function CameraScanner({ open, onClose, onDetect, formats, title = "Scan code" }: { open: boolean; onClose: () => void; onDetect: (value: string) => void; formats: Format[]; title?: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let done = false;
    setError(null);
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (done) return stream.getTracks().forEach((t) => t.stop());
        if (video.current) {
          video.current.srcObject = stream;
          await video.current.play();
        }
        const detector = new (window as any).BarcodeDetector({ formats });
        timer = setInterval(async () => {
          if (!video.current || video.current.readyState < 2) return;
          try {
            const codes = await detector.detect(video.current);
            if (codes[0]?.rawValue && !done) {
              done = true;
              onDetect(String(codes[0].rawValue));
              onClose();
            }
          } catch {
            /* frame not ready */
          }
        }, 250);
      } catch {
        setError("Could not open the camera. Allow camera access, or type / scan the code into the box instead.");
      }
    })();
    return () => {
      done = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title={title} size="sm">
      {error ? <Notice tone="bad">{error}</Notice> : <video ref={video} muted playsInline className="aspect-square w-full rounded-lg bg-slate-900 object-cover" />}
      <p className="mt-2 text-center text-xs text-slate-500">Hold the code steady inside the frame.</p>
    </Modal>
  );
}

/** Text box for a handheld scanner (Enter submits) with an optional camera button. */
export function ScanInput({ onScan, placeholder, formats, autoFocus, label }: { onScan: (value: string) => void; placeholder: string; formats: Format[]; autoFocus?: boolean; label: string }) {
  const [value, setValue] = useState("");
  const [cam, setCam] = useState(false);
  const [supported, setSupported] = useState(false);
  useEffect(() => setSupported(cameraScanSupported()), []);
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim()) onScan(value.trim());
        setValue("");
      }}
    >
      <div className="relative flex-1">
        <ScanLine className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-slate-400" aria-hidden />
        <Input aria-label={label} autoFocus={autoFocus} className="pl-9" placeholder={placeholder} value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" spellCheck={false} />
      </div>
      {supported && <Button aria-label="Scan with camera" onClick={() => setCam(true)}><Camera className="h-4 w-4" /></Button>}
      <CameraScanner open={cam} onClose={() => setCam(false)} onDetect={onScan} formats={formats} title={label} />
    </form>
  );
}
