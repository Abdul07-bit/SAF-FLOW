"use client";

/**
 * Last-resort error page (the root layout itself failed). Must render its own
 * <html> and cannot rely on the app's styles, so it uses inline styles.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", fontFamily: "system-ui, sans-serif", background: "#031527", color: "#e3edf2" }}>
        <main style={{ maxWidth: 380, padding: 32, textAlign: "center" }}>
          <h1 style={{ fontSize: 20, margin: "0 0 8px" }}>Something went wrong</h1>
          <p style={{ color: "#8fa8ba", lineHeight: 1.5, margin: 0 }}>SAF Flow could not load. Please try again in a moment.</p>
          {error.digest && <p style={{ color: "#8fa8ba", fontSize: 12, marginTop: 12 }}>Reference: {error.digest}</p>}
          <button onClick={reset} style={{ marginTop: 20, padding: "10px 20px", border: 0, borderRadius: 10, background: "#017f7c", color: "#fff", fontSize: 15, cursor: "pointer" }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
