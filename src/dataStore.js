'use strict';

const { EventEmitter } = require('events');

/**
 * PLC 数据区存储
 *
 * 支持的区域（S7 地址区代码）：
 *   0x81  PE  输入区   I
 *   0x82  PA  输出区   Q
 *   0x83  MK  位存储区 M
 *   0x84  DB  数据块
 *
 * 所有写入都经过 writeAt / writeBitAt，从而能在"值真正发生变化"时
 * 发出 change 事件（逻辑规则引擎依赖它做值变化检测）。
 */

const AREA = {
  PE: 0x81,
  PA: 0x82,
  MK: 0x83,
  DB: 0x84,
  CT: 0x1c,
  TM: 0x1d,
};

/** 初始化值表达式：REAL0 / INT4 / DINT8 / WORD12 / BYTE16 / X20.0 / STR24 */
const INIT_RE = /^(REAL|DINT|DWORD|INT|WORD|BYTE|CHAR|STR|X)(\d+)(?:\.([0-7]))?$/i;

class DataStore extends EventEmitter {
  constructor(config = {}) {
    super();
    // 访问未定义的 DB 时是否自动创建（默认关闭；开启后任何 DB 都能读写，不会报 0x0A）
    this.autoCreateDb = config.autoCreateDb === true;
    this.autoCreateDbSize = config.autoCreateDbSize || 1024;
    this.logger = config.logger || null;
    /** @type {Map<number, {buffer: Buffer, size: number, name: string}>} */
    this.dbs = new Map();
    this.merkers = Buffer.alloc(config.merkersSize ?? 256);
    this.inputs = Buffer.alloc(config.inputsSize ?? 128);
    this.outputs = Buffer.alloc(config.outputsSize ?? 128);

    for (const db of config.dbs || []) {
      this.addDb(db.number, db.size, db.init, db.name);
    }
  }

  addDb(number, size, init, name = `DB${number}`) {
    if (!Number.isInteger(number) || number < 1 || number > 65535) {
      throw new Error(`非法的 DB 号: ${number}`);
    }
    if (!Number.isInteger(size) || size < 1) {
      throw new Error(`DB${number} 大小非法: ${size}`);
    }
    const buffer = Buffer.alloc(size);
    this.dbs.set(number, { buffer, size, name });
    if (init) this.applyInit(number, init);
    return buffer;
  }

  /** 按 "REAL0": 12.5 这样的键值初始化（与 nodes7 地址语法接近） */
  applyInit(dbNumber, init) {
    const db = this.dbs.get(dbNumber);
    if (!db) throw new Error(`DB${dbNumber} 不存在`);
    for (const [key, value] of Object.entries(init)) {
      const m = INIT_RE.exec(key.trim());
      if (!m) throw new Error(`无法解析初始化地址: ${key}`);
      const type = m[1].toUpperCase();
      const offset = Number(m[2]);
      const bit = m[3] ? Number(m[3]) : 0;
      const b = db.buffer;
      switch (type) {
        case 'X':
          setBit(b, offset * 8 + bit, Boolean(value));
          break;
        case 'BYTE':
          b.writeUInt8(Number(value) & 0xff, offset);
          break;
        case 'CHAR':
          b.writeInt8(Number(value), offset);
          break;
        case 'WORD':
          b.writeUInt16BE(Number(value) & 0xffff, offset);
          break;
        case 'INT':
          b.writeInt16BE(Number(value), offset);
          break;
        case 'DWORD':
          b.writeUInt32BE(Number(value) >>> 0, offset);
          break;
        case 'DINT':
          b.writeInt32BE(Number(value), offset);
          break;
        case 'REAL':
          b.writeFloatBE(Number(value), offset);
          break;
        case 'STR':
          b.write(String(value), offset, Math.min(String(value).length, b.length - offset), 'latin1');
          break;
        default:
          break;
      }
    }
  }

  /** 取得某个区域的 Buffer，不存在返回 null */
  getArea(areaName, dbNumber = 0) {
    switch (areaName) {
      case 'PE':
        return this.inputs;
      case 'PA':
        return this.outputs;
      case 'MK':
        return this.merkers;
      case 'DB': {
        const db = this.dbs.get(dbNumber);
        if (db) return db.buffer;
        if (!this.autoCreateDb) return null;
        // 自动创建：让未在配置中定义的 DB 也能正常读写
        const buffer = this.addDb(dbNumber, this.autoCreateDbSize, null, `DB${dbNumber} (自动创建)`);
        if (this.logger) {
          this.logger.info(`收到对未定义 DB${dbNumber} 的访问，已自动创建 ${this.autoCreateDbSize} 字节`);
        }
        return buffer;
      }
      default:
        return null;
    }
  }

  /**
   * 按字节写入并对"值是否真的变化"做检测
   * @returns {{ok: boolean, changed?: boolean, reason?: string}}
   */
  writeAt(areaName, dbNumber, byteOffset, payload) {
    const buffer = this.getArea(areaName, dbNumber);
    if (!buffer) return { ok: false, reason: 'area-not-found' };
    if (byteOffset < 0 || byteOffset + payload.length > buffer.length) {
      return { ok: false, reason: 'out-of-range' };
    }

    let changed = false;
    for (let i = 0; i < payload.length; i++) {
      if (buffer[byteOffset + i] !== payload[i]) {
        changed = true;
        break;
      }
    }
    payload.copy(buffer, byteOffset);

    const event = { area: areaName, dbNumber, offset: byteOffset, length: payload.length, changed };
    this.emit('write', event); // 每次写入都通知（逻辑规则按 trigger 自行过滤）
    if (changed) this.emit('change', event);
    return { ok: true, changed };
  }

  /**
   * 按位写入（BOOL）
   * @param {number} bitAddress 位地址（字节*8 + 位）
   */
  writeBitAt(areaName, dbNumber, bitAddress, bitCount, payload) {
    const buffer = this.getArea(areaName, dbNumber);
    if (!buffer) return { ok: false, reason: 'area-not-found' };

    const startByte = bitAddress >> 3;
    const needBytes = Math.ceil(((bitAddress % 8) + bitCount) / 8);
    if (startByte + needBytes > buffer.length) return { ok: false, reason: 'out-of-range' };

    const snapshot = buffer.subarray(startByte, startByte + needBytes).toString('hex');
    for (let i = 0; i < bitCount; i++) {
      const value = (payload[i >> 3] >> (i & 7)) & 1;
      const abs = bitAddress + i;
      const byte = abs >> 3;
      const bit = abs & 7;
      if (value) buffer[byte] |= 1 << bit;
      else buffer[byte] &= ~(1 << bit);
    }
    const after = buffer.subarray(startByte, startByte + needBytes).toString('hex');
    const changed = snapshot !== after;

    const event = { area: areaName, dbNumber, offset: startByte, length: needBytes, changed };
    this.emit('write', event);
    if (changed) this.emit('change', event);
    return { ok: true, changed };
  }

  /** 序列化所有数据区（持久化用） */
  serialize() {
    const dbs = {};
    for (const [number, db] of this.dbs) {
      dbs[number] = { size: db.size, name: db.name, data: db.buffer.toString('hex') };
    }
    return {
      version: 1,
      merkers: this.merkers.toString('hex'),
      inputs: this.inputs.toString('hex'),
      outputs: this.outputs.toString('hex'),
      dbs,
    };
  }

  /**
   * 从快照恢复数据区。
   * - 快照里存在但当前配置里没有的 DB（例如自动创建的 DB）会被建出来
   * - DB 长度变化时按较小长度拷贝，保留已有数据
   */
  restore(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;

    const copyInto = (target, hex) => {
      if (typeof hex !== 'string' || hex.length === 0) return;
      const src = Buffer.from(hex, 'hex');
      src.copy(target, 0, 0, Math.min(src.length, target.length));
    };

    for (const [numberStr, record] of Object.entries(snapshot.dbs || {})) {
      const number = Number(numberStr);
      if (!Number.isInteger(number) || number < 1) continue;
      const src = Buffer.from(record.data || '', 'hex');

      let db = this.dbs.get(number);
      if (!db) {
        const size = Math.max(record.size || 0, src.length, 1);
        this.addDb(number, size, null, record.name || `DB${number}`);
        db = this.dbs.get(number);
      }
      src.copy(db.buffer, 0, 0, Math.min(src.length, db.buffer.length));
    }

    copyInto(this.merkers, snapshot.merkers);
    copyInto(this.inputs, snapshot.inputs);
    copyInto(this.outputs, snapshot.outputs);
    return true;
  }

  /** 以可读形式列出所有 DB 概况 */
  describe() {
    return [...this.dbs.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([number, db]) => ({ number, name: db.name, size: db.size }));
  }

  /** 把内存按行打印成 hex（调试用） */
  dumpArea(areaName, dbNumber, length = 32) {
    const buf = this.getArea(areaName, dbNumber);
    if (!buf) return '';
    const n = Math.min(length, buf.length);
    return buf.subarray(0, n).toString('hex').replace(/(.{2})/g, '$1 ').trim();
  }
}

function setBit(buf, bitIndex, value) {
  const byte = bitIndex >> 3;
  const bit = bitIndex & 7;
  if (byte >= buf.length) return;
  if (value) buf[byte] |= 1 << bit;
  else buf[byte] &= ~(1 << bit);
}

module.exports = { DataStore, AREA, setBit };
