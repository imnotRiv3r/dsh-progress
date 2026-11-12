/**
 * 下载命令识别：从后台任务的 `label`（即完整命令文本）判断它是不是在下载，
 * 以及把下载可能落盘的路径解析出来，供采样器统计字节。
 *
 * 只做字面量分析，不执行、不展开变量；识别不到的路径由采样器用 %TEMP% 兜底。
 * @module dsh-progress/detect
 */
import { basename, isAbsolute, join, resolve } from 'node:path'

/** 命令里出现的 URL。 */
const URL_RE = /\b(?:https?|ftp):\/\/[^\s"'`)<>\]]+/gi

/**
 * 各下载器的识别规则，按优先级排列。顺序有意义：`python -m pip` 必须先于
 * 泛化的 `python`，`Invoke-WebRequest` 必须先于一般的 PowerShell 命令。
 */
const RULES = [
  { tool: 'git', re: /\bgit(?:\.exe)?\s+(?:clone|fetch|pull|submodule\s+update|lfs\s+pull)\b/i },
  { tool: 'pip', re: /\bpip3?(?:\.exe)?\s+(?:install|download|wheel)\b/i },
  { tool: 'pip', re: /(?:python3?|py)(?:\.exe)?\s+-m\s+pip\s+(?:install|download|wheel)\b/i },
  { tool: 'uv', re: /\buv\s+(?:pip\s+)?(?:install|add|sync|lock|download|export)\b/i },
  { tool: 'npm', re: /\b(?:npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?\s+(?:i|install|ci|add|dlx|create|update|fetch|rebuild)\b/i },
  { tool: 'aria2', re: /\baria2c?(?:\.exe)?\b/i },
  { tool: 'curl', re: /\bcurl(?:\.exe)?\b/i },
  { tool: 'wget', re: /\bwget(?:\.exe)?\b/i },
  { tool: 'http', re: /\bStart-BitsTransfer\b/i },
  // `Invoke-WebRequest` 最常见的用法是读 API 到内存，只有落到 `-OutFile` 才算下载。
  { tool: 'http', re: /\b(?:Invoke-WebRequest|iwr|Invoke-RestMethod|irm)\b/i, require: /-OutFile\b/i },
  { tool: 'winget', re: /\bwinget(?:\.exe)?\s+(?:install|download)\b/i },
  { tool: 'choco', re: /\bchoco(?:\.exe)?\s+install\b/i },
  { tool: 'scoop', re: /\bscoop\s+(?:install|update)\b/i },
  { tool: 'nuget', re: /\b(?:nuget|dotnet)\s+(?:install|tool\s+install|add\s+package)\b/i },
  { tool: 'cargo', re: /\bcargo\s+(?:install|fetch|vendor|update)\b/i },
  { tool: 'go', re: /\bgo\s+(?:get|mod\s+download)\b/i },
  { tool: 'docker', re: /\bdocker\s+(?:pull|load|save|build)\b/i },
]

/** 只是打印版本、帮助的调用不是下载。 */
const INFO_ONLY_RE = /(?:^|\s)(?:--version|-V|--help|-h|version)(?:\s|$)/i

/** 带值的单字母/长选项，解析位置参数时要跳过它们后面的值。 */
const GIT_VALUE_FLAGS = new Set([
  '--depth',
  '--branch',
  '--origin',
  '--reference',
  '--reference-if-able',
  '--config',
  '--jobs',
  '--filter',
  '--separate-git-dir',
  '--template',
  '--upload-pack',
  '--shallow-since',
  '--shallow-exclude',
  '--server-option',
  '-b',
  '-j',
  '-o',
  '-c',
  '-u',
])

/** 下载器的「写到哪」选项。 */
const OUTPUT_FLAG_RE =
  /(?:^|\s)(-o|-O|--output|--output-document|--out|-OutFile|-Destination|--dest|-d|--destination|--target-dir|--dir|-DownloadFolder|-Path)(?:\s+|=)(?:"([^"]+)"|'([^']+)'|([^\s|;&]+))/gi

/**
 * 识别一个命令标签。
 * @param label - 后台任务的标签（完整命令）。
 * @param cwd - 相对路径的解析基准，通常是 Harness 的工作目录。
 * @returns 命中时给出工具名、展示名与候选落盘路径；否则 `null`。
 */
export function detectDownload(label, cwd) {
  if (typeof label !== 'string' || label.trim() === '') return null
  if (label.length > 8000) return null

  const rule = RULES.find(candidate => candidate.re.test(label))
  if (rule === undefined) return null
  if (rule.require !== undefined && !rule.require.test(label)) return null
  if ((rule.tool === 'curl' || rule.tool === 'wget' || rule.tool === 'aria2') && INFO_ONLY_RE.test(label)) {
    // `curl --version` 之类：没有 URL 也没有输出参数就不算下载。
    URL_RE.lastIndex = 0
    OUTPUT_FLAG_RE.lastIndex = 0
    const hasUrl = URL_RE.test(label)
    const hasOutput = OUTPUT_FLAG_RE.test(label)
    URL_RE.lastIndex = 0
    OUTPUT_FLAG_RE.lastIndex = 0
    if (!hasUrl && !hasOutput) return null
  }

  URL_RE.lastIndex = 0
  OUTPUT_FLAG_RE.lastIndex = 0
  const base = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
  // 命令里常见 `$d="E:\dir"; curl -o "$d\file"` 这种写法，先把赋值收集起来做展开。
  const variables = collectAssignments(label)
  const targets = new Set()
  const urls = []

  for (const match of label.matchAll(URL_RE)) {
    const url = trimUrl(match[0])
    if (url === '') continue
    urls.push(url)
    const name = fileNameOfUrl(url)
    if (name !== '') {
      // 下载器默认把文件放在 cwd；两种落点都纳入采样，路径不存在时采样器会跳过。
      targets.add(resolve(base, name))
      targets.add(resolve(base, `${name}.part`))
      targets.add(resolve(base, `${name}.tmp`))
    }
  }

  for (const match of label.matchAll(OUTPUT_FLAG_RE)) {
    const flag = match[1].toLowerCase()
    const value = match[2] ?? match[3] ?? match[4]
    if (typeof value !== 'string' || value === '' || value.startsWith('-')) continue
    if (value.includes('{{') || value.includes('$(')) continue
    // pip/uv 的下载先落 %TEMP%，-d 目录要等下载完才有文件；遍历它只会白白吃掉预算。
    if ((rule.tool === 'pip' || rule.tool === 'uv') && (flag === '-d' || flag === '--dest')) continue
    const expanded = expandPath(value, variables)
    if (expanded === undefined) continue
    targets.add(isAbsolute(expanded) ? expanded : resolve(base, expanded))
  }

  const gitDirs = rule.tool === 'git' ? gitCloneDirs(label, base, urls, variables) : []
  for (const dir of gitDirs) {
    // 只看 .git：下载中的 pack 就写在这里，而工作树的文件数量可能上万个。
    targets.add(join(dir, '.git'))
  }

  if (rule.tool === 'npm' || rule.tool === 'uv') {
    // 依赖安装的字节主要落在工作目录的 node_modules / .venv 里。
    targets.add(resolve(base, 'node_modules'))
    targets.add(resolve(base, '.venv'))
  }

  return {
    tool: rule.tool,
    cwd: base,
    urls,
    targets: [...targets].filter(target => target !== ''),
    fileName: displayName(rule.tool, label, urls, targets, gitDirs),
  }
}

/**
 * `git clone [选项] <url> [目录]` 的目标目录；缺省时按仓库名推导。
 * @param label - 命令文本。
 * @param base - 解析基准目录。
 * @param urls - 已抽取的 URL。
 * @returns 候选目录列表。
 */
function gitCloneDirs(label, base, urls, variables) {
  const dirs = []
  const match = label.match(/\bgit(?:\.exe)?\s+clone\b([^\n]*)/i)
  const repoName = urls.length > 0 ? repoNameOfUrl(urls[0]) : ''
  if (match !== null) {
    const tokens = match[1].trim().split(/\s+/).filter(token => token !== '')
    const positional = []
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]
      if (token.startsWith('-')) {
        if (GIT_VALUE_FLAGS.has(token)) index += 1
        continue
      }
      positional.push(token)
    }
    const raw = positional[1] === undefined ? '' : stripQuotes(positional[1])
    const dir = raw === '' ? '' : expandPath(raw, variables)
    if (typeof dir === 'string' && dir !== '' && !dir.includes('${')) {
      dirs.push(isAbsolute(dir) ? dir : resolve(base, dir))
      return dirs
    }
  }
  if (repoName !== '') dirs.push(resolve(base, repoName))
  return dirs
}

/** 去掉 URL 尾部的标点。 */
function trimUrl(url) {
  return url.replace(/[.,;:!?'"`)\]}>\\]+$/u, '')
}

/** 去掉 PowerShell/CMD 包在参数外面的引号。 */
function stripQuotes(value) {
  return String(value).replace(/^["']+|["']+$/g, '')
}

/**
 * 收集命令里 `$name="path"` 形式的赋值。
 *
 * `$d="E:\downloads"; curl -o "$d\a.zip" ...` 是很常见的写法，
 * 不展开就永远定位不到下载落点，字节会一直是 0。
 * @param label - 命令文本。
 * @returns 变量名到值的映射。
 */
function collectAssignments(label) {
  const variables = new Map()
  for (const match of label.matchAll(/\$(\w+)\s*=\s*(["'])([^"']*)\2/g)) {
    variables.set(match[1], match[3])
  }
  return variables
}

/**
 * 展开路径里的 `$var`、`${var}`、`$env:NAME`、`%NAME%`。
 * @param value - 原始参数值。
 * @param variables - 命令内收集到的赋值。
 * @returns 展开后的路径；引用了无法解析的变量时返回 `undefined`（宁可不采样，也不猜错路径）。
 */
function expandPath(value, variables) {
  let resolved = true
  const expanded = String(value)
    .replace(/\$env:(\w+)/gi, (_, name) => lookupEnv(name, () => (resolved = false)))
    .replace(/\$\{(\w+)\}/g, (_, name) => lookupVar(name, variables, () => (resolved = false)))
    .replace(/\$(\w+)/g, (_, name) => lookupVar(name, variables, () => (resolved = false)))
    .replace(/%(\w+)%/g, (_, name) => lookupEnv(name, () => (resolved = false)))
  return resolved && expanded !== '' ? expanded : undefined
}

/** 读环境变量，缺失时标记为无法解析。 */
function lookupEnv(name, fail) {
  const value = process.env[name]
  if (value === undefined || value === '') {
    fail()
    return ''
  }
  return value
}

/** 读命令内变量，缺失时标记为无法解析。 */
function lookupVar(name, variables, fail) {
  const value = variables.get(name)
  if (value === undefined) {
    fail()
    return ''
  }
  return value
}

/** URL 最后一段作为文件名线索。 */
function fileNameOfUrl(url) {
  try {
    const parsed = new URL(url)
    const segment = parsed.pathname.split('/').filter(part => part !== '').pop() ?? ''
    if (segment === '') return ''
    const decoded = decodeURIComponent(segment)
    return decoded.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 160)
  } catch {
    return ''
  }
}

/** 从仓库 URL 推导 clone 目录名。 */
function repoNameOfUrl(url) {
  const name = fileNameOfUrl(url)
  return name.replace(/\.git$/i, '')
}

/**
 * 卡片标题：优先具体文件名，其次仓库名/包名，最后退化为命令首行。
 * @param tool - 工具名。
 * @param label - 命令文本。
 * @param urls - 命令里的 URL。
 * @param targets - 候选落盘路径。
 * @param gitDirs - git clone 的目标目录。
 * @returns 一段适合显示的短文本。
 */
function displayName(tool, label, urls, targets, gitDirs) {
  if (gitDirs.length > 0) {
    const name = basename(gitDirs[0])
    if (name !== '' && name !== '.') return name
  }
  if (tool === 'pip' || tool === 'uv' || tool === 'npm') {
    const packageName = packageNameOf(label)
    if (packageName !== '') return packageName
  }
  if (urls.length > 0) {
    const first = fileNameOfUrl(urls[0])
    if (first !== '') return tool === 'git' ? first.replace(/\.git$/i, '') : first
  }
  for (const target of targets) {
    const name = basename(target)
    if (name !== '' && name !== '.' && name !== 'node_modules' && name !== '.venv') return name
  }
  const head = label.trim().split(/\r?\n/)[0]
  return head.length > 60 ? `${head.slice(0, 60)}…` : head
}

/**
 * 从 `pip install x` / `npm i x` / `uv add x` 里取出被安装的包名。
 * @param label - 命令文本。
 * @returns 包名，取不到时为空串。
 */
function packageNameOf(label) {
  const tokens = label.split(/\s+/).filter(token => token !== '')
  const verbs = new Set([
    'install',
    'download',
    'wheel',
    'add',
    'i',
    'ci',
    'dlx',
    'create',
    'update',
    'fetch',
    'sync',
  ])
  const start = tokens.findIndex(token => verbs.has(token.toLowerCase()))
  if (start < 0) return ''
  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.startsWith('-')) {
      // `-r requirements.txt` 这类：跟一个值再继续。
      if (/^-(?:r|c|e|i|f|g|o|d|j)$/i.test(token) || /^--(?:requirement|dest|target|index-url|find-links|output|directory|prefix|root|config-setting|extra-index-url|global-option|no-binary|only-binary)/i.test(token)) {
        index += 1
      }
      continue
    }
    if (/[\\/]/.test(token)) continue
    if (token.includes('==')) return token.split('==')[0]
    if (token.includes('@')) return token.split('@')[0]
    return token
  }
  return ''
}

/**
 * 大小 + 单位 → 字节数；解析不了时返回 `undefined`。
 * @param value - 形如 `12.9`。
 * @param unit - 形如 `MB`、`MiB`、`kB`、`G`。
 * @returns 字节数。
 */
export function parseSize(value, unit) {
  const amount = Number.parseFloat(value)
  if (!Number.isFinite(amount)) return undefined
  const normalized = String(unit ?? '').toLowerCase()
  const decimal = normalized.includes('i') ? 1024 : 1000
  const scale =
    normalized.startsWith('k') ? decimal
    : normalized.startsWith('m') ? decimal ** 2
    : normalized.startsWith('g') ? decimal ** 3
    : normalized.startsWith('t') ? decimal ** 4
    : 1
  return amount * scale
}
