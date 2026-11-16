# `simulator.js` 函数详解

> **一句话职责**：可选功能——定时修改 DB5/DB6/DB7 里的几个值，让模拟器看起来像一台"正在运行的 PLC"（数值在跳、温度在爬、状态位在闪）。
> 它**不参与协议**，只是往 `dataStore` 的 Buffer 里写数据。默认关闭，用 `--live` 或配置 `simulation.enabled` 打开。

## 在项目中的位置

```
index.js --live ──► new Simulator(store) ──setInterval──► update() ──► 直接改 Buffer
```

⚠️ 注意：这里**直接操作 Buffer** 而不是走 `store.writeAt()`。原因：模拟数据每秒刷新，不需要触发持久化（否则每秒写磁盘），也不需要触发心跳规则。如果你希望模拟数据也能触发规则，需要改成走 `writeAt`。

---

## 被修改的地址

| 地址 | 类型 | 变化规律 | 用途 |
| --- | --- | --- | --- |
| `DB5.DBD0` | REAL | `50 + 50×sin(tick/10)`，0~100 正弦波 | 模拟过程值/流量 |
| `DB5.DBW4` | INT | `tick % 32767` 递增 | 模拟计数器 |
| `DB5.DBX6.0` | BOOL | 每 2 次翻转一次 | 模拟心跳位 |
| `DB6.DBD0` | REAL | 20~80 之间来回爬升，每 tick ±0.7 | 模拟温度设定 |
| `DB7.DBW2` | INT | `tick % 1000` 循环 | 模拟运行小时 |
| `DB7.DBX0.0` | BOOL | 恒置 `1` | 模拟"运行中"状态 |

---

## `class Simulator`

### `constructor(store, options)`

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `store` | — | 数据区实例 |
| `options.intervalMs` | `1000` | 刷新周期（毫秒） |
| `options.logger` | `console` | 日志器 |

内部状态：

```js
this.tick = 0;              // 心跳计数，所有规律都由它驱动
this.temperature = 25;      // 当前模拟温度（会一直累加/递减）
this.temperatureDir = 1;    // 温度变化方向：1 上升，-1 下降
```

---

### 三个 getter：`db5` / `db6` / `db7`

```js
get db5() { return this.store.getArea('DB', 5); }
```

每次访问都实时取 Buffer，好处是**DB 被重建（如恢复存档）后不用更新引用**，代价是开销极小（一次 Map 查找）。

返回 `null` 时所有写入都会被跳过（下面 `update()` 里有 `db5 &&` 判断），所以**删掉 DB5 也不会报错**。

---

### `start()`

```js
if (this.timer) return;                       // 幂等：重复调用不会起多个定时器
this.timer = setInterval(() => this.update(), this.intervalMs);
if (this.timer.unref) this.timer.unref();     // ★ 不阻止进程退出
this.logger.info(`数据模拟器已启动（每 ${this.intervalMs} ms 刷新一次 DB5/DB6/DB7）`);
```

- `unref()`：模拟器不该让 Node 进程"退不掉"
- 幂等判断：`index.js` 里 `server.on('client:connect')` 之类误调用也安全

---

### `stop()`

```js
if (this.timer) { clearInterval(this.timer); this.timer = null; }
```

`index.js` 的 `shutdown()` 里调用，避免退出时还有定时任务在跑。

---

### `update()` —— 一次刷新（核心）

```js
this.tick += 1;

// ── DB5：正弦波 + 计数 + 心跳位 ──
if (db5 && db5.length >= 8) {
  const sine = 50 + 50 * Math.sin(this.tick / 10);
  db5.writeFloatBE(Number(sine.toFixed(3)), 0);   // DBD0 = REAL（大端）
  db5.writeInt16BE(this.tick % 32767, 4);         // DBW4 = INT

  const byte = db5[6];                            // ★ 位操作要读-改-写
  db5[6] = this.tick % 2 === 0 ? byte | 0x01 : byte & 0xfe;
}

// ── DB6：温度来回爬 ──
if (db6 && db6.length >= 4) {
  this.temperature += this.temperatureDir * 0.7;
  if (this.temperature > 80) this.temperatureDir = -1;   // 到顶掉头
  if (this.temperature < 20) this.temperatureDir = 1;    // 到底掉头
  db6.writeFloatBE(Number(this.temperature.toFixed(2)), 0);
}

// ── DB7：运行计数 + 运行位 ──
if (db7 && db7.length >= 4) {
  db7.writeInt16BE(this.tick % 1000, 2);
  db7[0] = 0x01;
}
```

三个实现细节值得注意：

1. **长度保护**（`db5.length >= 8`）：DB 被配置得很小时不会越界抛错，只是跳过
2. **位操作读-改-写**：`db5[6] = byte | 0x01`，不能直接 `db5[6] = 1`，否则会把同一字节的其他位清零
3. **`toFixed()` 再转 Number**：避免浮点误差累积出 `50.00000000000001` 这种值，让上位机看到干净的数字

---

## 效果示例

开启 `--live` 后，客户端每秒读一次会看到：

```
tick=1  DB5.REAL0=54.983  DB5.INT4=1    DB6.REAL0=25.70
tick=2  DB5.REAL0=59.840  DB5.INT4=2    DB6.REAL0=26.40
tick=3  DB5.REAL0=64.457  DB5.INT4=3    DB6.REAL0=27.10
...
tick=16 DB5.REAL0=97.22   DB5.INT4=16   DB6.REAL0=36.20
```

适合演示"上位机曲线在动"的效果。

---

## 常见修改点

| 需求 | 改法 |
| --- | --- |
| 改刷新频率 | `simulation.intervalMs` 或 `new Simulator(store, { intervalMs: 500 })` |
| 改模拟的地址/规律 | 直接改 `update()` 里的写入逻辑 |
| 让模拟数据也触发心跳规则 | 把 `db5.writeFloatBE(...)` 换成 `store.writeAt('DB', 5, 0, buf)` |
| 让模拟数据也持久化 | 同上（走 `writeAt` 就会发 `change` 事件） |
| 模拟随机故障 | 在 `update()` 里按概率改 `DB7.DBX0.1`（故障位） |
| 多个 DB 联动 | 在 `update()` 里加 `if (db6Real > 60) db7[0] = 0` 之类逻辑 |
