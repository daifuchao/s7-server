'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 数据持久化：把 DB / M / I / Q 区的数据存到 JSON 文件，
 * 重启后自动恢复，实现"断电保持"（与 PLC 的保持性存储区类似）。
 *
 * - 写入触发后防抖落盘（默认 300ms，避免高频写造成 IO 压力）
 * - 进程退出时强制落盘
 * - 文件内容为十六进制字符串，可读、可手工编辑
 */
class Persistence {
  constructor(store, options = {}) {
    this.store = store;
    this.file = path.resolve(options.file || 'data/state.json');
    this.debounceMs = options.debounceMs ?? 300;
    this.logger = options.logger || console;
    this.timer = null;
    this.handler = () => this.scheduleSave();
  }

  /** 从文件恢复数据（不存在则返回 false） */
  load() {
    if (!fs.existsSync(this.file)) {
      this.logger.info(`未找到持久化数据文件 ${this.file}，使用配置中的初始值`);
      return false;
    }
    try {
      const snapshot = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.store.restore(snapshot);
      const when = snapshot.savedAt ? `，保存于 ${snapshot.savedAt}` : '';
      const dbs = Object.keys(snapshot.dbs || {}).sort((a, b) => Number(a) - Number(b));
      this.logger.info(`已恢复运行数据：${this.file}${when}`);
      this.logger.info(`  数据块: ${dbs.map((n) => `DB${n}`).join(', ') || '无'}`);
      return true;
    } catch (err) {
      this.logger.warn(`读取持久化数据失败（${err.message}），改用初始值`);
      return false;
    }
  }

  /** 监听数据变化，自动保存 */
  watch() {
    this.store.on('change', this.handler);
  }

  unwatch() {
    this.store.off('change', this.handler);
  }

  scheduleSave() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, this.debounceMs);
    if (this.timer.unref) this.timer.unref();
  }

  /** 立即落盘 */
  save() {
    try {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const snapshot = this.store.serialize();
      snapshot.savedAt = new Date().toISOString();
      fs.writeFileSync(this.file, JSON.stringify(snapshot));
      return true;
    } catch (err) {
      this.logger.warn(`保存数据失败: ${err.message}`);
      return false;
    }
  }

  /** 删除持久化文件（恢复默认初始值） */
  clear() {
    try {
      if (fs.existsSync(this.file)) {
        fs.unlinkSync(this.file);
        this.logger.info(`已清除持久化数据 ${this.file}`);
      }
      return true;
    } catch (err) {
      this.logger.warn(`清除持久化数据失败: ${err.message}`);
      return false;
    }
  }
}

module.exports = { Persistence };
