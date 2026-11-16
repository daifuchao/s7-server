# `logic.js` 函数详解

> **一句话职责**：让模拟器拥有"PLC 程序"的能力——**客户端写某个地址 → 服务端读它的值 → 做运算 → 写到另一个地址**。默认实现的就是心跳：写 `DB6.INT372`，服务端把 `该值+1` 写进 `DB5.INT356`。

## 在项目中的位置

```
dataStore.writeAt()  ──emit('write')──►  logic.js.onChange()
                                              │ 判断规则是否命中
                                              ▼
                                         execute() ──► dataStore.writeAt()（写目标地址）
```

因为写目标又走 `writeAt`，理论上可以"链式触发"，所以需要**递归深度保护**。

---

## 支持的动作（`do.op`）

| op | 计算式 | 典型用途 |
| --- | --- | --- |
| `copyadd` | **目标 = 源当前值 + step** | 心跳/握手：客户端写 N，服务端回 N+1 |
| `copy` | 目标 = 源当前值 | 数据镜像 |
| `inc` | 目标 = 目标当前值 + step | 计数器自增 |
| `dec` | 目标 = 目标当前值 − step | 倒计数 |
| `add` | 目标 = 目标当前值 + step | 同 inc（step 可为负） |
| `set` | 目标 = 固定值 `value` | 触发即置位 |

## 两种触发方式（`trigger`）

| 值 | 行为 |
| --- | --- |
| `write`（默认） | 客户端**每写一次**就执行一次（即使写的是同一个值） |
| `change` | 只有源值**真的变了**才执行 |

> 心跳场景用 `write`：客户端可能重发同一个心跳序号，服务端仍应刷新响应值。

---

## 常量 `TYPES` —— 数据类型定义表

每个类型提供四样东西：

```js
INT: {
  size: 2,                                  // 占用字节
  read: (b, o) => b.readInt16BE(o),         // 从 Buffer 读
  encode: (v) => { ... writeInt16BE ... },  // 转成 Buffer
  add: (v, d) => wrapSigned(v + d, 65536),  // 加法（带 PLC 式回绕）
}
```

| 类型 | size | 读取方法 | 回绕规则 |
| --- | --- | --- | --- |
| `BYTE` | 1 | `readUInt8` | 0~255 |
| `WORD` | 2 | `readUInt16BE` | 0~65535 |
| `INT` | 2 | `readInt16BE` | **-32768~32767**（32767+1 → -32768） |
| `DWORD` | 4 | `readUInt32BE` | 0~2³²-1 |
| `DINT` | 4 | `readInt32BE` | -2³¹~2³¹-1 |
| `REAL` | 4 | `readFloatBE` | 保留 6 位小数避免浮点误差堆积 |

**为什么要有回绕**：PLC 的 ADD 指令就是 16/32 位定长溢出后回绕（不会抛错、不会变大数）。模拟器保持一致，上位机看到的数值行为才和真机一样。

---

## `wrap(v, mod)` / `wrapSigned(v, mod)`

```js
function wrap(v, mod)        { return ((v % mod) + mod) % mod; }          // 无符号回绕
function wrapSigned(v, mod)  { return wrap(v + mod / 2, mod) - mod / 2; } // 有符号回绕
```

- `wrap(32769, 65536)` → `32769`
- `wrapSigned(32768, 65536)` → `-32768`（INT 溢出）
- 先 `%` 再 `+mod` 再 `%`：保证 JS 负数取模也是正数结果

---

## `class LogicEngine`

### `constructor(store, options)`

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `store` | — | 数据区（事件源 + 读写目标） |
| `options.rules` | `[]` | 规则数组（来自 config 的 `logic`） |
| `options.logger` | `console` | 日志器 |
| `options.maxDepth` | `4` | 递归深度上限，防规则互相触发死循环 |

```js
this.depth = 0;                        // 当前递归深度
this.rules = [];                       // 规范化后的规则
this.stats = new Map();                // 规则名 → 触发次数
this.handler = (e) => this.onChange(e); // 保存引用，便于 off
```

构造函数里逐条调用 `normalizeRule()`，**不合法的规则会被跳过并警告，而不是让服务起不来**。

---

### `normalizeRule(raw)` —— 校验并规范化一条规则

输入（config 里写的）：

```json
{
  "name": "心跳1",
  "on":  { "db": 6, "offset": 372, "type": "INT" },
  "do":  { "db": 5, "offset": 356, "type": "INT", "op": "copyadd", "step": 1 },
  "trigger": "write"
}
```

校验四件事：

1. `on` / `do` 必须存在
2. `type` 必须在 `TYPES` 里（默认 `INT`）
3. `op` 必须是允许的 6 种之一（默认 `inc`）
4. **地址必须落在 DB 范围内**：

```js
if (!srcBuf || rule.on.offset + rule.on.size > srcBuf.length) {
  this.logger.warn(`忽略逻辑规则（源地址超出 DB${rule.on.db} 长度 ...）`);
  return null;
}
```

> 这条校验非常实用：如果 DB5 被配成 300 字节，而规则要写 `DB5.INT356`，启动日志会明确告诉你"目标地址超出 DB5 长度 300，规则已忽略"——而不是等你联调时才发现心跳没反应。

输出（内部结构）：

```js
{
  name, trigger,                 // 'write' | 'change'
  on: { db, offset, type, size }, // 源
  do: { db, offset, type, op, step, value }, // 目标
  last: undefined,               // 上次读到的源值（用于判断变化）
  fires: 0,                      // 触发次数
}
```

---

### `start()` —— 挂上事件并打印规则

```js
this.store.on('write', this.handler);       // ★ 监听 write（不是 change）
for (const rule of this.rules) {
  rule.last = this.readSource(rule);        // 记录初始值，避免重启后第一次写被误判为变化
  this.stats.set(rule.name, 0);
}
```

然后打印，例如：

```
已加载 2 条逻辑规则（值变化 → 计数）:
  · 心跳1：写 DB6.INT372 → DB5.INT356 = 该值 + 1
      [当前值 0] → DB5.INT356 源值 +1
```

> 顺序要求：必须在 `persistence.load()` **之后**调用（`s7server.start()` 已保证），否则 `last` 会取到初始值而不是恢复后的值。

### `stop()`

```js
this.store.off('write', this.handler);
```

### `readSource(rule)`

按规则源类型从 DB 里读当前值；DB 不存在返回 `undefined`（调用方会跳过）。

---

### `onChange(event)` —— 规则命中判断（核心）

```js
if (event.area !== 'DB') return;             // 只处理 DB 区
if (this.depth >= this.maxDepth) return;     // 递归保护

for (const rule of this.rules) {
  if (rule.on.db !== event.dbNumber) continue;

  // ① 区间重叠判断：支持客户端一次写一大块（如 DB6.DBB360~379 覆盖 INT372）
  const start = rule.on.offset;
  const end = rule.on.offset + rule.on.size;
  if (event.offset + event.length <= start || event.offset >= end) continue;

  // ② 读当前值，判断是否变化
  const current = this.readSource(rule);
  const previous = rule.last;
  const changed = current !== previous;
  rule.last = current;

  // ③ 按触发方式过滤
  if (rule.trigger === 'change' && !changed) continue;

  rule.fires += 1;
  this.execute(rule, previous, current, changed);
}
```

**① 区间重叠判断**是这段代码最巧妙的地方：

| 客户端写 | 事件区间 | 规则源 | 是否命中 |
| --- | --- | --- | --- |
| `DB6.DBW372` | [372, 374) | [372, 374) | ✅ |
| `DB6.DBB360~379`（20 字节） | [360, 380) | [372, 374) | ✅ |
| `DB6.DBW374` | [374, 376) | [372, 374) | ❌（不重叠） |

条件 `event.offset + event.length <= start || event.offset >= end` 是标准的"两区间不相交"判断。

**③ 为什么用 `current !== previous` 而不是事件里的 `changed`**：一次块写可能改了别的字节而源值没变，只有比较源值本身才准确。

---

### `execute(rule, previous, current, changed)` —— 执行动作

```js
const buffer = this.store.getArea('DB', rule.do.db);
const type = TYPES[rule.do.type];
const oldValue = type.read(buffer, rule.do.offset);   // 目标的当前值

switch (rule.do.op) {
  case 'inc':     newValue = type.add(oldValue, Math.abs(rule.do.step)); break;
  case 'dec':     newValue = type.add(oldValue, -Math.abs(rule.do.step)); break;
  case 'add':     newValue = type.add(oldValue, rule.do.step); break;
  case 'copyadd': newValue = type.add(current, rule.do.step); break;  // ★ 基于源值
  case 'set':     newValue = Number(rule.do.value); break;
  case 'copy':    newValue = current; break;
}

// 递归深度 +1，写目标，再 -1（finally 保证即使写入抛错也能恢复）
this.depth += 1;
try {
  result = this.store.writeAt('DB', rule.do.db, rule.do.offset, type.encode(newValue));
} finally {
  this.depth -= 1;
}
```

日志：

```
[LOGIC] 写 DB6.INT372 (0 → 5)  ⇒  DB5.INT356: 0 → 6
[LOGIC] 写 DB6.INT372 (写入 100)  ⇒  DB5.INT356: 101 → 101   ← 重复写同值，幂等
```

`srcDesc` 会区分"值变化 `旧 → 新`"和"重复写入 `写入 N`"两种情况，方便判断客户端行为。

---

## 常见规则配置示例

```json
// 1. 心跳：写 DB6.INT372 = N → DB5.INT356 = N + 1
{ "on": {"db":6,"offset":372,"type":"INT"},
  "do": {"db":5,"offset":356,"type":"INT","op":"copyadd","step":1}, "trigger":"write" }

// 2. 计数：写一次 DB6.INT374 就 +1（不关心写什么值）
{ "on": {"db":6,"offset":374,"type":"INT"},
  "do": {"db":5,"offset":358,"type":"INT","op":"inc","step":1}, "trigger":"write" }

// 3. 镜像：DB6 的 REAL 同步到 DB5
{ "on": {"db":6,"offset":0,"type":"REAL"},
  "do": {"db":5,"offset":4,"type":"REAL","op":"copy"}, "trigger":"change" }

// 4. 报警置位：DB7.X0.0 变 true 时把 DB7.INT4 设为 1
{ "on": {"db":7,"offset":0,"type":"BYTE"},
  "do": {"db":7,"offset":4,"type":"INT","op":"set","value":1}, "trigger":"change" }
```

---

## 已知限制

| 限制 | 说明 |
| --- | --- |
| 只支持 DB 区 | `onChange` 里 `if (event.area !== 'DB') return` |
| 不支持 BIT 类型 | `TYPES` 里没有 BOOL；BOOL 触发需要扩展（可按 BYTE 监听整个字节） |
| 不支持多条件组合 | 一条规则只监听一个地址；多条件需要写多条规则或扩展逻辑 |
| 递归深度 4 | 超过后静默跳过，防止 A→B→A 死循环 |
