# `s7comm.js` 逐函数详解

> 这个文件是模拟器的"大脑"：它把 TCP 里收到的 **S7 协议报文（PDU）** 翻译成对内存数据区的读/写操作，再把结果按协议格式打包回给客户端。
> 它不碰 socket、不碰 TCP 分包，**只管 S7 协议这一层**（上层是 `s7server.js` 的 COTP/TPKT，下层是 `dataStore.js` 的内存区）。

---

## 一、调用关系总览

```
ClientSession.onFrame()            ← s7server.js：收到 COTP DT 帧，取出 S7 PDU
   └─ S7CommHandler.handle(pdu)    ← 【入口】兜住所有异常，保证有响应
        └─ dispatch(pdu, pduRef)   ← 按 rosctr / 功能码分发
             ├─ handleSetupCommunication()   功能码 0xF0  通信协商
             ├─ handleReadVar()              功能码 0x04  读变量
             │    ├─ parseVarSpec()                        解析 12 字节变量说明
             │    └─ readItem()                            逐项从内存取值
             ├─ handleWriteVar()             功能码 0x05  写变量
             │    └─ writeItem()                           逐项写入内存
             └─ handleUserData()             功能码 0x07  SZL（CPU/模块标识）
                  └─ buildSzlResponse() → buildSzlRecords()
        └─ buildAckData()          ← 【统一出口】所有响应用它组装
```

---

## 二、文件顶部的常量（先看懂它们，后面函数才好读）

| 常量 | 内容 | 作用 |
| --- | --- | --- |
| `PROTOCOL_ID` | `0x32` | S7 协议固定标识，每个 PDU 第 0 字节；不是 0x32 说明不是 S7 报文 |
| `ROSCTR` | `JOB=0x01` / `ACK=0x02` / `ACK_DATA=0x03` / `USERDATA=0x07` | 报文类型：客户端请求是 JOB，服务端响应是 ACK_DATA |
| `AREA_NAMES` | `0x81 PE(I)`、`0x82 PA(Q)`、`0x83 MK(M)`、`0x84 DB`、`0x1c CT`、`0x1d TM` | 把报文里的"区域代码"映射成内部可读名字，用于取内存 Buffer |
| `AREA_LETTER` | `PE→I`、`PA→Q`、`MK→M`、`DB→DB` | 只用于日志好看：`M10.3`、`DB5.DBD0` |
| `TRANSPORT` | 传输尺寸表：`0x01 BIT(1位)`、`0x02 BYTE(8位)`、`0x04 WORD(16位)`、`0x05 INT(16位)`、`0x06 DWORD(32位)`、`0x07 DINT`、`0x08 REAL(32位)`… | **核心表**：告诉程序"客户端要读几个元素、每个元素多少位"，从而算出字节数 |
| `RC` | `OK=0xFF`、`INVALID_ADDRESS=0x05`、`OBJECT_NOT_EXIST=0x0A`、`TYPE_INCONSISTENT=0x07`… | 数据项返回码，业内标准值，别自己改 |
| `DATA_TRANSPORT` | `BIT=0x03`、`BYTE=0x04` | 响应里用的传输尺寸（和请求里的取值不完全一样） |

---

## 三、报文结构（理解函数的前提）

```
Job（客户端请求，头 10 字节）
┌──────┬───────┬─────────┬──────────┬──────────┬──────────┬───────┬──────┐
│ 0x32 │ROSCTR │ 冗余标识 │ PDU 引用  │ 参数长度  │ 数据长度  │ 参数   │ 数据  │
│  1B  │  1B   │   2B    │   2B     │   2B     │   2B     │  nB   │  mB  │
└──────┴───────┴─────────┴──────────┴──────────┴──────────┴───────┴──────┘
        =0x01                                                  ↑
                                                  参数长度、数据长度从这算

Ack-Data（服务端响应，头 12 字节，多了 2 字节错误信息）
┌──────┬───────┬─────────┬──────────┬──────────┬──────────┬────────┬────────┬───────┬──────┐
│ 0x32 │ 0x03  │ 冗余标识 │ PDU 引用  │ 参数长度  │ 数据长度  │ 错误类  │ 错误码  │ 参数   │ 数据  │
└──────┴───────┴─────────┴──────────┴──────────┴──────────┴────────┴────────┴───────┴──────┘
                                                              0x00      0x00    ← 成功
```

读请求的"参数"部分：

```
┌──────┬───────┬─────────────────────────────────────────┐
│ 0x04 │ 项数  │ 项1（12 字节 S7ANY）│ 项2 │ 项3 …          │
└──────┴───────┴─────────────────────────────────────────┘

S7ANY（12 字节，就是"一个地址"的完整描述）
┌──────┬──────┬──────┬────────┬────────┬────────┬──────┬──────────┐
│ 0x12 │ 0x0A │ 0x10 │传输尺寸 │元素个数 │ DB 号  │ 区域 │  地址(3) │
│      │      │S7ANY │ 1B     │  2B    │  2B    │ 1B   │  位地址  │
└──────┴──────┴──────┴────────┴────────┴────────┴──────┴──────────┘
```

---

## 四、逐个函数

### 1. `constructor(store, options)`

创建"协议处理器"，**每个客户端连接一个实例**（因为 PDU 长度是会话级状态）。

| 属性 | 含义 |
| --- | --- |
| `this.store` | 数据区对象（`dataStore.js`），真正的 DB/M/I/Q 内存在这里 |
| `this.maxPduSize` | 服务端允许的最大 PDU（默认 960，来自配置） |
| `this.pduSize` | **当前会话**协商出来的 PDU，初始 240，`0xF0` 之后被改写 |
| `this.tag` | 日志前缀，如 `[#3 192.168.0.9:52100]`，多客户端时能区分 |
| `this.writeAckItemSize` | 写响应中每项几个字节，默认 1（见第 12 节"坑"） |
| `this.stats` | 读写计数 |

> 为什么每个连接一个实例：`pduSize` 是"这个连接"协商的结果，不同客户端可能不一样。

---

### 2. `handle(pdu)` —— 唯一入口

```js
handle(pdu) {
  if (!Buffer.isBuffer(pdu) || pdu.length < 10 || pdu[0] !== 0x32) return null;
  ...
  try { return this.dispatch(pdu, pduRef); }
  catch (err) { return this.buildAckData(pduRef, ..., 0x81, 0x04); }
}
```

做三件事：

1. **合法性检查**：不是 Buffer、长度不足 10、第 0 字节不是 `0x32` → 直接返回 `null`（上层不发响应）
2. **调试打印**：环境变量 `S7_DUMP=1`（即 `--dump`）时，打印收发的十六进制报文
3. **兜住异常**：这是关键设计——**任何内部错误都必须回一个错误响应**。
   否则客户端只能等到超时，然后疯狂重连（"心跳写值失败 + 触发重连"就是这么来的）。错误响应 `errClass=0x81, errCode=0x04` 表示"应用层不支持/内部错误"。

---

### 3. `dispatch(pdu, pduRef)` —— 拆头 + 分发

```js
const paramLen = pdu.readUInt16BE(6);
const dataLen  = pdu.readUInt16BE(8);
const param = pdu.subarray(10, 10 + paramLen);
const data  = pdu.subarray(10 + paramLen, 10 + paramLen + dataLen);
```

- 按头部声明的两个长度，把报文切成 **参数区** 和 **数据区**
- `Math.min(...)` 防止客户端长度字段造假导致越界
- 然后按 `ROSCTR` 和 `param[0]`（功能码）分发：

| 条件 | 交给谁 |
| --- | --- |
| `rosctr === 0x07` | `handleUserData()`（SZL） |
| `rosctr !== 0x01` | 忽略并返回 null（不是 Job 的请求不处理） |
| `param[0] === 0xF0` | `handleSetupCommunication()` |
| `param[0] === 0x04` | `handleReadVar()` |
| `param[0] === 0x05` | `handleWriteVar()` |
| 其他 | 记录"不支持的功能码"，回 `0x81/0x04` |

---

### 4. `buildAckData(pduRef, param, data, errClass, errCode)` —— 统一出口

组装 Ack-Data 响应：**12 字节头 + 参数 + 数据**。

- `pduRef` 必须原样回显请求里的 PDU 引用，客户端靠它匹配"这是哪个请求的响应"
- 参数长度/数据长度按实际内容写入
- `errClass/errCode` 默认 `0x00/0x00`（成功）；出错时通常 `0x81/0x04`

> 这里只负责"帧结构"，不关心参数里装的是什么——所以读、写、协商都用它。

---

### 5. `handleSetupCommunication(pduRef, param)` —— 0xF0 通信协商

客户端握手时问："我能用多大 PDU、能同时发几个请求？"

```
请求参数: F0 00 | MaxAmqCaller(2) | MaxAmqCallee(2) | 期望PDU长度(2)
```

实现要点：

```js
let pduSize = Math.min(requested, this.maxPduSize);
if (pduSize < 240) pduSize = 240;   // 真实 CPU 的下限是 240
this.pduSize = pduSize;             // 记到会话上，后面裁剪响应要用
```

- **取小值**：客户端要 960、服务端上限 960 → 960；客户端要 4096 → 仍给 960
- **不低于 240**：和真实 PLC 行为一致
- 响应参数结构与请求相同，只是长度换成协商值

> `this.pduSize` 后续在 `handleReadVar` 里决定"一次最多能返回多少数据"。

---

### 6. `handleReadVar(pduRef, param)` —— 0x04 读变量

四步：

**① 解析出每个要读的项**

```js
for (let i = 0; i < count; i++) {
  const offset = 2 + i * 12;          // 参数区：2 字节头 + 每项 12 字节
  items.push(this.parseVarSpec(param, offset));
}
while (items.length < count) items.push({ malformed: true, ... });
```

> 补 `malformed` 项是为了**响应项数永远等于请求项数**，否则客户端按项数逐个解析会错位。

**② 逐项取值** → `this.readItem(item)`，得到 `{code, transport, length, payload, label}`

**③ 按 PDU 裁剪**（一次读太多时不能超长）

```js
const maxDataLen = this.pduSize - 12 - 2;   // 头 12 + 参数 2
// 每项占用 = 4 字节描述 + 数据 + 奇数补齐
```

放不下的项**不返回**（响应里的项数会小于请求项数）。

**④ 组装响应**

```
参数区: 04 | 实际返回项数
数据区: 每项 = 返回码(1) 传输尺寸(1) 长度(2) 数据 [补1字节使偶数]
```

注意：读响应的"每项返回码/长度"是放在**数据区**的，参数区只有 `04 + 项数` 两个字节（这是很多实现搞错的地方）。

最后打印日志：
```
[READ ] 读取 12 项: DB5.DBB0[6]=OK, DB5.DBB12[50]=OK, DB5.DBB108[42]=ERR:0x05(越界…)
```

---

### 7. `parseVarSpec(param, offset)` —— 解析 12 字节 S7ANY

把参数区里的 12 个字节翻译成对象：

```js
{
  specType: 0x12,        // 变量说明类型（固定）
  specLen:  0x0A,        // 后续字节数（固定）
  syntaxId: 0x10,        // 寻址方式：0x10 = S7ANY
  transport: 0x02,       // 传输尺寸：这里是 BYTE
  count: 350,            // 元素个数
  dbNumber: 5,           // DB 号（M/I/Q 区为 0）
  area: 0x84,            // 区域：0x84 = DB
  address: 2800,         // ★ 位地址 = 字节偏移 × 8 + 位号
}
```

**最容易被忽略的一行**：`address` 是**位地址**！

- `DB5.DBB350` → `350 × 8 = 2800`
- `DB5.DBX350.3` → `2800 + 3 = 2803`

所以后面所有"字节操作"都必须 `item.address >> 3`（除以 8）。

---

### 8. `readItem(item)` —— 真正从内存取一个值

返回统一结构 `{code, transport, length, payload, label, reason}`。

分支逻辑：

| 情况 | 处理 | 响应传输尺寸 / 长度单位 |
| --- | --- | --- |
| 区域不认识 | `0x0A 未知区域` | — |
| 传输尺寸不认识 | `0x06 不支持的类型` | — |
| DB 不存在 | `0x0A DB5 未定义` | — |
| `transport === 0x01`（BIT） | `extractBits()` 取位 | `0x03` / **位** |
| `transport === 0x09/0x0F`（OCTET STRING / DT） | 直接切片 | 原样回显 / **字节** |
| 其他（BYTE/WORD/DINT/REAL…） | `buffer.subarray(startByte, startByte + n)` | `0x04` / **位** |

三个关键点：

1. **字节数计算**：`Math.ceil((count × 每个元素的位数) / 8)`
   例：读 `DB5.DBD0`（REAL × 1）→ `1 × 32 / 8 = 4` 字节
2. **长度字段单位随传输尺寸变**：`0x03/0x04` 用**位**，`0x09` 用**字节**。
   这是 S7 协议的真实语义，客户端（如 nodes7）会按此除以 8。
3. **越界判断**：`startByte + byteCount > buffer.length` → `0x05`，并在 `reason` 里写清"要多少字节、当前多长"，方便排查。

---

### 9. `handleWriteVar(pduRef, param, data)` —— 0x05 写变量

写请求比读多一个"数据区"，所以要先**按顺序切出每项的写入值**：

```
参数区: 05 | 项数 | 项1 S7ANY(12B) | 项2 S7ANY(12B) …
数据区: 每项 = 保留(1)=0x00 | 传输尺寸(1) | 长度(2) | 数据 | [补1字节使偶数]
```

核心是这段"长度容错"：

```js
const bySpec  = Math.ceil((item.count × 每个元素位数) / 8);  // 按地址推算应该多少字节
let byteLen   = dataItemByteLength(transport, length);       // 按长度字段推算

if (bySpec > 0 && byteLen !== bySpec && length === bySpec) byteLen = length; // 容错1
if (offset + byteLen > data.length && offset + length <= data.length) byteLen = length; // 容错2
```

- **标准行为**：长度字段以"位"为单位（写 2 字节 INT → `length = 16`）
- **容错**：有些客户端按"字节"填（写 2 字节 INT → `length = 2`）。两种都能正确解析，否则会写错位、后续项全部错乱

然后逐项写 → `writeItem()`，再组响应：

```
参数区: 05 | 项数
数据区: 每项 1 字节返回码（0xFF 成功）
```

> 若请求里解析出的项少于请求项数（数据区不完整），会**补错误项**保证项数一致，让客户端能正常解析而不是超时。

---

### 10. `writeItem(item)` —— 真正往内存写一个值

返回 `{code, reason, hex}`（`hex` 用于日志显示写入内容）。

| 情况 | 处理 |
| --- | --- |
| 区域不认识 | `0x0A` |
| DB 未定义 | `0x0A`，reason 提示"请在 config 中添加" |
| 空数据 | `0x07` |
| 位写（transport 0x01 或写入项是 BIT） | `store.writeBitAt(...)` |
| 字节写 | `store.writeAt(...)`（地址先 `>> 3`） |

**为什么不直接改 Buffer**：`dataStore.writeAt()` 内部会做"新旧值比较"，并在变化时发 `change` 事件——**持久化（保存到磁盘）和心跳逻辑都挂在这个事件上**。绕过它写内存，这些功能就失效了。

位写时 `writeBitAt` 也是"读-改-写"，只动目标位，不影响同字节的其他 BOOL。

---

### 11. `handleUserData()` / `buildSzlResponse()` / `buildSzlRecords()` —— SZL（可选功能）

SZL = 系统状态列表，客户端用它读 CPU/模块标识（`GetCpuInfo`）。

```
请求参数: 00 01 12 04 | SZL-ID(2) | Index(2)
```

- `0x0011` → 模块标识（订货号 `6ES7 214-1AG40-0XB0` 等）
- `0x001C` → 组件标识（`CPU 1214C DC/DC/DC`）
- 其他 ID → 返回 `0x81/0x04` 错误

这部分只是"让某些客户端的 CPU 信息面板有数据"，对读写没有影响；不实现也能正常读写。

---

### 12. `describe(item)` —— 生成可读地址（只给日志用）

`DB5` + `transport 0x08(REAL)` + `address 2800` + `count 1`
→ `DB5.REAL350[4]`

- 位：`DB7.DBX0.0`
- 其他：`DB5.DBB0[10]`（B=字节、W=字、DINT、REAL…）

**纯辅助函数**，不影响协议行为，但排障时价值极大（能一眼看出客户端在读哪个地址）。

---

### 13. 模块级辅助函数

| 函数 | 作用 |
| --- | --- |
| `dataItemByteLength(transport, length)` | 把"长度字段"换算成"字节数"：`0x03/0x01` 按位、`0x09/0x0F` 按字节、其余按位 |
| `extractBits(buffer, startBit, bitCount)` | 从内存按位取（支持跨字节、支持多位），返回紧凑字节 |
| `writeBits(buffer, startBit, bitCount, payload)` | 按位写（旧的实现残留，**当前已被 `dataStore.writeBitAt` 取代，不再被调用**） |
| `szlString(text, len)` | 用空格填充生成定长 ASCII 字段 |
| `buildSzlRecords(szlId, szlIndex)` | 生成 SZL 记录内容，未支持的 ID 返回 `null` |

---

## 五、一次"读 DB5.DBD0（REAL）"的完整时序

```
客户端发:
  32 01 0000 0002 000E 0000 | 04 01 | 12 0A 10 02 0001 0005 84 00000000
  ↑TPKT/COTP 之上就是这串   └功能└项数 └──── 1 个 S7ANY：BYTE×1，DB5，DB 区，位地址 0
  注意：节点7 读 REAL 实际发的是 "BYTE × 4"，即 count=4、transport=0x02

handle() → dispatch() → handleReadVar()
   → parseVarSpec() 得到 {transport:0x02, count:4, dbNumber:5, area:0x84, address:0}
   → readItem()   startByte = 0>>3 = 0, byteCount = ceil(4×8/8) = 4
                  payload = DB5 的 DBB0~DBB3 = 41 48 00 00

服务端回:
  32 03 0000 0002 0002 0006 0000 | 04 01 | FF 04 0020 41480000
  ↑                                  └功能 └项数 └返回码 └传输尺寸 0x04 └长度 32 位 └数据
```

---

## 六、几个"必须这么写"的地方（容易踩的坑）

| 现象 | 原因 | 正确做法 |
| --- | --- | --- |
| 客户端报"数据长度不符" | 读响应长度字段按"字节"写了 | `0x03/0x04` 的长度单位是**位**，要 ×8 |
| 读 `DB5.DBD350` 读到 0 / 越界 | 直接把 `address` 当字节偏移 | `address` 是**位地址**，要 `>> 3` |
| 写第二项开始错乱 | 长度字段按字节/位理解不一致 | 用 `dataItemByteLength` + 两项容错 |
| 客户端一直超时重连 | 异常时没回响应 | `handle()` 里 try/catch 兜底必须保留 |
| 一次读很多项丢数据 | 响应超过协商的 PDU | `handleReadVar` 的裁剪逻辑；把 `pduSize` 提到 960 |
| 某些客户端写值失败但服务端显示 OK | 写响应项宽不同（1 字节 vs 4 字节） | 配置 `writeAckItemSize: 4` |

---

## 七、想扩展时改哪里

| 需求 | 改法 |
| --- | --- |
| 支持新区域（如定时器 T 区） | `AREA_NAMES` 加代码 → `dataStore.getArea()` 加分支 → 其余自动生效 |
| 支持新数据类型 | `TRANSPORT` 加一项 `{name, bits}` 即可（长度单位是位） |
| 支持"写响应 4 字节格式" | 配置 `writeAckItemSize: 4` |
| 支持块上传下载（0x1A~0x1F） | `dispatch()` 里加 case，返回 `0x81/0x04` 或实现之 |
| 记录每次读写到数据库 | 在 `handleReadVar`/`handleWriteVar` 的日志处加钩子（或用 `store.on('write')`） |

---

## 八、已知的小遗留（不影响使用，供你按需清理）

1. **`writeBits()` 已是死代码**：位写已下沉到 `dataStore.writeBitAt()`（为了统一"变化检测"），这个函数不再被调用，可删。
2. **`specType / specLen / syntaxId` 未校验**：真实 CPU 会校验 `syntaxId === 0x10`，这里只记录不检查。若要更严格，在 `parseVarSpec` 后加判断并回 `0x06`。
3. **CT/TM 区有映射但无内存**：`AREA_NAMES` 里有 `0x1c/0x1d`，但 `dataStore` 没有对应 Buffer，访问会返回 `0x0A`（符合"未实现"的预期）。
4. **读响应裁剪不重发**：超出 PDU 的项直接不返回。Snap7 会自动补读，`nodes7` 不会——所以默认把 PDU 设为 960 已能覆盖常见场景。
