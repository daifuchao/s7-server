'use strict';

/**
 * 批量读取场景测试：模拟上位机/网关一次性读取十多个分散地址
 * （例如 DB5.DBB0[6] + DB5.DBB12[50] + DB5.DBB108[42] ... 共 12 项），
 * 校验服务端在接近 PDU 上限时不会丢项 / 不越界。
 *
 * 运行：node test/bulk-read-test.js [端口]
 */

const net = require('net');

const PORT = Number(process.argv[2] || process.env.S7_PORT || 1102);
const HOST = process.env.S7_HOST || '127.0.0.1';

function tpkt(p) {
  const b = Buffer.alloc(4 + p.length);
  b[0] = 0x03;
  b.writeUInt16BE(4 + p.length, 2);
  p.copy(b, 4);
  return b;
}
const DT = Buffer.from([0x02, 0xf0, 0x80]);

function s7Job(ref, param, data = Buffer.alloc(0)) {
  const h = Buffer.from([0x32, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0]);
  h.writeUInt16BE(ref, 4);
  h.writeUInt16BE(param.length, 6);
  h.writeUInt16BE(data.length, 8);
  return Buffer.concat([h, param, data]);
}

function varSpec(db, offset, count) {
  const b = Buffer.alloc(12);
  b[0] = 0x12;
  b[1] = 0x0a;
  b[2] = 0x10;
  b[3] = 0x02; // BYTE
  b.writeUInt16BE(count, 4);
  b.writeUInt16BE(db, 6);
  b[8] = 0x84;
  const bits = offset * 8;
  b[9] = (bits >> 16) & 0xff;
  b[10] = (bits >> 8) & 0xff;
  b[11] = bits & 0xff;
  return b;
}

// 与用户实际日志一致的 12 个地址（DB5/DB6 各 6 项，最大到 350 字节）
const REQUESTS = [
  [5, 0, 6],
  [5, 12, 50],
  [5, 108, 42],
  [5, 222, 12],
  [5, 250, 24],
  [5, 298, 13],
  [6, 0, 68],
  [6, 186, 16],
  [6, 210, 12],
  [6, 228, 16],
  [6, 316, 14],
  [6, 336, 6],
];

function parseItems(pdu, n) {
  let ptr = 14;
  const out = [];
  for (let i = 0; i < n; i++) {
    const rc = pdu[ptr];
    const transport = pdu[ptr + 1];
    const len = pdu.readUInt16BE(ptr + 2);
    const byteLen = transport === 0x03 ? Math.ceil(len / 8) : transport === 0x09 ? len : len / 8;
    out.push({ rc, byteLen, data: pdu.subarray(ptr + 4, ptr + 4 + byteLen) });
    ptr += 4 + byteLen + (byteLen % 2);
  }
  return out;
}

(async () => {
  const socket = net.connect({ port: PORT, host: HOST });
  await new Promise((res, rej) => {
    socket.once('connect', res);
    socket.once('error', rej);
  });

  let buf = Buffer.alloc(0);
  const queue = [];
  socket.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= 4) {
      const total = buf.readUInt16BE(2);
      if (buf.length < total) break;
      const frame = buf.subarray(4, total);
      buf = buf.subarray(total);
      const w = queue.shift();
      if (w) w(frame);
    }
  });

  const req = (payload) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('超时')), 4000);
      queue.push((f) => {
        clearTimeout(t);
        resolve(f.subarray(3));
      });
      socket.write(tpkt(payload));
    });

  // COTP 连接
  queue.push(() => {});
  socket.write(tpkt(Buffer.from([0x11, 0xe0, 0, 0, 0, 1, 0x00, 0xc0, 0x01, 0x0a, 0xc1, 0x02, 0x01, 0x00, 0xc2, 0x02, 0x03, 0x01])));
  await new Promise((r) => setTimeout(r, 200));

  // 通信协商
  const setup = Buffer.from([0xf0, 0x00, 0x00, 0x01, 0x00, 0x01, 0x03, 0xc0]);
  const setupRes = await req(Buffer.concat([DT, s7Job(1, setup)]));
  const pduSize = setupRes.readUInt16BE(18);
  console.log(`协商 PDU = ${pduSize} 字节`);

  // 12 项批量读
  const param = Buffer.concat([Buffer.from([0x04, REQUESTS.length]), ...REQUESTS.map(([db, off, len]) => varSpec(db, off, len))]);
  const res = await req(Buffer.concat([DT, s7Job(2, param)]));
  const returned = res[13];
  const items = parseItems(res, returned);

  const totalBytes = items.reduce((s, i) => s + i.byteLen, 0);
  console.log(`请求 ${REQUESTS.length} 项，返回 ${returned} 项，数据共 ${totalBytes} 字节`);

  let ok = returned === REQUESTS.length;
  items.forEach((it, i) => {
    const [db, off, len] = REQUESTS[i] || [];
    const pass = it.rc === 0xff && it.byteLen === len;
    if (!pass) ok = false;
    console.log(`  ${pass ? '✅' : '❌'} DB${db}.DBB${off}[${len}] → rc=0x${it.rc.toString(16)}, ${it.byteLen} 字节`);
  });

  socket.destroy();
  console.log(`\n${ok ? '🎉 批量读取全部成功，无截断' : '❌ 存在失败/截断项'}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error('❌ 异常:', e.message);
  process.exit(1);
});
