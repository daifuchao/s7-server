# S7-1200 模拟服务端（Node.js）

纯 Node.js 实现的西门子 **S7-1200 PLC 模拟服务端**，在标准 **ISO-on-TCP（102 端口）+ S7comm 经典协议** 上运行，任何支持 S7 协议的客户端（Snap7 / python-snap7 / nodes7 / S7.Net / node-red-contrib-s7 / KEPServerEX 等）都能像连接真实 PLC 一样连上它，并读写 **DB5 / DB6 / DB7**。

- **零运行时依赖**：只用 Node 内置 `net` / `buffer`，`npm install` 不是必须的
- **已实测通过**：`nodes7` 真实客户端 + 自研协议级测试（9/9）

---

## 一、功能特性

| 能力 | 说明 |
| --- | --- |
| 传输层 | TPKT(RFC1006) + COTP Class 0 连接建立/维持/断开 |
| 会话层 | S7comm `Setup Communication`，PDU 长度协商（默认 480，可配） |
| 数据访问 | `Read Var (0x04)` / `Write Var (0x05)`，支持一次多项 |
| 数据类型 | BOOL(位)、BYTE、CHAR、WORD、INT、DWORD、DINT、REAL、STRING |
| 数据区域 | DB 数据块、M 位存储区、I 输入区、Q 输出区 |
| 多客户端 | 支持多个客户端同时连接，互不干扰 |
| 错误码 | 地址越界返回 `0x05`，DB 不存在返回 `0x0A`（与真实 CPU 行为一致） |
| 可观测 | 每条读写请求打印可读地址与结果，支持 `--verbose` 十六进制报文调试 |
| 数据模拟 | `--live` 让 DB5/DB6/DB7 数值周期性变化，模拟"活"的 PLC |
| 逻辑规则 | 客户端写触发地址 → 服务端读值运算 → 写回目标地址，默认 DB6.INT372→DB5.INT356=值+1、DB6.INT374→DB5.INT358=值+1 |
| 断电保持 | 写入的数据自动保存到 `data/state.json`，**重启后自动恢复，不重置**（`--reset` 可恢复初始值） |

---

## 二、目录结构

```
s7-1200-sim/
├── src/
│   ├── index.js        # 启动入口（命令行参数解析）
│   ├── s7server.js     # TCP 服务、客户端会话管理
│   ├── s7comm.js       # S7comm 协议核心（Setup/Read/Write/SZL）
│   ├── cotp.js         # COTP 连接管理
│   ├── tpkt.js         # TPKT 封包 / 流式拆包
│   ├── dataStore.js    # DB / M / I / Q 数据区存储
│   ├── logic.js        # 逻辑规则引擎（写触发 → 读值运算 → 写目标）
│   ├── persistence.js  # 数据持久化（断电保持）
│   ├── simulator.js    # 可选的数据变化模拟
│   └── logger.js       # 日志
├── config/default.json # 配置文件（DB 定义、端口、PDU、逻辑规则、持久化）
├── data/state.json     # 运行时生成：持久化的数据（重启自动恢复）
├── test/
│   ├── client-demo.js      # 用 nodes7 客户端做端到端读写测试
│   ├── raw-proto-test.js   # 不依赖第三方库的协议级自测
│   ├── bulk-read-test.js   # 批量读取（多地址一次读）
│   ├── logic-test.js       # 心跳逻辑测试
│   └── persist-test.js     # 持久化（重启保持）测试
└── package.json
```

---

## 三、快速开始

```bash
# 1. 启动（102 是标准 S7 端口，需要管理员权限）
sudo node src/index.js

# 2. 或者使用高位端口，普通用户即可运行
node src/index.js --port 1102

# 3. 带动态数据 + 详细日志
node src/index.js --port 1102 --live --verbose
```

启动输出示例：

```
01:31:57.865 [INFO ] S7-1200 模拟服务端已启动: 0.0.0.0:1102
01:31:57.866 [INFO ]   数据块 DB5_ProcessData: 1024 字节
01:31:57.866 [INFO ]   数据块 DB6_Setpoints: 1024 字节
01:31:57.866 [INFO ]   数据块 DB7_Status: 512 字节
01:31:57.867 [INFO ] 等待客户端连接…（Ctrl+C 退出）
01:31:59.351 [INFO ] [#1 127.0.0.1:41248] COTP 连接建立 (TSAP 客户端=0x100 → 服务端=0x301)
01:31:59.351 [INFO ] [#1 127.0.0.1:41248] 通信建立完成，协商 PDU 长度 = 480 字节
01:31:59.353 [READ ] [#1 127.0.0.1:41248] 读取 2 项: DB5.DBB0[4]=OK, DB6.DBB8[2]=OK
01:31:59.356 [WRITE] [#1 127.0.0.1:41248] 写入 1 项: DB5.DBB0[4]=OK ← 414570a4
```

### 命令行参数

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| `--port <端口>` | 监听端口 | `102` |
| `--host <地址>` | 监听地址 | `0.0.0.0` |
| `--pdu <字节>` | 最大 PDU 长度 | `960` |
| `--config <路径>` | 配置文件路径 | `config/default.json` |
| `--live` | 开启数据模拟 | 关 |
| `--verbose` | 输出调试日志 | 关 |
| `--dump` | 打印每个请求/响应的原始报文（十六进制） | 关 |
| `--reset` | 启动前清除持久化数据，恢复配置里的初始值 | 关 |
| `--no-persist` | 关闭持久化（每次启动都是初始值） | 关 |

也支持环境变量：`S7_PORT`、`S7_HOST`、`S7_PDU_SIZE`。
调试报文：`S7_DUMP=1 node src/index.js --port 1102`（打印收发的 PDU 十六进制）。

> **Linux 上绑定 102 端口的两种方式**
> 1. `sudo node src/index.js`
> 2. `sudo setcap cap_net_bind_service=+ep $(which node)`，之后普通用户也能用 102

---

## 四、默认数据块布局

### DB5 · ProcessData（1024 字节，以下为已定义变量）

| 地址 | 类型 | 说明 | 初值 |
| --- | --- | --- | --- |
| `DB5.DBD0` | REAL | 过程值 1 | 0.0 |
| `DB5.DBD4` | REAL | 过程值 2 | 0.0 |
| `DB5.DBW8` | INT | 计数器 | 0 |
| `DB5.DBW10` | INT | 状态字 | 0 |
| `DB5.DBD12` | DINT | 累计量 | 0 |
| `DB5.DBX16.0` | BOOL | 启动位 | false |
| `DB5.DBX16.1` | BOOL | 停止位 | false |
| `DB5.DBX16.2` | BOOL | 报警位 | false |
| `DB5.STRING20` | STRING[20] | 文本 | "S7-1200 SIM" |
| `DB5.INT356` | INT | **读心跳 1**：= 客户端写入 DB6.INT372 的值 + 1 | 0 |
| `DB5.INT358` | INT | **读心跳 2**：= 客户端写入 DB6.INT374 的值 + 1 | 0 |

### DB6 · Setpoints（1024 字节）

| 地址 | 类型 | 说明 | 初值 |
| --- | --- | --- | --- |
| `DB6.DBD0` | REAL | 温度设定 | 25.0 |
| `DB6.DBD4` | REAL | 压力设定 | 60.0 |
| `DB6.DBW8` | INT | 速度设定 | 100 |
| `DB6.DBX12.0` | BOOL | 使能 | false |
| `DB6.INT372` | INT | **写心跳 1**：客户端往这里写值，服务端读值 +1 写进 DB5.INT356 | 0 |
| `DB6.INT374` | INT | **写心跳 2**：客户端往这里写值，服务端读值 +1 写进 DB5.INT358 | 0 |

### DB7 · Status（512 字节）

| 地址 | 类型 | 说明 | 初值 |
| --- | --- | --- | --- |
| `DB7.DBX0.0` | BOOL | 运行状态 | false |
| `DB7.DBX0.1` | BOOL | 故障状态 | false |
| `DB7.DBW2` | INT | 运行小时 | 0 |
| `DB7.DBW4` | INT | 报警码 | 0 |
| `DB7.DBD8` | REAL | 实际温度 | 0.0 |
| `DB7.DBD12` | DWORD | 计数器 | 0 |

另外内置：**M 区 1024 字节**、**I 区 256 字节**、**Q 区 256 字节**。

---

## 五、客户端连接示例

### 1) Node.js（nodes7）

```js
const nodes7 = require('nodes7');
const conn = new nodes7({ silent: false });

conn.initiateConnection({ port: 1102, host: '127.0.0.1', rack: 0, slot: 1 }, (err) => {
  if (err) return console.log('连接失败', err);

  // 读
  conn.readItems(['DB5,REAL0', 'DB6,INT8', 'DB7,X0.0', 'MB0'], (bad, values) => {
    console.log(values);   // { 'DB5,REAL0': 12.34, ... } 或 null(bad=true)
  });

  // 写
  conn.writeItems(['DB5,REAL0', 'DB7,X0.0'], [12.34, true], (bad) => {
    console.log(bad ? '写失败' : '写成功');
  });
});
```

### 2) Python（python-snap7）

```python
import snap7
from snap7.util import get_real, set_real

client = snap7.client.Client()
client.connect('127.0.0.1', 0, 1, 1102)      # 注意 tcpport 参数

data = client.db_read(5, 0, 4)               # 读 DB5.DBD0
print(get_real(data, 0))

buf = bytearray(4)
set_real(buf, 0, 12.34)
client.db_write(5, 0, buf)                   # 写 DB5.DBD0
client.disconnect()
```

### 3) C#（S7.Net）

```csharp
var plc = new Plc(CpuType.S71200, "127.0.0.1", 0, 1);
plc.Open();
var temp = (float)plc.Read("DB6.DBD0");
plc.Write("DB7.DBX0.0", true);
```

### 4) node-red-contrib-s7

添加 `s7 in` / `s7 out` 节点，地址填 `DB5,REAL0`、`DB7,X0.0`，端口填 1102（或 102）。

> 如果你的客户端没有"端口"参数（默认只能连 102），请用 `sudo` 启动服务端监听 102。

---

## 六、配置说明（config/default.json）

```json
{
  "port": 102,
  "host": "0.0.0.0",
  "pduSize": 480,
  "merkersSize": 256,
  "inputsSize": 128,
  "outputsSize": 128,
  "dbs": [
    {
      "number": 5,
      "size": 1024,
      "name": "DB5_ProcessData",
      "init": { "REAL0": 0.0, "INT8": 0, "X16.0": false, "STRING20": "..." }
    }
  ],
  "simulation": { "enabled": false, "intervalMs": 1000 }
}
```

- `init` 的键支持：`X<字节>.<位>`、`B<偏移>`（BYTE）、`WORD`、`INT`、`DWORD`、`DINT`、`REAL`、`STR<偏移>`
- **加一个新的 DB（例如 DB8，100 字节）**：在 `dbs` 数组里追加一项即可，重启后生效

```json
{ "number": 8, "size": 100, "name": "DB8_Extra", "init": { "REAL0": 0 } }
```

- `writeAckItemSize`（可选，默认 `1`）：写响应中每个数据项的字节数。标准写响应每项只有 1 字节返回码，`nodes7`/`snap7` 均按此解析；若你的客户端（例如部分 C# 实现）按 4 字节（返回码+传输尺寸+长度）解析导致"写值失败"，改成 `4` 即可
- `autoCreateDb`（可选，默认 `false`）：访问未在 `dbs` 中定义的 DB 时自动创建，避免报 `0x0A`
- `autoCreateDbSize`（可选，默认 `1024`）：自动创建的 DB 大小
- `persistence`：数据持久化（断电保持）
  ```json
  "persistence": { "enabled": true, "file": "data/state.json", "debounceMs": 300 }
  ```
  `file` 为数据文件路径（相对启动目录），`debounceMs` 为写入后落盘的防抖时间

### 心跳 / 读值运算写回逻辑（logic）

`logic` 数组用来实现"**客户端写某个地址 → 服务端读它的当前值做运算 → 写到另一个地址**"，
相当于 PLC 程序里的 MOVE / ADD 指令。默认内置两条心跳：

- 客户端写 `DB6.INT372 = N` → 服务端读该值 +1 → 写入 `DB5.INT356 = N + 1`
- 客户端写 `DB6.INT374 = N` → 服务端读该值 +1 → 写入 `DB5.INT358 = N + 1`

```json
"logic": [
  {
    "name": "心跳1：写 DB6.INT372 → DB5.INT356 = 该值 + 1",
    "on":  { "db": 6, "offset": 372, "type": "INT" },
    "do":  { "db": 5, "offset": 356, "type": "INT", "op": "copyadd", "step": 1 },
    "trigger": "write"
  },
  {
    "name": "心跳2：写 DB6.INT374 → DB5.INT358 = 该值 + 1",
    "on":  { "db": 6, "offset": 374, "type": "INT" },
    "do":  { "db": 5, "offset": 358, "type": "INT", "op": "copyadd", "step": 1 },
    "trigger": "write"
  }
]
```

| 字段 | 说明 |
| --- | --- |
| `on.db` / `on.offset` / `on.type` | **触发地址**：客户端写到这个地址就执行规则 |
| `do.db` / `do.offset` / `do.type` | **目标地址**：运算结果写到这里 |
| `do.op` | 动作，见下表 |
| `do.step` | 步长，默认 `1` |
| `trigger` | `write`（默认）每次写入都执行；`change` 仅值变化时执行 |

| `do.op` | 含义 |
| --- | --- |
| `copyadd` | **目标 = 源地址当前值 + step**（默认，即"读这个值 +1 写过去"） |
| `copy` | 目标 = 源地址当前值 |
| `inc` | 目标 = 目标当前值 + step（目标自己累加，适合"写一次 +1"） |
| `dec` | 目标 = 目标当前值 - step |
| `add` | 目标 = 目标当前值 + step |
| `set` | 目标 = 固定值 `value` |

支持的数据类型：`BYTE`、`WORD`、`INT`、`DWORD`、`DINT`、`REAL`。
INT / WORD 溢出按 PLC 规则回绕（如 32767 + 1 → -32768）。

**行为说明**

- `trigger: "write"`：客户端每写一次就刷新一次目标值（`copyadd` 结果幂等，重复写同值不会累加）
- `trigger: "change"`：只有源值真正变化才执行
- 支持客户端**一次性写一大块**（如写 `DB6.DBB360~379`）：只要写入区间覆盖触发地址就会执行
- 一次报文里写多个心跳地址：每条规则各自执行
- 规则写目标也走同一写入通道，可做链式规则；内置最大递归深度（默认 4）防止死循环

服务端日志示例：

```
[LOGIC] 写 DB6.INT372 (0 → 5)     ⇒  DB5.INT356: 0 → 6
[LOGIC] 写 DB6.INT372 (5 → 100)   ⇒  DB5.INT356: 6 → 101
[LOGIC] 写 DB6.INT372 (写入 100)  ⇒  DB5.INT356: 101 → 101   ← 重复写同值，幂等
[LOGIC] 写 DB6.INT372 (100 → -1)  ⇒  DB5.INT356: 101 → 0
```

> 若要"服务端自己每次 +1 累加"（而不是等于源值+1），把 `"op": "copyadd"` 改成 `"op": "inc"`；
> 若要一次加 10，改 `"step": 10`。

---

## 七、断电保持（重启不重置数据）

服务端默认**开启持久化**：任何区域的写入都会在 300ms 内落盘到 `data/state.json`，
进程退出（Ctrl+C / SIGTERM）时再强制保存一次。启动时自动恢复到内存，因此重启后数据不会重置。

```
03:21:26.006 [INFO ] 已恢复运行数据：/opt/s7-1200-sim/data/state.json，保存于 2026-11-11T03:21:21.116Z
03:21:26.006 [INFO ]   数据块: DB5, DB6, DB7
```

| 场景 | 命令 |
| --- | --- |
| 正常启动（保持上次数据） | `node src/index.js --port 102` |
| 清空保持数据、回到配置初始值 | `node src/index.js --port 102 --reset` |
| 本次运行不保存（每次都是初始值） | `node src/index.js --port 102 --no-persist` |
| 想彻底不要持久化 | 配置里设 `"persistence": { "enabled": false }` |

说明：

- 保存内容包括 **DB / M / I / Q** 全部区域，以及逻辑规则算出的值（如 `DB5.INT356`）
- 文件是 JSON + 十六进制字符串，可读也可手工编辑，例如：
  ```json
  { "version": 1, "savedAt": "2026-11-11T03:21:21.116Z",
    "dbs": { "5": { "size": 1024, "name": "DB5_ProcessData", "data": "41480000..." } },
    "merkers": "0000...", "inputs": "...", "outputs": "..." }
  ```
- 若之后把某个 DB 的 `size` 改大/改小，已有数据按较小长度保留，不会报错
- 通过 `autoCreateDb` 自动创建的 DB 也会被保存，重启后自动重建

## 八、测试

```bash
npm install                 # 仅为安装测试用的 nodes7 客户端
node src/index.js --port 1102 &

# 端到端读写测试（nodes7 真实客户端）
node test/client-demo.js 1102

# 协议级测试（自建报文，校验握手/位读/越界/多项读）
node test/raw-proto-test.js 1102

# 批量读取测试（12 个分散地址一次性读取，校验不丢项/不截断）
node test/bulk-read-test.js 1102

# 心跳逻辑测试（写源值 → 服务端读值+1 写入目标）
node test/logic-test.js 1102

# 持久化测试（重启保持 / --reset / --no-persist）
node test/persist-test.js
```

实测结果：

```
【读取初始值】 { db5_real0: 0, db6_real0: 25, db6_int8: 100, db7_bit00: false, ... }
【写入】DB5.REAL0=12.34 / DB6.INT8=-5 / DB7.X0.0=true
【写后回读】{ db5_real0: 12.34, db6_int8: -5, db7_bit00: true, ... }
🎉 全部通过：模拟服务端读写正常

协议级自测：🎉 通过 9/9
```

---

## 九、与真实 PLC 的对应关系

| 项目 | 真实 S7-1200 设置 | 本模拟器 |
| --- | --- | --- |
| 访问方式 | TIA 中勾选 CPU → 防护与安全 → **允许来自远程伙伴的 PUT/GET 通信访问** | 无需设置，天然支持 |
| 数据块 | 被第三方读写的 DB 必须**关闭"优化的块访问"**（否则无绝对地址） | 所有 DB 均为绝对地址 |
| 机架/插槽 | Rack 0 / Slot 1（S7-1200/1500） | 任意 TSAP 均接受 |
| 端口 | 102 | 102（可用 `--port` 改） |
| PDU | 240~960 协商 | 默认上限 480 |

---

## 十、局限性

- 只实现 **S7comm 经典协议**（即 PUT/GET 通道），**不支持** S7comm-Plus（优化访问、符号寻址）
- 不支持块上传/下载（`0x1A~0x1F`）、PLC 启停（`0x28`）、诊断缓冲区等，这类请求会返回错误码
- SZL 读取（模块/CPU 标识）只提供基础返回，用于部分客户端的 `GetCpuInfo`
- 定时器 T / 计数器 C 区未实现（返回"对象不存在"）
- 仅用于开发调试与联调，请勿用于生产环境

---

## 十一、常见问题

**客户端连不上？**
1. 确认端口一致（客户端默认 102）
2. 客户端机架/插槽填 `0 / 1`
3. 用 `--verbose` 看是否有 COTP 连接日志；没有就是网络/端口问题

**读出来是 BAD / 0x0A？**
DB 号没在配置里定义 —— 日志会写明 `ERR:0x0a(DB8 未定义)`。

**日志里出现 `ERR:0x05(越界，需要 xxxB，当前长度 yyyB)`？**
说明客户端访问的地址超出了数据块长度。真实项目里 DB 往往有几百甚至几千字节，
把 `config/default.json` 里对应 DB 的 `size` 调大即可（S7-1200 单个 DB 最大可达 16 KB 以上），
例如客户端读到 `DB5.DBB350`，就把 DB5 的 `size` 设为不小于 `350 + 数据长度`：

```json
{ "number": 5, "size": 4096, "name": "DB5_ProcessData", "init": { ... } }
```

默认已给出 DB5/DB6 = 1024 字节、DB7 = 512 字节、M 区 1024 字节，一般够用。

**写值失败 / 心跳写入一直失败？**
按顺序检查服务端日志（每条写请求都会打印目标地址、写入值、返回码和原因）：

| 服务端日志 | 原因 | 处理 |
| --- | --- | --- |
| `ERR:0x0a(DB9 未定义（请在 config 中添加）)` | 客户端写了一个配置里没有的 DB | 在 `dbs` 里添加该 DB，或设 `"autoCreateDb": true` |
| `ERR:0x05(越界，写 1022~1029B，DB 长度 1024B)` | 写入地址超出 DB 长度 | 把该 DB 的 `size` 调大 |
| 客户端报失败但服务端日志显示 `=OK` | 客户端按 4 字节解析写响应 | 设 `"writeAckItemSize": 4` |
| 服务端日志完全没有这条写请求 | 报文没到服务端（端口/连接/PDU 问题） | 加 `--dump --verbose` 看有没有 `>> PDU` 进来 |

最有效的办法是带参数重启服务端，然后抓一次写请求：

```bash
node src/index.js --port 102 --dump --verbose
```

它会同时打印收（`>>`）发（`<<`）的完整十六进制报文，例如：

```
>> PDU: 32 01 00 00 00 03 00 26 00 13 05 03 12 0a 10 02 00 04 00 05 84 00 00 00 ...
<< PDU: 32 03 00 00 00 03 00 02 00 03 00 00 05 03 ff ff ff
```

**为什么客户端一次请求里既有 OK 又有 0x05？**
客户端（如 Snap7/nodes7）会把相邻变量合并成一个块读取，只有当块尾超出 DB 长度时才整块失败，
所以按上一条把 `size` 调大就能全部 OK。

**写 BOOL 不生效？**
BOOL 地址要带位号：`DB7,X0.0`；写字节用 `DB7,DBB0` 等价形式 `MB0`。

---

MIT License
