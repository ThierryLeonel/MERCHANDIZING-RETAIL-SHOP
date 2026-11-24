import { ImagePlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Badge, Button, ErrorText, Modal, Select } from "../../components/ui";
import { api } from "../../lib/api";
import { useApi } from "../../lib/hooks";

interface P { id: string; code: string; name: string; has_photo: boolean; skus: string[] }
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

/** Matches a photo file name ("HOME-001.jpg", "Hand Fans.png") to a product by code/SKU, then by name. */
export function matchProduct(file: string, products: P[]): P | undefined {
  const stem = file.replace(/\.[^.]+$/, "");
  const key = norm(stem);
  return products.find((p) => norm(p.code) === key || p.skus.some((s) => norm(s) === key)) ?? products.find((p) => norm(p.name) === key);
}

/** Shrinks big phone photos to at most 1000 px (JPEG) before upload; falls back to the original file. */
async function shrink(file: File): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1000 / Math.max(bmp.width, bmp.height));
    if (k === 1 && file.size < 400_000) return file;
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise<Blob>((res) => c.toBlob((b) => res(b ?? file), "image/jpeg", 0.85));
  } catch { return file; }
}

/** Upload many product photos at once; each file is matched to a product by its name (adjustable before upload). */
export function PhotoUpload({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const idx = useApi<P[]>("/catalogue/product-index");
  const [files, setFiles] = useState<{ file: File; product: string; touched?: boolean; status?: "done" | "error"; error?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const products = useMemo(() => idx.data ?? [], [idx.data]);
  // files chosen before the product list arrived are matched as soon as it does (manual choices are kept)
  useEffect(() => { if (products.length) setFiles((fs) => fs.map((f) => (f.product || f.touched ? f : { ...f, product: matchProduct(f.file.name, products)?.id ?? "" }))); }, [products]);
  const pick = (list: FileList | null) => {
    if (!list) return;
    setFiles(Array.from(list).filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp)$/i.test(f.name)).map((f) => ({ file: f, product: matchProduct(f.name, products)?.id ?? "" })));
  };
  const ready = files.filter((f) => f.product && f.status !== "done");
  const upload = async () => {
    setBusy(true); setErr(null);
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!f.product || f.status === "done") continue;
      try {
        const fd = new FormData();
        fd.append("file", await shrink(f.file), f.file.name.replace(/\.[^.]+$/, ".jpg"));
        await api(`/attachments?owner_type=product&owner_id=${f.product}`, { body: fd });
        setFiles((fs) => fs.map((x, j) => (j === i ? { ...x, status: "done" } : x)));
      } catch (e) {
        setFiles((fs) => fs.map((x, j) => (j === i ? { ...x, status: "error", error: (e as Error).message } : x)));
      }
    }
    setBusy(false);
    onDone();
  };
  const done = files.filter((f) => f.status === "done").length;
  return (
    <Modal open onClose={onClose} size="lg" title="Upload product photos"
      footer={<><Button variant="secondary" onClick={onClose}>{done ? "Close" : "Cancel"}</Button><Button icon={<ImagePlus className="h-4 w-4" />} loading={busy} disabled={!ready.length} onClick={upload}>Upload {ready.length || ""} photo{ready.length === 1 ? "" : "s"}</Button></>}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">Take photos of your products and name each file after the product code (for example <code>HOME-001.jpg</code>) or the product name (<code>Hand Fans.jpg</code>). Select them all at once — each is matched to its product; change any match below. JPEG, PNG or WebP; large photos are resized automatically. A new photo replaces the product's picture.</p>
        <input type="file" multiple accept="image/jpeg,image/png,image/webp" aria-label="Choose photos" disabled={!idx.data || busy} onChange={(e) => pick(e.target.files)} className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:font-medium file:text-brand-800 hover:file:bg-brand-100" />
        {files.length > 0 && (
          <div className="max-h-[50dvh] divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
            {files.map((f, i) => (
              <div key={`${f.file.name}-${i}`} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate" title={f.file.name}>{f.file.name}</span>
                <Select aria-label={`Product for ${f.file.name}`} className="h-9 w-full sm:w-72" value={f.product} disabled={busy || f.status === "done"} onChange={(e) => setFiles((fs) => fs.map((x, j) => (j === i ? { ...x, product: e.target.value, touched: true } : x)))}>
                  <option value="">— not matched (skip) —</option>
                  {products.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.code}){p.has_photo ? " · has photo" : ""}</option>)}
                </Select>
                {f.status === "done" ? <Badge tone="green">Uploaded</Badge> : f.status === "error" ? <Badge tone="red">{f.error ?? "Failed"}</Badge> : f.product ? <Badge tone="blue">Matched</Badge> : <Badge>Skip</Badge>}
              </div>
            ))}
          </div>
        )}
        {files.length > 0 && <p className="text-xs text-slate-500">{files.filter((f) => f.product).length} of {files.length} matched{done ? ` · ${done} uploaded` : ""}</p>}
        <ErrorText error={err} />
      </div>
    </Modal>
  );
}
