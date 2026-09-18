import { readFileSync } from 'node:fs'

/** package.json engines.dsh owns the exact host target; other declarations are checked against it. */
export const DSH_SOURCE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).engines.dsh
if (typeof DSH_SOURCE_VERSION !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(DSH_SOURCE_VERSION)) {
  throw new Error('package.json engines.dsh must name one exact released host version')
}
export const DSH_SOURCE_TAG = `dsh-v${DSH_SOURCE_VERSION}`
export const DSH_COMPAT_RANGE = DSH_SOURCE_VERSION
