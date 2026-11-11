/**
 * Production first-run setup. Creates ONE business with roles, chart of
 * accounts, posting rules, approval policies and the owner user.
 * - Refuses if any business already exists.
 * - Never creates demo data or default credentials: the owner password must be
 *   supplied at run time (SETUP_OWNER_PASSWORD) and must be changed at first sign-in.
 */
import "reflect-metadata";
import { createPrismaClient } from "@retail/db";
import "../config";
import { validatePasswordStrength } from "../modules/auth/auth.service";
import { createBranchWithDefaults, createUser, setupBusiness } from "./business-setup";

async function main() {
  const name = process.env.SETUP_BUSINESS_NAME?.trim();
  const email = process.env.SETUP_OWNER_EMAIL?.trim().toLowerCase();
  const password = process.env.SETUP_OWNER_PASSWORD ?? "";
  const branchName = process.env.SETUP_FIRST_BRANCH_NAME?.trim() || "Main Store";
  if (!name || !email || !password) throw new Error("Set SETUP_BUSINESS_NAME, SETUP_OWNER_EMAIL and SETUP_OWNER_PASSWORD");
  validatePasswordStrength(password);
  if (/demo|password|12345/i.test(password)) throw new Error("Choose a non-trivial owner password");
  const db = createPrismaClient();
  try {
    if (await db.business.count()) throw new Error("A business already exists; setup has already been run");
    const business = await setupBusiness(db, { name, isDemo: false });
    await db.$transaction(async (tx) => {
      const branch = await createBranchWithDefaults(tx, business.id, { code: "MAIN", name: branchName, kind: "STORE" });
      await createUser(tx, business.id, { email, name: "Owner", password, roles: ["OWNER"], branchIds: [branch.id], allBranches: true, mustChange: true });
    });
    console.log(`Business "${name}" created. Sign in as ${email} (password change required). Next: tax rates, branches, registers, users, products, opening stock.`);
  } finally {
    await db.$disconnect();
  }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
