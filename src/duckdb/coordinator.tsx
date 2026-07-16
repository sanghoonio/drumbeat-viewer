/**
 * DuckDB-wasm + Mosaic coordinator, as a React context singleton.
 *
 * We let Mosaic's `wasmConnector()` own the DuckDB-wasm instance (a single copy —
 * avoids the two-duckdb-versions clash), then ask it for that instance via
 * `getDuckDB()` / `getConnection()` so we can register a DROPPED file into it.
 *
 * See plans/2026-07-02-analysis-viewer-duckdb-vgplot.md.
 */
import * as vg from "@uwdata/vgplot";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ingestFile, type ColumnInfo } from "./ingest";

// Non-null while a dropped file is being ingested (parse + derive + rank precompute) —
// drives the full-screen loading overlay. `frac` is a rough phase-weighted fraction.
export interface LoadingState {
  name: string;
  label: string;
  frac: number;
}

interface CoordinatorState {
  coordinator: any | null; // vg.Coordinator
  db: any | null; // duckdb AsyncDuckDB (from the connector)
  conn: any | null; // duckdb AsyncDuckDBConnection (from the connector)
  ready: boolean;
  columns: ColumnInfo[];
  rowCount: number;
  fileName: string | null;
  loading: LoadingState | null;
  loadFile: (file: File) => Promise<void>;
  loadUrl: (url: string, name?: string) => Promise<void>;
  clear: () => void;
  error: string | null;
}

const Ctx = createContext<CoordinatorState | null>(null);

export function CoordinatorProvider({ children }: { children: ReactNode }) {
  const coordinatorRef = useRef<any>(null);
  const dbRef = useRef<any>(null);
  const connRef = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [fileName, setFileName] = useState<string | null>(null);
  const [loading, setLoading] = useState<LoadingState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const connector = vg.wasmConnector();
        const coordinator = new vg.Coordinator(connector);
        // Force init + grab the backing instance so file-drop can register into it.
        const db = await connector.getDuckDB();
        const conn = await connector.getConnection();
        if (cancelled) return;
        coordinatorRef.current = coordinator;
        dbRef.current = db;
        connRef.current = conn;
        setReady(true);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const state = useMemo<CoordinatorState>(() => {
    const loadFile = async (file: File) => {
      if (!dbRef.current || !connRef.current) throw new Error("duckdb not ready");
      setError(null);
      setLoading({ name: file.name, label: "reading file…", frac: 0 });
      try {
        const { columns, rowCount } = await ingestFile(
          dbRef.current,
          connRef.current,
          file,
          (label, frac) => setLoading({ name: file.name, label, frac }),
        );
        coordinatorRef.current?.clear({ clients: true, cache: true });
        setColumns(columns);
        setRowCount(rowCount);
        setFileName(file.name);
      } catch (e) {
        setError(String(e));
        throw e;
      } finally {
        setLoading(null);
      }
    };
    // Fetch a presigned export straight from R2 (atlas "Open in viewer" opens us with the URL in
    // the fragment), then hand the bytes to the SAME ingest path a dropped file takes. Bytes go
    // R2→browser; nothing proxies them. The URL is time-limited and single-use, so on failure we
    // don't retry — the App surfaces the error and the user reopens from atlas.
    const loadUrl = async (url: string, name = "export.parquet") => {
      if (!dbRef.current) throw new Error("duckdb not ready");
      setError(null);
      setLoading({ name, label: "downloading export…", frac: 0.02 });
      let file: File;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        file = new File([await res.blob()], name);
      } catch {
        setError("Couldn't load this export (the link may have expired). Reopen it from atlas.");
        setLoading(null);
        return;
      }
      await loadFile(file);
    };
    return {
      coordinator: coordinatorRef.current,
      db: dbRef.current,
      conn: connRef.current,
      ready,
      columns,
      rowCount,
      fileName,
      loading,
      error,
      loadFile,
      loadUrl,
      clear: () => {
        setError(null);
        setColumns([]);
        setRowCount(0);
        setFileName(null);
        connRef.current?.query("DROP TABLE IF EXISTS data").catch(() => {});
        coordinatorRef.current?.clear({ clients: true, cache: true });
      },
    };
  }, [ready, columns, rowCount, fileName, loading, error]);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export function useCoordinator(): CoordinatorState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useCoordinator must be used within CoordinatorProvider");
  return v;
}
