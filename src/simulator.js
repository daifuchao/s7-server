'use strict';

/**
 * 数据模拟器：周期性改变 DB 中的数值，让"PLC"看起来是活的（可选）
 *
 * 默认对 DB5 / DB6 / DB7 做简单演示：
 *   DB5.DBD0  正弦波 (REAL)
 *   DB5.DBW4  递增计数 (INT)
 *   DB5.DBX6.0 心跳位 (BOOL)
 *   DB6.DBD0  缓慢爬升的温度设定 (REAL 0~100)
 *   DB7.DBW2  循环计数 (INT)
 *   DB7.DBX0.0 运行状态位 (BOOL)
 */

class Simulator {
  constructor(store, options = {}) {
    this.store = store;
    this.intervalMs = options.intervalMs || 1000;
    this.logger = options.logger || console;
    this.timer = null;
    this.tick = 0;
    this.temperature = 25;
    this.temperatureDir = 1;
  }

  get db5() {
    return this.store.getArea('DB', 5);
  }

  get db6() {
    return this.store.getArea('DB', 6);
  }

  get db7() {
    return this.store.getArea('DB', 7);
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.update(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    this.logger.info(`数据模拟器已启动（每 ${this.intervalMs} ms 刷新一次 DB5/DB6/DB7）`);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  update() {
    this.tick += 1;
    const db5 = this.db5;
    const db6 = this.db6;
    const db7 = this.db7;

    if (db5 && db5.length >= 8) {
      // 正弦波 0~100
      const sine = 50 + 50 * Math.sin(this.tick / 10);
      db5.writeFloatBE(Number(sine.toFixed(3)), 0);
      // 递增计数
      db5.writeInt16BE(this.tick % 32767, 4);
      // 心跳位
      const byte = db5[6];
      db5[6] = this.tick % 2 === 0 ? byte | 0x01 : byte & 0xfe;
    }

    if (db6 && db6.length >= 4) {
      // 温度在 20~80 之间来回爬升
      this.temperature += this.temperatureDir * 0.7;
      if (this.temperature > 80) this.temperatureDir = -1;
      if (this.temperature < 20) this.temperatureDir = 1;
      db6.writeFloatBE(Number(this.temperature.toFixed(2)), 0);
    }

    if (db7 && db7.length >= 4) {
      db7.writeInt16BE(this.tick % 1000, 2);
      db7[0] = 0x01; // 运行中
    }
  }
}

module.exports = { Simulator };
