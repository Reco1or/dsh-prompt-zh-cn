/**
 * dsh-prompt-zh-cn — 在运行时把 DeepSeek Harness 内置的
 * 系统提示词（sections）、运行时上下文（contexts）与工具定义（tools）
 * 整体替换为中文。
 *
 * 设计要点：
 *  - 包装 `systemPrompt.assemble()` 与 `systemPrompt.refreshContext()`，
 *    在组装结果返回后做整树替换；这样连 `complete: true` 的人格提示词也能覆盖。
 *  - 工具定义在注册/解析时原地翻译描述与参数 schema，原生执行器、PTC SDK、
 *    以及系统提示词里的工具声明会同时得到中文。
 *  - 所有文本按「精确匹配 → 空白折叠匹配 → 正则模板」三级查找；
 *    命中不了就原样返回，绝不猜测或破坏协议标记。
 *  - 不修改任何 DSH 源码，卸载插件即恢复英文。
 *
 * 设计参考：dsh-harness-zh-cn（MIT，zjl1989-li），详见 README「来源与致谢」与
 * THIRD_PARTY_NOTICES.md。
 *
 * @module dsh-prompt-zh-cn
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Cordis 插件名。 */
export const name = 'dsh-prompt-zh-cn'

/** 依赖的系统提示词注册表与工具注册表。 */
export const inject = ['systemPrompt', 'tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const DICT_DIR = join(HERE, '..', 'dict')

/** 读取一个 JSON 字典；失败时返回空表而不是中断插件加载。 */
function loadJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(join(DICT_DIR, file), 'utf8'))
  } catch (error) {
    console.warn(`[dsh-prompt-zh-cn] 无法读取 ${file}: ${error?.message ?? error}`)
    return fallback
  }
}

const SECTION_ENTRIES = loadJson('sections.json', [])
const TOOL_DESCRIPTIONS = {
  ...loadJson('tool-descriptions.json', {}),
  ...loadJson('tool-descriptions-extra.json', {}),
}
const TOOL_FIELDS = {
  ...loadJson('tool-fields.json', {}),
  ...loadJson('tool-fields-extra.json', {}),
}
const PHRASES = loadJson('phrases.json', {})
const MESSAGES = loadJson('messages.json', {})

/** 把任意空白折叠成单个空格，用于容忍源码拼接处的差异。 */
function collapse(text) {
  return text.replace(/\s+/g, ' ').trim()
}

/** 构建「英文 → 中文」精确表；同时索引空白折叠后的键。 */
function buildMap(source) {
  const map = new Map()
  for (const [en, zh] of Object.entries(source)) {
    if (typeof en !== 'string' || typeof zh !== 'string' || en.length === 0) continue
    map.set(en, zh)
    const folded = collapse(en)
    if (folded !== en && !map.has(folded)) map.set(folded, zh)
  }
  return map
}

const PHRASE_MAP = buildMap(PHRASES)
const TOOL_DESC_MAP = buildMap(TOOL_DESCRIPTIONS)
const TOOL_FIELD_MAP = buildMap(TOOL_FIELDS)
const SKILL_LINE_MAP = buildMap(MESSAGES.skillCatalog?.lines ?? {})
const SKILL_DESCRIPTION_MAP = buildMap(MESSAGES.skillCatalog?.descriptions ?? {})
const TIME_CONTEXT = MESSAGES.timeContext ?? {}

/** 文本里是否还残留明显的英文句子（用于诊断漏译）。 */
function looksEnglish(text) {
  return /[A-Za-z]{3,}/.test(text) && !/[\u4e00-\u9fff]/.test(text)
}

/** 展开译文中的 $1..$9 / $0 与 $$，避免 String.replace 的 $ 语义干扰。 */
function expand(template, match) {
  return template.replace(/\$(\$|\d)/g, (whole, token) => {
    if (token === '$') return '$'
    const index = Number(token)
    return match[index] ?? whole
  })
}

/** 在精确表里查找；返回 undefined 表示没有命中。 */
function lookupExact(map, text) {
  const direct = map.get(text)
  if (direct !== undefined) return direct
  const folded = collapse(text)
  if (folded !== text) return map.get(folded)
  return undefined
}

/** 段落/行级回退：整段没有命中时，逐行应用精确表。 */
function translateGeneric(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  const whole = lookupExact(PHRASE_MAP, text)
  if (whole !== undefined) return whole
  const paragraphs = text.split(/\n\n/)
  if (paragraphs.length > 1) {
    let changed = false
    const mapped = paragraphs.map((paragraph) => {
      const hit = translateGeneric(paragraph)
      if (hit !== paragraph) changed = true
      return hit
    })
    if (changed) return mapped.join('\n\n')
  }
  const lines = text.split('\n')
  if (lines.length > 1) {
    let changed = false
    const mapped = lines.map((line) => {
      const hit = lookupExact(PHRASE_MAP, line)
      if (hit !== undefined) { changed = true; return hit }
      return line
    })
    if (changed) return mapped.join('\n')
  }
  return text
}

/** 按名称分组的 section/context 条目。 */
const NAMED = new Map()
for (const entry of SECTION_ENTRIES) {
  if (!entry || typeof entry !== 'object') continue
  if (typeof entry.name !== 'string' || typeof entry.zh !== 'string') continue
  const key = `${entry.kind}:${entry.name}`
  const list = NAMED.get(key) ?? []
  list.push(entry)
  NAMED.set(key, list)
}

/** 应用一条命名条目；没有匹配返回 undefined。 */
function applyEntry(entry, text) {
  const match = entry.match ?? 'exact'
  if (match === 'exact') {
    if (typeof entry.en !== 'string') return undefined
    const direct = text === entry.en
    const folded = !direct && collapse(text) === collapse(entry.en)
    return direct || folded ? entry.zh : undefined
  }
  if (match === 'regex') {
    if (typeof entry.en !== 'string') return undefined
    let regex
    try {
      regex = new RegExp(entry.en, entry.flags ?? '')
    } catch (error) {
      console.warn(`[dsh-prompt-zh-cn] 非法正则 ${entry.id}: ${error?.message ?? error}`)
      return undefined
    }
    const result = regex.exec(text)
    if (result === null) return undefined
    return text.replace(regex, (...args) => expand(entry.zh, args))
  }
  return undefined
}

/** 特殊处理器：结构过于动态、无法用单条正则覆盖的段落。 */
const SPECIAL = {
  'context:subagent:identity': translateSubagentIdentity,
  'section:tools:sdk': translateToolsSdk,
}

function replaceLines(text, rules) {
  let out = text
  for (const [regex, builder] of rules) {
    out = out.replace(regex, (...args) => builder(args))
  }
  return out
}

/** 子代理身份上下文：根代理/子代理名称与两条协作提示。 */
function translateSubagentIdentity(text) {
  return replaceLines(text, [
    [/^You are the root agent\. Your name is ("[^"]*")\.$/m, (m) => `你是指挥根代理。你的名称是 ${m[1]}。`],
    [/^You are a subagent delegated by agent ("[^"]*")\.$/m, (m) => `你是由代理 ${m[1]} 委派的子代理。`],
    [/^Your name is ("[^"]*")\.$/m, (m) => `你的名称是 ${m[1]}。`],
    [/^The root agent of your collaboration tree is ("[^"]*")\.$/m, (m) => `你的协作树根代理是 ${m[1]}。`],
    [/^To message other agents, use send_message\(\{ agent: "<agent-name>", message: "\.\.\." \}\)\.$/m,
      () => '要向其他代理发送消息，请使用 send_message({ agent: "<agent-name>", message: "..." })。'],
    [/^Use list_agents\(\{\}\) to find your collaborator agents and their names\.$/m,
      () => '使用 list_agents({}) 查找你的协作代理及其名称。'],
    [/^Your agent id is ("[^"]*")\. Your subagent tree root is unavailable\. Continue independent work; subagent discovery and messaging require an active root\.$/m,
      (m) => `你的代理 id 是 ${m[1]}。你的子代理树根不可用。继续独立工作；子代理发现和消息传递需要活动的根。`],
  ])
}

/** PTC 模式 `tools:sdk`：翻译固定说明文字，保留生成的声明代码。 */
function translateToolsSdk(text) {
  let out = text
  const rules = [
    [/^## Writing code for run_code$/m, () => '## 为 run_code 编写代码'],
    [/^`run_code` takes two required arguments: `code`, the body of an async TypeScript function \(erasable syntax only — no `enum` or namespaces; type annotations are advisory, the code runs type-stripped\), and `description`, a short summary of what the program does\. The declarations below are SDK bindings for this program\. A declaration does not make its name a directly callable tool; only names supplied as separate tool schemas may be called directly\.$/m,
      () => '`run_code` 接受两个必填参数：`code`，一个异步 TypeScript 函数的函数体（仅限可擦除语法——不能使用 `enum` 或命名空间；类型注解只是提示，代码会剥离类型后运行）；以及 `description`，对程序所做事情的简短说明。下面的声明是本程序的 SDK 绑定。声明本身并不会使其名称成为可直接调用的工具；只有作为独立工具 schema 提供的名称才能直接调用。'],
    [/^`run_code` takes two required arguments: `code`, the program to execute, and `description`, a short summary of what the program does\. The declarations below are SDK bindings for this program\. A declaration does not make its name a directly callable tool; only names supplied as separate tool schemas may be called directly\.$/m,
      () => '`run_code` 接受两个必填参数：`code`，要执行的程序；以及 `description`，对程序所做事情的简短说明。下面的声明是本程序的 SDK 绑定。声明本身并不会使其名称成为可直接调用的工具；只有作为独立工具 schema 提供的名称才能直接调用。'],
    [/^Inside the program:$/m, () => '程序内部：'],
    [/^- Call tools as `await tools\.name\(args\)` — quoted access for exotic names: `tools\["my-tool"\]\(args\)`\. Every call resolves to the tool's typed canonical JSON value\. Tool arguments must be lossless JSON\.$/m,
      () => '- 以 `await tools.name(args)` 调用工具；特殊名称用带引号的访问方式：`tools["my-tool"](args)`。每次调用都会解析为该工具带类型的规范 JSON 值。工具参数必须是可无损表示的 JSON。'],
    [/^- A FAILED tool call rejects with `ToolCallError`, whose `toolName` identifies the failed tool and whose `message` is human-readable — `try\/catch` it to handle and continue\.$/m,
      () => '- 失败的工具调用会以 `ToolCallError` 拒绝，其 `toolName` 标识失败的工具，`message` 为可读文本——用 `try/catch` 处理并继续。'],
    [/^- Independent read-only calls MAY overlap under `Promise\.all` \(safe calls run concurrently; mutating calls run alone, in submission order\)\. Sequence dependent work with `await`\.$/m,
      () => '- 相互独立的只读调用可以在 `Promise.all` 下重叠执行（安全调用并发运行；修改型调用按提交顺序单独运行）。有依赖关系的工作用 `await` 串行化。'],
    [/^- Emit results with `return` and\/or `console\.log\(\.\.\.\)`\. Only what you print or return is program output\. A successful tool result containing an image is attached after the run so you can inspect it on the next step; every other intermediate result stays out of the conversation, so extract just what you need\.$/m,
      () => '- 用 `return` 和/或 `console.log(...)` 输出结果。只有你打印或返回的内容才是程序输出。包含图片的成功工具结果会在运行结束后附加，以便你在下一步查看；其他所有中间结果都不会进入对话，因此只提取你需要的内容。'],
    [/^- Only values emitted as program output enter the conversation\. A successful tool result containing an image is attached after the run so you can inspect it on the next step; every other intermediate result stays out of the conversation, so extract just what you need\.$/m,
      () => '- 只有作为程序输出发出的值才会进入对话。包含图片的成功工具结果会在运行结束后附加，以便你在下一步查看；其他所有中间结果都不会进入对话，因此只提取你需要的内容。'],
    [/^Program-only SDK bindings:$/m, () => '仅程序内的 SDK 绑定：'],
    [/^ When no separate `bash` schema is supplied, invoke a declared `bash` binding inside `run_code`:$/m,
      () => ' 当没有单独提供 `bash` schema 时，在 `run_code` 内调用已声明的 `bash` 绑定：'],
  ]
  out = replaceLines(out, rules)
  return out
}

/** 把 15m 1s 这类紧凑时长转成中文单位。 */
function translateDurationZh(value) {
  if (value === 'unavailable') return '不可用'
  return value
    .replace(/(\d+)d/g, (_, n) => `${n} 天`)
    .replace(/(\d+)h/g, (_, n) => `${n} 小时`)
    .replace(/(\d+)m/g, (_, n) => `${n} 分`)
    .replace(/(\d+)s/g, (_, n) => `${n} 秒`)
}

/**
 * time-context 的 durable 快照消息：
 * `Time sampled while preparing turn N, step M: ...` 等三行。
 */
function translateTimeContextText(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  return text.split('\n').map((line) => {
    let match
    if ((match = /^Time sampled while preparing turn (\d+), step (\d+): (.+)$/.exec(line))) {
      return expand(TIME_CONTEXT.sampled ?? line, [line, match[1], match[2], match[3]])
    }
    if ((match = /^Browser time zone for this request: mixed (.*)\. Ask the user to clarify otherwise-unqualified dates and times\.$/.exec(line))) {
      return expand(TIME_CONTEXT.browserMixed ?? line, [line, match[1]])
    }
    if (line === 'Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.') {
      return TIME_CONTEXT.browserMissing ?? line
    }
    if ((match = /^Browser time zone for this request: (.+)\. Interpret otherwise-unqualified dates and times in this zone\.$/.exec(line))) {
      return expand(TIME_CONTEXT.browserResolved ?? line, [line, match[1]])
    }
    if ((match = /^Elapsed since the preceding model-visible message: (.+)\.$/.exec(line))) {
      return expand(TIME_CONTEXT.elapsedModel ?? line, [line, translateDurationZh(match[1])])
    }
    if ((match = /^Elapsed since the preceding step context: (.+)\.$/.exec(line))) {
      return expand(TIME_CONTEXT.elapsedStep ?? line, [line, translateDurationZh(match[1])])
    }
    return line
  }).join('\n')
}

/**
 * skill-catalog 的 `<system-reminder>` 消息：
 * 翻译框架句与内置技能描述，保留技能名、`<available_skills>` 标签和未知技能原文。
 */
function translateSkillCatalogText(text) {
  if (typeof text !== 'string' || text.length === 0) return text
  return text.split('\n').map((line) => {
    const trimmed = line.trim()
    const lineHit = lookupExact(SKILL_LINE_MAP, trimmed)
    if (lineHit !== undefined) return line.replace(trimmed, lineHit)
    const entry = /^- `([^`]+)`: (.*)$/.exec(trimmed)
    if (entry !== null) {
      const description = lookupExact(SKILL_DESCRIPTION_MAP, entry[2])
      if (description !== undefined) return line.replace(trimmed, `- \`${entry[1]}\`: ${description}`)
    }
    return line
  }).join('\n')
}

/**
 * 翻译 deriveMessages() 返回的消息数组：只克隆 time-context / skill-catalog，
 * 其余消息原样复用。返回新数组，不修改会话日志里的冻结消息。
 */
function translateDerivedMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages
  let changed = false
  const out = []
  for (const message of messages) {
    const kind = message?.source?.kind
    const translator = kind === 'time-context'
      ? translateTimeContextText
      : kind === 'skill-catalog' ? translateSkillCatalogText : undefined
    if (translator === undefined || !Array.isArray(message.content)) {
      out.push(message)
      continue
    }
    let messageChanged = false
    const content = []
    for (const block of message.content) {
      if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
        const next = translator(block.text)
        if (next !== block.text) {
          content.push({ ...block, text: next })
          messageChanged = true
          continue
        }
      }
      content.push(block)
    }
    if (messageChanged) {
      changed = true
      out.push({ ...message, content })
    } else {
      out.push(message)
    }
  }
  return changed ? out : messages
}

/** 包装 session.deriveMessages()，在请求构建前替换模型可见的历史注入消息。 */
function patchSessionMessages(session, restore) {
  if (session === null || typeof session !== 'object' || typeof session.deriveMessages !== 'function') return
  if (patchedSessions.has(session)) return
  patchedSessions.add(session)
  const original = session.deriveMessages
  const wrapped = function (...args) {
    const messages = original.apply(this, args)
    try {
      return translateDerivedMessages(messages)
    } catch (error) {
      console.warn(`[dsh-prompt-zh-cn] 历史消息翻译失败: ${error?.message ?? error}`)
      return messages
    }
  }
  try {
    session.deriveMessages = wrapped
    restore.push(() => {
      if (session.deriveMessages === wrapped) session.deriveMessages = original
      patchedSessions.delete(session)
    })
  } catch (error) {
    patchedSessions.delete(session)
    console.warn(`[dsh-prompt-zh-cn] 无法包装 deriveMessages: ${error?.message ?? error}`)
  }
}

const patchedSessions = new WeakSet()

const misses = new Map()
let missCount = 0

function recordMiss(kind, source, text) {
  if (!looksEnglish(text)) return
  missCount++
  if (misses.size >= 300) return
  const key = `${kind}|${source}|${collapse(text).slice(0, 120)}`
  if (!misses.has(key)) misses.set(key, { kind, name: source, text })
}

/** 翻译一个 section 或 context。 */
function translateNamed(kind, name, text) {
  if (typeof text !== 'string' || text.length === 0) return text
  const list = NAMED.get(`${kind}:${name}`)
  if (list !== undefined) {
    for (const entry of list) {
      const result = applyEntry(entry, text)
      if (result !== undefined) return result
    }
  }
  const special = SPECIAL[`${kind}:${name}`]
  if (special !== undefined) {
    const result = special(text)
    if (result !== text) return result
  }
  const generic = translateGeneric(text)
  if (generic !== text) return generic
  recordMiss(kind, name, text)
  return text
}

/** 递归翻译 schema 里的 description/title。 */
function translateSchemaNode(node, seen) {
  if (node === null || typeof node !== 'object') return
  if (seen.has(node)) return
  seen.add(node)
  if (typeof node.description === 'string') {
    const hit = lookupExact(TOOL_FIELD_MAP, node.description)
    if (hit !== undefined) node.description = hit
    else recordMiss('field', '', node.description)
  }
  if (typeof node.title === 'string') {
    const hit = lookupExact(TOOL_FIELD_MAP, node.title)
    if (hit !== undefined) node.title = hit
  }
  for (const [key, value] of Object.entries(node)) {
    // 属性名本身可能就叫 description/title；只有字符串值才是注解。
    if ((key === 'description' || key === 'title') && typeof value === 'string') continue
    translateSchemaNode(value, seen)
  }
}

/** 翻译一条工具定义（原地）。 */
function translateDefinition(definition, seen = new WeakSet()) {
  if (definition === null || typeof definition !== 'object' || seen.has(definition)) return
  seen.add(definition)
  if (typeof definition.description === 'string') {
    const hit = lookupExact(TOOL_DESC_MAP, definition.description)
    if (hit !== undefined) definition.description = hit
    else {
      const generic = translateGeneric(definition.description)
      if (generic !== definition.description) definition.description = generic
      else recordMiss('tool', typeof definition.name === 'string' ? definition.name : '', definition.description)
    }
  }
  translateSchemaNode(definition.parameters, new Set())
  if (definition.output && typeof definition.output === 'object') {
    translateSchemaNode(definition.output.schema, new Set())
  }
}

/** 翻译一次组装结果（原地）。 */
function translateAssembly(assembly, options = {}) {
  if (assembly === null || typeof assembly !== 'object') return assembly
  try {
    if (options.sections !== false && Array.isArray(assembly.sections)) {
      for (const section of assembly.sections) {
        if (section === null || typeof section !== 'object') continue
        section.text = translateNamed('section', section.name, section.text)
      }
    }
  } catch (error) {
    console.warn(`[dsh-prompt-zh-cn] section 翻译失败: ${error?.message ?? error}`)
  }
  try {
    if (options.contexts !== false && Array.isArray(assembly.contexts)) {
      for (const context of assembly.contexts) {
        if (context === null || typeof context !== 'object') continue
        context.text = translateNamed('context', context.name, context.text)
      }
    }
  } catch (error) {
    console.warn(`[dsh-prompt-zh-cn] context 翻译失败: ${error?.message ?? error}`)
  }
  try {
    if (options.tools !== false && Array.isArray(assembly.tools)) {
      for (const tool of assembly.tools) translateDefinition(tool)
    }
  } catch (error) {
    console.warn(`[dsh-prompt-zh-cn] tool 翻译失败: ${error?.message ?? error}`)
  }
  return assembly
}

/** 包装一个服务方法，返回恢复函数。 */
function wrapMethod(service, method, wrap) {
  const original = service?.[method]
  if (typeof original !== 'function') return () => {}
  let wrapped
  try {
    wrapped = wrap(function (...args) { return original.apply(service, args) })
    service[method] = wrapped
  } catch (error) {
    console.warn(`[dsh-prompt-zh-cn] 无法包装 ${method}: ${error?.message ?? error}`)
    return () => {}
  }
  return () => {
    if (service[method] === wrapped) service[method] = original
  }
}

/** Cordis 插件入口。 */
export function apply(ctx, config = {}) {
  const options = {
    sections: config.sections !== false,
    contexts: config.contexts !== false,
    tools: config.tools !== false,
    messages: config.messages !== false,
    diagFile: typeof config.diagFile === 'string' ? config.diagFile : undefined,
    verbose: config.verbose === true,
  }

  const prompt = ctx.systemPrompt
  const tools = ctx.get?.('tools') ?? ctx.tools
  let dumped = false

  /** 可选：把首次组装结果与漏译样本写到诊断文件，便于核对覆盖率。 */
  function maybeDump(assembly) {
    if (options.diagFile === undefined || dumped) return
    dumped = true
    try {
      const payload = {
        generatedAt: new Date().toISOString(),
        sections: assembly?.sections ?? [],
        contexts: assembly?.contexts ?? [],
        tools: assembly?.tools ?? [],
        misses: [...misses.values()],
        missCount,
      }
      writeFileSync(options.diagFile, JSON.stringify(payload, null, 2), 'utf8')
      if (options.verbose) console.info(`[dsh-prompt-zh-cn] 诊断快照已写入 ${options.diagFile}（漏译 ${missCount} 处）`)
    } catch (error) {
      console.warn(`[dsh-prompt-zh-cn] 诊断写入失败: ${error?.message ?? error}`)
    }
  }

  const restore = []

  if (prompt !== undefined) {
    restore.push(wrapMethod(prompt, 'assemble', (original) => async function (...args) {
      const assembly = await original.apply(this, args)
      // 兜底：即使 agent/created 没覆盖到，也在这里补挂该 agent 的 session。
      try {
        patchSessionMessages(args[0]?.agent?.session, restore)
      } catch (error) {
        console.warn(`[dsh-prompt-zh-cn] 补挂 session 失败: ${error?.message ?? error}`)
      }
      translateAssembly(assembly, options)
      maybeDump(assembly)
      return assembly
    }))
    restore.push(wrapMethod(prompt, 'refreshContext', (original) => function (...args) {
      const assembly = original.apply(this, args)
      translateAssembly(assembly, options)
      return assembly
    }))
  }

  if (tools !== undefined && options.tools) {
    // 只读遍历一次已注册定义；之后新注册的工具由 assemble 时的 assembly.tools 覆盖。
    try {
      for (const definition of tools.definitions?.() ?? []) translateDefinition(definition)
    } catch (error) {
      console.warn(`[dsh-prompt-zh-cn] 遍历已有工具失败: ${error?.message ?? error}`)
    }
  }

  if (options.messages) {
    // 包装每个 agent 所属 session 的 deriveMessages()：模型请求构建前，
    // 历史里的 time-context / skill-catalog 会被替换成中文克隆，不改会话日志。
    const hookAgent = (agent) => {
      patchSessionMessages(agent?.session, restore)
    }
    const agents = ctx.get?.('agents')
    try {
      if (typeof agents?.list === 'function') for (const agent of agents.list()) hookAgent(agent)
      const disposeCreated = ctx.on('agent/created', ({ agent }) => hookAgent(agent), { global: true })
      if (typeof disposeCreated === 'function') restore.push(disposeCreated)
    } catch (error) {
      console.warn(`[dsh-prompt-zh-cn] 无法监听 agent/created: ${error?.message ?? error}`)
    }
  }

  ctx.effect(() => () => {
    for (const undo of restore.reverse()) {
      try { undo() } catch { /* 卸载时尽力恢复 */ }
    }
  }, 'dsh-prompt-zh-cn: restore patched services')

  if (options.verbose) {
    console.info(`[dsh-prompt-zh-cn] 已启用：sections=${options.sections} contexts=${options.contexts} tools=${options.tools}`)
  }
}

/** Cordis 加载器同时接受具名导出与默认导出。 */
export default { name, inject, apply }