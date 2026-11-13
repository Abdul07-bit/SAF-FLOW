import type { MetadataRoute } from "next";

/** Makes SAF Flow installable as an app (desktop and phone). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SAF Flow",
    short_name: "SAF Flow",
    description: "SmartAutoFlex business software: SAF Dine Flow, SAF Stay Flow and SAF Bill Flow.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    display_override: ["window-controls-overlay", "standalone"],
    orientation: "any",
    background_color: "#031527",
    theme_color: "#031527",
    categories: ["business", "productivity", "finance"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Admin panel", url: "/admin", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Restaurant POS", url: "/dine/pos", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Hotel front desk", url: "/stay/front-desk", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Shop POS", url: "/bill/pos", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
