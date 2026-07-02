/**
 * Floating, draggable detail card for a clicked post. Absolutely positioned inside the
 * umap's relative container and clamped to it, so it can be dragged anywhere over the plot
 * but never covers the sidebar. Drag by the header, close with X. Drag uses window
 * listeners bound only during an active drag, so the card can't get stuck to the cursor.
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { X, ExternalLink } from "lucide-react";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

const int = (d: any) => (d == null || Number(d) === -1 ? "—" : Number(d).toLocaleString());
const dateTime = (d: any) =>
  d == null
    ? "—"
    : new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(Number(d) * 1000),
      );

const STATS: [string, string][] = [
  ["Views", "view_count"],
  ["Likes", "like_count"],
  ["Comments", "comment_count"],
  ["Shares", "share_count"],
  ["Saves", "collect_count"],
  ["Reposts", "repost_count"],
  ["Followers", "author_follower_count"],
];

const META: [string, string][] = [
  ["Content type", "content_type"],
  ["Duration", "duration_ms"],
];

export function PostCard({ row, onClose }: { row: Record<string, any>; onClose: () => void }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 16, y: 16 });

  // Open at the top-right of the plot area (once size is known, before paint).
  useLayoutEffect(() => {
    const el = cardRef.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent) return;
    setPos({ x: Math.max(0, parent.clientWidth - el.offsetWidth - 16), y: 16 });
  }, []);

  // Drag via window listeners bound only for the duration of a drag — they always tear
  // down on mouseup, so the card can't get stuck following the cursor.
  const onDown = (e: ReactPointerEvent) => {
    const el = cardRef.current;
    const parent = el?.offsetParent as HTMLElement | null;
    if (!el || !parent || e.button !== 0) return;
    e.preventDefault();
    const pr = parent.getBoundingClientRect();
    const offX = e.clientX - pr.left - pos.x;
    const offY = e.clientY - pr.top - pos.y;
    const move = (ev: PointerEvent) => {
      setPos({
        x: clamp(ev.clientX - pr.left - offX, 0, pr.width - el.offsetWidth),
        y: clamp(ev.clientY - pr.top - offY, 0, pr.height - el.offsetHeight),
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const has = (k: string) => k in row && row[k] != null && row[k] !== "";
  const stats = STATS.filter(([, k]) => k in row);
  const caption = has("caption") ? String(row.caption) : "";
  const keywords = has("cluster_keywords")
    ? String(row.cluster_keywords).split(" | ").slice(0, 6).join(", ")
    : null;
  const url = has("url") ? String(row.url) : null;

  const Field = ({ label, value }: { label: string; value: string }) => (
    <div className="flex justify-between gap-3 py-0.5">
      <span className="shrink-0 text-base-content/50">{label}</span>
      <span className="truncate text-right">{value}</span>
    </div>
  );

  return (
    <div
      ref={cardRef}
      style={{ left: pos.x, top: pos.y }}
      className="absolute z-40 flex max-h-[90%] w-80 flex-col overflow-hidden rounded-box border border-base-300 bg-base-100 shadow-xl"
    >
      <div
        onPointerDown={onDown}
        className="flex cursor-move touch-none select-none items-start justify-between gap-2 border-b border-base-300 bg-base-200/60 px-3 py-2"
      >
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{has("author_handle") ? row.author_handle : "post"}</div>
          <div className="truncate text-xs text-base-content/50">
            {[has("platform") && row.platform, has("region") && row.region].filter(Boolean).join(" · ")}
          </div>
        </div>
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onClose}
          className="shrink-0 text-base-content/40 transition-colors hover:text-error"
          aria-label="close"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-2.5 text-xs">
        {caption && (
          <>
            <p className="whitespace-pre-wrap break-words text-base-content/80">{caption}</p>
            <hr className="-mx-3 border-base-300" />
          </>
        )}

        <div>
          {has("create_time") && <Field label="Posted" value={dateTime(row.create_time)} />}
          {has("cluster") && (
            <Field label="Cluster" value={keywords ? `${row.cluster} · ${keywords}` : String(row.cluster)} />
          )}
          {META.filter(([, k]) => has(k)).map(([label, k]) => (
            <Field
              key={k}
              label={label}
              value={k === "duration_ms" ? `${(Number(row[k]) / 1000).toFixed(1)}s` : String(row[k])}
            />
          ))}
        </div>

        {stats.length > 0 && (
          <>
            <hr className="-mx-3 border-base-300" />
            <div className="grid grid-cols-2 gap-x-3">
              {stats.map(([label, k]) => (
                <div key={k} className="flex justify-between gap-2 py-0.5">
                  <span className="text-base-content/50">{label}</span>
                  <span className="tabular-nums">{int(row[k])}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="link link-primary inline-flex items-center gap-1 pt-1"
          >
            open post <ExternalLink className="size-3" />
          </a>
        )}
      </div>
    </div>
  );
}
