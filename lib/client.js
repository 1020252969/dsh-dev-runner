/**
 * dsh-dev-runner — client half.
 *
 * One right-sidebar page type, `dev-runner`, plus one session-header control.
 * Four seats in total:
 *
 *   sidebar.right.tab.guide.entry          -> the door in the sidebar's "+" menu
 *   sidebar.right.pane.tab                 -> the panel body
 *   sidebar.right.pane.tab.title           -> the tab chip
 *   conversation.session.header.utilities  -> one-click start/stop + a status pill
 *
 * The header seat is a `kind: "list", scope: "session"` slot: the host renders
 * it only while a session header is on screen (a blank session hides it), so it
 * is a convenience, never the only way in. The sidebar page is always reachable.
 *
 * A client `inject` entry is a HARD dependency gate in Cordis: an entry the
 * running host line does not serve keeps `apply` from running at all. Every
 * service below ships unconditionally on the supported line, and each seat is
 * registered inside its own try/catch, so a seat this host does not render
 * degrades to a console warning instead of taking the page down.
 *
 * No build step: this file is loaded verbatim by `dsh-client-modules`, so it
 * calls `jsx.jsx()` directly rather than shipping JSX. That keeps `dsh plugin
 * add file:` installable and keeps the package free of a `prepare` script.
 */
window.__ModuleLoader__.load({
  id: 'dsh-dev-runner',
  factory(require) {
    const React = require('react');
    const jsx = require('react/jsx-runtime');

    const name = 'dsh-dev-runner-client';
    const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'];

    const API = '/dev-runner/api';
    const LOCALE = 'devRunner';
    const KIND = 'dev-runner';
    const PLUGIN_ID = 'dsh-dev-runner';
    const HEADER_SLOT = 'conversation.session.header.utilities';

    /**
     * How often to re-read `/status`.
     *
     * One second keeps the panel honest while you are watching it, but the panel is
     * meant to be left open beside the work. Two pollers (the panel and the header
     * pill) each spending a full rebuild-and-SQLite-load on the host every second is
     * a fixed tax on a machine that is already busy running the dev servers. So the
     * cadence follows attention: fast within a minute of the last interaction, then
     * slow — both tick counts are visible in the panel, so a slow refresh reads as
     * "polling slowly" rather than "frozen".
     */
    const POLL_MS = 1_000;
    const POLL_QUIET_MS = 4_000;
    const POLL_ATTENTION_MS = 60_000;
    const HEADER_POLL_MS = 1500;
    const LOG_POLL_MS = 700;
    /** Lines kept on the client; the host keeps its own ring buffer. */
    const LOG_LINES = 5000;

    const zh = {
      title: '开发服务',
      new: '开发服务',
      description: '发现项目、一键启停并跟随日志',
      'list.title': '项目',
      'list.empty': '还没有配置项目',
      'list.emptyHint': '点「添加项目」，或用「扫描目录」自动找出前后端与启动命令。',
      'list.count': '{count} 个项目',
      'panel.title': '开发服务',
      'panel.summary': '{running} / {total} 运行中',
      'action.startAll': '全部启动',
      'notice.startAllFailed': '有 {count} 个项目没能启动：{names}',
  'notice.startAllCancelled': '启动已取消，已启动的项目需要单独停止',
      'action.stopAll': '全部停止',
      'action.start': '启动',
      'action.stop': '停止',
      'action.restart': '重启',
      'action.refresh': '刷新',
      'action.add': '添加项目',
      'action.edit': '编辑',
      'action.delete': '删除',
        'action.deleteConfirm': '确认删除',
      'action.save': '保存',
      'action.cancel': '取消',
      'action.back': '继续编辑',
      'action.clearLog': '清空日志',
      'action.follow': '跟随最新',
      'action.copy': '复制',
      'action.copied': '已复制',
      'action.download': '下载',
      'action.scan': '扫描目录',
      'action.close': '关闭',
      'action.apply': '写入项目表',
      'action.selectAll': '全选',
      'action.selectNone': '全不选',
      'action.selectPrimary': '只选主命令',
      'state.stopped': '已停止',
      'state.done': '已完成',
      'state.starting': '启动中',
      'state.running': '运行中',
      'state.failed': '失败',
      'role.backend': '后端',
      'role.frontend': '前端',
      'role.service': '服务',
      'role.infra': '基础设施',
      'source.store': '项目表来自 {file}',
      'source.storeEmpty': '项目表为空，已回落到插件配置（{file} 会在首次保存时创建）',
      'source.config': '项目表来自插件配置（尚未落到自有文件）',
      'source.problems': '{count} 项配置问题',
      'meta.restarts': '已重启 {count} 次',
      'meta.dependsOn': '依赖 {names}',
      'meta.port': '端口 {port}',
      'meta.waiting': '等待 {target}',
      'meta.pendingEdit': '改动要重启才生效',
      'meta.url': '就绪地址 {url}',
      'log.title': '日志',
      'log.empty': '还没有输出',
      'log.lossy': '早期日志已被覆盖',
      'log.before': '启动前命令',
      'log.stepOk': '完成',
      'log.stepFailed': '失败',
      'log.stepRunning': '执行中',
      'log.filter': '筛选…',
      'log.matches': '{index}/{count} 处匹配',
      'log.noMatches': '无匹配',
      'log.prev': '上一个',
      'log.next': '下一个',
      'log.noProject': '左侧选择一个项目查看日志',
      'status.idle': '未运行',
      'status.running': '运行中 {duration}',
      'status.ready': '就绪 {duration}',
      'editor.newTitle': '添加项目',
      'editor.editTitle': '编辑 {name}',
      'editor.leave': '有未保存的改动，确定放弃吗？',
      'editor.id': '标识',
      'editor.idHint': '留空则按目录名生成，项目之间必须唯一。',
      'editor.name': '名称',
      'editor.cwd': '工作目录',
      'editor.cwdHint': '绝对路径，命令在这里执行。',
      'editor.command': '启动命令',
      'editor.commandHint': '例如 mvn spring-boot:run 或 npm run dev。',
      'editor.args': '额外参数',
      'editor.argsHint': '追加到启动命令之后。',
      'editor.env': '环境变量',
      'editor.envHint': '每行一个 KEY=VALUE；留空则完全继承宿主环境（宿主会先剔除凭据与 DSH_* 变量）。',
      'editor.role': '角色',
      'editor.framework': '框架',
      'editor.readyPort': '就绪端口',
      'editor.readyPortHint': 'TCP 探测；留空表示不探测端口。',
      'editor.readyHost': '探测地址',
      'editor.readyHostHint': '留空则同时试 127.0.0.1 与 ::1（Vite 常只监听后者）。',
      'editor.readyUrl': '就绪地址',
      'editor.readyUrlHint': 'HTTP 探测，优先级高于端口；填了就以它为准。',
      'editor.readyTimeoutMs': '就绪超时 (ms)',
      'editor.stopGraceMs': '停止宽限 (ms)',
      'editor.autoRestart': '退出后自动重启',
      'editor.restartDelayMs': '重启延迟 (ms)',
      'editor.dependsOn': '依赖项目',
      'editor.dependsOnHint': '用逗号分隔的项目标识；被依赖的项目先启动。',
      'editor.before': '启动前命令',
      'editor.beforeHint': '每行一步：名称 | 命令 | 期望输出（可省）| continue（可省，失败也继续）。',
      'editor.invalid.cwd': '工作目录不能为空',
      'editor.invalid.command': '启动命令不能为空',
      'editor.invalid.port': '端口必须是 1-65535 的整数',
      'editor.invalid.url': '就绪地址必须以 http:// 或 https:// 开头',
      'editor.invalid.number': '{field} 必须是数字',
      'editor.invalid.dependsOn': '依赖的项目不存在：{names}',
      'editor.invalid.env': '环境变量第 {line} 行不是 KEY=VALUE',
      'editor.invalid.before': '启动前命令第 {line} 行至少需要「名称 | 命令」',
      'discover.heading': '扫描目录',
      'discover.root': '目录',
      'discover.rootHint': '默认使用已配置项目的父目录。',
      'discover.depth': '递归深度',
      'discover.scan': '开始扫描',
      'discover.scanning': '扫描中…',
      'discover.results': '找到 {count} 个候选',
      'discover.none': '这个目录里没有识别出可启动的项目',
      'discover.evidence': '依据',
      'discover.portSource': '端口来源：{source}',
      'discover.command': '启动命令',
      'discover.apply': '写入项目表',
      'discover.replace': '替换现有项目表',
      'discover.replaceHint': '不勾选则合并：同名标识覆盖，其余保留。',
      'discover.dependency': '自动依赖：{reason}',
      'discover.chooseCommand': '启动命令（共 {count} 个可选）',
      'discover.noRoot': '请先填写要扫描的目录',
      'discover.cancel': '取消扫描',
      'header.startAll': '一键启动',
      'header.stopAll': '全部停止',
      'header.summary': '{running}/{total} 运行中',
      'header.title': '开发服务：{summary}',
      'header.open': '打开运行面板',
      'confirm.delete': '删除项目「{name}」？正在运行的实例会先停止。',
      'error.request': '请求失败：{message}',
    };
    const en = {
      title: 'Dev services',
      new: 'Dev services',
      description: 'Discover projects, start them at once, follow the logs',
      'list.title': 'Projects',
      'list.empty': 'No projects configured yet',
      'list.emptyHint': 'Add one, or point "Scan a folder" at your repository to find the stack automatically.',
      'list.count': '{count} projects',
      'panel.title': 'Dev services',
      'panel.summary': '{running} of {total} running',
      'action.startAll': 'Start all',
      'notice.startAllFailed': '{count} project(s) did not start: {names}',
  'notice.startAllCancelled': 'Start-up was cancelled; projects that did start stay running until you stop them',
      'action.stopAll': 'Stop all',
      'action.start': 'Start',
      'action.stop': 'Stop',
      'action.restart': 'Restart',
      'action.refresh': 'Refresh',
      'action.add': 'Add project',
      'action.edit': 'Edit',
      'action.delete': 'Delete',
        'action.deleteConfirm': 'Confirm delete',
      'action.save': 'Save',
      'action.cancel': 'Cancel',
      'action.back': 'Keep editing',
      'action.clearLog': 'Clear log',
      'action.follow': 'Follow',
      'action.copy': 'Copy',
      'action.copied': 'Copied',
      'action.download': 'Download',
      'action.scan': 'Scan a folder',
      'action.close': 'Close',
      'action.apply': 'Write to project table',
      'action.selectAll': 'Select all',
      'action.selectNone': 'Select none',
      'action.selectPrimary': 'Primary only',
      'state.stopped': 'Stopped',
      'state.done': 'Done',
      'state.starting': 'Starting',
      'state.running': 'Running',
      'state.failed': 'Failed',
      'role.backend': 'Backend',
      'role.frontend': 'Frontend',
      'role.service': 'Service',
      'role.infra': 'Infra',
      'source.store': 'Project table from {file}',
      'source.storeEmpty': 'Project table is empty; falling back to plugin config ({file} appears on first save)',
      'source.config': 'Project table from plugin config (no own file yet)',
      'source.problems': '{count} configuration problem(s)',
      'meta.restarts': 'restarted {count}×',
      'meta.dependsOn': 'after {names}',
      'meta.port': 'port {port}',
      'meta.waiting': 'waiting for {target}',
      'meta.pendingEdit': 'edit applies on restart',
      'meta.url': 'ready at {url}',
      'log.title': 'Log',
      'log.empty': 'No output yet',
      'log.lossy': 'Earlier lines were overwritten',
      'log.before': 'Pre-launch',
      'log.stepOk': 'done',
      'log.stepFailed': 'failed',
      'log.stepRunning': 'running',
      'log.filter': 'Filter…',
      'log.matches': '{index}/{count} matches',
      'log.noMatches': 'No matches',
      'log.prev': 'Previous',
      'log.next': 'Next',
      'log.noProject': 'Pick a project on the left to read its log',
      'status.idle': 'Idle',
      'status.running': 'Running {duration}',
      'status.ready': 'Ready {duration}',
      'editor.newTitle': 'Add project',
      'editor.editTitle': 'Edit {name}',
      'editor.leave': 'This project has unsaved changes. Discard them?',
      'editor.id': 'Id',
      'editor.idHint': 'Empty generates one from the folder name; ids must be unique.',
      'editor.name': 'Name',
      'editor.cwd': 'Working directory',
      'editor.cwdHint': 'Absolute path; the command runs here.',
      'editor.command': 'Start command',
      'editor.commandHint': 'For example mvn spring-boot:run or npm run dev.',
      'editor.args': 'Extra arguments',
      'editor.argsHint': 'Appended to the start command.',
      'editor.env': 'Environment',
      'editor.envHint': 'One KEY=VALUE per line. Empty inherits the host environment, minus the credentials and DSH_* values the host scrubs.',
      'editor.role': 'Role',
      'editor.framework': 'Framework',
      'editor.readyPort': 'Ready port',
      'editor.readyPortHint': 'TCP probe; empty disables the port probe.',
      'editor.readyHost': 'Probe host',
      'editor.readyHostHint': 'Empty tries 127.0.0.1 and ::1 (Vite often binds only the latter).',
      'editor.readyUrl': 'Ready URL',
      'editor.readyUrlHint': 'HTTP probe, takes priority over the port when set.',
      'editor.readyTimeoutMs': 'Ready timeout (ms)',
      'editor.stopGraceMs': 'Stop grace (ms)',
      'editor.autoRestart': 'Restart after exit',
      'editor.restartDelayMs': 'Restart delay (ms)',
      'editor.dependsOn': 'Depends on',
      'editor.dependsOnHint': 'Comma-separated project ids; those start first.',
      'editor.before': 'Pre-launch steps',
      'editor.beforeHint': 'One step per line: name | command | expected output (optional) | continue (optional, keep going after a failure).',
      'editor.invalid.cwd': 'Working directory is required',
      'editor.invalid.command': 'Start command is required',
      'editor.invalid.port': 'Port must be an integer between 1 and 65535',
      'editor.invalid.url': 'Ready URL must start with http:// or https://',
      'editor.invalid.number': '{field} must be a number',
      'editor.invalid.dependsOn': 'Unknown project id(s): {names}',
      'editor.invalid.env': 'Environment line {line} is not KEY=VALUE',
      'editor.invalid.before': 'Pre-launch line {line} needs at least "name | command"',
      'discover.heading': 'Scan a folder',
      'discover.root': 'Folder',
      'discover.rootHint': 'Defaults to the parent of the first configured project.',
      'discover.depth': 'Depth',
      'discover.scan': 'Scan',
      'discover.scanning': 'Scanning…',
      'discover.results': '{count} candidate(s)',
      'discover.none': 'No startable project was recognised in this folder',
      'discover.evidence': 'Evidence',
      'discover.portSource': 'Port source: {source}',
      'discover.command': 'Start command',
      'discover.apply': 'Write to project table',
      'discover.replace': 'Replace the existing project table',
      'discover.replaceHint': 'Unchecked merges: same id overwrites, everything else stays.',
      'discover.dependency': 'Wired dependency: {reason}',
      'discover.chooseCommand': 'Start command ({count} detected)',
      'discover.noRoot': 'Fill in a folder to scan first',
      'discover.cancel': 'Cancel scan',
      'header.startAll': 'Start all',
      'header.stopAll': 'Stop all',
      'header.summary': '{running}/{total} running',
      'header.title': 'Dev services: {summary}',
      'header.open': 'Open the runner panel',
      'confirm.delete': 'Delete project "{name}"? A running instance is stopped first.',
      'error.request': 'Request failed: {message}',
    };

    /**
     * One request helper; every failure becomes a message, never a throw.
     *
     * A request that never settles is worse than one that fails: the poll keeps
     * its interval, so aborted requests pile up behind a hung host and the panel
     * silently stops refreshing. A deadline turns that into the same ordinary
     * error path as a 500.
     */
    const REQUEST_TIMEOUT_MS = 15_000;

    /**
     * Scanning is not a status read.
     *
     * A repository walk that finishes inside 15 s is the exception, and killing
     * the request at 15 s did not kill the walk: the host kept going while the
     * panel reported failure, which is why the only cure was restarting the
     * host. The deadline therefore belongs to the call, not to the panel.
     */
    const DISCOVER_TIMEOUT_MS = 120_000;

    async function call(path, options) {
      const { timeoutMs = REQUEST_TIMEOUT_MS, ...rest } = options ?? {};
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetch(API + path, {
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          ...rest,
        });
      } catch (failure) {
        throw new Error(failure?.name === 'AbortError'
          ? `no answer within ${timeoutMs / 1000}s`
          : String(failure?.message ?? failure));
      } finally {
        clearTimeout(timer);
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) {
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      return body;
    }

    function readError(failure) {
      return String(failure?.message ?? failure);
    }

    function formatDuration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '';
      const total = Math.floor(ms / 1000);
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      if (minutes >= 60) return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
      if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
      return `${seconds}s`;
    }

    // ---------------------------------------------------------------- ANSI ---
    //
    // Dev servers colour their output, and a log panel that drops the escape
    // codes on the floor shows "^[[32m" or, worse, silently deletes the text
    // between them. This turns SGR sequences into per-span styles so the panel
    // reads like the terminal the user would otherwise be watching.

    const ANSI_FG = {
      30: '#3f3f46', 31: '#dc2626', 32: '#16a34a', 33: '#d97706',
      34: '#2563eb', 35: '#9333ea', 36: '#0891b2', 37: '#a1a1aa',
      90: '#71717a', 91: '#f87171', 92: '#4ade80', 93: '#fbbf24',
      94: '#60a5fa', 95: '#c084fc', 96: '#22d3ee', 97: '#f4f4f5',
    };
    const ANSI_BG = {
      40: '#27272a', 41: '#7f1d1d', 42: '#14532d', 43: '#78350f',
      44: '#1e3a8a', 45: '#581c87', 46: '#164e63', 47: '#3f3f46',
      100: '#52525b', 101: '#991b1b', 102: '#166534', 103: '#92400e',
      104: '#1e40af', 105: '#6b21a8', 106: '#155e75', 107: '#71717a',
    };
    /** The first sixteen palette entries are the sixteen named colours. */
    const ANSI_BASE16 = [
      ANSI_FG[30], ANSI_FG[31], ANSI_FG[32], ANSI_FG[33],
      ANSI_FG[34], ANSI_FG[35], ANSI_FG[36], ANSI_FG[37],
      ANSI_FG[90], ANSI_FG[91], ANSI_FG[92], ANSI_FG[93],
      ANSI_FG[94], ANSI_FG[95], ANSI_FG[96], ANSI_FG[97],
    ];
    const ANSI_CUBE = [0, 95, 135, 175, 215, 255];

    function rgb(r, g, b) {
      return `rgb(${r}, ${g}, ${b})`;
    }

    /** xterm-256 index to a colour: 16 named, 216 cube, 24 greys. */
    function paletteColor(index) {
      if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
      if (index < 16) return ANSI_BASE16[index];
      if (index < 232) {
        const n = index - 16;
        return rgb(ANSI_CUBE[Math.floor(n / 36) % 6], ANSI_CUBE[Math.floor(n / 6) % 6], ANSI_CUBE[n % 6]);
      }
      const grey = 8 + (index - 232) * 10;
      return rgb(grey, grey, grey);
    }

    const ESCAPE = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007|\r/gu;

    /** Drop every escape sequence (used for copy/download and for filtering). */
    function stripAnsi(text) {
      return String(text).replace(ESCAPE, '').replace(/\u001b/g, '');
    }

    function spanStyle(state) {
      const style = {};
      if (state.fg !== undefined) style.color = state.fg;
      if (state.bg !== undefined) style.background = state.bg;
      if (state.bold) style.fontWeight = 600;
      if (state.italic) style.fontStyle = 'italic';
      if (state.underline) style.textDecoration = 'underline';
      if (state.dim) style.opacity = 0.72;
      return style;
    }

    /**
     * Split one line into styled spans. Unknown codes are ignored on purpose: a
     * stray SGR must never hide the text after it.
     */
    function ansiSpans(text) {
      const plain = String(text).replace(/\r/gu, '');
      const spans = [];
      let state = {};
      let cursor = 0;
      const pattern = /\u001b\[([0-9;]*)m/gu;
      const push = (chunk) => {
        if (chunk === '') return;
        spans.push({ text: chunk, style: spanStyle(state) });
      };
      let match = pattern.exec(plain);
      while (match !== null) {
        push(plain.slice(cursor, match.index));
        cursor = pattern.lastIndex;
        const codes = match[1] === '' ? [0] : match[1].split(';').map((code) => Number(code));
        for (let index = 0; index < codes.length; index += 1) {
          const code = codes[index];
          if (code === 0) state = {};
          else if (code === 1) state.bold = true;
          else if (code === 2) state.dim = true;
          else if (code === 3) state.italic = true;
          else if (code === 4) state.underline = true;
          else if (code === 22) { state.bold = false; state.dim = false; }
          else if (code === 23) state.italic = false;
          else if (code === 24) state.underline = false;
          else if (code === 39) state.fg = undefined;
          else if (code === 49) state.bg = undefined;
          else if (code === 38 || code === 48) {
            const slot = code === 38 ? 'fg' : 'bg';
            const mode = codes[index + 1];
            if (mode === 5) {
              state[slot] = paletteColor(codes[index + 2]);
              index += 2;
            } else if (mode === 2) {
              state[slot] = rgb(codes[index + 2], codes[index + 3], codes[index + 4]);
              index += 4;
            } else {
              index += 1;
            }
          } else if (code >= 30 && code <= 37) state.fg = ANSI_FG[code];
          else if (code >= 90 && code <= 97) state.fg = ANSI_FG[code];
          else if (code >= 40 && code <= 47) state.bg = ANSI_BG[code];
          else if (code >= 100 && code <= 107) state.bg = ANSI_BG[code];
        }
        match = pattern.exec(plain);
      }
      push(plain.slice(cursor));
      if (spans.length === 0) spans.push({ text: '', style: {} });
      return spans;
    }

    // ----------------------------------------------------------- transport ---

    /** Shared polling state for the status list; one timer for the whole page. */
    function useRunner() {
      const [projects, setProjects] = React.useState([]);
      const [source, setSource] = React.useState('');
      const [storeFile, setStoreFile] = React.useState('');
      const [problems, setProblems] = React.useState([]);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [selected, setSelected] = React.useState('');

      const refresh = React.useCallback(async () => {
        try {
          const body = await call('/status');
          const list = Array.isArray(body.projects) ? body.projects : [];
          setProjects(list);
          setSource(typeof body.source === 'string' ? body.source : '');
          setStoreFile(typeof body.storeFile === 'string' ? body.storeFile : '');
          setProblems(Array.isArray(body.problems) ? body.problems : []);
          setError('');
          setSelected((current) => {
            if (current !== '' && list.some((project) => project.id === current)) return current;
            return list.length > 0 ? list[0].id : '';
          });
        } catch (failure) {
          setError(readError(failure));
        }
      }, []);

      const lastTouchAt = React.useRef({ value: 0 });

      React.useEffect(() => {
        let live = true;
        // A panel nobody is touching is a fixed cost on a machine that is busy
        // running dev servers. The cadence has to be decided when the NEXT timer is
        // armed, not when an interaction happens: listening on `document` for
        // clicks only tells us afterwards, and re-running this effect per click
        // would ALSO fight with every busy flip. So the panel keeps the last
        // interaction time in a ref and samples it as each poll is scheduled.
        lastTouchAt.current.value = Date.now();
        const touch = () => { lastTouchAt.current.value = Date.now(); };
        // Capture phase sees interactions that stop propagation, and the three
        // events cover pointer, keyboard and wheel without needing `passive`.
        document.addEventListener('pointerdown', touch, true);
        document.addEventListener('keydown', touch, true);
        document.addEventListener('wheel', touch, true);
        let timer = 0;
        const schedule = () => {
          const quietFor = Date.now() - lastTouchAt.current.value;
          timer = setTimeout(() => {
            if (live === false) return;
            if (document.hidden) schedule();
            else refresh().then(schedule, schedule);
          }, (quietFor > POLL_ATTENTION_MS ? POLL_QUIET_MS : POLL_MS));
        };
        refresh().then(schedule, schedule);
        return () => {
          live = false;
          clearTimeout(timer);
          document.removeEventListener('pointerdown', touch, true);
          document.removeEventListener('keydown', touch, true);
          document.removeEventListener('wheel', touch, true);
        };
      }, [refresh]);

      /** POST/PUT/DELETE one route, then re-read the status. */
      const act = React.useCallback(async (path, options) => {
        const settings = options ?? {};
        setBusy(settings.label ?? path);
        try {
          const result = await call(path, {
            method: settings.method ?? 'POST',
            body: settings.body === undefined ? undefined : JSON.stringify(settings.body),
          });
          setError('');
          await refresh();
          return result;
        } catch (failure) {
          setError(readError(failure));
          return undefined;
        } finally {
          setBusy('');
        }
      }, [refresh]);

      return { projects, source, storeFile, problems, error, notice, setNotice, busy, selected, setSelected, refresh, act };
    }

    /**
     * The raw, editable project table (as stored), which is not the same thing
     * as `/status`: status carries runtime state, this carries configuration.
     */
    function useTable(open) {
      const [table, setTable] = React.useState({ projects: [], source: '', storeFile: '', problems: [] });
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState('');

      const reload = React.useCallback(async () => {
        try {
          const body = await call('/projects');
          setTable({
            projects: Array.isArray(body.projects) ? body.projects : [],
            source: typeof body.source === 'string' ? body.source : '',
            storeFile: typeof body.storeFile === 'string' ? body.storeFile : '',
            problems: Array.isArray(body.problems) ? body.problems : [],
          });
          setError('');
        } catch (failure) {
          setError(readError(failure));
        }
      }, []);

      React.useEffect(() => {
        if (open) reload();
      }, [open, reload]);

      const save = React.useCallback(async (project) => {
        setBusy('save');
        try {
          await call('/projects', { method: 'POST', body: JSON.stringify({ project }) });
          setError('');
          await reload();
          return true;
        } catch (failure) {
          setError(readError(failure));
          return false;
        } finally {
          setBusy('');
        }
      }, [reload]);

      const remove = React.useCallback(async (id) => {
        setBusy('delete');
        try {
          await call(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
          setError('');
          await reload();
          return true;
        } catch (failure) {
          setError(readError(failure));
          return false;
        } finally {
          setBusy('');
        }
      }, [reload]);

      return { table, error, busy, reload, save, remove };
    }

    /** Tail one project's log with a cursor, appending only new lines. */
    function useLog(projectId, open) {
      const [entries, setEntries] = React.useState([]);
      const [lossy, setLossy] = React.useState(false);
      const cursor = React.useRef(0);

      React.useEffect(() => {
        setEntries([]);
        setLossy(false);
        cursor.current = 0;
      }, [projectId]);

      React.useEffect(() => {
        if (!open || projectId === '') return undefined;
        let live = true;
        let timer;
        const pull = async () => {
          try {
            const body = await call(`/logs?id=${encodeURIComponent(projectId)}&since=${cursor.current}`);
            if (!live) return;
            if (body.lossy === true) setLossy(true);
            if (Array.isArray(body.entries) && body.entries.length > 0) {
              const added = body.entries;
              setEntries((current) => {
                const next = current.concat(added);
                return next.length > LOG_LINES ? next.slice(next.length - LOG_LINES) : next;
              });
            }
            if (typeof body.nextSince === 'number') cursor.current = body.nextSince;
          } catch {
            // A transient poll failure keeps the last rendered tail on screen.
          }
          if (live) timer = setTimeout(pull, LOG_POLL_MS);
        };
        pull();
        return () => {
          live = false;
          if (timer !== undefined) clearTimeout(timer);
        };
      }, [projectId, open]);

      return {
        entries,
        lossy,
        clear: () => {
          setEntries([]);
        },
      };
    }

    // ------------------------------------------------------------ helpers ----

    function stateLabel(project, t) {
      if (project.state === 'running') return t('state.running');
      if (project.state === 'starting') return t('state.starting');
      if (project.state === 'failed') return t('state.failed');
      // A one-shot command that finished its job. Distinct from `stopped`
      // because there is nothing to stop and nothing went wrong.
      if (project.state === 'done') return t('state.done');
      return t('state.stopped');
    }

    function dotColor(state) {
      if (state === 'running') return '#16a34a';
      if (state === 'failed') return '#dc2626';
      if (state === 'starting') return '#d97706';
      if (state === 'done') return '#0ea5e9';
      return '#9ca3af';
    }

    /**
     * A status dot with a soft halo, so a running project reads as "live" from
     * across the panel instead of looking like a 8px bullet in a list.
     */
    function stateDot(state) {
      const color = dotColor(state);
      return {
        background: color,
        boxShadow: state === 'running' || state === 'starting'
          ? `0 0 0 3px ${state === 'running' ? 'rgba(22, 163, 74, 0.16)' : 'rgba(217, 119, 6, 0.16)'}`
          : 'none',
      };
    }

    function isLive(project) {
      return project.state === 'running' || project.state === 'starting';
    }

    function roleLabel(role, t) {
      if (role === 'backend') return t('role.backend');
      if (role === 'frontend') return t('role.frontend');
      if (role === 'infra') return t('role.infra');
      return t('role.service');
    }

    function readinessText(project, t) {
      if (typeof project.readyUrl === 'string' && project.readyUrl !== '') return t('meta.url', { url: project.readyUrl });
      if (project.readyPort !== null && project.readyPort !== undefined) return t('meta.port', { port: project.readyPort });
      return '';
    }

    /**
     * What the row should say while the runner is still waiting for readiness.
     *
     * The host writes `waiting for port 8080 on 127.0.0.1, ::1` into `detail` for
     * as long as the probe runs, which can be the whole readiness window. Without
     * surfacing it the row reads "running" from the first moment, and the user
     * cannot tell a slow start from a stuck one.
     */
    function waitingText(project, t) {
      const detail = typeof project.detail === 'string' ? project.detail : '';
      if (!/^waiting for /u.test(detail)) return '';
      const target = detail.slice('waiting for '.length);
      return t('meta.waiting', { target });
    }

    /**
     * Is the project running a command other than the one now configured?
     *
     * The host records what it actually spawned (`runningCommand`); the row shows
     * `command` + `args` from the table. When those disagree, the edit has not
     * taken effect yet — it applies on the next start.
     */
    function editPending(project) {
      const running = project.runningCommand;
      if (typeof running !== 'string' || running === '') return false;
      const configured = project.args === undefined || project.args === ''
        ? project.command
        : `${project.command} ${project.args}`;
      return running !== configured;
    }

    /**
     * The sub-line of one project row: state, then what it is doing, then bonus
     * facts — joined once so nothing can be glued twice.
     */
    function waitRowText(project, t) {
      const parts = [stateLabel(project, t)];
      const waiting = waitingText(project, t);
      if (waiting !== '') parts.push(waiting);
      if (project.restarts > 0) parts.push(t('meta.restarts', { count: project.restarts }));
      // A running project keeps the command it was started with: editing the table
      // does not restart it. Saying so is what stops "I changed it and nothing
      // happened" — the row would otherwise show the new command as if in force.
      if (editPending(project)) parts.push(t('meta.pendingEdit'));
      if (project.role !== 'service') parts.push(roleLabel(project.role, t));
      return parts.join(' · ');
    }

    /** A short, human summary used by the header pill's tooltip. */
    function summaryText(projects, t) {
      const running = projects.filter(isLive).length;
      return t('header.summary', { running, total: projects.length });
    }

    // ------------------------------------------------------------- styles ----

    // ---------------------------------------------------------------------
    // Visual system
    //
    // The host ships two palettes — a light one and a dark one — and swaps them
    // through the `light-dark()` CSS function. Hardcoding `#fff`/`#111` here
    // would look fine in one theme and wrong in the other, so every colour
    // either comes from a `--dsw-*` token or goes through `light-dark()`.
    //
    // Depth comes from two stacked shadows (a tight contact shadow plus a wide
    // soft one), which is what makes a panel read as raised rather than as a
    // rectangle with a line around it.
    // ---------------------------------------------------------------------
    const surface = 'light-dark(#ffffff, #1f2125)';
    const surfaceSunken = 'light-dark(#f7f8fa, #131417)';
    const hairline = 'light-dark(rgba(15, 23, 42, 0.07), rgba(255, 255, 255, 0.07))';
    const hairlineStrong = 'light-dark(rgba(15, 23, 42, 0.12), rgba(255, 255, 255, 0.12))';
    const ink = 'light-dark(#0f172a, #f1f5f9)';
    const inkSoft = 'light-dark(#475569, #94a3b8)';
    const inkFaint = 'light-dark(#94a3b8, #64748b)';
    const accent = 'light-dark(#2563eb, #60a5fa)';
    const liftSoft = '0 1px 2px light-dark(rgba(15, 23, 42, 0.05), rgba(0, 0, 0, 0.4))';
    const liftPanel = '0 1px 2px light-dark(rgba(15, 23, 42, 0.04), rgba(0, 0, 0, 0.35)), 0 6px 16px -6px light-dark(rgba(15, 23, 42, 0.10), rgba(0, 0, 0, 0.5))';
    const ease = '160ms cubic-bezier(0.22, 1, 0.36, 1)';
    const fontUi = 'var(--dsw-font-family, system-ui, -apple-system, "Segoe UI", sans-serif)';
    const fontMono = 'var(--dsh-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)';
    const sizeBase = 'var(--dsh-content-font-size-secondary, 13px)';

    const styles = {
      root: {
        display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
        fontFamily: fontUi, color: 'var(--dsw-alias-label-primary, inherit)',
        background: 'var(--dsw-alias-bg-base, transparent)', position: 'relative',
        WebkitFontSmoothing: 'antialiased', textRendering: 'optimizeLegibility',
      },
      toolbar: {
        display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center',
        padding: '12px 14px', flex: '0 0 auto',
        borderBottom: `1px solid ${hairline}`,
        background: surface,
      },
      toolbarSpacer: { flex: '1 1 auto' },
      actionBar: {
        display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center',
        padding: '10px 14px', flex: '0 0 auto',
        borderBottom: `1px solid ${hairline}`,
        background: surfaceSunken,
      },
      summary: {
        display: 'inline-flex', alignItems: 'center', gap: '6px',
        padding: '2px 10px', borderRadius: '999px',
        fontSize: `calc(${sizeBase} - 2px)`, color: inkSoft,
        fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
        background: 'light-dark(rgba(15, 23, 42, 0.04), rgba(255, 255, 255, 0.05))',
        border: `1px solid ${hairline}`,
      },
      body: { display: 'flex', flex: '1 1 auto', minHeight: 0 },
      list: {
        width: '228px', minWidth: '160px', maxWidth: '45%', overflowY: 'auto',
        padding: '8px', gap: '4px', display: 'flex', flexDirection: 'column',
        flex: '0 0 auto', background: surfaceSunken,
        borderRight: `1px solid ${hairline}`,
        scrollbarWidth: 'thin',
      },
      // A row is a small card that lifts off the sunken list: the active one
      // gets the raised shadow plus an accent spine, so selection reads even in
      // a screenshot with the colours stripped out.
      row: {
        display: 'block', width: '100%', textAlign: 'left',
        padding: '9px 11px', borderRadius: '8px',
        border: `1px solid transparent`, borderLeftWidth: '2px',
        background: 'transparent', color: 'inherit', fontFamily: fontUi, cursor: 'pointer',
        transition: `background ${ease}, box-shadow ${ease}, border-color ${ease}`,
      },
      rowActive: {
        background: surface,
        borderColor: hairline,
        borderLeftColor: accent,
        boxShadow: liftPanel,
      },
      rowHead: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 },
      rowName: {
        fontSize: sizeBase, fontWeight: 600, color: ink,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        letterSpacing: '0.005em',
      },
      rowMeta: {
        display: 'block', marginTop: '3px', marginLeft: '16px',
        fontSize: `calc(${sizeBase} - 2px)`, color: inkFaint,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
      },
      detail: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minWidth: 0, minHeight: 0, background: surface },
      detailHead: {
        display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
        padding: '14px 16px 6px', flex: '0 0 auto', rowGap: '8px',
      },
      detailTitle: { display: 'flex', alignItems: 'center', gap: '9px', minWidth: 0, flex: '1 1 auto' },
      detailName: {
        fontSize: `calc(${sizeBase} + 3px)`, fontWeight: 680, color: ink,
        letterSpacing: '-0.005em',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      detailActions: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      badge: {
        display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '2px 9px',
        borderRadius: '999px', fontSize: `calc(${sizeBase} - 2px)`,
        fontWeight: 600, letterSpacing: '0.02em',
        border: '1px solid currentColor',
        background: 'light-dark(rgba(255, 255, 255, 0.6), rgba(255, 255, 255, 0.06))',
      },
      metaRow: {
        display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap',
        padding: '0 12px 8px', flex: '0 0 auto',
      },
      steps: {
        display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '6px 10px',
        borderBottom: '1px solid var(--dsw-alias-border-l4)', flex: '0 0 auto',
      },
      step: {
        display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '1px 7px', borderRadius: '999px',
        fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)', background: 'var(--dsw-alias-bg-l2)',
      },
      chip: {
        display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '1px 7px', borderRadius: '999px',
        fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
        border: '1px solid var(--dsw-alias-border-l3)', color: 'var(--dsw-alias-label-secondary)',
      },
      source: {
        fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 2px)',
        color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        maxWidth: '100%',
      },
      logTool: {
        display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap',
        padding: '8px 16px', flex: '0 0 auto',
        borderTop: `1px solid ${hairline}`, background: surface,
      },
      // The log is a sunken terminal well: a recessed surface plus an inset
      // shadow, so it reads as a place where text accumulates.
      log: {
        flex: '1 1 auto', minHeight: 0, overflowY: 'auto',
        padding: '12px 14px', margin: '0 16px 14px', borderRadius: '10px',
        fontFamily: fontMono, fontSize: `calc(${sizeBase} - 1px)`,
        lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        background: surfaceSunken, color: inkSoft, tabSize: 4,
        border: `1px solid ${hairline}`,
        boxShadow: 'inset 0 1px 3px light-dark(rgba(15, 23, 42, 0.05), rgba(0, 0, 0, 0.45))',
        scrollbarWidth: 'thin',
      },
      line: { display: 'block' },
      lineErr: { color: 'light-dark(#dc2626, #f87171)' },
      lineRunner: { color: inkFaint, fontStyle: 'italic' },
      match: {
        background: 'light-dark(#fde68a, #854d0e)', color: 'light-dark(#18181b, #fef3c7)',
        borderRadius: '3px', padding: '0 2px',
        boxShadow: '0 0 0 2px light-dark(rgba(253, 230, 138, 0.45), rgba(133, 77, 14, 0.45))',
      },
      hint: {
        display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
        padding: '40px 24px', color: inkFaint, lineHeight: 1.8,
        fontSize: `calc(${sizeBase} - 1px)`,
      },
      brand: {
        display: 'flex', alignItems: 'center', gap: '8px',
        fontSize: `calc(${sizeBase} + 1px)`, fontWeight: 680, color: ink,
        letterSpacing: '-0.01em',
      },
      brandMark: {
        width: '17px', height: '17px', flex: '0 0 auto',
        filter: 'drop-shadow(0 1px 2px light-dark(rgba(15, 23, 42, 0.18), rgba(0, 0, 0, 0.6)))',
      },
      // Tabs are a strip, not a row of buttons: the active one is underlined.
      tabs: {
        display: 'flex', alignItems: 'stretch', gap: '2px', flex: '1 1 auto',
        padding: '0 8px', borderBottom: '1px solid var(--dsw-alias-border-l3)', flex: '0 0 auto',
      },
      tab: {
        padding: '7px 11px', border: 'none', borderBottom: '2px solid transparent',
        background: 'transparent', color: 'var(--dsw-alias-label-secondary)', font: 'inherit',
        cursor: 'pointer', whiteSpace: 'nowrap', marginBottom: '-1px',
        transition: 'color 120ms ease, border-color 120ms ease',
      },
      tabActive: {
        color: 'var(--dsw-alias-label-primary, inherit)', fontWeight: 600,
        borderBottomColor: 'var(--dsw-alias-label-primary, currentColor)',
      },
      // The primary action is the only button with a filled surface, a coloured
      // background and a shadow; everything else stays a quiet outline. Before
      // this the two styles differed only by font-weight, so Start looked like
      // Edit.
      button: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '5px',
        minHeight: '28px', padding: '4px 12px', borderRadius: '7px',
        border: `1px solid ${hairlineStrong}`,
        background: surface, color: ink,
        fontFamily: fontUi, fontSize: `calc(${sizeBase} - 1px)`, fontWeight: 500,
        cursor: 'pointer', textDecoration: 'none', whiteSpace: 'nowrap',
        boxShadow: liftSoft,
        transition: `background ${ease}, border-color ${ease}, box-shadow ${ease}, transform ${ease}`,
      },
      buttonPrimary: {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '5px',
        minHeight: '28px', padding: '4px 14px', borderRadius: '7px',
        border: '1px solid transparent',
        background: accent,
        color: 'light-dark(#ffffff, #0b1220)',
        fontFamily: fontUi, fontSize: `calc(${sizeBase} - 1px)`, fontWeight: 620,
        letterSpacing: '0.005em', cursor: 'pointer', whiteSpace: 'nowrap',
        boxShadow: '0 1px 2px light-dark(rgba(37, 99, 235, 0.3), rgba(0, 0, 0, 0.5)), 0 4px 10px -4px light-dark(rgba(37, 99, 235, 0.45), rgba(96, 165, 250, 0.3))',
        transition: `filter ${ease}, box-shadow ${ease}, transform ${ease}`,
      },
      input: {
        width: '100%', minHeight: '30px', padding: '5px 10px', borderRadius: '7px',
        border: `1px solid ${hairlineStrong}`, background: surface,
        color: ink, fontFamily: fontUi, fontSize: sizeBase, boxSizing: 'border-box',
        transition: `border-color ${ease}, box-shadow ${ease}`,
      },
      select: {
        minHeight: '30px', padding: '5px 10px', borderRadius: '7px',
        border: `1px solid ${hairlineStrong}`, background: surface,
        color: ink, fontFamily: fontUi, fontSize: sizeBase, cursor: 'pointer',
      },
      textarea: {
        width: '100%', minHeight: '72px', padding: '8px 10px', borderRadius: '7px',
        border: `1px solid ${hairlineStrong}`, background: surface,
        color: ink, fontFamily: fontMono, fontSize: `calc(${sizeBase} - 1px)`,
        boxSizing: 'border-box', lineHeight: 1.6, resize: 'vertical',
        transition: `border-color ${ease}, box-shadow ${ease}`,
      },
      field: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
      fieldHint: {
        fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 2px)',
        color: 'var(--dsw-alias-label-tertiary)',
      },
      fieldLabel: { fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)', fontWeight: 600 },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '8px' },
      // The editor and the scan sheet REPLACE the panel body, so this is a plain
      // flex column: no absolute positioning, and therefore no dependence on which
      // ancestor happens to be the containing block.
      sheetRoot: {
        display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
        background: surface, fontFamily: fontUi, color: 'var(--dsw-alias-label-primary, inherit)',
      },
      // The sheet body is a quiet canvas; the form fields sit on cards so a long
      // form does not read as one undifferentiated wall of inputs.
      sheet: {
        flex: '1 1 auto', minHeight: 0, overflowY: 'auto', padding: '14px 16px',
        display: 'flex', flexDirection: 'column', gap: '12px',
        background: surfaceSunken,
      },
      sheetHead: {
        display: 'flex', alignItems: 'center', gap: '9px',
        padding: '13px 16px', flex: '0 0 auto',
        borderBottom: `1px solid ${hairline}`, background: surface,
      },
      sheetFoot: {
        display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
        padding: '11px 16px', flex: '0 0 auto',
        borderTop: `1px solid ${hairline}`, background: surface,
      },
      candidate: {
        display: 'flex', flexDirection: 'column', gap: '6px', padding: '12px 13px',
        border: `1px solid ${hairline}`, borderRadius: '10px',
        background: surface, boxShadow: liftSoft,
        transition: `border-color ${ease}, box-shadow ${ease}`,
      },
      error: {
        color: 'light-dark(#dc2626, #f87171)',
        fontSize: `calc(${sizeBase} - 1px)`, fontWeight: 500,
      },
      warn: {
        color: 'light-dark(#b45309, #fbbf24)',
        fontSize: `calc(${sizeBase} - 1px)`, fontWeight: 500,
      },
      // The top-bar pill the header control renders inside the chat header.
      pill: {
        display: 'inline-flex', alignItems: 'center', gap: '7px', padding: '3px 11px',
        borderRadius: '999px', border: `1px solid ${hairlineStrong}`,
        background: surface, fontSize: `calc(${sizeBase} - 1px)`,
        color: ink, boxShadow: liftSoft,
        fontFamily: fontUi, fontVariantNumeric: 'tabular-nums',
        transition: `background ${ease}, box-shadow ${ease}`,
      },
      pillOpen: {
        display: 'inline-flex', alignItems: 'center', gap: '7px', padding: '0',
        border: 'none', background: 'transparent', color: 'inherit',
        font: 'inherit', cursor: 'pointer',
      },
      pillButton: {
        padding: '0 7px', borderRadius: '999px', border: 'none', background: 'transparent',
        color: inkSoft, font: 'inherit', cursor: 'pointer',
        transition: `color ${ease}, background ${ease}`,
      },
      dot: { width: '8px', height: '8px', borderRadius: '50%', flex: '0 0 auto' },
    };

    function buttonStyle(disabled, primary) {
      const base = primary ? styles.buttonPrimary : styles.button;
      return { ...base, opacity: disabled ? 0.45 : 1, cursor: disabled ? 'default' : 'pointer' };
    }

    // ------------------------------------------------------ editor drafts ----

    function projectToDraft(project) {
      const value = project ?? {};
      return {
        id: value.id ?? '',
        name: value.name ?? '',
        cwd: value.cwd ?? '',
        command: value.command ?? '',
        args: value.args ?? '',
        role: value.role ?? 'service',
        framework: value.framework ?? '',
        readyPort: value.readyPort === null || value.readyPort === undefined ? '' : String(value.readyPort),
        readyHost: value.readyHost ?? '',
        readyUrl: value.readyUrl ?? '',
        readyTimeoutMs: value.readyTimeoutMs === undefined ? '' : String(value.readyTimeoutMs),
        stopGraceMs: value.stopGraceMs === undefined ? '' : String(value.stopGraceMs),
        autoRestart: value.autoRestart === true,
        restartDelayMs: value.restartDelayMs === undefined ? '' : String(value.restartDelayMs),
        dependsOn: (value.dependsOn ?? []).join(', '),
        envText: Object.entries(value.env ?? {}).map(([key, entry]) => `${key}=${entry}`).join('\n'),
        // The pipe format carries all four step fields, including the two that
        // were previously unreachable from the panel: `expect` and a trailing
        // `!`/`?` marker for `continueOnError`. A step the user wrote by hand with
        // an empty expect keeps its trailing column so the round trip is lossless.
        beforeText: (value.before ?? [])
          .map((step) => {
            const cells = [step.name, step.command, step.expect ?? ''];
            if (step.continueOnError === true) cells.push('continue');
            return cells.join(' | ');
          })
          .join('\n'),
      };
    }

    function numberOrUndefined(text) {
      const trimmed = String(text ?? '').trim();
      if (trimmed === '') return undefined;
      const value = Number(trimmed);
      return Number.isFinite(value) ? value : undefined;
    }

    /**
     * Draft to wire format. The store normalizes and bounds everything again on
     * the host, so this only has to be honest about what the user typed: an
     * unparseable number becomes a validation error before it ever travels.
     */
    function draftToProject(draft) {
      const env = {};
      for (const line of String(draft.envText ?? '').split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;
        const at = trimmed.indexOf('=');
        if (at <= 0) continue;
        env[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
      }
      const before = [];
      for (const line of String(draft.beforeText ?? '').split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        // Columns: name | command | expect (optional) | continue (optional).
        // Anything beyond the third cell is recognised by keyword rather than
        // position, so a step whose expect is empty still reads the marker.
        const parts = trimmed.split('|').map((part) => part.trim());
        if (parts[0] === '' || parts[1] === undefined || parts[1] === '') continue;
        const rest = parts.slice(2);
        const continueOnError = rest.some((part) => /^(continue|continueOnError)$/iu.test(part));
        const expect = rest
          .filter((part) => !/^(continue|continueOnError)$/iu.test(part))
          .join(' | ');
        before.push({ name: parts[0], command: parts[1], expect, continueOnError });
      }
      const project = {
        id: draft.id.trim(),
        name: draft.name.trim() === '' ? draft.id.trim() : draft.name.trim(),
        cwd: draft.cwd.trim(),
        command: draft.command.trim(),
        args: draft.args.trim(),
        role: draft.role,
        framework: draft.framework.trim(),
        readyHost: draft.readyHost.trim(),
        readyUrl: draft.readyUrl.trim(),
        autoRestart: draft.autoRestart === true,
        dependsOn: draft.dependsOn.split(',').map((part) => part.trim()).filter((part) => part !== ''),
        env,
        before,
      };
      const port = numberOrUndefined(draft.readyPort);
      if (port !== undefined) project.readyPort = port;
      const readyTimeoutMs = numberOrUndefined(draft.readyTimeoutMs);
      if (readyTimeoutMs !== undefined) project.readyTimeoutMs = readyTimeoutMs;
      const stopGraceMs = numberOrUndefined(draft.stopGraceMs);
      if (stopGraceMs !== undefined) project.stopGraceMs = stopGraceMs;
      const restartDelayMs = numberOrUndefined(draft.restartDelayMs);
      if (restartDelayMs !== undefined) project.restartDelayMs = restartDelayMs;
      return project;
    }

    /** Everything wrong with a draft, in the user's language. */
    function draftProblems(draft, knownIds, t) {
      const problems = [];
      if (draft.cwd.trim() === '') problems.push(t('editor.invalid.cwd'));
      if (draft.command.trim() === '') problems.push(t('editor.invalid.command'));
      const port = String(draft.readyPort ?? '').trim();
      if (port !== '') {
        const value = Number(port);
        if (!Number.isFinite(value) || value < 1 || value > 65535) problems.push(t('editor.invalid.port'));
      }
      const url = draft.readyUrl.trim();
      if (url !== '' && !/^https?:\/\//u.test(url)) problems.push(t('editor.invalid.url'));
      for (const [field, label] of [
        ['readyTimeoutMs', t('editor.readyTimeoutMs')],
        ['stopGraceMs', t('editor.stopGraceMs')],
        ['restartDelayMs', t('editor.restartDelayMs')],
      ]) {
        const raw = String(draft[field] ?? '').trim();
        if (raw !== '' && !Number.isFinite(Number(raw))) problems.push(t('editor.invalid.number', { field: label }));
      }
      const wanted = draft.dependsOn.split(',').map((part) => part.trim()).filter((part) => part !== '');
      const unknown = wanted.filter((id) => !knownIds.has(id));
      if (unknown.length > 0) problems.push(t('editor.invalid.dependsOn', { names: unknown.join(', ') }));
      String(draft.envText ?? '').split('\n').forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) return;
        if (trimmed.indexOf('=') <= 0) problems.push(t('editor.invalid.env', { line: index + 1 }));
      });
      String(draft.beforeText ?? '').split('\n').forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed === '') return;
        const parts = trimmed.split('|').map((part) => part.trim());
        if (parts[0] === '' || parts[1] === undefined || parts[1] === '') {
          problems.push(t('editor.invalid.before', { line: index + 1 }));
        }
      });
      return problems;
    }

    // ----------------------------------------------------------- fragments ----

    function Field({ label, hint, children }) {
      return jsx.jsx('label', {
        style: styles.field,
        children: [
          jsx.jsx('span', { key: 'label', style: styles.fieldLabel, children: label }),
          children,
          hint === undefined || hint === '' ? null : jsx.jsx('span', { key: 'hint', style: styles.fieldHint, children: hint }),
        ],
      });
    }

    function TextInput({ value, onChange, placeholder, type, onEnter }) {
      return jsx.jsx('input', {
        type: type ?? 'text',
        value,
        placeholder,
        style: styles.input,
        onChange: (event) => onChange(event.target.value),
        onKeyDown: onEnter === undefined ? undefined : (event) => {
          if (event.key === 'Enter') onEnter();
        },
      });
    }

    function TextArea({ value, onChange, rows, placeholder }) {
      return jsx.jsx('textarea', {
        value,
        rows: rows ?? 3,
        placeholder,
        style: styles.textarea,
        spellCheck: false,
        onChange: (event) => onChange(event.target.value),
      });
    }

    function Select({ value, options, onChange }) {
      return jsx.jsx('select', {
        value,
        style: styles.select,
        onChange: (event) => onChange(event.target.value),
        children: options.map((option) => jsx.jsx('option', {
          key: option.value,
          value: option.value,
          children: option.label,
        })),
      });
    }

    // ------------------------------------------------------------- editor ----

    /** Add/edit one project. Nothing is written until the draft validates. */
    /**
     * A stable text form of a draft, for comparing "what is typed now" against
     * "what was there when the editor opened". JSON of the field order is not
     * enough on its own because `steps` and `env` are free-form and reordered
     * entries are the same edit.
     */
    function draftFingerprint(draft) {
      const value = draft ?? {};
      const steps = (value.steps ?? []).map((step) => [step.name ?? '', step.command ?? '', step.expect ?? '', step.continueOnError === true ? '1' : '0'].join('\u0000'));
      const env = Object.entries(value.env ?? {}).map(([key, item]) => `${key}\u0000${item}`).sort();
      const before = (value.before ?? []).map((step) => [step.name ?? '', step.command ?? '', step.expect ?? '', step.continueOnError === true ? '1' : '0'].join('\u0000'));
      return JSON.stringify([
        value.id ?? '', value.name ?? '', value.cwd ?? '', value.command ?? '', value.role ?? '',
        value.dependsOn ?? [], value.port ?? '', value.readyUrl ?? '', value.readyHost ?? '',
        value.readyTimeoutMs ?? '', value.stopGraceMs ?? '', value.restartDelayMs ?? '',
        value.autoRestart ?? '', value.jvmArgs ?? '', env, before,
      ]);
    }

    function ProjectForm({ t, draft, setDraft, knownIds, onSubmit, onCancel, busy }) {
      const problems = draftProblems(draft, knownIds, t);
      const set = (field) => (value) => setDraft({ ...draft, [field]: value });
      const baseline = React.useRef(draft);
      const [leaving, setLeaving] = React.useState(false);
      const changed = draftFingerprint(draft) !== draftFingerprint(baseline.current);
      /**
       * Cancel means "throw my typing away", so it takes two clicks once anything
       * was typed. One click is enough when nothing changed: there is nothing to lose.
       */
      const askLeave = () => {
        if (changed === false || leaving === true) {
          onCancel();
          return;
        }
        setLeaving(true);
      };
      return jsx.jsx('div', {
        style: styles.sheetRoot,
        children: [
          jsx.jsx('div', {
            key: 'head',
            style: styles.sheetHead,
            children: [
              jsx.jsx('span', { style: { fontWeight: 600 }, children: draft.id === '' ? t('editor.newTitle') : t('editor.editTitle', { name: draft.name === '' ? draft.id : draft.name }) }),
              jsx.jsx('span', { style: styles.toolbarSpacer }),
              jsx.jsx('button', {
                type: 'button',
                style: buttonStyle(leaving),
                onClick: askLeave,
                children: leaving ? t('action.deleteConfirm') : t('action.cancel'),
              }),
            ],
          }),
          leaving === false
            ? null
            : jsx.jsx('div', {
                key: 'leave',
                style: { ...styles.warn, padding: '6px 10px' },
                children: [
                  jsx.jsx('span', { key: 'text', children: t('editor.leave') }),
                  jsx.jsx('span', { key: 'spacer', style: styles.toolbarSpacer }),
                  jsx.jsx('button', { key: 'stay', type: 'button', style: buttonStyle(false), onClick: () => setLeaving(false), children: t('action.back') }),
                ],
              }),
          jsx.jsx('div', {
            key: 'sheet',
            style: styles.sheet,
            children: [
              jsx.jsx('div', {
                key: 'ids',
                style: styles.grid,
                children: [
                  jsx.jsx(Field, {
                    key: 'id',
                    label: t('editor.id'),
                    hint: t('editor.idHint'),
                    children: jsx.jsx(TextInput, { value: draft.id, onChange: set('id') }),
                  }),
                  jsx.jsx(Field, {
                    key: 'name',
                    label: t('editor.name'),
                    children: jsx.jsx(TextInput, { value: draft.name, onChange: set('name') }),
                  }),
                  jsx.jsx(Field, {
                    key: 'role',
                    label: t('editor.role'),
                    children: jsx.jsx(Select, {
                      value: draft.role,
                      onChange: set('role'),
                      options: [
                        { value: 'backend', label: t('role.backend') },
                        { value: 'frontend', label: t('role.frontend') },
                        { value: 'service', label: t('role.service') },
                        { value: 'infra', label: t('role.infra') },
                      ],
                    }),
                  }),
                  jsx.jsx(Field, {
                    key: 'framework',
                    label: t('editor.framework'),
                    children: jsx.jsx(TextInput, { value: draft.framework, onChange: set('framework') }),
                  }),
                ],
              }),
              jsx.jsx(Field, {
                key: 'cwd',
                label: t('editor.cwd'),
                hint: t('editor.cwdHint'),
                children: jsx.jsx(TextInput, { value: draft.cwd, onChange: set('cwd') }),
              }),
              jsx.jsx('div', {
                key: 'cmd',
                style: styles.grid,
                children: [
                  jsx.jsx(Field, {
                    key: 'command',
                    label: t('editor.command'),
                    hint: t('editor.commandHint'),
                    children: jsx.jsx(TextInput, { value: draft.command, onChange: set('command') }),
                  }),
                  jsx.jsx(Field, {
                    key: 'args',
                    label: t('editor.args'),
                    hint: t('editor.argsHint'),
                    children: jsx.jsx(TextInput, { value: draft.args, onChange: set('args') }),
                  }),
                ],
              }),
              jsx.jsx(Field, {
                key: 'env',
                label: t('editor.env'),
                hint: t('editor.envHint'),
                children: jsx.jsx(TextArea, { value: draft.envText, onChange: set('envText'), rows: 3 }),
              }),
              jsx.jsx('div', {
                key: 'ready',
                style: styles.grid,
                children: [
                  jsx.jsx(Field, {
                    key: 'port',
                    label: t('editor.readyPort'),
                    hint: t('editor.readyPortHint'),
                    children: jsx.jsx(TextInput, { value: draft.readyPort, onChange: set('readyPort') }),
                  }),
                  jsx.jsx(Field, {
                    key: 'host',
                    label: t('editor.readyHost'),
                    hint: t('editor.readyHostHint'),
                    children: jsx.jsx(TextInput, { value: draft.readyHost, onChange: set('readyHost') }),
                  }),
                  jsx.jsx(Field, {
                    key: 'url',
                    label: t('editor.readyUrl'),
                    hint: t('editor.readyUrlHint'),
                    children: jsx.jsx(TextInput, { value: draft.readyUrl, onChange: set('readyUrl') }),
                  }),
                  jsx.jsx(Field, {
                    key: 'timeout',
                    label: t('editor.readyTimeoutMs'),
                    children: jsx.jsx(TextInput, { value: draft.readyTimeoutMs, onChange: set('readyTimeoutMs') }),
                  }),
                  jsx.jsx(Field, {
                    key: 'grace',
                    label: t('editor.stopGraceMs'),
                    children: jsx.jsx(TextInput, { value: draft.stopGraceMs, onChange: set('stopGraceMs') }),
                  }),
                  jsx.jsx(Field, {
                    key: 'restartDelay',
                    label: t('editor.restartDelayMs'),
                    children: jsx.jsx(TextInput, { value: draft.restartDelayMs, onChange: set('restartDelayMs') }),
                  }),
                ],
              }),
              jsx.jsx(Field, {
                key: 'depends',
                label: t('editor.dependsOn'),
                hint: t('editor.dependsOnHint'),
                children: jsx.jsx(TextInput, { value: draft.dependsOn, onChange: set('dependsOn') }),
              }),
              jsx.jsx(Field, {
                key: 'before',
                label: t('editor.before'),
                hint: t('editor.beforeHint'),
                children: jsx.jsx(TextArea, { value: draft.beforeText, onChange: set('beforeText'), rows: 3 }),
              }),
              jsx.jsx('label', {
                key: 'autoRestart',
                style: { display: 'flex', alignItems: 'center', gap: '6px' },
                children: [
                  jsx.jsx('input', {
                    type: 'checkbox',
                    checked: draft.autoRestart,
                    onChange: (event) => set('autoRestart')(event.target.checked),
                  }),
                  jsx.jsx('span', { children: t('editor.autoRestart') }),
                ],
              }),
            ],
          }),
          jsx.jsx('div', {
            key: 'foot',
            style: styles.sheetFoot,
            children: [
              jsx.jsx('button', {
                type: 'button',
                style: buttonStyle(problems.length > 0 || busy === 'save', true),
                onClick: () => {
                  if (problems.length === 0) onSubmit(draftToProject(draft));
                },
                children: t('action.save'),
              }),
              jsx.jsx('button', { type: 'button', style: buttonStyle(false), onClick: onCancel, children: t('action.cancel') }),
              jsx.jsx('span', { style: styles.toolbarSpacer }),
              problems.length === 0
                ? null
                : jsx.jsx('span', { style: styles.error, children: problems.join('；') }),
            ],
          }),
        ],
      });
    }

    // ----------------------------------------------------------- discovery ---

    /** Scan a folder through the host and offer the candidates it can prove. */
    /** Identity of "start command N of candidate X". */
    function optionKey(candidateId, index) {
      return `${candidateId}#${index}`;
    }

    function optionList(candidate) {
      return Array.isArray(candidate.commandOptions) ? candidate.commandOptions : [];
    }

    /** What to call one command in the UI: the npm script, else the note, else the index. */
    function optionLabel(option, index) {
      if (option === undefined || option === null) return `#${index}`;
      if (typeof option.script === 'string' && option.script !== '') return option.script;
      if (typeof option.note === 'string' && option.note !== '') return option.note;
      return `#${index}`;
    }

    /** Id suffix for a project split out of a candidate with several commands. */
    function optionSlug(option, index) {
      const slug = String(optionLabel(option, index))
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-+|-+$/gu, '');
      return slug === '' ? `option-${index}` : slug;
    }

    /**
     * Turn picked `candidate#option` keys into project drafts.
     *
     * A candidate with one picked command keeps its own id. A candidate whose
     * several commands are all wanted — uni-app's `dev:h5` plus `dev:mp-weixin`,
     * or a backend you also want to compile first — becomes one project per
     * command, suffixed with the script name so the ids stay unique. Dependencies
     * are rewritten to whatever ids the depended-on candidate produced, so
     * splitting one project never leaves another's `dependsOn` dangling.
     */
    function discoveryPlan(candidates, keys) {
      const wanted = new Set(Array.isArray(keys) ? keys : []);
      const list = Array.isArray(candidates) ? candidates : [];
      const entries = [];
      const idsByCandidate = {};
      for (const candidate of list) {
        const options = optionList(candidate);
        const picked = [];
        const total = Math.max(options.length, 1);
        for (let index = 0; index < total; index += 1) {
          if (wanted.has(optionKey(candidate.id, index))) picked.push(index);
        }
        if (picked.length === 0) continue;
        const ids = [];
        for (const index of picked) {
          const option = options[index];
          const lone = picked.length === 1;
          const id = lone ? candidate.id : `${candidate.id}-${optionSlug(option, index)}`;
          ids.push(id);
          entries.push({
            source: candidate,
            project: {
              id,
              name: lone ? candidate.name : `${candidate.name} · ${optionLabel(option, index)}`,
              cwd: candidate.cwd,
              command: option === undefined ? candidate.command : option.command,
              role: candidate.role,
              framework: candidate.framework,
              readyPort: option === undefined ? candidate.readyPort : option.readyPort,
              dependsOn: [],
              source: 'discovered',
            },
          });
        }
        idsByCandidate[candidate.id] = ids;
      }
      for (const entry of entries) {
        const declared = Array.isArray(entry.source.dependsOn) ? entry.source.dependsOn : [];
        for (const dependency of declared) {
          const produced = idsByCandidate[dependency];
          const targets = Array.isArray(produced) && produced.length > 0 ? produced : [dependency];
          for (const id of targets) {
            if (id !== entry.project.id && entry.project.dependsOn.indexOf(id) === -1) entry.project.dependsOn.push(id);
          }
        }
      }
      return entries.map((entry) => entry.project);
    }

    function DiscoverPanel({ t, defaultRoot, onClose, onApply, busy }) {
      const [root, setRoot] = React.useState(defaultRoot ?? '');
      const [depth, setDepth] = React.useState('2');
      const [result, setResult] = React.useState(null);
      const [picked, setPicked] = React.useState({});
      const [replace, setReplace] = React.useState(false);
      const [error, setError] = React.useState('');
      const [scanning, setScanning] = React.useState(false);

      /**
       * Ask the host to stop walking.
       *
       * Aborting the fetch in `call` only closes this side of the request: the
       * walk keeps a core pinned and every later request queues behind it, so a
       * scan the user has given up on has to be cancelled on the host too.
       */
      const cancel = () => {
        void call('/discover/cancel', { method: 'POST' }).catch(() => undefined);
      };

      const scan = async () => {
        if (root.trim() === '') {
          setError(t('discover.noRoot'));
          return;
        }
        setScanning(true);
        setError('');
        try {
          const body = await call('/discover', {
            method: 'POST',
            body: JSON.stringify({ root: root.trim(), maxDepth: Number(depth) }),
            timeoutMs: DISCOVER_TIMEOUT_MS,
          });
          const candidates = Array.isArray(body.candidates) ? body.candidates : [];
          setResult({ candidates, problems: Array.isArray(body.problems) ? body.problems : [], scanned: body.scanned });
          // Start with one command per candidate — the primary one. A candidate
          // with more (uni-app's dev:mp-weixin next to dev:h5, say) is offered as
          // extra checkboxes in the list rather than turned on silently.
          const next = {};
          for (const candidate of candidates) next[optionKey(candidate.id, 0)] = true;
          setPicked(next);
        } catch (failure) {
          // A deadline here means the host is still walking, not that the scan
          // was rejected: stop it before the panel forgets about it.
          cancel();
          setError(readError(failure));
        } finally {
          setScanning(false);
        }
      };

      const candidates = result === null ? [] : result.candidates;
      const keys = Object.keys(picked).filter((key) => picked[key] === true);
      const plan = discoveryPlan(candidates, keys);
      const apply = () => onApply(plan, replace);
      const everyOption = (candidate) => {
        const total = Math.max(optionList(candidate).length, 1);
        for (let index = 0; index < total; index += 1) {
          if (picked[optionKey(candidate.id, index)] !== true) return false;
        }
        return true;
      };
      const pickAll = (candidate, on) => {
        const next = { ...picked };
        const total = Math.max(optionList(candidate).length, 1);
        for (let index = 0; index < total; index += 1) {
          const key = optionKey(candidate.id, index);
          if (on) next[key] = true;
          else delete next[key];
        }
        setPicked(next);
      };
      const pickOne = (candidateId, index, on) => {
        const next = { ...picked };
        const key = optionKey(candidateId, index);
        if (on) next[key] = true;
        else delete next[key];
        setPicked(next);
      };

      return jsx.jsx('div', {
        style: styles.sheetRoot,
        children: [
          jsx.jsx('div', {
            key: 'head',
            style: styles.sheetHead,
            children: [
              jsx.jsx('span', { style: { fontWeight: 600 }, children: t('discover.heading') }),
              jsx.jsx('span', { style: styles.toolbarSpacer }),
              jsx.jsx('button', { type: 'button', style: buttonStyle(false), onClick: onClose, children: t('action.close') }),
            ],
          }),
          jsx.jsx('div', {
            key: 'sheet',
            style: styles.sheet,
            children: [
              jsx.jsx('div', {
                key: 'controls',
                style: styles.grid,
                children: [
                  jsx.jsx(Field, {
                    key: 'root',
                    label: t('discover.root'),
                    hint: t('discover.rootHint'),
                    children: jsx.jsx(TextInput, { value: root, onChange: setRoot, onEnter: scan }),
                  }),
                  jsx.jsx(Field, {
                    key: 'depth',
                    label: t('discover.depth'),
                    children: jsx.jsx(TextInput, { value: depth, onChange: setDepth }),
                  }),
                ],
              }),
              jsx.jsx('div', {
                key: 'actions',
                style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' },
                children: [
                  jsx.jsx('button', {
                    type: 'button',
                    style: buttonStyle(scanning, true),
                    onClick: scan,
                    children: scanning ? t('discover.scanning') : t('discover.scan'),
                  }),
                  scanning
                    ? jsx.jsx('button', {
                        type: 'button',
                        style: buttonStyle(false),
                        onClick: cancel,
                        children: t('discover.cancel'),
                      })
                    : null,
                  result === null
                    ? null
                    : jsx.jsx('button', {
                        type: 'button',
                        style: buttonStyle(false),
                        // The state a scan starts in. "Select all" is destructive in a
                        // way that is easy to miss: a uni-app folder contributes
                        // dev:h5 AND dev:mp-weixin, and ticking both means two copies
                        // of the same app fighting over one port. One click back.
                        onClick: () => {
                          const next = {};
                          for (const candidate of candidates) next[optionKey(candidate.id, 0)] = true;
                          setPicked(next);
                        },
                        children: t('action.selectPrimary'),
                      }),
                  result === null
                    ? null
                    : jsx.jsx('button', {
                        type: 'button',
                        style: buttonStyle(false),
                        onClick: () => {
                          const next = {};
                          for (const candidate of candidates) {
                            const total = Math.max(optionList(candidate).length, 1);
                            for (let index = 0; index < total; index += 1) next[optionKey(candidate.id, index)] = true;
                          }
                          setPicked(next);
                        },
                        children: t('action.selectAll'),
                      }),
                  result === null
                    ? null
                    : jsx.jsx('button', {
                        type: 'button',
                        style: buttonStyle(false),
                        onClick: () => setPicked({}),
                        children: t('action.selectNone'),
                      }),
                  error === '' ? null : jsx.jsx('span', { style: styles.error, children: error }),
                ],
              }),
              result !== null && candidates.length === 0
                ? jsx.jsx('div', { key: 'none', style: styles.hint, children: t('discover.none') })
                : null,
              result === null
                ? null
                : jsx.jsx('div', {
                    key: 'results',
                    style: { display: 'flex', flexDirection: 'column', gap: '7px' },
                    children: candidates.map((candidate) => {
                      const options = optionList(candidate);
                      const primary = options[0];
                      const port = primary === undefined ? candidate.readyPort : primary.readyPort;
                      const portSource = primary === undefined ? candidate.readyPortSource : primary.readyPortSource;
                      return jsx.jsx('div', {
                        key: candidate.id,
                        style: styles.candidate,
                        children: [
                          jsx.jsx('label', {
                            key: 'title',
                            style: { display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 600 },
                            children: [
                              jsx.jsx('input', {
                                type: 'checkbox',
                                checked: everyOption(candidate),
                                onChange: (event) => pickAll(candidate, event.target.checked),
                              }),
                              jsx.jsx('span', { children: candidate.name }),
                              jsx.jsx('span', { style: styles.chip, children: roleLabel(candidate.role, t) }),
                              jsx.jsx('span', { style: styles.chip, children: candidate.framework }),
                              port === null || port === undefined ? null : jsx.jsx('span', {
                                style: styles.chip,
                                title: portSource ?? '',
                                children: t('meta.port', { port }),
                              }),
                            ],
                          }),
                          jsx.jsx('span', { key: 'cwd', style: styles.fieldHint, children: candidate.cwd }),
                          options.length <= 1
                            ? jsx.jsx('span', {
                                key: 'command',
                                style: styles.fieldHint,
                                children: `${t('discover.command')}: ${primary === undefined ? candidate.command : primary.command}`,
                              })
                            : jsx.jsx('div', {
                                key: 'commands',
                                style: { display: 'flex', flexDirection: 'column', gap: '3px' },
                                children: [
                                  jsx.jsx('span', {
                                    key: 'label',
                                    style: styles.fieldHint,
                                    children: t('discover.chooseCommand', { count: options.length }),
                                  }),
                                  ...options.map((option, index) => jsx.jsx('label', {
                                    key: `option-${index}`,
                                    style: { display: 'flex', alignItems: 'center', gap: '6px' },
                                    children: [
                                      jsx.jsx('input', {
                                        type: 'checkbox',
                                        checked: picked[optionKey(candidate.id, index)] === true,
                                        onChange: (event) => pickOne(candidate.id, index, event.target.checked),
                                      }),
                                      jsx.jsx('span', { style: { fontFamily: 'monospace' }, children: option.command }),
                                      option.script === undefined ? null : jsx.jsx('span', { style: styles.chip, children: option.script }),
                                      option.readyPort === null || option.readyPort === undefined ? null : jsx.jsx('span', {
                                        style: styles.chip,
                                        title: option.readyPortSource ?? '',
                                        children: t('meta.port', { port: option.readyPort }),
                                      }),
                                    ],
                                  })),
                                ],
                              }),
                          port === null || port === undefined || options.length > 1
                            ? null
                            : jsx.jsx('span', {
                                key: 'portSource',
                                style: styles.fieldHint,
                                children: t('discover.portSource', { source: portSource ?? '' }),
                              }),
                          candidate.dependsOn === undefined || candidate.dependsOn.length === 0
                            ? null
                            : jsx.jsx('span', {
                                key: 'depends',
                                style: styles.fieldHint,
                                children: t('discover.dependency', { reason: candidate.dependsOnWhy ?? candidate.dependsOn.join(', ') }),
                              }),
                          jsx.jsx('span', {
                            key: 'evidence',
                            style: styles.fieldHint,
                            children: `${t('discover.evidence')}: ${(candidate.evidence ?? []).join(' · ')}`,
                          }),
                        ],
                      });
                    }),
                  }),
              result !== null && Array.isArray(result.problems) && result.problems.length > 0
                ? jsx.jsx('div', {
                    key: 'problems',
                    style: styles.warn,
                    children: result.problems.join('；'),
                  })
                : null,
            ],
          }),
          jsx.jsx('div', {
            key: 'foot',
            style: styles.sheetFoot,
            children: [
              jsx.jsx('label', {
                style: { display: 'flex', alignItems: 'center', gap: '6px' },
                children: [
                  jsx.jsx('input', { type: 'checkbox', checked: replace, onChange: (event) => setReplace(event.target.checked) }),
                  jsx.jsx('span', { children: t('discover.replace') }),
                ],
              }),
              jsx.jsx('span', { style: styles.fieldHint, children: t('discover.replaceHint') }),
              jsx.jsx('span', { style: styles.toolbarSpacer }),
              jsx.jsx('span', { style: styles.fieldHint, children: t('discover.results', { count: plan.length }) }),
              jsx.jsx('button', {
                type: 'button',
                style: buttonStyle(plan.length === 0 || busy !== '', true),
                onClick: apply,
                children: t('discover.apply'),
              }),
            ],
          }),
        ],
      });
    }

    // ------------------------------------------------------------- log view --

    /** One line: ANSI when unfiltered, a marked-up plain line while filtering. */
    function LogLine({ entry, query, register }) {
      const base = entry.stream === 'stderr' ? styles.lineErr : entry.stream === 'runner' ? styles.lineRunner : null;
      const style = base === null ? styles.line : { ...styles.line, ...base };
      const text = String(entry.text ?? '');
      let children;
      const at = query === '' ? -1 : stripAnsi(text).toLowerCase().indexOf(query.toLowerCase());
      if (at >= 0) {
        const plain = stripAnsi(text);
        children = [
          jsx.jsx('span', { key: 'a', children: plain.slice(0, at) }),
          jsx.jsx('span', { key: 'b', style: styles.match, children: plain.slice(at, at + query.length) }),
          jsx.jsx('span', { key: 'c', children: plain.slice(at + query.length) }),
        ];
      } else {
        children = ansiSpans(text).map((span, index) => jsx.jsx('span', {
          key: index,
          style: span.style,
          children: span.text === '' ? '\u00a0' : span.text,
        }));
      }
      return jsx.jsx('div', {
        ref: register,
        style,
        'data-seq': entry.seq,
        children,
      });
    }

    function LogView({ t, projectId, entries, lossy, onClear }) {
      const [query, setQuery] = React.useState('');
      const [follow, setFollow] = React.useState(true);
      const [cursor, setCursor] = React.useState(0);
      const [copied, setCopied] = React.useState(false);
      const container = React.useRef(null);
      const nodes = React.useRef(new Map());

      // Switching projects must start from a clean view. Without this, the filter
      // text, the "follow" switch and the jump cursor all leak: a search that
      // matched nothing in the previous project keeps the next one filtered, and a
      // paused scroll follows nothing. Adjusting state during render (rather than
      // in an effect) avoids showing one frame of the previous project's state.
      const lastProject = React.useRef(projectId);
      if (lastProject.current !== projectId) {
        lastProject.current = projectId;
        setQuery('');
        setFollow(true);
        setCursor(0);
        setCopied(false);
        nodes.current.clear();
      }

      const matches = React.useMemo(() => {
        if (query === '') return [];
        const needle = query.toLowerCase();
        const found = [];
        entries.forEach((entry, index) => {
          if (stripAnsi(String(entry.text ?? '')).toLowerCase().includes(needle)) found.push(index);
        });
        return found;
      }, [entries, query]);

      React.useEffect(() => {
        setCursor(0);
      }, [query]);

      React.useEffect(() => {
        if (!follow || container.current === null) return;
        container.current.scrollTop = container.current.scrollHeight;
      }, [entries, follow]);

      /** Only the plain text leaves the panel; colour codes are terminal trivia. */
      const plainText = () => entries.map((entry) => stripAnsi(String(entry.text ?? ''))).join('\n');

      const copy = async () => {
        const text = plainText();
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // Clipboard permission can be refused; a throwaway textarea still works.
          const area = document.createElement('textarea');
          area.value = text;
          area.style.position = 'fixed';
          area.style.opacity = '0';
          document.body.appendChild(area);
          area.select();
          try {
            document.execCommand('copy');
          } catch {}
          document.body.removeChild(area);
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      };

      const jump = (delta) => {
        if (matches.length === 0) return;
        const next = (cursor + delta + matches.length) % matches.length;
        setCursor(next);
        setFollow(false);
        const entry = entries[matches[next]];
        const node = entry === undefined ? undefined : nodes.current.get(entry.seq);
        if (node !== undefined && typeof node.scrollIntoView === 'function') {
          node.scrollIntoView({ block: 'center' });
        }
      };

      return jsx.jsx('div', {
        style: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0 },
        children: [
          jsx.jsx('div', {
            key: 'tools',
            style: styles.logTool,
            children: [
              jsx.jsx('input', {
                key: 'filter',
                type: 'text',
                value: query,
                placeholder: t('log.filter'),
                style: { ...styles.input, width: '150px' },
                onChange: (event) => setQuery(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') jump(event.shiftKey ? -1 : 1);
                },
              }),
              query === ''
                ? null
                : jsx.jsx('span', {
                    key: 'count',
                    style: matches.length === 0 ? styles.warn : styles.fieldHint,
                    children: matches.length === 0
                      ? t('log.noMatches')
                      : t('log.matches', { index: matches.length === 0 ? 0 : cursor + 1, count: matches.length }),
                  }),
              query === ''
                ? null
                : jsx.jsx('button', { key: 'prev', type: 'button', style: buttonStyle(false), title: t('log.prev'), onClick: () => jump(-1), children: '↑' }),
              query === ''
                ? null
                : jsx.jsx('button', { key: 'next', type: 'button', style: buttonStyle(false), title: t('log.next'), onClick: () => jump(1), children: '↓' }),
              jsx.jsx('span', { key: 'spacer', style: styles.toolbarSpacer }),
              jsx.jsx('label', {
                key: 'follow',
                style: { display: 'flex', alignItems: 'center', gap: '4px' },
                children: [
                  jsx.jsx('input', {
                    type: 'checkbox',
                    checked: follow,
                    onChange: (event) => setFollow(event.target.checked),
                  }),
                  jsx.jsx('span', { children: t('action.follow') }),
                ],
              }),
              jsx.jsx('button', {
                key: 'clear',
                type: 'button',
                style: buttonStyle(false),
                onClick: () => {
                  nodes.current.clear();
                  onClear();
                },
                children: t('action.clearLog'),
              }),
              jsx.jsx('button', {
                key: 'copy',
                type: 'button',
                style: buttonStyle(entries.length === 0),
                onClick: copy,
                children: copied ? t('action.copied') : t('action.copy'),
              }),
              jsx.jsx('a', {
                key: 'download',
                href: `${API}/logs.txt?id=${encodeURIComponent(projectId)}`,
                download: `${projectId}.log`,
                style: buttonStyle(entries.length === 0),
                children: t('action.download'),
              }),
            ],
          }),
          jsx.jsx('div', {
            key: 'log',
            ref: container,
            style: styles.log,
            children: entries.length === 0
              ? jsx.jsx('span', { style: styles.hint, children: t('log.empty') })
              : [
                  lossy ? jsx.jsx('span', { key: 'lossy', style: styles.lineRunner, children: t('log.lossy') }) : null,
                  ...entries.map((entry) => jsx.jsx(LogLine, {
                    key: entry.seq,
                    entry,
                    query,
                    register: (node) => {
                      if (node === null) nodes.current.delete(entry.seq);
                      else nodes.current.set(entry.seq, node);
                    },
                  })),
                ],
          }),
        ],
      });
    }

    // ------------------------------------------------------------ the page ---

    /** The panel body: project list on the left, one project's log on the right. */
    function DevRunnerBody(props) {
      const { t, active } = props;
      const runner = useRunner();
      const [mode, setMode] = React.useState('none');
      const [draft, setDraft] = React.useState(null);
      const table = useTable(mode !== 'none');
      const project = runner.projects.find((candidate) => candidate.id === runner.selected);
      const log = useLog(runner.selected, active !== false);

      // A session id is not a folder: passing it here made the default scan a
      // path that does not exist, so the first scan of every project answered
      // "directory not found". The parent of the first configured project is a
      // real folder, and it is where that project's siblings - the thing a scan
      // is looking for - live.
      const firstCwd = String(runner.projects[0]?.cwd ?? '');
      const defaultRoot = firstCwd.replace(/[\\/][^\\/]+$/u, '');
      const knownIds = new Set(runner.projects.map((candidate) => candidate.id));
      const sourceLine = runner.source === 'store'
        ? t('source.store', { file: runner.storeFile })
        : runner.source === 'store-empty'
          ? t('source.storeEmpty', { file: runner.storeFile })
          : t('source.config');

      const openNew = () => {
        setDraft(projectToDraft({ role: 'service', readyTimeoutMs: 120000, stopGraceMs: 8000, restartDelayMs: 1000 }));
        setMode('edit');
        table.reload();
      };
      const openEdit = (target) => {
        setDraft(projectToDraft(target));
        setMode('edit');
        table.reload();
      };
      const submit = async (value) => {
        const ok = await table.save(value);
        if (ok) {
          setMode('none');
          setDraft(null);
          await runner.refresh();
        }
      };
      /**
       * Which project is waiting for delete confirmation, by id.
       *
       * This used to be `window.confirm`, which is the wrong tool inside a
       * plugin: Electron can suppress a native dialog (and then `confirm` returns
       * false without ever asking), so the button looked dead. An in-panel
       * confirmation always exists, is dismissible with Escape, and can name the
       * project without a modal window stealing focus.
       */
      const [confirming, setConfirming] = React.useState('');
      const remove = async (target) => {
        if (confirming !== target.id) {
          setConfirming(target.id);
          return;
        }
        setConfirming('');
        const ok = await table.remove(target.id);
        if (ok) await runner.refresh();
      };

      /**
       * The editor and the scan sheet REPLACE the panel; they do not float over
       * it.
       *
       * The first version positioned them `absolute: inset 0` inside the pane,
       * which assumed the pane was the containing block. In the real sidebar that
       * is not guaranteed — the pane scrolls its own content, so an absolutely
       * positioned child anchors to a scrolling box and its header/footer land on
       * top of the project list underneath. Replacing the body avoids the question
       * entirely: one thing is mounted at a time, and it lays itself out with the
       * same flex column the rest of the panel uses.
       */
      if (mode === 'edit' && draft !== null) {
        return jsx.jsx(ProjectForm, {
          t,
          draft,
          setDraft,
          knownIds,
          busy: table.busy,
          onSubmit: submit,
          onCancel: () => {
            setMode('none');
            setDraft(null);
          },
        });
      }
      if (mode === 'discover') {
        return jsx.jsx(DiscoverPanel, {
          t,
          defaultRoot,
          busy: table.busy,
          onClose: () => setMode('none'),
          onApply: async (candidates, replace) => {
            const body = await call('/discover/apply', {
              method: 'POST',
              body: JSON.stringify({ candidates, replace }),
            }).catch(() => undefined);
            if (body !== undefined) {
              setMode('none');
              await table.reload();
              await runner.refresh();
            }
          },
        });
      }

      return jsx.jsx('div', {
        style: styles.root,
        children: [
          jsx.jsx('div', {
            key: 'toolbar',
            style: styles.toolbar,
            children: [
              jsx.jsx('span', {
                key: 'brand',
                style: styles.brand,
                children: [
                  jsx.jsx('svg', {
                    key: 'mark',
                    style: styles.brandMark,
                    viewBox: '0 0 64 64',
                    'aria-hidden': 'true',
                    children: [
                      jsx.jsx('rect', { key: 'win', x: 4, y: 10, width: 56, height: 44, rx: 8, fill: '#111827' }),
                      jsx.jsx('rect', { key: 'bar', x: 4, y: 10, width: 56, height: 12, rx: 8, fill: '#1f2937' }),
                      jsx.jsx('circle', { key: 'd1', cx: 12, cy: 16, r: 2.4, fill: '#22c55e' }),
                      jsx.jsx('circle', { key: 'd2', cx: 20, cy: 16, r: 2.4, fill: '#eab308' }),
                      jsx.jsx('circle', { key: 'd3', cx: 28, cy: 16, r: 2.4, fill: '#ef4444' }),
                      jsx.jsx('path', { key: 'chev', d: 'M14 32l7 7-7 7', stroke: '#22c55e', strokeWidth: 3, fill: 'none' }),
                      jsx.jsx('rect', { key: 'l1', x: 26, y: 34, width: 16, height: 3, rx: 1.5, fill: '#38bdf8', opacity: 0.75 }),
                      jsx.jsx('rect', { key: 'l2', x: 26, y: 42, width: 24, height: 3, rx: 1.5, fill: '#38bdf8' }),
                    ],
                  }),
                  jsx.jsx('span', { key: 'name', children: t('panel.title') }),
                ],
              }),
              jsx.jsx('span', { key: 'gap', style: styles.toolbarSpacer }),
              jsx.jsx('button', {
                key: 'add',
                type: 'button',
                style: buttonStyle(false),
                onClick: openNew,
                children: t('action.add'),
              }),
              jsx.jsx('button', {
                key: 'scan',
                type: 'button',
                style: buttonStyle(false),
                onClick: () => {
                  setMode('discover');
                  table.reload();
                },
                children: t('action.scan'),
              }),
              jsx.jsx('button', {
                key: 'refresh',
                type: 'button',
                style: buttonStyle(false),
                onClick: () => runner.refresh(),
                children: t('action.refresh'),
              }),
            ],
          }),
          // Start/stop all live on their own bar: they act on every project, so
          // they belong next to the summary, not mixed in with editing actions.
          jsx.jsx('div', {
            key: 'actions',
            style: styles.actionBar,
            children: [
              jsx.jsx('button', {
                key: 'startAll',
                type: 'button',
                style: buttonStyle(runner.busy !== '' || runner.projects.length === 0, true),
                onClick: async () => {
                  const result = await runner.act('/start-all', { label: 'start-all' });
                  // A run where some projects failed should say so once, not leave the
                  // user counting red rows. The host returns the summary.
                  const failed = Array.isArray(result?.failed) ? result.failed : [];
                  if (result?.cancelled === true) {
                    // Stopped part-way by "Stop all": saying "did not start" about
                    // projects the user himself called off would be a lie.
                    runner.setNotice(t('notice.startAllCancelled'));
                    return;
                  }
                  runner.setNotice(failed.length === 0
                    ? ''
                    : t('notice.startAllFailed', { count: failed.length, names: failed.map((item) => item.name).join(', ') }));
                },
                children: t('action.startAll'),
              }),
              jsx.jsx('button', {
                key: 'stopAll',
                type: 'button',
                style: buttonStyle(runner.busy !== '' || runner.projects.length === 0),
                onClick: () => runner.act('/stop-all', { label: 'stop-all' }),
                children: t('action.stopAll'),
              }),
              jsx.jsx('span', { key: 'gap', style: styles.toolbarSpacer }),
              jsx.jsx('span', {
                key: 'summary',
                style: styles.summary,
                children: t('panel.summary', {
                  total: runner.projects.length,
                  running: runner.projects.filter((item) => isLive(item)).length,
                }),
              }),
            ],
          }),
          runner.error === ''
            ? null
            : jsx.jsx('div', { key: 'error', style: { ...styles.hint, paddingBottom: 0 }, children: t('error.request', { message: runner.error }) }),
          runner.notice === undefined || runner.notice === ''
            ? null
            : jsx.jsx('div', { key: 'notice', style: { ...styles.warn, padding: '2px 10px 6px' }, children: runner.notice }),
          jsx.jsx('div', {
            key: 'source',
            style: { ...styles.source, padding: '2px 10px 6px 10px' },
            children: [
              sourceLine,
              runner.problems.length === 0 ? '' : ` · ${t('source.problems', { count: runner.problems.length })}`,
            ].join(''),
          }),
          runner.projects.length === 0
            ? jsx.jsx('div', {
                key: 'empty',
                style: styles.hint,
                children: `${t('list.empty')} ${t('list.emptyHint')}`,
              })
            : jsx.jsx('div', {
                key: 'body',
                style: styles.body,
                children: [
                  jsx.jsx('div', {
                    key: 'list',
                    style: styles.list,
                    children: runner.projects.map((candidate) => {
                      const active = candidate.id === runner.selected;
                      return jsx.jsx('button', {
                        key: candidate.id,
                        type: 'button',
                        style: { ...styles.row, ...(active ? styles.rowActive : null) },
                        onClick: () => runner.setSelected(candidate.id),
                        children: [
                          jsx.jsx('span', {
                            key: 'head',
                            style: styles.rowHead,
                            children: [
                              jsx.jsx('span', { key: 'dot', style: { ...styles.dot, ...stateDot(candidate.state) } }),
                              jsx.jsx('span', { key: 'name', style: styles.rowName, children: candidate.name }),
                            ],
                          }),
                          jsx.jsx('span', {
                            key: 'meta',
                            style: styles.rowMeta,
                            children: waitRowText(candidate, t),
                          }),
                        ],
                      });
                    }),
                  }),
                  jsx.jsx('div', {
                    key: 'detail',
                    style: styles.detail,
                    children: project === undefined
                      ? jsx.jsx('div', { style: styles.hint, children: t('log.noProject') })
                      : [
                          jsx.jsx('div', {
                            key: 'head',
                            style: styles.detailHead,
                            children: [
                              jsx.jsx('div', {
                                key: 'title',
                                style: styles.detailTitle,
                                children: [
                                  jsx.jsx('span', { key: 'dot', style: { ...styles.dot, ...stateDot(project.state) } }),
                                  jsx.jsx('span', { key: 'name', style: styles.detailName, children: project.name }),
                                  jsx.jsx('span', {
                                    key: 'state',
                                    style: { ...styles.badge, color: dotColor(project.state) },
                                    children: stateLabel(project, t),
                                  }),
                                ],
                              }),
                              jsx.jsx('div', {
                                key: 'actions',
                                style: styles.detailActions,
                                children: [
                                  jsx.jsx('button', {
                                    key: 'toggle',
                                    type: 'button',
                                    // Only this row is busy: a start that is waiting out
                                    // its readiness probe takes as long as the probe does,
                                    // and greying out every other row for that long reads
                                    // as the whole panel being frozen.
                                    style: buttonStyle(runner.busy === project.id, true),
                                    onClick: () => runner.act(
                                      `/projects/${encodeURIComponent(project.id)}/${isLive(project) ? 'stop' : 'start'}`,
                                      { label: project.id },
                                    ),
                                    children: isLive(project) ? t('action.stop') : t('action.start'),
                                  }),
                                  jsx.jsx('button', {
                                    key: 'restart',
                                    type: 'button',
                                    style: buttonStyle(runner.busy === project.id),
                                    onClick: () => runner.act(`/projects/${encodeURIComponent(project.id)}/restart`, { label: project.id }),
                                    children: t('action.restart'),
                                  }),
                                  jsx.jsx('button', { key: 'edit', type: 'button', style: buttonStyle(false), onClick: () => openEdit(project), children: t('action.edit') }),
                                  jsx.jsx('button', {
                                    key: 'delete',
                                    type: 'button',
                                    style: confirming === project.id ? buttonStyle(false, true) : buttonStyle(false),
                                    onClick: () => remove(project),
                                    children: confirming === project.id ? t('action.deleteConfirm') : t('action.delete'),
                                  }),
                                  confirming === project.id
                                    ? jsx.jsx('button', {
                                        key: 'cancel',
                                        type: 'button',
                                        style: buttonStyle(false),
                                        onClick: () => setConfirming(''),
                                        children: t('action.cancel'),
                                      })
                                    : null,
                                ],
                              }),
                            ],
                          }),
                          // Meta chips live on their own line: mixed into the title
                          // row they competed with the action buttons for width.
                          jsx.jsx('div', {
                            key: 'meta',
                            style: styles.metaRow,
                            children: [
                              project.framework === '' ? null : jsx.jsx('span', { key: 'fw', style: styles.chip, children: project.framework }),
                              project.dependsOn.length === 0
                                ? null
                                : jsx.jsx('span', { key: 'dep', style: styles.chip, children: t('meta.dependsOn', { names: project.dependsOn.join(', ') }) }),
                              readinessText(project, t) === ''
                                ? null
                                : jsx.jsx('span', { key: 'ready', style: styles.chip, children: readinessText(project, t) }),
                            ],
                          }),
                          confirming === project.id
                            ? jsx.jsx('div', {
                                key: 'confirm',
                                style: { ...styles.warn, padding: '2px 10px 6px' },
                                children: t('confirm.delete', { name: project.name }),
                              })
                            : null,
                          project.detail === undefined || project.detail === ''
                            ? null
                            : jsx.jsx('div', { key: 'detail', style: { ...styles.source, padding: '4px 10px 0' }, children: project.detail }),
                          project.steps.length === 0 ? null : jsx.jsx('div', {
                            key: 'steps',
                            style: styles.steps,
                            children: project.steps.map((step) => jsx.jsx('span', {
                              key: step.name,
                              style: styles.step,
                              title: step.message,
                              children: [
                                jsx.jsx('span', {
                                  key: 'dot',
                                  style: {
                                    ...styles.dot,
                                    width: '6px',
                                    height: '6px',
                                    background: step.state === 'ok' ? '#16a34a' : step.state === 'failed' ? '#dc2626' : '#d97706',
                                  },
                                }),
                                jsx.jsx('span', {
                                  key: 'text',
                                  children: `${step.name} · ${step.state === 'ok' ? t('log.stepOk') : step.state === 'failed' ? t('log.stepFailed') : t('log.stepRunning')}${step.ms === null ? '' : ` ${formatDuration(step.ms)}`}`,
                                }),
                              ],
                            })),
                          }),
                          jsx.jsx(LogView, {
                            key: 'log',
                            t,
                            projectId: project.id,
                            entries: log.entries,
                            lossy: log.lossy,
                            onClear: log.clear,
                          }),
                        ],
                  }),
                ],
              }),
        ],
      });
    }

    /** The "+" menu door: one button that opens the page. */
    function DevRunnerGuide({ title, description, kind, useTabInfo, t }) {
      const { tab } = useTabInfo();
      return jsx.jsx('div', {
        'data-sidebar-right-guide-entry': kind,
        style: { padding: '2px' },
        children: jsx.jsx('button', {
          type: 'button',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            width: '100%',
            padding: '8px 10px',
            border: '1px solid var(--dsw-alias-border-l3)',
            borderRadius: 'var(--dsw-radius-sm, 4px)',
            background: 'var(--dsw-alias-bg-l1)',
            color: 'inherit',
            font: 'inherit',
            textAlign: 'left',
            cursor: 'pointer',
          },
          'aria-label': description === undefined ? title : `${title} ${description}`,
          onClick: () => {
            tab.actions.openTab(kind, { replaceTab: true });
          },
          children: [
            jsx.jsx('span', { style: { fontSize: '16px' }, 'aria-hidden': 'true', children: '\u25B6' }),
            jsx.jsx('span', {
              style: { display: 'flex', flexDirection: 'column', minWidth: 0 },
              children: [
                jsx.jsx('span', { style: { fontWeight: 600 }, children: title }),
                description === undefined
                  ? null
                  : jsx.jsx('span', {
                      style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
                      children: description,
                    }),
              ],
            }),
          ],
        }),
      });
    }

    /** The tab chip. */
    function DevRunnerTitle({ useTabInfo, t }) {
      const { tab } = useTabInfo();
      return jsx.jsx('span', {
        style: { display: 'inline-flex', alignItems: 'center', gap: '5px', minWidth: 0 },
        children: [
          jsx.jsx('span', { 'aria-hidden': 'true', children: '\u25B6' }),
          jsx.jsx('span', {
            style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            children: tab.title ?? t('title'),
          }),
        ],
      });
    }

    // ------------------------------------------------------ session header ---

    /**
     * The header control: how many projects are up, and one button that starts
     * or stops them all. It renders nothing until a table exists, because an
     * empty pill in the session header is noise, not information.
     */
    function HeaderControl(props) {
      const { t, openPanel } = props;
      const [projects, setProjects] = React.useState([]);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');

      React.useEffect(() => {
        let live = true;
        const pull = async () => {
          try {
            const body = await call('/status');
            if (!live) return;
            setProjects(Array.isArray(body.projects) ? body.projects : []);
            setError('');
          } catch (failure) {
            if (live) setError(readError(failure));
          }
        };
        pull();
        const timer = setInterval(() => {
          if (!document.hidden) pull();
        }, HEADER_POLL_MS);
        return () => {
          live = false;
          clearInterval(timer);
        };
      }, []);

      if (projects.length === 0) return null;

      const running = projects.filter(isLive).length;
      const failed = projects.filter((project) => project.state === 'failed').length;
      const start = running === 0;
      const act = async () => {
        setBusy(true);
        try {
          await call(start ? '/start-all' : '/stop-all', { method: 'POST' });
          const body = await call('/status');
          setProjects(Array.isArray(body.projects) ? body.projects : []);
          setError('');
        } catch (failure) {
          setError(readError(failure));
        } finally {
          setBusy(false);
        }
      };

      const tooltip = error === ''
        ? t('header.title', { summary: summaryText(projects, t) })
        : t('error.request', { message: error });

      // The pill is the door: the host exposes `sidebarRight.openTab(kind)`, so a
      // click lands on the panel instead of asking the user to find the sidebar's
      // Start card first. Without that service the pill stays informational and the
      // guide card remains the only way in.
      const canOpen = typeof openPanel === 'function';

      return jsx.jsx('span', {
        style: styles.pill,
        title: tooltip,
        children: [
          jsx.jsx('button', {
            key: 'open',
            type: 'button',
            style: { ...styles.pillOpen, cursor: canOpen ? 'pointer' : 'default' },
            title: canOpen ? t('header.open') : tooltip,
            onClick: () => {
              if (canOpen) openPanel();
            },
            children: [
              jsx.jsx('span', {
                key: 'dot',
                style: { ...styles.dot, background: failed > 0 ? '#dc2626' : running > 0 ? '#16a34a' : '#9ca3af' },
              }),
              jsx.jsx('span', { key: 'count', children: summaryText(projects, t) }),
            ],
          }),
          jsx.jsx('button', {
            key: 'action',
            type: 'button',
            style: { ...styles.pillButton, opacity: busy ? 0.5 : 1 },
            disabled: busy,
            onClick: act,
            children: start ? t('header.startAll') : t('header.stopAll'),
          }),
        ],
      });
    }

    // --------------------------------------------------------------- apply ---

    function apply(ctx) {
      try {
        ctx.effect(() => ctx.locale.register(LOCALE, { zh, en }), 'dsh-dev-runner: copy');
        const t = ctx.locale.bind(LOCALE);

        // Registering the page type is what lets the sidebar open a `dev-runner`
        // tab at all; without it the guide door would open an unavailable pane.
        try {
          ctx.effect(() => ctx.sidebarRightTabs.register({
            id: PLUGIN_ID,
            kind: KIND,
            multiple: false,
            priority: 'builtin',
            title: () => t('title'),
            guide: [{
              id: 'new',
              order: 21,
              title: () => t('new'),
              description: () => t('description'),
            }],
          }), 'dsh-dev-runner: tab type');
        } catch (error) {
          console.error('[dsh-dev-runner] tab type registration failed:', error);
        }

        // Opening the panel from the header pill. `sidebarRight` is the host's own
        // service, so this works with or without the better-sidebar plugin; it throws
        // when no session pane is adopted, which is exactly why the call is fenced.
        const openPanel = () => {
          try {
            const right = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined;
            if (right === undefined || typeof right.openTab !== 'function') return false;
            right.openTab(KIND);
            return true;
          } catch (error) {
            console.error('[dsh-dev-runner] could not open the panel:', error);
            return false;
          }
        };

        const register = (slotName, Component, extra, injected) => {
          try {
            ctx.effect(() => ctx.slots.inject(slotName, () => ctx.slots.register(
              {
                name: slotName,
                key: PLUGIN_ID,
                id: PLUGIN_ID,
                locale: LOCALE,
                inject: (sessionId) => ({ t, sessionId, ...(injected ?? {}) }),
                ...(extra ?? {}),
              },
              Component,
            )), `dsh-dev-runner: ${slotName}`);
          } catch (error) {
            console.error(`[dsh-dev-runner] ${slotName} seat failed to register (host side unaffected):`, error);
          }
        };

        register('sidebar.right.tab.guide.entry', DevRunnerGuide);
        register('sidebar.right.pane.tab', DevRunnerBody);
        register('sidebar.right.pane.tab.title', DevRunnerTitle);
        // `kind: list, scope: session`: the host mounts it beside the session
        // title, and hides it while the session header is blank.
        register(HEADER_SLOT, HeaderControl, { order: 30, label: () => t('title') }, { openPanel });
      } catch (error) {
        console.error('[dsh-dev-runner] client failed to load (host side unaffected):', error);
      }
    }

    // `testing` exposes the pure helpers and the components to the test suite.
    // The helpers are what fail silently in a browser (ANSI parsing, draft
    // conversion); the components are here so a render pass can be driven
    // without a browser at all.
    return {
      name,
      inject,
      apply,
      testing: {
        ansiSpans,
        stripAnsi,
        editPending,
        projectToDraft,
        draftToProject,
        draftProblems,
        discoveryPlan,
        optionKey,
        components: {
          body: DevRunnerBody,
          guide: DevRunnerGuide,
          title: DevRunnerTitle,
          header: HeaderControl,
          form: ProjectForm,
          discover: DiscoverPanel,
          logView: LogView,
          logLine: LogLine,
        },
      },
    };
  },
});
