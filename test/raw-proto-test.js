'use strict';

/**
 * 协议级自测（不依赖任何第三方 S7 库）：直接构造 TPKT/COTP/S7comm 报文，
 * 校验服务端的 COTP 握手、通信协商、位读取、越界与不存在 DB 的错误码。
 *
 * 运行：node test/raw-proto-test.js [端口]
 */

const net = require('net');

const PORT = Number(process.argv[2] || process.env.S7_PORT || 1102);
const HOST = process.env.S7_HOST || '127.0.0.1';

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
}

function tpkt(payload) {
  const b = Buffer.alloc(4 + payload.length);
  b[0] = 0x03;
  b[1] = 0x00;
  b.writeUInt16BE(4 + payload.length, 2);
  payload.copy(b, 4);
  return b;
}

function cotpCr() {
  return Buffer.from([0x11, 0xe0, 0x00, 0x00, 0x00, 0x01, 0x00, 0xc0, 0x01, 0x0a, 0xc1, 0x02, 0x01, 0x00, 0xc2, 0x02, 0x03, 0x01]);
}

function s7Job(pduRef, param, data = Buffer.alloc(0)) {
  const h = Buffer.alloc(10);
  h[0] = 0x32;
  h[1] = 0x01;
  h.writeUInt16BE(0, 2);
  h.writeUInt16BE(pduRef, 4);
  h.writeUInt16BE(param.length, 6);
  h.writeUInt16BE(data.length, 8);
  return Buffer.concat([h, param, data]);
}

function dt(payload) {
  return Buffer.concat([Buffer.from([0x02, 0xf0, 0x80]), payload]);
}

function setupParam(pduSize = 480) {
  const p = Buffer.alloc(8);
  p[0] = 0xf0;
  p[1] = 0x00;
  p.writeUInt16BE(1, 2);
  p.writeUInt16BE(1, 4);
  p.writeUInt16BE(pduSize, 6);
  return p;
}

/** 生成 S7ANY 变量说明 */
function varSpec({ transport, count, db, area, addressBits }) {
  const b = Buffer.alloc(12);
  b[0] = 0x12;
  b[1] = 0x0a;
  b[2] = 0x10;
  b[3] = transport;
  b.writeUInt16BE(count, 4);
  b.writeUInt16BE(db, 6);
  b[8] = area;
  b[9] = (addressBits >> 16) & 0xff;
  b[10] = (addressBits >> 8) & 0xff;
  b[11] = addressBits & 0xff;
  return b;
}

function readParam(specs) {
  return Buffer.concat([Buffer.from([0x04, specs.length]), ...specs]);
}

class RawClient {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    socket.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      while (this.buf.length >= 4) {
        const total = this.buf.readUInt16BE(2);
        if (this.buf.length < total) break;
        const frame = this.buf.subarray(4, total);
        this.buf = this.buf.subarray(total);
        const w = this.waiters.shift();
        if (w) w(frame);
      }
    });
  }

  send(payload) {
    this.socket.write(tpkt(payload));
  }

  /** 发送并等待一帧响应，返回去掉 COTP DT 头后的 S7 PDU */
  request(payload, timeout = 3000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('响应超时')), timeout);
      this.waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame.subarray(3));
      });
      this.send(payload);
    });
  }

  /** 接收 COTP CC */
  waitCcotp(timeout = 3000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('COTP 响应超时')), timeout);
      this.waiters.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }
}

function parseReadResponse(pdu, itemCount) {
  // 头 12 字节 + 参数 2 字节，然后每项 4 字节描述 + 数据
  let ptr = 14;
  const items = [];
  for (let i = 0; i < itemCount; i++) {
    const rc = pdu[ptr];
    const transport = pdu[ptr + 1];
    const len = pdu.readUInt16BE(ptr + 2);
    const byteLen = transport === 0x03 ? Math.ceil(len / 8) : transport === 0x09 ? len : len / 8;
    const data = pdu.subarray(ptr + 4, ptr + 4 + byteLen);
    items.push({ rc, transport, len, data });
    ptr += 4 + byteLen + (byteLen % 2);
  }
  return items;
}

(async () => {
  const socket = net.connect({ port: PORT, host: HOST });
  const client = new RawClient(socket);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  console.log(`协议级自测 ${HOST}:${PORT}\n`);

  // 1. COTP 连接
  client.send(cotpCr());
  const cc = await client.waitCcotp();
  check('COTP 连接确认 (0xD0)', cc[1] === 0xd0, `code=0x${cc[1].toString(16)}`);

  // 2. 通信协商
  const setupRes = await client.request(dt(s7Job(0x0100, setupParam(960))));
  const negotiated = setupRes.readUInt16BE(18);
  check('Setup Communication 成功', setupRes[0] === 0x32 && setupRes[10] === 0 && negotiated > 0, `协商 PDU=${negotiated}`);

  // 3. 读取 DB5 前 8 字节
  const r1 = await client.request(dt(s7Job(0x0101, readParam([varSpec({ transport: 0x02, count: 8, db: 5, area: 0x84, addressBits: 0 })]))));
  const it1 = parseReadResponse(r1, 1)[0];
  check('读 DB5.DBB0~7 返回 0xFF', it1.rc === 0xff && it1.data.length === 8, `transport=0x${it1.transport.toString(16)} len=${it1.len}bit`);

  // 4. 读取位 DB7.DBX0.0
  const r2 = await client.request(dt(s7Job(0x0102, readParam([varSpec({ transport: 0x01, count: 1, db: 7, area: 0x84, addressBits: 0 })]))));
  const it2 = parseReadResponse(r2, 1)[0];
  check('读 DB7.DBX0.0（位）返回 0xFF', it2.rc === 0xff && it2.data.length === 1, `bit=${it2.data[0] & 1}`);

  // 5. 读取不存在的 DB8
  const r3 = await client.request(dt(s7Job(0x0103, readParam([varSpec({ transport: 0x02, count: 4, db: 8, area: 0x84, addressBits: 0 })]))));
  const it3 = parseReadResponse(r3, 1)[0];
  check('读不存在的 DB8 → 返回码 0x0A', it3.rc === 0x0a, `rc=0x${it3.rc.toString(16)}`);

  // 6. 越界读取 DB7 偏移 600
  const r4 = await client.request(dt(s7Job(0x0104, readParam([varSpec({ transport: 0x02, count: 4, db: 7, area: 0x84, addressBits: 600 * 8 })]))));
  const it4 = parseReadResponse(r4, 1)[0];
  check('读 DB7.DBB600[4] 越界 → 0x05', it4.rc === 0x05, `rc=0x${it4.rc.toString(16)}`);

  // 7. 写 DB6.DBB32~35 再读回
  const writeData = Buffer.concat([
    Buffer.from([0x00, 0x04, 0x00, 0x20]), // rc=0, transport=0x04, 32 bit
    Buffer.from([0xde, 0xad, 0xbe, 0xef]),
  ]);
  const wParam = Buffer.concat([Buffer.from([0x05, 0x01]), varSpec({ transport: 0x02, count: 4, db: 6, area: 0x84, addressBits: 32 * 8 })]);
  const wr = await client.request(dt(s7Job(0x0105, wParam, writeData)));
  check('写 DB6.DBB32~35 返回 0xFF', wr[14] === 0xff, `rc=0x${wr[14].toString(16)}`);

  const r5 = await client.request(dt(s7Job(0x0106, readParam([varSpec({ transport: 0x02, count: 4, db: 6, area: 0x84, addressBits: 32 * 8 })]))));
  const it5 = parseReadResponse(r5, 1)[0];
  check('读回写入的数据', it5.data.toString('hex') === 'deadbeef', it5.data.toString('hex'));

  // 8. 一次读 3 个不同 DB（多项请求）
  const r6 = await client.request(
    dt(
      s7Job(
        0x0107,
        readParam([
          varSpec({ transport: 0x02, count: 4, db: 5, area: 0x84, addressBits: 0 }),
          varSpec({ transport: 0x02, count: 2, db: 6, area: 0x84, addressBits: 0 }),
          varSpec({ transport: 0x02, count: 4, db: 7, area: 0x84, addressBits: 0 }),
        ]),
      ),
    ),
  );
  const multi = parseReadResponse(r6, 3);
  check('一次读 3 个 DB 全部 0xFF', multi.every((i) => i.rc === 0xff), multi.map((i) => i.data.length + 'B').join('/'));

  // 9. 大偏移访问（DB5 1024 字节内）应成功
  const r7 = await client.request(dt(s7Job(0x0108, readParam([varSpec({ transport: 0x02, count: 24, db: 5, area: 0x84, addressBits: 900 * 8 })]))));
  const it7 = parseReadResponse(r7, 1)[0];
  check('读 DB5.DBB900[24]（大偏移）成功', it7.rc === 0xff && it7.data.length === 24, `rc=0x${it7.rc.toString(16)}`);

  // 10. 超出 DB5 长度仍应报 0x05
  const r8 = await client.request(dt(s7Job(0x0109, readParam([varSpec({ transport: 0x02, count: 50, db: 5, area: 0x84, addressBits: 1000 * 8 })]))));
  const it8 = parseReadResponse(r8, 1)[0];
  check('读 DB5.DBB1000[50] 越界 → 0x05', it8.rc === 0x05, `rc=0x${it8.rc.toString(16)}`);

  // 11. 写未定义的 DB9 → 0x0A（说明 DB 未配置，而不是静默失败）
  const w11 = Buffer.concat([Buffer.from([0x00, 0x04, 0x00, 0x10]), Buffer.from([0x11, 0x22])]);
  const p11 = Buffer.concat([Buffer.from([0x05, 0x01]), varSpec({ transport: 0x02, count: 2, db: 9, area: 0x84, addressBits: 0 })]);
  const r11 = await client.request(dt(s7Job(0x010a, p11, w11)));
  check('写未定义 DB9 → 0x0A', r11[14] === 0x0a, `rc=0x${r11[14].toString(16)}`);

  // 12. 写越界 DB5.DBB1022[8] → 0x05
  const w12 = Buffer.concat([Buffer.from([0x00, 0x04, 0x00, 0x40]), Buffer.alloc(8, 0x55)]);
  const p12 = Buffer.concat([Buffer.from([0x05, 0x01]), varSpec({ transport: 0x02, count: 8, db: 5, area: 0x84, addressBits: 1022 * 8 })]);
  const r12 = await client.request(dt(s7Job(0x010b, p12, w12)));
  check('写 DB5.DBB1022[8] 越界 → 0x05', r12[14] === 0x05, `rc=0x${r12[14].toString(16)}`);

  // 13. 非标准客户端：长度字段按"字节"填写（应为 16 位却填 2）
  const w13 = Buffer.concat([Buffer.from([0x00, 0x04, 0x00, 0x02]), Buffer.from([0xaa, 0xbb])]);
  const p13 = Buffer.concat([Buffer.from([0x05, 0x01]), varSpec({ transport: 0x02, count: 2, db: 7, area: 0x84, addressBits: 500 * 8 })]);
  const r13 = await client.request(dt(s7Job(0x010c, p13, w13)));
  const rd13 = parseReadResponse(
    await client.request(dt(s7Job(0x010d, readParam([varSpec({ transport: 0x02, count: 2, db: 7, area: 0x84, addressBits: 500 * 8 })])))), 1)[0];
  check('长度字段按字节填写也能正确写入', r13[14] === 0xff && rd13.data.toString('hex') === 'aabb', `rc=0x${r13[14].toString(16)} 回读=${rd13.data.toString('hex')}`);

  // 14. 数据区不完整（请求 2 项、只给 1 项数据）：必须有响应且项数一致（避免客户端超时）
  const w14 = Buffer.concat([Buffer.from([0x00, 0x04, 0x00, 0x10]), Buffer.from([0x11, 0x22])]);
  const p14 = Buffer.concat([
    Buffer.from([0x05, 0x02]),
    varSpec({ transport: 0x02, count: 2, db: 7, area: 0x84, addressBits: 0 }),
    varSpec({ transport: 0x02, count: 2, db: 7, area: 0x84, addressBits: 2 * 8 }),
  ]);
  const r14 = await client.request(dt(s7Job(0x010e, p14, w14)));
  check('数据区不完整仍有响应（项数一致）', r14[13] === 2 && r14[15] === 0x07, `count=${r14[13]} 第2项rc=0x${(r14[15] || 0).toString(16)}`);

  socket.destroy();
  const okCount = results.filter((r) => r.ok).length;
  console.log(`\n${okCount === results.length ? '🎉' : '⚠️'} 通过 ${okCount}/${results.length}`);
  process.exit(okCount === results.length ? 0 : 1);
})().catch((err) => {
  console.error('❌ 自测异常:', err.message);
  process.exit(1);
});
