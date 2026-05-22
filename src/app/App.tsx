import "./App.css";
import { useEffect } from "react";
import Home from "@/pages/Home";

const SCROLLBAR_VISIBLE_CLASS = "scrollbar-visible"; 
const SCROLLBAR_HIDE_DELAY_MS = 3000;

function canScroll(element: Element) {
  const style = window.getComputedStyle(element);
  const canScrollY =
    (style.overflowY === "auto" || style.overflowY === "scroll") &&
    element.scrollHeight > element.clientHeight;
  const canScrollX =
    (style.overflowX === "auto" || style.overflowX === "scroll") &&
    element.scrollWidth > element.clientWidth;

  return canScrollY || canScrollX;
}

function findScrollableElement(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return null;
  }

  let element: Element | null = target;

  while (element && element !== document.body) {
    if (canScroll(element)) {
      return element;
    }

    element = element.parentElement;
  }

  const scrollingElement = document.scrollingElement;
  return scrollingElement && canScroll(scrollingElement) ? scrollingElement : null;
}

function useAutoHideScrollbars() {
  useEffect(() => {
    const hideTimers = new Map<Element, number>();
    const hoveredElements = new Set<Element>();
    let pendingPointerTarget: EventTarget | null = null;
    let pointerMoveFrame: number | null = null;

    const hideScrollbarLater = (element: Element) => {
      if (hoveredElements.has(element)) {
        return;
      }

      const existingTimer = hideTimers.get(element);
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
      }

      const hideTimer = window.setTimeout(() => {
        if (!hoveredElements.has(element)) {
          element.classList.remove(SCROLLBAR_VISIBLE_CLASS);
        }
        hideTimers.delete(element);
      }, SCROLLBAR_HIDE_DELAY_MS);

      hideTimers.set(element, hideTimer);
    };

    const revealScrollbar = (element: Element | null, keepVisible = false) => {
      if (!element) {
        return;
      }

      element.classList.add(SCROLLBAR_VISIBLE_CLASS);

      const existingTimer = hideTimers.get(element);
      if (existingTimer !== undefined) {
        window.clearTimeout(existingTimer);
        hideTimers.delete(element);
      }

      if (keepVisible || hoveredElements.has(element)) {
        return;
      }

      hideScrollbarLater(element);
    };

    const revealFromEventTarget = (event: Event) => {
      revealScrollbar(findScrollableElement(event.target));
    };

    const revealFromActiveElement = () => {
      revealScrollbar(findScrollableElement(document.activeElement));
    };

    const revealFromPointerMove = (event: PointerEvent) => {
      pendingPointerTarget = event.target;

      if (pointerMoveFrame !== null) {
        return;
      }

      pointerMoveFrame = window.requestAnimationFrame(() => {
        revealScrollbar(findScrollableElement(pendingPointerTarget));
        pendingPointerTarget = null;
        pointerMoveFrame = null;
      });
    };

    const keepVisibleFromPointerOver = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") {
        return;
      }

      const element = findScrollableElement(event.target);
      if (!element) {
        return;
      }

      hoveredElements.add(element);
      revealScrollbar(element, true);
    };

    const hideAfterPointerOut = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") {
        return;
      }

      const previousElement = findScrollableElement(event.target);
      const nextElement = findScrollableElement(event.relatedTarget);

      if (!previousElement || previousElement === nextElement) {
        return;
      }

      hoveredElements.delete(previousElement);
      hideScrollbarLater(previousElement);
    };

    window.addEventListener("scroll", revealFromEventTarget, true);
    window.addEventListener("wheel", revealFromEventTarget, { passive: true });
    window.addEventListener("pointerover", keepVisibleFromPointerOver, { passive: true });
    window.addEventListener("pointerout", hideAfterPointerOut, { passive: true });
    window.addEventListener("pointermove", revealFromPointerMove, { passive: true });
    window.addEventListener("touchmove", revealFromEventTarget, { passive: true });
    window.addEventListener("keydown", revealFromActiveElement);

    return () => {
      window.removeEventListener("scroll", revealFromEventTarget, true);
      window.removeEventListener("wheel", revealFromEventTarget);
      window.removeEventListener("pointerover", keepVisibleFromPointerOver);
      window.removeEventListener("pointerout", hideAfterPointerOut);
      window.removeEventListener("pointermove", revealFromPointerMove);
      window.removeEventListener("touchmove", revealFromEventTarget);
      window.removeEventListener("keydown", revealFromActiveElement);

      if (pointerMoveFrame !== null) {
        window.cancelAnimationFrame(pointerMoveFrame);
      }

      hideTimers.forEach((timer, element) => {
        window.clearTimeout(timer);
        element.classList.remove(SCROLLBAR_VISIBLE_CLASS);
      });
      hideTimers.clear();
      hoveredElements.clear();
    };
  }, []);
}

function App() {
  useAutoHideScrollbars();

  return (
    <main className="app-container">
      <Home />
    </main>
  );
}

export default App;
