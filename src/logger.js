'use strict';

/**
 * 极简日志工具：带时间戳与等级，TTY 环境下带颜色。
 */
const useColor = process.stdout.isTTY && process.env.NO_COLOR !== '1';

const C = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
  magenta: '\x1b[35m',
};

function paint(color, text) {
  return useColor ? `${color}${text}${C.reset}` : text;
}

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

class Logger {
  constructor({ verbose = false, silent = false } = {}) {
    this.verbose = verbose;
    this.silent = silent;
  }

  _out(tag, color, msg) {
    if (this.silent) return;
    if(tag !== '[READ ]'){ 
      console.log(`${paint(C.gray, ts())} ${paint(color, tag)} ${msg}`);
    }
  }

  info(msg) {
    this._out('[INFO ]', C.green, msg);
  }

  warn(msg) {
    this._out('[WARN ]', C.yellow, msg);
  }

  error(msg) {
    this._out('[ERROR]', C.red, msg);
  }

  read(msg) {
    this._out('[READ ]', C.blue, msg);
  }

  write(msg) {
    this._out('[WRITE]', C.magenta, msg);
  }

  debug(msg) {
    if (this.verbose) this._out('[DEBUG]', C.gray, msg);
  }
}

module.exports = { Logger, paint, C };
