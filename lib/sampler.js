/**
 * 磁盘字节采样器：给下载任务估一个「已写入多少字节」的曲线。
 *
 * 下载器本身很少在非 TTY 管道里报告进度（实测 pip/npm 不会），所以这里直接
 * 看文件系统：先量命令里解析出来的目标路径，再用系统临时目录的新增量兜底。
 * 每次采样带时间预算，避免大目录（node_modules）拖慢 Harness 主进程。
 * @module dsh-progress/sampler
 */
import { lstat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 临时目录里属于某个下载器的条目名。按工具限定前缀，比「最近改动」稳得多：
 * Windows 的 %TEMP% 里常年躺着成百上千个无关的 `.tmp` 残留。
 */
const TEMP_TOOL_PREFIXES = {
  pip: /^(?:pip[-_]|uv-|python-)/i,
  uv: /^(?:pip[-_]|uv-)/i,
  npm: /^(?:npm-|pnpm|npx-|yarn-)/i,
  git: /^(?:git-)/i,
  default: /^(?:pip[-_]|uv-|npm-|pnpm|npx-|yarn-|git-|winget-|choco-|scoop-)/i,
}

/** 浏览器/下载器写到一半的文件名后缀。 */
const PARTIAL_SUFFIX_RE = /\.(?:part|partial|crdownload|opdownload|download)\d*$/i

/**
 * 有预算的磁盘字节统计器。
 *
 * 目录遍历有两条硬约束：总时间预算与总条目上限。下载目录往往夹着几万个
 * 历史文件（比如同一目录里旧的仓库副本），放任遍历会拖垮 Host 主进程，
 * 也会把本该留给 %TEMP% 的时间吃掉。
 */
export class DiskSampler {
  #budgetMs
  #depth
  #maxEntries
  #logger

  /**
   * @param options - 预算与日志。
   */
  constructor({ budgetMs = 260, depth = 3, maxEntries = 4000, logger } = {}) {
    this.#budgetMs = budgetMs
    this.#depth = depth
    this.#maxEntries = maxEntries
    this.#logger = logger
  }

  /**
   * 量一个任务当前写入了多少字节。
   * @param task - 采样上下文：目标路径、启动时间与临时目录基线。
   * @returns 目标与临时目录的原始字节读数。
   */
  async measure(task) {
    const startedAt = Date.now()
    // 两路各留预算：目标目录不能把临时目录那一份时间吃光。
    const targetDeadline = startedAt + Math.round(this.#budgetMs * 0.45)
    const tempDeadline = startedAt + this.#budgetMs
    const state = { entries: this.#maxEntries }

    const targets = Array.isArray(task.targets) ? task.targets : []
    let targetBytes = 0
    for (const target of targets) {
      if (Date.now() > targetDeadline || state.entries <= 0) break
      targetBytes += await this.#sizeOf(target, targetDeadline, 0, state)
    }

    let tempBytes = 0
    try {
      tempBytes = await this.#tempBytes(task.tool, tempDeadline, state)
    } catch (error) {
      this.#logger?.debug?.(`dsh-progress: temp scan failed: ${String(error)}`)
    }

    // 只报原始读数：增量由调用方对着任务开始时的基线算，目录里原有内容不算下载量。
    return {
      targetBytes,
      tempBytes,
      complete: Date.now() <= tempDeadline,
    }
  }

  /**
   * 打开任务时量一次临时目录基线，后续只看增量。
   * 与 `measure` 使用同一套前缀过滤，两条曲线才可比。
   * @param tool - 下载器名。
   * @returns 基线字节数。
   */
  async baseline(tool) {
    try {
      return await this.#tempBytes(tool, Date.now() + this.#budgetMs, { entries: this.#maxEntries })
    } catch (error) {
      this.#logger?.debug?.(`dsh-progress: temp baseline failed: ${String(error)}`)
      return 0
    }
  }

  /**
   * 单个路径的字节数：文件取大小，目录按深度、时间与条目预算递归。
   * @param path - 绝对路径。
   * @param deadline - 时间预算截止点。
   * @param depth - 当前递归深度。
   * @param state - 跨路径共享的剩余条目额度。
   * @returns 字节数；不存在、不可读或超额时为已统计的部分。
   */
  async #sizeOf(path, deadline, depth, state) {
    if (typeof path !== 'string' || path === '') return 0
    if (state.entries <= 0 || Date.now() > deadline) return 0
    let stats
    try {
      stats = await lstat(path)
    } catch {
      return 0
    }
    if (stats.isFile()) return stats.size
    if (!stats.isDirectory()) return 0
    if (depth >= this.#depth) return 0
    let total = 0
    let entries
    try {
      entries = await readdir(path, { withFileTypes: true })
    } catch {
      return 0
    }
    for (const entry of entries) {
      if (Date.now() > deadline || state.entries <= 0) break
      state.entries -= 1
      const child = join(path, entry.name)
      if (entry.isDirectory()) total += await this.#sizeOf(child, deadline, depth + 1, state)
      else if (entry.isFile()) {
        try {
          const childStats = await lstat(child)
          total += childStats.size
        } catch {
          // 被并发删除的临时文件：跳过。
        }
      }
    }
    return total
  }

  /**
   * 系统临时目录里属于某个下载器的字节总和。
   * @param tool - 下载器名；用于挑选该下载器的临时条目前缀。
   * @param deadline - 时间预算截止点。
   * @param state - 跨路径共享的剩余条目额度。
   * @returns 字节数。
   */
  async #tempBytes(tool, deadline, state) {
    const root = tmpdir()
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      return 0
    }
    const prefix = TEMP_TOOL_PREFIXES[tool] ?? TEMP_TOOL_PREFIXES.default
    let total = 0
    for (const entry of entries) {
      if (Date.now() > deadline || state.entries <= 0) break
      if (!prefix.test(entry.name) && !PARTIAL_SUFFIX_RE.test(entry.name)) continue
      const full = join(root, entry.name)
      let stats
      try {
        stats = await lstat(full)
      } catch {
        continue
      }
      state.entries -= 1
      if (stats.isFile()) total += stats.size
      else if (stats.isDirectory()) total += await this.#sizeOf(full, deadline, 0, state)
    }
    return total
  }
}
