import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createApp } from "../src/bootstrap";
import { closeContext, makeWorld, PASSWORD, World } from "./harness";

let w: World;
let app: INestApplication;
const tokens: Record<string, string> = {};
const login = async (email: string) => {
  const r = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password: PASSWORD }).expect(200);
  return r.body.access_token as string;
};

beforeAll(async () => {
  w = await makeWorld();
  app = await createApp({ logger: false });
  await app.init();
  for (const who of ["owner", "cashier", "manager", "keeper"]) tokens[who] = await login((w as any)[who].email);
});
afterAll(async () => { await app?.close(); await closeContext(); });

const api = () => request(app.getHttpServer());

describe("authentication", () => {
  it("rejects unauthenticated requests and wrong passwords, with structured errors", async () => {
    const r = await api().get("/api/v1/products").expect(401);
    expect(r.body.error.code).toBe("UNAUTHENTICATED");
    expect(r.body.requestId).toBeTruthy();
    await api().post("/api/v1/auth/login").send({ email: w.cashier.email, password: "wrong-password-1" }).expect(401);
  });
  it("revoking a session invalidates its access token immediately", async () => {
    const t = await login(w.keeper.email);
    const me = await api().get("/api/v1/auth/sessions").set("Authorization", `Bearer ${t}`).expect(200);
    const current = me.body.find((s: any) => s.current);
    await api().post(`/api/v1/auth/sessions/${current.id}/revoke`).set("Authorization", `Bearer ${t}`).expect(200);
    const r = await api().get("/api/v1/auth/me").set("Authorization", `Bearer ${t}`).expect(401);
    expect(r.body.error.code).toBe("SESSION_REVOKED");
  });
  it("refresh tokens rotate and reuse revokes the session", async () => {
    const r = await api().post("/api/v1/auth/login").send({ email: w.manager.email, password: PASSWORD }).expect(200);
    const cookie = r.headers["set-cookie"][0].split(";")[0];
    const r2 = await api().post("/api/v1/auth/refresh").set("Cookie", cookie).expect(200);
    expect(r2.body.access_token).toBeTruthy();
    const reuse = await api().post("/api/v1/auth/refresh").set("Cookie", cookie).expect(401);
    expect(reuse.body.error.code).toBe("REFRESH_REUSED");
  });
});

describe("server-side permission and branch enforcement", () => {
  it("cashiers cannot read financial statements or manage products", async () => {
    await api().get("/api/v1/accounting/trial-balance").set("Authorization", `Bearer ${tokens.cashier}`).expect(403);
    await api().post("/api/v1/products").set("Authorization", `Bearer ${tokens.cashier}`).send({}).expect(403);
    await api().get("/api/v1/accounting/trial-balance").set("Authorization", `Bearer ${tokens.owner}`).expect(200);
  });
  it("branch scope: a user cannot act on a branch they are not assigned to", async () => {
    const r = await api().get(`/api/v1/catalogue/sellables?branch_id=${w.s2.id}`).set("Authorization", `Bearer ${tokens.cashier}`).expect(403);
    expect(r.body.error.message).toMatch(/branch/i);
    await api().get(`/api/v1/catalogue/sellables?branch_id=${w.s1.id}`).set("Authorization", `Bearer ${tokens.cashier}`).expect(200);
  });
  it("cost prices are never sent to users without products.view_cost", async () => {
    const v = await w.product({ retail: "1000" });
    await w.stock(w.s1.id, v.id, "1", "400");
    const asCashier = await api().get(`/api/v1/products/${v.product_id}`).set("Authorization", `Bearer ${tokens.cashier}`).expect(200);
    expect(asCashier.body.can_view_cost).toBe(false);
    expect(asCashier.body.variants[0].costs).toEqual([]);
    expect(JSON.stringify(asCashier.body)).not.toContain('"average_cost"');
    const asOwner = await api().get(`/api/v1/products/${v.product_id}`).set("Authorization", `Bearer ${tokens.owner}`).expect(200);
    expect(asOwner.body.variants[0].costs[0].average_cost).toBe("400");
    const bal = await api().get(`/api/v1/inventory/balances?branch_id=${w.s1.id}&search=${v.sku}`).set("Authorization", `Bearer ${tokens.keeper}`).expect(200);
    expect(bal.body.items[0].average_cost).toBeUndefined();
  });
  it("request validation rejects malformed money and unknown fields", async () => {
    const r = await api().post("/api/v1/sales/checkout").set("Authorization", `Bearer ${tokens.cashier}`).set("Idempotency-Key", "k-12345678").send({ branch_id: w.s1.id, register_id: w.regs.r1.id, lines: [{ variant_id: w.s1.id, quantity: "1.5e3" }], payments: [{ method: "CASH", amount: "abc" }], hack: true }).expect(400);
    expect(r.body.error.code).toBe("VALIDATION_FAILED");
  });
  it("critical mutations require an Idempotency-Key and replay the original response", async () => {
    const v = await w.product({ retail: "100" });
    await w.stock(w.s1.id, v.id, "3", "50");
    await w.session(w.cashier, w.regs.r1.id);
    const body = { branch_id: w.s1.id, register_id: w.regs.r1.id, lines: [{ variant_id: v.id, quantity: "1" }], payments: [{ method: "CASH", amount: "100" }] };
    await api().post("/api/v1/sales/checkout").set("Authorization", `Bearer ${tokens.cashier}`).send(body).expect(422);
    const a = await api().post("/api/v1/sales/checkout").set("Authorization", `Bearer ${tokens.cashier}`).set("Idempotency-Key", "same-key-0001").send(body).expect(201);
    const b = await api().post("/api/v1/sales/checkout").set("Authorization", `Bearer ${tokens.cashier}`).set("Idempotency-Key", "same-key-0001").send(body).expect(201);
    expect(b.headers["idempotent-replay"]).toBe("true");
    expect(b.body.id).toBe(a.body.id);
    expect(a.body.total).toBe("100"); // decimals serialised as exact strings
    await api().post("/api/v1/sales/checkout").set("Authorization", `Bearer ${tokens.cashier}`).set("Idempotency-Key", "same-key-0001").send({ ...body, notes: "different" }).expect(422);
  });
  it("webhooks require a valid signature", async () => {
    await api().post("/api/v1/payments/webhooks/simulator").set("x-signature", "bad").send({ event_id: "e1", request_reference: "r", status: "SUCCESSFUL" }).expect(401);
  });
});
