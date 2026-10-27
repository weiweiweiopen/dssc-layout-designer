import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { en, type UiKey } from "./locales/en";
import { zhTW } from "./locales/zh-TW";

export type Locale = "zh-TW" | "en";
export const LOCALE_STORAGE_KEY = "dssc-layout-language";
export const dictionaries = { "zh-TW": zhTW, en };
export function translate(locale: Locale, key: UiKey, values: Record<string, string | number> = {}) {
  return dictionaries[locale][key].replace(/\{(\w+)\}/g, (token, name: string) => String(values[name] ?? token));
}
const LocaleContext = createContext<{
  locale: Locale;
  setLocale: (locale: Locale) => void;
} | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => {
    try { return localStorage.getItem(LOCALE_STORAGE_KEY) === "en" ? "en" : "zh-TW"; }
    catch { return "zh-TW"; }
  });
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = translate(locale, "title");
    try { localStorage.setItem(LOCALE_STORAGE_KEY, locale); } catch { /* optional preference */ }
  }, [locale]);
  return <LocaleContext.Provider value={{ locale, setLocale }}>{children}</LocaleContext.Provider>;
}

export function useI18n() {
  const context = useContext(LocaleContext);
  if (!context) throw new Error("useI18n requires LocaleProvider");
  return { ...context,
    t: (key: UiKey, values?: Record<string, string | number>) => translate(context.locale, key, values),
    b: (zh: string, english: string) => context.locale === "zh-TW" ? zh : english,
  };
}
