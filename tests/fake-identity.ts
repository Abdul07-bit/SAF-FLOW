import { randomUUID } from "node:crypto";
import type { IdentityProvider, IdentityUser } from "@/server/auth/identity";
import { IdentityError } from "@/server/auth/identity";

/**
 * In-memory stand-in for Supabase Auth, used ONLY by the automated tests so
 * they never create real accounts or send real email. It mimics the
 * behaviour the server relies on: invite creates an identity without a
 * password, links carry an access token, recovery and passwords work.
 */
export class FakeIdentity implements IdentityProvider {
  users = new Map<string, { user: IdentityUser; password: string | null; banned: boolean }>();
  tokens = new Map<string, string>(); // access token -> identity id
  outbox: { kind: "invite" | "recovery"; email: string; token: string }[] = [];
  admin = true;

  configured() {
    return true;
  }
  adminConfigured() {
    return this.admin;
  }

  private byEmail(email: string) {
    return [...this.users.values()].find((u) => u.user.email === email.toLowerCase());
  }
  private issue(id: string) {
    const t = `fake-token-${randomUUID()}`;
    this.tokens.set(t, id);
    return t;
  }

  /** The access token from the most recent email to this address. */
  lastToken(email: string): string {
    const m = [...this.outbox].reverse().find((x) => x.email === email.toLowerCase());
    if (!m) throw new Error(`No email sent to ${email}`);
    return m.token;
  }

  async signInWithPassword(email: string, password: string) {
    const u = this.byEmail(email);
    if (!u || u.banned || !u.password || u.password !== password) return null;
    return { user: u.user, accessToken: this.issue(u.user.id) };
  }
  async getUser(token: string) {
    const id = this.tokens.get(token);
    return id ? this.users.get(id)!.user : null;
  }
  async updatePassword(token: string, password: string) {
    const id = this.tokens.get(token);
    if (!id) throw new IdentityError("IDENTITY_ERROR", "bad token", 401);
    const u = this.users.get(id)!;
    if (u.password === password) throw new IdentityError("SAME_PASSWORD", "same", 400);
    u.password = password;
    u.user.emailConfirmed = true;
  }
  async sendRecovery(email: string) {
    const u = this.byEmail(email);
    if (u) this.outbox.push({ kind: "recovery", email: u.user.email, token: this.issue(u.user.id) });
  }
  async inviteUser(email: string) {
    if (this.byEmail(email)) throw new IdentityError("IDENTITY_EXISTS", "exists", 409);
    const user: IdentityUser = { id: randomUUID(), email: email.toLowerCase(), emailConfirmed: false };
    this.users.set(user.id, { user, password: null, banned: false });
    this.outbox.push({ kind: "invite", email: user.email, token: this.issue(user.id) });
    return user;
  }
  async generateInviteLink(email: string) {
    let u = this.byEmail(email);
    if (!u) {
      const user: IdentityUser = { id: randomUUID(), email: email.toLowerCase(), emailConfirmed: false };
      u = { user, password: null, banned: false };
      this.users.set(user.id, u);
    }
    const token = this.issue(u.user.id);
    this.outbox.push({ kind: "invite", email: u.user.email, token });
    return { user: u.user, link: `http://localhost:3000/auth/callback#access_token=${token}&type=invite` };
  }
  async setBanned(id: string, banned: boolean) {
    const u = this.users.get(id);
    if (u) u.banned = banned;
  }
}
