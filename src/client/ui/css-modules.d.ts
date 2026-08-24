/**
 * Ambient faces of the bundle's CSS pipeline: `*.module.css` imports
 * are compiled by the tsdown dsh-css-modules-inline plugin (lightningcss,
 * hashed `[hash]_[local]` class names) into a default-exported class map with
 * a self-injecting `<style data-plugin>` side effect; plain `*.css` is not
 * used by this package but declared for parity with the reference preset's
 * src/css-modules.d.ts.
 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css' {
  const classes: Record<string, string>
  export default classes
}
