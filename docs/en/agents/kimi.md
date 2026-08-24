# Kimi

[中文](../../agents/kimi.md) | [English](kimi.md)

## CLI check

The locally verified Kimi CLI exposes these entry points:

```bash
kimi --version
kimi login
kimi doctor
kimi acp --help
```

Log in and repair health through Kimi's own CLI or browser flow. The plugin references
opaque configuration, credential, and OAuth paths in Kimi's data home. It does not read,
copy, or log their values.

## DSH configuration

Select the Kimi template and wait for health to become `ready` before creating an ACP
session. Models and reasoning options come from the config options returned by that agent
session. If no live option exists, the UI does not guess or fabricate model identity. Do
not enter credentials or environment-variable values in DSH; select the Kimi template in
the ACP panel and run the check again. Kimi text, tools, and context occupancy follow the
same ACP display boundary as other supported agents.
