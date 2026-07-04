/**
 * File → DuckDB table. Registers a dropped file's bytes and creates the `data`
 * table from it, inferring the reader from the extension. Then introspects the
 * schema via DESCRIBE so the color-by controls can be built generically.
 *
 * TODO (per plan): multi-file drop + join on post_id (drop embeddings + affect +
 * topic separately and JOIN into `data`). v1 handles a single combined export.
 */
import { classifyColumns, type ColumnInfo } from "../lib/columns";
import { rankableColumns } from "../lib/fields";

export type { ColumnInfo };

// Hard ceiling on upload size. The whole dataset lives in the in-page wasm engine and every row is
// an SVG dot in the scatter, so a pathological file would stall or OOM the tab. A topic export is a
// few-k to ~15k rows, so this is generous headroom; oversized files are rejected before materializing.
const ROW_LIMIT = 250_000;

// duckdb types come from Mosaic's own copy (via the connector); typed loosely here.
type AsyncDuckDB = any;
type AsyncDuckDBConnection = any;

function readerFor(name: string, ext: string): string {
  if (ext === "parquet") return `read_parquet('${name}')`;
  if (ext === "csv" || ext === "tsv") return `read_csv_auto('${name}')`;
  if (ext === "json" || ext === "ndjson") return `read_json_auto('${name}')`;
  throw new Error(`unsupported file type: .${ext} (use parquet, csv, or json)`);
}

// Monotonic counter → a fresh virtual filename per upload. DuckDB-wasm caches parquet blocks by
// filename in its buffer manager, and `dropFile` doesn't flush that cache — so re-registering the
// SAME name (e.g. a re-exported topic) reads stale blocks → "Snappy decompression failure:
// Uncompressed data size mismatch". A never-seen name always reads clean.
let uploadSeq = 0;

// Ingest phases for the loading overlay: a label plus a rough fraction-complete. The fractions
// are hand-weighted (materializing the table and the rank window-sorts dominate), not measured.
export type IngestProgress = (label: string, frac: number) => void;

export async function ingestFile(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  file: File,
  onProgress?: IngestProgress,
): Promise<{ columns: ColumnInfo[]; rowCount: number }> {
  const step: IngestProgress = (label, frac) => onProgress?.(label, frac);
  step("reading file…", 0.03);
  const buf = new Uint8Array(await file.arrayBuffer());
  const ext = file.name.toLowerCase().split(".").pop() || "parquet";
  const vname = `upload-${++uploadSeq}.${ext}`;
  const reader = readerFor(vname, ext); // validates the extension before we register
  await db.registerFileBuffer(vname, buf);
  step("validating…", 0.12);

  // Reject oversized uploads BEFORE materializing the table (parquet count is metadata-cheap;
  // CSV/JSON stream-count without building columns), so a huge file can't stall/OOM the wasm engine.
  const nRows = Number(
    (await conn.query(`SELECT count(*)::BIGINT AS n FROM ${reader}`)).toArray()[0]?.n ?? 0,
  );
  if (nRows > ROW_LIMIT) {
    await db.dropFile?.(vname)?.catch(() => {});
    throw new Error(
      `Export has ${nRows.toLocaleString()} rows, over the ${ROW_LIMIT.toLocaleString()}-row limit — filter or subset it first.`,
    );
  }

  step("loading table…", 0.25);
  await conn.query(`CREATE OR REPLACE TABLE data AS SELECT * FROM ${reader}`);
  // `data` is materialized; free the buffer (unique name means no future collision anyway).
  await db.dropFile?.(vname)?.catch(() => {});

  const descRows: { name: string; type: string }[] = (await conn.query(`DESCRIBE data`))
    .toArray()
    .map((r: any) => ({ name: String(r.column_name), type: String(r.column_type) }));

  // Derive `engagement_rate` = (likes + comments + shares) ÷ views — drumbeat-atlas' `eng_rate`.
  // The rate is undefined for a post with no recorded views, so views <= 0 (or NULL) → NULL rather
  // than atlas' floor-to-1, which turns those degenerate rows into absurd rates (e.g. 434) that
  // then dominate the color/axis domain and flatten the real [0, ~0.5] bulk to zero. `::DOUBLE`
  // forces float division. Only when the source counts are present and it isn't already exported;
  // wrapped so a non-numeric count column just skips the field instead of failing the whole load.
  step("deriving fields…", 0.5);
  const present = new Set(descRows.map((r) => r.name));
  const ENG_SRC = ["like_count", "comment_count", "share_count", "view_count"];
  if (ENG_SRC.every((c) => present.has(c)) && !present.has("engagement_rate")) {
    try {
      await conn.query(`ALTER TABLE data ADD COLUMN engagement_rate DOUBLE`);
      await conn.query(
        `UPDATE data SET engagement_rate = CASE WHEN view_count IS NULL OR view_count <= 0 THEN NULL ` +
          `ELSE (like_count + comment_count + share_count)::DOUBLE / view_count END`,
      );
      descRows.push({ name: "engagement_rate", type: "DOUBLE" });
    } catch {
      await conn.query(`ALTER TABLE data DROP COLUMN IF EXISTS engagement_rate`).catch(() => {});
    }
  }

  const columns = classifyColumns(descRows);

  // Flag continuous columns whose min is <= 0 (or all-null) so the UI can disable
  // the log scale for them (signed metrics like VADER compound run negative).
  const cont = columns.filter((c) => c.kind === "continuous");
  if (cont.length) {
    const sel = cont.map((c) => `min("${c.name}") AS "${c.name}"`).join(", ");
    const row: any = (await conn.query(`SELECT ${sel} FROM data`)).toArray()[0] ?? {};
    for (const c of cont) {
      const v = row[c.name];
      c.signed = v == null || Number(v) <= 0;
    }
  }

  const cnt = await conn.query(`SELECT count(*)::INT AS n FROM data`);
  const rowCount = Number(cnt.toArray()[0]?.n ?? 0);

  // Precompute a GLOBAL rank column per correlatable field so ProfileStrip's live `corr()` on the
  // ranks yields (approximate) Spearman without re-ranking per selection — the ranking cost lives
  // here (once, ~one window sort per field over a small table), not on the brush path. Ranks are
  // over the whole upload; validated to approximate the true within-selection Spearman closely
  // (mean |err| ~0.01), degrading only where a selection has little spread (r ≈ 0 anyway).
  // NULL-masked (NULLs stay NULL → ignored pairwise by corr), min-rank ties, cast to FLOAT.
  step("precomputing ranks…", 0.65);
  const existing = new Set(descRows.map((r) => r.name));
  const rankable = rankableColumns(columns).filter((c) => !existing.has(`${c}__rank`));
  if (rankable.length && rowCount > 0) {
    const exprs = rankable.map(
      (c) => `CASE WHEN "${c}" IS NULL THEN NULL ELSE RANK() OVER (ORDER BY "${c}") END::FLOAT AS "${c}__rank"`,
    );
    try {
      // CREATE OR REPLACE is atomic: on any failure the old `data` survives untouched, so we simply
      // leave `hasRank` unset and ProfileStrip uses raw Pearson exactly as before. The `*__rank`
      // columns stay OUT of `columns` (hidden); only the base column's `hasRank` flag is surfaced.
      await conn.query(`CREATE OR REPLACE TABLE data AS SELECT *, ${exprs.join(", ")} FROM data`);
      const ranked = new Set(rankable);
      for (const c of columns) if (ranked.has(c.name)) c.hasRank = true;
    } catch {
      /* best-effort: no ranks → Pearson fallback */
    }
  }

  step("done", 1);
  return { columns, rowCount };
}
