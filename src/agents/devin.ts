/** Devin's separate model sessions permit bounded parallel discovery. */
export const devinModelProbeOptions = {
  probeModelConfigOptions: true,
  probeModelConfigConcurrency: 8,
} as const
