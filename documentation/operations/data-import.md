# Importing and exporting data (Excel / CSV)

Screen: **Import & export** (permission `data.import`, Owner by default; each import also needs the normal permission for what it changes). Files are read in the browser (`.xlsx` first sheet, or `.csv` with comma or semicolon) and sent to the API as rows.

**Safety rules**
- Every file is checked in full first (dry run). Each row shows *New*, *Update* or *Error*, plus warnings.
- If any row has an error, **nothing** is imported. A clean file is imported in one database transaction (opening stock is posted right after, as one document).
- Headers are matched without case, accents or punctuation, in English or French (e.g. *Nom*, *Catégorie*, *Prix de vente*, *Téléphone*, *Quantité*, *Coût unitaire*). Numbers accept `1 500`, `1,500`, `1.500,50`; dates accept `YYYY-MM-DD`, `DD/MM/YYYY` and Excel dates.
- At most 5,000 rows per file.

| Import | Matching existing records | Notes |
|---|---|---|
| Products & categories (`POST /imports/products`) | SKU, then barcode, then exact name (single-SKU products) | Categories use `Parent > Child` paths and are created when missing; missing units and brands are created. Type and unit of an existing product are not changed. Empty selling price → product created with price 0, flagged *Price not set*, and refused at the POS (`PRICE_NOT_SET`) until a price is entered. Minimum price / bargaining need `prices.manage`. Optional *Quantity* + *Unit cost* columns post opening stock when a branch is chosen. |
| Opening stock (`POST /imports/stock`) | SKU, barcode or unique exact name | Adds the quantities at the branch's sales floor at the given unit cost: Dr Inventory / Cr Opening balance equity, document `OPN-…`. Batch number required for batch-tracked items; serial-numbered items must be received through purchasing. |
| Customers (`POST /imports/customers`) | Phone number (digits, ignoring +237), then exact name when no phone | Group must exist. Credit limits need `customers.credit`; a limit above zero activates credit. |

**Export / edit / re-import:** *Download current products* (`GET /imports/products/export`) and *Download current customers* (`GET /imports/customers/export`) produce files in the import format — edit them in Excel and import them back to update in bulk.

**Starter catalogue:** about 108 common mini-supermarket products in 24 categories (staples, drinks, dairy, personal care, household, baby, bulk goods), with prices left empty. Load it directly or download it, adjust it and import it. It is a convenience list only — product names and pack sizes are generic and should be adapted to the shop.
