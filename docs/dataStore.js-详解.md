# `dataStore.js` 函数详解

> **一句话职责**：PLC 的"内存"。所有 DB / M / I / Q 区就是几个 `Buffer`，这个文件负责**按区域取内存、按字节/按位写入、检测值是否变化并广播事件、序列化到文件**。
> 它是整个项目的**中心数据层**：协议层（`s7comm.js`）、逻辑规则（`logic.js`）、持久化（`persistence.js`）、模拟器（`simulator.js`）全都读写它。

## 在项目中的位置

```
s7comm.js（协议读写） ┐
logic.js（规则运算）  ├──► dataStore.js（唯一的内存入口）──► change 事件 ──► persistence.js（落盘）
simulator.js（模拟）  ┘                                        └──► logic.js（规则触发）
```

**为什么所有写入都要走这里**：因为只有 `writeAt` / `writeBitAt` 会发 `write` / `change` 事件。绕过它直接改 Buffer，持久化不落盘、心跳规则不触发。

---

## 常量

### `AREA` —— 区域代码表

| 键 | 值 | 含义 | 内部 Buffer |
| --- | --- | --- | --- |
| `PE` | `0x81` | 输入区 I | `this.inputs` |
| `PA` | `0x82` | 输出区 Q | `this.outputs` |
| `MK` | `0x83` | 位存储 M | `this.merkers` |
| `DB` | `0x84` | 数据块 | `this.dbs`（Map） |
| `CT` | `0x1c` | 计数器 | 未实现 |
| `TM` | `0x1d` | 定时器 | 未实现 |

> 这些值与 `s7comm.js` 的 `AREA_NAMES` 对应，是 S7 协议里规定的区域编号。

### `INIT_RE` —— 初始化表达式

```js
/^(REAL|DINT|DWORD|INT|WORD|BYTE|CHAR|STR|X)(\d+)(?:\.([0-7]))?$/i
```

用于解析配置里的 `"REAL0": 12.5`、`"X16.0": true`、`"STR20": "abc"` 这类键。

---

## `class DataStore extends EventEmitter`

继承 `EventEmitter` 就是为了发 `write` / `change` 事件。

### `constructor(config)`

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `autoCreateDb` | `false` | 访问未定义的 DB 时自动创建（避免 0x0A） |
| `autoCreateDbSize` | `1024` | 自动创建的 DB 大小 |
| `logger` | `null` | 用于输出警告 |
| `dbs[]` | — | 每个 DB 的 `{number, size, name, init}` |
| `merkersSize` | `256` | M 区大小（配置里是 1024） |
| `inputsSize` | `128` | I 区大小 |
| `outputsSize` | `128` | Q 区大小 |

做的事：分配三个 Buffer，然后逐个 `addDb()`。

---

### `addDb(number, size, init, name)`

**作用**：新建一个 DB 并可选地写入初始值。

| 参数 | 说明 |
| --- | --- |
| `number` | DB 号（1~65535），非法直接抛错 |
| `size` | 字节数（≥1） |
| `init` | 初始值对象，如 `{ "REAL0": 12.5 }` |
| `name` | 显示名，只用于日志 |
| **返回** | 该 DB 的 Buffer |

存储结构：`this.dbs.set(number, { buffer, size, name })`，即 **Map<DB号, {Buffer, 大小, 名字}>**。

---

### `applyInit(dbNumber, init)` —— 写初始值

**作用**：按 `"类型+偏移"` 的键把初始值写进 Buffer。

支持的类型与写法：

| 写法 | 含义 | 实现 |
| --- | --- | --- |
| `"X16.0": true` | 第 16 字节第 0 位 | `setBit(b, offset*8 + bit, value)` |
| `"BYTE20": 255` | 1 字节无符号 | `writeUInt8` |
| `"CHAR20": 65` | 1 字节有符号 | `writeInt8` |
| `"WORD8": 65535` | 2 字节无符号 | `writeUInt16BE` |
| `"INT8": -5` | 2 字节有符号 | `writeInt16BE` |
| `"DWORD12": 100` | 4 字节无符号 | `writeUInt32BE` |
| `"DINT12": -100` | 4 字节有符号 | `writeInt32BE` |
| `"REAL0": 12.5` | 4 字节浮点 | `writeFloatBE`（**大端**） |
| `"STR20": "abc"` | ASCII 字符串 | `write(..., 'latin1')` |

**越界保护**（重要）：

```js
const needSize = type === 'STR' ? String(value).length + 1 : type === 'X' ? 1 : FIXED_SIZE[type];
if (offset + needSize > b.length) {
  this.logger.warn(`DB${dbNumber} 的初始值 ${key} 需要 ${offset + needSize} 字节，但 DB 只有 ${b.length} 字节，已跳过`);
  continue;
}
```

> 没有这段保护时，如果把 DB 的 `size` 配小了而 `init` 里还写着 `INT356`，**服务会直接启动失败**（`RangeError: The value of "offset" is out of range`）。现在改为"跳过 + 警告"，服务照常起来，问题在日志里一目了然。

---

### `getArea(areaName, dbNumber = 0)`

**作用**：按区域名取对应的 Buffer，取不到返回 `null`。

```js
case 'DB': {
  const db = this.dbs.get(dbNumber);
  if (db) return db.buffer;
  if (!this.autoCreateDb) return null;          // 默认：让协议层回 0x0A
  const buffer = this.addDb(dbNumber, this.autoCreateDbSize, null, `DB${dbNumber} (自动创建)`);
  this.logger.info(`收到对未定义 DB${dbNumber} 的访问，已自动创建 ${this.autoCreateDbSize} 字节`);
  return buffer;
}
```

- 这是协议层判断"DB 是否存在"的唯一入口：返回 `null` → `s7comm.js` 回 `0x0A`
- `autoCreateDb` 打开后，任何 DB 号都能读写（适合对接那种地址表很杂的上位机）

---

### `writeAt(areaName, dbNumber, byteOffset, payload)` —— 字节写（核心）

**作用**：把 `payload` 写到指定区域的指定字节偏移，并检测**值是否真的变了**。

| 参数 | 说明 |
| --- | --- |
| `areaName` | `'DB'` / `'MK'` / `'PE'` / `'PA'` |
| `dbNumber` | DB 号（非 DB 区可传 0） |
| `byteOffset` | 字节偏移 |
| `payload` | 要写入的字节 |
| **返回** | `{ok: true, changed: boolean}` 或 `{ok: false, reason}` |

流程：

```js
if (!buffer) return { ok: false, reason: 'area-not-found' };
if (byteOffset < 0 || byteOffset + payload.length > buffer.length) return { ok: false, reason: 'out-of-range' };

// ① 逐个字节比较，判断有没有变化
let changed = false;
for (...) if (buffer[i] !== payload[i]) { changed = true; break; }

// ② 复制进去
payload.copy(buffer, byteOffset);

// ③ 广播事件
const event = { area, dbNumber, offset: byteOffset, length: payload.length, changed };
this.emit('write', event);              // 每次写入都发（规则引擎自己按 trigger 过滤）
if (changed) this.emit('change', event); // 只有真变化才发（持久化只关心这个）
```

**为什么要区分 `write` 和 `change` 两个事件**：

| 事件 | 订阅者 | 原因 |
| --- | --- | --- |
| `write` | `logic.js` | 心跳规则要"**每写一次就刷新一次**"，即使值没变 |
| `change` | `persistence.js` | 落盘只在数据真的变化时做，避免重复写同一个值也触发磁盘 IO |

---

### `writeBitAt(areaName, dbNumber, bitAddress, bitCount, payload)` —— 位写

**作用**：写 BOOL，**只改目标位，不影响同一字节的其他位**（读-改-写）。

| 参数 | 说明 |
| --- | --- |
| `bitAddress` | **位地址** = 字节×8 + 位号（来自 S7ANY 的 address，直接可用） |
| `bitCount` | 写几位（通常 1） |
| `payload` | 位数据（每字节 8 位，低位在前） |

```js
const startByte = bitAddress >> 3;
const needBytes = Math.ceil(((bitAddress % 8) + bitCount) / 8);

const snapshot = buffer.subarray(startByte, startByte + needBytes).toString('hex'); // 改前快照
for (let i = 0; i < bitCount; i++) {
  const value = (payload[i >> 3] >> (i & 7)) & 1;
  const abs = bitAddress + i;
  if (value) buffer[abs >> 3] |= 1 << (abs & 7);
  else       buffer[abs >> 3] &= ~(1 << (abs & 7));
}
const changed = snapshot !== after;  // 用 hex 快照比对，支持跨字节
```

> 为什么用 hex 快照而不是逐位比较：一次可能写多个位、可能跨字节，比对整段 hex 最简单也最快。

---

### `serialize()`

**作用**：把全部数据区导出成可 JSON 化的对象（给持久化用）。

```js
{
  version: 1,
  merkers: "00ff...",
  inputs: "...",
  outputs: "...",
  dbs: { "5": { size: 1024, name: "DB5_ProcessData", data: "41480000..." } }
}
```

用 **hex 字符串**而不是 base64/数组：文件可读、可直接在编辑器里改、体积也不大（1024 字节 → 2048 字符）。

---

### `restore(snapshot)`

**作用**：从 `serialize()` 的结果恢复内存，启动时由 `persistence.js` 调用。

```js
for (const [numberStr, record] of Object.entries(snapshot.dbs || {})) {
  let db = this.dbs.get(number);
  if (!db) {                                   // 配置里没有的 DB（例如自动创建的）→ 建出来
    const size = Math.max(record.size || 0, src.length, 1);
    this.addDb(number, size, null, record.name || `DB${number}`);
  }
  src.copy(db.buffer, 0, 0, Math.min(src.length, db.buffer.length));  // ★ 按较小长度拷贝
}
```

两个细节：

- **配置里没有的 DB 会被重建**，所以 `autoCreateDb` 建出来的 DB 重启后也在
- 用 `Math.min(src.length, target.length)` 拷贝：DB 尺寸改大改小都不会报错，只保留能放下的部分

---

### `describe()`

**作用**：返回所有 DB 的概况 `[{number, name, size}]`，按 DB 号排序。`index.js` 启动时用它打印"数据块 DB5_ProcessData: 1024 字节"。

---

### `dumpArea(areaName, dbNumber, length = 32)`

**作用**：把内存前 N 个字节打印成 `41 48 00 00 ...` 形式的 hex，调试用。

---

## 模块级函数 `setBit(buf, bitIndex, value)`

**作用**：在 Buffer 上置位/清位（`applyInit` 初始化 BOOL 时用）。

```js
const byte = bitIndex >> 3;
const bit = bitIndex & 7;
if (value) buf[byte] |= 1 << bit;
else       buf[byte] &= ~(1 << bit);
```

---

## 常见修改点

| 需求 | 改法 |
| --- | --- |
| 新增一个 DB | 改 `config/default.json` 的 `dbs` 数组，不用改代码 |
| 让未定义的 DB 也能读写 | 配置 `"autoCreateDb": true` |
| 增加定时器/计数器区 | 构造函数里加 `this.timers = Buffer.alloc(...)`，`getArea` 加 case，并在 `s7comm.js` 的 `AREA_NAMES` 里映射 |
| 想每次写入都落盘 | 把 `persistence.js` 的监听从 `change` 改成 `write` |
| 想记录每个地址的变化历史 | `this.on('change', e => ...)` 自己挂一个监听即可 |
| 想给某个 DB 加"只读"保护 | 在 `writeAt` 里判断 `dbNumber`，返回 `{ok:false, reason:'read-only'}` |
