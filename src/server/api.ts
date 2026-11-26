/**
 * Registers every API module once and exposes the dispatcher used by the
 * Next.js catch-all route (src/app/api/[...path]/route.ts) and by the tests.
 */
import "./routes/auth";
import "./routes/mfa";
import "./routes/security";
import "./routes/admin";
import "./routes/team";
import "./routes/tenant";
import "./routes/staff";
import "./routes/dine";
import "./routes/stay";
import "./routes/bill";
import "./routes/daybook";
import "./routes/system";

export { handleRequest, listRoutes } from "./http/router";
