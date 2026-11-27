/**
 * Where likeness loads its data files from: ict/ (face model), hands/ (hand
 * models). In the demo that's the app's public folder. When likeness is used
 * as a library, the build sets it to the "assets/" folder next to the bundle;
 * apps can override it with setAssetBase(), or pass explicit URLs per option.
 */
let base: string | null = null;

export function setAssetBase(url: string | URL): void {
  const s = String(url);
  base = s.endsWith("/") ? s : `${s}/`;
}

export function assetBase(): string {
  if (base) return base;
  const env = (import.meta as { env?: { BASE_URL?: string } }).env;
  return env?.BASE_URL ?? "/";
}

/** e.g. assetUrl("ict") -> "<base>ict" (no trailing slash). */
export function assetUrl(path: string): string {
  return assetBase() + path.replace(/^\//, "").replace(/\/$/, "");
}
