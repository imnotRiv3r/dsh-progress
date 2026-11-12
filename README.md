English | [中文](README.zh.md)

# dsh-progress

A [DeepSeek Harness](https://github.com/deepseek-ai) plugin that shows a live download card in the bottom-right corner of the UI while a background job is downloading: progress bar, bytes written, current speed, and ETA.

![Download progress card](docs/card-percent.png)

That screenshot is a real run: a **silent** download (`curl -s`, which prints nothing at all) still shows `4.14 MB / 12.9 MB`, `32%`, and `148 KB/s`.

```
┌──────────────────────────────────────┐
│ py  plotly                        ✕  │
│     4.00 MB / 9.70 MB                │
│ ███████████░░░░░░░░░░░░░░░░░░░░░░░░  │
│ 41% · pip            400 KB/s · 14s left │
└──────────────────────────────────────┘
```

## What do the animated stripes mean?

A filled bar means the total size is known, so a percentage can be computed.
Moving stripes mean **indeterminate**: the plugin knows a download is running and how fast bytes are landing, but the total size is unknown, so there is no honest percentage to show.

That is a deliberate fallback, not a failure. A total comes from one of three sources, tried in order:

1. **The downloader reports it** — `git clone --progress`, `aria2c`, pip's `(9.7 MB)`, `curl -#`.
2. **A HEAD request** — for a single file URL the plugin reads `content-length`; this is what makes silent downloads show a percentage.
3. **Neither** — the card falls back to stripes.

![Real percentage from curl](docs/card-curl.png)

`curl -#` reports percentages on its own (the `15% · curl` above), and so does `git clone --progress`. Stripes remain only for downloads that have no single total: `npm install` (dozens of packages), commands with multiple URLs, and servers that refuse HEAD.

## How it works

Three real sources feed the card:

| Source | Covers | Notes |
|---|---|---|
| Job output | git, aria2, wget, `curl -#`, docker, pip summary lines | Percentages, speed and totals are parsed straight out of the output |
| Disk sampling | anything that writes to disk | Watches `.git`, `-o` targets and that downloader's own `%TEMP%` staging files, then derives speed from byte growth |
| HEAD probe | single-file HTTP(S) downloads | Reads `content-length` to supply the missing total |

Choices worth knowing, all verified by experiment on Windows:

- `git clone --progress` emits complete percentage frames even through Harness' pipes, so the injected prompt guidance asks for `--progress`.
- `curl -#` also emits complete percentages through pipes — **unless the command pipes its output away** (`curl ... | Select-Object` swallows it).
- `pip` and `npm` print **no** live progress in a non-TTY pipe (and `--progress-bar on` does not help). Dependency installs therefore rely on disk sampling: pip writes to `%TEMP%\pip-download-*` / `pip-unpack-*`, and pip's first line carries `(9.7 MB)`, which supplies the total.
- Target directories are measured as **deltas**: the size at job start is recorded as a baseline, so files that were already there are never counted as part of this download.

## Where the UI mounts

The browser half registers into the `shell.overlay` slot (root scope, unused by default) and then renders through `ReactDOM.createPortal` into `document.body`.

The portal is required: the slot container carries `transform` / `overflow`, so a `position: fixed` card placed inside it gets clipped or positioned against that ancestor instead of the viewport. Symptom without it: the component runs fine but nothing is visible. The plugin falls back to in-slot rendering when `react-dom` is unavailable.

## Verify

```powershell
# Is the Host half alive? `hits` keeps growing once the browser half attaches.
Invoke-RestMethod http://127.0.0.1:2482/plugin/dsh-progress/state
# {"version":1,"now":...,"tasks":[...],"poll":{"hits":123,"lastHitAt":...,"build":"0.1.0"}}
```

`poll.hits` counts requests to the state route. If it does not grow, the browser half is not loaded (usually the page was not refreshed). If it grows but no card appears, the problem is mounting, not data. `poll.build` names the Host build that answered.

Trigger a visible download:

```powershell
curl.exe -L -# --limit-rate 300k -o "$env:TEMP\probe.bin" `
  https://mirrors.aliyun.com/pypi/packages/a3/dd/4b822569d6b96c39d1215dbae0582fd99954dcbcf0c1a13c61783feaca3f/numpy-2.2.6-cp310-cp310-win_amd64.whl
```

## When a card appears

- The job must be a **background job** (`run_in_background: true`, or a foreground command promoted to background on timeout). Foreground commands have no job row, so there is nothing to observe.
- The command must look like a download: `git clone|fetch|pull`, `pip/uv install|download`, `npm/pnpm/yarn/bun i|install|add`, `curl`, `wget`, `aria2c`, `Invoke-WebRequest -OutFile`, `Start-BitsTransfer`, `winget/choco/scoop/nuget install`, `cargo install|fetch`, `go get|mod download`, `docker pull`.
- Explicitly ignored: `git status`, `curl --version`, `pip list`, `Invoke-WebRequest` without `-OutFile`, and similar.

With `guidePrompt` enabled (the default) the plugin adds one short system-prompt section asking the model to run downloads with `run_in_background` and progress-friendly flags. That section is what determines how often you actually see cards.

Shell variables inside the command are expanded when possible — `$dir="D:\dl"; curl -o "$dir\a.zip" ...` still resolves to the real target. A variable that cannot be resolved is skipped rather than guessed, so a mis-read path never produces a wrong progress curve.

## Install

Installed the same way as any Harness profile plugin.

1. Link this directory into the profile's `node_modules`:

   ```powershell
   cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-progress" "E:\dshWorkspace\dsh-progress"
   ```

2. Add the dependency and bundle to the profile's `package.json`:

   ```json
   {
     "dependencies": { "dsh-progress": "link:E:/dshWorkspace/dsh-progress" },
     "dsh": { "profile": { "bundles": ["...", "dsh-progress"] } }
   }
   ```

3. The Host half hot-reloads with profile changes; the browser half needs **one page refresh**.

## Config

The row id is `progress`; edit it in the profile's `cordis.patch.yml`:

```yaml
- id: progress
  name: dsh-progress
  config:
    enabled: true
    guidePrompt: true
    settledTtlMs: 12000
    maxTasks: 8
    sampleBudgetMs: 220
    probeTotals: true
    workingDirectory: ''
```

| Field | Default | Meaning |
|---|---:|---|
| `enabled` | `true` | Master switch |
| `guidePrompt` | `true` | Inject the download guidance into the system prompt |
| `settledTtlMs` | `12000` | How long Host keeps returning a finished task |
| `maxTasks` | `8` | Maximum cards shown at once |
| `sampleBudgetMs` | `220` | Time budget per disk sample; lower it on huge directories |
| `probeTotals` | `true` | HEAD-probe single file URLs for a total size; disabling it means silent downloads stay indeterminate |
| `workingDirectory` | process cwd | Base directory for resolving relative paths in commands |

## Limitations

- **Foreground downloads never show a card.** This follows from Harness' job model; it is not something a plugin can work around.
- **Stripes are not a bug.** Without a total there is nothing to compute a percentage from. `npm install` and other multi-package downloads have no single total by design.
- **`pip` / `npm` report no live progress**, so the percentage is `disk delta ÷ total`; pip's total comes from its own first line.
- **`%TEMP%` is shared.** Two concurrent pip downloads can bleed into each other's byte counts. Filtering by downloader prefix (`pip-*`, `npm-*`, …) keeps this rare, but it is not guaranteed.
- **Disk sampling is an estimate.** Directory walks have time and entry caps, so very large trees may only be partially counted and the curve can wobble.
- **HEAD probing covers a single URL only.** Multi-URL commands, non-HTTP(S) addresses and servers that refuse HEAD get no total, and probe failures are silent.
- Ownerless jobs (not belonging to any session) only show bytes, never an output percentage.
- Editing `client.js` requires a page refresh; Host-side edits hot-reload.

## Development

```powershell
node test/smoke.mjs          # detection, parsing, browser-half registration — fully offline
```

`test/smoke.mjs` uses excerpts of real command output as fixtures and never touches the network.

## License

MIT
