# 交接说明（2026-11-06）

> 这份文档写给三种人：明天回来的我、想接手的人、以及半年后想知道「当初到底做到哪」的我。
> 状态行的时间戳以本机为准。

## 一句话状态

本节状态截至 2026-11-07；更早的「四件待办」已全部完成，见下表。

| 项目 | 状态 | 证据 |
|---|---|---|
| 测试 | ✅ 147 项，6 个套件 + 文档核对 | `npm test` 全绿（见下） |
| 打包 | ✅ 14 文件 / 96 kB | `npm pack --dry-run` |
| GitHub | ✅ 已上线 | `https://github.com/1020252969/dsh-dev-runner` |
| npm 发布 | ✅ 已发布 | `dsh-dev-runner@0.3.0`，`dist-tags.latest = 0.3.0` |
| 收录 PR | ⏳ 等仓库满 1 天 | `awesome-dsh-plugin` PR #12848，`check` 全绿，只剩年龄门槛自动重跑 |
| 截图 | ❌ 未拍 | `assets/` 只有两张图标 PNG；`screenshots.json` 已移除（声明不存在的图会被收录侧判为 dead） |

## 一、已完成（无需再动手）

### 代码

```
lib/index.js     66684 B  宿主半边：Config、Runner、路由、准入闸门
lib/client.js   125502 B  浏览器半边：面板、编辑器、发现、日志、顶栏
lib/discover.js  67888 B  发现引擎（纯函数，只依赖 node:fs）
lib/store.js     11074 B  项目表持久化（原子写、环依赖切边）
```

四条设计原则，改动时别违反：

1. **规则写在注释里，也写在测试里。** 每个非显然的决定（为什么 `env` 只传项目自己的变量、为什么准入是「回环 + 同源」而不是用宿主的 `requestRejection`、为什么游标是包含式）都在代码注释里写了原因，对应测试引用同一个原因。
2. **不说不知道的事。** 端口只有约定值时标注「约定值」；就绪没探测方式时写「没配就绪探测」；日志被丢弃时说 `lossy`。宁可难看，不可骗人。
3. **空状态返回 `null`，不是空壳。** 顶栏药丸在表为空时不渲染，避免占位噪音。
4. **`dsh plugin add` 必须能装。** 客户端手写 `window.__ModuleLoader__.load`，没有构建步骤，所以 checkout 直接可装、发布不需要 `prepare`。

### 测试（147 项）

| 套件 | 数量 | 它守护什么 |
|---|---|---|
| discovery | 38 | 六种检测器、端口依据三级、容器下钻、走查双边界、24 小时内的线性时间回归 |
| store | 16 | 归一化、越界回落、环依赖切边、损坏文件改名、原子写 |
| config | 6 | 宿主校验用的 schemastery schema |
| host | 44 | 桩宿主跑整个 Runner：就绪、依赖、前置步骤、自动重启熔断、全部路由、准入闸门、**死进程与借来的端口都不算就绪**、窗口丢弃上报 |
| client | 21 | bundle 注册、中英词条一致、ANSI、编辑器校验、发现规划、`continueOnError`/`readyHost` 往返 |
| render | 22 | 桩 React 真渲染每个座：面板、编辑器全字段、扫描结果、日志筛选、顶栏 |
| docs | 6 | 文档里的数字必须等于套件实际数量 |

### 已修复的 8 个 bug（都来自真实使用，不是想象）

1. Spring 嵌套 YAML 的 `${SERVER_PORT:8080}` 解析不出端口
2. `spring: → profiles: → active:` 正则**灾难性回溯**，63 行文件让扫描卡死数分钟
3. Maven 聚合根（`<packaging>pom</packaging>`）被当成可运行服务
4. Android 工程被提议 `gradlew run`（必失败）
5. 纯 POM 瞎猜 `exec:java`
6. **起不来却报 `running`**：spawn 失败后要等下一次轮询才变红
7. **借来的端口被当成自己的就绪**：`ready in 0 ms` 其实是别人的服务
8. **日志窗口丢弃不报警 + 游标卡死 + 下一页漏一行**

## 二、剩下的四件事

### 1. 重启宿主（关键，其它验证都依赖它）

`Get-Process 'DeepSeek Harness'` 显示启动于 **11-05 14:53**，我所有代码改动都在 **11-06**。宿主的模块加载器只在启动时读一次 JS，所以：

- 上表第 6、7、8 项修复**线上都还没生效**
- 面板的新字段（`readyHost`、步骤的 `continue` 列）也**看不到**

**做法**：应用内正常退出再打开。**不要强杀进程** —— 会弹崩溃窗，点「恢复」会把 profile 补丁重置成默认值（丢模型/UI 设置），本机 AGENTS.md 记录过这次事故。

**重启后立刻跑**（我会做，留给你自查也行）：

```powershell
# 1) 起不来就该立刻 failed，而不是先绿后红
curl.exe -s -X POST -H "content-type: application/json" `
  --data '{"project":{"id":"t1","cwd":"D:\\no-such-dir","command":"echo hi","role":"service"}}' `
  http://127.0.0.1:58627/dev-runner/api/projects
curl.exe -s -X POST http://127.0.0.1:58627/dev-runner/api/projects/t1/start
# 期望 state=failed 且 detail 含 ENOENT

# 2) 端口被别人占着时不能报就绪
#    先起一个占用 18097 的东西，再建 readyPort=18097 的项目并 start
# 期望 detail 含 "was already in use before this project started"
```

### 2. GitHub 镜像（收录的硬门槛）

收录列表只认 `github.com`：CI 读你仓库的 `package.json`、查仓库年龄、`icon`/截图必须 GitHub 托管。

1. 把你自己的 SSH 公钥（如 `~/.ssh/id_rsa.pub`）贴到 https://github.com/settings/keys
2. 建**空**的公开仓库 `dsh-dev-runner`（不要勾 README/.gitignore/license），加 topic `dsh-plugin`
3. 推上去：

```powershell
git push <github-remote> main:main
```

> 有的机器上 git 的 HTTPS 出口不通（`getaddrinfo() thread failed to start`），SSH 也可能被拒
> （`Permission denied (publickey)`）。那种情况下只能走 REST API 推：`PUT /repos/<owner>/<repo>/contents/<path>`
> （空仓库要先 `POST /git/blobs` 会 409，得先用 Contents API 提交一个文件建出首个 commit），
> 或用 `POST /git/refs` + `POST /git/trees` + `POST /git/commits`。

### 3. npm

```powershell
npm login
npm publish --access public
```

若账号开了 2FA，`npm login` 需要真人交互，改为在 npm 网页建一把
**Granular Access Token**（勾 `Bypass 2FA` 才能 publish）写进 `~/.npmrc` 的
`//registry.npmjs.org/:_authToken=`。

`repository` 必须指回**被收录的那个仓库**（GitHub URL），否则 npm 包与收录条目不会被关联。

### 4. 截图（3 张）

`screenshots.json` 已声明文件名，图还没拍：

| 文件 | 内容 |
|---|---|
| `assets/screenshot-panel.png` | 面板：项目列表 + 状态点 + 彩色日志 + 筛选框 |
| `assets/screenshot-discovery.png` | 扫描面板：候选、依据、逐命令复选框 |
| `assets/screenshot-header.png` | 顶栏药丸：`n/m` + 启停按钮 |

**为什么我做不了**：GUI 的浏览器凭据是进程内随机 token（`processLaunchToken` 用 `randomBytes`，只存 WeakMap，不落盘），Playwright 也没装。所以只能人工截。

## 三、这份文档没覆盖的（如实记录）

- **渲染只在桩里验证过**。12 项 render 检查用桩 React 跑真实组件，证明「字段在树上、按钮在、颜色对」，但**布局是否舒服、真实字体下是否错位**没验证过。这需要人眼，也就是第 4 件事。
- **真实 Windows 停止行为**：代码里 `terminate()` 后 `waitForExit()`，实测前端进程能停干净（端口释放、无残留 node），但**强杀 vs 优雅停止**的差别在 PTY 场景下没测过（本插件用 `spawn` 不是 `spawnTerminal`）。
- **`readyUrl` 的 HTTPS + 自签证书**：`probeHttpOnce` 设了 `rejectUnauthorized: false`，是为了内网自签场景，但这意味着**它不校验证书**。文档没写这条，属于已知的宽松处。（2026-11-06 已用真实自签握手验证过能通；证书随测试携带，见 `test/fixtures/self-signed.pfx`。变异测试确认：改成 `true` 该用例立刻红。）

## 四、明天从哪开始

```
读这份文档 → 跑 npm test（应 7/7 全绿）→ 重启宿主 → 跑上面两条 curl 自检
→ 推 GitHub → 拍三张截图 → 确认 package.json 的 repository → npm publish
→ 满 1 天后提收录 PR（条目文件放到 awesome-dsh-plugin 仓库的 data/plugins/ 下）
```
