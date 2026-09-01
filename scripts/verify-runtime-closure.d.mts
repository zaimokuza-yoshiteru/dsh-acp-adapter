export interface MissingRelativeRuntimeImport {
  readonly file: string
  readonly specifier: string
  readonly resolved: string
}

export function findMissingRelativeRuntimeImports(
  files: readonly string[],
  readFile: (file: string) => string,
): MissingRelativeRuntimeImport[]
