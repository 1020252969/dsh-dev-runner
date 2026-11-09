# dsh-dev-runner

<img src="assets/icon-180.png" width="96" align="right" alt="dsh-dev-runner icon">

[简体中文](#简体中文) · [English](#english) · [纯中文版](./docs-zh-CN.md)

## 简体中文

一键拉起整套开发环境：在侧栏面板里增删改项目，在旁边读日志——带颜色、能搜索、能下载，全程不用离开对话。

多数多项目工程需要后端和前端同时跑着。IDEA 的运行配置是单选，所以「后端 + 前端」要点两次、开两个日志窗口，而且前端启动时没有任何东西能证明后端已经在应答。这个插件接手了这层编排：

- **一张项目表**，存在你看得到的地方；
- 每个项目可有**有序的启动前步骤**（编译、生成、迁移）；
- 每个项目**一条常驻命令**；
- 就绪与否**由探测说话**——TCP 端口或 HTTP 地址——而不是「进程还活着」；
- **依赖关系**，后端就绪后前端才开始；
- **自动重启**，并带熔断：连续瞬间退出多次就放弃继续拉。

它对具体技术栈**一无所知**。项目、命令、启动前步骤全是数据，所以 Maven、Gradle、npm、Python、Go、Docker Compose 一视同仁——下面的自动发现也永远只是**提议**。本来就**该退出**的命令（`kubectl apply`、代码生成器、数据库迁移）会以独立的 `done` 状态结束，而不是被当成失败。

### 功能

### 自动发现

给它一个目录，它会读你本来就会看的那些文件：

| 检测器 | 依据文件 | 提议的启动命令 |
| --- | --- | --- |
| Maven | `pom.xml` | `mvn -Dmaven.test.skip=true spring-boot:run`、`quarkus:dev`、`exec:java` |
| Gradle | `build.gradle[.kts]` | `gradlew bootRun` / `gradle run` |
| Node | `package.json`、`vite.config.*` | 最合适的 `dev` / `start` / `serve` 脚本，uni-app 取 `dev:h5` |
| Python | `manage.py`、`requirements.txt`、`pyproject.toml` | `manage.py runserver`、`uvicorn …`、`flask run`、`streamlit run` |
| Go | `go.mod` | `go run .` |
| Compose | `docker-compose.yml`、`compose.yml` | `docker compose up` |

每个候选都带上**产生它的依据**——`pom.xml` + `spring-boot-maven-plugin`、`package.json` + 框架 `uni-app`、指向 8080 的 Vite 开发代理——以及端口的来历：

- 文件里写明了就用真值（`${SERVER_PORT:8080}`、`server.port`、`server: { port: … }`、`.env` 里的 `PORT`、脚本里的 `--port`、Compose 的发布端口）；
- 没有任何文件写明时**标注为“约定值”**（uni-app → 5173）；
- 需要未激活的 profile 才能确定时**不猜**（`application-prod.yml` 不会被当成你的开发端口）。

按下「应用」之前不会写入任何东西；前端只在「Vite 代理正好指向那个后端的端口」或「扫描中只有一个后端」时才接到后端上。

**服务网格**同理接线：注册中心、配置中心或调用点从配置里读出来，且只连到「扫描中确实存在的那个对端」。Eureka 的 `defaultZone` 里列了多个 peer 时取本地那个；Nacos 集群（`nacos-node-1:8848,nacos:8848`）取扫描到的成员；Dubbo/Feign 的接口名映射回提供它的应用。`${EUREKA_URL:…}` 这类占位符**不猜**——项目干脆没有这条边，因为值在部署环境里时这才是诚实的答案。

扫描有 **120 秒上限**，期间可以按「取消扫描」中断——宿主会真的停下遍历，并把已经找到的部分作为结果返回；目录留空时默认扫**第一个已配置项目的父目录**，不再依赖当前会话。

一个项目如果**有多种启动方式**——uni-app 包同时有 `dev:h5` 与 `dev:mp-weixin`，或者后端你还想先 `compile` 一次——会各自列成一个复选框。勾多个就各自成为一个项目，id 追加脚本名（`garden-uniapp-dev-mp-weixin`）以免相撞；原本依赖这个被拆开项目的东西会自动改接到它的每一个分身，而不会指向一个已经不存在的 id。

### 侧栏面板

- 项目列表：实时状态、已运行时长、重启次数；
- 在面板里**增删改**项目：`cwd`、`command`、`args`、`env`、`role`、`framework`、就绪方式（`readyPort` / `readyHost` / `readyUrl`）、各类超时、启动前步骤（**含**输出校验与「失败也继续」）、依赖、自动重启；
- 编辑器拒绝保存宿主会拒绝的表（缺 `cwd`/`command`、端口不在 1–65535、`readyUrl` 没有协议、依赖了不存在的项目），并逐条列出原因；
- 每个项目的日志：**ANSI 彩色**（16 色、256 色、真彩）、筛选 + 匹配计数 + 上下跳转、跟随、清空、复制、**下载**成 `‹id›.log`。

### 顶栏控件

会话顶栏上的一枚小药丸：状态点 + `运行中/总数` + 一个按钮（整栈启动 / 整栈停止）。状态点和计数本身就是按钮——点它通过宿主的侧栏服务直接打开面板，不用自己去找页签；面板也可以从侧栏自己的引导按钮打开。

> 注意：空会话里宿主不渲染会话头，这枚药丸也随之不可见；有会话后即出现。

### 安装

```
dsh plugin --profile desktop add dsh-dev-runner
```

本地源码目录：

```
dsh plugin --profile desktop add 'file:<absolute path to the checkout>'
```

装好后侧栏引导里会多出 **Dev services**。无需任何配置：面板打开后输入要扫描的目录，接受结果即可落盘。

### 配置

两个来源，一张生效表：

1. **`<DSH_HOME>/.dev-runner/projects.json`** —— 面板写入的文件，归插件所有并由它编辑。（`DSH_HOME` 取 `%DSH_HOME%`；宿主没设时用 `~/.dsh`。）
2. **profile 补丁** —— `cordis.patch.yml` 里 `dev-runner` 条目 `config` 下的 `projects` 数组。

两者同时存在时**以存储文件为准**。`GET /status` 与面板都会报出当前生效的来源（`store`、`store-empty` 或 `config`），所以「我写的 YAML 没生效」永远有明确答案：被面板自己的文件接管了。删掉那个文件即可回退到 profile 补丁。

```yaml
- insert:
    - id: dev-runner
      name: 'dsh-dev-runner'
      config:
        discoverDepth: 2
        projects:
          - id: backend
            name: API
            cwd: <absolute path to your shop-api checkout>
            command: mvn -Dmaven.test.skip=true spring-boot:run
            role: backend
            readyPort: 8080
            readyTimeoutMs: 180000
            env:
              SPRING_PROFILES_ACTIVE: dev
          - id: frontend
            name: 商城前端
            cwd: <absolute path to your shop-ui checkout>
            command: npm run dev:h5
            role: frontend
            readyPort: 5173
            args: -- --host
            dependsOn: [backend]
            autoRestart: true
            before:
              - name: 生成接口代码
                command: npm run gen:api
                expect: 'generated'
```

项目字段：

| 字段 | 含义 |
| --- | --- |
| `id` | 唯一标识；API 与 `dependsOn` 都用它寻址 |
| `name` | 面板显示名 |
| `cwd` | 绝对工作目录 |
| `command` | 常驻命令 |
| `args` | 追加到 `command` 之后 |
| `env` | 该项目额外的环境变量 |
| `role` | `backend` / `frontend` / `service` / `infra`（展示与发现排序） |
| `framework` | 自由标签（`spring`、`uni-app` 等） |
| `readyPort`、`readyHost` | TCP 就绪探测 |
| `readyUrl` | HTTP 就绪探测（优先；任何响应即算就绪，并报出状态码） |
| `readyTimeoutMs` | 就绪最多等多久（默认 120000） |
| `stopGraceMs` | 强停前的宽限（默认 8000） |
| `autoRestart` | 非正常退出后自动重启 |
| `oneShot` | 这条命令**本来就该退出**：退出码 0 结束为 `done` 而非 `failed`，且永不自动重启；依赖它的项目照样算「已满足」 |
| `restartDelayMs` | 重启前延时（默认 1000） |
| `dependsOn` | 必须先运行的项目 id |
| `before` | 启动前步骤：`name`、`command`、`expect`（可选，输出必须包含的子串）、`timeoutMs`、`continueOnError` |

关于环境变量的一条要紧语义：插件**只发送你声明的变量**。宿主会先从父环境里剔除凭据与 `DSH_*`，再合并你给的这一份；因此开发服务器不会继承那些刚被宿主摘掉的东西。确有需要请显式声明。

### HTTP 接口

所有路由都在 `/dev-runner/api` 下，挂在宿主自己的 web 服务上，有两道闸：连接必须是回环地址，且带 `Origin` 的请求必须指向本监听（别的站点上的页面因此无法借你的浏览器驱动它）。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/status` | 表来源、存储路径、问题列表、每个项目的快照 |
| GET | `/projects` | 当前生效的原始表 |
| PUT | `/projects` | 整表替换（`{ "projects": [...] }`） |
| POST | `/projects` | 新增或更新单个项目（`{ "project": {...} }`） |
| DELETE | `/projects/:id` | 删除一个项目 |
| POST | `/projects/:id/start` · `stop` · `restart` | 操作单个项目 |
| POST | `/start-all` · `/stop-all` | 按依赖顺序操作整栈 |
| POST | `/discover` | 扫描（`{ "root": "...", "maxDepth": 2 }`）并返回候选 |
| POST | `/discover/cancel` | 中断进行中的扫描；返回里的 `cancelled` 说明是否真有扫描在跑 |
| POST | `/discover/apply` | 写入被接受的候选（`{ "candidates": [...], "replace": false }`） |
| GET | `/logs?id=&since=` | 日志分页：`entries`、`nextSince`、`lossy`、`state` |
| GET | `/logs.txt?id=` | 同一份日志，作为文本下载 |

### 要求与边界

- DSH `>=0.2.0-rc.2 || >=0.2.1-rc.2 || >=0.2.2-alpha.3`（开发时所在的宿主线）；`@deepseek-ai/schemastery ^3.18.4` 是 peer 依赖。
- **Windows 上无法优雅停止子进程**：公开的 spawn 接缝给的是一个进程而非控制台进程组，SIGINT 无处投递，插件会直接终止——面板如实写明，不假装。
- 自动发现是提议引擎，不是构建系统：它读清单，读不到你的意图。多模块 Maven 仍需先 `mvn -DskipTests install`，而只存在于你脑子里的端口仍是未知。
- 日志在内存里：每项目 2000 行、每流 256 KiB，保留最新的。
- 就绪是探测，不是健康检查：端口应答即算就绪，哪怕里面的应用还在预热。

### 实测情况

不是设想，是一个真实双项目仓库（Spring Boot 后端 + uni-app 前端）上跑出来的，全程通过插件自己的 HTTP 接口驱动：

| 项目 | 结果 |
| --- | --- |
| 扫描该仓库 | 5 个目录里找到 2 个项目：后端端口 8080 **读自 `application.yml`**，前端 5173 **标注为框架约定值**，并因为「扫描中只有一个后端」而接到后端上 |
| 启动 uni-app 前端 | `ready in 3551 ms (::1:5173)`——就绪由端口探测判定，不是「进程还活着」 |
| 它的日志 | 20 条，ANSI 原样保留（`vite v5.2.8` 横幅、`ready in 2807ms`），`lossy: false` |
| 停止它 | `state: stopped`，端口已释放，没有残留 `node` 进程 |
| 整套接口 | 对运行中的插件做了 22 项检查：每条路由、非回环/跨源拒绝、store 往返、`发现 → 应用 → 还原` |

重启宿主后又做了一次，专挑**失败路径**（这些是最容易「看起来正常但骗人」的地方）：

| 项目 | 结果 |
| --- | --- |
| 工作目录不存在 | **启动返回值里就是 `failed`**——`process failed: Error: spawn cmd.exe ENOENT`，不再是先亮绿灯、下一次轮询才变红 |
| 命令不存在 | 同样在启动返回值里 `failed`——`process exited with code 1` |
| 端口被别人占着 | `128.0.0.1:54600 was already in use before this project started — this project does not own it`，且**没有**任何 `ready in … ms` 的声称 |
| 端口启动时是空的、稍后才应答 | `ready in 533 ms (128.0.0.1:54606)`——照常测量，因为这才是真实开发服务器的样子 |
| 一个正常项目 | `running`（防「断言恒真」的对照组） |
| 面板新增的 `readyHost` 与「失败也继续」的步骤 | 经活着的 store 往返后落到磁盘上 |

### 开发

```bash
npm install
npm test
```

六个测试套件——**147 项检查**——都不需要宿主即可运行。`npm test` 通过 `test/run-all.mjs` 统一跑完，每个套件打印一行结论：

| 套件 | 数量 | 覆盖内容 |
| --- | --- | --- |
| `test/discover.spec.mjs` | 38 | 各检测器、端口依据、profile 排序、依赖接线、容器识别、走查边界；`--scan <目录>` 直接扫描真实目录并打印结果 |
| `test/store.spec.mjs` | 16 | 归一化、取值范围、环依赖、文件损坏恢复、原子写 |
| `test/config.spec.mjs` | 6 | 宿主校验用的 schemastery schema |
| `test/host.spec.mjs` | 44 | 用桩宿主跑整个 Runner：就绪、依赖、启动前步骤、自动重启熔断、全部路由、准入闸门、死进程与借来的端口都不算就绪 |
| `test/client.spec.mjs` | 21 | bundle 注册、中英词条一致、ANSI 解析、编辑器校验、发现规划 |
| `test/render.spec.mjs` | 22 | 用桩 React 真渲染每个座并断言：面板、编辑器全部字段、扫描结果、日志筛选、顶栏药丸 |

客户端半边是手写 `window.__ModuleLoader__` 形式、没有构建步骤，所以在源码目录上直接 `dsh plugin add 'file:…'` 就能用。

### 许可证

MIT，见 [LICENSE](LICENSE)。

## English

Bring up a whole dev stack with one click, edit the project table in the sidebar,
and read every log — with colours, search and download — without leaving the
chat.

Most multi-project setups need a backend and a frontend running at the same time.
IDEA run configurations are single-selection, so "backend plus frontend" is two
clicks and two log windows, and nothing proves that the backend is actually
answering before the frontend starts. This plugin owns that orchestration:

- **one table of projects**, stored where you can see it;
- **ordered pre-launch steps** per project (compile, generate, migrate);
- **one long-running command** per project;
- **readiness proven by a probe** — a TCP port or an HTTP URL — not by "the
  process is still alive";
- **dependencies**, so the backend is ready before the frontend boots;
- **auto-restart** with a guard that gives up on a project that dies instantly,
  over and over.

It carries **no knowledge of any particular stack**. Every project, command and
pre-launch step is data, so Maven, Gradle, npm, Python, Go and Docker Compose all
work the same way — and the discovery engine below only ever *proposes*. A
command that is *supposed* to exit (`kubectl apply`, a code generator, a
migration) ends in its own `done` state instead of being called a failure.

### Features

### Auto-discovery

Point it at a directory and it reads the same files you would:

| Detector | Files | Start command it proposes |
| --- | --- | --- |
| Maven | `pom.xml` | `mvn -Dmaven.test.skip=true spring-boot:run`, `quarkus:dev`, `exec:java` |
| Gradle | `build.gradle[.kts]` | `gradlew bootRun` / `gradle run` |
| Node | `package.json`, `vite.config.*` | the best `dev` / `start` / `serve` script, including `dev:h5` for uni-app |
| Python | `manage.py`, `requirements.txt`, `pyproject.toml` | `manage.py runserver`, `uvicorn …`, `flask run`, `streamlit run` |
| Go | `go.mod` | `go run .` |
| Compose | `docker-compose.yml`, `compose.yml` | `docker compose up` |

Every proposed project carries **the evidence that produced it** — `pom.xml` +
`spring-boot-maven-plugin`, `package.json` + framework `uni-app`, a Vite dev
proxy that targets port 8080 — and where the port came from:

- the real answer when a file states it (`${SERVER_PORT:8080}`, `server.port`,
  `server: { port: … }`, a `.env` `PORT`, a `--port` flag in the script, a
  published port in a Compose file);
- **marked as a convention** when nothing states it (`uni-app` → 5173);
- and *not* invented when the value needs a profile that is not active
  (`application-prod.yml` is not read as your dev port).

Nothing is written until you press Apply, and a frontend is wired to a backend
only when the Vite proxy names that backend's port, or when the scan found
exactly one backend.

A **service mesh** is wired the same way: a registry, a config center or a call
site is read from configuration, and the edge is drawn only to the peer that was
actually scanned. An Eureka `defaultZone` list with several peers picks the local
one; a Nacos cluster (`nacos-node-1:8848,nacos:8848`) picks the scanned member; a
Dubbo/Feign interface maps back to the application that provides it. A
`${EUREKA_URL:…}` placeholder is **not** guessed — the project gets no edge,
which is the honest answer when the value lives in the deployment environment.

A project that has **several ways to start** — a uni-app package with `dev:h5`
and `dev:mp-weixin`, a backend you also want to `compile` first — lists them as
separate checkboxes. Tick more than one and each becomes its own project, with
the script name appended to the id (`garden-uniapp-dev-mp-weixin`) so nothing
collides, and any project that depended on the split one is rewired to all of
its halves instead of being left pointing at an id that no longer exists.

### Sidebar panel

- the project list with live state, elapsed time and restart count;
- **add, edit and delete** projects in the panel: `cwd`, `command`, `args`,
  `env`, `role`, `framework`, readiness (`readyPort` / `readyHost` / `readyUrl`),
  timeouts, pre-launch steps (**including** the required-output check and "keep
  going after a failure"), dependencies, auto-restart;
- the editor refuses to save a table the host would reject (missing `cwd` or
  `command`, a port outside 1–65535, a `readyUrl` without a scheme, a dependency
  on a project that does not exist) and lists every reason;
- logs per project with **ANSI colours** (16-colour, 256-colour and truecolor),
  a filter with match count and next/previous jump, follow mode, clear, copy and
  **download** as `‹id›.log`.

### Top-bar control

A compact pill in the session header: a state dot, `running/total`, and a
button that starts the whole stack or stops it. The dot and the count are
themselves a button — clicking them opens the panel through the host's sidebar
service, so you do not have to go hunting for the tab. The panel also opens from
the sidebar's own guide button.

> Note: the host hides the session header — and with it this pill — in a blank
> session. It appears as soon as a session exists.

### Install

```
dsh plugin --profile desktop add dsh-dev-runner
```

For a local checkout:

```
dsh plugin --profile desktop add 'file:<absolute path to the checkout>'
```

After installing, the sidebar guide offers **Dev services**. Nothing else is
required: with no configuration at all, the panel opens, scans a directory you
type, and saves what you accept.

A scan has a **120-second deadline** and a **Cancel scan** button that really stops the walk and answers with what it had already found; leaving the folder empty scans the **parent of the first configured project**, not the current session.

### Configuration

Two sources, one effective table:

1. **`<DSH_HOME>/.dev-runner/projects.json`** — written by the panel. This is
   the file the plugin owns and edits. (`DSH_HOME` is `%DSH_HOME%` when the host
   sets it, otherwise `~/.dsh`.)
2. **the profile patch** — the `projects` array under `config` for the
   `dev-runner` entry in `cordis.patch.yml`.

The store file wins when it exists. `GET /status` and the panel both report
which source is live (`store`, `store-empty` or `config`), so a table that
"ignored" your YAML is never a mystery: it was superseded by the panel's own
file. Delete that file to fall back to the profile patch.

```yaml
- insert:
    - id: dev-runner
      name: 'dsh-dev-runner'
      config:
        discoverDepth: 2
        projects:
          - id: backend
            name: API
            cwd: <absolute path to your shop-api checkout>
            command: mvn -Dmaven.test.skip=true spring-boot:run
            role: backend
            readyPort: 8080
            readyTimeoutMs: 180000
            env:
              SPRING_PROFILES_ACTIVE: dev
          - id: frontend
            name: Shop UI
            cwd: <absolute path to your shop-ui checkout>
            command: npm run dev:h5
            role: frontend
            readyPort: 5173
            args: -- --host
            dependsOn: [backend]
            autoRestart: true
            before:
              - name: codegen
                command: npm run gen:api
                expect: 'generated'
```

Per-project fields:

| Field | Meaning |
| --- | --- |
| `id` | unique; the API and `dependsOn` address projects by it |
| `name` | label shown in the panel |
| `cwd` | absolute working directory |
| `command` | the long-running command |
| `args` | appended to `command` |
| `env` | extra environment variables for this project |
| `role` | `backend` / `frontend` / `service` / `infra` (display + discovery ordering) |
| `framework` | free-form label (`spring`, `uni-app`, …) |
| `readyPort`, `readyHost` | TCP readiness probe |
| `readyUrl` | HTTP readiness probe (takes precedence; any response counts, the status is reported) |
| `readyTimeoutMs` | how long readiness may take (default 120000) |
| `stopGraceMs` | grace before a forced stop (default 8000) |
| `autoRestart` | restart after an unexpected exit |
| `oneShot` | the command is *supposed* to exit: exit code 0 ends in `done`, not `failed`, and it is never restarted. A dependent counts it as satisfied |
| `restartDelayMs` | delay before that restart (default 1000) |
| `dependsOn` | ids that must be running first |
| `before` | pre-launch steps: `name`, `command`, `expect` (optional required substring), `timeoutMs`, `continueOnError` |

Environment semantics worth knowing: the plugin sends **only the variables you
declare**. The host strips credentials and `DSH_*` from the parent environment
before merging yours, so a dev server never inherits what the host removed. If a
tool needs one of those variables, declare it explicitly.

### HTTP API

All routes are under `/dev-runner/api`, served on the host's own web server, and
guarded by two fences: the connection must be loopback, and a request that
carries an `Origin` must name this listener (so a page on another site cannot
drive it through your browser).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/status` | table source, store path, problems, every project's snapshot |
| GET | `/projects` | the raw effective table |
| PUT | `/projects` | replace it (`{ "projects": [...] }`) |
| POST | `/projects` | add or update one project (`{ "project": {...} }`) |
| DELETE | `/projects/:id` | remove one project |
| POST | `/projects/:id/start` · `stop` · `restart` | one project |
| POST | `/start-all` · `/stop-all` | the whole stack, in dependency order |
| POST | `/discover` | scan (`{ "root": "...", "maxDepth": 2 }`) and return candidates |
| POST | `/discover/cancel` | stop the scan in flight; `cancelled` says whether one was running |
| POST | `/discover/apply` | write accepted candidates (`{ "candidates": [...], "replace": false }`) |
| GET | `/logs?id=&since=` | log page: `entries`, `nextSince`, `lossy`, `state` |
| GET | `/logs.txt?id=` | the same log as a text download |

### Requirements and limitations

- DSH `>=0.2.0-rc.2 || >=0.2.1-rc.2 || >=0.2.2-alpha.3` (the host line this was
  developed against); `@deepseek-ai/schemastery ^3.18.4` is a peer dependency.
- **Windows cannot stop a child gracefully** here: the public spawn seam gives a
  process, not a console group, so SIGINT has nowhere to go and the plugin
  terminates. The panel says so rather than pretending.
- Discovery is a proposal engine, not a build system: it reads manifests, not
  your intent. Multi-module Maven builds still need the modules installed
  (`mvn -DskipTests install`) before `spring-boot:run` can resolve them, and a
  port that only exists in your head stays unknown.
- Logs live in memory: 2000 lines per project, 256 KiB per stream, newest kept.
- Readiness is a probe, not a health check: a port that answers is "ready", even
  if the application inside it is still warming up.

### Verified on

Not aspirations — this is what the plugin did on a real two-project checkout (a
Spring Boot backend plus a uni-app frontend), driven through its own HTTP API:

| What | Result |
| --- | --- |
| Scan of the checkout | 2 projects found in 5 directories: the backend with port 8080 **read from `application.yml`**, the frontend with 5173 **marked as the framework's convention**, wired to the backend because it was the only one |
| Starting the uni-app frontend | `ready in 3551 ms (::1:5173)` — readiness decided by the port probe, not by the process still being alive |
| Its logs | 20 entries, raw ANSI preserved (the `vite v5.2.8` banner, `ready in 2807ms`), `lossy: false` |
| Stopping it | `state: stopped`, port released, no orphan `node` process left behind |
| The whole API | 22 checks against the running plugin: every route, loopback/same-origin rejection, store round trip, `discover → apply → revert` |

A second live pass, on a restarted host, targeted the failure paths specifically:

| What | Result |
| --- | --- |
| A folder that does not exist | `failed` **in the start answer** — `process failed: Error: spawn cmd.exe ENOENT`, not a green dot that turns red one poll later |
| A command that does not exist | `failed` in the start answer — `process exited with code 1` |
| A port somebody else owns | `128.0.0.1:54600 was already in use before this project started — this project does not own it`, and **no** `ready in … ms` claim |
| A port that was free at spawn and answered later | `ready in 533 ms (128.0.0.1:54606)` — still measured, because that is what a real dev server looks like |
| A healthy project | `running`, as it should be (the control that keeps the checks from being always-true) |
| The panel's `readyHost` and a `continue` step | survived a round trip through the live store and landed on disk |

### Development

```bash
npm install
npm test
```

Six suites — **147 checks** — all runnable without the host. `npm test` runs them
through `test/run-all.mjs` and prints one verdict per suite:

| Suite | Checks | Covers |
| --- | --- | --- |
| `test/discover.spec.mjs` | 38 | every detector, port evidence, profile ranking, dependency wiring, containers, the walk's bounds; `--scan <dir>` scans a real directory and prints what it found |
| `test/store.spec.mjs` | 16 | normalisation, limits, cycles, corrupt-file recovery, atomic writes |
| `test/config.spec.mjs` | 6 | the schemastery schema the host validates against |
| `test/host.spec.mjs` | 44 | the whole Runner against a stub host: readiness, dependencies, pre-launch steps, auto-restart guard, every route, the admission fences, a dead or borrowed process never reported ready |
| `test/client.spec.mjs` | 21 | bundle registration, locale parity, ANSI parsing, editor validation, the discovery plan |
| `test/render.spec.mjs` | 22 | every seat rendered through a stub React and asserted on: the panel, the editor's fields, the scan results, the log filter, the header pill |

The client half is hand-written against `window.__ModuleLoader__` with no build
step, so `dsh plugin add 'file:…'` works on a checkout.

### License

MIT — see [LICENSE](LICENSE).
