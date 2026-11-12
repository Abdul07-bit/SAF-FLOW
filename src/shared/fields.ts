/**
 * Field DSL shared by server and browser. A resource is declared once:
 * the server derives zod validation and CRUD endpoints from it, the UI derives
 * tables and forms. Money fields are paise on the wire; the form shows rupees.
 */
import type { ProductCode } from "@/config/catalog";

export type FieldType =
  | "text" | "textarea" | "int" | "number" | "money" | "percent" | "bool"
  | "select" | "ref" | "date" | "time" | "tags" | "phone" | "email";

export interface FieldDef {
  type: FieldType;
  label: string;
  required?: boolean;
  min?: number;
  max?: number;
  options?: readonly string[];
  /** For type "ref": endpoint returning {items:[{id,...}]} and the label field. */
  ref?: { api: string; label: string };
  placeholder?: string;
  help?: string;
  default?: unknown;
  /** Hidden from the create/edit form (read-only / computed). */
  readOnly?: boolean;
  /** Shown only when creating (e.g. opening stock). */
  createOnly?: boolean;
  /** Only show in the form when the tenant has this (relative) feature. */
  feature?: string;
}

export interface ColumnDef {
  key: string;
  label: string;
  type?: FieldType | "badge" | "status";
  feature?: string;
}

export interface ResourceDef {
  key: string;
  product: ProductCode | ":product";
  api: string;
  title: string;
  singular: string;
  description?: string;
  fields: Record<string, FieldDef>;
  columns: ColumnDef[];
  read: { feature: string | readonly string[]; permission: string | readonly string[] };
  write: { feature: string | readonly string[]; permission: string | readonly string[] };
  branchScoped?: boolean;
  /** Deactivate (isActive=false) instead of deleting. */
  softDelete?: boolean;
  search?: string[];
}

export const f = {
  text: (label: string, o: Partial<FieldDef> = {}): FieldDef => ({ type: "text", label, ...o }),
  textarea: (label: string, o: Partial<FieldDef> = {}): FieldDef => ({ type: "textarea", label, ...o }),
  int: (label: string, o: Partial<FieldDef> = {}): FieldDef => ({ type: "int", label, ...o }),
  number: (label: string, o: Partial<FieldDef> = {}): FieldDef => ({ type: "number", label, ...o }),
  money: (label: string, o: Partial<FieldDef> = {}): FieldDef => ({ type: "money", label, ...o }),
  percent: (label: string, o: Partial<FieldDef> = {}): FieldDef => ({ type: "percent", label, ...o }),
  bool: (label: string, o: Partial<FieldDef> = {}): FieldDef => ({ type: "bool", label, ...o }),
  select: (label: string, options: readonly string[], o: Partial<FieldDef> = {}): FieldDef => ({ type: "select", label, options, ...o }),
  ref: (label: string, api: string, labelKey = "name", o: Partial<FieldDef> = {}): FieldDef => ({
    type: "ref", label, ref: { api, label: labelKey }, ...o,
  }),
  date: (label: string, o: Partial<FieldDef> = {}): FieldDef => ({ type: "date", label, ...o }),
  time: (label: string, o: Partial<FieldDef> = {}): FieldDef => ({ type: "time", label, ...o }),
  tags: (label: string, o: Partial<FieldDef> = {}): FieldDef => ({ type: "tags", label, ...o }),
  phone: (label: string, o: Partial<FieldDef> = {}): FieldDef => ({ type: "phone", label, ...o }),
  email: (label: string, o: Partial<FieldDef> = {}): FieldDef => ({ type: "email", label, ...o }),
};

export function humanize(v: string): string {
  return v.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}
