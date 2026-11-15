/**
 * Starter catalogue for a neighbourhood mini-supermarket: common categories and
 * everyday products, so a new shop can load them and then just edit names,
 * prices and pack sizes and add what is missing.
 *
 * Prices are deliberately left empty — every shop sets its own. Products
 * without a price are flagged "Price not set" and cannot be sold until a price
 * is entered (in Products, or by re-importing the downloaded spreadsheet).
 */
export const STARTER_COLUMNS = ["Category", "Name", "Unit", "Type", "Selling price", "Minimum price", "Bargain", "Barcode", "Reorder point"] as const;

type Item = [category: string, name: string, unit?: string, type?: "bulk", reorder?: number];

const ITEMS: Item[] = [
  // Food staples
  ["Food staples > Rice & grains", "Rice, long grain 5 kg", "BAG", undefined, 5],
  ["Food staples > Rice & grains", "Rice, long grain 25 kg", "BAG", undefined, 2],
  ["Food staples > Rice & grains", "Rice, perfumed 5 kg", "BAG", undefined, 5],
  ["Food staples > Rice & grains", "Maize flour 1 kg", "PCS", undefined, 10],
  ["Food staples > Rice & grains", "Semolina 1 kg", "PCS", undefined, 6],
  ["Food staples > Flour & pasta", "Wheat flour 1 kg", "PCS", undefined, 10],
  ["Food staples > Flour & pasta", "Spaghetti 500 g", "PCS", undefined, 24],
  ["Food staples > Flour & pasta", "Macaroni 500 g", "PCS", undefined, 24],
  ["Food staples > Flour & pasta", "Instant noodles (pack)", "PCS", undefined, 40],
  ["Food staples > Oil & fats", "Vegetable oil 1 L", "PCS", undefined, 12],
  ["Food staples > Oil & fats", "Vegetable oil 5 L", "PCS", undefined, 4],
  ["Food staples > Oil & fats", "Margarine 250 g", "PCS", undefined, 12],
  ["Food staples > Sugar & salt", "Sugar, granulated 1 kg", "PCS", undefined, 20],
  ["Food staples > Sugar & salt", "Sugar cubes 1 kg box", "PCS", undefined, 10],
  ["Food staples > Sugar & salt", "Salt 1 kg", "PCS", undefined, 12],
  // Canned & packaged
  ["Canned & packaged food", "Tomato paste 70 g", "PCS", undefined, 48],
  ["Canned & packaged food", "Tomato paste 400 g", "PCS", undefined, 12],
  ["Canned & packaged food", "Sardines in oil 125 g", "PCS", undefined, 24],
  ["Canned & packaged food", "Corned beef 340 g", "PCS", undefined, 12],
  ["Canned & packaged food", "Sweet corn 340 g", "PCS", undefined, 12],
  ["Canned & packaged food", "Green peas 400 g", "PCS", undefined, 12],
  ["Canned & packaged food", "Baked beans 400 g", "PCS", undefined, 12],
  // Spices & seasonings
  ["Spices & seasonings", "Seasoning cubes (box)", "PCS", undefined, 20],
  ["Spices & seasonings", "Seasoning cubes (single)", "PCS", undefined, 200],
  ["Spices & seasonings", "Black pepper, ground 50 g", "PCS", undefined, 10],
  ["Spices & seasonings", "Curry powder 50 g", "PCS", undefined, 10],
  ["Spices & seasonings", "Mayonnaise 450 ml", "PCS", undefined, 6],
  ["Spices & seasonings", "Ketchup 500 g", "PCS", undefined, 6],
  ["Spices & seasonings", "Mustard 370 g", "PCS", undefined, 6],
  ["Spices & seasonings", "Vinegar 1 L", "PCS", undefined, 6],
  // Breakfast
  ["Breakfast > Milk", "Powdered milk 400 g tin", "PCS", undefined, 12],
  ["Breakfast > Milk", "Powdered milk sachet 25 g", "PCS", undefined, 100],
  ["Breakfast > Milk", "Sweetened condensed milk 397 g", "PCS", undefined, 24],
  ["Breakfast > Milk", "Evaporated milk 410 g", "PCS", undefined, 24],
  ["Breakfast > Hot drinks", "Chocolate drink powder 400 g", "PCS", undefined, 12],
  ["Breakfast > Hot drinks", "Instant coffee 100 g", "PCS", undefined, 6],
  ["Breakfast > Hot drinks", "Tea bags (box of 25)", "PCS", undefined, 12],
  ["Breakfast > Spreads & cereals", "Chocolate spread 400 g", "PCS", undefined, 6],
  ["Breakfast > Spreads & cereals", "Jam 370 g", "PCS", undefined, 6],
  ["Breakfast > Spreads & cereals", "Corn flakes 375 g", "PCS", undefined, 6],
  ["Breakfast > Bread", "Bread loaf", "PCS", undefined, 20],
  // Dairy & eggs
  ["Dairy & eggs", "Eggs (tray of 30)", "PCS", undefined, 5],
  ["Dairy & eggs", "Eggs (single)", "PCS", undefined, 30],
  ["Dairy & eggs", "Yoghurt 500 ml", "PCS", undefined, 12],
  ["Dairy & eggs", "Butter 250 g", "PCS", undefined, 6],
  ["Dairy & eggs", "Processed cheese portions (box)", "PCS", undefined, 12],
  // Beverages
  ["Beverages > Water", "Mineral water 1.5 L", "PCS", undefined, 24],
  ["Beverages > Water", "Mineral water 0.5 L", "PCS", undefined, 24],
  ["Beverages > Water", "Mineral water 1.5 L (pack of 6)", "PCS", undefined, 6],
  ["Beverages > Soft drinks & juices", "Soft drink 33 cl can", "PCS", undefined, 24],
  ["Beverages > Soft drinks & juices", "Soft drink 1.5 L bottle", "PCS", undefined, 12],
  ["Beverages > Soft drinks & juices", "Soft drink 60 cl bottle", "PCS", undefined, 24],
  ["Beverages > Soft drinks & juices", "Fruit juice 1 L", "PCS", undefined, 12],
  ["Beverages > Soft drinks & juices", "Energy drink 25 cl", "PCS", undefined, 24],
  ["Beverages > Soft drinks & juices", "Malt drink 33 cl", "PCS", undefined, 24],
  ["Beverages > Beer & wine", "Beer 65 cl bottle", "PCS", undefined, 24],
  ["Beverages > Beer & wine", "Beer 33 cl can", "PCS", undefined, 24],
  ["Beverages > Beer & wine", "Red wine 75 cl", "PCS", undefined, 6],
  ["Beverages > Beer & wine", "Whisky sachet", "PCS", undefined, 50],
  // Snacks
  ["Snacks & biscuits", "Biscuits (pack)", "PCS", undefined, 48],
  ["Snacks & biscuits", "Cream biscuits (pack)", "PCS", undefined, 48],
  ["Snacks & biscuits", "Crisps 50 g", "PCS", undefined, 24],
  ["Snacks & biscuits", "Roasted groundnuts (pack)", "PCS", undefined, 24],
  ["Snacks & biscuits", "Sweets / candy (single)", "PCS", undefined, 200],
  ["Snacks & biscuits", "Chewing gum", "PCS", undefined, 100],
  ["Snacks & biscuits", "Chocolate bar", "PCS", undefined, 24],
  // Baby care
  ["Baby care", "Baby diapers, size 3 (pack)", "PCS", undefined, 6],
  ["Baby care", "Baby diapers, size 4 (pack)", "PCS", undefined, 6],
  ["Baby care", "Baby wipes (pack)", "PCS", undefined, 12],
  ["Baby care", "Infant milk formula 400 g", "PCS", undefined, 6],
  ["Baby care", "Baby cereal 400 g", "PCS", undefined, 6],
  ["Baby care", "Baby lotion 200 ml", "PCS", undefined, 6],
  // Personal care
  ["Personal care > Soap & bath", "Bath soap bar", "PCS", undefined, 48],
  ["Personal care > Soap & bath", "Shower gel 250 ml", "PCS", undefined, 6],
  ["Personal care > Soap & bath", "Deodorant spray", "PCS", undefined, 6],
  ["Personal care > Oral care", "Toothpaste 75 ml", "PCS", undefined, 24],
  ["Personal care > Oral care", "Toothbrush", "PCS", undefined, 24],
  ["Personal care > Hair & body", "Body lotion 400 ml", "PCS", undefined, 6],
  ["Personal care > Hair & body", "Petroleum jelly 250 ml", "PCS", undefined, 12],
  ["Personal care > Hair & body", "Hair pomade", "PCS", undefined, 6],
  ["Personal care > Hair & body", "Shampoo 400 ml", "PCS", undefined, 6],
  ["Personal care > Hair & body", "Razor blades (pack)", "PCS", undefined, 12],
  ["Personal care > Hair & body", "Sanitary pads (pack)", "PCS", undefined, 24],
  // Household
  ["Household > Laundry", "Washing powder 500 g", "PCS", undefined, 24],
  ["Household > Laundry", "Washing powder 1 kg", "PCS", undefined, 12],
  ["Household > Laundry", "Laundry soap bar", "PCS", undefined, 48],
  ["Household > Laundry", "Bleach 1 L", "PCS", undefined, 12],
  ["Household > Cleaning", "Dishwashing liquid 750 ml", "PCS", undefined, 12],
  ["Household > Cleaning", "Floor cleaner 1 L", "PCS", undefined, 6],
  ["Household > Cleaning", "Insecticide spray", "PCS", undefined, 12],
  ["Household > Cleaning", "Mosquito coils (box)", "PCS", undefined, 24],
  ["Household > Paper & disposables", "Toilet paper (single roll)", "PCS", undefined, 48],
  ["Household > Paper & disposables", "Toilet paper (pack of 4)", "PCS", undefined, 12],
  ["Household > Paper & disposables", "Paper napkins (pack)", "PCS", undefined, 12],
  ["Household > Paper & disposables", "Aluminium foil", "PCS", undefined, 6],
  ["Household > Kitchen & home", "Matches (pack of 10 boxes)", "PCS", undefined, 12],
  ["Household > Kitchen & home", "Candles (pack)", "PCS", undefined, 12],
  ["Household > Kitchen & home", "Batteries AA (pack of 2)", "PCS", undefined, 24],
  ["Household > Kitchen & home", "LED bulb", "PCS", undefined, 12],
  ["Household > Kitchen & home", "Rechargeable torch", "PCS", undefined, 4],
  // Bulk & loose goods — sold by weight/volume, price can be bargained (set a minimum)
  ["Bulk & loose goods", "Rice (loose)", "KG", "bulk", 25],
  ["Bulk & loose goods", "Beans (loose)", "KG", "bulk", 10],
  ["Bulk & loose goods", "Groundnuts (loose)", "KG", "bulk", 10],
  ["Bulk & loose goods", "Garri (loose)", "KG", "bulk", 10],
  ["Bulk & loose goods", "Sugar (loose)", "KG", "bulk", 10],
  ["Bulk & loose goods", "Palm oil (loose)", "L", "bulk", 10],
  ["Bulk & loose goods", "Dried fish (loose)", "KG", "bulk", 5],
  ["Bulk & loose goods", "Onions (loose)", "KG", "bulk", 10],
];

/** Rows keyed by the template's column headers (as the import screen expects). */
export function starterRows(): Record<string, string>[] {
  return ITEMS.map(([category, name, unit, type, reorder]) => ({
    Category: category, Name: name, Unit: unit ?? "PCS", Type: type === "bulk" ? "bulk" : "standard",
    "Selling price": "", "Minimum price": "", Bargain: "", Barcode: "", "Reorder point": reorder != null ? String(reorder) : "",
  }));
}
