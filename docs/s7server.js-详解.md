# `s7server.js` 函数详解

> **一句话职责**：TCP 服务器本体。负责 `net.createServer` 监听端口、为每个客户端建立会话（`ClientSession`）、在 TPKT / COTP / S7comm 三层之间转发数据，以及管理服务端的生命周期（启动、数据恢复、逻辑规则、持久化、停止）。

## 在项目中的位置

```
net socket ──► ClientSession ──► TpktParser ──► COTP 分发 ──► S7CommHandler ──► DataStore
                     ▲                                                              │
                     └──────────────── 响应原路返回 ◄───────────────────────────────┘
```

`S7Server` 是"容器"，`ClientSession` 是"每个连接的工人"。

---

# 一、`ClientSession` —— 单个客户端连接

## `constructor(socket, server)`

为每个新连接创建一个实例，**一个连接一个实例**（会话状态不共享）。

| 属性 | 说明 |
| --- | --- |
| `id` | 递增的连接序号（`sessionSeq`），日志里 `[#3 ...]` 的 3 |
| `parser` | `TpktParser` 实例，**每个连接一条流，必须独立缓冲** |
| `state` | 连接阶段：`'WAIT_CR'` → `'S7'` |
| `connected` | 是否已完成 COTP 握手（用于日志） |
| `remote` / `tag` | `127.0.0.1:55054` / `[#1 127.0.0.1:55054]`，日志前缀 |
| `clientRef` | 客户端在 CR 里的源引用 |
| `serverRef` | 服务端自己的引用，**随机生成**（`1~65534`） |
| `handler` | `S7CommHandler` 实例，保存本会话协商出的 `pduSize` |

socket 设置：

```js
socket.setNoDelay(true);        // ★ 关闭 Nagle 算法，小报文立即发出（S7 是请求-响应模式，延迟敏感）
socket.setKeepAlive(true, 10000); // 10 秒探测，及时发现断线的客户端
```

三个事件：`data` → `onData`、`close` → `onClose`、`error` → 打日志（不崩溃）。

---

## `onData(chunk)`

TCP 数据到达的**唯一入口**。

```js
try {
  frames = this.parser.push(chunk);      // 拆包，可能得到 0~N 个完整帧
} catch (err) {
  this.socket.destroy();                 // 拆包失败说明流已乱，直接断开
  return;
}
for (const frame of frames) {
  try { this.onFrame(frame); }
  catch (err) { /* 记录日志，不影响后续帧 */ }
}
```

- **两级 try/catch**：拆包失败 → 断开连接；单帧处理失败 → 只记录，继续处理后面的帧
- 这也是"一个 TCP 包里有多个请求"能被正确处理的原因

---

## `onFrame(frame)`

按 COTP 报文类型分发。`frame` 已经去掉了 TPKT 头，所以 `frame[1]` 就是 COTP 代码。

| `frame[1]` | 处理 |
| --- | --- |
| `0xE0` CR | 解析 → 生成 CC 回发 → 标记 `connected` → 触发 `client:connect` 事件 |
| `0xF0` DT | `frame.subarray(3)` 取到 S7 PDU → `handler.handle()` → 结果套 DT 头回发 |
| `0x80` DR | 回 DC，然后 `socket.end()` |
| 其他 | debug 日志忽略 |

CR 分支的关键代码：

```js
const info = parseConnectionPacket(frame);
this.clientRef = info.srcRef;
const cc = buildConnectionConfirm({
  clientRef: info.srcRef,          // 目标引用 = 客户端源引用
  serverRef: this.serverRef,
  srcTsap: info.dstTsap || 0x0100, // 回显对端要的 TSAP
  dstTsap: info.srcTsap || 0x0100,
});
this.write(cc);
this.state = 'S7';
this.server.emit('client:connect', this);   // 让 S7Server 打"在线客户端数"
```

DT 分支：

```js
const s7pdu = frame.subarray(3);            // 跳过 COTP 的 3 字节 DT 头
const response = this.handler.handle(s7pdu); // null 表示不需要响应
if (response) {
  this.write(Buffer.concat([buildDataHeader(true), response])); // 套回 DT 头
}
```

> `handle()` 返回 `null` 的场景：非 Job 报文、协议 ID 不对。此时不能回空包，否则客户端会解析错误。

---

## `write(cotpPayload)`

统一的发送出口：**加 TPKT 头 → 写 socket**。

```js
if (this.socket.destroyed) return;   // 防止对已关闭的连接写入（会抛 EPIPE）
this.socket.write(encodeTpkt(cotpPayload));
```

所有响应都经过这里，所以将来要加"流量统计/抓包"只需改这一处。

---

## `onClose()` / `close()`

| 方法 | 说明 |
| --- | --- |
| `onClose()` | socket 关闭回调：打日志 + 从服务端会话集合里移除 |
| `close()` | 主动关闭：`socket.end()`（优雅关闭，等对端 FIN） |

> 用 `end()` 而不是 `destroy()`：服务端主动停止时先发 FIN，客户端能干净退出。

---

# 二、`S7Server` —— 服务端容器

## `constructor(config)`

负责**把所有部件组装起来**，是理解整个项目的最佳入口：

```js
this.config = { host: '0.0.0.0', port: 102, pduSize: 960, ...config };
this.logger = config.logger instanceof Logger ? config.logger : new Logger(config);
this.store  = new DataStore({ ...this.config, logger: this.logger });   // 内存
this.logic  = new LogicEngine(this.store, { rules: config.logic, ... }); // 规则引擎
this.persistence = new Persistence(this.store, {...});                   // 持久化（可关闭）
this.sessions = new Set();   // 当前所有连接
```

`persistence` 的开关逻辑：

```js
const persistenceConfig = config.persistence === undefined ? { enabled: true } : config.persistence;
this.persistence = persistenceConfig && persistenceConfig.enabled !== false ? new Persistence(...) : null;
```

即：**不写配置默认开**，写 `{"enabled": false}` 或 `--no-persist` 才关。

---

## `start()` —— 启动流程（顺序很重要）

```js
this.server = net.createServer((socket) => {
  this.sessions.add(new ClientSession(socket, this));   // 每个连接一个会话
});

// ① 先恢复数据（否则规则和数据都以初始值为准）
if (this.persistence) {
  if (this.config.reset) this.persistence.clear();
  else this.persistence.load();
  this.persistence.watch();
}

// ② 再启动逻辑规则（它的 last 初值要基于恢复后的数据）
this.logic.start();

// ③ 最后监听端口
this.server.listen(this.config.port, this.config.host, () => { ...打印 DB 概况... });
```

返回 Promise，`index.js` 用 `await server.start()` 并集中处理 `EACCES` / `EADDRINUSE`。

> ① → ② → ③ 的顺序不能乱：如果先 `logic.start()` 再 `load()`，重启后规则的 `last` 是初始值 0，而实际数据是 500，第一次写入会被误判为"变化"，心跳就会多加 1。

---

## `removeSession(session)` / `get clientCount()`

```js
removeSession(session) { this.sessions.delete(session); }
get clientCount() { return this.sessions.size; }
```

配合 `index.js` 里的 `server.on('client:connect', ...)` 打印"当前在线客户端: N"。

---

## `stop()` —— 优雅停止

```js
this.logic.stop();                 // 1. 先摘掉规则事件
if (this.persistence) {
  this.persistence.unwatch();      // 2. 摘掉持久化事件
  this.persistence.save();         // 3. ★ 强制落盘（不能靠防抖定时器）
}
for (const session of this.sessions) session.close();  // 4. 关闭连接
this.sessions.clear();
await new Promise((resolve) => this.server.close(resolve));  // 5. 关闭监听
```

顺序是有讲究的：

- 先摘监听再落盘 → 避免保存过程中又触发新的保存
- 强制 `save()` → 防抖定时器可能还没到点，不保存就会丢最后几秒的数据
- `server.close(cb)` 只在**没有活跃连接**时才回调，所以要先关连接

---

## `client:connect` 事件

```js
this.server.emit('client:connect', this);  // 在 ClientSession.onFrame 的 CR 分支
```

`index.js` 里：

```js
server.on('client:connect', (session) => {
  logger.info(`当前在线客户端: ${server.clientCount}`);
  session.socket.on('close', () => logger.info(`当前在线客户端: ${server.clientCount}`));
});
```

> 这是"组装关系"的示例：会话层只负责 emit，具体要做什么由使用方决定。

---

## 常见修改点

| 需求 | 改法 |
| --- | --- |
| 限制最大连接数 | `net.createServer` 回调里判断 `this.sessions.size`，超限 `socket.destroy()` |
| 只允许特定 IP 连接 | 回调里检查 `socket.remoteAddress` |
| 记录每个连接的读写字节数 | `ClientSession.write()` 里累加，`onData()` 里累加 |
| 连接空闲超时断开 | 每个 session 加一个定时器，`onData` 时重置 |
| 支持多个端口 | 再 `new S7Server({...config, port: 1103})` 起一个实例即可（store 可选择共享） |
| 想做"只读模式" | 在 `ClientSession` 创建 handler 时传入选项，让 `s7comm.js` 拒绝写请求 |

---

## 一句话总结各文件分工

| 文件 | 职责 |
| --- | --- |
| `index.js` | 解析参数、拼装、启动、处理信号 |
| `s7server.js` | TCP 监听 + 连接会话 + 生命周期 |
| `tpkt.js` | 4 字节信封 + 流式拆包 |
| `cotp.js` | 连接握手（CR/CC）+ DT 帧头 |
| `s7comm.js` | S7 读写指令的解析与响应 |
| `dataStore.js` | 内存数据区 + 变化事件 |
| `logic.js` | 规则引擎（写→算→写） |
| `persistence.js` | 断电保持 |
| `simulator.js` | 可选的动态数据 |
| `logger.js` | 日志输出 |
