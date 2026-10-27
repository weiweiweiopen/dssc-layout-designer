import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "./i18n";
import { staticHelpEn } from "./locales/help";

interface ActiveHelp {
  anchor: HTMLElement;
  content: string;
  id: string;
}

const HelpContext = createContext<{
  show: (help: ActiveHelp) => void;
  hide: (anchor: HTMLElement) => void;
} | null>(null);

function HelpPopup({ help, keepOpen, hide }: {
  help: ActiveHelp;
  keepOpen: () => void;
  hide: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    const box = help.anchor.getBoundingClientRect();
    const popup = ref.current!.getBoundingClientRect();
    const toolbar = help.anchor.closest(".view-toolbar");
    // Side placement over a horizontal toolbar can cover neighboring buttons
    // and swallow their clicks (especially the shared seal-stage checkbox).
    const preferredLeft = toolbar ? box.left : box.right + 8 + popup.width <= window.innerWidth - 8
      ? box.right + 8 : box.left - popup.width - 8;
    const preferredTop = toolbar ? toolbar.getBoundingClientRect().bottom + 6 : box.top;
    setPosition({
      left: Math.max(8, Math.min(preferredLeft, window.innerWidth - popup.width - 8)),
      top: Math.max(8, Math.min(preferredTop, window.innerHeight - popup.height - 8)),
    });
  }, [help]);
  return createPortal(
    <div ref={ref} id={help.id} role="tooltip" className="parameter-tooltip"
      style={position} onPointerEnter={keepOpen} onPointerLeave={hide}>
      {help.content}
    </div>, document.body,
  );
}

export function HelpProvider({ children }: { children: ReactNode }) {
  const { locale } = useI18n();
  const [active, setActive] = useState<ActiveHelp | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepOpen = () => { if (timer.current) clearTimeout(timer.current); };
  const dismiss = () => { keepOpen(); setActive(null); };
  useEffect(() => { keepOpen(); setActive(null); }, [locale]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    const scroll = (event: Event) => {
      if (!(event.target instanceof Element && event.target.closest('[role="tooltip"]'))) dismiss();
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", dismiss);
    return () => {
      keepOpen();
      window.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", dismiss);
    };
  }, []);
  const hide = (anchor: HTMLElement) => {
    keepOpen();
    timer.current = setTimeout(() => setActive((current) => current?.anchor === anchor ? null : current), 120);
  };
  return <HelpContext.Provider value={{
    show: (help) => { keepOpen(); setActive(help); }, hide,
  }}>
    {children}
    {active ? <HelpPopup help={active} keepOpen={keepOpen} hide={() => hide(active.anchor)} /> : null}
  </HelpContext.Provider>;
}

/** Portaled help stays outside the scrolling sidebar and occupies no form space. */
export function Help({ as: Tag = "div", content: source, contentEn, children, id: suppliedId, ...props }: {
  as?: "label" | "div" | "span";
  content: string;
  contentEn?: string;
  children: ReactNode;
} & React.HTMLAttributes<HTMLElement>) {
  const context = useContext(HelpContext)!;
  const { locale } = useI18n();
  const content = locale === "en" ? contentEn ?? staticHelpEn[source] ?? source : source;
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  return <Tag {...props} data-help={content} aria-describedby={id}
    onPointerEnter={(event) => context.show({ anchor: event.currentTarget, content, id })}
    onPointerLeave={(event) => {
      if (!event.currentTarget.contains(document.activeElement)) context.hide(event.currentTarget);
    }}
    onFocusCapture={(event) => context.show({ anchor: event.currentTarget, content, id })}
    onBlurCapture={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) context.hide(event.currentTarget);
    }}>
    {children}
  </Tag>;
}
