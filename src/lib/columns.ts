/**
 * Column classification for the generic color-by controls. Maps DuckDB column
 * types to a kind the scatter uses to pick a color scale.
 *
 * TODO (per plan): refine categorical vs id via distinct-count probes; detect
 * signed columns (min<0<max) to prefer a diverging scale.
 */
export interface ColumnInfo {
  name: string;
  type: string;
  kind: "continuous" | "categorical" | "id";
  signed?: boolean; // continuous column with <= 0 (or null-only) values → log scale unsafe
  hasRank?: boolean; // a "<name>__rank" column was precomputed at ingest (Spearman via Pearson-on-ranks)
}

const NUMERIC =
  /(INT|DECIMAL|NUMERIC|REAL|DOUBLE|FLOAT|HUGEINT|BIGINT|SMALLINT|TINYINT|UINTEGER|UBIGINT)/i;

// columns that are identifiers / not meaningful to color by
const ID_LIKE = /(^post_id$|_id$|^url$|^document$|_keywords$|^text$)/i;

export function classifyColumns(
  raw: { name: string; type: string }[],
): ColumnInfo[] {
  return raw.map(({ name, type }) => {
    let kind: ColumnInfo["kind"];
    if (ID_LIKE.test(name)) kind = "id";
    else if (NUMERIC.test(type)) kind = "continuous";
    else kind = "categorical";
    return { name, type, kind };
  });
}

/** default fill: a cluster column if present, else first continuous, else none */
export function defaultColorBy(cols: ColumnInfo[]): string | null {
  const cluster = cols.find((c) => c.name === "cluster");
  if (cluster) return cluster.name;
  const cont = cols.find((c) => c.kind === "continuous");
  return cont?.name ?? null;
}

/** best-guess x/y columns for the embedding scatter — numeric (continuous) only, so a
 * VARCHAR column that happens to be named umap_x can't be handed to the scatter as an axis */
export function defaultXY(cols: ColumnInfo[]): { x: string | null; y: string | null } {
  const cont = new Set(cols.filter((c) => c.kind === "continuous").map((c) => c.name));
  const x = ["umap_x", "x", "umap_1", "tsne_x"].find((n) => cont.has(n)) ?? null;
  const y = ["umap_y", "y", "umap_2", "tsne_y"].find((n) => cont.has(n)) ?? null;
  return { x, y };
}
