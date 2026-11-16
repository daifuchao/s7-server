# `persistence.js` 函数详解

> **一句话职责**：把内存里的 DB / M / I / Q 保存到 JSON 文件，重启时自动读回来——也就是 **"断电保持"**。
> 它只做两件事：**监听变化 → 防抖落盘**、**启动时恢复**。具体如何序列化由 `dataStore.js` 的 `serialize()/restore()` 负责。

## 在项目中的位置

```
dataStore（change 事件）
      ↓
persistence.js（防抖 → 写文件 data/state.json）
      ↓ 启动时
dataStore.restore()（恢复内存）
```

## 硬要说清的两点

1. **为什么监听 `change` 而不是 `write`**
   `change` 只在值真正变化时发出，重复写同一个值不会触发落盘，省 IO。
2. **为什么有防抖**
   上位机可能每秒写几十次（心跳场景），每次都 `writeFileSync` 会有明显 IO 抖动。默认攒 300ms 写一次。

---

## `class Persistence`

### `constructor(store, options)`

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `store` | — | `DataStore` 实例 |
| `options.file` | `data/state.json` | 存档路径（`path.resolve` 成绝对路径） |
| `options.debounceMs` | `300` | 防抖时间（毫秒） |
| `options.logger` | `console` | 日志器 |

内部状态：

```js
this.timer = null;                       // 防抖定时器
this.handler = () => this.scheduleSave(); // 事件回调（保存引用，便于 off）
```

> `handler` 存成属性很重要：`store.off('change', handler)` 必须传**同一个函数引用**才能解绑。如果写成 `off('change', () => this.scheduleSave())` 就永远解不掉。

---

### `load()` —— 启动时恢复

| 返回 | 说明 |
| --- | --- |
| `true` | 成功从文件恢复 |
| `false` | 文件不存在 / 解析失败（此时内存保持配置里的初始值） |

```js
if (!fs.existsSync(this.file)) {
  this.logger.info(`未找到持久化数据文件 ${this.file}，使用配置中的初始值`);
  return false;
}
const snapshot = JSON.parse(fs.readFileSync(this.file, 'utf8'));
this.store.restore(snapshot);
this.logger.info(`已恢复运行数据：${this.file}，保存于 ${snapshot.savedAt}`);
```

**关键设计：读取失败不抛异常**。文件损坏、手工改错 JSON、磁盘故障时，只打警告并继续用初始值启动——模拟服务不能因为一个存档文件坏了就起不来。

---

### `watch()` / `unwatch()`

```js
watch()   { this.store.on('change', this.handler); }
unwatch() { this.store.off('change', this.handler); }
```

- `watch()` 在 `s7server.start()` 里、`load()` 之后调用
- `unwatch()` 在 `s7server.stop()` 里调用，**必须在最终 `save()` 之前**，否则保存过程中若触发变化会重复排定时器

---

### `scheduleSave()` —— 防抖调度

```js
scheduleSave() {
  if (this.timer) return;                  // ★ 已有定时器就不再排（合并多次写入）
  this.timer = setTimeout(() => {
    this.timer = null;
    this.save();
  }, this.debounceMs);
  if (this.timer.unref) this.timer.unref(); // ★ 不阻止进程退出
}
```

两个细节：

- **合并写入**：300ms 内的 N 次变化只会落盘 1 次
- **`unref()`**：定时器不会让 Node 进程"赖着不退出"。如果没有它，按 Ctrl+C 后要等定时器走完才退出

---

### `save()` —— 真正写文件

```js
fs.mkdirSync(path.dirname(this.file), { recursive: true }); // 目录不存在就建
const snapshot = this.store.serialize();
snapshot.savedAt = new Date().toISOString();                 // 记录保存时间，恢复时能看出来
fs.writeFileSync(this.file, JSON.stringify(snapshot));
```

| 返回 | 说明 |
| --- | --- |
| `true` / `false` | 是否成功（失败只打警告，不抛异常） |

- **同步写**（`writeFileSync`）：数据量小（几十 KB），同步写能保证 `stop()` 里调用后立刻落盘
- **先 `clearTimeout`**：如果定时器还没触发，立即保存时要把排队的任务取消，避免重复写
- 写失败（磁盘满、权限不足）只 `warn`，因为此时业务仍在运行，不该崩溃

---

### `clear()`

删除存档文件，用于 `--reset`。

```js
if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
this.logger.info(`已清除持久化数据 ${this.file}`);
```

`s7server.start()` 里的逻辑：

```js
if (this.persistence) {
  if (this.config.reset) this.persistence.clear();  // --reset：先删档
  else this.persistence.load();                     // 否则读档
  this.persistence.watch();                         // 之后的变化都要保存
}
this.logic.start();                                 // ★ 规则要在恢复之后启动
```

> 顺序很重要：**先恢复数据、再启动逻辑规则**。因为规则的 `last` 初值要基于恢复后的值，否则重启后第一次写入会被误判为"变化"。

---

## 存档文件长什么样

```json
{
  "version": 1,
  "merkers": "00000000...",
  "inputs": "00000000...",
  "outputs": "00000000...",
  "dbs": {
    "5": { "size": 1024, "name": "DB5_ProcessData", "data": "4148000000000000..." },
    "6": { "size": 1024, "name": "DB6_Setpoints",   "data": "41c80000..." },
    "7": { "size": 512,  "name": "DB7_Status",      "data": "01000000..." }
  },
  "savedAt": "2026-11-11T03:21:21.116Z"
}
```

---

## 三种运行模式对照

| 模式 | 命令 | load | watch | save |
| --- | --- | --- | --- | --- |
| 正常（保持） | `node src/index.js` | ✅ | ✅ | ✅ 退出时 |
| 重置 | `--reset` | ❌ 先 `clear()` | ✅ | ✅ |
| 不保存 | `--no-persist` | 不创建实例 | — | — |

---

## 常见修改点

| 需求 | 改法 |
| --- | --- |
| 改存档位置 | 配置 `persistence.file` |
| 改落盘频率 | 配置 `persistence.debounceMs`（调大更省 IO，调小更安全） |
| 想每次变化立即落盘 | `debounceMs: 0` |
| 想定时快照（如每 5 秒） | 在 `watch()` 里加 `setInterval(() => this.save(), 5000)` |
| 想区分"保持性"和"非保持性"区域 | 在 `serialize()` 里跳过指定 DB，或在 `restore()` 里不恢复 |
| 想改成数据库存储 | 替换 `save()`/`load()` 内部实现，接口保持不变即可 |
