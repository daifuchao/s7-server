# `index.js` 函数详解

> **一句话职责**：命令行入口。解析参数 → 读配置 → 打印横幅 → 创建并启动 `S7Server` → 按需启动模拟器 → 处理退出信号。
> 它本身**不含任何协议逻辑**，只做"组装和启动"。

## 启动流程

```
node src/index.js --port 1102 --live --verbose
        │
        ├─ parseArgs()      把 argv 变成 { port:'1102', live:true, verbose:true }
        ├─ loadConfig()     读 default.json + 环境变量 + 命令行（优先级递增）
        ├─ new Logger()     创建日志器
        ├─ new S7Server()   组装 DataStore / LogicEngine / Persistence
        ├─ await start()    恢复数据 → 启动规则 → 监听端口
        ├─ new Simulator()  仅当 --live 或 config.simulation.enabled
        └─ SIGINT/SIGTERM   优雅停止（落盘 + 关连接）
```

---

## 模块级常量 `BANNER`

启动时打印的 ASCII 方框，纯装饰。用模板字符串写，注意里面的 `╔═╗` 是等宽字符，编辑器里看着对齐就行。

---

## `parseArgs(argv)`

**作用**：手写一个极简的参数解析器（不引第三方库）。

| 输入 | 输出 |
| --- | --- |
| `['--port','1102']` | `{ port: '1102' }` |
| `['--live']` | `{ live: true }` |
| `['--no-persist']` | `{ 'no-persist': true }` |
| `['--port','1102','--verbose']` | `{ port: '1102', verbose: true }` |

```js
for (let i = 0; i < argv.length; i++) {
  const token = argv[i];
  if (!token.startsWith('--')) continue;
  const key = token.slice(2);
  const next = argv[i + 1];
  if (next && !next.startsWith('--')) { args[key] = next; i += 1; }  // --key value
  else { args[key] = true; }                                        // --flag
}
```

三个特点：

1. **`--key value` 和 `--flag` 都支持**：靠"下一个参数是不是以 `--` 开头"判断
2. **值都是字符串**（`'1102'`），类型转换交给 `loadConfig` 做（`Number()` / `String()`）
3. 不支持 `--port=1102` 这种写法（要扩展可以加一行 `split('=')`）

---

## `loadConfig(args)`

**作用**：把"配置文件 + 环境变量 + 命令行"合并成最终配置，**优先级：命令行 > 环境变量 > 配置文件**。

```js
// ① 读文件（默认 config/default.json；--config 可指定）
const configPath = args.config ? path.resolve(process.cwd(), args.config) : path.join(__dirname, '..', 'config', 'default.json');
config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
```

- 用 `path.join(__dirname, '..')` 而不是 `process.cwd()`：**保证从任何目录启动都能找到默认配置**
- `--config` 指定的路径则按 `process.cwd()` 解析（符合用户直觉）
- 文件不存在且没指定 `--config` 时用空对象 `{}`（走代码里的默认值）

```js
// ② 环境变量
if (process.env.S7_PORT) config.port = Number(process.env.S7_PORT);
if (process.env.S7_HOST) config.host = process.env.S7_HOST;
if (process.env.S7_PDU_SIZE) config.pduSize = Number(process.env.S7_PDU_SIZE);

// ③ 命令行（最高优先级）
if (args.port !== undefined) config.port = Number(args.port);
if (args.host !== undefined) config.host = String(args.host);
if (args.pdu !== undefined) config.pduSize = Number(args.pdu);
if (args.verbose) config.verbose = true;
if (args.dump) process.env.S7_DUMP = '1';
if (args.reset) config.reset = true;
if (args['no-persist']) config.persistence = { enabled: false };
```

| 参数 | 对应配置 | 说明 |
| --- | --- | --- |
| `--port` | `config.port` | 监听端口 |
| `--host` | `config.host` | 监听地址 |
| `--pdu` | `config.pduSize` | 最大 PDU（默认 960） |
| `--config` | — | 指定配置文件 |
| `--live` | 在 `main()` 里判断 | 开启数据模拟 |
| `--dump` | `process.env.S7_DUMP` | 打印原始报文（`s7comm.js` 里检查这个环境变量） |
| `--reset` | `config.reset` | 启动时清除持久化数据 |
| `--no-persist` | `config.persistence` | 关闭持久化 |
| `--verbose` | `config.verbose` | 调试日志 |
| `--help` | — | 打印帮助 |

> `--dump` 用**环境变量**而不是配置项传递，是为了让 `s7comm.js` 不必层层接收参数——代价是全局状态，但对调试开关可以接受。

---

## `main()` —— 主流程

### ① 帮助信息

```js
if (args.help || args.h) { console.log(`用法: ...`); return; }
```

在 `BANNER` 之前返回，所以 `--help` 只打印用法，不打印横幅。注意帮助文本里的 `--port` 说明提到了"非 root 用户请用 1102 这类高位端口"。

### ② 创建日志器和服务端

```js
const logger = new Logger({ verbose: Boolean(config.verbose) });
console.log(BANNER);
const server = new S7Server({ ...config, logger });   // ★ logger 注入进去，后续所有模块共用
```

`{ ...config, logger }` 的写法：把 logger 塞进 config 对象，`S7Server` 构造函数里再分发给 `DataStore` / `LogicEngine` / `Persistence`。

### ③ 监听连接事件

```js
server.on('client:connect', (session) => {
  logger.info(`当前在线客户端: ${server.clientCount}`);
  session.socket.on('close', () => logger.info(`当前在线客户端: ${server.clientCount}`));
});
```

> 注意 `close` 监听是加在 `session.socket` 上的，不是 server 上——因为每个连接各有自己的 socket。

### ④ 启动并集中处理错误

```js
try { await server.start(); }
catch (err) {
  if (err.code === 'EACCES') { /* 端口 102 需要 root，提示 sudo 或 setcap 或换端口 */ process.exit(1); }
  if (err.code === 'EADDRINUSE') { /* 端口被占用 */ process.exit(1); }
  /* 其他错误 */ process.exit(1);
}
```

**这是这段代码最有价值的部分**：把 Node 底层的错误码翻译成人能看懂的提示。

| 错误码 | 原因 | 提示内容 |
| --- | --- | --- |
| `EACCES` | 非 root 绑定 102 | 用 sudo / 换端口 / `setcap cap_net_bind_service=+ep $(which node)` |
| `EADDRINUSE` | 端口被占用 | 换端口或先停掉已有进程 |

### ⑤ 按需启动模拟器

```js
const simEnabled = Boolean(config.simulation && config.simulation.enabled);
if (simEnabled || args.live) {
  simulator = new Simulator(server.store, { intervalMs: config.simulation?.intervalMs || 1000, logger });
  simulator.start();
}
```

**两个开关任一为真就启动**：配置文件里的 `simulation.enabled` 或命令行 `--live`。用 `simulator` 变量在外部保存引用，方便退出时 `stop()`。

### ⑥ 优雅退出

```js
const shutdown = async (signal) => {
  logger.info(`收到 ${signal}，正在关闭…`);
  if (simulator) simulator.stop();   // 1. 停定时器
  await server.stop();               // 2. 停规则 → 落盘 → 关连接 → 关监听
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));   // Ctrl+C
process.on('SIGTERM', () => shutdown('SIGTERM')); // kill / docker stop
```

顺序：先停模拟器（否则 `server.stop()` 期间它还在改数据），再停服务端（内部会落盘）。

> 没有处理 `SIGHUP`，也没有处理 `uncaughtException`。如果你要跑在容器里，可以补上 `uncaughtException` 的日志 + 落盘。

### ⑦ 顶层兜底

```js
main().catch((err) => { console.error(err); process.exit(1); });
```

`loadConfig` 里 `throw new Error('配置文件不存在')` 就是靠这里兜住的——会打印堆栈并退出。

---

## 常见修改点

| 需求 | 改法 |
| --- | --- |
| 增加一个命令行参数 | `parseArgs` 不用改；`loadConfig` 里加一行 `if (args.xxx) config.xxx = ...` |
| 改默认端口/PDU | 改 `config/default.json`，或改 `S7Server` 构造函数的默认值 |
| 想用 `--port=1102` 写法 | `parseArgs` 里对 `token.includes('=')` 做一次 split |
| 想在启动时打印配置摘要 | 在 `BANNER` 后加一段 `console.log(config)` |
| 想后台运行（daemon） | 用 `pm2 start src/index.js -- --port 102` 或 systemd |
| 想支持多实例 | 每个实例 `--port` 不同 + `--config` 指向不同文件（持久化文件也要不同） |
| 想在退出时打印统计 | `shutdown()` 里读 `server.store.describe()` 和 handler 的 `stats` |
