'use strict';

/**
 * S7comm 协议处理（经典 S7 协议，即 S7-1200/1500 打开 PUT/GET 后使用的协议）
 *
 * Job PDU 结构:
 *   0x32 | ROSCTR | RedundancyID(2) | PDU-Reference(2) | ParamLen(2) | DataLen(2) | Param | Data
 *
 * 支持的功能：
 *   0xF0 Setup Communication
 *   0x04 Read Var
 *   0x05 Write Var
 *   0x07 UserData（SZL 读取，可返回模块/CPU 标识，可选）
 */

const PROTOCOL_ID = 0x32;

const ROSCTR = {
  JOB: 0x01,
  ACK: 0x02,
  ACK_DATA: 0x03,
  USERDATA: 0x07,
};

/** 区域代码 → 内部名称 */
const AREA_NAMES = {
  0x81: 'PE', // 输入 I
  0x82: 'PA', // 输出 Q
  0x83: 'MK', // 位存储 M
  0x84: 'DB', // 数据块
  0x1c: 'CT', // 计数器
  0x1d: 'TM', // 定时器
};

const AREA_LETTER = { PE: 'I', PA: 'Q', MK: 'M', DB: 'DB', CT: 'C', TM: 'T' };

/** S7ANY 传输尺寸 → 每个元素占用的位数 */
const TRANSPORT = {
  0x01: { name: 'BIT', bits: 1, code: 'X' },
  0x02: { name: 'BYTE', bits: 8, code: 'B' },
  0x03: { name: 'CHAR', bits: 8, code: 'B' },
  0x04: { name: 'WORD', bits: 16, code: 'W' },
  0x05: { name: 'INT', bits: 16, code: 'INT' },
  0x06: { name: 'DWORD', bits: 32, code: 'DW' },
  0x07: { name: 'DINT', bits: 32, code: 'DINT' },
  0x08: { name: 'REAL', bits: 32, code: 'REAL' },
  0x09: { name: 'DATE', bits: 16, code: 'W' },
  0x0a: { name: 'TOD', bits: 32, code: 'DW' },
  0x0b: { name: 'TIME', bits: 32, code: 'DINT' },
  0x0c: { name: 'S5TIME', bits: 16, code: 'W' },
  0x0f: { name: 'DT', bits: 64, code: 'B' },
};

/** 数据项返回码 */
const RC = {
  OK: 0xff,
  HARDWARE_FAULT: 0x01,
  ACCESS_NOT_ALLOWED: 0x03,
  INVALID_ADDRESS: 0x05,
  TYPE_NOT_SUPPORTED: 0x06,
  TYPE_INCONSISTENT: 0x07,
  OBJECT_NOT_EXIST: 0x0a,
};

/** 响应数据项的传输尺寸 */
const DATA_TRANSPORT = {
  BIT: 0x03,
  BYTE: 0x04,
};

class S7CommHandler {
  /**
   * @param {import('./dataStore').DataStore} store
   * @param {{pduSize?:number, logger?:any, tag?:string}} options
   */
  constructor(store, options = {}) {
    this.store = store;
    this.logger = options.logger || console;
    this.maxPduSize = options.pduSize || 960;
    this.pduSize = 240;
    this.tag = options.tag || '[s7]';
    this.writeAckItemSize = options.writeAckItemSize || 1; // 写响应每项 1 字节返回码（与 nodes7 / snap7 解析方式一致）
    this.stats = { reads: 0, writes: 0 };
  }

  /** 处理一个完整的 S7 PDU，返回响应 PDU（Buffer）或 null */
  handle(pdu) {
    if (!Buffer.isBuffer(pdu) || pdu.length < 10 || pdu[0] !== PROTOCOL_ID) return null;
    if (process.env.S7_DUMP === '1') {
      console.log(`  >> ${this.tag} PDU: ${pdu.toString('hex').replace(/(.{2})/g, '$1 ')}`);
    }

    const pduRef = pdu.readUInt16BE(4); 
    try {
      const response = this.dispatch(pdu, pduRef); 
      if (process.env.S7_DUMP === '1' && response) {
        console.log(`  << ${this.tag} PDU: ${response.toString('hex').replace(/(.{2})/g, '$1 ')}`);
      }
      return response;
    } catch (err) {
      // 关键：无论内部发生什么异常，都必须回一个响应，否则客户端会一直超时重试
      this.logger.error(`${this.tag} 处理报文异常: ${err.message}`);
      if (this.logger.verbose) console.error(err);
      return this.buildAckData(pduRef, Buffer.alloc(0), Buffer.alloc(0), 0x81, 0x04);
    }
  }

  dispatch(pdu, pduRef) {
    const rosctr = pdu[1];
    const paramLen = pdu.readUInt16BE(6);
    const dataLen = pdu.readUInt16BE(8);
    const paramEnd = Math.min(10 + paramLen, pdu.length);
    const param = pdu.subarray(10, paramEnd);
    const data = pdu.subarray(paramEnd, Math.min(paramEnd + dataLen, pdu.length));

    if (rosctr === ROSCTR.USERDATA) return this.handleUserData(pduRef, param, data);
    if (rosctr !== ROSCTR.JOB) {
      this.logger.debug(`${this.tag} 忽略非 Job 报文 ROSCTR=0x${rosctr.toString(16)}`);
      return null;
    }
    if (param.length === 0) return this.buildAckData(pduRef, Buffer.alloc(0), Buffer.alloc(0), 0x81, 0x04);

    switch (param[0]) {
      case 0xf0:
        return this.handleSetupCommunication(pduRef, param);
      case 0x04:
        return this.handleReadVar(pduRef, param);
      case 0x05:
        return this.handleWriteVar(pduRef, param, data);
      default:
        this.logger.warn(`${this.tag} 不支持的功能码 0x${param[0].toString(16).padStart(2, '0')}`);
        return this.buildAckData(pduRef, Buffer.from([param[0]]), Buffer.alloc(0), 0x81, 0x04);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 报文构造                                                            */
  /* ------------------------------------------------------------------ */

  buildAckData(pduRef, param, data, errClass = 0x00, errCode = 0x00) {
    const header = Buffer.alloc(12);
    header[0] = PROTOCOL_ID;
    header[1] = ROSCTR.ACK_DATA;
    header.writeUInt16BE(0x0000, 2);
    header.writeUInt16BE(pduRef, 4);
    header.writeUInt16BE(param.length, 6);
    header.writeUInt16BE(data.length, 8);
    header[10] = errClass;
    header[11] = errCode;
    return Buffer.concat([header, param, data]);
  }

  /* ------------------------------------------------------------------ */
  /* 0xF0 Setup Communication                                            */
  /* ------------------------------------------------------------------ */

  handleSetupCommunication(pduRef, param) {
    const maxAmqCaller = param.length >= 4 ? param.readUInt16BE(2) : 1;
    const maxAmqCallee = param.length >= 6 ? param.readUInt16BE(4) : 1;
    const requested = param.length >= 8 ? param.readUInt16BE(6) : 240;

    let pduSize = Math.min(requested || 240, this.maxPduSize);
    if (pduSize < 240) pduSize = 240; // 最小 240，和真实 CPU 行为一致
    this.pduSize = pduSize;

    const resParam = Buffer.alloc(8);
    resParam[0] = 0xf0;
    resParam[1] = 0x00;
    resParam.writeUInt16BE(Math.min(maxAmqCaller || 1, 8), 2);
    resParam.writeUInt16BE(Math.min(maxAmqCallee || 1, 8), 4);
    resParam.writeUInt16BE(pduSize, 6);

    this.logger.info(`${this.tag} 通信建立完成，协商 PDU 长度 = ${pduSize} 字节`);
    return this.buildAckData(pduRef, resParam, Buffer.alloc(0));
  }

  /* ------------------------------------------------------------------ */
  /* 0x04 Read Var                                                       */
  /* ------------------------------------------------------------------ */

  handleReadVar(pduRef, param) {
    const count = param.length > 1 ? param[1] : 0;
    const items = [];
    for (let i = 0; i < count; i++) {
      const offset = 2 + i * 12;
      if (offset + 12 > param.length) break;
      items.push(this.parseVarSpec(param, offset));
    }
    // 变量说明不足时补错误项，保证返回项数与请求项数一致（客户端解析不会错位）
    while (items.length < count) items.push({ area: 0, transport: 0, count: 0, dbNumber: 0, address: 0, malformed: true });

    const resolved = items.map((item) =>
      item.malformed ? { code: RC.TYPE_INCONSISTENT, transport: 0, length: 0, payload: null, label: '?', reason: '变量说明不完整' } : this.readItem(item),
    );

    // 按协商的 PDU 长度裁剪（超出部分不返回，客户端会自行重试剩余项）
    const maxDataLen = Math.max(this.pduSize - 12 - 2, 0);
    let used = 0;
    let returned = 0;
    for (let i = 0; i < resolved.length; i++) {
      const r = resolved[i];
      const size = 4 + (r.payload ? r.payload.length + (r.payload.length % 2) : 0);
      if (returned > 0 && used + size > maxDataLen) break;
      used += size;
      returned += 1;
    }

    // 参数区：功能码 + 实际返回项数
    const resParam = Buffer.from([0x04, returned]);

    // 数据区：每项 = 返回码(1) | 传输尺寸(1) | 长度(2) | 数据 | [补齐]
    const chunks = [];
    for (let i = 0; i < returned; i++) {
      const r = resolved[i];
      const head = Buffer.alloc(4);
      head[0] = r.code;
      head[1] = r.transport;
      head.writeUInt16BE(r.length, 2);
      chunks.push(head);
      if (r.payload && r.payload.length) {
        chunks.push(r.payload);
        if (r.payload.length % 2 === 1) chunks.push(Buffer.from([0x00])); // 偶数字节对齐
      }
    }

    this.stats.reads += 1;
    const summary = resolved
      .slice(0, returned)
      .map((r) => `${r.label}=${r.code === RC.OK ? 'OK' : `ERR:0x${r.code.toString(16).padStart(2, '0')}${r.reason ? '(' + r.reason + ')' : ''}`}`)
      .join(', ');
    this.logger.read(`${this.tag} 读取 ${returned} 项: ${summary}`);

    return this.buildAckData(pduRef, resParam, Buffer.concat(chunks));
  }

  /** 解析 12 字节 S7ANY 变量说明 */
  parseVarSpec(param, offset) {
    return {
      specType: param[offset], // 0x12
      specLen: param[offset + 1], // 0x0A
      syntaxId: param[offset + 2], // 0x10 = S7ANY
      transport: param[offset + 3],
      count: param.readUInt16BE(offset + 4),
      dbNumber: param.readUInt16BE(offset + 6),
      area: param[offset + 8],
      address: (param[offset + 9] << 16) | (param[offset + 10] << 8) | param[offset + 11],
    };
  }

  /**
   * 读出单个数据项
   *
   * 注意响应长度字段的语义（与真实 CPU 一致）：
   *   - 传输尺寸 0x03(BIT) / 0x04(BYTE,WORT,DWORD)：长度以"位"为单位
   *   - 传输尺寸 0x09(OCTET STRING)：长度以"字节"为单位
   */
  readItem(item) {
    const areaName = AREA_NAMES[item.area];
    const spec = TRANSPORT[item.transport];
    const label = this.describe(item);
    const fail = (code, reason) => ({ code, transport: 0x00, length: 0, payload: null, label, reason });

    if (!areaName) return fail(RC.OBJECT_NOT_EXIST, `未知区域 0x${item.area.toString(16)}`);
    if (!spec) return fail(RC.TYPE_NOT_SUPPORTED, `不支持的类型 0x${item.transport.toString(16)}`);

    const buffer = this.store.getArea(areaName, item.dbNumber);
    if (!buffer) {
      return fail(RC.OBJECT_NOT_EXIST, areaName === 'DB' ? `DB${item.dbNumber} 未定义` : `${areaName} 区未启用`);
    }

    // 位读取
    if (item.transport === 0x01) {
      const startBit = item.address;
      const bitCount = Math.max(item.count || 1, 1);
      const needBytes = Math.ceil(((startBit % 8) + bitCount) / 8);
      if ((startBit >> 3) + needBytes > buffer.length) {
        return fail(RC.INVALID_ADDRESS, `越界，${label} 超过长度 ${buffer.length}B`);
      }
      return {
        code: RC.OK,
        transport: DATA_TRANSPORT.BIT, // 0x03
        length: bitCount, // 位
        payload: extractBits(buffer, startBit, bitCount),
        label,
      };
    }

    // 字节 / 字 / 双字（客户端通常用 0x02 BYTE 形式请求）
    // 注意：S7ANY 中的地址始终是"位地址"，字节寻址需要 /8
    const startByte = item.address >> 3;

    if (item.transport === 0x09 || item.transport === 0x0f) {
      const byteCount = Math.ceil((item.count * spec.bits) / 8);
      if (byteCount <= 0 || startByte + byteCount > buffer.length) {
        return fail(RC.INVALID_ADDRESS, `越界，需要 ${startByte + byteCount}B，当前长度 ${buffer.length}B`);
      }
      return {
        code: RC.OK,
        transport: item.transport, // 原样回显 0x09 / 0x0f
        length: byteCount, // 字节
        payload: Buffer.from(buffer.subarray(startByte, startByte + byteCount)),
        label,
      };
    }

    const byteCount = Math.ceil((item.count * spec.bits) / 8);
    if (byteCount <= 0 || startByte + byteCount > buffer.length) {
      return fail(RC.INVALID_ADDRESS, `越界，需要 ${startByte + byteCount}B，当前长度 ${buffer.length}B`);
    }

    return {
      code: RC.OK,
      transport: DATA_TRANSPORT.BYTE, // 0x04
      length: byteCount * 8, // 位
      payload: Buffer.from(buffer.subarray(startByte, startByte + byteCount)),
      label,
    };
  }

  /* ------------------------------------------------------------------ */
  /* 0x05 Write Var                                                      */
  /* ------------------------------------------------------------------ */

  handleWriteVar(pduRef, param, data) {
    const count = param.length > 1 ? param[1] : 0;
    const items = [];
    let offset = 0;
    let malformed = false;

    for (let i = 0; i < count; i++) {
      const specOffset = 2 + i * 12;
      if (specOffset + 12 > param.length) {
        malformed = true;
        break;
      }
      const item = this.parseVarSpec(param, specOffset);

      // 数据项: 返回码(1) | 传输尺寸(1) | 长度(2) | 数据 | [补齐字节]
      if (offset + 4 > data.length) {
        malformed = true;
        break;
      }
      const transport = data[offset + 1];
      const length = data.readUInt16BE(offset + 2);
      offset += 4;

      // 长度字段容错：
      //   标准里 0x03/0x04 等传输尺寸的长度字段以"位"为单位，
      //   但有部分客户端按"字节"填写，这里做兼容。
      const spec = TRANSPORT[item.transport];
      const bitsPerElement = spec ? spec.bits : 8;
      const bySpec = Math.ceil(((item.count || 0) * bitsPerElement) / 8); // 按变量说明推算的字节数
      let byteLen = dataItemByteLength(transport, length);

      // 容错 1：length 恰好等于按变量说明推算的字节数 → 说明客户端按字节填写
      if (bySpec > 0 && byteLen !== bySpec && length === bySpec) {
        byteLen = length;
      }
      // 容错 2：按位解析超出实际数据长度 → 退化为按字节解析
      if (offset + byteLen > data.length && offset + length <= data.length) {
        byteLen = length;
      }
      const payload = Buffer.from(data.subarray(offset, offset + byteLen));
      offset += byteLen + (byteLen % 2); // 偶数字节对齐

      items.push({ ...item, writeTransport: transport, payload });
    }

    const results = items.map((item) => this.writeItem(item));

    // 请求项数 > 实际解析项数时补错误项，保证响应项数与请求一致
    const requested = count;
    while (results.length < requested) {
      results.push({ code: RC.TYPE_INCONSISTENT, reason: malformed ? '数据区长度不足/不完整' : '解析失败', hex: '' });
    }

    const resParam = Buffer.from([0x05, results.length]);
    const itemSize = this.writeAckItemSize;
    const resData = Buffer.alloc(results.length * itemSize);
    results.forEach((r, i) => {
      resData[i * itemSize] = r.code;
      if (itemSize >= 4) {
        resData[i * itemSize + 1] = 0x04;
        resData.writeUInt16BE(0, i * itemSize + 2);
      }
    });

    this.stats.writes += 1;
    const summary = items
      .map((item, i) => {
        const r = results[i];
        const status = r.code === RC.OK ? 'OK' : `ERR:0x${r.code.toString(16).padStart(2, '0')}${r.reason ? '(' + r.reason + ')' : ''}`;
        const val = item.payload && item.payload.length ? ` ← ${item.payload.toString('hex')}` : '';
        return `${this.describe(item)}=${status}${val}`;
      })
      .join(', ');
    this.logger.write(`${this.tag} 写入 ${results.length} 项: ${summary}`);

    return this.buildAckData(pduRef, resParam, resData);
  }

  /** 写入单个数据项，返回 {code, reason, hex} */
  writeItem(item) {
    const hex = item.payload ? item.payload.toString('hex') : '';
    const areaName = AREA_NAMES[item.area];
    if (!areaName) {
      return { code: RC.OBJECT_NOT_EXIST, reason: `未知区域 0x${item.area.toString(16)}`, hex };
    }

    const buffer = this.store.getArea(areaName, item.dbNumber);
    if (!buffer) {
      const why = areaName === 'DB' ? `DB${item.dbNumber} 未定义（请在 config 中添加）` : `${areaName} 区未启用`;
      return { code: RC.OBJECT_NOT_EXIST, reason: why, hex };
    }
    if (!item.payload || item.payload.length === 0) {
      return { code: RC.TYPE_INCONSISTENT, reason: '写入数据为空', hex };
    }

    const isBit = item.transport === 0x01 || item.writeTransport === 0x01;

    if (isBit) {
      const bitCount = Math.max(item.count || 1, 1);
      const res = this.store.writeBitAt(areaName, item.dbNumber, item.address, bitCount, item.payload);
      return res.ok ? { code: RC.OK, hex } : { code: RC.INVALID_ADDRESS, reason: `越界，DB 长度 ${buffer.length}B`, hex };
    }

    // 注意：S7ANY 中的地址始终是"位地址"，字节寻址需要 /8
    const startByte = item.address >> 3;
    const res = this.store.writeAt(areaName, item.dbNumber, startByte, item.payload);
    if (!res.ok) {
      return {
        code: RC.INVALID_ADDRESS,
        reason: `越界，写 ${startByte}~${startByte + item.payload.length - 1}B，DB 长度 ${buffer.length}B`,
        hex,
      };
    }
    return { code: RC.OK, hex };
  }

  /* ------------------------------------------------------------------ */
  /* 0x07 UserData（SZL：读取 CPU / 模块标识）                             */
  /* ------------------------------------------------------------------ */

  handleUserData(pduRef, param, data) {
    // 仅处理 SZL 请求：Param = 00 01 12 04 <SZL-ID:2> <Index:2>
    if (param.length >= 8 && param[0] === 0x00 && param[1] === 0x01 && param[2] === 0x12) {
      const szlId = param.readUInt16BE(4);
      const szlIndex = param.readUInt16BE(6);
      this.logger.debug(`${this.tag} SZL 请求 ID=0x${szlId.toString(16)} Index=${szlIndex}`);
      return this.buildSzlResponse(pduRef, szlId, szlIndex);
    }

    // 其它 UserData 请求：回错误
    const resParam = Buffer.from([0x00, 0x01, 0x12, 0x04, 0x12, 0x8a, 0x11, 0x00]);
    return this.buildAckData(pduRef, resParam, Buffer.from([0x0a, 0x00, 0x00, 0x00]), 0x81, 0x04);
  }

  buildSzlResponse(pduRef, szlId, szlIndex) {
    const records = buildSzlRecords(szlId, szlIndex);
    if (!records) return this.buildAckData(pduRef, Buffer.from([0x00, 0x01, 0x12, 0x08, 0x12, 0x8a, 0x11, 0x00]), Buffer.from([0x0a, 0x00, 0x00, 0x00]), 0x81, 0x04);

    const payload = Buffer.concat(records);
    const header = Buffer.alloc(8);
    header[0] = 0xff; // 返回码
    header[1] = 0x09; // 传输尺寸
    header.writeUInt16BE(payload.length + 4, 2); // 数据长度
    header.writeUInt16BE(szlId, 4);
    header.writeUInt16BE(szlIndex, 6);

    const resParam = Buffer.from([0x00, 0x01, 0x12, 0x08, 0x12, 0x8a, 0x11, 0x00]);
    return this.buildAckData(pduRef, resParam, Buffer.concat([header, payload]));
  }

  /* ------------------------------------------------------------------ */
  /* 工具                                                                */
  /* ------------------------------------------------------------------ */

  /** 生成可读地址，如 DB5.DBD0 / M10.3 */
  describe(item) {
    const areaName = AREA_NAMES[item.area] || `0x${item.area.toString(16)}`;
    const spec = TRANSPORT[item.transport];
    const startByte = item.address >> 3;
    if (item.transport === 0x01) {
      const bit = item.address & 7;
      return areaName === 'DB'
        ? `DB${item.dbNumber}.DBX${startByte}.${bit}`
        : `${AREA_LETTER[areaName] || areaName}${startByte}.${bit}`;
    }
    const code = spec ? spec.code : 'B';
    const byteCount = spec ? Math.ceil((item.count * spec.bits) / 8) : 0;
    return areaName === 'DB'
      ? `DB${item.dbNumber}.DB${code}${startByte}[${byteCount}]`
      : `${AREA_LETTER[areaName] || areaName}${code}${startByte}[${byteCount}]`;
  }
}

/* -------------------------------------------------------------------- */
/* 位操作辅助                                                             */
/* -------------------------------------------------------------------- */

/**
 * 计算写请求数据项的实际字节数
 *   - 0x03 BIT           : 长度单位为位
 *   - 0x04/0x02/0x05..   : 长度单位为位（byteLength * 8）
 *   - 0x09/0x0f          : 长度单位为字节
 */
function dataItemByteLength(transport, length) {
  if (transport === 0x03 || transport === 0x01) return Math.max(1, Math.ceil(length / 8));
  if (transport === 0x09 || transport === 0x0f) return length;
  return Math.ceil(length / 8);
}

function extractBits(buffer, startBit, bitCount) {
  const out = Buffer.alloc(Math.ceil(bitCount / 8));
  for (let i = 0; i < bitCount; i++) {
    const abs = startBit + i;
    const byte = abs >> 3;
    const bit = abs & 7;
    if (byte >= buffer.length) break;
    if ((buffer[byte] >> bit) & 1) out[i >> 3] |= 1 << (i & 7);
  }
  return out;
}

function writeBits(buffer, startBit, bitCount, payload) {
  for (let i = 0; i < bitCount; i++) {
    const value = (payload[i >> 3] >> (i & 7)) & 1;
    const abs = startBit + i;
    const byte = abs >> 3;
    const bit = abs & 7;
    if (byte >= buffer.length) return;
    if (value) buffer[byte] |= 1 << bit;
    else buffer[byte] &= ~(1 << bit);
  }
}

/* -------------------------------------------------------------------- */
/* SZL 记录构造                                                           */
/* -------------------------------------------------------------------- */

function szlString(text, len) {
  const buf = Buffer.alloc(len, 0x20);
  buf.write(text.slice(0, len), 0, 'latin1');
  return buf;
}

function buildSzlRecords(szlId, szlIndex) {
  // 0x0011: 模块标识；0x001C: 组件标识
  if (szlId === 0x0011 && szlIndex === 0x0001) {
    const record = Buffer.alloc(28);
    record.writeUInt16BE(0x0001, 0); // 索引
    szlString('6ES7 214-1AG40-0XB0', 20).copy(record, 2); // 订货号
    record[22] = 0x03; // 硬件版本
    record[23] = 0x03; // 固件版本
    record.writeUInt16BE(0x0401, 24); // V4.1
    return [record];
  }
  if (szlId === 0x001c && szlIndex === 0x0001) {
    const record = Buffer.alloc(34);
    record[0] = 0x01;
    szlString('6ES7 214-1AG40-0XB0', 20).copy(record, 1);
    szlString('CPU 1214C DC/DC/DC', 20).copy(record, 21);
    return [record];
  }
  return null;
}

module.exports = { S7CommHandler, TRANSPORT, AREA_NAMES, RC, ROSCTR };
