/**
 * A few example customers and suppliers so a new shop can see how things work.
 * They are marked "(sample)" — rename them into real contacts, or delete them:
 * contacts that have never been used in a sale, order or payment can be deleted.
 * Phone numbers are deliberately left empty (no real numbers are invented).
 */
export const SAMPLE_CUSTOMERS: Record<string, string>[] = [
  { Name: "Walk-in regular — Mama Ngo (sample)", Phone: "", Email: "", Address: "Akwa, Douala", "Credit limit": "", "Payment terms (days)": "" },
  { Name: "Boutique du Quartier (sample)", Phone: "", Email: "", Address: "Bonamoussadi, Douala", "Credit limit": "100000", "Payment terms (days)": "14" },
  { Name: "Snack Bar Le Carrefour (sample)", Phone: "", Email: "", Address: "Deido, Douala", "Credit limit": "50000", "Payment terms (days)": "7" },
  { Name: "École Les Petits Génies (sample)", Phone: "", Email: "", Address: "Bonapriso, Douala", "Credit limit": "200000", "Payment terms (days)": "30" },
  { Name: "Monsieur Fotso (sample)", Phone: "", Email: "", Address: "Makepe, Douala", "Credit limit": "", "Payment terms (days)": "" },
  { Name: "Restaurant Chez Tantine (sample)", Phone: "", Email: "", Address: "Bali, Douala", "Credit limit": "75000", "Payment terms (days)": "14" },
];

export const SAMPLE_SUPPLIERS: Record<string, string>[] = [
  { Code: "SUP-FOOD", Name: "Food staples wholesaler (sample)", Contact: "", Phone: "", Email: "", Address: "Marché Central, Douala", "Tax ID": "", "Payment terms (days)": "0" },
  { Code: "SUP-DRINKS", Name: "Beverage distributor (sample)", Contact: "", Phone: "", Email: "", Address: "Bassa, Douala", "Tax ID": "", "Payment terms (days)": "7" },
  { Code: "SUP-DAIRY", Name: "Milk & dairy importer (sample)", Contact: "", Phone: "", Email: "", Address: "Port of Douala", "Tax ID": "", "Payment terms (days)": "14" },
  { Code: "SUP-HYGIENE", Name: "Soap & hygiene products (sample)", Contact: "", Phone: "", Email: "", Address: "Akwa Nord, Douala", "Tax ID": "", "Payment terms (days)": "30" },
  { Code: "SUP-HOUSEHOLD", Name: "Household goods trader (sample)", Contact: "", Phone: "", Email: "", Address: "Marché Mboppi, Douala", "Tax ID": "", "Payment terms (days)": "0" },
];
