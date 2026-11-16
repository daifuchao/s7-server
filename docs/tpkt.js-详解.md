# `tpkt.js` 函数详解

> **一句话职责**：TPKT 是 S7 协议的最外层信封（RFC 1006）。这个文件只做两件事——**把要发的数据套上 4 字节 TPKT 头**，以及**把 TCP 流拆成一个个完整帧**。
> 它是全项目最简单也最基础的一层，**不关心内容是什么**（COTP 还是 S7 都无所谓）。

## 在协议栈中的位置

```
TCP（流式，可能半包/粘包）
  ↓  ← 本文件负责
TPKT（4 字节头 + 长度）
  ↓
COTP（cotp.js）
  ↓
S7comm（s7comm.js）
```

## 帧结构

```
┌────────┬────────┬──────────────┬──────────────────┐
│  0x03  │  0x00  │  Length(2B)  │   COTP 数据…      │
│ 版本号  │ 保留    │ 含头部的总长   │                  │
└────────┴────────┴──────────────┴──────────────────┘
              大端（高字节在前）
```

例：`03 00 00 16 ...` → 总长 0x16 = 22 字节（4 字节头 + 18 字节 COTP 数据）。

---

## 常量

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `TPKT_HEADER_LEN` | `4` | 头部固定 4 字节，所有长度计算都基于它 |

---

## `encodeTpkt(payload)`

**作用**：给一段 COTP 数据加上 TPKT 头，变成可以直接 `socket.write()` 的字节流。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `payload` | Buffer | COTP 数据（CR/CC/DT 等） |
| **返回** | Buffer | 完整的 TPKT 帧 |

实现要点：

```js
const buf = Buffer.alloc(4 + payload.length);
buf[0] = 0x03;                                // 版本号，固定 3
buf[1] = 0x00;                                // 保留字节
buf.writeUInt16BE(4 + payload.length, 2);     // ★ 长度包含 4 字节头
payload.copy(buf, 4);
```

- **长度字段包含头部自身**（`4 + payload.length`），这是最容易写错的地方——少加 4 客户端会一直等数据
- 必须在原本 Buffer 外新分配，不能原地加头

---

## `class TpktParser`

**作用**：解决 TCP 的"半包/粘包"问题。TCP 不保证一次 `data` 事件就是一个完整报文：可能只来半个帧，也可能一次来三个帧。

### `constructor()`

初始化 `this.buffer = Buffer.alloc(0)`，作为**跨多次 data 事件的累积缓冲区**。每个连接一个实例（`s7server.js` 里 `new TpktParser()`）。

### `push(chunk)`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `chunk` | Buffer | 本次 `socket.on('data')` 收到的原始字节 |
| **返回** | `Buffer[]` | 本次能拼出的**所有完整帧**（已剥掉 4 字节头，只留 COTP 内容） |

内部循环三件事：

```js
while (this.buffer.length >= 4) {
  // ① 同步：首字节不是 0x03 说明流错位，丢 1 字节继续找
  if (this.buffer[0] !== 0x03) { this.buffer = this.buffer.subarray(1); continue; }

  // ② 读长度：不够一帧就 break，等下次 push
  const total = this.buffer.readUInt16BE(2);
  if (total <= 4) { this.buffer = this.buffer.subarray(4); continue; }  // 非法长度，跳过
  if (this.buffer.length < total) break;

  // ③ 切出一帧，剩余留在 buffer 里
  frames.push(this.buffer.subarray(4, total));
  this.buffer = this.buffer.subarray(total);
}
```

三个设计点值得注意：

1. **重同步机制**（①）：如果字节流错位（例如收到了非 TPKT 数据），逐字节丢弃直到重新对齐，而不是直接断开连接——提高容错性
2. **不完整帧就 `break`**：绝不从中途截断，保证每次返回的帧都是完整的
3. **`subarray` 零拷贝**：`subarray` 是视图不是复制，性能好；但要注意后续如果改这块内存会影响原 buffer（本项目只读不写，安全）

> 返回的每个 Buffer 已经**去掉了 TPKT 头**，所以 `s7server.js` 里拿到后直接看 `frame[1]` 就是 COTP 报文类型。

---

## 常见修改点

| 需求 | 改法 |
| --- | --- |
| 想限制单帧最大长度（防攻击） | `push()` 里加 `if (total > 8192) { 丢弃并重同步 }` |
| 想记录原始字节流 | 在 `push` 开头 `console.log(chunk.toString('hex'))` |
| 想支持 TPKT over TLS | 不需要改这里，在 socket 层换 `tls.createServer` 即可 |
