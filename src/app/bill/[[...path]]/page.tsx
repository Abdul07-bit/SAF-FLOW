"use client";

import { useParams } from "next/navigation";
import { ProductApp } from "@/components/product-app";
import { SCREENS } from "@/screens/registry";

export default function Page() {
  const { path } = useParams<{ path?: string[] }>();
  return <ProductApp code="bill" path={path ?? []} screens={SCREENS} />;
}
