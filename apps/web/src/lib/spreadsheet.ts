/**
 * Reading and writing spreadsheets in the browser (Excel .xlsx and CSV).
 * Libraries are loaded on demand so they don't weigh on the rest of the app.
 */
export type SheetRow = Record<string, string>;

const cellText = (v: unknown): string => {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  return String(v).trim();
};

/** Reads the first sheet of an .xlsx file, or a .csv file (comma or semicolon), into rows keyed by the header row. */
export async function readRows(file: File): Promise<SheetRow[]> {
  const name = file.name.toLowerCase();
  let table: unknown[][];
  if (name.endsWith(".csv") || name.endsWith(".txt")) {
    const Papa = (await import("papaparse")).default;
    const text = (await file.text()).replace(/^\uFEFF/, "");
    table = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" }).data;
  } else if (name.endsWith(".xlsx")) {
    const { readSheet } = await import("read-excel-file/browser");
    table = (await readSheet(file)) as unknown[][];
  } else {
    throw new Error("Choose an Excel (.xlsx) or CSV file. Older .xls files: open them in Excel and save as .xlsx.");
  }
  const headerIndex = table.findIndex((r) => r.some((c) => cellText(c) !== ""));
  if (headerIndex < 0) return [];
  const headers = table[headerIndex].map(cellText);
  return table.slice(headerIndex + 1)
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, cellText(r[i])]).filter(([h]) => h)) as SheetRow)
    .filter((r) => Object.values(r).some((v) => v !== ""));
}

/** Downloads an .xlsx file: a data sheet with bold headers and an optional instructions sheet. */
export async function downloadXlsx(fileName: string, columns: string[], rows: Record<string, string | number | null | undefined>[], instructions?: [string, string][]) {
  const writeXlsxFile = (await import("write-excel-file/browser")).default;
  const header = columns.map((c) => ({ value: c, fontWeight: "bold" as const }));
  const data = [header, ...rows.map((r) => columns.map((c) => ({ value: r[c] == null ? "" : String(r[c]), type: String })))];
  const sheets: any[] = [{ data, sheet: "Data", columns: columns.map((c) => ({ width: Math.max(12, Math.min(40, c.length + 4, ...rows.slice(0, 200).map((r) => String(r[c] ?? "").length + 2))) })) }];
  if (instructions) sheets.push({ sheet: "Instructions", data: [[{ value: "Column", fontWeight: "bold" }, { value: "What to enter", fontWeight: "bold" }], ...instructions.map(([a, b]) => [{ value: a, type: String }, { value: b, type: String }])], columns: [{ width: 22 }, { width: 90 }] });
  const blob = await writeXlsxFile(sheets).toBlob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = fileName; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
