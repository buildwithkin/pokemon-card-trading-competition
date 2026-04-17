"use client";

import { useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { HoloEffect } from "@/lib/holo";

export { holoEffectForRarity, type HoloEffect } from "@/lib/holo";

const clamp = (n: number, min = 0, max = 100) =>
  Math.min(Math.max(n, min), max);
const adjust = (n: number, fromA: number, fromB: number, toA: number, toB: number) =>
  toA + ((toB - toA) * (n - fromA)) / (fromB - fromA);

export function HoloCard({
  children,
  className,
  intensity = 1,
  effect = "shine",
}: {
  children: ReactNode;
  className?: string;
  intensity?: number;
  effect?: HoloEffect;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = clamp(((e.clientX - rect.left) / rect.width) * 100);
    const py = clamp(((e.clientY - rect.top) / rect.height) * 100);
    const cx = px - 50;
    const cy = py - 50;
    const fromCenter = clamp(Math.sqrt(cx * cx + cy * cy) / 50, 0, 1);
    const rx = (-cy / 4) * intensity;
    const ry = (cx / 3.5) * intensity;
    el.style.setProperty("--pointer-x", `${px}%`);
    el.style.setProperty("--pointer-y", `${py}%`);
    el.style.setProperty("--pointer-from-left", `${px / 100}`);
    el.style.setProperty("--pointer-from-top", `${py / 100}`);
    el.style.setProperty("--pointer-from-center", `${fromCenter}`);
    el.style.setProperty("--background-x", `${adjust(px, 0, 100, 37, 63)}%`);
    el.style.setProperty("--background-y", `${adjust(py, 0, 100, 33, 67)}%`);
    el.style.setProperty("--rotate-x", `${rx}deg`);
    el.style.setProperty("--rotate-y", `${ry}deg`);
  };

  const handleLeave = () => {
    const el = ref.current;
    if (el) {
      el.style.setProperty("--pointer-x", "50%");
      el.style.setProperty("--pointer-y", "50%");
      el.style.setProperty("--pointer-from-left", "0.5");
      el.style.setProperty("--pointer-from-top", "0.5");
      el.style.setProperty("--pointer-from-center", "0");
      el.style.setProperty("--background-x", "50%");
      el.style.setProperty("--background-y", "50%");
      el.style.setProperty("--rotate-x", "0deg");
      el.style.setProperty("--rotate-y", "0deg");
    }
    setActive(false);
  };

  return (
    <div
      ref={ref}
      className={cn(
        "holo-card",
        `holo-card--${effect}`,
        active && "holo-card--active",
        className,
      )}
      onMouseEnter={() => setActive(true)}
      onMouseLeave={handleLeave}
      onMouseMove={handleMove}
    >
      <div className="holo-card__inner">
        {children}
        <div className="holo-card__shine" aria-hidden />
        <div className="holo-card__glare" aria-hidden />
      </div>
    </div>
  );
}
