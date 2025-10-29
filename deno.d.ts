// Override Deno APIs that should not be used directly
// Use util/temp.ts instead for these methods:
declare namespace Deno {
  /**
   * @deprecated Use {@link ~/util/temp.ts} instead.
   * @see {@link ~/util/temp.ts#makeTempDir}
   */
  export function makeTempDir(options?: MakeTempOptions): Promise<never>;
  /**
   * @deprecated Use {@link ~/util/temp.ts} instead.
   * @see {@link ~/util/temp.ts#makeTempDirSync}
   */
  export function makeTempDirSync(options?: MakeTempOptions): never;
  /**
   * @deprecated Use {@link ~/util/temp.ts} instead.
   * @see {@link ~/util/temp.ts#makeTempFile}
   */
  export function makeTempFile(options?: MakeTempOptions): Promise<never>;
  /**
   * @deprecated Use {@link ~/util/temp.ts} instead.
   * @see {@link ~/util/temp.ts#makeTempFileSync}
   */
  export function makeTempFileSync(options?: MakeTempOptions): never;
}
