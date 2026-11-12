'use strict';

/**
 * 用 nodes7（纯 JS 的 S7 客户端，常用于连接真实 S7-300/400/1200/1500）
 * 验证模拟服务端的读 / 写功能。
 *
 * 运行：npm install && node test/client-demo.js [端口]
 */

const nodes7 = require('nodes7');

const PORT = Number(process.argv[2] || process.env.S7_PORT || 1102);
const HOST = process.env.S7_HOST || '127.0.0.1';

const tags = {
  db5_real0: 'DB5,REAL0',
  db5_int8: 'DB5,INT8',
  db5_bit160: 'DB5,X16.0',
  db5_str20: 'DB5,STRING20.14',
  db6_real0: 'DB6,REAL0',
  db6_int8: 'DB6,INT8',
  db7_int2: 'DB7,INT2',
  db7_bit00: 'DB7,X0.0',
  m0: 'MB0',
};

function connect() {
  return new Promise((resolve, reject) => {
    const conn = new nodes7({ silent: true });
    conn.initiateConnection({ port: PORT, host: HOST, rack: 0, slot: 1 }, (err) => {
      if (err) return reject(err);
      conn.setTranslationCB((tag) => tags[tag]);
      conn.addItems(Object.keys(tags));
      resolve(conn);
    });
  });
}

function readAll(conn) {
  return new Promise((resolve, reject) => {
    conn.readAllItems((bad, values) => (bad ? reject(new Error('读取返回 BAD: ' + JSON.stringify(values))) : resolve(values)));
  });
}

function writeItems(conn, names, values) {
  return new Promise((resolve, reject) => {
    conn.writeItems(names, values, (bad) => (bad ? reject(new Error('写入失败')) : resolve()));
  });
}

(async () => {
  console.log(`连接 ${HOST}:${PORT} …`);
  const conn = await connect();
  console.log('✅ 连接成功（COTP 连接 + 通信协商）\n');

  console.log('【1】读取初始值（DB5 / DB6 / DB7 / M）');
  const before = await readAll(conn);
  console.log(before);

  console.log('\n【2】写入：DB5.REAL0=12.34, DB6.INT8=-5, DB7.X0.0=true');
  await writeItems(conn, ['db5_real0', 'db6_int8', 'db7_bit00'], [12.34, -5, true]);

  const after = await readAll(conn);
  console.log('\n【3】写后回读');
  console.log(after);

  const checks = [
    ['DB5.REAL0 ≈ 12.34', Math.abs(after.db5_real0 - 12.34) < 0.001],
    ['DB6.INT8 == -5', after.db6_int8 === -5],
    ['DB7.X0.0 == true', after.db7_bit00 === true],
  ];

  console.log('\n【4】结果校验');
  for (const [name, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${name}`);

  const allOk = checks.every(([, ok]) => ok);
  console.log(`\n${allOk ? '🎉 全部通过：模拟服务端读写正常' : '❌ 存在失败项'}`);

  conn.dropConnection(() => process.exit(allOk ? 0 : 1));
})().catch((err) => {
  console.error('❌ 测试失败:', err.message || err);
  process.exit(1);
});
