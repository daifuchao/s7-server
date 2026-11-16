# `logger.js` 函数详解

> **一句话职责**：一个 70 行的极简日志器，提供带时间戳、带等级标签、可选颜色的输出。**没有依赖、没有文件滚动**，够用就好。

## 输出长什么样

```
07:59:07.688 [READ ] [#1 127.0.0.1:55054] 读取 2 项: DB5.DBB100[2]=OK, DB5.DBB356[2]=OK
07:59:07.690 [WRITE] [#1 127.0.0.1:55054] 写入 1 项: DB6.DBB372[2]=OK ← 03e7
07:58:52.705 [WARN ] DB5 的初始值 INT356 需要 358 字节，但 DB 只有 300 字节，已跳过
```

结构：`时间戳 + [等级] + 消息`，其中等级用颜色区分（在终端里才上色）。

---

## 模块级变量与函数

### `useColor`

```js
const useColor = process.stdout.isTTY && process.env.NO_COLOR !== '1';
```

- 只有 **输出到终端**（TTY）时才启用 ANSI 颜色，重定向到文件时自动关掉，避免日志文件里出现 `\x1b[32m` 乱码
- 支持 `NO_COLOR=1` 环境变量强制关闭（这是社区通用约定）

### `C`（颜色表）

```js
const C = { reset, gray, red, green, yellow, blue, magenta };
```

存 ANSI 转义码，`paint()` 用它们给文字上色。

### `paint(color, text)`

**作用**：给文本套颜色，不启用颜色时原样返回。

| 参数 | 说明 |
| --- | --- |
| `color` | `C` 里的某个颜色码 |
| `text` | 要上色的文字 |
| **返回** | string |

### `ts()`

**作用**：生成 `时:分:秒.毫秒` 形式的时间戳，例如 `07:59:07.688`。

```js
const p = (n, w = 2) => String(n).padStart(w, '0');
return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
```

- 毫秒补到 3 位，这样对齐好看，也便于看请求耗时
- 只输出时间不输出日期：服务端日志通常是"当天会话"，够用且省空间

---

## `class Logger`

### `constructor({ verbose, silent })`

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `verbose` | `false` | 为 `true` 时才输出 `debug()`（命令行 `--verbose` 打开） |
| `silent` | `false` | 为 `true` 时所有输出都静默（测试或嵌入用） |

### `_out(tag, color, msg)`（私有）

所有方法最终都走这里：

```js
if (this.silent) return;
console.log(`${paint(C.gray, ts())} ${paint(color, tag)} ${msg}`);
```

时间戳用灰色、等级标签用各自颜色、消息原色 —— 视觉上等级最醒目。

### `info(msg)` / `warn(msg)` / `error(msg)`

通用三级日志，标签分别是 `[INFO ]`、`[WARN ]`、`[ERROR]`（方括号内补空格对齐）。

### `read(msg)` / `write(msg)`

**这个项目特有的两个等级**，标签 `[READ ]`（青色）、`[WRITE]`（洋红），专门用于 S7 读/写报文日志。

这样做的原因：S7 联调时最需要一眼区分"这是客户端在读"还是"在写"，单独配色比全是 INFO 高效得多。

### `debug(msg)`

只在 `verbose === true` 时输出，标签 `[DEBUG]`（灰色）。用于 COTP 报文、SZL 请求等"平时不想看"的信息。

---

## 谁在用它

| 使用方 | 用途 |
| --- | --- |
| `index.js` | 创建实例（读 `--verbose`），打印启动横幅、错误提示、退出信息 |
| `s7server.js` | 连接建立/关闭、在线客户端数、PDU 协商结果 |
| `s7comm.js` | `logger.read()` / `logger.write()` 输出每条读写请求 |
| `logic.js` | `[LOGIC]` 规则触发日志 |
| `persistence.js` | 恢复/保存/清除数据 |
| `dataStore.js` | 初始化值越界、自动创建 DB 的警告 |

`Logger` 实例通过构造函数一路传递（`new S7Server({...config, logger})` → `new DataStore({...logger})` → ...），是典型的**依赖注入**，方便测试时换成静默实例。

---

## 常见修改点

| 需求 | 改法 |
| --- | --- |
| 日志写文件 | `_out()` 里改成 `fs.appendFileSync(file, 行)`，或同时写 console |
| 加日期 | `ts()` 里加 `年-月-日` |
| 按等级过滤（如只看 WARN 以上） | 构造函数加 `level`，`_out` 里比较优先级 |
| 想输出 JSON 结构化日志 | 在 `_out` 里改成 `JSON.stringify({ts, level, msg})` |
| 想关闭颜色但保留 TTY | `NO_COLOR=1 node src/index.js` |
