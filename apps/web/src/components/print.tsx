import { Printer } from "lucide-react";
import { ReactNode } from "react";
import { dateTime } from "../lib/format";
import { useSession } from "../lib/session";
import { Button } from "./ui";

/**
 * Printing: the element to print is copied into #print-root (outside the app), the
 * app is hidden for the duration of the print, and the copy is removed afterwards.
 * Receipts print on 80 mm paper; reports print on A4 with a business header.
 */
export function printElement(el: Element | null, kind: "receipt" | "report") {
  if (!el) return;
  let root = document.getElementById("print-root");
  if (!root) { root = document.createElement("div"); root.id = "print-root"; document.body.appendChild(root); }
  root.className = kind === "receipt" ? "print-receipt" : "print-report";
  root.innerHTML = "";
  root.appendChild(el.cloneNode(true));
  // inputs/selects keep their current values in the copy
  root.querySelectorAll("input, select, textarea").forEach((n) => n.remove());
  document.body.classList.add("printing");
  const done = () => { document.body.classList.remove("printing"); if (root) root.innerHTML = ""; window.removeEventListener("afterprint", done); };
  window.addEventListener("afterprint", done);
  window.print();
  setTimeout(done, 500);
}

/** Prints the receipt shown on the page (the element with class print-area). */
export const printReceipt = (scope?: Element | null) => printElement((scope ?? document).querySelector(".print-area"), "receipt");

/**
 * Wraps a report so it can be printed: on paper it gets the business name, the
 * report title, the period and who printed it when.
 */
export function PrintSheet({ id, title, subtitle, children }: { id: string; title: string; subtitle?: ReactNode; children: ReactNode }) {
  const { me, branchId } = useSession();
  const branch = me?.branches.find((b) => b.id === branchId);
  return (
    <div id={id} className="report-sheet">
      <div className="print-only mb-3 border-b border-black pb-2">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-base font-bold">{me?.business.name}</div>
            {branch && <div className="text-xs">{branch.code} — {branch.name}</div>}
          </div>
          <div className="text-right text-xs">Printed {dateTime(new Date().toISOString())}<br />by {me?.user.full_name}</div>
        </div>
        <div className="mt-2 text-lg font-semibold">{title}</div>
        {subtitle && <div className="text-xs">{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

export function PrintButton({ target, label = "Print", size }: { target: string; label?: string; size?: "sm" }) {
  return <Button variant="secondary" size={size} icon={<Printer className="h-4 w-4" />} onClick={() => printElement(document.getElementById(target), "report")}>{label}</Button>;
}
