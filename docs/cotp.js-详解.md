# `cotp.js` 函数详解

> **一句话职责**：COTP（ISO 8073 Class 0）负责"建立连接 / 传输数据 / 断开连接"这三件事的外壳。对 S7 来说，COTP 就是 TCP 之上的一层"会话握手"，握手完成后所有 S7 报文都装在 COTP 的 **DT** 帧里发。
> 本文件只处理 COTP 头，**不解析 S7 内容**。

## 在协议栈中的位置

```
TCP
  ↓
TPKT（tpkt.js，4 字节信封）
  ↓  ← 本文件负责
COTP（连接 + 数据帧头）
  ↓
S7comm（s7comm.js）
```

## 报文类型

| 名称 | 代码 | 方向 | 含义 |
| --- | --- | --- | --- |
| **CR** | `0xE0` | 客户端 → 服务端 | Connection Request，连接请求 |
| **CC** | `0xD0` | 服务端 → 客户端 | Connection Confirm，连接确认 |
| **DT** | `0xF0` | 双向 | Data Transfer，数据传输（S7 报文都走它） |
| **DR** | `0x80` | 双向 | Disconnect Request，断开请求 |
| **DC** | `0xC0` | 双向 | Disconnect Confirm，断开确认 |

## 报文结构

```
┌────┬──────┬────────────┬────────────┬───────┬──────────────┐
│ LI │ Code │ 目标引用(2) │ 源引用(2)   │ Class │  参数区…      │
│ 1B │ 1B   │   参考值    │   参考值    │  1B   │              │
└────┴──────┴────────────┴────────────┴───────┴──────────────┘
  ↑ LI = 本字节之后的总长度（不含 LI 自己）

参数区常见三个：
  C0 01 0A        → TPDU 大小 = 1 << 0x0A = 1024 字节
  C1 02 xx xx     → 源 TSAP（客户端/服务端自己的"门牌号"）
  C2 02 xx xx     → 目标 TSAP（要连的对端"门牌号"）
```

**TSAP 是什么**：可以理解为"PLC 上的哪个服务入口"。S7-1200 常见：

- 客户端源 TSAP = `0x0100`（PG 连接随便取）
- 服务端目标 TSAP = `0x0301`（连接类型 0x03 = PG/OP，机架 0，插槽 1）
- 本项目**不校验 TSAP**，任何值都接受并把对端的回显回去，所以机架/插槽填错也连得上（真实 PLC 会拒绝）

---

## 常量 `COTP`

```js
const COTP = { CR: 0xE0, CC: 0xD0, DR: 0x80, DC: 0xC0, DT: 0xF0 };
```

`s7server.js` 用它做 `switch (frame[1])` 分发。

---

## `parseConnectionPacket(buf)`

**作用**：解析收到的 CR（或 DR）报文，取出引用号和 TSAP。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `buf` | Buffer | 已剥掉 TPKT 头的 COTP 报文 |
| **返回** | `{li, code, dstRef, srcRef, cls, tpduSize?, srcTsap?, dstTsap?}` 或 `null` |

实现要点：

```js
const li = buf[0];                 // 后续长度
const dstRef = buf.readUInt16BE(2);
const srcRef = buf.readUInt16BE(4);

// 参数区是 TLV 形式，循环读取
let offset = 7;
const end = Math.min(1 + li, buf.length);   // ★ 用 LI 界定边界，防止越界
while (offset + 2 <= end) {
  const code8 = buf[offset];      // C0/C1/C2
  const len   = buf[offset + 1];
  if (code8 === 0xC0 && len === 1) params.tpduSize = 1 << buf[offset + 2]; // 指数表示：0x0A → 1024
  if (code8 === 0xC1 && len === 2) params.srcTsap = ...;
  if (code8 === 0xC2 && len === 2) params.dstTsap = ...;
  offset += 2 + len;              // 跳过本参数
}
```

注意：

- **TPDU 大小是 2 的幂**：报文里存的是指数 `0x0A`，实际值 `1 << 10 = 1024`
- 参数区可能缺项（有的客户端不发 TSAP），所以用可选字段（`?`）
- `buf.length < 7` 直接返回 `null`，避免读到垃圾数据

---

## `buildConnectionConfirm({clientRef, serverRef, srcTsap, dstTsap, tpduSizeCode})`

**作用**：构造 CC（连接确认），这是握手成功的关键一步。

| 参数 | 说明 |
| --- | --- |
| `clientRef` | 客户端在 CR 里的**源引用**，要原样放进 CC 的"目标引用" |
| `serverRef` | 服务端自己生成的引用（每个连接随机一个） |
| `srcTsap` / `dstTsap` | 服务端 TSAP / 客户端 TSAP |
| `tpduSizeCode` | TPDU 大小指数，默认 `0x0A`（1024） |

关键实现：

```js
buf[0] = 6 + params.length;     // ★ LI = 总长度 - 1
buf[1] = COTP.CC;
buf.writeUInt16BE(clientRef, 2); // 目标引用 = 客户端的源引用（引用配对）
buf.writeUInt16BE(serverRef, 4); // 源引用 = 我们自己的
buf[6] = 0x00;                  // Class 0
```

两个易错点：

1. **LI 是"总长度 - 1"**，不是总长度。写成总长度会让客户端多读一个字节导致后续报文错位
2. **引用要交叉配对**：CC 的目标引用 = CR 的源引用，否则客户端会认为"你确认的不是我"

`s7server.js` 里的调用：

```js
const cc = buildConnectionConfirm({
  clientRef: info.srcRef,
  serverRef: this.serverRef,
  srcTsap: info.dstTsap || 0x0100,   // 把对端要的目标当我们的源（回显）
  dstTsap: info.srcTsap || 0x0100,
});
```

---

## `buildDataHeader(eot = true)`

**作用**：构造 DT 帧的 3 字节头，S7 报文接在它后面。

```js
return Buffer.from([0x02, COTP.DT, eot ? 0x80 : 0x00]);
//                    LI=2   0xF0      TPDU-NR/EOT，0x80 表示最后一个分片
```

| 参数 | 说明 |
| --- | --- |
| `eot` | `true`（默认）= 最后一个分片；本项目不分片，永远传 `true`（即 `0x80`） |

> 注意：TPKT 头 + COTP DT 头一共 **7 字节**，这就是很多 S7 解析代码里"偏移 7 开始才是 S7 报文"的原因。

---

## `buildDisconnectConfirm({clientRef, serverRef})`

**作用**：客户端发 DR 时回 DC，礼貌地确认断开，然后 `socket.end()`。

结构与 CC 相同，只是 Code 换成 `0xC0`、没有参数区（LI = 6）。

> 即使不回 DC，直接关 socket 也能工作，但规范做法是回一下，某些客户端（如 Snap7）会等这个确认才干净退出。

---

## 常见修改点

| 需求 | 改法 |
| --- | --- |
| 只允许特定机架/插槽连接 | 在 `parseConnectionPacket` 后校验 `dstTsap`，不符则回 DR |
| 想限制同时连接数 | 在 `s7server.js` 的 CR 分支里判断 `server.sessions.size` |
| 支持 COTP 分片（>1024 字节报文） | 需实现 DT 多帧发送（`eot=false` + TPDU-NR 递增），本项目未支持 |
| 记录连接日志细节 | `parseConnectionPacket` 返回对象里已有全部字段，直接打日志 |
