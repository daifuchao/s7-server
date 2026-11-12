'use strict';

/**
 * 持久化（断电保持）测试：
 *   1. 写入数据 → 停止 → 重启 → 数据仍在
 *   2. --reset 启动 → 回到配置中的初始值
 *   3. --no-persist 启动 → 写入不落盘，重启后回到初始值
 *
 * 运行：node test/persist-test.js
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const nodes7 = require('nodes7');

const PORT = Number(process.env.PERSIST_TEST_PORT || 1114);
const ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'data', 'state.json');

const tags = { real: 'DB5,REAL0', hb: 'DB6,INT372', cnt: 'DB5,INT356', bit: 'DB7,X0.0' };

const results = [];
function check(name, ok, extra = '') {
  results.push(ok);
  console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? '  ' + extra : ''}`);
}

function startServer(extraArgs = []) {
  const child = spawn(process.execPath, ['src/index.js', '--port', String(PORT), ...extraArgs], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d.toString();
  });
  child.stderr.on('data', (d) => {
    out += d.toString();
  });
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (out.includes('等待客户端连接')) {
        clearInterval(timer);
        resolve({ child, getOutput: () => out });
      }
    }, 100);
    setTimeout(() => {
      clearInterval(timer);
      resolve({ child, getOutput: () => out });
    }, 4000);
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    let done = false;
    child.once('exit', () => {
      if (!done) {
        done = true;
        resolve();
      }
    });
    child.kill('SIGTERM');
    setTimeout(() => {
      if (!done) {
        done = true;
        try {
          child.kill('SIGKILL');
        } catch (e) {}
        resolve();
      }
    }, 4000);
  });
}

function withClient(fn) {
  return new Promise((resolve, reject) => {
    const conn = new nodes7({ silent: true });
    conn.initiateConnection({ port: PORT, host: '127.0.0.1', rack: 0, slot: 1 }, async (err) => {
      if (err) return reject(err);
      conn.setTranslationCB((t) => tags[t]);
      conn.addItems(Object.keys(tags));
      try {
        const result = await fn(conn);
        conn.dropConnection(() => resolve(result));
      } catch (e) {
        conn.dropConnection(() => reject(e));
      }
    });
  });
}

const readAll = (conn) => new Promise((res, rej) => conn.readAllItems((bad, v) => (bad ? rej(new Error('读失败')) : res(v))));
const writeItems = (conn, names, values) =>
  new Promise((res, rej) => conn.writeItems(names, values, (bad) => (bad ? rej(new Error('写失败')) : res())));

(async () => {
  console.log(`持久化测试，端口 ${PORT}\n`);

  // 清理
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);

  // ---------- 场景 1：写入 → 重启 → 数据保持 ----------
  console.log('【1】写入数据后重启，数据应保持');
  let server = await startServer();
  const written = await withClient(async (conn) => {
    await writeItems(conn, ['real', 'hb', 'bit'], [12.5, 500, true]);
    return readAll(conn);
  });
  console.log(`     写入后: REAL0=${written.real}, INT372=${written.hb}, INT356=${written.cnt}, X0.0=${written.bit}`);
  await stopServer(server.child);

  check('退出时生成了持久化文件', fs.existsSync(STATE_FILE));

  server = await startServer();
  const restored = await withClient((conn) => readAll(conn));
  console.log(`     重启后: REAL0=${restored.real}, INT372=${restored.hb}, INT356=${restored.cnt}, X0.0=${restored.bit}`);
  check(
    'DB5.REAL0 保持为 12.5',
    Math.abs(restored.real - 12.5) < 0.001,
  );
  check('DB6.INT372 保持为 500', restored.hb === 500);
  check('DB7.X0.0 保持为 true', restored.bit === true);
  check('心跳结果 DB5.INT356 = 501 也保持', restored.cnt === 501);
  await stopServer(server.child);

  // ---------- 场景 2：--reset 恢复初始值 ----------
  console.log('\n【2】使用 --reset 启动，应回到配置中的初始值');
  server = await startServer(['--reset']);
  const afterReset = await withClient((conn) => readAll(conn));
  console.log(`     REAL0=${afterReset.real}, INT372=${afterReset.hb}, X0.0=${afterReset.bit}`);
  check('DB5.REAL0 恢复为 0', afterReset.real === 0);
  check('DB6.INT372 恢复为 0', afterReset.hb === 0);
  check('DB7.X0.0 恢复为 false', afterReset.bit === false);
  await stopServer(server.child);

  // ---------- 场景 3：--no-persist 不保存 ----------
  console.log('\n【3】使用 --no-persist 写入后重启，数据应回到初始值');
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  server = await startServer(['--no-persist']);
  await withClient(async (conn) => {
    await writeItems(conn, ['real', 'hb'], [77.7, 888]);
    return readAll(conn);
  });
  await stopServer(server.child);
  check('--no-persist 不生成持久化文件', !fs.existsSync(STATE_FILE));

  server = await startServer();
  const afterNoPersist = await withClient((conn) => readAll(conn));
  console.log(`     REAL0=${afterNoPersist.real}, INT372=${afterNoPersist.hb}`);
  check('重启后 REAL0 为初始值 0', afterNoPersist.real === 0);
  check('重启后 INT372 为初始值 0', afterNoPersist.hb === 0);
  await stopServer(server.child);

  // 清理
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);

  const ok = results.filter(Boolean).length;
  console.log(`\n${ok === results.length ? '🎉' : '⚠️'} 通过 ${ok}/${results.length}`);
  process.exit(ok === results.length ? 0 : 1);
})().catch((e) => {
  console.error('❌ 测试异常:', e.message || e);
  process.exit(1);
});
