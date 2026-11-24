import { Baby, Brush, GraduationCap, Headphones, House, type LucideIcon, Package, Paperclip, PartyPopper, Shirt, ShoppingBag, Smile, Sparkles, SprayCan, Footprints } from "lucide-react";
import { useEffect, useState } from "react";
import { getAccessToken } from "../lib/api";
import { cx } from "./ui";

/**
 * Product picture: the uploaded photo when there is one, otherwise an illustrated tile drawn from the
 * product's category (icon + colour) and name, so every product — built-in or new — has a picture.
 */
const STYLES: [RegExp, LucideIcon, string, string][] = [
  [/clean|laundry/i, SprayCan, "from-sky-50 to-sky-100", "text-sky-600"],
  [/dental|oral/i, Smile, "from-cyan-50 to-teal-100", "text-teal-600"],
  [/cosmetic|skin|beauty/i, Sparkles, "from-pink-50 to-rose-100", "text-rose-500"],
  [/bab(y|ies)|mother/i, Baby, "from-amber-50 to-yellow-100", "text-amber-600"],
  [/child|kids/i, Footprints, "from-lime-50 to-green-100", "text-green-600"],
  [/female|women|lad(y|ies)/i, ShoppingBag, "from-fuchsia-50 to-purple-100", "text-purple-500"],
  [/men|wear|cloth|fashion/i, Shirt, "from-indigo-50 to-blue-100", "text-indigo-500"],
  [/school|stationery/i, GraduationCap, "from-orange-50 to-orange-100", "text-orange-600"],
  [/party|gift/i, PartyPopper, "from-red-50 to-pink-100", "text-red-500"],
  [/office|utilit/i, Paperclip, "from-slate-50 to-slate-200", "text-slate-600"],
  [/electr/i, Headphones, "from-violet-50 to-indigo-100", "text-violet-600"],
  [/manicure|pedicure|nail/i, Brush, "from-rose-50 to-pink-100", "text-pink-600"],
  [/house|home/i, House, "from-emerald-50 to-emerald-100", "text-emerald-600"],
];

const cache = new Map<string, Promise<string | null>>();
function photoUrl(id: string) {
  if (!cache.has(id)) {
    cache.set(id, fetch(`/api/v1/attachments/${id}`, { headers: { Authorization: `Bearer ${getAccessToken()}` } })
      .then(async (r) => (r.ok ? URL.createObjectURL(await r.blob()) : null)).catch(() => null));
  }
  return cache.get(id)!;
}
/** Forget a cached photo (after replacing it). */
export const forgetPhoto = (id: string) => cache.delete(id);

export function ProductImage({ attachmentId, name, category, className = "h-24 w-24", showName = true }: { attachmentId?: string | null; name?: string; category?: string | null; className?: string; showName?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setUrl(null);
    if (attachmentId) photoUrl(attachmentId).then((u) => live && setUrl(u));
    return () => { live = false; };
  }, [attachmentId]);
  if (url) return <img src={url} alt={name ?? ""} className={cx(className, "rounded-lg object-cover")} />;
  const [, Icon, bg, fg] = STYLES.find(([re]) => re.test(category ?? "")) ?? [null, Package, "from-slate-50 to-slate-100", "text-slate-500"];
  const short = (name ?? "").replace(/\s*-\s*/g, " · ");
  return (
    <div role="img" aria-label={name ? `${name} (illustration)` : "Product"} className={cx(className, "relative flex flex-col items-center justify-center gap-1 overflow-hidden rounded-lg bg-gradient-to-br p-1.5 text-center", bg)}>
      <Icon className={cx("h-1/3 max-h-10 min-h-4 w-auto shrink-0", fg)} strokeWidth={1.75} aria-hidden />
      {showName && short && <span className={cx("line-clamp-2 w-full text-[10px] font-semibold leading-tight", fg)}>{short}</span>}
    </div>
  );
}
