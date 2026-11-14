# 第三方声明

本插件（`dsh-prompt-zh-cn`）以 MIT 许可证发布。下列项目未直接包含在本包的运行时代码中，但其设计、术语、文档或原文对本插件有重要参考作用；按 MIT 许可证要求保留其版权与许可声明。

## dsh-harness-zh-cn

- 项目：`dsh-harness-zh-cn`
- 作者/维护者：`zjl1989-li`
- 仓库：https://github.com/zjl1989-li/dsh-harness-zh-cn
- 许可证：MIT
- 参考方式：借鉴其“运行时汉化 DSH 系统提示词/工具定义”的设计思路、词典组织方式与术语；针对 DSH `0.2.2-rc.3` 重写了接入方式（`systemPrompt.assemble/refreshContext` + `tools.register/resolve`），并重新整理、翻译了词典。本包不包含原项目的运行时代码或词典副本。

以下为原项目 MIT 许可证原文：

```text
MIT License

Copyright (c) 2026 dsh-harness-zh contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## DeepSeek Harness

- 项目：DeepSeek Harness（`@deepseek-ai/dsh`）
- 许可证：MIT
- 参考方式：本插件的英文提示词、工具 schema 与官方中文对照取自本机安装的 DSH `0.2.2-rc.3` 及其 `docs/` 文档；运行时只调用 DSH 的公开插件 API，不修改或再分发 DSH 源码。