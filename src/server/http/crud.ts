import { z } from "zod";
import type { FieldDef, ResourceDef } from "@/shared/fields";
import { dateOnly, isISODate } from "@/lib/dates";
import { route, type Ctx } from "./router";
import { badRequest, notFound } from "./errors";

/** Ref endpoint -> Prisma delegate, used to verify references stay inside the tenant. */
const REF_MODELS: Record<string, string> = {
  "/dine/menu-categories": "dineMenuCategory",
  "/dine/stock-items": "dineStockItem",
  "/dine/suppliers": "dineSupplier",
  "/stay/room-types": "stayRoomType",
  "/stay/rooms": "stayRoom",
  "/bill/categories": "billCategory",
  "/bill/suppliers": "billSupplier",
};

function fieldSchema(fd: FieldDef): z.ZodType {
  let s: z.ZodType;
  switch (fd.type) {
    case "text":
    case "textarea": {
      let str = z.string().trim().max(fd.max ?? (fd.type === "textarea" ? 2000 : 200));
      if (fd.required) str = str.min(1, `${fd.label} is required`);
      s = str;
      break;
    }
    case "phone":
      s = z.string().trim().regex(/^[+\d][\d\s-]{6,18}$/, `${fd.label}: enter a valid phone number`);
      break;
    case "email":
      s = z.string().trim().max(120).pipe(z.email(`${fd.label}: enter a valid email`));
      break;
    case "int": {
      let n = z.number().int();
      if (fd.min !== undefined) n = n.min(fd.min);
      if (fd.max !== undefined) n = n.max(fd.max);
      s = n;
      break;
    }
    case "number": {
      let n = z.number().finite();
      if (fd.min !== undefined) n = n.min(fd.min);
      if (fd.max !== undefined) n = n.max(fd.max);
      s = n;
      break;
    }
    case "money":
      s = z.number().int().min(0).max(100_000_000_00);
      break;
    case "percent":
      s = z.number().int().min(0).max(10_000);
      break;
    case "bool":
      s = z.boolean();
      break;
    case "select":
      s = z.enum(fd.options as unknown as [string, ...string[]]);
      break;
    case "ref":
      s = z.uuid(`${fd.label}: select a value`);
      break;
    case "date":
      s = z.string().refine(isISODate, `${fd.label}: use YYYY-MM-DD`);
      break;
    case "time":
      s = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, `${fd.label}: use HH:MM`);
      break;
    case "tags":
      s = z.array(z.string().trim().min(1).max(40)).max(30);
      break;
  }
  if (!fd.required) s = z.preprocess((v) => (v === "" ? null : v), s.nullable().optional());
  return s;
}

export function schemasFor(def: ResourceDef) {
  const shape: Record<string, z.ZodType> = {};
  for (const [k, fd] of Object.entries(def.fields)) if (!fd.readOnly) shape[k] = fieldSchema(fd);
  const create = z.object(shape);
  return { create, update: create.partial() };
}

function toDb(def: ResourceDef, data: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    const fd = def.fields[k];
    out[k] = fd?.type === "date" && typeof v === "string" ? dateOnly(v) : v;
  }
  return out;
}

export interface CrudOptions {
  model: string;
  include?: object;
  orderBy?: object | object[];
  where?: (ctx: Ctx) => object;
  mapOut?: (row: any, ctx: Ctx) => unknown;
  listHook?: (ctx: Ctx, rows: any[]) => Promise<any[]>;
  beforeCreate?: (ctx: Ctx, data: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
  afterCreate?: (ctx: Ctx, row: any, input: Record<string, unknown>) => Promise<void>;
  beforeUpdate?: (ctx: Ctx, data: Record<string, unknown>, existing: any) => Promise<Record<string, unknown>> | Record<string, unknown>;
  noDelete?: boolean;
  /** Extra fields stripped before writing (virtual inputs such as openingStock). */
  virtual?: string[];
}

const listQuery = z.object({
  q: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(200),
  all: z.enum(["0", "1"]).optional(),
});

export function registerCrud(def: ResourceDef, opts: CrudOptions) {
  const { create, update } = schemasFor(def);
  const product = def.product;
  const base = def.api;
  const readAuth = { product, feature: def.read.feature, permission: def.read.permission } as const;
  const writeAuth = { product, feature: def.write.feature, permission: def.write.permission } as const;
  const tag = def.key;
  const delegate = (ctx: Ctx) => (ctx.db as any)[opts.model];

  const scope = (ctx: Ctx) => ({
    tenantId: ctx.tenantId,
    ...(def.branchScoped ? { branchId: ctx.branchId } : {}),
    ...(opts.where ? opts.where(ctx) : {}),
  });

  async function checkRefs(ctx: Ctx, data: Record<string, unknown>) {
    for (const [k, fd] of Object.entries(def.fields)) {
      const v = data[k];
      if (fd.type !== "ref" || !v) continue;
      const model = REF_MODELS[fd.ref!.api];
      if (!model) continue;
      const found = await (ctx.db as any)[model].findFirst({ where: { id: v, tenantId: ctx.tenantId }, select: { id: true } });
      if (!found) throw badRequest(`${fd.label}: the selected record does not exist.`);
    }
  }

  async function load(ctx: Ctx) {
    const row = await delegate(ctx).findFirst({ where: { id: ctx.params.id, ...scope(ctx) }, include: opts.include });
    if (!row) throw notFound(def.singular);
    return row;
  }

  const out = (ctx: Ctx, row: any) => (opts.mapOut ? opts.mapOut(row, ctx) : row);

  route({
    method: "GET", path: base, tag, summary: `List ${def.title.toLowerCase()}`, auth: readAuth, query: listQuery,
    handler: async (ctx) => {
      const { q, page, pageSize, all } = ctx.query;
      const where: Record<string, unknown> = { ...scope(ctx) };
      if (def.softDelete && all !== "1") where.isActive = true;
      if (q && def.search?.length)
        where.OR = def.search.map((k) => ({ [k]: { contains: q, mode: "insensitive" } }));
      const [rows, total] = await Promise.all([
        delegate(ctx).findMany({
          where, include: opts.include, orderBy: opts.orderBy ?? { createdAt: "desc" },
          skip: (page - 1) * pageSize, take: pageSize,
        }),
        delegate(ctx).count({ where }),
      ]);
      const items = opts.listHook ? await opts.listHook(ctx, rows) : rows;
      return { items: items.map((r: any) => out(ctx, r)), total, page, pageSize };
    },
  });

  route({
    method: "GET", path: `${base}/:id`, tag, summary: `Get one ${def.singular.toLowerCase()}`, auth: readAuth,
    handler: async (ctx) => {
      const row = await load(ctx);
      const [withExtra] = opts.listHook ? await opts.listHook(ctx, [row]) : [row];
      return out(ctx, withExtra);
    },
  });

  route({
    method: "POST", path: base, tag, summary: `Create ${def.singular.toLowerCase()}`, auth: writeAuth, body: create,
    audit: `${def.key}.create`,
    handler: async (ctx) => {
      const input = ctx.body as Record<string, unknown>;
      await checkRefs(ctx, input);
      let data = toDb(def, input);
      for (const v of opts.virtual ?? []) delete data[v];
      if (opts.beforeCreate) data = await opts.beforeCreate(ctx, data);
      const row = await delegate(ctx).create({
        data: { ...data, tenantId: ctx.tenantId, ...(def.branchScoped ? { branchId: ctx.branchId } : {}) },
        include: opts.include,
      });
      if (opts.afterCreate) await opts.afterCreate(ctx, row, input);
      await ctx.audit(`${def.key}.create`, { type: def.key, id: row.id });
      ctx.status = 201;
      return out(ctx, row);
    },
  });

  route({
    method: "PATCH", path: `${base}/:id`, tag, summary: `Update ${def.singular.toLowerCase()}`, auth: writeAuth, body: update,
    handler: async (ctx) => {
      const existing = await load(ctx);
      const input = ctx.body as Record<string, unknown>;
      await checkRefs(ctx, input);
      let data = toDb(def, input);
      for (const v of opts.virtual ?? []) delete data[v];
      if (opts.beforeUpdate) data = await opts.beforeUpdate(ctx, data, existing);
      const row = await delegate(ctx).update({ where: { id: existing.id }, data, include: opts.include });
      await ctx.audit(`${def.key}.update`, { type: def.key, id: row.id }, { fields: Object.keys(data) });
      return out(ctx, row);
    },
  });

  if (!opts.noDelete) {
    route({
      method: "DELETE", path: `${base}/:id`, tag,
      summary: def.softDelete ? `Deactivate ${def.singular.toLowerCase()}` : `Delete ${def.singular.toLowerCase()}`,
      auth: writeAuth,
      handler: async (ctx) => {
        const existing = await load(ctx);
        if (def.softDelete) await delegate(ctx).update({ where: { id: existing.id }, data: { isActive: false } });
        else await delegate(ctx).delete({ where: { id: existing.id } });
        await ctx.audit(`${def.key}.${def.softDelete ? "deactivate" : "delete"}`, { type: def.key, id: existing.id });
        return { ok: true };
      },
    });
    if (def.softDelete) {
      route({
        method: "POST", path: `${base}/:id/restore`, tag, summary: `Reactivate ${def.singular.toLowerCase()}`, auth: writeAuth,
        handler: async (ctx) => {
          const row = await delegate(ctx).findFirst({ where: { id: ctx.params.id, ...scope(ctx) } });
          if (!row) throw notFound(def.singular);
          await delegate(ctx).update({ where: { id: row.id }, data: { isActive: true } });
          return { ok: true };
        },
      });
    }
  }
}
