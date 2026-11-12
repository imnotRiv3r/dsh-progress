/**
 * 冒烟测试：命令识别、进度解析、浏览器半的注册与展示逻辑。
 *
 * 不联网、不依赖真实下载：样本来自真实命令输出（git clone / pip / curl）。
 * 运行：node test/smoke.mjs
 */
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { detectDownload } from '../lib/detect.js'
import { probeContentLength } from '../lib/probe.js'

const pluginSource = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// ---------- 1. 命令识别 ----------
const detectCases = [
  ['git clone --progress https://github.com/expressjs/express E:\\ws\\express_clone', 'git', 'express_clone'],
  ['Remove-Item x; git clone --depth 1 https://github.com/microsoft/TypeScript "E:\\ws\\ts" 2>&1', 'git', 'ts'],
  ['python -m pip download numpy --no-deps -d E:\\ws', 'pip', 'numpy'],
  ['pip install requests==2.31.0', 'pip', 'requests'],
  ['pnpm add lodash', 'npm', 'lodash'],
  ['curl -L -o out.zip https://example.com/a.zip', 'curl', 'a.zip'],
  ['aria2c -d C:\\dl -o file.zip https://example.com/file.zip', 'aria2', 'file.zip'],
  ['Invoke-WebRequest -Uri https://example.com/y.exe -OutFile C:\\dl\\y.exe', 'http', 'y.exe'],
  ['Start-BitsTransfer -Source https://example.com/a.zip -Destination C:\\dl\\a.zip', 'http', 'a.zip'],
  ['winget install Git.Git', 'winget', 'winget install Git.Git'],
]
for (const [label, tool, fileName] of detectCases) {
  const found = detectDownload(label, 'E:\\ws')
  assert.ok(found !== null, `应识别为下载: ${label}`)
  assert.equal(found.tool, tool, `工具名不符: ${label}`)
  assert.equal(found.fileName, fileName, `展示名不符: ${label}`)
}

const notDownload = [
  'echo hello',
  'git status',
  'git fetch --all'.replace('fetch', 'status'),
  'curl --version',
  'Start-Sleep 1; Invoke-WebRequest -Uri "http://127.0.0.1:2482/plugin/dsh-progress/state" -UseBasicParsing',
  'npm run build',
  'python -m pip list',
]
for (const label of notDownload) {
  assert.equal(detectDownload(label, 'E:\\ws'), null, `不应识别为下载: ${label}`)
}

// git 只采样 .git；pip 不采样 -d 目录（下载先落 %TEMP%）
const gitTargets = detectDownload('git clone https://github.com/a/b "E:\\ws\\b"', 'E:\\ws').targets
assert.ok(gitTargets.includes('E:\\ws\\b\\.git'), 'git 应采样 .git')
const pipTargets = detectDownload('python -m pip download numpy -d E:\\ws', 'E:\\ws').targets
assert.deepEqual(pipTargets, [], 'pip 不应把 -d 目录当作采样目标')

// 命令内变量必须展开，否则采样永远定位不到落点
const variableLabel =
  '$d="E:\\ws\\dl"; New-Item -ItemType Directory -Force -Path $d | Out-Null; curl.exe -s -L -o "$d\\optuna.whl" "https://mirror.example/x/numpy.whl"'
const variableTargets = detectDownload(variableLabel, 'E:\\ws').targets
assert.ok(variableTargets.includes('E:\\ws\\dl\\optuna.whl'), '应展开 $d 变量定位到落点')
// 引用无法解析的变量时宁可不采样，也不猜错路径
const unknownTargets = detectDownload('curl -o "$nope\\a.zip" https://mirror.example/a.zip', 'E:\\ws').targets
assert.ok(!unknownTargets.some(target => target.includes('$')), '无法解析的变量不应产生错误路径')

// ---------- 2. 总量探测的输入校验（不联网：非法输入直接就返回 undefined） ----------
assert.equal(await probeContentLength('not-a-url'), undefined)
assert.equal(await probeContentLength('ftp://example.com/a.zip'), undefined)

// ---------- 3. 从 client.js 中切出纯函数 ----------
const start = pluginSource.indexOf('const MATCHERS = [')
const end = pluginSource.indexOf('/** 面板本体。 */')
assert.ok(start > 0 && end > start, '无法从 client.js 切出纯函数段')
const pure = new Function(
  `const MAX_TEXT = ${16 * 1024}\n${pluginSource.slice(start, end)}\nreturn { parseProgress, present, formatBytes, formatDuration, parseEta }`,
)()

// 真实 git clone 输出的尾部（节选）：Resolving 阶段不能把百分比拉回 100
const gitTail = [
  'Receiving objects:  44% (29360/66727), 14.10 MiB | 14.09 MiB/s',
  'Resolving deltas: 100% (14396/14396), done.',
].join('\r\n')
const gitProgress = pure.parseProgress(gitTail)
assert.equal(gitProgress.percent, 44, 'git 应取最后一个 Receiving 帧，忽略 Resolving')
assert.ok(Math.abs(gitProgress.speed - 14.09 * 1024 * 1024) < 1, 'git 速度应解析为字节/秒')
assert.equal(
  pure.parseProgress('Receiving objects: 10% (1/10)\r\nReceiving objects: 55% (5/10)').percent,
  55,
  '同一阶段应取最新一帧',
)

// 真实 pip 收尾行
const pipLine = '     -------------------------------------- 12.9/12.9 MB 491.0 kB/s eta 0:00:00'
const pipProgress = pure.parseProgress(pipLine)
assert.equal(pipProgress.total, 12_900_000)
assert.equal(pipProgress.downloaded, 12_900_000)
assert.equal(pipProgress.speed, 491_000)

// 只有总大小时也要能算百分比
const hintOnly = pure.parseProgress('  Downloading https://x/p.whl (9.7 MB)')
assert.equal(hintOnly.total, 9_700_000)
const view = pure.present(
  { id: 'j', tool: 'pip', fileName: 'p.whl', status: 'running', startedAt: Date.now() - 10_000, finishedAt: null, bytes: 4_000_000, speed: 400_000 },
  '  Downloading https://x/p.whl (9.7 MB)',
  Date.now(),
)
assert.ok(Math.abs(view.percent - (4_000_000 / 9_700_000) * 100) < 0.5, '百分比应由磁盘字节与总量算出')
assert.ok(view.eta > 0 && view.eta < 20_000, 'ETA 应约为 14 秒')

// aria2 / wget / curl 的哈希进度
assert.equal(pure.parseProgress('[#1a2b3c 12MiB/45MiB(26%) CN:1 DL:1.2MiB ETA:30s]').percent, 26)
assert.equal(pure.parseProgress('0K .......... .......... 45%  1.2M 3s').percent, 45)
assert.equal(pure.parseProgress('#################   45.0%').percent, 45)
assert.equal(pure.formatBytes(1_234_567), '1.23 MB')
assert.equal(pure.formatDuration(83_000), '1m 23s')

// ---------- 3. 浏览器半的注册 ----------
const registrations = []
globalThis.window = { __ModuleLoader__: { load: registration => registrations.push(registration) } }
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useMemo: fn => fn(),
  useCallback: fn => fn,
  useRef: value => ({ current: value }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}
new Function('window', 'document', pluginSource)(globalThis.window, {
  getElementById: () => null,
  head: { appendChild: () => {} },
  createElement: () => ({ set textContent(v) {}, id: '' }),
})
assert.equal(registrations.length, 1, 'client.js 应只注册一个模块')
const exported = registrations[0].factory(specifier => {
  if (specifier === 'react') return react
  throw new Error(`意外的 require: ${specifier}`)
})
assert.deepEqual(exported.inject, ['slots', 'jobs'])

let registered
exported.apply({
  slots: {
    inject: (name, run) => {
      assert.equal(name, 'shell.overlay')
      run()
    },
    register: (options, Component) => {
      registered = { options, Component }
      return () => {}
    },
  },
  jobs: { state: {}, observe: () => () => {} },
})
assert.equal(registered.options.name, 'shell.overlay')
assert.equal(registered.options.id, 'dsh-progress')
assert.equal(registered.Component.name, 'DownloadCards')

console.log('smoke: 全部通过')
