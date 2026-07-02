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

function readerFor(name: string): string {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "parquet") return `read_parquet('${name}')`;
  if (ext === "csv" || ext === "tsv") return `read_csv_auto('${name}')`;
  if (ext === "json" || ext === "ndjson") return `read_json_auto('${name}')`;
  throw new Error(`unsupported file type: .${ext} (use parquet, csv, or json)`);
}

export async function ingestFile(
  db: AsyncDuckDB,
  conn: AsyncDuckDBConnection,
  file: File,
): Promise<{ columns: ColumnInfo[]; rowCount: number }> {
  const buf = new Uint8Array(await file.arrayBuffer());
  // Drop any prior registration of this name first: re-uploading a file with the same name
  // (e.g. a re-exported topic) otherwise reuses DuckDB-wasm's cached parquet metadata against
  // the new bytes → "Snappy decompression failure: Uncompressed data size mismatch".
  await db.dropFile?.(file.name)?.catch(() => {});
  await db.registerFileBuffer(file.name, buf);
  await conn.query(
    `CREATE OR REPLACE TABLE data AS SELECT * FROM ${readerFor(file.name)}`,
  );
  // `data` is now a materialized table; the file buffer is no longer needed. Free it so the
  // next upload starts from a clean slate regardless of filename.
  await db.dropFile?.(file.name)?.catch(() => {});

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
