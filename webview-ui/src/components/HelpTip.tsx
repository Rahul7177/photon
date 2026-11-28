import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";

interface HelpCoords {
  top: number;
  left: number;
  width: number;
  placement: "above" | "below";
  arrowLeft: number;
}

export function HelpTip({ text }: { text: string }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [coords, setCoords] = useState<HelpCoords | null>(null);
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const open = hovered || pinned;

  const updatePosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth || 360;
    const vh = window.innerHeight || 600;
    const popWidth = Math.min(244, Math.max(180, vw - 20));
    const centerX = rect.left + rect.width / 2;
    const left = Math.max(10, Math.min(vw - popWidth - 10, centerX - popWidth / 2));
    const placement: "above" | "below" = rect.bottom + 88 > vh && rect.top > 90 ? "above" : "below";
    const top = placement === "above" ? rect.top - 7 : rect.bottom + 7;
    const arrowLeft = Math.max(12, Math.min(popWidth - 12, centerX - left));
    setCoords({ top, left, width: popWidth, placement, arrowLeft });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();

    const handleDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (
        target &&
        (triggerRef.current?.contains(target) || popoverRef.current?.contains(target))
      ) {
        return;
      }
      setPinned(false);
      setHovered(false);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPinned(false);
        setHovered(false);
      }
    };

    const handleScrollOrResize = () => {
      updatePosition();
    };

    document.addEventListener("mousedown", handleDocMouseDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("scroll", handleScrollOrResize, true);
    window.addEventListener("resize", handleScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", handleDocMouseDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("scroll", handleScrollOrResize, true);
      window.removeEventListener("resize", handleScrollOrResize);
    };
  }, [open, updatePosition]);

  return (
    <>
      <span
        ref={triggerRef}
        role="button"
        tabIndex={0}
        aria-label={text}
        aria-expanded={open}
        className={`help-tip-trigger${open ? " active" : ""}${pinned ? " pinned" : ""}`}
        onMouseEnter={() => {
          updatePosition();
          setHovered(true);
        }}
        onMouseLeave={() => {
          setHovered(false);
        }}
        onFocus={() => {
          updatePosition();
          setHovered(true);
        }}
        onBlur={() => {
          if (!pinned) setHovered(false);
        }}
        onMouseDown={(e) => {
          e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          updatePosition();
          setPinned((prev) => {
            const next = !prev;
            if (!next) setHovered(false);
            return next;
          });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            e.preventDefault();
            updatePosition();
            setPinned((prev) => !prev);
          }
        }}
      >
        ?
      </span>
      {open &&
        coords &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popoverRef}
            role="tooltip"
            className={`help-tip-popover ${coords.placement}`}
            style={{
              top: `${coords.top}px`,
              left: `${coords.left}px`,
              width: `${coords.width}px`,
            }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <span
              className="help-tip-arrow"
              style={{ left: `${coords.arrowLeft}px` }}
            />
            <div className="help-tip-content">{text}</div>
          </div>,
          document.body
        )}
    </>
  );
}
