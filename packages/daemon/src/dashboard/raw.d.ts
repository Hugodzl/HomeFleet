/**
 * `import text from "./file.ext?raw"` yields the file's contents as a string.
 * Vitest (Vite) implements `?raw` natively; the tsup build implements it with
 * the `rawText` esbuild plugin in packages/daemon/tsup.config.ts. Used only
 * to embed the dashboard's static assets into the daemon bundle.
 */
declare module "*?raw" {
  const content: string;
  export default content;
}
