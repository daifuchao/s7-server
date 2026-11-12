'use strict';

/**
 * COTP (ISO 8073 Class 0) 连接管理
 *
 * - 0xE0 CR 连接请求（客户端 → 服务端）
 * - 0xD0 CC 连接确认（服务端 → 客户端）
 * - 0xF0 DT 数据传输
 * - 0x80 DR 断开请求 / 0xC0 DC 断开确认
 */

const COTP = {
  CR: 0xe0,
  CC: 0xd0,
  DR: 0x80,
  DC: 0xc0,
  DT: 0xf0,
};

/**
 * 解析 CR / DR 报文
 * 结构: LI | Code | DstRef(2) | SrcRef(2) | Class(1) | [参数...]
 */
function parseConnectionPacket(buf) {
  if (buf.length < 7) return null;
  const li = buf[0];
  const code = buf[1];
  const dstRef = buf.readUInt16BE(2);
  const srcRef = buf.readUInt16BE(4);
  const cls = buf[6];
  const params = {};

  // 参数区从第 7 字节开始，到 1 + LI 结束
  let offset = 7;
  const end = Math.min(1 + li, buf.length);
  while (offset + 2 <= end) {
    const code8 = buf[offset];
    const len = buf[offset + 1];
    const value = buf.subarray(offset + 2, offset + 2 + len);
    if (code8 === 0xc0 && len === 1) params.tpduSize = 1 << value[0]; // 0x0A => 1024
    if (code8 === 0xc1 && len === 2) params.srcTsap = value.readUInt16BE(0);
    if (code8 === 0xc2 && len === 2) params.dstTsap = value.readUInt16BE(0);
    offset += 2 + len;
  }

  return { li, code, dstRef, srcRef, cls, ...params };
}

/**
 * 构造 CC（连接确认）
 * @param {{clientRef:number, serverRef:number, srcTsap:number, dstTsap:number, tpduSizeCode?:number}} opt
 */
function buildConnectionConfirm({ clientRef, serverRef, srcTsap = 0x0100, dstTsap = 0x0301, tpduSizeCode = 0x0a }) {
  const params = Buffer.from([
    0xc0, 0x01, tpduSizeCode,
    0xc1, 0x02, (srcTsap >> 8) & 0xff, srcTsap & 0xff,
    0xc2, 0x02, (dstTsap >> 8) & 0xff, dstTsap & 0xff,
  ]);
  const buf = Buffer.alloc(7 + params.length);
  buf[0] = 6 + params.length; // LI = 总长度 - 1
  buf[1] = COTP.CC;
  buf.writeUInt16BE(clientRef, 2); // 目标引用 = 客户端源引用
  buf.writeUInt16BE(serverRef, 4); // 源引用 = 服务端自己的引用
  buf[6] = 0x00; // Class 0
  params.copy(buf, 7);
  return buf;
}

/** 构造 DT（数据传输）COTP 头，EOT=1 表示最后一个分片 */
function buildDataHeader(eot = true) {
  return Buffer.from([0x02, COTP.DT, eot ? 0x80 : 0x00]);
}

/** 构造 DC（断开确认） */
function buildDisconnectConfirm({ clientRef, serverRef }) {
  const buf = Buffer.alloc(7);
  buf[0] = 0x06;
  buf[1] = COTP.DC;
  buf.writeUInt16BE(clientRef, 2);
  buf.writeUInt16BE(serverRef, 4);
  buf[6] = 0x00;
  return buf;
}

module.exports = { COTP, parseConnectionPacket, buildConnectionConfirm, buildDataHeader, buildDisconnectConfirm };
