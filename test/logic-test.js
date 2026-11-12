'use strict';

/**
 * 心跳逻辑测试
 *
 *   客户端写 DB6.INT372 = N  →  服务端读该值 +1  →  DB5.INT356 = N + 1
 *   客户端写 DB6.INT374 = N  →  服务端读该值 +1  →  DB5.INT358 = N + 1
 *
 * 运行：node test/logic-test.js [端口]
 */

const nodes7 = require('nodes7');

const PORT = Number(process.argv[2] || process.env.S7_PORT || 1102);
const HOST = process.env.S7_HOST || '127.0.0.1';

const tags = {
  hb1: 'DB6,INT372',
  hb2: 'DB6,INT374',
  cnt1: 'DB5,INT356',
  cnt2: 'DB5,INT358',
  blk: 'DB6,B360.20', // 块写：DB6.DBB360~379（覆盖 INT372 / INT374）
};

const results = [];
function check(name, actual, expected) {
  const ok = actual === expected;
  results.push(ok);
  console.log(`  ${ok ? '✅' : '❌'} ${name}  期望 ${expected}，实际 ${actual}`);
  return ok;
}

const conn = new nodes7({ silent: true });

const connect = () =>
  new Promise((resolve, reject) => {
    conn.initiateConnection({ port: PORT, host: HOST, rack: 0, slot: 1 }, (err) => {
      if (err) return reject(err);
      conn.setTranslationCB((t) => tags[t]);
      conn.addItems(Object.keys(tags));
      resolve();
    });
  });

const readAll = () =>
  new Promise((resolve, reject) => conn.readAllItems((bad, v) => (bad ? reject(new Error('读失败')) : resolve(v))));
const read = async (name) => (await readAll())[name];

const write = (names, values) =>
  new Promise((resolve, reject) => {
    conn.writeItems(names, values, (bad) => (bad ? reject(new Error('写失败')) : resolve()));
  });

(async () => {
  await connect();
  console.log(`已连接 ${HOST}:${PORT}\n`);

  const v = await readAll();
  console.log(`初始值: DB6.INT372=${v.hb1}, DB6.INT374=${v.hb2}, DB5.INT356=${v.cnt1}, DB5.INT358=${v.cnt2}\n`);

  console.log('【1】写 DB6.INT372 = 5  →  DB5.INT356 应为 6');
  await write('hb1', 5);
  check('DB5.INT356', await read('cnt1'), 6);

  console.log('\n【2】写 DB6.INT372 = 100  →  DB5.INT356 应为 101');
  await write('hb1', 100);
  check('DB5.INT356', await read('cnt1'), 101);

  console.log('\n【3】重复写同一个值 100  →  DB5.INT356 仍为 101（幂等，不累加）');
  await write('hb1', 100);
  check('DB5.INT356', await read('cnt1'), 101);

  console.log('\n【4】写 DB6.INT372 = -1  →  DB5.INT356 应为 0');
  await write('hb1', -1);
  check('DB5.INT356', await read('cnt1'), 0);

  console.log('\n【5】心跳 2：写 DB6.INT374 = 50  →  DB5.INT358 应为 51');
  await write('hb2', 50);
  check('DB5.INT358', await read('cnt2'), 51);

  console.log('\n【6】一次写入两个心跳地址（同一报文）');
  await write(['hb1', 'hb2'], [7, 70]);
  check('DB5.INT356', await read('cnt1'), 8);
  check('DB5.INT358', await read('cnt2'), 71);

  console.log('\n【7】一次性块写 DB6.DBB360~379（覆盖两个心跳地址）');
  const block = new Array(20).fill(0);
  block[12] = 0x01;
  block[13] = 0x2c; // INT372 = 300
  block[14] = 0x01;
  block[15] = 0x2d; // INT374 = 301
  await write('blk', block);
  check('DB5.INT356', await read('cnt1'), 301);
  check('DB5.INT358', await read('cnt2'), 302);

  console.log('\n【8】溢出回绕：写 DB6.INT372 = 32767  →  DB5.INT356 应为 -32768（PLC INT 规则）');
  await write('hb1', 32767);
  check('DB5.INT356', await read('cnt1'), -32768);

  const okCount = results.filter(Boolean).length;
  console.log(`\n${okCount === results.length ? '🎉' : '⚠️'} 通过 ${okCount}/${results.length}`);

  conn.dropConnection(() => process.exit(okCount === results.length ? 0 : 1));
})().catch((e) => {
  console.error('❌ 测试异常:', e.message || e);
  process.exit(1);
});
