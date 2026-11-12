#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { S7Server } = require('./s7server');
const { Simulator } = require('./simulator');
const { Logger } = require('./logger');

const BANNER = `
  ╔══════════════════════════════════════════════════════════╗
  ║   Siemens S7-1200 (S7comm) 模拟服务端  ·  Node.js        ║
  ║   默认数据块: DB5 / DB6 / DB7                            ║
  ╚══════════════════════════════════════════════════════════╝
`;

/** 解析命令行参数：--key value / --flag */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function loadConfig(args) {
  const defaultPath = path.join(__dirname, '..', 'config', 'default.json');
  const configPath = args.config ? path.resolve(process.cwd(), String(args.config)) : defaultPath;
  let config = {};
  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } else if (args.config) {
    throw new Error(`配置文件不存在: ${configPath}`);
  }

  // 环境变量
  if (process.env.S7_PORT) config.port = Number(process.env.S7_PORT);
  if (process.env.S7_HOST) config.host = process.env.S7_HOST;
  if (process.env.S7_PDU_SIZE) config.pduSize = Number(process.env.S7_PDU_SIZE);

  // 命令行优先
  if (args.port !== undefined) config.port = Number(args.port);
  if (args.host !== undefined) config.host = String(args.host);
  if (args.pdu !== undefined) config.pduSize = Number(args.pdu);
  if (args.verbose) config.verbose = true;
  if (args.dump) process.env.S7_DUMP = '1';

  return config;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    console.log(`
用法: node src/index.js [选项]

选项:
  --port <端口>      监听端口（默认 102；非 root 用户请用 1102 等高...位端口）
  --host <地址>      监听地址（默认 0.0.0.0）
  --pdu <字节>       最大 PDU 长度（默认 960）
  --config <路径>    指定配置文件（默认 config/default.json）
  --live            开启数据模拟（DB5/DB6/DB7 数值自动变化）
  --dump            打印每个请求/响应的原始报文（十六进制，排查问题用）
  --verbose         输出调试日志
  --help            显示帮助

示例:
  sudo node src/index.js                       # 标准 102 端口
  node src/index.js --port 1102 --verbose       # 免 root 测试
  node src/index.js --port 1102 --live          # 带动态数据
  node src/index.js --port 1102 --dump --verbose  # 打印原始报文，排查写/读失败
`);
    return;
  }

  const config = loadConfig(args);
  const logger = new Logger({ verbose: Boolean(config.verbose) });

  console.log(BANNER);

  const server = new S7Server({ ...config, logger });

  server.on('client:connect', (session) => {
    logger.info(`当前在线客户端: ${server.clientCount}`);
    session.socket.on('close', () => logger.info(`当前在线客户端: ${server.clientCount}`));
  });

  try {
    await server.start();
  } catch (err) {
    if (err.code === 'EACCES') {
      logger.error(`端口 ${config.port} 需要管理员权限。`);
      logger.error('请使用 sudo 运行，或改用高位端口，例如: node src/index.js --port 1102');
      logger.error('（Linux 也可执行: sudo setcap cap_net_bind_service=+ep $(which node)）');
      process.exit(1);
    }
    if (err.code === 'EADDRINUSE') {
      logger.error(`端口 ${config.port} 已被占用，请换一个端口。`);
      process.exit(1);
    }
    logger.error(`启动失败: ${err.message}`);
    process.exit(1);
  }

  let simulator = null;
  const simEnabled = Boolean(config.simulation && config.simulation.enabled);
  if (simEnabled || args.live) {
    simulator = new Simulator(server.store, {
      intervalMs: config.simulation?.intervalMs || 1000,
      logger,
    });
    simulator.start();
  }

  logger.info('等待客户端连接…（Ctrl+C 退出）');

  const shutdown = async (signal) => {
    logger.info(`收到 ${signal}，正在关闭…`);
    if (simulator) simulator.stop();
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
