/**
 * File → DuckDB table. Registers a dropped file's bytes and creates the `data`
 * table from it, inferring the reader from the extension. Then introspects the
 * schema via DESCRIBE so the color-by controls can be built generically.
 *
 * TODO (per plan): multi-file drop + join on post_id (drop embeddings + affect +
 * topic separately and JOIN into `data`). v1 handles a single combined export.
 */
import { classifyColumns, type ColumnInfo } from "../lib/columns";

export type { ColumnInfo };

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

export async function ingestFile(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  file: File,
): Promise<{ columns: ColumnInfo[]; rowCount: number }> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const ext = file.name.toLowerCase().split(".").pop() || "parquet";
  const vname = `upload-${++uploadSeq}.${ext}`;
  const reader = readerFor(vname, ext); // validates the extension before we register
  await db.registerFileBuffer(vname, buf);
  await conn.query(`CREATE OR REPLACE TABLE data AS SELECT * FROM ${reader}`);
  // `data` is materialized; free the buffer (unique name means no future collision anyway).
  await db.dropFile?.(vname)?.catch(() => {});

  const desc = await conn.query(`DESCRIBE data`);
  const columns = classifyColumns(
    desc.toArray().map((r: any) => ({
      name: String(r.column_name),
      type: String(r.column_type),
    })),
  );

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
  return { columns, rowCount };
}
