'use strict';

/**
 * 逻辑规则引擎：模拟 PLC 程序里的"读值 → 运算 → 写回"
 *
 * 典型用途——心跳/握手：
 *   客户端写 DB6.INT372 = N
 *   → 服务端读该地址当前值 N，+1 后写入 DB5.INT356（= N+1）
 *
 * 规则配置（config/default.json 的 logic 数组）：
 *   {
 *     "name": "说明文字",
 *     "on":  { "db": 6, "offset": 372, "type": "INT" },                       // 触发的地址（写它就会执行）
 *     "do":  { "db": 5, "offset": 356, "type": "INT", "op": "copyadd", "step": 1 },  // 读源值 +1 写入目标
 *     "trigger": "write"                                                       // write=每次写入都执行；change=仅值变化时执行
 *   }
 *
 * op 支持：
 *   copyadd  目标 = 源地址当前值 + step   （"读这个值 +1 写过去"）
 *   copy     目标 = 源地址当前值
 *   inc      目标 = 目标当前值 + step     （自增计数）
 *   dec      目标 = 目标当前值 - step
 *   add      目标 = 目标当前值 + step
 *   set      目标 = 固定值 value
 */

/** 支持的数据类型定义：长度、读数、编码、加法回绕 */
const TYPES = {
  BYTE: {
    size: 1,
    read: (b, o) => b.readUInt8(o),
    encode: (v) => Buffer.from([v & 0xff]),
    add: (v, d) => wrap(v, 256),
  },
  WORD: {
    size: 2,
    read: (b, o) => b.readUInt16BE(o),
    encode: (v) => {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(v & 0xffff);
      return b;
    },
    add: (v, d) => wrap(v + d, 65536),
  },
  INT: {
    size: 2,
    read: (b, o) => b.readInt16BE(o),
    encode: (v) => {
      const b = Buffer.alloc(2);
      b.writeInt16BE(v);
      return b;
    },
    add: (v, d) => wrapSigned(v + d, 65536),
  },
  DWORD: {
    size: 4,
    read: (b, o) => b.readUInt32BE(o),
    encode: (v) => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(v >>> 0);
      return b;
    },
    add: (v, d) => wrap(v + d, 4294967296),
  },
  DINT: {
    size: 4,
    read: (b, o) => b.readInt32BE(o),
    encode: (v) => {
      const b = Buffer.alloc(4);
      b.writeInt32BE(v);
      return b;
    },
    add: (v, d) => wrapSigned(v + d, 4294967296),
  },
  REAL: {
    size: 4,
    read: (b, o) => b.readFloatBE(o),
    encode: (v) => {
      const b = Buffer.alloc(4);
      b.writeFloatBE(Number(v));
      return b;
    },
    add: (v, d) => Number((v + d).toFixed(6)),
  },
};

/** 无符号回绕（与 PLC 的 16/32 位加法一致） */
function wrap(v, mod) {
  return ((v % mod) + mod) % mod;
}

/** 有符号回绕 */
function wrapSigned(v, mod) {
  return wrap(v + mod / 2, mod) - mod / 2;
}

class LogicEngine {
  /**
   * @param {import('./dataStore').DataStore} store
   * @param {{rules?: Array, logger?: any, maxDepth?: number}} options
   */
  constructor(store, options = {}) {
    this.store = store;
    this.logger = options.logger || console;
    this.maxDepth = options.maxDepth || 4;
    this.depth = 0;
    this.rules = [];
    this.stats = new Map(); // 规则名 → 触发次数
    this.handler = (e) => this.onChange(e);

    for (const raw of options.rules || []) {
      const rule = this.normalizeRule(raw);
      if (rule) this.rules.push(rule);
    }
  }

  normalizeRule(raw) {
    if (!raw || !raw.on || !raw.do) {
      this.logger.warn(`忽略无效逻辑规则: ${JSON.stringify(raw)}`);
      return null;
    }
    const srcType = String(raw.on.type || 'INT').toUpperCase();
    const dstType = String(raw.do.type || 'INT').toUpperCase();
    const dstOp = String(raw.do.op || 'inc').toLowerCase();
    const trigger = String(raw.trigger || 'write').toLowerCase(); // write | change

    if (!TYPES[srcType] || !TYPES[dstType]) {
      this.logger.warn(`忽略逻辑规则（不支持的数据类型）: ${JSON.stringify(raw)}`);
      return null;
    }
    if (!['inc', 'dec', 'add', 'set', 'copy', 'copyadd'].includes(dstOp)) {
      this.logger.warn(`忽略逻辑规则（不支持的动作 ${dstOp}）: ${JSON.stringify(raw)}`);
      return null;
    }

    const rule = {
      name: raw.name || `DB${raw.on.db}.${srcType}${raw.on.offset} → DB${raw.do.db}.${dstType}${raw.do.offset}`,
      on: { db: Number(raw.on.db), offset: Number(raw.on.offset), type: srcType, size: TYPES[srcType].size },
      do: {
        db: Number(raw.do.db),
        offset: Number(raw.do.offset),
        type: dstType,
        op: dstOp,
        step: raw.do.step === undefined ? 1 : Number(raw.do.step),
        value: raw.do.value,
      },
      trigger: trigger === 'change' ? 'change' : 'write',
      last: undefined,
      fires: 0,
    };

    // 校验地址是否在 DB 范围内
    const srcBuf = this.store.getArea('DB', rule.on.db);
    const dstBuf = this.store.getArea('DB', rule.do.db);
    if (!srcBuf || rule.on.offset + rule.on.size > srcBuf.length) {
      this.logger.warn(`忽略逻辑规则（源地址超出 DB${rule.on.db} 长度 ${srcBuf ? srcBuf.length : 0}）: ${rule.name}`);
      return null;
    }
    if (!dstBuf || rule.do.offset + TYPES[dstType].size > dstBuf.length) {
      this.logger.warn(`忽略逻辑规则（目标地址超出 DB${rule.do.db} 长度 ${dstBuf ? dstBuf.length : 0}）: ${rule.name}`);
      return null;
    }
    return rule;
  }

  /** 挂载到数据区变化事件上 */
  start() {
    if (!this.rules.length) return;
    this.store.on('write', this.handler);
    for (const rule of this.rules) {
      rule.last = this.readSource(rule);
      this.stats.set(rule.name, 0);
    }
    this.logger.info(`已加载 ${this.rules.length} 条逻辑规则（值变化 → 计数）:`);
    for (const rule of this.rules) {
      const opText =
        rule.do.op === 'inc'
          ? `自增 ${rule.do.step}`
          : rule.do.op === 'dec'
          ? `自减 ${rule.do.step}`
          : rule.do.op === 'add'
          ? `加 ${rule.do.step}`
          : rule.do.op === 'set'
          ? `设为 ${rule.do.value}`
          : rule.do.op === 'copyadd'
          ? `源值 +${rule.do.step}`
          : '复制源值';
      this.logger.info(
        `  · ${rule.name}  [当前值 ${rule.last}] → DB${rule.do.db}.${rule.do.type}${rule.do.offset} ${opText}`,
      );
    }
  }

  stop() {
    this.store.off('write', this.handler);
  }

  readSource(rule) {
    const buf = this.store.getArea('DB', rule.on.db);
    if (!buf) return undefined;
    return TYPES[rule.on.type].read(buf, rule.on.offset);
  }

  /** 数据区发生变化 → 检查是否有规则被触发 */
  onChange(event) {
    if (event.area !== 'DB') return;
    if (this.depth >= this.maxDepth) return; // 防止规则互相触发导致死循环

    for (const rule of this.rules) {
      if (rule.on.db !== event.dbNumber) continue;
      // 判断变化区间与规则监听的地址是否重叠（支持客户端一次性写一大块）
      const start = rule.on.offset;
      const end = rule.on.offset + rule.on.size;
      if (event.offset + event.length <= start || event.offset >= end) continue;

      const current = this.readSource(rule);
      if (current === undefined) continue;

      const previous = rule.last;
      const changed = current !== previous;
      rule.last = current;

      // trigger=change 时只在值真正变化时执行；trigger=write 时每次写入都执行
      if (rule.trigger === 'change' && !changed) continue;

      rule.fires += 1;
      this.stats.set(rule.name, rule.fires);
      this.execute(rule, previous, current, changed);
    }
  }

  /** 执行动作 */
  execute(rule, previous, current, changed) {
    const buffer = this.store.getArea('DB', rule.do.db);
    const type = TYPES[rule.do.type];
    const oldValue = type.read(buffer, rule.do.offset);

    let newValue;
    switch (rule.do.op) {
      // inc/dec/add 都以"目标地址当前的读值"为基准运算（读-改-写）
      case 'inc':
        newValue = type.add(oldValue, Math.abs(rule.do.step));
        break;
      case 'dec':
        newValue = type.add(oldValue, -Math.abs(rule.do.step));
        break;
      case 'add':
        newValue = type.add(oldValue, rule.do.step);
        break;
      // copyadd 以"源地址当前的读值"为基准 + step
      case 'copyadd':
        newValue = type.add(current, rule.do.step);
        break;
      case 'set':
        newValue = Number(rule.do.value);
        break;
      case 'copy':
        newValue = current;
        break;
      default:
        return;
    }

    this.depth += 1;
    let result;
    try {
      result = this.store.writeAt('DB', rule.do.db, rule.do.offset, type.encode(newValue));
    } finally {
      this.depth -= 1;
    }

    const dst = `DB${rule.do.db}.${rule.do.type}${rule.do.offset}`;
    if (!result.ok) {
      this.logger.warn(`[LOGIC] 动作写入失败(${result.reason}): ${dst}`);
      return;
    }
    const srcDesc = changed ? `${previous} → ${current}` : `写入 ${current}`;
    this.logger.info(
      `[LOGIC] 写 DB${rule.on.db}.${rule.on.type}${rule.on.offset} (${srcDesc})  ⇒  ${dst}: ${oldValue} → ${newValue}`,
    );
  }
}

module.exports = { LogicEngine, TYPES };
