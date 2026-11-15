import { AdminController } from "../src/modules/admin/admin.controller";
import { closeContext, makeWorld, World } from "./harness";

let w: World;
let admin: AdminController;
beforeAll(async () => { w = await makeWorld(); admin = w.app.get(AdminController); });
afterAll(closeContext);

describe("cash registers", () => {
  it("creates, edits and deletes an unused register (with its till account); refuses deleting one with history", async () => {
    const reg = await admin.createRegister(w.owner, { branch_id: w.s1.id, code: "t9", name: "Express till" });
    expect(reg.code).toBe("T9");
    await expect(admin.createRegister(w.owner, { branch_id: w.s1.id, code: "T9", name: "Dup" })).rejects.toMatchObject({ code: "DUPLICATE_CODE" });
    const fa = await w.db.financialAccount.findUniqueOrThrow({ where: { id: reg.till_account_id } });

    const upd = await admin.updateRegister(w.owner, reg.id, { name: "Express lane", code: "T10" });
    expect(upd.code).toBe("T10");
    expect((await w.db.financialAccount.findUniqueOrThrow({ where: { id: fa.id } })).name).toContain("Express lane");
    expect((await w.db.account.findUniqueOrThrow({ where: { id: fa.gl_account_id } })).name).toContain("Express lane");

    await admin.deleteRegister(w.owner, reg.id);
    expect(await w.db.cashRegister.findUnique({ where: { id: reg.id } })).toBeNull();
    expect(await w.db.financialAccount.findUnique({ where: { id: fa.id } })).toBeNull();
    expect(await w.db.account.findUnique({ where: { id: fa.gl_account_id } })).toBeNull();

    // a new register reuses the freed ledger code instead of colliding
    const again = await admin.createRegister(w.owner, { branch_id: w.s1.id, code: "T11", name: "Again" });
    expect(again.id).toBeTruthy();

    // a register with a session cannot be deleted, cannot change code, cannot be deactivated while open
    await w.session(w.cashier, w.regs.r1.id);
    await expect(admin.deleteRegister(w.owner, w.regs.r1.id)).rejects.toMatchObject({ code: "REGISTER_IN_USE" });
    await expect(admin.updateRegister(w.owner, w.regs.r1.id, { code: "ZZ" })).rejects.toMatchObject({ code: "REGISTER_IN_USE" });
    await expect(admin.updateRegister(w.owner, w.regs.r1.id, { active: false })).rejects.toMatchObject({ code: "SESSION_OPEN" });
    const renamed = await admin.updateRegister(w.owner, w.regs.r1.id, { name: "Main counter" });
    expect(renamed.name).toBe("Main counter");

    // an unused register can be deactivated, and then no session can be opened on it
    await admin.updateRegister(w.owner, again.id, { active: false });
    await expect(w.svc.finance.openSession(w.manager, { register_id: again.id, opening_float: "0" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
