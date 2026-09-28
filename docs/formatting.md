# Code formatting / 代码格式化

Prettier is pinned to `3.9.9` with single quotes, no semicolons, two-space indentation, a 120-column width, and LF endings. Generated output and registry snapshots are ignored. Git checks out text files with LF endings and keeps automatic binary detection.

Run `pnpm format` to format supported files, or `pnpm format:check` to check them without changing files. CI runs the same check on Linux.

Prettier 固定为 `3.9.9`：单引号、不加分号、两个空格缩进、每行 120 列，并使用 LF 换行。生成文件和 Registry 快照会被忽略。Git 会将文本文件以 LF 检出，二进制文件保留自动识别。

运行 `pnpm format` 格式化支持的文件，或运行 `pnpm format:check` 仅检查、不修改文件。CI 会在 Linux 上运行相同检查。
