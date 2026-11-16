import { AdminController } from "../src/modules/admin/admin.controller";
import { closeContext, makeWorld, World } from "./harness";

let w: World;
let admin: AdminController;
beforeAll(async () => { w = await makeWorld(); admin = w.app.get(AdminController); });
afterAll(closeContext);

describe("branches", () => {
  it("edits and deletes an unused branch with its locations, registers, tills and safe; refuses a branch with history", async () => {
    const br = await admin.createBranch(w.owner, { code: "tmp1", name: "Pop-up stand", kind: "STORE" });
    const reg = await admin.createRegister(w.owner, { branch_id: br.id, code: "P1", name: "Pop-up till" });
    const safe = await w.db.financialAccount.findFirstOrThrow({ where: { branch_id: br.id, kind: "SAFE" } });
    expect(safe.code).toBe("SAFE-TMP1");

    const upd = await admin.updateBranch(w.owner, br.id, { code: "pop", name: "Pop-up kiosk", phone: "699000000" });
    expect(upd).toMatchObject({ code: "POP", name: "Pop-up kiosk", phone: "699000000" });
    const safe2 = await w.db.financialAccount.findUniqueOrThrow({ where: { id: safe.id } });
    expect(safe2).toMatchObject({ code: "SAFE-POP", name: "Safe — Pop-up kiosk" });
    await expect(admin.updateBranch(w.owner, br.id, { code: w.s1.code })).rejects.toMatchObject({ code: "DUPLICATE_CODE" });

    // the branch.created audit entry points at the branch; deleting detaches it without touching anything else
    const auditBefore = await w.db.auditEvent.findFirstOrThrow({ where: { action: "branch.created", entity_id: br.id } });
    await admin.deleteBranch(w.owner, br.id);
    expect(await w.db.branch.findUnique({ where: { id: br.id } })).toBeNull();
    expect(await w.db.cashRegister.findUnique({ where: { id: reg.id } })).toBeNull();
    expect(await w.db.financialAccount.findMany({ where: { id: { in: [safe.id, reg.till_account_id] } } })).toHaveLength(0);
    expect(await w.db.location.count({ where: { branch_id: br.id } })).toBe(0);
    const auditAfter = await w.db.auditEvent.findUniqueOrThrow({ where: { id: auditBefore.id } });
    expect(auditAfter.branch_id).toBeNull();
    expect(auditAfter.summary).toBe(auditBefore.summary);
    expect(await w.db.auditEvent.count({ where: { action: "branch.deleted", entity_id: br.id } })).toBe(1);

    // audit entries remain append-only outside a branch deletion
    await expect(w.db.$executeRawUnsafe(`UPDATE audit_events SET branch_id = NULL WHERE id = '${auditBefore.id}'`)).rejects.toThrow(/append-only/);

    // a recreated branch gets a free safe ledger code instead of colliding
    const again = await admin.createBranch(w.owner, { code: "TMP2", name: "Second stand", kind: "WAREHOUSE" });
    expect(again.id).toBeTruthy();
    const other = await w.db.auditEvent.findFirstOrThrow({ where: { action: "branch.created", entity_id: again.id } });
    expect(other.branch_id).toBe(again.id);
    await expect(w.db.$executeRawUnsafe(`UPDATE audit_events SET branch_id = NULL WHERE id = '${other.id}'`)).rejects.toThrow(/append-only/);

    // a branch with transactions cannot be deleted or re-coded; one with an open session cannot be deactivated
    await w.session(w.cashier, w.regs.r1.id);
    await expect(admin.deleteBranch(w.owner, w.s1.id)).rejects.toMatchObject({ code: "BRANCH_IN_USE" });
    await expect(admin.updateBranch(w.owner, w.s1.id, { code: "ZZZ" })).rejects.toMatchObject({ code: "BRANCH_IN_USE" });
    await expect(admin.updateBranch(w.owner, w.s1.id, { active: false })).rejects.toMatchObject({ code: "SESSION_OPEN" });
    expect((await admin.updateBranch(w.owner, w.s1.id, { name: "Main shop" })).name).toBe("Main shop");

    // an unused branch can be deactivated
    expect((await admin.updateBranch(w.owner, again.id, { active: false })).active).toBe(false);
  });
});
