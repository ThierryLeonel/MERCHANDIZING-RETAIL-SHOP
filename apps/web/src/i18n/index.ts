import { en, MessageKey } from "./en";

const dictionaries: Record<string, Partial<Record<MessageKey, string>>> = { en };
let locale = "en";
export const setLocale = (l: string) => { locale = dictionaries[l] ? l : "en"; };
export function t(key: MessageKey): string {
  return dictionaries[locale]?.[key] ?? en[key] ?? key;
}
