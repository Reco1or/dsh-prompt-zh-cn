# 中文提示词（dsh-prompt-zh-cn）

DeepSeek Harness 中文提示词插件：在运行时把 DSH 内置的**系统提示词 sections**、**运行时上下文**、**自动注入消息**与**工具定义**替换为中文，不修改任何 DSH 源码，卸载即恢复英文。

> 中文名：**中文提示词**；包名：`dsh-prompt-zh-cn`。
>
> GUI 原始会话记录与模型实际收到的内容可能不同，原因见 [GUI 原始记录与模型侧内容的差异](#gui-原始记录与模型侧内容的差异)。

> 本项目**借鉴并重构**了 [zjl1989-li/dsh-harness-zh-cn](https://github.com/zjl1989-li/dsh-harness-zh-cn)（MIT）；
> 
> 差异与本项目重写的部分见文末「来源与致谢」及 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## 它翻译什么

- **系统提示词 sections**：身份行、部署人格前缀、计划模式策略、团队策略、各内置工具的使用指导、文件引用规范、交付物规范、结构化输出指令、PTC 模式说明等。
- **运行时上下文**：当前工作目录、沙箱文件策略、审批策略、委派限制、Harness 检出目录、Web GUI URL、子代理身份等。
- **工具定义**：内置工具的描述（`description`）以及参数 schema 中每一层 `description` / `title`，覆盖原生工具模式与 PTC 模式。
- **自动注入的上下文消息**：`time-context` 的时间快照、`skill-catalog` 的 `<system-reminder>` 框架句与内置技能描述。

工具名称、参数名、命令、路径、`[exit code: N]`、`[sandbox: ...]`、`<system-reminder>` 等机器协议标识保持原样，不改变 DSH 的解析与执行行为。

## 安装

### 从 GitHub 安装

打开 **设置 → 插件 → 添加插件**，输入以下任一 spec：

```text
github:Reco1or/dsh-prompt-zh-cn
git+https://github.com/Reco1or/dsh-prompt-zh-cn.git
```

检查后安装并启用；如果提示重启，重启 DSH。若 profile 里已经用 `link:` 装了同名包，先移除本地 bundle 再装 GitHub 版本。

### 从本地目录安装（开发用）

把本目录作为本地 bundle 安装：

1. 打开 **设置 → 插件**；
2. 选择 **添加插件**，指向本目录（包含 `package.json` 与 `cordis.patch.yml` 的目录）；
3. 启用后新建会话即可生效。

> 替换已安装插件的文件或修改 `dict/` 后，运行中的进程可能仍缓存旧模块；请重启 DSH 以载入新模块与词典。首次全新安装通常可直接热应用。

也可以由 `plugin_manager` 安装：

```text
plugin_manager({ action: "install_bundle", target: "<本目录的绝对路径>" })
```

## 配置

安装后可在 profile 的 `cordis.patch.yml` 中按 id 覆盖配置：

```yaml
- id: dsh-prompt-zh-cn
  config:
    sections: true    # 翻译系统提示词 sections
    contexts: true    # 翻译运行时上下文
    tools: true       # 翻译工具描述与参数描述
    messages: true    # 翻译 time-context / skill-catalog 注入消息
    diagFile: ""      # 可选：写入首次组装快照与漏译样本的绝对路径
    verbose: false
```

`diagFile` 仅用于排查覆盖率：写入一次组装结果、工具 schema 与未命中的英文文本，不含用户消息。

## 工作原理

- 包装 `ctx.systemPrompt.assemble()` 与 `refreshContext()`，在组装结果返回后按名称/文本替换 sections 与 contexts。这样也能覆盖声明为 `complete: true` 的完整人格提示词。
- 启动时只读遍历 `ctx.tools.definitions()` 翻译已注册定义；之后新注册/作用域工具由 `assemble()` 返回的 `assembly.tools` 统一翻译（原生执行器与 PTC `tools:sdk` 的共同来源），不包装 `tools` 服务方法。
- 包装每个 agent 所属 session 的 `deriveMessages()`：在每次请求构建历史前，把 `time-context` / `skill-catalog` 消息克隆并翻译成中文；不修改会话日志与 `source.entries`。因此当前会话里已有的英文快照/目录也会在模型侧变成中文。
- 文本匹配顺序：精确匹配 → 空白折叠匹配 → 正则模板；未命中时原样返回并记录诊断，不做猜测性替换。

## GUI 原始记录与模型侧内容的差异

本插件会翻译两类由 DSH 自动注入的消息：

- `time-context`：时间采样快照（当前时间、浏览器时区、距上一条消息的间隔）；
- `skill-catalog`：技能目录的 `<system-reminder>` 框架句与内置技能描述。

这两类消息有一个容易误解的现象：**GUI 的“上下文注入”里仍可能显示英文，但模型实际收到的是中文。**

### 为什么会这样

DSH 的会话有两层：

| 层 | 内容 | 本插件是否修改 |
| --- | --- | --- |
| 会话日志 / GUI 原始记录 | `Session` 里持久化的原始消息事件，消息对象是 deep-frozen、共享的 | 否 |
| 模型请求历史 | 每次请求前由 `session.deriveMessages()` 派生的消息数组 | 是 |

- 会话日志是事实记录，插件不应该、也无法安全地改写它；GUI 的时间线/上下文注入面板读取的是这一层，所以会显示创建时的英文原文。
- 模型请求历史是 `deriveMessages()` 每次重新派生的数组。插件包装这个方法，只把 `source.kind` 为 `time-context` / `skill-catalog` 的消息**克隆**一份、替换其中的文本块，再返回给模型请求构建器。
- 原始消息和 `source.entries` 不被修改；用户消息、工具结果、技能正文也不会被扫描或改写。

因此：

- **模型侧**：看到的是中文；
- **GUI 原始记录**：仍是英文；
- 两者不一致是设计结果，不是翻译失败。

### 覆盖范围

- 历史里已经存在的英文 `time-context` / `skill-catalog` 消息也会在每次请求时被翻译，不需要新建会话。
- `skill-catalog` 只翻译框架句与内置技能描述；用户/第三方技能描述保持原文，技能名与 `<available_skills>` 标签不动。
- 技能正文（加载后的 `SKILL.md` 内容）不在翻译范围内。

### 为什么不在 GUI 层也改

GUI 直接渲染持久化事件；要改它就得改写会话日志或前端渲染，前者会破坏 DSH 的消息不可变性，后者需要客户端插件并依赖前端内部结构。本插件的目标是“模型看到中文”，不是“重写历史记录”，所以选择只改模型请求派生层。

### 附：会话标题为什么仍是英文

DSH 的会话标题由独立的 `dsh-session-title-first-prompt-llm` / `dsh-session-title-all-prompts-llm` provider 生成。它用**自己的英文 system prompt** 单独调用模型，不经过 `systemPrompt.assemble()`，也不经过本插件的 `deriveMessages()` 包装，因此本插件无法影响标题语言。

标题 prompt 里虽然写了 “Use the language of the messages”，但同时给了英文示例 “such as Greeting”；模型有时会直接沿用英文，甚至把中文首条消息 “你好” 标题成 “Greeting”。这是标题 provider 的模型行为，不是本插件造成的。需要中文标题时，可在会话列表里手动重命名；或者另做一个专门改写标题 prompt 的插件。

## 覆盖范围与限制

- 覆盖 DSH `0.2.2-rc.3` 当前 Desktop profile，以及随发行版提供的 `standard`、`ptc`、`minimal`、`cordis` 四个内置预设所用到的系统提示词 section、运行时上下文、77 个内置工具 schema（含 PTC 模式 `run_code` 的固定说明段落），以及 `time-context` / `skill-catalog` 注入消息。
- MCP 服务器自带的外部工具描述、第三方插件自定义的提示词、用户自己的 `AGENTS.md`、技能正文（加载后的 `SKILL.md` 内容）与工具输出不翻译。
- 会话日志本身保持原样；插件只在模型请求的历史派生中替换文本，UI 的原始会话记录仍可能显示英文。新请求与历史消息都会翻译。
- 技能目录只翻译框架句与内置技能描述；用户/第三方技能的描述保持原文。
- 可选的 Computer Use（CUA）、Stagehand 浏览器等独立可选包自带的整段提示词不在默认覆盖内；它们未安装时不会出现。
- 内部辅助提示（会话标题、压缩摘要、插件市场描述）不属于系统提示词，不在此插件范围内。
- DSH 升级若改动内置提示词措辞，未命中的段落会保持英文；可通过 `diagFile` 定位后补充字典。

## 卸载

在插件页停用或移除本插件，下一次请求即恢复英文提示词；不残留任何源码改动。

## 来源与致谢

本插件**借鉴并重构**了 [zjl1989-li/dsh-harness-zh-cn](https://github.com/zjl1989-li/dsh-harness-zh-cn)（MIT License，Copyright (c) 2026 dsh-harness-zh contributors）。原项目面向旧版 DSH，通过 `system-prompt/assemble` 瀑布、`commands.list` 与客户端 `locale.lookup` 做汉化；本项目针对 DSH `0.2.2-rc.3` 重新实现了运行时接入（`systemPrompt.assemble/refreshContext` + `session.deriveMessages`），并重新整理、扩充了系统提示词与工具定义词典。原项目的词典组织方式与术语（agent→代理、job→任务、session→会话、provider→提供方、fiber→纤程）给了我们重要参考。

本插件不包含原项目的运行时代码或词典副本；如后续合并其内容，请同时保留其 MIT 版权与许可声明。完整第三方声明见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

DeepSeek Harness 及其官方中文文档同样以 MIT 许可证发布；本插件的英文原文与工具 schema 取自本机安装的 DSH `0.2.2-rc.3`。

## 许可证

MIT