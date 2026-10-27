"use client";

import { useEffect } from "react";

/** Portaled dialogs and menus share the same cashier sizing and visible viewport. */
export function CashierTouchViewport({active}: {active: boolean}) {
  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    root.dataset.cashierTouch = "true";
    const viewport = window.visualViewport;
    function update() {
      root.style.setProperty("--cashier-viewport-height", `${viewport?.height ?? window.innerHeight}px`);
      root.style.setProperty("--cashier-viewport-top", `${viewport?.offsetTop ?? 0}px`);
      const workspace = document.querySelector(".cashier-workspace");
      if (workspace) root.style.setProperty("--cashier-workspace-height", `${Math.max(220, (viewport?.height ?? window.innerHeight) - Math.max(0,workspace.getBoundingClientRect().top - (viewport?.offsetTop ?? 0)) - 12)}px`);
      requestAnimationFrame(() => {
        const field = document.activeElement;
        if (field instanceof HTMLElement && field.matches("input,textarea,select") && field.closest('[data-slot="dialog-content"]')) {
          field.scrollIntoView({block:"nearest", inline:"nearest"});
        }
      });
    }
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    const observer = new ResizeObserver(update);
    const main = document.querySelector("main");
    if (main) observer.observe(main);
    return () => {
      delete root.dataset.cashierTouch;
      root.style.removeProperty("--cashier-viewport-height");
      root.style.removeProperty("--cashier-viewport-top");
      root.style.removeProperty("--cashier-workspace-height");
      observer.disconnect();
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [active]);
  return null;
}
