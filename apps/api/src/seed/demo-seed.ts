/**
 * DEMONSTRATION DATA — fictional business for evaluation and training.
 * Never run against production (refuses when NODE_ENV=production).
 *
 * All transactional data is created through the real business services, so
 * stock, cost pools and journals agree exactly (verified at the end by the
 * reconciliation report). Because stock movements cannot be backdated
 * (see documentation/accounting/policies.md), all demo activity is dated today.
 *
 *   pnpm seed:demo            # requires an EMPTY, migrated database
 *   pnpm seed:demo --reset # drops and re-migrates the dev database first
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { INestApplicationContext } from "@nestjs/common";
import { AppModule } from "../app.module";
import { AuthContext } from "../common/auth-context";
import { loadAuthContext } from "../common/guards";
import { D } from "../common/money";
import { PrismaService } from "../common/prisma.service";
import { config } from "../config";
import { AccountingService } from "../modules/accounting/accounting.service";
import { ApprovalsService } from "../modules/approvals/approvals.service";
import { CatalogueService, ProductInput } from "../modules/catalogue/catalogue.service";
import { CustomersService } from "../modules/customers/customers.service";
import { FinanceService } from "../modules/finance/finance.service";
import { InventoryService } from "../modules/inventory/inventory.service";
import { PurchasingService } from "../modules/purchasing/purchasing.service";
import { SalesService } from "../modules/sales/sales.service";
import { createBranchWithDefaults, createRegister, createUser, setupBusiness } from "./business-setup";

export const DEMO_PASSWORD = "Demo@12345";

export async function runDemoSeed(app: INestApplicationContext, opts: { quiet?: boolean } = {}) {
  const log = (m: string) => !opts.quiet && console.log(m);
  const prisma = app.get(PrismaService);
  const db = prisma.client;
  if (await db.business.count()) throw new Error("Database already contains a business. Use --reset (development only) to start over.");

  // ------------------------------------------------------------ organisation
  const business = await setupBusiness(db, { name: "Mboa Home & Style (DEMO)", legalName: "Mboa Home & Style SARL — fictional demo company", phone: "+237 600 000 000", address: "Rue de la Joie, Akwa, Douala (fictional)", isDemo: true });
  const B = business.id;
  const { dla1, dla2, wh1 } = await db.$transaction(async (tx) => ({
    dla1: await createBranchWithDefaults(tx, B, { code: "DLA1", name: "Akwa Store", kind: "STORE", address: "Akwa, Douala" }),
    dla2: await createBranchWithDefaults(tx, B, { code: "DLA2", name: "Bonapriso Store", kind: "STORE", address: "Bonapriso, Douala" }),
    wh1: await createBranchWithDefaults(tx, B, { code: "WH1", name: "Central Warehouse", kind: "WAREHOUSE", address: "Bassa industrial zone, Douala" }),
  }));
  const regs = await db.$transaction(async (tx) => ({
    r1: await createRegister(tx, B, dla1.id, "R1", "Till 1"),
    r2: await createRegister(tx, B, dla1.id, "R2", "Till 2"),
    r3: await createRegister(tx, B, dla2.id, "R1", "Till 1"),
  }));
  const users = [
    { email: "owner@mboa.demo", name: "Amina Owner", roles: ["OWNER"], branchIds: [], allBranches: true },
    { email: "manager.akwa@mboa.demo", name: "Paul Manager (Akwa)", roles: ["STORE_MANAGER"], branchIds: [dla1.id, wh1.id] },
    { email: "cashier.akwa@mboa.demo", name: "Grace Cashier (Akwa)", roles: ["CASHIER"], branchIds: [dla1.id] },
    { email: "cashier2.akwa@mboa.demo", name: "Eric Cashier (Akwa)", roles: ["CASHIER"], branchIds: [dla1.id] },
    { email: "manager.bonapriso@mboa.demo", name: "Sandrine Manager (Bonapriso)", roles: ["STORE_MANAGER"], branchIds: [dla2.id] },
    { email: "cashier.bonapriso@mboa.demo", name: "Joel Cashier (Bonapriso)", roles: ["CASHIER"], branchIds: [dla2.id] },
    { email: "buyer@mboa.demo", name: "Nadia Purchasing", roles: ["PURCHASING_OFFICER"], branchIds: [], allBranches: true },
    { email: "storekeeper@mboa.demo", name: "Bruno Storekeeper", roles: ["STOREKEEPER"], branchIds: [wh1.id, dla1.id, dla2.id] },
    { email: "accountant@mboa.demo", name: "Claire Accountant", roles: ["ACCOUNTANT"], branchIds: [], allBranches: true },
    { email: "admin@mboa.demo", name: "Sam SysAdmin", roles: ["SYSTEM_ADMIN"], branchIds: [], allBranches: true },
    { email: "auditor@mboa.demo", name: "Irene Auditor", roles: ["AUDITOR"], branchIds: [], allBranches: true },
  ];
  await db.$transaction(async (tx) => { for (const u of users) await createUser(tx, B, { ...u, password: DEMO_PASSWORD }); }, { timeout: 60_000 });
  log(`Organisation: 3 branches, 3 registers, ${users.length} users`);

  const actor = async (email: string): Promise<AuthContext> => {
    const u = await db.user.findFirstOrThrow({ where: { email } });
    const s = await db.userSession.create({ data: { user_id: u.id, refresh_token_hash: "demo-seed", expires_at: new Date(Date.now() + 3600_000), user_agent: "demo-seed" } });
    return loadAuthContext(prisma, u.id, s.id);
  };
  const owner = await actor("owner@mboa.demo");
  const buyer = await actor("buyer@mboa.demo");
  const keeper = await actor("storekeeper@mboa.demo");
  const managerAkwa = await actor("manager.akwa@mboa.demo");
  const cashierAkwa = await actor("cashier.akwa@mboa.demo");
  const cashier2Akwa = await actor("cashier2.akwa@mboa.demo");
  const cashierBona = await actor("cashier.bonapriso@mboa.demo");
  const managerBona = await actor("manager.bonapriso@mboa.demo");
  const accountant = await actor("accountant@mboa.demo");

  // --------------------------------------------------------------- catalogue
  const ref = async () => ({
    units: Object.fromEntries((await db.unit.findMany({ where: { business_id: B } })).map((u) => [u.code, u.id])),
  });
  const { units } = await ref();
  const demoTax = await db.taxRate.create({ data: { business_id: B, code: "DEMO-TAX", name: "Demo sales tax 10% (illustrative only — configure real rates)", rate_percent: D(10) } });
  const depts: Record<string, string> = {};
  for (const [code, name] of [["HOME", "Home & Kitchen"], ["BEAUTY", "Beauty & Fragrance"], ["FASHION", "Fashion"], ["BABY", "Baby"], ["PARTY", "Party"], ["CLEAN", "Cleaning"], ["ACCESS", "Watches & Accessories"]]) {
    depts[code] = (await db.department.create({ data: { business_id: B, code, name } })).id;
  }
  const cats: Record<string, string> = {};
  for (const [code, name, dept] of [
    ["APPLIANCES", "Small appliances", "HOME"], ["KITCHEN", "Kitchen utensils", "HOME"], ["COSMETICS", "Cosmetics", "BEAUTY"], ["PERFUME", "Perfumes", "BEAUTY"],
    ["DRESSES", "Dresses", "FASHION"], ["MENSWEAR", "Menswear", "FASHION"], ["SHOES", "Shoes", "FASHION"], ["BAGS", "Bags", "ACCESS"], ["WATCHES", "Watches", "ACCESS"],
    ["JEWELLERY", "Accessories", "ACCESS"], ["BABYWEAR", "Baby clothing", "BABY"], ["BABYCARE", "Baby bath & care", "BABY"], ["PARTY", "Party supplies", "PARTY"],
    ["DETERGENT", "Detergents", "CLEAN"], ["HOUSEHOLD", "Household paper", "CLEAN"], ["SERVICES", "Services", "PARTY"],
    ["LOOSE", "Bulk & loose goods", "FASHION"],
  ]) cats[code] = (await db.category.create({ data: { business_id: B, code, name, department_id: depts[dept] } })).id;
  const brands: Record<string, string> = {};
  for (const name of ["Sawa Home", "Kumba Kitchen", "Bella Douala", "Ébène Parfums", "Wouri Wear", "Mungo Leather", "Limbe Time", "Petit Lion", "Fête Facile", "Propre+"]) brands[name] = (await db.brand.create({ data: { business_id: B, name } })).id;
  const attr = async (code: string, name: string, values: string[]) => {
    const a = await db.attribute.create({ data: { business_id: B, code, name, values: { create: values.map((v, i) => ({ value: v, sort_order: i })) } }, include: { values: true } });
    return Object.fromEntries(a.values.map((v) => [v.value, v.id]));
  };
  const SIZE = await attr("SIZE", "Size", ["S", "M", "L", "XL"]);
  const COLOUR = await attr("COLOUR", "Colour", ["Red", "Blue", "Black", "Brown", "Pink", "Gold"]);
  const SHOE = await attr("SHOE_SIZE", "Shoe size", ["18", "19", "20", "37", "38", "39", "40", "41", "42", "43", "44"]);
  const VOLUME = await attr("VOLUME", "Volume", ["50 ml", "100 ml"]);
  const AGE = await attr("AGE", "Age group", ["0-3 m", "3-6 m", "6-12 m"]);

  const suppliers: Record<string, string> = {};
  for (const [code, name, terms] of [["SUP-HOME", "Douala Home Distributors (demo)", 30], ["SUP-BEAUTY", "Cosmétiques du Littoral (demo)", 15], ["SUP-FASHION", "Wouri Textile Import (demo)", 30], ["SUP-CLEAN", "Propre Industries (demo)", 0]] as const) {
    suppliers[code] = (await db.supplier.create({ data: { business_id: B, code, name, payment_terms_days: terms, phone: "+237 600 000 1" + code.length, email: `${code.toLowerCase()}@supplier.demo` } })).id;
  }

  const P = (p: Omit<ProductInput, "base_unit_id"> & { base_unit_id?: string }) => catalogue.createProduct(owner, { base_unit_id: units.PCS, tax_rate_id: demoTax.id, ...p } as ProductInput);
  const catalogue = app.get(CatalogueService);
  let barcodeSeq = 1000;
  const one = (sku: string, name: string, retail: string, extra: Partial<ProductInput["variants"][number]> = {}) => [{ sku, name, retail_price: retail, barcodes: [{ code: `61000000${++barcodeSeq}` }], reorder_point: "5", reorder_qty: "20", ...extra }];
  const variants = (prefix: string, base: string, retail: string, combos: { label: string; values: string[] }[], extra: Partial<ProductInput["variants"][number]> = {}) =>
    combos.map((c) => ({ sku: `${prefix}-${c.label.replace(/[^A-Z0-9]/gi, "").toUpperCase()}`, name: `${base} ${c.label}`, retail_price: retail, attribute_value_ids: c.values, barcodes: [{ code: `62000000${++barcodeSeq}` }], reorder_point: "2", reorder_qty: "6", ...extra }));
  const sizesColours = (sizes: string[], colours: string[]) => sizes.flatMap((s) => colours.map((c) => ({ label: `${s} ${c}`, values: [SIZE[s], COLOUR[c]] })));

  const prods: Record<string, any> = {};
  const add = async (key: string, p: Parameters<typeof P>[0]) => { prods[key] = await P(p); };
  await add("kettle", { code: "P-KETTLE", name: "Electric kettle 1.7 L", product_type: "STANDARD", department_id: depts.HOME, category_id: cats.APPLIANCES, brand_id: brands["Sawa Home"], track_serials: true, warranty_months: 12, variants: one("KET-17", "Electric kettle 1.7 L stainless", "18500", { min_price: "16000", preferred_supplier_id: suppliers["SUP-HOME"], is_shortcut: true }) });
  await add("blender", { code: "P-BLENDER", name: "Blender 2-speed 1.5 L", product_type: "STANDARD", department_id: depts.HOME, category_id: cats.APPLIANCES, brand_id: brands["Sawa Home"], track_serials: true, warranty_months: 12, variants: one("BLD-15", "Blender 2-speed 1.5 L", "32000", { min_price: "28000", preferred_supplier_id: suppliers["SUP-HOME"] }) });
  await add("pan", { code: "P-PAN28", name: "Non-stick frying pan 28 cm", product_type: "STANDARD", department_id: depts.HOME, category_id: cats.KITCHEN, brand_id: brands["Kumba Kitchen"], variants: one("PAN-28", "Non-stick frying pan 28 cm", "9500", { is_shortcut: true }) });
  await add("potset", { code: "P-POTSET", name: "Stainless cooking pot set (5 pcs)", product_type: "PREPACKED_SET", department_id: depts.HOME, category_id: cats.KITCHEN, brand_id: brands["Kumba Kitchen"], variants: one("POT-SET5", "Cooking pot set 5 pcs", "45000", { min_price: "40000" }) });
  await add("knives", { code: "P-KNIVES", name: "Kitchen knife set (6 pcs)", product_type: "PREPACKED_SET", department_id: depts.HOME, category_id: cats.KITCHEN, brand_id: brands["Kumba Kitchen"], variants: one("KNF-SET6", "Kitchen knife set 6 pcs", "12500") });
  await add("containers", { code: "P-BOX6", name: "Food storage containers (6-pack)", product_type: "STANDARD", department_id: depts.HOME, category_id: cats.KITCHEN, brand_id: brands["Kumba Kitchen"], variants: one("BOX-6", "Food containers 6-pack", "6000") });
  await add("spoons", { code: "P-SPOONS", name: "Wooden spoon set", product_type: "STANDARD", department_id: depts.HOME, category_id: cats.KITCHEN, variants: one("SPN-SET", "Wooden spoon set (4)", "2500", { is_shortcut: true }) });
  await add("lotion", { code: "P-LOTION", name: "Body lotion 400 ml", product_type: "STANDARD", department_id: depts.BEAUTY, category_id: cats.COSMETICS, brand_id: brands["Bella Douala"], variants: one("LOT-400", "Body lotion 400 ml", "3500", { is_shortcut: true }) });
  await add("shea", { code: "P-SHEA", name: "Shea butter cream 250 ml", product_type: "STANDARD", department_id: depts.BEAUTY, category_id: cats.COSMETICS, brand_id: brands["Bella Douala"], track_batches: true, track_expiry: true, variants: one("SHEA-250", "Shea butter cream 250 ml", "4000", { preferred_supplier_id: suppliers["SUP-BEAUTY"] }) });
  await add("lipstick", { code: "P-LIPSTICK", name: "Matte lipstick", product_type: "VARIANT", department_id: depts.BEAUTY, category_id: cats.COSMETICS, brand_id: brands["Bella Douala"], variants: variants("LIP", "Matte lipstick", "2500", [{ label: "Red", values: [COLOUR.Red] }, { label: "Pink", values: [COLOUR.Pink] }, { label: "Brown", values: [COLOUR.Brown] }]) });
  await add("perfume", { code: "P-EBENE", name: "Nuit d'Ébène eau de parfum", product_type: "VARIANT", department_id: depts.BEAUTY, category_id: cats.PERFUME, brand_id: brands["Ébène Parfums"], variants: [
    { sku: "EBN-50", name: "Nuit d'Ébène EDP 50 ml", retail_price: "22000", min_price: "19000", attribute_value_ids: [VOLUME["50 ml"]], barcodes: [{ code: "6200000005001" }], reorder_point: "2", reorder_qty: "6" },
    { sku: "EBN-100", name: "Nuit d'Ébène EDP 100 ml", retail_price: "35000", min_price: "31000", attribute_value_ids: [VOLUME["100 ml"]], barcodes: [{ code: "6200000010001" }], reorder_point: "2", reorder_qty: "6" },
  ] });
  await add("perfumeMen", { code: "P-WOURI", name: "Wouri Homme eau de toilette 100 ml", product_type: "STANDARD", department_id: depts.BEAUTY, category_id: cats.PERFUME, brand_id: brands["Ébène Parfums"], variants: one("WRI-100", "Wouri Homme EDT 100 ml", "27000") });
  await add("dress", { code: "P-DRESS-WAX", name: "Wax-print midi dress", product_type: "VARIANT", department_id: depts.FASHION, category_id: cats.DRESSES, brand_id: brands["Wouri Wear"], variants: variants("DRS", "Wax-print dress", "15000", sizesColours(["S", "M", "L", "XL"], ["Red", "Blue"])) });
  await add("polo", { code: "P-POLO", name: "Men's cotton polo", product_type: "VARIANT", department_id: depts.FASHION, category_id: cats.MENSWEAR, brand_id: brands["Wouri Wear"], variants: variants("PLO", "Men's polo", "8000", sizesColours(["M", "L", "XL"], ["Black", "Blue"])) });
  await add("sandals", { code: "P-SANDAL", name: "Women's sandals", product_type: "VARIANT", department_id: depts.FASHION, category_id: cats.SHOES, brand_id: brands["Mungo Leather"], variants: variants("SND", "Women's sandals size", "11000", ["37", "38", "39", "40", "41"].map((s) => ({ label: s, values: [SHOE[s]] }))) });
  await add("shoes", { code: "P-OXFORD", name: "Men's leather shoes", product_type: "VARIANT", department_id: depts.FASHION, category_id: cats.SHOES, brand_id: brands["Mungo Leather"], variants: variants("OXF", "Men's leather shoes size", "28000", ["40", "41", "42", "43", "44"].map((s) => ({ label: s, values: [SHOE[s]] })), { min_price: "24000" }) });
  await add("tote", { code: "P-TOTE", name: "Leather tote handbag", product_type: "VARIANT", department_id: depts.ACCESS, category_id: cats.BAGS, brand_id: brands["Mungo Leather"], variants: variants("TOT", "Leather tote", "24000", [{ label: "Black", values: [COLOUR.Black] }, { label: "Brown", values: [COLOUR.Brown] }]) });
  await add("backpack", { code: "P-BACKPACK", name: "Everyday backpack", product_type: "STANDARD", department_id: depts.ACCESS, category_id: cats.BAGS, variants: one("BPK-01", "Everyday backpack", "13500") });
  await add("watchMen", { code: "P-WATCH-M", name: "Men's analogue watch", product_type: "STANDARD", department_id: depts.ACCESS, category_id: cats.WATCHES, brand_id: brands["Limbe Time"], track_serials: true, warranty_months: 24, variants: one("WCH-M01", "Men's analogue watch steel", "42000", { min_price: "37000" }) });
  await add("watchLady", { code: "P-WATCH-L", name: "Ladies' bracelet watch", product_type: "STANDARD", department_id: depts.ACCESS, category_id: cats.WATCHES, brand_id: brands["Limbe Time"], variants: one("WCH-L01", "Ladies' bracelet watch gold-tone", "29000") });
  await add("sunglasses", { code: "P-SUNGLASS", name: "Polarised sunglasses", product_type: "STANDARD", department_id: depts.ACCESS, category_id: cats.JEWELLERY, variants: one("SUN-01", "Polarised sunglasses", "7500") });
  await add("earrings", { code: "P-EARRINGS", name: "Fashion earrings set", product_type: "PREPACKED_SET", department_id: depts.ACCESS, category_id: cats.JEWELLERY, variants: one("EAR-SET", "Fashion earrings set (3 pairs)", "4500") });
  await add("bodysuit", { code: "P-BODYSUIT", name: "Baby bodysuit 3-pack", product_type: "VARIANT", department_id: depts.BABY, category_id: cats.BABYWEAR, brand_id: brands["Petit Lion"], variants: variants("BDY", "Baby bodysuit 3-pack", "7000", ["0-3 m", "3-6 m", "6-12 m"].map((a) => ({ label: a, values: [AGE[a]] }))) });
  await add("babygel", { code: "P-BABYGEL", name: "Baby bath gel 500 ml", product_type: "STANDARD", department_id: depts.BABY, category_id: cats.BABYCARE, brand_id: brands["Petit Lion"], track_batches: true, track_expiry: true, variants: one("BBG-500", "Baby bath gel 500 ml", "3800") });
  await add("babyshoes", { code: "P-BABYSHOE", name: "Baby soft-sole shoes", product_type: "VARIANT", department_id: depts.BABY, category_id: cats.BABYWEAR, brand_id: brands["Petit Lion"], variants: variants("BBS", "Baby soft shoes size", "5000", ["18", "19", "20"].map((s) => ({ label: s, values: [SHOE[s]] }))) });
  await add("babytowel", { code: "P-BABYTOWEL", name: "Hooded baby towel", product_type: "STANDARD", department_id: depts.BABY, category_id: cats.BABYCARE, brand_id: brands["Petit Lion"], variants: one("BBT-01", "Hooded baby towel", "6500") });
  await add("partykit", { code: "P-PARTYKIT", name: "Birthday party kit (prepacked)", product_type: "PREPACKED_SET", department_id: depts.PARTY, category_id: cats.PARTY, brand_id: brands["Fête Facile"], variants: one("PTY-KIT", "Birthday party kit for 10", "15000") });
  await add("balloons", { code: "P-BALLOON", name: "Balloons (pack of 50)", product_type: "STANDARD", department_id: depts.PARTY, category_id: cats.PARTY, brand_id: brands["Fête Facile"], variants: one("BAL-50", "Balloons assorted, pack of 50", "3000", { is_shortcut: true }) });
  await add("plates", { code: "P-PLATES", name: "Paper plates (pack of 20)", product_type: "STANDARD", department_id: depts.PARTY, category_id: cats.PARTY, brand_id: brands["Fête Facile"], variants: one("PLT-20", "Paper plates, pack of 20", "1500") });
  // Bulk / loose goods: bought as a lot, sold by the piece or metre, price bargained down to a minimum.
  await add("tshirtBale", { code: "P-FRIP-TS", name: "Second-hand T-shirts (from bales)", product_type: "BULK", negotiable_price: true, department_id: depts.FASHION, category_id: cats.LOOSE, variants: [{ sku: "FRIP-TS", name: "Second-hand T-shirt (assorted)", retail_price: "1500", min_price: "1000", reorder_point: "40", reorder_qty: "120", is_shortcut: true, conversions: [{ unit_id: units.BALE, factor: "120", is_purchase_default: true, is_sellable: true }] }] });
  await add("wax", { code: "P-WAX", name: "Wax print fabric (by the metre)", product_type: "BULK", negotiable_price: true, base_unit_id: units.M, department_id: depts.FASHION, category_id: cats.LOOSE, variants: [{ sku: "WAX-M", name: "Wax print fabric, per metre", retail_price: "2500", min_price: "2000", reorder_point: "12", reorder_qty: "36", is_shortcut: true }] });
  const cartonOf = (n: string) => ({ conversions: [{ unit_id: units.CTN, factor: n, is_purchase_default: true, is_sellable: true }] });
  await add("detergent", { code: "P-DETERG1L", name: "Liquid detergent 1 L", product_type: "STANDARD", department_id: depts.CLEAN, category_id: cats.DETERGENT, brand_id: brands["Propre+"], variants: [{ sku: "DTG-1L", name: "Liquid detergent 1 L", retail_price: "2200", wholesale_price: "1900", reorder_point: "24", reorder_qty: "48", preferred_supplier_id: suppliers["SUP-CLEAN"], is_shortcut: true, barcodes: [{ code: "6300000001001" }, { code: "6300000001012", unit_id: units.CTN }], ...cartonOf("12") }] });
  await add("powder", { code: "P-POWDER500", name: "Washing powder 500 g", product_type: "STANDARD", department_id: depts.CLEAN, category_id: cats.DETERGENT, brand_id: brands["Propre+"], variants: [{ sku: "PWD-500", name: "Washing powder 500 g", retail_price: "1200", wholesale_price: "1000", reorder_point: "48", reorder_qty: "96", preferred_supplier_id: suppliers["SUP-CLEAN"], barcodes: [{ code: "6300000002001" }, { code: "6300000002024", unit_id: units.CTN }], ...cartonOf("24") }] });
  await add("bleach", { code: "P-BLEACH1L", name: "Bleach 1 L", product_type: "STANDARD", department_id: depts.CLEAN, category_id: cats.DETERGENT, brand_id: brands["Propre+"], variants: [{ sku: "BLC-1L", name: "Bleach 1 L", retail_price: "900", reorder_point: "24", reorder_qty: "48", barcodes: [{ code: "6300000003001" }], ...cartonOf("12") }] });
  await add("dishwash", { code: "P-DISH750", name: "Dishwashing liquid 750 ml", product_type: "STANDARD", department_id: depts.CLEAN, category_id: cats.DETERGENT, brand_id: brands["Propre+"], variants: [{ sku: "DSH-750", name: "Dishwashing liquid 750 ml", retail_price: "1500", reorder_point: "20", reorder_qty: "40", barcodes: [{ code: "6300000004001" }], ...cartonOf("20") }] });
  await add("tissue", { code: "P-TISSUE10", name: "Toilet tissue 10 rolls", product_type: "STANDARD", department_id: depts.CLEAN, category_id: cats.HOUSEHOLD, variants: one("TIS-10", "Toilet tissue, 10 rolls", "2800") });
  await add("giftwrap", { code: "P-GIFTWRAP", name: "Gift wrapping service", product_type: "NON_STOCK", department_id: depts.PARTY, category_id: cats.SERVICES, variants: [{ sku: "SRV-GIFT", name: "Gift wrapping", retail_price: "1000", is_shortcut: true }] });
  const productCount = Object.keys(prods).length;
  const V = async (sku: string) => db.productVariant.findFirstOrThrow({ where: { business_id: B, sku } });
  log(`Catalogue: ${productCount} products, ${await db.productVariant.count({ where: { business_id: B } })} SKUs`);

  // Branch price for Bonapriso + scheduled wholesale prices
  const retailList = await db.priceList.findFirstOrThrow({ where: { business_id: B, code: "RETAIL" } });
  const bonaList = await db.priceList.create({ data: { business_id: B, code: "DLA2-RETAIL", name: "Bonapriso branch prices", kind: "RETAIL", branch_id: dla2.id } });
  await db.priceListItem.create({ data: { price_list_id: bonaList.id, variant_id: (await V("EBN-100")).id, price: D(37000), min_price: D(33000), effective_from: new Date(Date.now() - 86400_000), created_by_id: owner.userId } });
  await db.priceListItem.create({ data: { price_list_id: retailList.id, variant_id: (await V("LOT-400")).id, price: D(3300), effective_from: new Date(Date.now() - 86400_000), created_by_id: owner.userId } });

  // -------------------------------------------------------------- purchasing
  const purchasing = app.get(PurchasingService);
  const approvals = app.get(ApprovalsService);
  const cost: Record<string, string> = {
    "KET-17": "11000", "BLD-15": "19500", "PAN-28": "5200", "POT-SET5": "27000", "KNF-SET6": "7000", "BOX-6": "3300", "SPN-SET": "1200", "LOT-400": "1900", "SHEA-250": "2100",
    "EBN-50": "12500", "EBN-100": "20000", "WRI-100": "15500", "BPK-01": "7800", "WCH-M01": "24000", "WCH-L01": "16500", "SUN-01": "3500", "EAR-SET": "2000", "BBG-500": "2000",
    "BBT-01": "3500", "PTY-KIT": "8500", "BAL-50": "1400", "PLT-20": "700", "TIS-10": "1700",
  };
  const poAndReceive = async (branchId: string, supplier: string, lines: { sku: string; qty: string; cost: string; unit?: string }[], opts: { receiveFraction?: number; damaged?: Record<string, string>; batches?: Record<string, { batch: string; expiry: string }>; serialPrefix?: Record<string, string> } = {}) => {
    const resolved = await Promise.all(lines.map(async (l) => ({ ...l, v: await V(l.sku) })));
    const po = await purchasing.createPO(buyer, { branch_id: branchId, supplier_id: suppliers[supplier], payment_type: "CREDIT", lines: resolved.map((l) => ({ variant_id: l.v.id, unit_id: l.unit ? units[l.unit] : undefined, quantity: l.qty, unit_cost: l.cost })) });
    const submitted = await purchasing.submitPO(buyer, po.id, "Restock");
    if (submitted!.status === "SUBMITTED") await approvals.decide(owner, submitted!.approval_request_id!, "APPROVE", "Approved for restock");
    const full = await purchasing.getPO(owner, po.id);
    await purchasing.receive(keeper, {
      branch_id: branchId, purchase_order_id: po.id, supplier_reference: `DN-${po.number}`,
      lines: full.lines.map((l) => {
        const sku = l.sku!;
        const total = D(l.quantity).times(opts.receiveFraction ?? 1).toDecimalPlaces(0);
        const dmg = D(opts.damaged?.[sku] ?? 0);
        const serialCount = total.times(l.unit_factor).toNumber();
        return {
          purchase_order_line_id: l.id, variant_id: l.variant_id, qty_accepted: total.minus(dmg).toString(), qty_damaged: dmg.toString(),
          ...(opts.batches?.[sku] ? { batch_number: opts.batches[sku].batch, expiry_date: opts.batches[sku].expiry } : {}),
          ...(opts.serialPrefix?.[sku] ? { serial_numbers: Array.from({ length: serialCount }, (_, i) => `${opts.serialPrefix![sku]}-${po.number}-${String(i + 1).padStart(3, "0")}`) } : {}),
        };
      }),
    }, `seed-${po.number}`);
    return po;
  };
  const today = new Date();
  const ymd = (days: number) => new Date(today.getTime() + days * 86400_000).toISOString().slice(0, 10);

  // Warehouse bulk purchase (above approval threshold → owner approves)
  const poWh = await poAndReceive(wh1.id, "SUP-CLEAN", [
    { sku: "DTG-1L", qty: "20", cost: "18000", unit: "CTN" }, // 20 cartons × 12 = 240 pcs
    { sku: "PWD-500", qty: "10", cost: "19200", unit: "CTN" }, // 10 cartons × 24 = 240 pcs
    { sku: "BLC-1L", qty: "10", cost: "7200", unit: "CTN" },
    { sku: "DSH-750", qty: "5", cost: "20000", unit: "CTN" },
  ]);
  const fashionSkus = (await db.productVariant.findMany({ where: { business_id: B, OR: [{ sku: { startsWith: "DRS-" } }, { sku: { startsWith: "PLO-" } }, { sku: { startsWith: "SND-" } }, { sku: { startsWith: "OXF-" } }, { sku: { startsWith: "TOT-" } }, { sku: { startsWith: "LIP-" } }, { sku: { startsWith: "BDY-" } }, { sku: { startsWith: "BBS-" } }] } })).map((v) => v.sku);
  const fashionCost = (sku: string) => (sku.startsWith("DRS") ? "8500" : sku.startsWith("PLO") ? "4200" : sku.startsWith("SND") ? "6000" : sku.startsWith("OXF") ? "16000" : sku.startsWith("TOT") ? "13000" : sku.startsWith("LIP") ? "1100" : sku.startsWith("BDY") ? "3800" : "2600");
  for (const [branch, label] of [[dla1, "DLA1"], [dla2, "DLA2"]] as const) {
    await poAndReceive(branch.id, "SUP-HOME", ["KET-17", "BLD-15", "PAN-28", "POT-SET5", "KNF-SET6", "BOX-6", "SPN-SET", "BPK-01", "TIS-10", "PTY-KIT", "BAL-50", "PLT-20"].map((sku) => ({ sku, qty: sku.startsWith("KET") || sku.startsWith("BLD") ? "4" : sku === "POT-SET5" ? "3" : "12", cost: cost[sku] })), { serialPrefix: { "KET-17": `KET${label}`, "BLD-15": `BLD${label}` }, damaged: label === "DLA1" ? { "PAN-28": "1" } : {} });
    await poAndReceive(branch.id, "SUP-BEAUTY", ["LOT-400", "SHEA-250", "EBN-50", "EBN-100", "WRI-100", "BBG-500", "BBT-01", "EAR-SET", "SUN-01", "WCH-L01", "WCH-M01"].map((sku) => ({ sku, qty: sku.startsWith("WCH-M") ? "3" : sku.startsWith("EBN") || sku.startsWith("WRI") || sku.startsWith("WCH") ? "5" : "15", cost: cost[sku] })), {
      batches: { "SHEA-250": { batch: `SH-${label}-2611`, expiry: ymd(label === "DLA1" ? 20 : 300) }, "BBG-500": { batch: `BG-${label}-2701`, expiry: ymd(240) } },
      serialPrefix: { "WCH-M01": `WCH${label}` },
    });
    await poAndReceive(branch.id, "SUP-FASHION", fashionSkus.map((sku) => ({ sku, qty: "4", cost: fashionCost(sku) })), { receiveFraction: label === "DLA2" ? 0.5 : 1 });
  }
  await poAndReceive(dla1.id, "SUP-FASHION", [{ sku: "FRIP-TS", qty: "1", cost: "90000", unit: "BALE" }, { sku: "WAX-M", qty: "48", cost: "1500" }]); // 1 bale = 120 T-shirts; 48 m of fabric
  log("Purchasing: purchase orders approved and received (incl. carton conversions, damaged goods, batches, serials, a partial delivery, a bale of loose goods)");

  // Supplier invoice matched to the warehouse receipt (with a price difference) and a part payment
  const whReceipt = await db.goodsReceipt.findFirstOrThrow({ where: { purchase_order_id: poWh.id }, include: { lines: true } });
  const inv = await purchasing.postInvoice(buyer, {
    branch_id: wh1.id, supplier_id: suppliers["SUP-CLEAN"], supplier_invoice_no: "PI-2026-0457", invoice_date: ymd(0), due_date: ymd(30),
    lines: whReceipt.lines.map((l, i) => ({ goods_receipt_line_id: l.id, quantity_base: D(l.accepted_base).plus(l.damaged_base).toString(), base_unit_cost: i === 0 ? D(l.base_unit_cost).plus(25).toString() : l.base_unit_cost.toString() })),
  });
  const bank = await db.financialAccount.findFirstOrThrow({ where: { business_id: B, code: "BANK-MAIN" } });
  // Opening bank and safe balances (counterpart: opening balance equity)
  await db.$transaction(async (tx) => {
    const posting = app.get(AccountingService)["posting"];
    await posting.post(tx, { businessId: B, entryDate: ymd(0), sourceType: "opening_balance", description: "Opening bank and safe balances (demo)", createdById: owner.userId, currencyDecimals: 0, lines: [
      { accountId: bank.gl_account_id, debit: 5000000, financialAccountId: bank.id },
      ...(await tx.financialAccount.findMany({ where: { business_id: B, kind: "SAFE" } })).map((s) => ({ accountId: s.gl_account_id, debit: 150000, financialAccountId: s.id })),
      { account: "opening_equity" as const, credit: 5000000 + 150000 * 3 },
    ] });
  });
  await purchasing.paySupplier(accountant, { branch_id: wh1.id, supplier_id: suppliers["SUP-CLEAN"], financial_account_id: bank.id, amount: "300000", payment_date: ymd(0), reference: "TRF-DEMO-001", allocations: [{ supplier_invoice_id: inv.id, amount: "300000" }] });
  log(`Payables: supplier invoice ${inv.number} matched (with price variance) and part-paid`);

  // ---------------------------------------------------------------- transfers
  const inventory = app.get(InventoryService);
  const whStore = await db.location.findFirstOrThrow({ where: { branch_id: wh1.id, code: "STORE" } });
  const dla1Floor = await db.location.findFirstOrThrow({ where: { branch_id: dla1.id, code: "FLOOR" } });
  const dla2Floor = await db.location.findFirstOrThrow({ where: { branch_id: dla2.id, code: "FLOOR" } });
  const t1 = await inventory.createTransfer(keeper, { from_branch_id: wh1.id, from_location_id: whStore.id, to_branch_id: dla1.id, to_location_id: dla1Floor.id, lines: [{ variant_id: (await V("DTG-1L")).id, quantity: "48" }, { variant_id: (await V("PWD-500")).id, quantity: "72" }, { variant_id: (await V("BLC-1L")).id, quantity: "36" }, { variant_id: (await V("DSH-750")).id, quantity: "40" }] });
  await inventory.approveTransfer(managerAkwa, t1.id);
  await inventory.dispatchTransfer(keeper, t1.id);
  const t1d = await db.stockTransfer.findUniqueOrThrow({ where: { id: t1.id }, include: { lines: true } });
  await inventory.receiveTransfer(keeper, t1.id, { lines: t1d.lines.map((l, i) => ({ line_id: l.id, qty_received: i === 1 ? D(l.qty_dispatched).minus(2).toString() : l.qty_dispatched.toString(), qty_short: i === 1 ? "2" : "0", note: i === 1 ? "2 packs torn in transit" : undefined })), close: true });
  const t2 = await inventory.createTransfer(keeper, { from_branch_id: wh1.id, from_location_id: whStore.id, to_branch_id: dla2.id, to_location_id: dla2Floor.id, lines: [{ variant_id: (await V("DTG-1L")).id, quantity: "36" }, { variant_id: (await V("PWD-500")).id, quantity: "48" }] });
  await inventory.approveTransfer(managerAkwa, t2.id);
  await inventory.dispatchTransfer(keeper, t2.id);
  log("Transfers: one received with a documented shortage, one in transit");

  // ------------------------------------------------------------- customers
  const customers = app.get(CustomersService);
  await db.customerGroup.create({ data: { business_id: B, name: "Retail customers", price_list_kind: "RETAIL" } });
  const wholesaleGroup = await db.customerGroup.create({ data: { business_id: B, name: "Resellers (wholesale)", price_list_kind: "WHOLESALE" } });
  const cust = {
    hotel: await customers.create(owner, { name: "Hôtel Sawa Plage (demo)", phone: "+237 600 111 001", credit_status: "ACTIVE", credit_limit: "300000", payment_terms_days: 30 }),
    reseller: await customers.create(owner, { name: "Boutique Mama Ngono (demo)", phone: "+237 600 111 002", credit_status: "ACTIVE", credit_limit: "100000", payment_terms_days: 14, customer_group_id: wholesaleGroup.id }),
    a: await customers.create(cashierAkwa, { name: "Marie Fotso", phone: "+237 600 111 003" }),
    b: await customers.create(cashierAkwa, { name: "Jean-Pierre Ekane", phone: "+237 600 111 004" }),
    c: await customers.create(cashierBona, { name: "Aïcha Bello", phone: "+237 600 111 005" }),
    d: await customers.create(cashierBona, { name: "Kevin Tchami", phone: "+237 600 111 006" }),
  };

  // ------------------------------------------------------- cashier sessions
  const finance = app.get(FinanceService);
  const sales = app.get(SalesService);
  const s1 = await finance.openSession(cashierAkwa, { register_id: regs.r1.id, opening_float: "25000" });
  await finance.openSession(cashier2Akwa, { register_id: regs.r2.id, opening_float: "20000" });
  await finance.openSession(cashierBona, { register_id: regs.r3.id, opening_float: "25000" });
  let n = 0;
  const sell = async (who: AuthContext, branchId: string, registerId: string, items: { sku: string; qty: string; discount?: string; reason?: string; unit?: string; serial?: boolean }[], payments: (total: any) => any[], customerId?: string) => {
    const lines = [];
    for (const it of items) {
      const v = await V(it.sku);
      let serialId: string | undefined;
      if (it.serial) {
        const reg = await db.cashRegister.findUniqueOrThrow({ where: { id: registerId } });
        serialId = (await db.serialNumber.findFirstOrThrow({ where: { variant_id: v.id, status: "IN_STOCK", location_id: reg.location_id } })).id;
      }
      lines.push({ variant_id: v.id, quantity: it.qty, unit_id: it.unit ? units[it.unit] : undefined, discount_amount: it.discount, discount_reason: it.reason, serial_number_id: serialId });
    }
    // price preview: run checkout with exact payments computed from a dry total
    const preview = await previewTotal(who, branchId, lines, customerId);
    return sales.checkout(who, { branch_id: branchId, register_id: registerId, customer_id: customerId, lines, payments: payments(preview) }, `seed-sale-${++n}`);
  };
  const previewTotal = async (who: AuthContext, branchId: string, lines: any[], customerId?: string) => {
    const reg = (await db.cashierSession.findFirstOrThrow({ where: { user_id: who.userId, status: "OPEN" } })).register_id;
    return D((await sales.quote(who, { branch_id: branchId, register_id: reg, customer_id: customerId, lines })).total);
  };
  const cash = (extra = 0) => (t: any) => [{ method: "CASH", amount: t.toString(), amount_tendered: t.plus(extra).toString() }];
  await sell(cashierAkwa, dla1.id, regs.r1.id, [{ sku: "DTG-1L", qty: "2" }, { sku: "LOT-400", qty: "1" }, { sku: "SPN-SET", qty: "1" }], cash(1500), cust.a.id);
  await sell(cashierAkwa, dla1.id, regs.r1.id, [{ sku: "KET-17", qty: "1", serial: true }, { sku: "PAN-28", qty: "1" }], cash(2000));
  const confirmPending = async (sale: any, who: AuthContext, ref: string) => {
    for (const p of sale.payments.filter((x: any) => x.status === "PENDING")) await sales.confirmPayment(who, p.id, ref);
  };
  // mobile money: cashier initiates (simulator attempt), manager confirms manually with the wallet reference
  await confirmPending(await sell(cashierAkwa, dla1.id, regs.r1.id, [{ sku: "EBN-50", qty: "1" }], (t) => [{ method: "MOBILE_MONEY", amount: t.toString(), payer_phone: "+237600111003" }], cust.a.id), managerAkwa, "MOMO-DEMO-78345");
  // split payment: cash + card (card confirmed by the manager with the terminal approval code)
  await confirmPending(await sell(cashierAkwa, dla1.id, regs.r1.id, [{ sku: "DRS-MRED", qty: "1" }, { sku: "SND-38", qty: "1", discount: "1000", reason: "Loyal customer" }], (t) => [{ method: "CASH", amount: "10000", amount_tendered: "10000" }, { method: "CARD", amount: t.minus(10000).toString() }], cust.b.id), managerAkwa, "CARD-AUTH-552190");
  await sell(cashierAkwa, dla1.id, regs.r1.id, [{ sku: "PWD-500", qty: "1", unit: "CTN" }], cash(0), cust.reseller.id); // carton sale (24 pcs) at wholesale price
  await sell(cashierAkwa, dla1.id, regs.r1.id, [{ sku: "SHEA-250", qty: "2" }, { sku: "BBG-500", qty: "1" }, { sku: "SRV-GIFT", qty: "1" }], cash(500));
  await sell(cashier2Akwa, dla1.id, regs.r2.id, [{ sku: "WCH-M01", qty: "1", serial: true }], cash(0));
  await sell(cashier2Akwa, dla1.id, regs.r2.id, [{ sku: "BAL-50", qty: "3" }, { sku: "PLT-20", qty: "4" }, { sku: "PTY-KIT", qty: "1" }], cash(1000));
  // cashiers lack pos.credit_sale by default → the manager rings the credit sale on their own session
  const sm = await finance.openSession(managerAkwa, { register_id: (await db.$transaction((tx) => createRegister(tx, B, dla1.id, "R9", "Manager till"))).id, opening_float: "30000" });
  await sell(managerAkwa, dla1.id, sm.register_id, [{ sku: "TIS-10", qty: "6" }, { sku: "DSH-750", qty: "6" }, { sku: "BLC-1L", qty: "6" }], (t) => [{ method: "CUSTOMER_CREDIT", amount: t.toString() }], cust.hotel.id);
  await sell(cashierBona, dla2.id, regs.r3.id, [{ sku: "EBN-100", qty: "1" }], cash(3000), cust.c.id); // branch-specific price applies
  await sell(cashierBona, dla2.id, regs.r3.id, [{ sku: "BDY-03M", qty: "2" }, { sku: "BBT-01", qty: "1" }], cash(0), cust.d.id);
  await confirmPending(await sell(cashierBona, dla2.id, regs.r3.id, [{ sku: "BLD-15", qty: "1", serial: true }], (t) => [{ method: "BANK_TRANSFER", amount: t.toString() }]), managerBona, "BT-DEMO-2026-11");
  // a sale awaiting mobile money confirmation (simulator) — left pending for the demo
  const pending = await sales.checkout(cashierBona, { branch_id: dla2.id, register_id: regs.r3.id, lines: [{ variant_id: (await V("LOT-400")).id, quantity: "2" }], payments: [{ method: "MOBILE_MONEY", amount: (await previewTotal(cashierBona, dla2.id, [{ variant_id: (await V("LOT-400")).id, quantity: "2" }])).toString(), payer_phone: "+237600111006" }] }, "seed-pending-momo");
  log(`Sales: ${n} completed sales (cash, mobile money, card, bank transfer, split, credit, carton) and 1 awaiting mobile-money confirmation (${pending.number})`);

  // return (partial) on the first Akwa sale, refunded in cash
  const firstSale = await db.sale.findFirstOrThrow({ where: { business_id: B, cashier_id: cashierAkwa.userId, status: "COMPLETED" }, orderBy: { created_at: "asc" }, include: { lines: true } });
  await sales.returnSale(managerAkwa, { sale_id: firstSale.id, register_id: sm.register_id, reason: "Customer changed mind", refund_method: "CASH", lines: [{ sale_line_id: firstSale.lines[0].id, quantity: "1", condition: "SELLABLE" }] }, "seed-return-1");
  const kettleSale = await db.sale.findFirstOrThrow({ where: { business_id: B, lines: { some: { sku: "KET-17" } } }, include: { lines: true } });
  await sales.returnSale(managerAkwa, { sale_id: kettleSale.id, register_id: sm.register_id, reason: "Does not heat — defective", refund_method: "CASH", lines: [{ sale_line_id: kettleSale.lines.find((l) => l.sku === "KET-17")!.id, quantity: "1", condition: "SUPPLIER_RETURN_PENDING", inspection_notes: "Element faulty; return to supplier under warranty" }] }, "seed-return-2");
  log("Returns: a sellable partial return and a defective item quarantined for supplier return");

  // customer account payment (partial)
  const hotelSale = await db.sale.findFirstOrThrow({ where: { customer_id: cust.hotel.id, status: "COMPLETED" } });
  await customers.receivePayment(accountant, cust.hotel.id, { branch_id: dla1.id, financial_account_id: bank.id, amount: "20000", reference: "HOTEL-CHQ-1102", allocations: [{ sale_id: hotelSale.id, amount: "15000" }] });

  // ------------------------------------------------------- cash management
  await finance.cashMovement(cashierAkwa, s1.id, { kind: "CASH_DROP", amount: "20000", reason: "Mid-day drop to safe" });
  const sum1 = await finance.getSession(cashierAkwa, s1.id);
  const shortBy = 500;
  await finance.closeSession(cashierAkwa, s1.id, { counted_cash: D(sum1.expected_cash).minus(shortBy).toString(), variance_reason: "Short 500 — suspected change error", denominations: { "10000": 2, "5000": 1 } });
  await finance.closeSession(managerAkwa, sm.id, { counted_cash: (await finance.getSession(managerAkwa, sm.id)).expected_cash.toString() });
  log("Cashier sessions: Akwa till 1 closed with a 500 shortage; Akwa till 2 and Bonapriso till 1 left open");

  // ---------------------------------------------------- expenses & adjustments
  const catId = async (name: string) => (await db.expenseCategory.findFirstOrThrow({ where: { business_id: B, name } })).id;
  await finance.createExpense(accountant, { branch_id: dla1.id, expense_date: ymd(0), payee: "Immobilière Akwa (demo landlord)", financial_account_id: bank.id, reference: "RENT-NOV", lines: [{ expense_category_id: await catId("Rent"), description: "Akwa store rent — November", amount: "250000" }] });
  await finance.createExpense(accountant, { branch_id: dla2.id, expense_date: ymd(0), payee: "Electricity utility (demo)", financial_account_id: bank.id, reference: "ELEC-1022", lines: [{ expense_category_id: await catId("Electricity and water"), description: "Bonapriso electricity", amount: "48500" }] });
  const dmgLoc = await db.location.findFirstOrThrow({ where: { branch_id: dla1.id, code: "DMG" } });
  const adjReq = await approvals.request(keeper, { type: "STOCK_ADJUSTMENT", reason: "Write off pan damaged on delivery", amount: "6000", branchId: dla1.id });
  await approvals.decide(managerAkwa, adjReq.id, "APPROVE", "Confirmed damaged beyond repair");
  await inventory.adjust(keeper, { branch_id: dla1.id, reason_code: "DAMAGE", reason: "Pan received damaged — beyond repair", approval_request_id: adjReq.id, lines: [{ variant_id: (await V("PAN-28")).id, location_id: dmgLoc.id, quantity: "-1" }] });
  // physical count at Bonapriso floor (small variance)
  const count = await inventory.startCount(keeper, { branch_id: dla2.id, location_id: dla2Floor.id, variant_ids: [(await V("TIS-10")).id, (await V("BAL-50")).id] });
  await inventory.recordCount(keeper, count.id, count.lines.map((l) => ({ variant_id: l.variant_id, counted_qty: D(l.system_qty).minus(l.variant_id === count.lines[0].variant_id ? 1 : 0).toString() })));
  const submitted = await inventory.submitCount(keeper, count.id);
  if (submitted!.status === "SUBMITTED") await approvals.decide(managerBona, submitted!.approval_request_id!, "APPROVE", "Variance accepted");
  await inventory.postCount(keeper, count.id);
  log("Expenses posted; damaged stock written off (approved); physical count posted");

  const recon = await app.get(AccountingService).reconciliation(owner);
  await db.userSession.updateMany({ where: { user_agent: "demo-seed" }, data: { revoked_at: new Date(), revoked_reason: "seed complete" } });
  return { business, recon };
}

async function main() {
  if (config.isProduction) { console.error("Refusing to seed demo data in production."); process.exit(1); }
  if (process.argv.includes("--reset")) {
    const { migrate } = require("../../../../packages/db/tools/migrate");
    await migrate(process.env.DATABASE_URL!, { reset: true });
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
  try {
    const { recon } = await runDemoSeed(app);
    console.log("\nReconciliation after seeding:");
    for (const c of recon.checks) console.log(`  ${c.ok ? "OK  " : "FAIL"} ${c.name}: subledger ${c.subledger} / ledger ${c.ledger}`);
    console.log(`\nDemo users (password for all: ${DEMO_PASSWORD}) — DEMO ONLY:`);
    console.log("  owner@mboa.demo, manager.akwa@mboa.demo, cashier.akwa@mboa.demo, cashier2.akwa@mboa.demo, manager.bonapriso@mboa.demo,");
    console.log("  cashier.bonapriso@mboa.demo, buyer@mboa.demo, storekeeper@mboa.demo, accountant@mboa.demo, admin@mboa.demo, auditor@mboa.demo");
    if (recon.checks.some((c) => !c.ok)) process.exitCode = 2;
  } finally {
    await app.close();
  }
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
