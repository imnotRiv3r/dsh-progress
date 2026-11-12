/**
 * Host 半：把下载类后台任务的磁盘增长做成一份可轮询的状态。
 *
 * 浏览器半不能读文件系统，所以这里在 Host 侧采样，并通过
 * `ctx.webServer.register()` 暴露一个只读 JSON 路由给同源的 Web GUI。
 * 插件只观察 job 注册表，不消费模型游标、不改变任务状态。
 *
 * @module dsh-dl-progress
 */
import z from '@deepseek-ai/schemastery'
import { DiskSampler } from './lib/sampler.js'
import { DownloadTracker } from './lib/tracker.js'

/** 状态路由；浏览器半用同一常量拼 URL。 */
export const STATE_PATH = '/plugin/dl-progress/state'

/** 只需要 job 注册表；提示词与 HTTP 路由都是可选增强。 */
export const inject = ['jobs']

/**
 * 行配置。全部 `volatile()`，这样插件面板能渲染出可编辑表单。
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile().description('总开关：关闭后不再识别下载任务，也不注册状态路由。'),
  guidePrompt: z
    .boolean()
    .default(true)
    .volatile()
    .description('在系统提示词里加一小段引导：下载类命令优先 run_in_background，并带进度友好的参数。'),
  settledTtlMs: z
    .number()
    .default(12_000)
    .volatile()
    .description('任务结束后卡片继续保留的毫秒数（浏览器半另有一段淡出时间）。'),
  maxTasks: z.number().default(8).volatile().description('同时最多展示的下载任务数量。'),
  sampleBudgetMs: z
    .number()
    .default(220)
    .volatile()
    .description('单轮磁盘采样的时间预算（毫秒）；调大更准，调小更省。'),
  probeTotals: z
    .boolean()
    .default(true)
    .volatile()
    .description('对单文件 URL 发一次 HEAD 取总大小：让静默下载也能显示百分比。'),
  workingDirectory: z
    .string()
    .default('')
    .volatile()
    .description('解析命令里相对路径的基准目录；留空使用 Harness 进程的工作目录。'),
})

/** 提示词段的顺序：排在内置指导之后、persona 后缀之前。 */
const PROMPT_ORDER = 9000

/** 提示词段名。 */
const PROMPT_NAME = 'plugin:dl-progress/download-guidance'

/** 引导模型让下载可被观察。 */
const PROMPT_TEXT = [
  'When a command downloads something (git clone/fetch/pull, pip/uv/npm/pnpm/yarn install,',
  'curl/wget/aria2c, Invoke-WebRequest, winget/choco/scoop install, cargo/go/docker pull),',
  'run it with `run_in_background: true` so the user sees a live download card, and add',
  'progress-friendly flags where they exist (`git clone --progress`, `curl -# -L`; wget and',
  'aria2c already report progress). Foreground downloads block the turn and show no card.',
].join(' ')

/**
 * 安装插件。
 * @param ctx - 插件上下文。
 * @param config - 行配置。
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  if (!settings.enabled) {
    ctx.logger.debug('dl-progress: disabled by config')
    return
  }

  const sampler = new DiskSampler({
    budgetMs: settings.sampleBudgetMs,
    logger: ctx.logger,
  })
  const tracker = new DownloadTracker({
    sampler,
    logger: ctx.logger,
    cwd: settings.workingDirectory,
    settledTtlMs: settings.settledTtlMs,
    maxTasks: settings.maxTasks,
    probeTotals: settings.probeTotals,
  })

  const unsubscribe = ctx.jobs.events.subscribe({ owners: 'all' }, event => {
    tracker.observe(event)
  })
  tracker.start()

  const disposeRoute = installStateRoute(ctx, tracker)
  const disposePrompt = installPrompt(ctx, settings)

  ctx.effect(() => () => {
    unsubscribe()
    disposeRoute?.()
    disposePrompt?.()
    tracker.stop()
  })
}

/**
 * 注册只读状态路由。webServer 可能稍后才就绪，所以带几次重试。
 * @param ctx - 插件上下文。
 * @param tracker - 任务台账。
 * @returns disposer，或者拿不到服务时为 undefined。
 */
function installStateRoute(ctx, tracker) {
  let dispose
  let attempts = 0
  let timer
  // 浏览器半每 600ms 轮询一次；计数用来判断它到底有没有挂载。
  const stats = { hits: 0, lastHitAt: 0 }

  const attempt = () => {
    if (dispose !== undefined) return
    const server = ctx.get('webServer')
    if (server !== undefined && server !== null && typeof server.register === 'function') {
      try {
        dispose = server.register({
          kind: 'exact',
          path: STATE_PATH,
          resource: request => {
            stats.hits += 1
            stats.lastHitAt = Date.now()
            try {
              const url = new URL(request.url ?? '/', 'http://dsh.invalid')
              const diag = url.searchParams.get('diag')
              if (diag !== null && diag !== '') stats.diag = diag.slice(0, 4000)
            } catch {
              // 诊断参数只是调试用，解析失败不影响状态返回。
            }
            return new Response(JSON.stringify({ ...tracker.snapshot(), poll: stats }), {
              headers: {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
              },
            })
          },
        })
        return
      } catch (error) {
        ctx.logger.warn(`dl-progress: cannot register ${STATE_PATH}: ${String(error)}`)
        return
      }
    }
    attempts += 1
    if (attempts >= 20) {
      ctx.logger.warn('dl-progress: webServer never became available; the progress card stays idle')
      return
    }
    timer = setTimeout(attempt, 500)
    if (typeof timer.unref === 'function') timer.unref()
  }

  attempt()

  return () => {
    if (timer !== undefined) clearTimeout(timer)
    const current = dispose
    dispose = undefined
    if (typeof current === 'function') current()
  }
}

/**
 * 注入一小段下载引导，让模型把下载放进后台任务、并带上进度友好参数。
 * @param ctx - 插件上下文。
 * @param settings - 归一化后的配置。
 * @returns disposer，或者不需要/不可用时为 undefined。
 */
function installPrompt(ctx, settings) {
  if (!settings.guidePrompt) return undefined
  const prompt = ctx.get('systemPrompt')
  if (prompt === undefined || prompt === null || typeof prompt.section !== 'function') return undefined
  try {
    const dispose = prompt.section({
      name: PROMPT_NAME,
      order: PROMPT_ORDER,
      text: PROMPT_TEXT,
    })
    return typeof dispose === 'function' ? dispose : undefined
  } catch (error) {
    ctx.logger.warn(`dl-progress: cannot add system prompt section: ${String(error)}`)
    return undefined
  }
}

/**
 * 把 loader 传入的配置整理成确定的形状。
 * @param config - 行配置，可能为空。
 * @returns 归一化设置。
 */
function normalizeConfig(config) {
  const value = config !== null && typeof config === 'object' ? config : {}
  const number = (input, fallback, min, max) => {
    const parsed = Number(input)
    if (!Number.isFinite(parsed)) return fallback
    return Math.min(max, Math.max(min, parsed))
  }
  return {
    enabled: value.enabled !== false,
    guidePrompt: value.guidePrompt !== false,
    settledTtlMs: number(value.settledTtlMs, 12_000, 1_000, 120_000),
    maxTasks: Math.round(number(value.maxTasks, 8, 1, 32)),
    sampleBudgetMs: Math.round(number(value.sampleBudgetMs, 220, 50, 2_000)),
    probeTotals: value.probeTotals !== false,
    workingDirectory:
      typeof value.workingDirectory === 'string' && value.workingDirectory.trim() !== ''
        ? value.workingDirectory.trim()
        : process.cwd(),
  }
}
