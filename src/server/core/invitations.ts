/**
 * Email invitations for Supabase-identity accounts. Used by SAF Team
 * onboarding, business-owner onboarding and owners inviting their staff.
 *
 * The SAF user row is created INACTIVE with its Supabase identity linked;
 * it activates when the person opens the link and sets a password
 * (POST /auth/link/complete). Nobody else ever knows the password.
 */
import type { Prisma, UserKind } from "@prisma/client";
import type { Tx } from "../db";
import { conflict, HttpError } from "../http/errors";
import { authCallbackUrl, identity, IdentityError, identityToHttp } from "../auth/identity";

export const INVITE_DAYS = 7;
export type Delivery = "email" | "link";

/** Creates the Supabase identity and the invitation email or link. */
export async function sendIdentityInvite(email: string, delivery: Delivery, data: Record<string, unknown>) {
  const idp = identity();
  if (!idp.adminConfigured())
    throw new HttpError(503, "IDENTITY_NOT_CONFIGURED",
      "Email invitations are awaiting Supabase credentials (SUPABASE_SECRET_KEY). See docs/DEPLOYMENT.md.");
  if (delivery === "email") {
    try {
      const user = await idp.inviteUser(email, authCallbackUrl(), data);
      return { authUserId: user.id, delivery: "email" as const, link: null as string | null };
    } catch (e) {
      // The identity already exists (e.g. an earlier attempt): hand out a link instead.
      if (!(e instanceof IdentityError && e.code === "IDENTITY_EXISTS")) identityToHttp(e);
    }
  }
  const r = await idp.generateInviteLink(email, authCallbackUrl(), data).catch(identityToHttp);
  return { authUserId: r.user.id, delivery: "link" as const, link: r.link as string | null };
}

export async function assertEmailFree(db: Tx, email: string) {
  const clash = await db.user.findFirst({
    where: { OR: [{ username: email }, { authUserId: { not: null }, email: { equals: email, mode: "insensitive" } }] },
    select: { id: true },
  });
  if (clash) throw conflict("A SAF Flow account already uses this email.");
}

export interface InviteAccountInput {
  email: string;
  fullName: string;
  phone?: string | null;
  kind: UserKind;
  tenantId: string | null;
  isTenantOwner?: boolean;
  platformRole?: string | null;
  delivery: Delivery;
  invitedById: string | null;
  /** Extra nested data for users.create (e.g. a staff profile). */
  extra?: Partial<Prisma.UserCreateInput>;
}

export async function inviteAccount(db: Tx, input: InviteAccountInput) {
  const email = input.email.trim().toLowerCase();
  await assertEmailFree(db, email);
  const sent = await sendIdentityInvite(email, input.delivery, { full_name: input.fullName });
  if (await db.user.findUnique({ where: { authUserId: sent.authUserId }, select: { id: true } }))
    throw conflict("This email's sign-in account is already linked to another SAF Flow user.");

  const user = await db.user.create({
    data: {
      ...(input.extra as object),
      kind: input.kind, username: email, email, authUserId: sent.authUserId, fullName: input.fullName,
      phone: input.phone || null, isTenantOwner: input.isTenantOwner ?? false,
      isActive: false, mustChangePassword: false,
      ...(input.platformRole ? { platformRoleRef: { connect: { code: input.platformRole } } } : {}),
      ...(input.tenantId ? { tenant: { connect: { id: input.tenantId } } } : {}),
    } as Prisma.UserCreateInput,
  });
  await db.invitation.create({
    data: {
      tenantId: input.tenantId, userId: user.id, email, delivery: sent.delivery, invitedById: input.invitedById,
      expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
    },
  });
  return { user, delivery: sent.delivery, link: sent.link };
}

/** New link / email for someone who has not accepted yet. */
export async function resendInvite(db: Tx, userId: string, delivery: Delivery) {
  const pending = await db.invitation.findFirst({ where: { userId, status: "PENDING" } });
  if (!pending) throw new HttpError(400, "NOT_PENDING", "This person has already accepted their invitation.");
  // A second "invite" email cannot go to an existing identity, so email resends use the recovery email.
  const link = delivery === "email"
    ? await identity().sendRecovery(pending.email, authCallbackUrl()).then(() => null, identityToHttp)
    : (await identity().generateInviteLink(pending.email, authCallbackUrl(), {}).catch(identityToHttp)).link;
  await db.invitation.update({
    where: { id: pending.id },
    data: { delivery, sentAt: new Date(), expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000) },
  });
  return { delivery, link };
}
