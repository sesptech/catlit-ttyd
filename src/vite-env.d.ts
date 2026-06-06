// Vite environment type augmentations.
//
// `?inline` returns the file contents as a string at build time so we
// can embed a vendored stylesheet (e.g. xterm.css) inside the Lit
// component's shadow DOM via `<style>${cssText}</style>`. Without this
// shim, `tsc --noEmit` rejects the import.

declare module "*.css?inline" {
  const cssText: string;
  export default cssText;
}
