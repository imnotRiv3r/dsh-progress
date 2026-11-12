/**
 * 下载任务台账：把后台任务注册表里「看起来在下载」的任务挑出来，持续采样
 * 磁盘字节，维护一条可展示的状态列表，供 HTTP 路由导出给浏览器半。
 *
 * 只做观察：不消费模型的 job 游标，不改变任务状态，也不影响完成通知。
 * @module dsh-dl-progress/tracker
 */
import { detectDownload } from './detect.js'
import { probeContentLength } from './probe.js'

/** 采样间隔：足够让速度曲线稳定，又不至于压住主进程。 */
const TICK_MS = 700
/** 速度窗口。 */
const SPEED_WINDOW_MS = 5000
/** 每个任务最多保留的样本数。 */
const MAX_SAMPLES = 24

/**
 * 管理所有正在观察的下载任务。
 */
export class DownloadTracker {
  #tasks = new Map()
  #sampler
  #logger
  #cwd
  #settledTtlMs
  #maxTasks
  #ticking = false
  #timer
  #probeTotals

  /**
   * @param options - 采样器、日志与保留策略。
   */
  constructor({ sampler, logger, cwd, settledTtlMs = 12_000, maxTasks = 8, probeTotals = true } = {}) {
    this.#sampler = sampler
    this.#logger = logger
    this.#cwd = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
    this.#settledTtlMs = settledTtlMs
    this.#maxTasks = maxTasks
    this.#probeTotals = probeTotals
  }

  /** 启动采样节拍。 */
  start() {
    if (this.#timer !== undefined) return
    this.#timer = setInterval(() => {
      void this.tick()
    }, TICK_MS)
    if (typeof this.#timer.unref === 'function') this.#timer.unref()
  }

  /** 停止采样。 */
  stop() {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
    this.#tasks.clear()
  }

  /**
   * 消费一条 job 注册表事件。
   * @param event - 注册表的生命周期事件。
   */
  observe(event) {
    try {
      this.#ingest(event)
    } catch (error) {
      this.#logger?.warn?.(`dl-progress: job event failed: ${String(error)}`)
    }
  }

  /**
   * 导出给浏览器的状态。
   * @returns JSON 友好的快照。
   */
  snapshot() {
    const now = Date.now()
    const tasks = [...this.#tasks.values()]
      .filter(task => this.#visible(task, now))
      .sort((left, right) => {
        const leftLive = isLive(left.status) ? 1 : 0
        const rightLive = isLive(right.status) ? 1 : 0
        if (leftLive !== rightLive) return rightLive - leftLive
        return (right.startedAt ?? 0) - (left.startedAt ?? 0)
      })
      .slice(0, this.#maxTasks)
      .map(task => ({
        id: task.id,
        sessionId: task.sessionId ?? null,
        tool: task.tool,
        fileName: task.fileName,
        label: task.label,
        status: task.status,
        startedAt: task.startedAt ?? null,
        finishedAt: task.finishedAt ?? null,
        elapsedMs: Math.max(0, (task.finishedAt ?? now) - (task.startedAt ?? now)),
        bytes: Math.round(task.bytes),
        speed: Math.round(task.speed),
        total: Number.isFinite(task.total) ? Math.round(task.total) : null,
        detail: task.detail ?? null,
        source: task.source ?? 'disk',
      }))
    return { version: 1, now, tasks }
  }

  /**
   * 一轮采样：量所有在跑的任务，顺手清掉过期的结束任务。
   */
  async tick() {
    if (this.#ticking) return
    this.#ticking = true
    try {
      const now = Date.now()
      for (const task of this.#tasks.values()) {
        if (!isLive(task.status)) continue
        const measurement = await this.#sampler.measure({
          tool: task.tool,
          targets: task.targets,
          startedAt: task.startedAt,
          tempBaseline: task.tempBaseline,
        })
        const targetDelta = Math.max(0, measurement.targetBytes - (task.targetBaseline ?? 0))
        const tempDelta = Math.max(0, measurement.tempBytes - (task.tempBaseline ?? 0))
        const bytes = Math.max(targetDelta, tempDelta)
        task.samples.push({ t: now, bytes })
        if (task.samples.length > MAX_SAMPLES) task.samples.splice(0, task.samples.length - MAX_SAMPLES)
        task.bytes = Math.max(task.bytes, bytes)
        task.speed = smoothedSpeed(task, now)
        task.source = tempDelta > targetDelta ? 'temp' : 'target'
      }
      this.#prune(now)
    } catch (error) {
      this.#logger?.debug?.(`dl-progress: sample tick failed: ${String(error)}`)
    } finally {
      this.#ticking = false
    }
  }

  /**
   * 把一条事件并入台账。
   * @param event - 注册表事件，带 `job` 投影。
   */
  #ingest(event) {
    const job = event?.job
    if (job === undefined || job === null) return
    const id = job.id === undefined || job.id === null ? '' : String(job.id)
    if (id === '') return
    const status = typeof job.status === 'string' ? job.status : 'running'
    const existing = this.#tasks.get(id)

    if (isLive(status)) {
      if (existing !== undefined) {
        existing.status = status
        if (typeof job.detail === 'string' && job.detail !== '') existing.detail = job.detail
        return
      }
      const label = typeof job.label === 'string' ? job.label : ''
      const found = detectDownload(label, this.#cwd)
      if (found === null) return
      const startedAt = Number.isFinite(job.startedAt) ? job.startedAt : Date.now()
      const task = {
        id,
        sessionId: job.owner === undefined || job.owner === null ? undefined : String(job.owner),
        tool: found.tool,
        fileName: found.fileName,
        label,
        status,
        startedAt,
        finishedAt: undefined,
        detail: undefined,
        targets: found.targets,
        urls: found.urls,
        tempBaseline: undefined,
        targetBaseline: undefined,
        total: undefined,
        bytes: 0,
        speed: 0,
        source: 'disk',
        samples: [],
      }
      this.#tasks.set(id, task)
      void this.#prime(task)
      void this.#probeTotal(task)
      return
    }

    if (existing === undefined) return
    existing.status = status
    if (existing.finishedAt === undefined) existing.finishedAt = Date.now()
    if (typeof job.detail === 'string' && job.detail !== '') existing.detail = job.detail
  }

  /**
   * 新任务的第一笔基线：目标目录与临时目录各量一次，之后只看增量，
   * 避免把打开前就存在的旧字节算成这次下载。
   * @param task - 新任务。
   */
  async #prime(task) {    try {
      task.tempBaseline = await this.#sampler.baseline(task.tool)
      const measurement = await this.#sampler.measure({
        tool: task.tool,
        targets: task.targets,
        startedAt: task.startedAt,
        tempBaseline: task.tempBaseline,
      })
      task.targetBaseline = measurement.targetBytes
      task.bytes = 0
      task.samples.push({ t: Date.now(), bytes: 0 })
    } catch (error) {
      this.#logger?.debug?.(`dl-progress: baseline failed: ${String(error)}`)
    }
  }

  /**
   * 对单文件 URL 探一次总量。
   *
   * 下载器自己报百分比时用不上它；但静默下载（`curl -s`、输出被管道吞掉）
   * 只靠字节曲线是算不出百分比的，这时服务器的 `content-length` 就是唯一来源。
   * 探测失败（离线、重定向到非 HTTP、服务器不支持 HEAD）只是保持不确定态。
   * @param task - 新任务。
   */
  async #probeTotal(task) {
    if (!this.#probeTotals) return
    const url = Array.isArray(task.urls) && task.urls.length === 1 ? task.urls[0] : undefined
    // 多 URL 的命令（批量下载）没有单一总量，探了也是错的。
    if (url === undefined) return
    try {
      const total = await probeContentLength(url)
      if (total !== undefined && this.#tasks.has(task.id)) task.total = total
    } catch (error) {
      this.#logger?.debug?.(`dl-progress: total probe failed: ${String(error)}`)
    }
  }

  /**
   * 还在不在展示窗口内。
   * @param task - 台账条目。
   * @param now - 当前时间。
   * @returns 是否展示。
   */
  #visible(task, now) {
    if (isLive(task.status)) return true
    if (task.finishedAt === undefined) return false
    return now - task.finishedAt <= this.#settledTtlMs
  }

  /**
   * 清掉过期的结束任务，并限制台账尺寸。
   * @param now - 当前时间。
   */
  #prune(now) {
    for (const [id, task] of this.#tasks) {
      if (!this.#visible(task, now) && !isLive(task.status)) this.#tasks.delete(id)
    }
    if (this.#tasks.size <= this.#maxTasks * 2) return
    const settled = [...this.#tasks.values()]
      .filter(task => !isLive(task.status))
      .sort((left, right) => (left.finishedAt ?? 0) - (right.finishedAt ?? 0))
    while (this.#tasks.size > this.#maxTasks * 2 && settled.length > 0) {
      const victim = settled.shift()
      this.#tasks.delete(victim.id)
    }
  }
}

/**
 * 任务是否还在进行。
 * @param status - job 状态。
 * @returns 是否进行中。
 */
function isLive(status) {
  return status === 'running' || status === 'stopping'
}

/**
 * 用最近窗口的字节差算速度，并做指数平滑，避免采样抖动。
 * @param task - 台账条目。
 * @param now - 当前时间。
 * @returns 每秒字节数。
 */
function smoothedSpeed(task, now) {
  const recent = task.samples.filter(sample => now - sample.t <= SPEED_WINDOW_MS)
  if (recent.length < 2) return task.speed
  const first = recent[0]
  const last = recent[recent.length - 1]
  const seconds = (last.t - first.t) / 1000
  if (seconds < 0.4) return task.speed
  const raw = Math.max(0, (last.bytes - first.bytes) / seconds)
  if (!Number.isFinite(raw)) return task.speed
  return task.speed === 0 ? raw : task.speed * 0.55 + raw * 0.45
}
