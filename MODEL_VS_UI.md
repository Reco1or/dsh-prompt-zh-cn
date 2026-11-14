# GUI 原始记录与模型侧内容的差异

本插件会翻译两类由 DSH 自动注入的消息：

- `time-context`：时间采样快照（当前时间、浏览器时区、距上一条消息的间隔）；
- `skill-catalog`：技能目录的 `<system-reminder>` 框架句与内置技能描述。

这两类消息有一个容易误解的现象：**GUI 的“上下文注入”里仍可能显示英文，但模型实际收到的是中文。**

## 为什么会这样

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

## 覆盖范围

- 历史里已经存在的英文 `time-context` / `skill-catalog` 消息也会在每次请求时被翻译，不需要新建会话。
- `skill-catalog` 只翻译框架句与内置技能描述；用户/第三方技能描述保持原文，技能名与 `<available_skills>` 标签不动。
- 技能正文（加载后的 `SKILL.md` 内容）不在翻译范围内。

## 为什么不在 GUI 层也改

GUI 直接渲染持久化事件；要改它就得改写会话日志或前端渲染，前者会破坏 DSH 的消息不可变性，后者需要客户端插件并依赖前端内部结构。本插件的目标是“模型看到中文”，不是“重写历史记录”，所以选择只改模型请求派生层。

## 附：会话标题为什么仍是英文

DSH 的会话标题由独立的 `dsh-session-title-first-prompt-llm` / `dsh-session-title-all-prompts-llm` provider 生成。它用**自己的英文 system prompt** 单独调用模型，不经过 `systemPrompt.assemble()`，也不经过本插件的 `deriveMessages()` 包装，因此本插件无法影响标题语言。

标题 prompt 里虽然写了 “Use the language of the messages”，但同时给了英文示例 “such as Greeting”；模型有时会直接沿用英文，甚至把中文首条消息 “你好” 标题成 “Greeting”。这是标题 provider 的模型行为，不是本插件造成的。需要中文标题时，可在会话列表里手动重命名；或者另做一个专门改写标题 prompt 的插件。