'use strict';

const net = require('net');
const { EventEmitter } = require('events');
const { TpktParser, encodeTpkt } = require('./tpkt');
const { COTP, parseConnectionPacket, buildConnectionConfirm, buildDataHeader, buildDisconnectConfirm } = require('./cotp');
const { S7CommHandler } = require('./s7comm');
const { DataStore } = require('./dataStore');
const { LogicEngine } = require('./logic');
const { Persistence } = require('./persistence');
const { Logger } = require('./logger');

let sessionSeq = 0;

/** 单个客户端连接 */
class ClientSession {
  constructor(socket, server) {
    this.socket = socket;
    this.server = server;
    this.logger = server.logger;
    this.id = ++sessionSeq;
    this.parser = new TpktParser();
    this.state = 'WAIT_CR';
    this.connected = false;
    this.remote = `${socket.remoteAddress}:${socket.remotePort}`;
    this.tag = `[#${this.id} ${this.remote}]`;
    this.clientRef = 0;
    this.serverRef = (Math.floor(Math.random() * 0xfffe) + 1) & 0xffff;
    this.handler = new S7CommHandler(server.store, {
      pduSize: server.config.pduSize,
      writeAckItemSize: server.config.writeAckItemSize,
      logger: this.logger,
      tag: this.tag,
    });

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.onClose());
    socket.on('error', (err) => {
      this.logger.warn(`${this.tag} socket 错误: ${err.message}`);
    });
  }

  onData(chunk) {
    let frames;
    try {
      frames = this.parser.push(chunk);
    } catch (err) {
      this.logger.error(`${this.tag} 拆包失败: ${err.message}`);
      this.socket.destroy();
      return;
    }
    for (const frame of frames) {
      try {
        this.onFrame(frame);
      } catch (err) {
        this.logger.error(`${this.tag} 处理报文异常: ${err.message}`);
        if (this.logger.verbose) console.error(err);
      }
    }
  }

  onFrame(frame) {
    if (frame.length < 2) return;
    const code = frame[1];

    switch (code) {
      case COTP.CR: {
        const info = parseConnectionPacket(frame);
        if (!info) return;
        this.clientRef = info.srcRef;
        const cc = buildConnectionConfirm({
          clientRef: info.srcRef,
          serverRef: this.serverRef,
          srcTsap: info.dstTsap || 0x0100,
          dstTsap: info.srcTsap || 0x0100,
        });
        this.write(cc);
        this.state = 'S7';
        this.connected = true;
        this.logger.info(
          `${this.tag} COTP 连接建立 (TSAP 客户端=0x${(info.srcTsap || 0).toString(16)} → 服务端=0x${(
            info.dstTsap || 0
          ).toString(16)}, TPDU=${info.tpduSize || 1024})`,
        );
        this.server.emit('client:connect', this);
        break;
      }

      case COTP.DT: {
        const s7pdu = frame.subarray(3);
        const response = this.handler.handle(s7pdu);
        if (response) {
          this.write(Buffer.concat([buildDataHeader(true), response]));
        }
        break;
      }

      case COTP.DR: {
        this.logger.info(`${this.tag} 客户端请求断开连接`);
        this.write(buildDisconnectConfirm({ clientRef: this.clientRef, serverRef: this.serverRef }));
        this.socket.end();
        break;
      }

      default:
        this.logger.debug(`${this.tag} 忽略 COTP 报文 code=0x${code.toString(16)}`);
        break;
    }
  }

  write(cotpPayload) {
    if (this.socket.destroyed) return;
    this.socket.write(encodeTpkt(cotpPayload));
  }

  onClose() {
    if (this.connected) {
      this.logger.info(`${this.tag} 连接已关闭`);
    }
    this.server.removeSession(this);
  }

  close() {
    this.socket.end();
  }
}

/**
 * S7-1200 模拟服务端
 */
class S7Server extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      host: '0.0.0.0',
      port: 102,
      pduSize: 960,
      ...config,
    };
    this.logger = this.config.logger instanceof Logger ? this.config.logger : new Logger(this.config);
    this.store = new DataStore(this.config);
    this.logic = new LogicEngine(this.store, {
      rules: this.config.logic,
      logger: this.logger,
    });

    // 持久化（默认开启：重启不重置数据）
    const persistenceConfig = this.config.persistence === undefined ? { enabled: true } : this.config.persistence;
    this.persistence =
      persistenceConfig && persistenceConfig.enabled !== false
        ? new Persistence(this.store, {
            file: persistenceConfig.file || 'data/state.json',
            debounceMs: persistenceConfig.debounceMs,
            logger: this.logger,
          })
        : null;
    this.sessions = new Set();
    this.server = null;
    this.startedAt = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.sessions.add(new ClientSession(socket, this));
      });

      this.server.on('error', (err) => {
        this.logger.error(`服务器错误: ${err.message}`);
        reject(err);
      });

      // 先恢复数据，再启动逻辑规则（规则的"上次值"要基于恢复后的数据）
      if (this.persistence) {
        if (this.config.reset) this.persistence.clear();
        else this.persistence.load();
        this.persistence.watch();
      }

      this.logic.start();

      this.server.listen(this.config.port, this.config.host, () => {
        this.startedAt = new Date();
        const { host, port } = this.config;
        this.logger.info(`S7-1200 模拟服务端已启动: ${host}:${port}`);
        for (const db of this.store.describe()) {
          this.logger.info(`  数据块 ${db.name}: ${db.size} 字节`);
        }
        resolve();
      });
    });
  }

  removeSession(session) {
    this.sessions.delete(session);
  }

  get clientCount() {
    return this.sessions.size;
  }

  async stop() {
    this.logic.stop();
    if (this.persistence) {
      this.persistence.unwatch();
      this.persistence.save(); // 退出前强制落盘
    }
    for (const session of this.sessions) session.close();
    this.sessions.clear();
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
      this.logger.info('服务端已停止');
    }
  }
}

module.exports = { S7Server, ClientSession };
