/**
 * Generic search → saved predicate filters. Pick a field (author / platform / caption / all
 * text / hashtags), then either type a substring (text fields) or choose a value (enum fields
 * like platform, whose distinct values are read from the export). Each saved search is a chip.
 * Chips combine as: OR within a field, AND across fields, minus any excludes:
 *
 *   (authorA OR authorB) AND (platform=tiktok OR platform=instagram) AND NOT (alltext~y ...)
 *
 * The combined predicate is pushed into the shared `filter` selection, so it hard-filters the
 * map AND the density plots. Only fields present in the export are offered.
 *
 * Note: the analysis export has no separate transcript/OCR text columns — that text lives in
 * "all text" (document). Add those columns to the export to search them individually.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as vg from "@uwdata/vgplot";
import { X } from "lucide-react";
import type { ColumnInfo } from "../lib/columns";
import type { Selections } from "../selections";

type Mode = "include" | "exclude";
interface Rule {
  id: number;
  fieldKey: string;
  value: string;
  mode: Mode;
}

// Search fields. `text` → substring ILIKE; `enum` → exact match, values from a dropdown.
const FIELD_DEFS: { key: string; label: string; cols: string[]; type?: "text" | "enum" }[] = [
  { key: "author", label: "Author", cols: ["author_handle", "author_nickname"] },
  { key: "platform", label: "Platform", cols: ["platform"], type: "enum" },
  { key: "caption", label: "Caption", cols: ["caption"] },
  { key: "document", label: "All text", cols: ["document"] },
  { key: "hashtags", label: "Hashtags", cols: ["hashtags"] },
];

const esc = (s: string) => s.replace(/'/g, "''");

export function FilterPanel({
  coordinator,
  columns,
  selections,
}: {
  coordinator: any;
  columns: ColumnInfo[];
  selections: Selections;
}) {
  const present = useMemo(() => new Set(columns.map((c) => c.name)), [columns]);
  const fields = useMemo(
    () =>
      FIELD_DEFS.map((f) => ({ ...f, type: f.type ?? "text", cols: f.cols.filter((c) => present.has(c)) })).filter(
        (f) => f.cols.length,
      ),
    [present],
  );

  const filterSrc = useRef({}).current;
  const idRef = useRef(1);
  const [rules, setRules] = useState<Rule[]>([]);
  const [draft, setDraft] = useState("");
  const [fieldKey, setFieldKey] = useState(fields[0]?.key ?? "");
  const [enumVals, setEnumVals] = useState<Record<string, string[]>>({});

  const curField = fields.find((f) => f.key === fieldKey);
  const isEnum = curField?.type === "enum";

  // Distinct values for enum fields (read once from the export).
  useEffect(() => {
    if (!coordinator) return;
    let alive = true;
    const enums = fields.filter((f) => f.type === "enum");
    Promise.all(
      enums.map(async (f) => {
        const col = f.cols[0];
        try {
          const rows = (await coordinator.query(
            `SELECT DISTINCT "${col}" AS v FROM data WHERE "${col}" IS NOT NULL ORDER BY 1`,
            { type: "json" },
          )) as any[];
          return [f.key, rows.map((r) => String(r.v))] as const;
        } catch {
          return [f.key, [] as string[]] as const;
        }
      }),
    ).then((pairs) => alive && setEnumVals(Object.fromEntries(pairs)));
    return () => {
      alive = false;
    };
  }, [coordinator, fields]);

  const clauseFor = (fieldKey: string, v: string) => {
    const f = fields.find((x) => x.key === fieldKey);
    if (!f) return null;
    const op = f.type === "enum" ? (c: string) => `"${c}" = '${esc(v)}'` : (c: string) => `"${c}" ILIKE '%${esc(v)}%'`;
    const clause = f.cols.map(op).join(" OR ");
    return f.cols.length > 1 ? `(${clause})` : clause;
  };
  const fieldLabel = (k: string) => fields.find((f) => f.key === k)?.label ?? k;

  // Rebuild the predicate whenever the rules change: OR within a field, AND across fields.
  useEffect(() => {
    const incByField = new Map<string, string[]>();
    const exc: string[] = [];
    for (const r of rules) {
      const clause = clauseFor(r.fieldKey, r.value);
      if (!clause) continue;
      if (r.mode === "include") {
        if (!incByField.has(r.fieldKey)) incByField.set(r.fieldKey, []);
        incByField.get(r.fieldKey)!.push(clause);
      } else {
        exc.push(clause);
      }
    }
    const parts: string[] = [];
    for (const clauses of incByField.values()) parts.push(`(${clauses.join(" OR ")})`);
    if (exc.length) parts.push(`NOT (${exc.join(" OR ")})`);
    const sql = parts.join(" AND ");
    selections.filter.update({
      source: filterSrc,
      value: rules.length ? sql : null,
      predicate: sql ? vg.sql`${sql}` : null,
    });
    return () => selections.filter.update({ source: filterSrc, value: null, predicate: null });
  }, [rules, selections, filterSrc]); // eslint-disable-line react-hooks/exhaustive-deps

  if (fields.length === 0) return null;

  // Exclude is supported by the predicate builder but not exposed; new rules are includes.
  const add = (val?: string) => {
    const v = (val ?? draft).trim();
    if (!v || !fieldKey || rules.some((r) => r.value === v && r.mode === "include" && r.fieldKey === fieldKey)) {
      setDraft("");
      return;
    }
    setRules((rs) => [...rs, { id: idRef.current++, fieldKey, value: v, mode: "include" }]);
    setDraft("");
  };
  const remove = (id: number) => setRules((rs) => rs.filter((r) => r.id !== id));

  return (
    <div className="flex shrink-0 flex-col gap-2 rounded-box border border-base-300 bg-base-100 px-4 py-2.5">
      <span className="text-xs font-medium text-base-content/70">Search</span>

      <div className="flex items-center gap-1">
        <select
          value={fieldKey}
          onChange={(e) => setFieldKey(e.target.value)}
          className="select select-xs h-6 w-24 shrink-0 px-1 text-xs"
        >
          {fields.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
        {isEnum ? (
          <select
            value=""
            onChange={(e) => e.target.value && add(e.target.value)}
            className="select select-xs h-6 w-0 min-w-0 flex-1 px-2 text-xs"
          >
            <option value="">select…</option>
            {(enumVals[fieldKey] ?? []).map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="contains…"
            className="input input-xs h-6 w-0 min-w-0 flex-1 px-2 text-xs"
          />
        )}
      </div>

      {rules.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {rules.map((r) => (
            <span
              key={r.id}
              className="inline-flex items-center gap-1 rounded-full border border-primary/40 px-1.5 py-0.5 text-xs text-primary"
            >
              <span>
                <span className="opacity-60">{fieldLabel(r.fieldKey)}:</span> {r.value}
              </span>
              <button onClick={() => remove(r.id)} className="hover:text-base-content" aria-label="remove">
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
