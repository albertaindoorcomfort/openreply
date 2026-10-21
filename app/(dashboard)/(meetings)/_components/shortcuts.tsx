"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

const ROUTES: Record<string, string> = { t: "/today", a: "/agenda", c: "/calendar", m: "/meetings", n: "/notes", i: "/inbox" };

/**
 * Single-key navigation (t, a, c, m, n, i) and "/" to focus search, ignored
 * while typing in a field so it never steals keystrokes.
 */
export default function Shortcuts() {
  const router = useRouter();
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || el?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (e.key === "/") {
        const search = document.querySelector<HTMLInputElement>("input[type=search]");
        if (search) {
          e.preventDefault();
          search.focus();
        }
        return;
      }
      const href = ROUTES[e.key];
      if (href) router.push(href);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);
  return null;
}
