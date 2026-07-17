/** Full-area drop target (shown until a dataset is loaded). Font styled to match the
 * atlas/pegasus error page (light heading, muted caption); keeps the dashed drop box. */
import { useRef, useState } from "react";
import { Upload } from "lucide-react";

export function DropZone({
  onFile,
  onDemo,
  error,
}: {
  onFile: (f: File) => void;
  onDemo?: () => void;
  error: string | null;
}) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 pb-16">
      <div className="text-xl font-thin tracking-wide">
        <span className="font-normal text-primary">atlas</span> viewer
      </div>
      <button
        type="button"
        className={`w-[420px] max-w-full cursor-pointer rounded-box border-2 border-dashed p-10 text-center transition-colors ${
          over ? "border-primary bg-primary/5" : "border-base-300 hover:border-base-content/30"
        }`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
      >
        <Upload className="mx-auto mb-3 size-6 text-base-content" />
        <p className="text-base font-light text-base-content">drop an export (parquet)</p>
        <p className="mt-2 text-xs text-base-content/50">or click to browse</p>
        <input
          ref={inputRef}
          type="file"
          accept=".parquet,.csv,.tsv,.json,.ndjson"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
          }}
        />
      </button>
      {onDemo && (
        <button
          type="button"
          className="cursor-pointer text-xs text-base-content/50 underline-offset-2 transition-colors hover:text-base-content hover:underline"
          onClick={onDemo}
        >
          try the demo dataset
        </button>
      )}
      {error && <p className="max-w-md text-center text-xs text-error">{error}</p>}
    </div>
  );
}
