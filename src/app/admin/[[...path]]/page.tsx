"use client";

import { useParams } from "next/navigation";
import { AdminApp } from "@/components/admin-app";

export default function Page() {
  const { path } = useParams<{ path?: string[] }>();
  return <AdminApp path={path ?? []} />;
}
