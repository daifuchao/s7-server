'use strict';

/**
 * TPKT (RFC 1006) 报文封装 / 拆包。
 *
 * 结构：
 *   0x03 | 0x00 | Length(2, 大端, 含 4 字节头) | COTP 数据
 */

const TPKT_HEADER_LEN = 4;

/** 把 COTP 数据封装成 TPKT 帧 */
function encodeTpkt(payload) {
  const buf = Buffer.alloc(TPKT_HEADER_LEN + payload.length);
  buf[0] = 0x03;
  buf[1] = 0x00;
  buf.writeUInt16BE(TPKT_HEADER_LEN + payload.length, 2);
  payload.copy(buf, TPKT_HEADER_LEN);
  return buf;
}

/**
 * 增量解析器：TCP 是流式的，一次 data 事件可能是半个帧，也可能是多个帧。
 */
class TpktParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  /**
   * 喂入一段 TCP 数据
   * @param {Buffer} chunk
   * @returns {Buffer[]} 完整的 COTP 数据片段（已去掉 4 字节 TPKT 头）
   */
  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const frames = [];

    while (this.buffer.length >= TPKT_HEADER_LEN) {
      if (this.buffer[0] !== 0x03) {
        // 不是 TPKT v3，丢弃首字节重新同步
        this.buffer = this.buffer.subarray(1);
        continue;
      }
      const total = this.buffer.readUInt16BE(2);
      if (total <= TPKT_HEADER_LEN) {
        this.buffer = this.buffer.subarray(TPKT_HEADER_LEN);
        continue;
      }
      if (this.buffer.length < total) break; // 等待剩余数据

      frames.push(this.buffer.subarray(TPKT_HEADER_LEN, total));
      this.buffer = this.buffer.subarray(total);
    }

    return frames;
  }
}

module.exports = { encodeTpkt, TpktParser, TPKT_HEADER_LEN };
