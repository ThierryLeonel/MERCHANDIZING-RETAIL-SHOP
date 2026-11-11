/** Generates documentation/requirements/permission-matrix.md from the permission catalogue. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVAL_TYPES, DEFAULT_ROLES, PERMISSIONS } from "./src/permissions";

const roles = Object.entries(DEFAULT_ROLES);
const lines = ["# Role and permission matrix", "", "_Generated from `packages/api-contracts/src/permissions.ts`. Enforced server-side on every request (PermissionsGuard + service checks); hiding UI controls is only a convenience._", "",
  "Roles are editable per business (Administration → Roles). An administrator can only grant permissions they hold. The Owner role always has all permissions.", "",
  `| Permission | Description | ${roles.map(([, r]) => r.name).join(" | ")} |`, `|---|---|${roles.map(() => ":-:").join("|")}|`];
for (const p of PERMISSIONS) lines.push(`| \`${p.code}\`${(p as any).sensitive ? " ★" : ""} | ${p.description} | ${roles.map(([, r]) => (r.permissions.includes(p.code as any) ? "✓" : "")).join(" | ")} |`);
lines.push("", "★ sensitive permission.", "", "## Approval types and deciding permission", "", "| Request type | Permission required to decide |", "|---|---|");
for (const [t, p] of Object.entries(APPROVAL_TYPES)) lines.push(`| ${t} | \`${p}\` |`);
lines.push("", "Self-approval is blocked by default for every type (configurable per policy). The System Administrator role holds no `approve.*` permission: technical administration does not confer financial approval authority.");
writeFileSync(join(__dirname, "..", "..", "documentation", "requirements", "permission-matrix.md"), lines.join("\n") + "\n");
console.log("permission matrix written");
