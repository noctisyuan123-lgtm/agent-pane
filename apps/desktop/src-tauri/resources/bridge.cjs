"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../../node_modules/ws/lib/constants.js
var require_constants = __commonJS({
  "../../node_modules/ws/lib/constants.js"(exports2, module2) {
    "use strict";
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob) BINARY_TYPES.push("blob");
    module2.exports = {
      BINARY_TYPES,
      CLOSE_TIMEOUT: 3e4,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: Symbol("kIsForOnEventAttribute"),
      kListener: Symbol("kListener"),
      kStatusCode: Symbol("status-code"),
      kWebSocket: Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});

// ../../node_modules/ws/lib/buffer-util.js
var require_buffer_util = __commonJS({
  "../../node_modules/ws/lib/buffer-util.js"(exports2, module2) {
    "use strict";
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat(list, totalLength) {
      if (list.length === 0) return EMPTY_BUFFER;
      if (list.length === 1) return list[0];
      const target = Buffer.allocUnsafe(totalLength);
      let offset = 0;
      for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask, output, offset, length) {
      for (let i = 0; i < length; i++) {
        output[offset + i] = source[i] ^ mask[i & 3];
      }
    }
    function _unmask(buffer, mask) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] ^= mask[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer(data) {
      toBuffer.readOnly = true;
      if (Buffer.isBuffer(data)) return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer.readOnly = false;
      }
      return buf;
    }
    module2.exports = {
      concat,
      mask: _mask,
      toArrayBuffer,
      toBuffer,
      unmask: _unmask
    };
    if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = require("bufferutil");
        module2.exports.mask = function(source, mask, output, offset, length) {
          if (length < 48) _mask(source, mask, output, offset, length);
          else bufferUtil.mask(source, mask, output, offset, length);
        };
        module2.exports.unmask = function(buffer, mask) {
          if (buffer.length < 32) _unmask(buffer, mask);
          else bufferUtil.unmask(buffer, mask);
        };
      } catch (e) {
      }
    }
  }
});

// ../../node_modules/ws/lib/limiter.js
var require_limiter = __commonJS({
  "../../node_modules/ws/lib/limiter.js"(exports2, module2) {
    "use strict";
    var kDone = Symbol("kDone");
    var kRun = Symbol("kRun");
    var Limiter = class {
      /**
       * Creates a new `Limiter`.
       *
       * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
       *     to run concurrently
       */
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      /**
       * Adds a job to the queue.
       *
       * @param {Function} job The job to run
       * @public
       */
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      /**
       * Removes a job from the queue and runs it if possible.
       *
       * @private
       */
      [kRun]() {
        if (this.pending === this.concurrency) return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module2.exports = Limiter;
  }
});

// ../../node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "../../node_modules/ws/lib/permessage-deflate.js"(exports2, module2) {
    "use strict";
    var zlib = require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = Symbol("permessage-deflate");
    var kTotalLength = Symbol("total-length");
    var kCallback = Symbol("callback");
    var kBuffers = Symbol("buffers");
    var kError = Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate2 = class {
      /**
       * Creates a PerMessageDeflate instance.
       *
       * @param {Object} [options] Configuration options
       * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
       *     for, or request, a custom client window size
       * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
       *     acknowledge disabling of client context takeover
       * @param {Number} [options.concurrencyLimit=10] The number of concurrent
       *     calls to zlib
       * @param {Boolean} [options.isServer=false] Create the instance in either
       *     server or client mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
       *     use of a custom server window size
       * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
       *     disabling of server context takeover
       * @param {Number} [options.threshold=1024] Size (in bytes) below which
       *     messages should not be compressed if context takeover is disabled
       * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
       *     deflate
       * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
       *     inflate
       */
      constructor(options) {
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._maxPayload = this._options.maxPayload | 0;
        this._isServer = !!this._options.isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter(concurrency);
        }
      }
      /**
       * @type {String}
       */
      static get extensionName() {
        return "permessage-deflate";
      }
      /**
       * Create an extension negotiation offer.
       *
       * @return {Object} Extension parameters
       * @public
       */
      offer() {
        const params = {};
        if (this._options.serverNoContextTakeover) {
          params.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params.client_max_window_bits = true;
        }
        return params;
      }
      /**
       * Accept an extension negotiation offer/response.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Object} Accepted configuration
       * @public
       */
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      /**
       * Releases all resources used by the extension.
       *
       * @public
       */
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(
              new Error(
                "The deflate stream was closed while data was being processed"
              )
            );
          }
        }
      }
      /**
       *  Accept an extension negotiation offer.
       *
       * @param {Array} offers The extension negotiation offers
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params) => {
          if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && !params.client_max_window_bits) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      /**
       * Accept the extension negotiation response.
       *
       * @param {Array} response The extension negotiation response
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsClient(response) {
        const params = response[0];
        if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error(
            'Unexpected or invalid parameter "client_max_window_bits"'
          );
        }
        return params;
      }
      /**
       * Normalize parameters.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Array} The offers/response with normalized parameters
       * @private
       */
      normalizeParams(configurations) {
        configurations.forEach((params) => {
          Object.keys(params).forEach((key) => {
            let value = params[key];
            if (value.length > 1) {
              throw new Error(`Parameter "${key}" must have only a single value`);
            }
            value = value[0];
            if (key === "client_max_window_bits") {
              if (value !== true) {
                const num = +value;
                if (!Number.isInteger(num) || num < 8 || num > 15) {
                  throw new TypeError(
                    `Invalid value for parameter "${key}": ${value}`
                  );
                }
                value = num;
              } else if (!this._isServer) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else if (key === "server_max_window_bits") {
              const num = +value;
              if (!Number.isInteger(num) || num < 8 || num > 15) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
              value = num;
            } else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
              if (value !== true) {
                throw new TypeError(
                  `Invalid value for parameter "${key}": ${value}`
                );
              }
            } else {
              throw new Error(`Unknown parameter "${key}"`);
            }
            params[key] = value;
          });
        });
        return configurations;
      }
      /**
       * Decompress data. Concurrency limited.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Compress data. Concurrency limited.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Decompress data.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _decompress(data, fin, callback) {
        const endpoint = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin) this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(
            this._inflate[kBuffers],
            this._inflate[kTotalLength]
          );
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      /**
       * Compress data.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _compress(data, fin, callback) {
        const endpoint = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(
            this._deflate[kBuffers],
            this._deflate[kTotalLength]
          );
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module2.exports = PerMessageDeflate2;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      if (this[kError]) {
        this[kCallback](this[kError]);
        return;
      }
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});

// ../../node_modules/ws/lib/validation.js
var require_validation = __commonJS({
  "../../node_modules/ws/lib/validation.js"(exports2, module2) {
    "use strict";
    var { isUtf8 } = require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0 - 15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16 - 31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32 - 47
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48 - 63
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64 - 79
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80 - 95
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96 - 111
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
      // 112 - 127
    ];
    function isValidStatusCode(code) {
      return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // Overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // Overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value) {
      return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
    }
    module2.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module2.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = require("utf-8-validate");
        module2.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});

// ../../node_modules/ws/lib/receiver.js
var require_receiver = __commonJS({
  "../../node_modules/ws/lib/receiver.js"(exports2, module2) {
    "use strict";
    var { Writable } = require("stream");
    var PerMessageDeflate2 = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver2 = class extends Writable {
      /**
       * Creates a Receiver instance.
       *
       * @param {Object} [options] Options object
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {String} [options.binaryType=nodebuffer] The type for binary data
       * @param {Object} [options.extensions] An object containing the negotiated
       *     extensions
       * @param {Boolean} [options.isServer=false] Specifies whether to operate in
       *     client or server mode
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       */
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxBufferedChunks = options.maxBufferedChunks | 0;
        this._maxFragments = options.maxFragments | 0;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = void 0;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = void 0;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      /**
       * Implements `Writable.prototype._write()`.
       *
       * @param {Buffer} chunk The chunk of data to write
       * @param {String} encoding The character encoding of `chunk`
       * @param {Function} cb Callback
       * @private
       */
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO) return cb();
        if (this._maxBufferedChunks > 0 && this._buffers.length >= this._maxBufferedChunks) {
          cb(
            this.createError(
              RangeError,
              "Too many buffered chunks",
              false,
              1008,
              "WS_ERR_TOO_MANY_BUFFERED_PARTS"
            )
          );
          return;
        }
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      /**
       * Consumes `n` bytes from the buffered data.
       *
       * @param {Number} n The number of bytes to consume
       * @return {Buffer} The consumed bytes
       * @private
       */
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length) return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(
            buf.buffer,
            buf.byteOffset + n,
            buf.length - n
          );
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(
              buf.buffer,
              buf.byteOffset + n,
              buf.length - n
            );
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      /**
       * Starts the parsing loop.
       *
       * @param {Function} cb Callback
       * @private
       */
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored) cb();
      }
      /**
       * Reads the first two bytes of a frame.
       *
       * @param {Function} cb Callback
       * @private
       */
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error = this.createError(
            RangeError,
            "RSV2 and RSV3 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_2_3"
          );
          cb(error);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate2.extensionName]) {
          const error = this.createError(
            RangeError,
            "RSV1 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          cb(error);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (!this._fragmented) {
            const error = this.createError(
              RangeError,
              "invalid opcode 0",
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error = this.createError(
              RangeError,
              `invalid opcode ${this._opcode}`,
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error = this.createError(
              RangeError,
              "FIN must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_FIN"
            );
            cb(error);
            return;
          }
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error = this.createError(
              RangeError,
              `invalid payload length ${this._payloadLength}`,
              true,
              1002,
              "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
            );
            cb(error);
            return;
          }
        } else {
          const error = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            true,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          cb(error);
          return;
        }
        if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error = this.createError(
              RangeError,
              "MASK must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_MASK"
            );
            cb(error);
            return;
          }
        } else if (this._masked) {
          const error = this.createError(
            RangeError,
            "MASK must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_MASK"
          );
          cb(error);
          return;
        }
        if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
        else this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+16).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+64).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num = buf.readUInt32BE(0);
        if (num > Math.pow(2, 53 - 32) - 1) {
          const error = this.createError(
            RangeError,
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            false,
            1009,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
          );
          cb(error);
          return;
        }
        this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      /**
       * Payload length has been read.
       *
       * @param {Function} cb Callback
       * @private
       */
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error = this.createError(
              RangeError,
              "Max payload size exceeded",
              false,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            cb(error);
            return;
          }
        }
        if (this._masked) this._state = GET_MASK;
        else this._state = GET_DATA;
      }
      /**
       * Reads mask bytes.
       *
       * @private
       */
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      /**
       * Reads data bytes.
       *
       * @param {Function} cb Callback
       * @private
       */
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          if (this._maxFragments > 0 && this._fragments.length >= this._maxFragments) {
            const error = this.createError(
              RangeError,
              "Too many message fragments",
              false,
              1008,
              "WS_ERR_TOO_MANY_BUFFERED_PARTS"
            );
            cb(error);
            return;
          }
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      /**
       * Decompresses data.
       *
       * @param {Buffer} data Compressed data
       * @param {Function} cb Callback
       * @private
       */
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err) return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error = this.createError(
                RangeError,
                "Max payload size exceeded",
                false,
                1009,
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              );
              cb(error);
              return;
            }
            if (this._maxFragments > 0 && this._fragments.length >= this._maxFragments) {
              const error = this.createError(
                RangeError,
                "Too many message fragments",
                false,
                1008,
                "WS_ERR_TOO_MANY_BUFFERED_PARTS"
              );
              cb(error);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO) this.startLoop(cb);
        });
      }
      /**
       * Handles a data message.
       *
       * @param {Function} cb Callback
       * @private
       */
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error = this.createError(
              Error,
              "invalid UTF-8 sequence",
              true,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            cb(error);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      /**
       * Handles a control message.
       *
       * @param {Buffer} data Data to handle
       * @return {(Error|RangeError|undefined)} A possible error
       * @private
       */
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code = data.readUInt16BE(0);
            if (!isValidStatusCode(code)) {
              const error = this.createError(
                RangeError,
                `invalid status code ${code}`,
                true,
                1002,
                "WS_ERR_INVALID_CLOSE_CODE"
              );
              cb(error);
              return;
            }
            const buf = new FastBuffer(
              data.buffer,
              data.byteOffset + 2,
              data.length - 2
            );
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error = this.createError(
                Error,
                "invalid UTF-8 sequence",
                true,
                1007,
                "WS_ERR_INVALID_UTF8"
              );
              cb(error);
              return;
            }
            this._loop = false;
            this.emit("conclude", code, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      /**
       * Builds an error object.
       *
       * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
       * @param {String} message The error message
       * @param {Boolean} prefix Specifies whether or not to add a default prefix to
       *     `message`
       * @param {Number} statusCode The status code
       * @param {String} errorCode The exposed error code
       * @return {(Error|RangeError)} The error
       * @private
       */
      createError(ErrorCtor, message, prefix, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(
          prefix ? `Invalid WebSocket frame: ${message}` : message
        );
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module2.exports = Receiver2;
  }
});

// ../../node_modules/ws/lib/sender.js
var require_sender = __commonJS({
  "../../node_modules/ws/lib/sender.js"(exports2, module2) {
    "use strict";
    var { Duplex } = require("stream");
    var { randomFillSync } = require("crypto");
    var {
      types: { isUint8Array }
    } = require("util");
    var PerMessageDeflate2 = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender2 = class _Sender {
      /**
       * Creates a Sender instance.
       *
       * @param {Duplex} socket The connection socket
       * @param {Object} [extensions] An object containing the negotiated extensions
       * @param {Function} [generateMask] The function used to generate the masking
       *     key
       */
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT;
        this.onerror = NOOP;
        this[kWebSocket] = void 0;
      }
      /**
       * Frames a piece of data according to the HyBi WebSocket protocol.
       *
       * @param {(Buffer|String)} data The data to frame
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @return {(Buffer|String)[]} The framed data
       * @public
       */
      static frame(data, options) {
        let mask;
        let merge = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === void 0) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask[0] = randomPool[randomPoolPointer++];
            mask[1] = randomPool[randomPoolPointer++];
            mask[2] = randomPool[randomPoolPointer++];
            mask[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1) target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask) return [target, data];
        target[1] |= 128;
        target[offset - 4] = mask[0];
        target[offset - 3] = mask[1];
        target[offset - 2] = mask[2];
        target[offset - 1] = mask[3];
        if (skipMasking) return [target, data];
        if (merge) {
          applyMask(data, mask, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask, data, 0, dataLength);
        return [target, data];
      }
      /**
       * Sends a close message to the other peer.
       *
       * @param {Number} [code] The status code component of the body
       * @param {(String|Buffer)} [data] The message component of the body
       * @param {Boolean} [mask=false] Specifies whether or not to mask the message
       * @param {Function} [cb] Callback
       * @public
       */
      close(code, data, mask, cb) {
        let buf;
        if (code === void 0) {
          buf = EMPTY_BUFFER;
        } else if (typeof code !== "number" || !isValidStatusCode(code)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === void 0 || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code, 0);
        } else {
          const length = Buffer.byteLength(data);
          if (length > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length);
          buf.writeUInt16BE(code, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else if (isUint8Array(data)) {
            buf.set(data, 2);
          } else {
            throw new TypeError("Second argument must be a string or a Uint8Array");
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      /**
       * Sends a ping message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      ping(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a pong message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      pong(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a data message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Object} options Options object
       * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
       *     or text
       * @param {Boolean} [options.compress=false] Specifies whether or not to
       *     compress `data`
       * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Function} [cb] Callback
       * @public
       */
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin) this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      /**
       * Gets the contents of a blob as binary data.
       *
       * @param {Blob} blob The blob
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     the data
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while the blob was being read"
            );
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      /**
       * Dispatches a message.
       *
       * @param {(Buffer|String)} data The message to send
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     `data`
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while data was being compressed"
            );
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      /**
       * Executes queued send operations.
       *
       * @private
       */
      dequeue() {
        while (this._state === DEFAULT && this._queue.length) {
          const params = this._queue.shift();
          this._bufferedBytes -= params[3][kByteLength];
          Reflect.apply(params[0], this, params.slice(1));
        }
      }
      /**
       * Enqueues a send operation.
       *
       * @param {Array} params Send operation parameters.
       * @private
       */
      enqueue(params) {
        this._bufferedBytes += params[3][kByteLength];
        this._queue.push(params);
      }
      /**
       * Sends a frame.
       *
       * @param {(Buffer | String)[]} list The frame to send
       * @param {Function} [cb] Callback
       * @private
       */
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module2.exports = Sender2;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function") cb(err);
      for (let i = 0; i < sender._queue.length; i++) {
        const params = sender._queue[i];
        const callback = params[params.length - 1];
        if (typeof callback === "function") callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});

// ../../node_modules/ws/lib/event-target.js
var require_event_target = __commonJS({
  "../../node_modules/ws/lib/event-target.js"(exports2, module2) {
    "use strict";
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = Symbol("kCode");
    var kData = Symbol("kData");
    var kError = Symbol("kError");
    var kMessage = Symbol("kMessage");
    var kReason = Symbol("kReason");
    var kTarget = Symbol("kTarget");
    var kType = Symbol("kType");
    var kWasClean = Symbol("kWasClean");
    var Event = class {
      /**
       * Create a new `Event`.
       *
       * @param {String} type The name of the event
       * @throws {TypeError} If the `type` argument is not specified
       */
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      /**
       * @type {*}
       */
      get target() {
        return this[kTarget];
      }
      /**
       * @type {String}
       */
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event.prototype, "target", { enumerable: true });
    Object.defineProperty(Event.prototype, "type", { enumerable: true });
    var CloseEvent = class extends Event {
      /**
       * Create a new `CloseEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {Number} [options.code=0] The status code explaining why the
       *     connection was closed
       * @param {String} [options.reason=''] A human-readable string explaining why
       *     the connection was closed
       * @param {Boolean} [options.wasClean=false] Indicates whether or not the
       *     connection was cleanly closed
       */
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === void 0 ? 0 : options.code;
        this[kReason] = options.reason === void 0 ? "" : options.reason;
        this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
      }
      /**
       * @type {Number}
       */
      get code() {
        return this[kCode];
      }
      /**
       * @type {String}
       */
      get reason() {
        return this[kReason];
      }
      /**
       * @type {Boolean}
       */
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
    var ErrorEvent = class extends Event {
      /**
       * Create a new `ErrorEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.error=null] The error that generated this event
       * @param {String} [options.message=''] The error message
       */
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === void 0 ? null : options.error;
        this[kMessage] = options.message === void 0 ? "" : options.message;
      }
      /**
       * @type {*}
       */
      get error() {
        return this[kError];
      }
      /**
       * @type {String}
       */
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
    var MessageEvent = class extends Event {
      /**
       * Create a new `MessageEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.data=null] The message content
       */
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === void 0 ? null : options.data;
      }
      /**
       * @type {*}
       */
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
    var EventTarget = {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary) {
            const event = new MessageEvent("message", {
              data: isBinary ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code, message) {
            const event = new CloseEvent("close", {
              code,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error) {
            const event = new ErrorEvent("error", {
              error,
              message: error.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module2.exports = {
      CloseEvent,
      ErrorEvent,
      Event,
      EventTarget,
      MessageEvent
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});

// ../../node_modules/ws/lib/extension.js
var require_extension = __commonJS({
  "../../node_modules/ws/lib/extension.js"(exports2, module2) {
    "use strict";
    var { tokenChars } = require_validation();
    function push(dest, name, elem) {
      if (dest[name] === void 0) dest[name] = [elem];
      else dest[name].push(elem);
    }
    function parse(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code = -1;
      let end = -1;
      let i = 0;
      for (; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (extensionName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (i !== 0 && (code === 32 || code === 9)) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            const name = header.slice(start, end);
            if (code === 44) {
              push(offers, name, params);
              params = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (code === 32 || code === 9) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            push(params, header.slice(start, end), true);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            start = end = -1;
          } else if (code === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1) start = i;
            else if (!mustUnescape) mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code] === 1) {
              if (start === -1) start = i;
            } else if (code === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (start !== -1 && (code === 32 || code === 9)) {
            if (end === -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            let value = header.slice(start, end);
            if (mustUnescape) {
              value = value.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params, paramName, value);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            paramName = void 0;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code === 32 || code === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1) end = i;
      const token = header.slice(start, end);
      if (extensionName === void 0) {
        push(offers, token, params);
      } else {
        if (paramName === void 0) {
          push(params, token, true);
        } else if (mustUnescape) {
          push(params, paramName, token.replace(/\\/g, ""));
        } else {
          push(params, paramName, token);
        }
        push(offers, extensionName, params);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension2) => {
        let configurations = extensions[extension2];
        if (!Array.isArray(configurations)) configurations = [configurations];
        return configurations.map((params) => {
          return [extension2].concat(
            Object.keys(params).map((k) => {
              let values = params[k];
              if (!Array.isArray(values)) values = [values];
              return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
            })
          ).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module2.exports = { format, parse };
  }
});

// ../../node_modules/ws/lib/websocket.js
var require_websocket = __commonJS({
  "../../node_modules/ws/lib/websocket.js"(exports2, module2) {
    "use strict";
    var EventEmitter = require("events");
    var https = require("https");
    var http2 = require("http");
    var net = require("net");
    var tls = require("tls");
    var { randomBytes, createHash: createHash3 } = require("crypto");
    var { Duplex, Readable } = require("stream");
    var { URL: URL2 } = require("url");
    var PerMessageDeflate2 = require_permessage_deflate();
    var Receiver2 = require_receiver();
    var Sender2 = require_sender();
    var { isBlob } = require_validation();
    var {
      BINARY_TYPES,
      CLOSE_TIMEOUT,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener, removeEventListener }
    } = require_event_target();
    var { format, parse } = require_extension();
    var { toBuffer } = require_buffer_util();
    var kAborted = Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket2 = class _WebSocket extends EventEmitter {
      /**
       * Create a new `WebSocket`.
       *
       * @param {(String|URL)} address The URL to which to connect
       * @param {(String|String[])} [protocols] The subprotocols
       * @param {Object} [options] Connection options
       */
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === void 0) {
            protocols = [];
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              protocols = [];
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._closeTimeout = options.closeTimeout;
          this._isServer = true;
        }
      }
      /**
       * For historical reasons, the custom "nodebuffer" type is used by the default
       * instead of "blob".
       *
       * @type {String}
       */
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type)) return;
        this._binaryType = type;
        if (this._receiver) this._receiver._binaryType = type;
      }
      /**
       * @type {Number}
       */
      get bufferedAmount() {
        if (!this._socket) return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      /**
       * @type {String}
       */
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      /**
       * @type {Boolean}
       */
      get isPaused() {
        return this._paused;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onclose() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onerror() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onopen() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onmessage() {
        return null;
      }
      /**
       * @type {String}
       */
      get protocol() {
        return this._protocol;
      }
      /**
       * @type {Number}
       */
      get readyState() {
        return this._readyState;
      }
      /**
       * @type {String}
       */
      get url() {
        return this._url;
      }
      /**
       * Set up the socket and the internal resources.
       *
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Object} options Options object
       * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message size
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @private
       */
      setSocket(socket, head, options) {
        const receiver = new Receiver2({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxBufferedChunks: options.maxBufferedChunks,
          maxFragments: options.maxFragments,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender2(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout) socket.setTimeout(0);
        if (socket.setNoDelay) socket.setNoDelay();
        if (head.length > 0) socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      /**
       * Emit the `'close'` event.
       *
       * @private
       */
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate2.extensionName]) {
          this._extensions[PerMessageDeflate2.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      /**
       * Start a closing handshake.
       *
       *          +----------+   +-----------+   +----------+
       *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
       *    |     +----------+   +-----------+   +----------+     |
       *          +----------+   +-----------+         |
       * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
       *          +----------+   +-----------+   |
       *    |           |                        |   +---+        |
       *                +------------------------+-->|fin| - - - -
       *    |         +---+                      |   +---+
       *     - - - - -|fin|<---------------------+
       *              +---+
       *
       * @param {Number} [code] Status code explaining why the connection is closing
       * @param {(String|Buffer)} [data] The reason why the connection is
       *     closing
       * @public
       */
      close(code, data) {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._readyState = _WebSocket.CLOSING;
        this._sender.close(code, data, !this._isServer, (err) => {
          if (err) return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        setCloseTimer(this);
      }
      /**
       * Pause the socket.
       *
       * @public
       */
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      /**
       * Send a ping.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the ping is sent
       * @public
       */
      ping(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Send a pong.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the pong is sent
       * @public
       */
      pong(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Resume the socket.
       *
       * @public
       */
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain) this._socket.resume();
      }
      /**
       * Send a data message.
       *
       * @param {*} data The message to send
       * @param {Object} [options] Options object
       * @param {Boolean} [options.binary] Specifies whether `data` is binary or
       *     text
       * @param {Boolean} [options.compress] Specifies whether or not to compress
       *     `data`
       * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when data is written out
       * @public
       */
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate2.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      /**
       * Forcibly close the connection.
       *
       * @public
       */
      terminate() {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket2, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket2.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket2.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function") return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket2.prototype.addEventListener = addEventListener;
    WebSocket2.prototype.removeEventListener = removeEventListener;
    module2.exports = WebSocket2;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        closeTimeout: CLOSE_TIMEOUT,
        protocolVersion: protocolVersions[1],
        maxBufferedChunks: 1024 * 1024,
        maxFragments: 128 * 1024,
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: void 0,
        hostname: void 0,
        protocol: void 0,
        timeout: void 0,
        method: "GET",
        host: void 0,
        path: void 0,
        port: void 0
      };
      websocket._autoPong = opts.autoPong;
      websocket._closeTimeout = opts.closeTimeout;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(
          `Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`
        );
      }
      let parsedUrl;
      if (address instanceof URL2) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL2(address);
        } catch {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key = randomBytes(16).toString("base64");
      const request = isSecure ? https.request : http2.request;
      const protocolSet = /* @__PURE__ */ new Set();
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate2({
          ...opts.perMessageDeflate,
          isServer: false,
          maxPayload: opts.maxPayload
        });
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate2.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol of protocols) {
          if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) {
            throw new SyntaxError(
              "An invalid or duplicated subprotocol was specified"
            );
          }
          protocolSet.add(protocol);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const parts = opts.path.split(":");
        opts.socketPath = parts[0];
        opts.path = parts[1];
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers = options && options.headers;
          options = { ...options, headers: {} };
          if (headers) {
            for (const [key2, value] of Object.entries(headers)) {
              options.headers[key2.toLowerCase()] = value;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost) delete opts.headers.host;
            opts.auth = void 0;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted]) return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location = res.headers.location;
        const statusCode = res.statusCode;
        if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL2(location, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(
            websocket,
            req,
            `Unexpected server response: ${res.statusCode}`
          );
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket2.CONNECTING) return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest = createHash3("sha1").update(key + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== void 0) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt) websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== void 0) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate2.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate2.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxBufferedChunks: opts.maxBufferedChunks,
          maxFragments: opts.maxFragments,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket2.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net.connect(options);
    }
    function tlsConnect(options) {
      options.path = void 0;
      if (!options.servername && options.servername !== "") {
        options.servername = net.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket2.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length = isBlob(data) ? data.size : toBuffer(data).length;
        if (websocket._socket) websocket._sender._bufferedBytes += length;
        else websocket._bufferedAmount += length;
      }
      if (cb) {
        const err = new Error(
          `WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`
        );
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code;
      if (websocket._socket[kWebSocket] === void 0) return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume, websocket._socket);
      if (code === 1005) websocket.close();
      else websocket.close(code, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused) websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== void 0) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary) {
      this[kWebSocket].emit("message", data, isBinary);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket2.CLOSED) return;
      if (websocket.readyState === WebSocket2.OPEN) {
        websocket._readyState = WebSocket2.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(
        websocket._socket.destroy.bind(websocket._socket),
        websocket._closeTimeout
      );
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket2.CLOSING;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
        const chunk = this.read(this._readableState.length);
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = void 0;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket2.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket2.CLOSING;
        this.destroy();
      }
    }
  }
});

// ../../node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "../../node_modules/ws/lib/stream.js"(exports2, module2) {
    "use strict";
    var WebSocket2 = require_websocket();
    var { Duplex } = require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream2(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary) {
        const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data)) ws.pause();
      });
      ws.once("error", function error(err) {
        if (duplex.destroyed) return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed) return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called) callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy) ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null) return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted) duplex.destroy();
        } else {
          ws._socket.once("finish", function finish() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused) ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module2.exports = createWebSocketStream2;
  }
});

// ../../node_modules/ws/lib/subprotocol.js
var require_subprotocol = __commonJS({
  "../../node_modules/ws/lib/subprotocol.js"(exports2, module2) {
    "use strict";
    var { tokenChars } = require_validation();
    function parse(header) {
      const protocols = /* @__PURE__ */ new Set();
      let start = -1;
      let end = -1;
      let i = 0;
      for (i; i < header.length; i++) {
        const code = header.charCodeAt(i);
        if (end === -1 && tokenChars[code] === 1) {
          if (start === -1) start = i;
        } else if (i !== 0 && (code === 32 || code === 9)) {
          if (end === -1 && start !== -1) end = i;
        } else if (code === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1) end = i;
          const protocol2 = header.slice(start, end);
          if (protocols.has(protocol2)) {
            throw new SyntaxError(`The "${protocol2}" subprotocol is duplicated`);
          }
          protocols.add(protocol2);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol = header.slice(start, i);
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
      }
      protocols.add(protocol);
      return protocols;
    }
    module2.exports = { parse };
  }
});

// ../../node_modules/ws/lib/websocket-server.js
var require_websocket_server = __commonJS({
  "../../node_modules/ws/lib/websocket-server.js"(exports2, module2) {
    "use strict";
    var EventEmitter = require("events");
    var http2 = require("http");
    var { Duplex } = require("stream");
    var { createHash: createHash3 } = require("crypto");
    var extension2 = require_extension();
    var PerMessageDeflate2 = require_permessage_deflate();
    var subprotocol2 = require_subprotocol();
    var WebSocket2 = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer2 = class extends EventEmitter {
      /**
       * Create a `WebSocketServer` instance.
       *
       * @param {Object} options Configuration options
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Boolean} [options.autoPong=true] Specifies whether or not to
       *     automatically send a pong in response to a ping
       * @param {Number} [options.backlog=511] The maximum length of the queue of
       *     pending connections
       * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
       *     track clients
       * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
       *     wait for the closing handshake to finish after `websocket.close()` is
       *     called
       * @param {Function} [options.handleProtocols] A hook to handle protocols
       * @param {String} [options.host] The hostname where to bind the server
       * @param {Number} [options.maxBufferedChunks=1048576] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=131072] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=104857600] The maximum allowed message
       *     size
       * @param {Boolean} [options.noServer=false] Enable no server mode
       * @param {String} [options.path] Accept only connections matching this path
       * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
       *     permessage-deflate
       * @param {Number} [options.port] The port where to bind the server
       * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
       *     server to use
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @param {Function} [options.verifyClient] A hook to reject connections
       * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
       *     class to use. It must be the `WebSocket` class or class that extends it
       * @param {Function} [callback] A listener for the `listening` event
       */
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxBufferedChunks: 1024 * 1024,
          maxFragments: 128 * 1024,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          closeTimeout: CLOSE_TIMEOUT,
          verifyClient: null,
          noServer: false,
          backlog: null,
          // use default (511 as implemented in net.js)
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket: WebSocket2,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError(
            'One and only one of the "port", "server", or "noServer" options must be specified'
          );
        }
        if (options.port != null) {
          this._server = http2.createServer((req, res) => {
            const body = http2.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(
            options.port,
            options.host,
            options.backlog,
            callback
          );
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true) options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set();
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      /**
       * Returns the bound address, the address family name, and port of the server
       * as reported by the operating system if listening on an IP socket.
       * If the server is listening on a pipe or UNIX domain socket, the name is
       * returned as a string.
       *
       * @return {(Object|String|null)} The address of the server
       * @public
       */
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server) return null;
        return this._server.address();
      }
      /**
       * Stop the server from accepting new connections and emit the `'close'` event
       * when all existing connections are closed.
       *
       * @param {Function} [cb] A one-time listener for the `'close'` event
       * @public
       */
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb) this.once("close", cb);
        if (this._state === CLOSING) return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server2 = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server2.close(() => {
            emitClose(this);
          });
        }
      }
      /**
       * See if a given request should be handled by this server instance.
       *
       * @param {http.IncomingMessage} req Request object to inspect
       * @return {Boolean} `true` if the request is valid, else `false`
       * @public
       */
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname !== this.options.path) return false;
        }
        return true;
      }
      /**
       * Handle a HTTP Upgrade request.
       *
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @public
       */
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key === void 0 || !keyRegex.test(key)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version !== 13 && version !== 8) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message, {
            "Sec-WebSocket-Version": "13, 8"
          });
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set();
        if (secWebSocketProtocol !== void 0) {
          try {
            protocols = subprotocol2.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate2({
            ...this.options.perMessageDeflate,
            isServer: true,
            maxPayload: this.options.maxPayload
          });
          try {
            const offers = extension2.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate2.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate2.extensionName]);
              extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info = {
            origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info, (verified, code, message, headers) => {
              if (!verified) {
                return abortHandshake(socket, code || 401, message, headers);
              }
              this.completeUpgrade(
                extensions,
                key,
                protocols,
                req,
                socket,
                head,
                cb
              );
            });
            return;
          }
          if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
      }
      /**
       * Upgrade the connection to WebSocket.
       *
       * @param {Object} extensions The accepted extensions
       * @param {String} key The value of the `Sec-WebSocket-Key` header
       * @param {Set} protocols The subprotocols
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @throws {Error} If called more than once with the same socket
       * @private
       */
      completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable) return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error(
            "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
          );
        }
        if (this._state > RUNNING) return abortHandshake(socket, 503);
        const digest = createHash3("sha1").update(key + GUID).digest("base64");
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest}`
        ];
        const ws = new this.options.WebSocket(null, void 0, this.options);
        if (protocols.size) {
          const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol) {
            headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
            ws._protocol = protocol;
          }
        }
        if (extensions[PerMessageDeflate2.extensionName]) {
          const params = extensions[PerMessageDeflate2.extensionName].params;
          const value = extension2.format({
            [PerMessageDeflate2.extensionName]: [params]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxBufferedChunks: this.options.maxBufferedChunks,
          maxFragments: this.options.maxFragments,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module2.exports = WebSocketServer2;
    function addListeners(server2, map) {
      for (const event of Object.keys(map)) server2.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server2.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server2) {
      server2._state = CLOSED;
      server2.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code, message, headers) {
      message = message || http2.STATUS_CODES[code];
      headers = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers
      };
      socket.once("finish", socket.destroy);
      socket.end(
        `HTTP/1.1 ${code} ${http2.STATUS_CODES[code]}\r
` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message
      );
    }
    function abortHandshakeOrEmitwsClientError(server2, req, socket, code, message, headers) {
      if (server2.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server2.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code, message, headers);
      }
    }
  }
});

// ../bridge/src/browser-mcp-config.ts
var browser_mcp_config_exports = {};
__export(browser_mcp_config_exports, {
  browserMcpServers: () => browserMcpServers
});
function moduleDir() {
  const fromEnv = process.env.AGENT_PANE_BRIDGE_DIR;
  if (fromEnv && import_node_fs5.default.existsSync(fromEnv)) return fromEnv;
  try {
    if (import_meta?.url) {
      return import_node_path5.default.dirname((0, import_node_url.fileURLToPath)(import_meta.url));
    }
  } catch {
  }
  const entry = process.argv[1];
  if (entry) {
    try {
      return import_node_path5.default.dirname(import_node_fs5.default.realpathSync(entry));
    } catch {
      return import_node_path5.default.dirname(import_node_path5.default.resolve(entry));
    }
  }
  return process.cwd();
}
function resolveBrowserMcpScript() {
  const fromEnv = process.env.AGENT_PANE_BROWSER_MCP;
  if (fromEnv && import_node_fs5.default.existsSync(fromEnv)) return fromEnv;
  const here = moduleDir();
  const candidates = [
    import_node_path5.default.join(here, "browser-mcp.cjs"),
    import_node_path5.default.join(here, "resources", "browser-mcp.cjs"),
    import_node_path5.default.join(here, "..", "browser-mcp.cjs"),
    import_node_path5.default.join(here, "..", "resources", "browser-mcp.cjs"),
    import_node_path5.default.join(here, "browser-mcp.ts"),
    import_node_path5.default.resolve(process.cwd(), "apps/bridge/src/browser-mcp.ts"),
    import_node_path5.default.resolve(process.cwd(), "apps/desktop/sidecar/browser-mcp.cjs"),
    import_node_path5.default.resolve(
      process.cwd(),
      "apps/desktop/src-tauri/resources/browser-mcp.cjs"
    )
  ];
  for (const p of candidates) {
    if (import_node_fs5.default.existsSync(p)) return p;
  }
  return null;
}
function browserMcpServers(httpBase = `http://${process.env.AGENT_PANE_HOST ?? "127.0.0.1"}:${process.env.AGENT_PANE_PORT ?? "8787"}`) {
  const script = resolveBrowserMcpScript();
  if (!script) {
    console.warn("[agent-pane] browser-mcp script not found \u2014 MCP tools disabled");
    return [];
  }
  const env = [{ name: "AGENT_PANE_HTTP", value: httpBase }];
  if (script.endsWith(".cjs") || script.endsWith(".js")) {
    return [
      {
        name: "agent-pane-browser",
        command: process.execPath,
        args: [script],
        env
      }
    ];
  }
  try {
    const req = (0, import_node_module.createRequire)(import_node_path5.default.resolve(process.cwd(), "package.json"));
    const tsxCli = req.resolve("tsx/cli");
    return [
      {
        name: "agent-pane-browser",
        command: process.execPath,
        args: [tsxCli, script],
        env
      }
    ];
  } catch {
    return [
      {
        name: "agent-pane-browser",
        command: "npx",
        args: ["tsx", script],
        env
      }
    ];
  }
}
var import_node_fs5, import_node_path5, import_node_module, import_node_url, import_meta;
var init_browser_mcp_config = __esm({
  "../bridge/src/browser-mcp-config.ts"() {
    "use strict";
    import_node_fs5 = __toESM(require("node:fs"), 1);
    import_node_path5 = __toESM(require("node:path"), 1);
    import_node_module = require("node:module");
    import_node_url = require("node:url");
    import_meta = {};
  }
});

// ../bridge/src/history-index.ts
function readPinSet() {
  try {
    if (!import_node_fs9.default.existsSync(PINS_PATH)) return /* @__PURE__ */ new Set();
    const raw = JSON.parse(import_node_fs9.default.readFileSync(PINS_PATH, "utf8"));
    if (Array.isArray(raw)) return new Set(raw.map(String));
    if (raw && typeof raw === "object") {
      const o = raw;
      if (Array.isArray(o.ids)) return new Set(o.ids.map(String));
      return new Set(Object.keys(o).filter((k) => o[k]));
    }
  } catch {
  }
  return /* @__PURE__ */ new Set();
}
function writePinSet(ids) {
  ensureRoot();
  const dir = import_node_path9.default.dirname(PINS_PATH);
  import_node_fs9.default.mkdirSync(dir, { recursive: true });
  import_node_fs9.default.writeFileSync(
    PINS_PATH,
    JSON.stringify({ ids: [...ids] }, null, 2),
    "utf8"
  );
  invalidateHistoryListCache();
}
function isPinned(sessionId) {
  return readPinSet().has(sessionId);
}
function setPinned(sessionId, pinned) {
  const set = readPinSet();
  if (pinned) set.add(sessionId);
  else set.delete(sessionId);
  writePinSet(set);
}
function invalidateHistoryListCache() {
  listCache = null;
}
function invalidateSessionEventsCache(sessionId) {
  if (sessionId) eventsCache.delete(sessionId);
  else eventsCache.clear();
}
function ensureRoot() {
  import_node_fs9.default.mkdirSync(ROOT, { recursive: true });
}
function metaPath(sessionId) {
  return import_node_path9.default.join(ROOT, sessionId, "meta.json");
}
function eventsPath(sessionId) {
  return import_node_path9.default.join(ROOT, sessionId, "events.jsonl");
}
function ensureTitle(sessionId, title) {
  const t = (title || "").trim();
  if (t && t !== "Untitled") return t.slice(0, 80);
  const derived = deriveMetaFromEvents(sessionId);
  const d = (derived?.title || "").trim();
  if (d && d !== "New session" && d !== "Untitled") return d.slice(0, 80);
  return t || "New session";
}
function readMeta(sessionId) {
  try {
    const p = metaPath(sessionId);
    if (!import_node_fs9.default.existsSync(p)) return null;
    const meta = JSON.parse(import_node_fs9.default.readFileSync(p, "utf8"));
    meta.pinned = isPinned(sessionId) || !!meta.pinned;
    meta.title = ensureTitle(sessionId, meta.title);
    return meta;
  } catch {
    return null;
  }
}
function writeMeta(meta) {
  ensureRoot();
  const dir = import_node_path9.default.join(ROOT, meta.sessionId);
  import_node_fs9.default.mkdirSync(dir, { recursive: true });
  const fixed = {
    ...meta,
    title: ensureTitle(meta.sessionId, meta.title),
    pinned: isPinned(meta.sessionId) || !!meta.pinned
  };
  import_node_fs9.default.writeFileSync(metaPath(meta.sessionId), JSON.stringify(fixed, null, 2), "utf8");
  invalidateHistoryListCache();
}
function upsertMeta(patch) {
  const prev = readMeta(patch.sessionId);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const prevTitle = (prev?.title || "").trim();
  const patchTitle = (patch.title || "").trim().slice(0, 80);
  const keepTitle = prevTitle && prevTitle !== "New session" && prevTitle !== "Untitled" && (prev?.messageCount ?? 0) > 0;
  const title = keepTitle ? prevTitle : patchTitle || prevTitle || "New session";
  const meta = {
    sessionId: patch.sessionId,
    cwd: patch.cwd ?? prev?.cwd ?? "",
    title: ensureTitle(patch.sessionId, title),
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    messageCount: (prev?.messageCount ?? 0) + (patch.bumpMessage ? 1 : 0),
    providerSessionId: patch.providerSessionId ?? prev?.providerSessionId,
    // Import lineage: set once, never clobber with empty
    sourceProviderSessionId: patch.sourceProviderSessionId ?? prev?.sourceProviderSessionId,
    // Pin from dedicated store (never lost on upsert)
    pinned: isPinned(patch.sessionId) || !!prev?.pinned,
    unread: prev?.unread,
    archived: prev?.archived
  };
  writeMeta(meta);
  return meta;
}
function deriveMetaFromEvents(sessionId) {
  const p = eventsPath(sessionId);
  if (!import_node_fs9.default.existsSync(p)) return null;
  let cwd = "";
  let title = "New session";
  let createdAt = "";
  let updatedAt = "";
  let messageCount = 0;
  let firstUser = "";
  try {
    const lines = import_node_fs9.default.readFileSync(p, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (!createdAt && e.at) createdAt = e.at;
        if (e.at) updatedAt = e.at;
        if (e.type === "SessionStarted") {
          cwd = e.cwd ?? cwd;
        }
        if (e.type === "UserMessageAppended") {
          messageCount++;
          const t = e.text ?? "";
          if (!firstUser && t) firstUser = t;
        }
      } catch {
      }
    }
  } catch {
    return null;
  }
  if (!createdAt) return null;
  return {
    sessionId,
    cwd,
    title: (firstUser || title).slice(0, 80),
    createdAt,
    updatedAt: updatedAt || createdAt,
    messageCount
  };
}
function listHistory(force = false) {
  if (!force && listCache && Date.now() - listCache.at < LIST_TTL_MS) {
    return listCache.groups;
  }
  ensureRoot();
  const sessions2 = [];
  let dirs = [];
  try {
    dirs = import_node_fs9.default.readdirSync(ROOT);
  } catch {
    listCache = { at: Date.now(), groups: [] };
    return [];
  }
  for (const id of dirs) {
    const dir = import_node_path9.default.join(ROOT, id);
    try {
      if (!import_node_fs9.default.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!hasReplayableEvents(id)) {
      try {
        const metaOnly = readMeta(id);
        const ev = eventsPath(id);
        const emptyOrMissing = !import_node_fs9.default.existsSync(ev) || import_node_fs9.default.statSync(ev).size === 0;
        if (metaOnly && emptyOrMissing) {
          import_node_fs9.default.rmSync(dir, { recursive: true, force: true });
        }
      } catch {
      }
      continue;
    }
    let meta = readMeta(id);
    if (!meta) {
      meta = deriveMetaFromEvents(id);
      if (meta && !isDraftSession(meta)) {
        meta.pinned = isPinned(id);
        writeMeta(meta);
      }
    } else {
      if (meta.pinned && !isPinned(id)) setPinned(id, true);
      const before = JSON.stringify({ t: meta.title, p: meta.pinned });
      meta = {
        ...meta,
        title: ensureTitle(id, meta.title),
        pinned: isPinned(id) || !!meta.pinned
      };
      const after = JSON.stringify({ t: meta.title, p: meta.pinned });
      if (before !== after && !isDraftSession(meta)) writeMeta(meta);
    }
    if (meta && !isDraftSession(meta)) sessions2.push(meta);
  }
  sessions2.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
  const byCwd = /* @__PURE__ */ new Map();
  const active = sessions2.filter((s) => !s.archived && !isDraftSession(s));
  for (const s of active) {
    const key = s.cwd || "(unknown)";
    const list = byCwd.get(key) ?? [];
    list.push(s);
    byCwd.set(key, list);
  }
  for (const list of byCwd.values()) {
    list.sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return a.pinned ? -1 : 1;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }
  const groups = [];
  for (const [cwd, list] of byCwd) {
    groups.push({
      cwd,
      name: cwd === "(unknown)" ? "Unknown" : import_node_path9.default.basename(cwd) || cwd,
      sessions: list
    });
  }
  groups.sort((a, b) => {
    const ta = a.sessions[0] ? new Date(a.sessions[0].updatedAt).getTime() : 0;
    const tb = b.sessions[0] ? new Date(b.sessions[0].updatedAt).getTime() : 0;
    return tb - ta;
  });
  listCache = { at: Date.now(), groups };
  return groups;
}
function loadSessionEvents(sessionId, force = false) {
  const p = eventsPath(sessionId);
  if (!import_node_fs9.default.existsSync(p)) return [];
  let mtimeMs = 0;
  try {
    mtimeMs = import_node_fs9.default.statSync(p).mtimeMs;
  } catch {
    return [];
  }
  const hit = eventsCache.get(sessionId);
  if (!force && hit && hit.mtimeMs === mtimeMs && Date.now() - hit.at < EVENTS_TTL_MS) {
    return hit.events;
  }
  const events = [];
  const lines = import_node_fs9.default.readFileSync(p, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
    }
  }
  eventsCache.set(sessionId, { at: Date.now(), mtimeMs, events });
  return events;
}
function patchMeta(sessionId, patch) {
  let prev = readMeta(sessionId);
  if (!prev) {
    prev = deriveMetaFromEvents(sessionId) ?? null;
  }
  if (!prev) return null;
  const next = {
    ...prev,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  if (patch.title != null && String(patch.title).trim()) {
    next.title = String(patch.title).trim().slice(0, 80);
  }
  if (typeof patch.pinned === "boolean") {
    setPinned(sessionId, patch.pinned);
    next.pinned = patch.pinned;
  } else {
    next.pinned = isPinned(sessionId) || !!prev.pinned;
  }
  if (typeof patch.unread === "boolean") next.unread = patch.unread;
  if (typeof patch.archived === "boolean") next.archived = patch.archived;
  if (patch.cwd != null) next.cwd = patch.cwd;
  next.title = ensureTitle(sessionId, next.title);
  writeMeta(next);
  return next;
}
function deleteSession(sessionId) {
  const dir = import_node_path9.default.join(ROOT, sessionId);
  try {
    if (import_node_fs9.default.existsSync(dir)) {
      import_node_fs9.default.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error("[history] deleteSession failed", sessionId, e);
    return false;
  }
  try {
    if (import_node_fs9.default.existsSync(dir)) {
      import_node_fs9.default.rmSync(dir, { recursive: true, force: true });
    }
  } catch {
  }
  try {
    if (isPinned(sessionId)) setPinned(sessionId, false);
  } catch {
  }
  invalidateHistoryListCache();
  invalidateSessionEventsCache(sessionId);
  return true;
}
function isDraftSession(meta) {
  return (meta.messageCount ?? 0) <= 0;
}
function hasReplayableEvents(sessionId) {
  const p = eventsPath(sessionId);
  if (!import_node_fs9.default.existsSync(p)) return false;
  try {
    const lines = import_node_fs9.default.readFileSync(p, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e.type === "UserMessageAppended") return true;
      } catch {
      }
    }
  } catch {
    return false;
  }
  return false;
}
function pruneDraftSessions(opts) {
  ensureRoot();
  let removed = 0;
  let dirs = [];
  try {
    dirs = import_node_fs9.default.readdirSync(ROOT);
  } catch {
    return 0;
  }
  for (const id of dirs) {
    if (opts?.keepSessionId && id === opts.keepSessionId) continue;
    const dir = import_node_path9.default.join(ROOT, id);
    try {
      if (!import_node_fs9.default.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const meta = readMeta(id) ?? deriveMetaFromEvents(id);
    if (!meta || !isDraftSession(meta)) continue;
    if (opts?.cwd && meta.cwd && meta.cwd !== opts.cwd) continue;
    if (deleteSession(id)) removed++;
  }
  return removed;
}
function sliceEventsByUserTurn(events, opts) {
  let turn = -1;
  const out = [];
  for (const e of events) {
    if (e.type === "SessionRewound") continue;
    if (e.type === "UserMessageAppended") {
      turn++;
      if (opts.beforeTurn != null && turn === opts.beforeTurn) break;
      if (opts.throughTurn != null && turn > opts.throughTurn) break;
    }
    out.push(e);
  }
  return out;
}
function forkSession(sessionId, opts) {
  const events = loadSessionEvents(sessionId, true);
  if (!events.length) return null;
  const prev = readMeta(sessionId) ?? deriveMetaFromEvents(sessionId);
  if (!prev) return null;
  const sliced = typeof opts?.throughUserTurn === "number" ? sliceEventsByUserTurn(events, { throughTurn: opts.throughUserTurn }) : events.filter((e) => e.type !== "SessionRewound");
  if (!sliced.length) return null;
  const newId = (0, import_node_crypto4.randomUUID)();
  const dir = import_node_path9.default.join(ROOT, newId);
  import_node_fs9.default.mkdirSync(dir, { recursive: true });
  const lines = sliced.map(
    (e, i) => JSON.stringify({ ...e, sessionId: newId, seq: i + 1 })
  );
  import_node_fs9.default.writeFileSync(import_node_path9.default.join(dir, "events.jsonl"), lines.join("\n") + "\n", "utf8");
  const messageCount = sliced.filter((e) => e.type === "UserMessageAppended").length;
  const firstUser = sliced.find((e) => e.type === "UserMessageAppended");
  const meta = {
    ...prev,
    sessionId: newId,
    title: `${(firstUser?.text || prev.title).slice(0, 60)} (fork)`,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    messageCount,
    pinned: false,
    unread: false,
    archived: false,
    // New branch — don't inherit stale provider id (resume starts fresh)
    providerSessionId: void 0
  };
  writeMeta(meta);
  invalidateSessionEventsCache(newId);
  invalidateHistoryListCache();
  return meta;
}
var import_node_fs9, import_node_os6, import_node_path9, import_node_crypto4, ROOT, PINS_PATH, listCache, LIST_TTL_MS, eventsCache, EVENTS_TTL_MS;
var init_history_index = __esm({
  "../bridge/src/history-index.ts"() {
    "use strict";
    import_node_fs9 = __toESM(require("node:fs"), 1);
    import_node_os6 = __toESM(require("node:os"), 1);
    import_node_path9 = __toESM(require("node:path"), 1);
    import_node_crypto4 = require("node:crypto");
    ROOT = import_node_path9.default.join(import_node_os6.default.homedir(), ".agent-pane", "sessions");
    PINS_PATH = import_node_path9.default.join(import_node_os6.default.homedir(), ".agent-pane", "pins.json");
    listCache = null;
    LIST_TTL_MS = 12e3;
    eventsCache = /* @__PURE__ */ new Map();
    EVENTS_TTL_MS = 6e4;
  }
});

// ../bridge/src/grok-session-import.ts
var grok_session_import_exports = {};
__export(grok_session_import_exports, {
  findGrokSessionDir: () => findGrokSessionDir,
  importGrokSession: () => importGrokSession
});
function extractText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((x) => {
      if (!x || typeof x !== "object") return "";
      const o = x;
      if (o.type === "text" || o.type === "summary_text" || o.text != null) {
        return String(o.text ?? "");
      }
      return "";
    }).join("");
  }
  return String(content);
}
function reasoningText(obj) {
  const summary = obj.summary;
  if (Array.isArray(summary)) {
    const parts = summary.map((x) => {
      if (!x || typeof x !== "object") return "";
      const o = x;
      if (o.type === "summary_text" || o.text != null) return String(o.text ?? "");
      return "";
    }).filter(Boolean);
    if (parts.length) return parts.join("\n");
  }
  return extractText(obj.content ?? obj.text);
}
function isNoiseUser(text) {
  const t = text.trim();
  if (!t) return true;
  if (t.startsWith("<local-command")) return true;
  if (t.startsWith("<command-name>") || t.startsWith("<command-message>")) {
    return true;
  }
  return false;
}
function trunc(s, n = 4e3) {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 20)}
\u2026(truncated)`;
}
function findGrokSessionDir(sessionId) {
  if (!import_node_fs11.default.existsSync(GROK_ROOT)) return null;
  for (const ent of import_node_fs11.default.readdirSync(GROK_ROOT, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const cand = import_node_path11.default.join(GROK_ROOT, ent.name, sessionId);
    if (import_node_fs11.default.existsSync(import_node_path11.default.join(cand, "chat_history.jsonl"))) return cand;
  }
  return null;
}
function importGrokSession(sessionId, opts) {
  const id = sessionId.trim();
  if (!id) throw new Error("sessionId required");
  const eventsPath2 = import_node_path11.default.join(PANE_ROOT, id, "events.jsonl");
  if (import_node_fs11.default.existsSync(eventsPath2) && !opts?.force) {
    const meta2 = readMeta(id);
    if (meta2) {
      return {
        ok: true,
        skipped: true,
        sessionId: id,
        meta: meta2,
        reason: "already imported"
      };
    }
  }
  const grokDir = findGrokSessionDir(id);
  if (!grokDir) throw new Error(`grok session not found: ${id}`);
  let summary = {};
  try {
    summary = JSON.parse(
      import_node_fs11.default.readFileSync(import_node_path11.default.join(grokDir, "summary.json"), "utf8")
    );
  } catch {
  }
  const cwd = (summary.info?.cwd || summary.cwd || "").trim() || import_node_os8.default.homedir();
  const createdAt = summary.created_at || (/* @__PURE__ */ new Date()).toISOString();
  const updatedAt = summary.updated_at || createdAt;
  const model = summary.current_model_id || void 0;
  const lines = import_node_fs11.default.readFileSync(import_node_path11.default.join(grokDir, "chat_history.jsonl"), "utf8").split("\n").filter(Boolean);
  const events = [];
  let seq = 0;
  let userCount = 0;
  let title = "";
  const openTools = /* @__PURE__ */ new Map();
  const push = (ev) => {
    seq += 1;
    events.push({
      ...ev,
      seq,
      sessionId: id,
      at: ev.at ?? createdAt
    });
  };
  push({
    type: "SessionStarted",
    cwd,
    model,
    providerSessionId: id,
    resumed: true
  });
  for (const raw of lines) {
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }
    const typ = obj.type;
    if (typ === "user") {
      const text = extractText(obj.content).trim();
      if (isNoiseUser(text)) continue;
      userCount += 1;
      if (!title) title = text.replace(/\n/g, " ").trim().slice(0, 80);
      push({ type: "UserMessageAppended", text });
    } else if (typ === "reasoning") {
      const text = reasoningText(obj).trim();
      if (text) push({ type: "ThoughtChunk", text });
    } else if (typ === "assistant") {
      const text = extractText(obj.content).trim();
      if (text) {
        push({ type: "MessageChunk", role: "assistant", text });
        push({ type: "MessageDone", role: "assistant" });
      }
      const toolCalls = obj.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          if (!tc || typeof tc !== "object") continue;
          const tco = tc;
          const tid = String(tco.id || `tool-${seq}`);
          const name = String(tco.name || "tool");
          const args = typeof tco.arguments === "string" ? tco.arguments : JSON.stringify(tco.arguments ?? "");
          openTools.set(tid, name);
          push({
            type: "ToolStarted",
            toolId: tid,
            title: name,
            kind: name,
            inputSummary: trunc(args, 1500)
          });
        }
      }
    } else if (typ === "tool_result") {
      const tid = String(obj.tool_call_id || `tool-result-${seq}`);
      const out = extractText(obj.content);
      openTools.delete(tid);
      push({
        type: "ToolFinished",
        toolId: tid,
        outputSummary: trunc(out, 4e3)
      });
    }
  }
  if (userCount === 0) {
    throw new Error(`no user messages in grok chat_history: ${grokDir}`);
  }
  if (!title) title = `Imported ${id.slice(0, 8)}`;
  if (events.length) {
    events[0].at = createdAt;
    events[events.length - 1].at = updatedAt;
  }
  import_node_fs11.default.mkdirSync(import_node_path11.default.join(PANE_ROOT, id), { recursive: true });
  import_node_fs11.default.writeFileSync(
    eventsPath2,
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8"
  );
  const meta = {
    sessionId: id,
    cwd,
    title,
    createdAt,
    updatedAt,
    messageCount: userCount,
    /** Current handle (initially same as Grok); resume will rewrite this. */
    providerSessionId: id,
    /** Stable import lineage — keep original Grok id after resume. */
    sourceProviderSessionId: id
  };
  writeMeta(meta);
  try {
    const raw = JSON.parse(import_node_fs11.default.readFileSync(import_node_path11.default.join(PANE_ROOT, id, "meta.json"), "utf8"));
    raw.importedFrom = "grok";
    raw.sourceKind = summary.session_kind || "grok";
    raw.sourceProviderSessionId = id;
    import_node_fs11.default.writeFileSync(
      import_node_path11.default.join(PANE_ROOT, id, "meta.json"),
      JSON.stringify(raw, null, 2) + "\n",
      "utf8"
    );
  } catch {
  }
  invalidateSessionEventsCache(id);
  invalidateHistoryListCache();
  return {
    ok: true,
    skipped: false,
    sessionId: id,
    meta: readMeta(id) ?? meta,
    events: events.length,
    userMessages: userCount,
    grokDir
  };
}
var import_node_fs11, import_node_os8, import_node_path11, GROK_ROOT, PANE_ROOT;
var init_grok_session_import = __esm({
  "../bridge/src/grok-session-import.ts"() {
    "use strict";
    import_node_fs11 = __toESM(require("node:fs"), 1);
    import_node_os8 = __toESM(require("node:os"), 1);
    import_node_path11 = __toESM(require("node:path"), 1);
    init_history_index();
    GROK_ROOT = import_node_path11.default.join(import_node_os8.default.homedir(), ".grok", "sessions");
    PANE_ROOT = import_node_path11.default.join(import_node_os8.default.homedir(), ".agent-pane", "sessions");
  }
});

// ../bridge/src/browser-session.ts
var browser_session_exports = {};
__export(browser_session_exports, {
  getBrowserSession: () => getBrowserSession
});
function assertHttpUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error("Invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http: and https: URLs are allowed");
  }
}
function getBrowserSession() {
  if (!singleton) singleton = new BrowserSession();
  return singleton;
}
var BrowserSession, singleton;
var init_browser_session = __esm({
  "../bridge/src/browser-session.ts"() {
    "use strict";
    BrowserSession = class {
      browser = null;
      page = null;
      lastScreenshot = "";
      lastError;
      url = "";
      title = "";
      async ensurePage() {
        if (this.page) return this.page;
        try {
          const pw = await new Function("return import('playwright')")();
          const browser = await pw.chromium.launch({ headless: true });
          this.browser = browser;
          this.page = await browser.newPage();
          this.lastError = void 0;
          return this.page;
        } catch (e) {
          this.lastError = "Playwright not available. Install with: npx playwright install chromium";
          throw e;
        }
      }
      async refreshScreenshot() {
        if (!this.page) return;
        try {
          const buf = await this.page.screenshot({ type: "png" });
          this.lastScreenshot = buf.toString("base64");
          this.lastError = void 0;
        } catch (e) {
          this.lastError = e instanceof Error ? e.message : String(e);
        }
      }
      async navigate(url) {
        assertHttpUrl(url);
        const page = await this.ensurePage();
        await page.goto(url, { waitUntil: "domcontentloaded" });
        this.url = page.url();
        this.title = await page.title();
        await this.refreshScreenshot();
      }
      async back() {
        const page = await this.ensurePage();
        await page.goBack({ waitUntil: "domcontentloaded" });
        this.url = page.url();
        this.title = await page.title();
        await this.refreshScreenshot();
      }
      async screenshot() {
        const page = await this.ensurePage();
        const buf = await page.screenshot({ type: "png" });
        this.lastScreenshot = buf.toString("base64");
        return this.lastScreenshot;
      }
      async snapshot() {
        const page = await this.ensurePage();
        try {
          if (page.accessibility?.snapshot) {
            const tree = await page.accessibility.snapshot();
            return JSON.stringify(tree, null, 2);
          }
        } catch {
        }
        return page.evaluate(() => document.body?.innerText ?? "");
      }
      async click(selector) {
        const page = await this.ensurePage();
        await page.click(selector);
        this.url = page.url();
        this.title = await page.title();
        await this.refreshScreenshot();
      }
      async type(selector, text) {
        const page = await this.ensurePage();
        await page.fill(selector, text);
        await this.refreshScreenshot();
      }
      getState() {
        return {
          url: this.url,
          title: this.title,
          screenshotBase64: this.lastScreenshot,
          ...this.lastError ? { error: this.lastError } : {}
        };
      }
    };
    singleton = null;
  }
});

// ../bridge/src/index.ts
var import_node_http = __toESM(require("node:http"), 1);

// ../../node_modules/ws/wrapper.mjs
var import_stream = __toESM(require_stream(), 1);
var import_extension = __toESM(require_extension(), 1);
var import_permessage_deflate = __toESM(require_permessage_deflate(), 1);
var import_receiver = __toESM(require_receiver(), 1);
var import_sender = __toESM(require_sender(), 1);
var import_subprotocol = __toESM(require_subprotocol(), 1);
var import_websocket = __toESM(require_websocket(), 1);
var import_websocket_server = __toESM(require_websocket_server(), 1);

// ../../packages/shared/dist/index.js
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}

// ../bridge/src/event-store.ts
var import_node_fs = __toESM(require("node:fs"), 1);
var import_node_path = __toESM(require("node:path"), 1);
var import_node_os = __toESM(require("node:os"), 1);
var EventStore = class {
  seqBySession = /* @__PURE__ */ new Map();
  memory = /* @__PURE__ */ new Map();
  root;
  constructor(root) {
    this.root = root ?? import_node_path.default.join(import_node_os.default.homedir(), ".agent-pane", "sessions");
    import_node_fs.default.mkdirSync(this.root, { recursive: true });
  }
  sessionDir(sessionId, create) {
    const dir = import_node_path.default.join(this.root, sessionId);
    if (create) import_node_fs.default.mkdirSync(dir, { recursive: true });
    return dir;
  }
  eventsPath(sessionId, create = false) {
    return import_node_path.default.join(this.sessionDir(sessionId, create), "events.jsonl");
  }
  /**
   * Ensure in-memory seq cursor is at least as high as anything already on disk.
   * Without this, after bridge restart / resume the cursor resets to 0 and new
   * events reuse seq 1..N — UI seenSeq then drops them as "already applied"
   * from the history replay. That was "resume works on disk but UI blank".
   */
  ensureSessionLoaded(sessionId) {
    if (!this.memory.has(sessionId)) {
      this.loadFromDisk(sessionId);
      return;
    }
    const cursor = this.seqBySession.get(sessionId) ?? 0;
    const p = this.eventsPath(sessionId, false);
    if (!import_node_fs.default.existsSync(p)) return;
    try {
      const lines = import_node_fs.default.readFileSync(p, "utf8").split("\n").filter(Boolean);
      let maxSeq = cursor;
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          if ((e.seq ?? 0) > maxSeq) maxSeq = e.seq ?? 0;
        } catch {
        }
      }
      if (lines.length > maxSeq) maxSeq = lines.length;
      if (maxSeq > cursor) this.seqBySession.set(sessionId, maxSeq);
    } catch {
    }
  }
  append(event) {
    this.ensureSessionLoaded(event.sessionId);
    const prev = this.seqBySession.get(event.sessionId) ?? 0;
    const seq = prev + 1;
    this.seqBySession.set(event.sessionId, seq);
    const stored = { ...event, seq };
    const list = this.memory.get(event.sessionId) ?? [];
    list.push(stored);
    this.memory.set(event.sessionId, list);
    import_node_fs.default.appendFileSync(
      this.eventsPath(event.sessionId, true),
      JSON.stringify(stored) + "\n",
      "utf8"
    );
    return stored;
  }
  list(sessionId, fromSeq = 0) {
    if (!this.memory.has(sessionId)) {
      this.loadFromDisk(sessionId);
    }
    const list = this.memory.get(sessionId) ?? [];
    return list.filter((e) => (e.seq ?? 0) > fromSeq);
  }
  loadFromDisk(sessionId) {
    const p = this.eventsPath(sessionId, false);
    if (!import_node_fs.default.existsSync(p)) {
      this.memory.set(sessionId, []);
      this.seqBySession.set(sessionId, 0);
      return;
    }
    const lines = import_node_fs.default.readFileSync(p, "utf8").split("\n").filter(Boolean);
    const events = [];
    let maxSeq = 0;
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        events.push(e);
        if ((e.seq ?? 0) > maxSeq) maxSeq = e.seq ?? 0;
      } catch {
      }
    }
    if (lines.length > maxSeq) maxSeq = lines.length;
    this.memory.set(sessionId, events);
    this.seqBySession.set(sessionId, maxSeq);
  }
  /** Drop in-memory state after disk delete so zombies cannot reappear. */
  purge(sessionId) {
    this.memory.delete(sessionId);
    this.seqBySession.delete(sessionId);
  }
  /**
   * Rewrite events.jsonl. Used after rewind (drop discarded turns) and tests.
   * Reassigns seq 1..N to keep the file tidy.
   */
  replaceAll(sessionId, events) {
    this.ensureSessionLoaded(sessionId);
    const stored = events.map((e, i) => ({
      ...e,
      sessionId,
      seq: i + 1
    }));
    this.memory.set(sessionId, stored);
    this.seqBySession.set(sessionId, stored.length);
    const p = this.eventsPath(sessionId, true);
    const body = stored.length === 0 ? "" : stored.map((e) => JSON.stringify(e)).join("\n") + "\n";
    import_node_fs.default.writeFileSync(p, body, "utf8");
    return stored;
  }
  /**
   * Keep events before the Nth UserMessageAppended (0-based).
   * Drops that user turn and everything after (Claude Code Undo).
   */
  truncateBeforeUserTurn(sessionId, userTurnIndex) {
    const list = this.list(sessionId, 0);
    let turn = -1;
    const kept = [];
    for (const e of list) {
      if (e.type === "SessionRewound") continue;
      if (e.type === "UserMessageAppended") {
        turn++;
        if (turn === userTurnIndex) break;
      }
      kept.push(e);
    }
    return this.replaceAll(sessionId, kept);
  }
  listSessions() {
    if (!import_node_fs.default.existsSync(this.root)) return [];
    return import_node_fs.default.readdirSync(this.root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  }
};

// ../bridge/src/grok-acp-adapter.ts
var import_node_child_process2 = require("node:child_process");
var readline = __toESM(require("node:readline"), 1);
var import_node_fs6 = __toESM(require("node:fs"), 1);
var import_node_path6 = __toESM(require("node:path"), 1);
var import_node_crypto = require("node:crypto");
var import_node_child_process3 = require("node:child_process");

// ../bridge/src/grok-signals-watcher.ts
var import_node_fs2 = __toESM(require("node:fs"), 1);
var import_node_os2 = __toESM(require("node:os"), 1);
var import_node_path2 = __toESM(require("node:path"), 1);
function resolveGrokSignalsPaths(cwd, providerSessionId) {
  if (!cwd?.trim() || !providerSessionId?.trim()) return [];
  const home = import_node_os2.default.homedir();
  const sessionsRoot = import_node_path2.default.join(home, ".grok", "sessions");
  const roots = /* @__PURE__ */ new Set();
  const abs = import_node_path2.default.resolve(cwd.trim());
  roots.add(abs);
  try {
    roots.add(import_node_fs2.default.realpathSync(abs));
  } catch {
  }
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (p) => {
    if (seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  for (const root of roots) {
    push(
      import_node_path2.default.join(
        sessionsRoot,
        encodeURIComponent(root),
        providerSessionId,
        "signals.json"
      )
    );
  }
  try {
    if (import_node_fs2.default.existsSync(sessionsRoot)) {
      for (const ent of import_node_fs2.default.readdirSync(sessionsRoot, { withFileTypes: true })) {
        if (!ent.isDirectory() || !ent.name.startsWith("%")) continue;
        push(
          import_node_path2.default.join(sessionsRoot, ent.name, providerSessionId, "signals.json")
        );
      }
    }
  } catch {
  }
  return out;
}
function readGrokSignalsUsage(paths) {
  for (const p of paths) {
    try {
      if (!import_node_fs2.default.existsSync(p)) continue;
      const raw = import_node_fs2.default.readFileSync(p, "utf8");
      const j = JSON.parse(raw);
      const used = Number(j.contextTokensUsed);
      const size = Number(j.contextWindowTokens);
      if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) {
        continue;
      }
      const pctRaw = Number(j.contextWindowUsage);
      return {
        used: Math.max(0, Math.round(used)),
        size: Math.max(1, Math.round(size)),
        pct: Number.isFinite(pctRaw) ? pctRaw : void 0
      };
    } catch {
    }
  }
  return null;
}
var GrokSignalsWatcher = class {
  constructor(paths, onUsage, intervalMs = 1200) {
    this.onUsage = onUsage;
    this.intervalMs = intervalMs;
    this.paths = paths;
  }
  timer = null;
  watchers = [];
  lastKey = "";
  stopped = false;
  paths;
  start() {
    this.stopped = false;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    for (const p of this.paths) {
      try {
        const dir = import_node_path2.default.dirname(p);
        if (!import_node_fs2.default.existsSync(dir)) continue;
        const w = import_node_fs2.default.watch(dir, { persistent: false }, (_evt, filename) => {
          if (this.stopped) return;
          if (!filename || filename === "signals.json" || String(filename).endsWith("signals.json")) {
            this.tick();
          }
        });
        this.watchers.push(w);
      } catch {
      }
    }
  }
  /** Force a read (e.g. after prompt completes). */
  refresh() {
    this.tick();
  }
  stop() {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
      }
    }
    this.watchers = [];
  }
  tick() {
    if (this.stopped) return;
    const u = readGrokSignalsUsage(this.paths);
    if (!u) return;
    const key = `${u.used}:${u.size}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.onUsage(u);
  }
};

// ../bridge/src/attachment-persist.ts
var import_node_fs3 = __toESM(require("node:fs"), 1);
var import_node_os3 = __toESM(require("node:os"), 1);
var import_node_path3 = __toESM(require("node:path"), 1);
var UPLOADS = import_node_path3.default.join(import_node_os3.default.homedir(), ".agent-pane", "uploads");
var MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/plain; charset=utf-8",
  ".tsx": "text/plain; charset=utf-8"
};
function guessMime(filePath) {
  const ext = import_node_path3.default.extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}
function isImagePath(filePath) {
  const ext = import_node_path3.default.extname(filePath).toLowerCase();
  return [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".svg",
    ".heic",
    ".avif"
  ].includes(ext);
}
function isEphemeralPath(filePath) {
  const p = filePath.replace(/\\/g, "/");
  return /\/TemporaryItems\//i.test(p) || /\/screencaptureui_/i.test(p) || /\/var\/folders\/[^/]+\/[^/]+\/T\//i.test(p) || /NSIRD_screencapture/i.test(p);
}
function persistLocalFile(absPath) {
  const src = import_node_path3.default.resolve(absPath);
  if (!import_node_fs3.default.existsSync(src) || !import_node_fs3.default.statSync(src).isFile()) return absPath;
  if (src.startsWith(UPLOADS + import_node_path3.default.sep) || src === UPLOADS) return src;
  import_node_fs3.default.mkdirSync(UPLOADS, { recursive: true });
  const base = import_node_path3.default.basename(src).replace(/[^\w.\-()+ ]+/g, "_").slice(0, 120) || "file.bin";
  const dest = import_node_path3.default.join(UPLOADS, `${Date.now().toString(36)}-${base}`);
  import_node_fs3.default.copyFileSync(src, dest);
  return dest;
}
function stabilizeAttachment(ref) {
  if (ref.kind === "folder") return ref;
  const p = ref.path;
  if (!p) return ref;
  if (isImagePath(p) || isEphemeralPath(p)) {
    return { ...ref, path: persistLocalFile(p) };
  }
  return ref;
}
function stabilizeAttachments(refs) {
  if (!refs?.length) return refs;
  return refs.map(stabilizeAttachment);
}

// ../bridge/src/path-env.ts
var import_node_fs4 = __toESM(require("node:fs"), 1);
var import_node_os4 = __toESM(require("node:os"), 1);
var import_node_path4 = __toESM(require("node:path"), 1);
var import_node_child_process = require("node:child_process");
var SYSTEM_DIRS = [
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin"
];
function nvmDefaultBin(home) {
  const nvmDir = process.env.NVM_DIR || import_node_path4.default.join(home, ".nvm");
  const alias = import_node_path4.default.join(nvmDir, "alias", "default");
  try {
    if (import_node_fs4.default.existsSync(alias)) {
      const ver = import_node_fs4.default.readFileSync(alias, "utf8").trim();
      if (ver) {
        const bin = import_node_path4.default.join(nvmDir, "versions", "node", ver, "bin");
        if (import_node_fs4.default.existsSync(bin)) return bin;
      }
    }
  } catch {
  }
  try {
    const versions = import_node_path4.default.join(nvmDir, "versions", "node");
    if (!import_node_fs4.default.existsSync(versions)) return null;
    const names = import_node_fs4.default.readdirSync(versions).filter((n) => n.startsWith("v")).sort();
    for (let i = names.length - 1; i >= 0; i--) {
      const bin = import_node_path4.default.join(versions, names[i], "bin");
      if (import_node_fs4.default.existsSync(bin)) return bin;
    }
  } catch {
  }
  return null;
}
function userExtraDirs(home) {
  const extras = [
    import_node_path4.default.join(home, ".grok", "bin"),
    import_node_path4.default.join(home, ".local", "bin"),
    import_node_path4.default.join(home, ".cargo", "bin")
  ];
  const nvm = nvmDefaultBin(home);
  if (nvm) extras.push(nvm);
  return extras.filter((d) => {
    try {
      return import_node_fs4.default.existsSync(d);
    } catch {
      return false;
    }
  });
}
function cleanPathParts(raw) {
  if (!raw) return [];
  return raw.split(import_node_path4.default.delimiter).map((p) => p.trim()).filter((p) => p.length > 0 && p !== "$" && !/^\$+$/.test(p));
}
function buildAugmentedPath(existing) {
  const home = import_node_os4.default.homedir();
  const parts = [
    ...SYSTEM_DIRS,
    ...userExtraDirs(home),
    ...cleanPathParts(existing)
  ];
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.join(import_node_path4.default.delimiter);
}
function applyHealthyPathToProcess() {
  process.env.PATH = buildAugmentedPath(process.env.PATH);
}
function withHealthyEnv(base = process.env) {
  const env = { ...base };
  env.PATH = buildAugmentedPath(base.PATH ?? process.env.PATH);
  env.BASH_ENV = "";
  env.ENV = "";
  return env;
}
function unwrapOuterQuotes(s) {
  const t = s.trim();
  if (t.length < 2) return t;
  const a = t[0];
  const b = t[t.length - 1];
  if (a === "'" && b === "'") {
    return t.slice(1, -1);
  }
  if (a === '"' && b === '"') {
    return t.slice(1, -1).replace(/\\([\\"`$])/g, "$1");
  }
  return t;
}
function stripLeadingPathExports(script) {
  let s = script.trimStart();
  for (let i = 0; i < 3; i++) {
    const m = s.match(
      /^export\s+PATH=(?:"[^"]*"|'[^']*'|[^\s;]+)\s*;?\s*/
    );
    if (!m) break;
    s = s.slice(m[0].length);
  }
  return s;
}
function stripBashCWrapper(script) {
  const t = script.trim();
  const m = t.match(/^(?:\/bin\/)?bash\s+-(l)?c\s+([\s\S]+)$/i);
  if (!m) return script;
  return unwrapOuterQuotes(m[2]);
}
function looksLikeGrokQuoteNest(s) {
  return s.includes(`'"`) || s.includes(`"'`);
}
function repairGrokBrokenShellEscapes(script) {
  let t = script.trim();
  if (!looksLikeGrokQuoteNest(t)) return t;
  if (t.startsWith("'")) {
    if (t.endsWith("'") && t.length >= 2) {
      const inner = t.slice(1, -1);
      if (looksLikeGrokQuoteNest(inner) || /[|]/.test(inner)) {
        t = inner;
      }
    } else {
      t = t.slice(1);
    }
  }
  t = t.replace(/'"'(.)'/g, "'$1'");
  t = t.replace(/"'"\\+n\\?"/g, '"\\n"');
  t = t.replace(/"'"\\+n"/g, '"\\n"');
  t = t.replace(/'\\+n'/g, "'\\n'");
  t = t.replace(/"\\+n"/g, '"\\n"');
  t = t.replace(/'"'"'/g, "'");
  t = t.replace(/'\"'\"'/g, "'");
  return t;
}
function demangleGrokShellWord(script) {
  const t = script.trim();
  if (!looksLikeGrokQuoteNest(t)) return t;
  const r = (0, import_node_child_process.spawnSync)("/bin/bash", ["--noprofile", "--norc"], {
    input: `set -- ${t}
printf '%s' "$1"
`,
    encoding: "utf8",
    env: withHealthyEnv(process.env)
  });
  if (r.status === 0 && typeof r.stdout === "string" && r.stdout.length > 0) {
    return r.stdout;
  }
  return repairGrokBrokenShellEscapes(t);
}
function bashHardenedArgs(script) {
  let body = demangleGrokShellWord(script.trim());
  body = stripLeadingPathExports(unwrapOuterQuotes(body));
  body = stripBashCWrapper(body);
  body = demangleGrokShellWord(body);
  body = stripLeadingPathExports(unwrapOuterQuotes(body));
  body = stripBashCWrapper(body);
  body = body.replace(/'(\r?\n)'/g, "'\\n'").replace(/"(\r?\n)"/g, '"\\n"');
  return {
    // -s: read script from stdin — no -c argv quoting battlefield
    args: ["--noprofile", "--norc", "-s"],
    stdinScript: body.endsWith("\n") ? body : `${body}
`,
    labelBody: body
  };
}
function bashSpec(script, healthyPath) {
  void healthyPath;
  const h = bashHardenedArgs(script);
  return {
    file: "/bin/bash",
    args: h.args,
    shell: false,
    label: `bash -s ${h.labelBody.slice(0, 40)}`,
    stdinScript: h.stdinScript
  };
}
function resolveToolSpawn(command, args, healthyPath) {
  const cmd = (command ?? "").trim();
  const a = args.map(String);
  if (/^(?:\/bin\/)?bash$/.test(cmd) && a.length >= 1 && /^-l?c$/.test(a[0])) {
    const script = a[1] ?? "";
    return bashSpec(script, healthyPath);
  }
  if (/^(?:\/bin\/)?bash$/.test(cmd) && a.length >= 1 && !/^-/.test(a[0])) {
    const script = a.length === 1 ? a[0] : a.join(" ");
    if (a.length > 1 || /[\s'"|&;<>$`]/.test(script)) {
      return bashSpec(script, healthyPath);
    }
  }
  const line = a.length === 0 ? cmd : "";
  if (line) {
    const m = line.match(/^(?:\/bin\/)?bash\s+-(l)?c\s+([\s\S]+)$/i);
    if (m) {
      return bashSpec(m[2], healthyPath);
    }
    if (/[\s'"|&;<>$`]/.test(line)) {
      return bashSpec(line, healthyPath);
    }
  }
  const file = cmd || "/bin/bash";
  const argv = a.length ? a : [];
  if (/[\s'"|&;<>$`]/.test(file)) {
    const script = argv.length ? `${file} ${argv.join(" ")}` : file;
    return bashSpec(script, healthyPath);
  }
  if (argv.some((x) => /[|&;<>]/.test(x) || x.includes("\n"))) {
    const script = [file, ...argv].join(" ");
    return bashSpec(script, healthyPath);
  }
  return {
    file,
    args: argv,
    shell: false,
    label: `${file} ${argv.join(" ")}`.trim().slice(0, 60)
  };
}

// ../bridge/src/grok-acp-adapter.ts
var GrokAcpAdapter = class {
  id = "grok-acp";
  proc = null;
  rl = null;
  nextId = 1;
  pending = /* @__PURE__ */ new Map();
  handlers = [];
  domainSessionId = "";
  providerSessionId = "";
  cwd = ".";
  model;
  effort;
  grokBin;
  closed = false;
  autoApprove;
  pendingPermissions = /* @__PURE__ */ new Map();
  /** 本会话用户消息，用于撤回 */
  userTurns = [];
  /** 当前 turn 是否已被用户取消（忽略后续 stream，直到下次 prompt） */
  turnCancelled = false;
  promptInFlight = false;
  /** Called when the child process dies unexpectedly (not after stop()). */
  deadHandlers = [];
  /**
   * While true, drop session/update notifications (legacy load-replay path;
   * resume now uses session/new + digest so absorb stays false in practice).
   */
  absorbUpdates = false;
  /** Resume digest preamble for first prompt after session/new. */
  contextPrefix = null;
  /** ACP terminal/create sessions */
  terminals = /* @__PURE__ */ new Map();
  constructor(opts) {
    this.grokBin = opts?.grokBin ?? process.env.GROK_BIN ?? `${process.env.HOME}/.grok/bin/grok`;
    this.autoApprove = opts?.autoApprove ?? process.env.AGENT_PANE_PERMISSION !== "ask";
  }
  onEvent(handler) {
    this.handlers.push(handler);
  }
  onDead(handler) {
    this.deadHandlers.push(handler);
  }
  /** Child still running and stdin open. */
  isAlive() {
    return Boolean(
      this.proc && !this.closed && this.proc.exitCode === null && this.proc.killed !== true && this.proc.stdin && !this.proc.stdin.destroyed
    );
  }
  emit(event) {
    for (const h of this.handlers) {
      try {
        h(event);
      } catch (e) {
        console.error("[adapter] handler error", e);
      }
    }
  }
  write(obj) {
    if (!this.proc?.stdin) return;
    this.proc.stdin.write(JSON.stringify(obj) + "\n");
  }
  send(method, params, timeoutMs = 12e4) {
    if (!this.proc?.stdin || this.closed) {
      return Promise.reject(new Error("Agent not started"));
    }
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        }
      });
    });
  }
  reply(id, result) {
    this.write({ jsonrpc: "2.0", id, result });
  }
  replyError(id, message, code = -32e3) {
    this.write({
      jsonrpc: "2.0",
      id,
      error: { code, message }
    });
  }
  handleLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id != null && msg.method == null) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      if (msg.id != null) {
        void this.handleServerRequest(msg.id, msg.method, msg.params);
      } else {
        this.handleNotification(msg.method, msg.params);
      }
    }
  }
  async handleServerRequest(id, method, params) {
    const p = params ?? {};
    try {
      if (method === "fs/read_text_file") {
        const filePath = String(p.path ?? "");
        const content = this.readTextFile(
          filePath,
          p.line,
          p.limit
        );
        this.reply(id, { content });
        return;
      }
      if (method === "fs/write_text_file") {
        const filePath = String(p.path ?? "");
        const content = String(p.content ?? "");
        this.writeTextFile(filePath, content);
        this.reply(id, null);
        this.emit({
          type: "ToolProgress",
          sessionId: this.domainSessionId,
          toolId: "fs-write",
          detail: `wrote ${filePath}`,
          at: nowIso()
        });
        return;
      }
      if (method === "session/request_permission" || method.endsWith("/request_permission")) {
        const options = p.options ?? [];
        const toolCall = p.toolCall ?? {};
        const tool = String(
          toolCall.title ?? toolCall.kind ?? p.tool ?? "tool"
        );
        const requestId = String(
          toolCall.toolCallId ?? p.requestId ?? id ?? (0, import_node_crypto.randomUUID)()
        );
        this.emit({
          type: "PermissionRequested",
          sessionId: this.domainSessionId,
          requestId,
          tool,
          summary: JSON.stringify(p).slice(0, 500),
          at: nowIso()
        });
        this.emitActivity(`Permission: ${tool}`, "permission");
        if (this.autoApprove) {
          const optionId = options.find((o) => o.kind === "allow_always")?.optionId ?? options.find((o) => o.kind === "allow_once")?.optionId ?? options[0]?.optionId ?? "allow-once";
          this.reply(id, {
            outcome: { outcome: "selected", optionId }
          });
          this.emit({
            type: "PermissionResolved",
            sessionId: this.domainSessionId,
            requestId,
            allow: true,
            at: nowIso()
          });
          this.emitActivity(null);
        } else {
          this.pendingPermissions.set(requestId, { rpcId: id, options });
        }
        return;
      }
      if (method === "terminal/create") {
        const termId = this.createTerminal(p);
        this.reply(id, { terminalId: termId });
        return;
      }
      if (method === "terminal/output") {
        const term = this.terminals.get(String(p.terminalId ?? ""));
        if (!term) {
          this.replyError(id, `Unknown terminal: ${p.terminalId}`);
          return;
        }
        this.reply(id, {
          output: term.output,
          truncated: term.truncated,
          exitStatus: term.exited ? { exitCode: term.exitCode, signal: term.signal } : null
        });
        return;
      }
      if (method === "terminal/wait_for_exit") {
        const term = this.terminals.get(String(p.terminalId ?? ""));
        if (!term) {
          this.replyError(id, `Unknown terminal: ${p.terminalId}`);
          return;
        }
        if (term.exited) {
          this.reply(id, { exitCode: term.exitCode, signal: term.signal });
          return;
        }
        await new Promise((resolve) => {
          term.waiters.push(resolve);
        });
        this.reply(id, { exitCode: term.exitCode, signal: term.signal });
        return;
      }
      if (method === "terminal/kill") {
        const term = this.terminals.get(String(p.terminalId ?? ""));
        if (term && !term.exited) {
          try {
            term.proc.kill("SIGTERM");
          } catch {
          }
        }
        this.reply(id, {});
        return;
      }
      if (method === "terminal/release") {
        const tid = String(p.terminalId ?? "");
        const term = this.terminals.get(tid);
        if (term) {
          if (!term.exited) {
            try {
              term.proc.kill("SIGTERM");
            } catch {
            }
          }
          this.terminals.delete(tid);
        }
        this.reply(id, {});
        return;
      }
      if (method === "_x.ai/auth/get_url" || method === "x.ai/auth/get_url") {
        const url = String(
          p.url ?? p.authUrl ?? ""
        );
        if (url) {
          this.emitActivity("Grok login \u2014 browser opened\u2026", "working");
          try {
            (0, import_node_child_process3.execFile)("open", [url], () => void 0);
          } catch (e) {
            console.warn("[adapter] open auth url failed", e);
          }
        }
        this.reply(id, { ok: true });
        return;
      }
      if (method === "_x.ai/auth/submit_code" || method === "x.ai/auth/submit_code") {
        this.reply(id, { ok: true });
        return;
      }
      console.warn("[adapter] unhandled server request", method);
      this.replyError(id, `Unsupported method: ${method}`, -32601);
    } catch (e) {
      this.replyError(
        id,
        e instanceof Error ? e.message : String(e)
      );
    }
  }
  readTextFile(filePath, line, limit) {
    if (!filePath) throw new Error("path required");
    const base = this.cwd && this.cwd !== "." ? this.cwd : process.cwd();
    const resolved = import_node_path6.default.isAbsolute(filePath) ? import_node_path6.default.normalize(filePath) : import_node_path6.default.resolve(base, filePath);
    if (!import_node_fs6.default.existsSync(resolved)) {
      throw new Error(`File not found: ${resolved}`);
    }
    if (isImagePath(resolved)) {
      const st = import_node_fs6.default.statSync(resolved);
      return `[Image file \u2014 not text]
path: ${resolved}
mime: ${guessMime(resolved)}
size: ${st.size} bytes
Do not use Read/read_file on images. If this image was attached by the user, it is already available as vision content in the conversation \u2014 describe it from that.`;
    }
    let text = import_node_fs6.default.readFileSync(resolved, "utf8");
    if (line != null || limit != null) {
      const lines = text.split("\n");
      const start = Math.max(0, (line ?? 1) - 1);
      const end = limit != null ? start + limit : lines.length;
      text = lines.slice(start, end).join("\n");
    }
    if (text.length > 2e6) {
      text = text.slice(0, 2e6) + "\n/* truncated */";
    }
    return text;
  }
  writeTextFile(filePath, content) {
    if (!filePath) throw new Error("path required");
    const base = this.cwd && this.cwd !== "." ? this.cwd : process.cwd();
    const resolved = import_node_path6.default.isAbsolute(filePath) ? import_node_path6.default.normalize(filePath) : import_node_path6.default.resolve(base, filePath);
    import_node_fs6.default.mkdirSync(import_node_path6.default.dirname(resolved), { recursive: true });
    import_node_fs6.default.writeFileSync(resolved, content, "utf8");
  }
  emitActivity(text, phase) {
    if (!this.domainSessionId) return;
    this.emit({
      type: "AgentActivity",
      sessionId: this.domainSessionId,
      text,
      phase,
      at: nowIso()
    });
  }
  /** Last context window size from agent (for compact_completed which only sends after). */
  lastContextSize = 0;
  /** Monotonic guard — signals can briefly point at the wrong session after resume. */
  lastContextUsed = 0;
  lastContextProviderId = "";
  turnAssistantText = "";
  signalsWatcher = null;
  stopSignalsWatcher() {
    this.signalsWatcher?.stop();
    this.signalsWatcher = null;
  }
  startSignalsWatcher() {
    this.stopSignalsWatcher();
    if (!this.providerSessionId || !this.cwd?.trim()) return;
    const paths = resolveGrokSignalsPaths(this.cwd, this.providerSessionId);
    if (paths.length === 0) return;
    this.signalsWatcher = new GrokSignalsWatcher(paths, (u) => {
      this.emitContextUsage(u.used, u.size, "signals", u.pct);
    });
    this.signalsWatcher.start();
  }
  /** Point watcher at a different Grok session id (e.g. from /session-info). */
  retargetProviderSession(nextId) {
    const id = nextId.trim();
    if (!id || id === this.providerSessionId) return;
    this.providerSessionId = id;
    this.lastContextUsed = 0;
    this.lastContextProviderId = id;
    this.startSignalsWatcher();
    this.publishSignalsUsageOnce();
  }
  /** One-shot read for SessionManager / HTTP (no watcher required). */
  publishSignalsUsageOnce() {
    if (!this.providerSessionId || !this.cwd?.trim()) return false;
    const u = readGrokSignalsUsage(
      resolveGrokSignalsPaths(this.cwd, this.providerSessionId)
    );
    if (!u) return false;
    this.emitContextUsage(u.used, u.size, "signals", u.pct);
    return true;
  }
  emitContextUsage(used, size, source, pct) {
    if (!this.domainSessionId) return;
    if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) return;
    const usedN = Math.max(0, Math.round(used));
    const sizeN = Math.max(1, Math.round(size));
    if (source === "signals" && this.lastContextProviderId === this.providerSessionId && this.lastContextUsed > 0 && usedN + 500 < this.lastContextUsed) {
      return;
    }
    this.lastContextSize = sizeN;
    this.lastContextUsed = usedN;
    this.lastContextProviderId = this.providerSessionId;
    this.emit({
      type: "ContextUsage",
      sessionId: this.domainSessionId,
      used: usedN,
      size: sizeN,
      source,
      pct: typeof pct === "number" && Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : Math.min(100, Math.round(usedN / sizeN * 100)),
      providerSessionId: this.providerSessionId || void 0,
      at: nowIso()
    });
  }
  /** Pull usage (+ optional session id) out of /session-info style replies. */
  ingestSessionInfoText(text) {
    if (!text || !/session\s*id|context\s*:/i.test(text)) return;
    const idMatch = text.match(
      /Session\s*ID\s*[:：]\s*\**\s*[`"]?(019f[0-9a-fA-F-]{20,}|[0-9a-f]{8}-[0-9a-f-]{27,})[`"]?/i
    );
    if (idMatch?.[1]) {
      this.retargetProviderSession(idMatch[1]);
    }
    const ctxMatch = text.match(
      /Context[\s\S]{0,48}?([\d,]+)\s*\/\s*([\d,]+)\s*tokens(?:\s*\((\d+)\s*%\))?/i
    );
    if (ctxMatch) {
      const used = Number(String(ctxMatch[1]).replace(/,/g, ""));
      const size = Number(String(ctxMatch[2]).replace(/,/g, ""));
      const pct = ctxMatch[3] != null ? Number(ctxMatch[3]) : void 0;
      if (Number.isFinite(used) && Number.isFinite(size) && size > 0) {
        this.emitContextUsage(used, size, "session_info", pct);
      }
    }
  }
  numField(v) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) {
      return Number(v);
    }
    return void 0;
  }
  createTerminal(p) {
    const id = `term-${(0, import_node_crypto.randomUUID)()}`;
    const command = String(p.command ?? "");
    const args = Array.isArray(p.args) ? p.args.map(String) : [];
    const cwd = typeof p.cwd === "string" && p.cwd ? p.cwd : this.cwd || process.cwd();
    const byteLimit = typeof p.outputByteLimit === "number" && p.outputByteLimit > 0 ? p.outputByteLimit : 1048576;
    const envList = Array.isArray(p.env) ? p.env : [];
    const env = withHealthyEnv(process.env);
    for (const e of envList) {
      if (e?.name) env[e.name] = String(e.value ?? "");
    }
    env.PATH = buildAugmentedPath(env.PATH);
    const spec = resolveToolSpawn(command, args, env.PATH);
    const proc = (0, import_node_child_process2.spawn)(spec.file, spec.args, {
      cwd,
      env: spec.env ? { ...env, ...spec.env } : env,
      shell: false,
      stdio: [
        spec.stdinScript != null ? "pipe" : "ignore",
        "pipe",
        "pipe"
      ]
    });
    if (spec.stdinScript != null && proc.stdin) {
      proc.stdin.write(spec.stdinScript);
      proc.stdin.end();
    }
    const term = {
      id,
      proc,
      output: "",
      truncated: false,
      exitCode: null,
      signal: null,
      exited: false,
      waiters: [],
      byteLimit
    };
    const append = (chunk) => {
      const s = chunk.toString("utf8");
      term.output += s;
      if (term.output.length > term.byteLimit) {
        term.output = term.output.slice(term.output.length - term.byteLimit);
        term.truncated = true;
      }
      const last = s.trim().split("\n").filter(Boolean).pop();
      if (last) {
        if (/command not found|bash_profile|zshrc|conda initialize/i.test(last)) {
          return;
        }
        this.emitActivity(
          last.length > 80 ? `${last.slice(0, 80)}\u2026` : last,
          "sleeping"
        );
      }
    };
    proc.stdout?.on("data", append);
    proc.stderr?.on("data", append);
    proc.on("error", (err) => {
      term.output += `
[spawn error] ${err.message}`;
      term.exitCode = 1;
      term.exited = true;
      for (const w of term.waiters.splice(0)) w();
    });
    proc.on("close", (code, signal) => {
      term.exitCode = code;
      term.signal = signal;
      term.exited = true;
      for (const w of term.waiters.splice(0)) w();
      this.emitActivity(null);
    });
    this.terminals.set(id, term);
    const label = spec.label;
    this.emitActivity(`Running ${label}${label.length >= 60 ? "\u2026" : ""}`, "tool");
    return id;
  }
  handleNotification(method, params) {
    const p = params ?? {};
    if (method === "session/update") {
      const update = p.update ?? p;
      this.mapSessionUpdate(update);
      return;
    }
    if (method === "_x.ai/sessions/changed" || method === "x.ai/sessions/changed") {
      const upserted = p.upserted ?? [];
      for (const u of upserted) {
        if (String(u.sessionId ?? "") !== this.providerSessionId) continue;
        const activity = String(u.activity ?? "");
        if (activity === "working") {
          this.emitActivity("Working\u2026", "working");
        } else if (activity === "idle") {
          this.emitActivity(null, "idle");
        }
      }
      return;
    }
    if (method === "_x.ai/queue/changed" || method === "x.ai/queue/changed") {
      if (String(p.sessionId ?? "") && String(p.sessionId) !== this.providerSessionId) {
        return;
      }
      const entries = p.entries ?? [];
      const running = p.runningPromptId ? String(p.runningPromptId) : "";
      const head = entries[0];
      if (head?.text?.trim().startsWith("/compact")) {
        this.emitActivity("Compacting conversation\u2026", "compact");
      } else if (running && head?.text) {
        this.emitActivity(
          `Queued: ${String(head.text).slice(0, 60)}`,
          "queue"
        );
      } else if (running) {
        this.emitActivity("Waiting for model\u2026", "working");
      }
      return;
    }
    if (method === "_x.ai/session_notification" || method === "x.ai/session_notification") {
      const update = p.update ?? p;
      const kind = String(update.sessionUpdate ?? "");
      if (kind === "tool_call_delta_chunk") {
        const toolId = String(update.tool_call_id ?? update.toolCallId ?? "delta");
        const name = String(update.name ?? "");
        const argDelta = update.arguments_delta;
        if (name && !name.startsWith("pending")) {
          this.emit({
            type: "ToolProgress",
            sessionId: this.domainSessionId,
            toolId,
            detail: name + (argDelta ? ` ${String(argDelta).slice(0, 120)}` : ""),
            at: nowIso()
          });
          this.emitActivity(`Calling ${name}\u2026`, "tool");
        }
      } else if (kind === "pending_interaction") {
        const ik = String(update.kind ?? "interaction");
        if (ik === "permission") {
          this.emitActivity("Waiting for permission\u2026", "permission");
        } else {
          this.emitActivity(`Waiting: ${ik}\u2026`, "working");
        }
      } else if (kind === "interaction_resolved") {
        this.emitActivity(null);
      } else if (kind === "auto_compact_started" || kind === "compact_started" || kind === "compacting") {
        this.emitActivity("Compacting conversation\u2026", "compact");
        const used = this.numField(update.tokens_used ?? update.tokensUsed);
        const size = this.numField(
          update.context_window ?? update.contextWindow
        );
        if (used != null && size != null) {
          this.emitContextUsage(used, size, "compact");
        }
      } else if (kind === "auto_compact_completed" || kind === "compact_completed") {
        const before = update.tokens_before ?? update.tokensBefore;
        const after = update.tokens_after ?? update.tokensAfter;
        const msg = before != null && after != null ? `Compacted \xB7 ${before} \u2192 ${after} tokens` : "Compact complete";
        this.emitActivity(msg, "compact");
        const afterN = this.numField(after);
        const size = this.numField(update.context_window ?? update.contextWindow) ?? (this.lastContextSize > 0 ? this.lastContextSize : void 0);
        if (afterN != null && size != null) {
          this.emitContextUsage(afterN, size, "compact_done");
        }
        setTimeout(() => this.emitActivity(null), 8e3);
      } else if (kind === "turn_completed") {
      } else if (kind === "session_summary_generated") {
      }
    }
  }
  mapSessionUpdate(update) {
    const kind = String(update.sessionUpdate ?? update.type ?? "");
    const sid = this.domainSessionId;
    const at = nowIso();
    if (this.absorbUpdates) {
      return;
    }
    if (this.turnCancelled && (kind === "agent_message_chunk" || kind === "agent_thought_chunk" || kind === "tool_call" || kind === "tool_call_update" || kind === "plan")) {
      return;
    }
    switch (kind) {
      case "agent_message_chunk": {
        const content = update.content;
        const text = content?.text ?? update.text ?? "";
        if (text) {
          this.turnAssistantText += text;
          if (/Session\s*ID|Context\s*:/i.test(this.turnAssistantText) && this.turnAssistantText.length < 2e4) {
            this.ingestSessionInfoText(this.turnAssistantText);
          }
          this.emit({
            type: "MessageChunk",
            sessionId: sid,
            role: "assistant",
            text,
            at
          });
        }
        break;
      }
      case "agent_thought_chunk": {
        const content = update.content;
        const text = content?.text ?? update.text ?? "";
        if (text) {
          this.emit({ type: "ThoughtChunk", sessionId: sid, text, at });
          this.emitActivity("Thinking\u2026", "thinking");
        }
        break;
      }
      case "tool_call": {
        const toolId = String(update.toolCallId ?? update.id ?? (0, import_node_crypto.randomUUID)());
        const title = String(update.title ?? update.kind ?? "tool");
        const toolKind = String(update.kind ?? "other");
        this.emit({
          type: "ToolStarted",
          sessionId: sid,
          toolId,
          title,
          kind: toolKind,
          inputSummary: summarize(update.rawInput ?? update.input ?? update.arguments),
          at
        });
        this.emitActivity(
          title.startsWith("Execute") || toolKind === "execute" ? `${title.slice(0, 72)}${title.length > 72 ? "\u2026" : ""}` : `Using ${title.slice(0, 60)}\u2026`,
          "tool"
        );
        break;
      }
      case "tool_call_update": {
        const toolId = String(update.toolCallId ?? update.id ?? "unknown");
        const status = String(update.status ?? "").toLowerCase();
        const title = update.title != null ? String(update.title) : void 0;
        const detail = summarize(update.content ?? update.rawOutput ?? update.output) || title || summarize(update);
        if (status === "failed" || status === "error") {
          this.emit({
            type: "ToolFailed",
            sessionId: sid,
            toolId,
            error: detail || "failed",
            at
          });
        } else if (status === "completed" || status === "success") {
          this.emit({
            type: "ToolFinished",
            sessionId: sid,
            toolId,
            outputSummary: detail,
            at
          });
        } else {
          this.emit({
            type: "ToolProgress",
            sessionId: sid,
            toolId,
            detail: detail || title,
            at
          });
          if (title && !status) {
          }
        }
        break;
      }
      case "plan": {
        const entries = update.entries ?? update.tasks ?? update.plan ?? [];
        const tasks = entries.map((e, i) => ({
          id: e.id ?? `task-${i}`,
          content: e.content ?? String(e),
          status: mapTaskStatus(e.status),
          source: "plan"
        }));
        this.emit({ type: "TasksReplaced", sessionId: sid, tasks, at });
        break;
      }
      case "usage_update": {
        const used = this.numField(update.used);
        const size = this.numField(update.size);
        if (used != null && size != null) {
          this.emitContextUsage(used, size, "acp");
        }
        break;
      }
      case "auto_compact_started":
      case "compact_started": {
        const used = this.numField(update.tokens_used ?? update.tokensUsed);
        const size = this.numField(
          update.context_window ?? update.contextWindow
        );
        if (used != null && size != null) {
          this.emitContextUsage(used, size, "compact");
        }
        this.emitActivity("Compacting conversation\u2026", "compact");
        break;
      }
      case "auto_compact_completed":
      case "compact_completed": {
        const after = this.numField(
          update.tokens_after ?? update.tokensAfter
        );
        const size = this.numField(update.context_window ?? update.contextWindow) ?? (this.lastContextSize > 0 ? this.lastContextSize : void 0);
        if (after != null && size != null) {
          this.emitContextUsage(after, size, "compact_done");
        }
        break;
      }
      default:
        break;
    }
  }
  async start(opts) {
    this.cwd = opts.cwd;
    this.model = opts.model;
    this.effort = opts.effort;
    this.closed = false;
    this.lastContextSize = 0;
    this.lastContextUsed = 0;
    this.lastContextProviderId = "";
    this.turnAssistantText = "";
    this.domainSessionId = opts.domainSessionId ?? (0, import_node_crypto.randomUUID)();
    if (opts.permissionMode === "default" || opts.permissionMode === "ask") {
      this.autoApprove = false;
    } else {
      this.autoApprove = true;
    }
    const agentArgs = ["agent"];
    if (opts.model) agentArgs.push("--model", opts.model);
    if (opts.effort) agentArgs.push("--effort", opts.effort);
    if (this.autoApprove) agentArgs.push("--always-approve");
    agentArgs.push("stdio");
    this.proc = (0, import_node_child_process2.spawn)(this.grokBin, agentArgs, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // Inherit bridge PATH (already augmented at boot); re-apply in case env was stripped.
      env: withHealthyEnv(process.env)
    });
    this.proc.stderr?.on("data", (buf) => {
      const line = buf.toString();
      try {
        const logDir = import_node_path6.default.join(
          process.env.HOME || "/tmp",
          ".agent-pane"
        );
        import_node_fs6.default.mkdirSync(logDir, { recursive: true });
        import_node_fs6.default.appendFileSync(
          import_node_path6.default.join(logDir, "grok-stderr.log"),
          `[${(/* @__PURE__ */ new Date()).toISOString()}] ${line.slice(0, 2e3)}`
        );
      } catch {
      }
      if (process.env.AGENT_PANE_DEBUG) {
        console.error("[grok stderr]", line.slice(0, 500));
      }
    });
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.handleLine(line));
    this.proc.on("exit", (code) => {
      const unexpected = !this.closed;
      this.proc = null;
      this.stopSignalsWatcher();
      if (unexpected) {
        this.emit({
          type: "SessionError",
          sessionId: this.domainSessionId,
          message: `grok agent exited (${code}) \u2014 send again to resume`,
          at: nowIso()
        });
        this.emit({
          type: "SessionEnded",
          sessionId: this.domainSessionId,
          stopReason: `exited:${code ?? "?"}`,
          at: nowIso()
        });
        for (const h of this.deadHandlers) {
          try {
            h(this.domainSessionId);
          } catch (e) {
            console.error("[adapter] onDead error", e);
          }
        }
      }
    });
    const init = await this.send("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        // Implemented: terminal/create|output|wait_for_exit|kill|release
        terminal: true
      },
      clientInfo: { name: "agent-pane", version: "0.1.2" }
    });
    const methods = Array.isArray(init?.authMethods) ? init.authMethods : [];
    const methodId = typeof init?._meta?.defaultAuthMethodId === "string" && init._meta.defaultAuthMethodId || methods.find((m) => typeof m?.id === "string" && m.id)?.id || (methods.length > 0 ? "grok.com" : null);
    this.absorbUpdates = false;
    const { browserMcpServers: browserMcpServers2 } = await Promise.resolve().then(() => (init_browser_mcp_config(), browser_mcp_config_exports));
    const wantMcp = process.env.AGENT_PANE_BROWSER_MCP !== "0" && !opts.resumed;
    const mcpServers = wantMcp ? browserMcpServers2() : [];
    const isAuthRequired = (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      return /Authentication required|auth_required|no auth method/i.test(msg);
    };
    const sessionNew = async (servers, timeoutMs) => await this.send(
      "session/new",
      { cwd: opts.cwd, mcpServers: servers },
      timeoutMs
    );
    const t0 = Date.now();
    let result;
    try {
      const firstTimeout = mcpServers.length > 0 ? 2e4 : 25e3;
      this.emitActivity("Connecting\u2026", "working");
      result = await sessionNew(mcpServers, firstTimeout);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (methodId && isAuthRequired(e)) {
        console.warn(
          `[adapter] session/new needs auth after ${Date.now() - t0}ms \u2014 authenticate once`
        );
        try {
          this.emitActivity("Grok login required\u2026", "working");
          await this.send("authenticate", { methodId }, 45e3);
        } catch (authErr) {
          this.emitActivity(null);
          const am = authErr instanceof Error ? authErr.message : String(authErr);
          throw new Error(
            `\u9700\u8981\u767B\u5F55 Grok\uFF08${am}\uFF09\u3002\u7EC8\u7AEF\u8DD1\uFF1Agrok login  \u7136\u540E\u56DE\u5230\u8FD9\u91CC\u518D Send\u3002`
          );
        }
        this.emitActivity("Connecting\u2026", "working");
        result = await sessionNew([], 25e3);
      } else if (mcpServers.length > 0 && /timed out/i.test(msg)) {
        console.warn(
          `[adapter] session/new with MCP timed out after ${Date.now() - t0}ms \u2014 retry without MCP`
        );
        this.emitActivity("Connecting\u2026", "working");
        result = await sessionNew([], 25e3);
      } else if (isAuthRequired(e)) {
        this.emitActivity(null);
        throw new Error(
          `\u9700\u8981\u767B\u5F55 Grok\u3002\u7EC8\u7AEF\u8DD1\uFF1Agrok login  \u7136\u540E\u56DE\u5230\u8FD9\u91CC\u518D Send\u3002\uFF08${msg}\uFF09`
        );
      } else {
        this.emitActivity(null);
        throw e;
      }
    }
    this.emitActivity(null);
    this.providerSessionId = result.sessionId ?? (0, import_node_crypto.randomUUID)();
    this.startSignalsWatcher();
    return {
      providerSessionId: this.providerSessionId,
      domainSessionId: this.domainSessionId,
      resumed: Boolean(opts.resumed),
      cwd: opts.cwd,
      model: opts.model,
      effort: opts.effort,
      /** Always need digest when resumed (we no longer session/load). */
      needsHistoryDigest: Boolean(opts.resumed)
    };
  }
  /** Optional preamble for first prompt after resume-without-load. */
  setContextPrefix(text) {
    this.contextPrefix = text && text.trim() ? text.trim() : null;
  }
  getSessionId() {
    return this.domainSessionId;
  }
  getProviderSessionId() {
    return this.providerSessionId;
  }
  async sendPrompt(input) {
    if (!this.isAlive()) {
      this.emit({
        type: "SessionError",
        sessionId: this.domainSessionId,
        message: "grok agent not running \u2014 send again to resume",
        at: nowIso()
      });
      throw new Error("agent not alive");
    }
    this.absorbUpdates = false;
    let promptText = input.text;
    if (this.contextPrefix) {
      promptText = `${this.contextPrefix}

---

${input.text}`;
      this.contextPrefix = null;
    }
    const blocks = [
      { type: "text", text: promptText }
    ];
    const attachments = stabilizeAttachments(input.attachments);
    const imageNames = [];
    if (attachments?.length) {
      for (const a of attachments) {
        const abs = a.path;
        const name = import_node_path6.default.basename(abs);
        if (a.kind !== "folder" && isImagePath(abs) && import_node_fs6.default.existsSync(abs)) {
          try {
            const buf = import_node_fs6.default.readFileSync(abs);
            if (buf.length <= 12 * 1024 * 1024) {
              blocks.push({
                type: "image",
                mimeType: guessMime(abs),
                data: buf.toString("base64")
              });
              imageNames.push(name);
            }
          } catch {
          }
        }
        blocks.push({
          type: "resource_link",
          uri: `file://${abs}`,
          name
        });
      }
    }
    if (imageNames.length) {
      blocks.push({
        type: "text",
        text: `[Attached image${imageNames.length > 1 ? "s" : ""}: ${imageNames.join(", ")}. Vision content is already included above \u2014 look at the image(s) directly. Do NOT call Read/read_file on these image paths (binary files).]`
      });
    }
    const shown = input.displayText ?? input.text;
    this.turnCancelled = false;
    this.promptInFlight = true;
    this.turnAssistantText = "";
    if (!input.skipUserEvent) {
      this.userTurns.push(shown);
      this.emit({
        type: "UserMessageAppended",
        sessionId: this.domainSessionId,
        text: shown,
        attachments,
        at: nowIso()
      });
    }
    if (shown.trim().startsWith("/compact")) {
      this.emitActivity("Compacting conversation\u2026", "compact");
    } else if (shown.trim().startsWith("/")) {
      this.emitActivity(`Running ${shown.trim().split(/\s+/)[0]}\u2026`, "working");
    } else {
      this.emitActivity("Waiting for model\u2026", "working");
    }
    try {
      const result = await this.send("session/prompt", {
        sessionId: this.providerSessionId,
        prompt: blocks
      });
      this.promptInFlight = false;
      this.emitActivity(null);
      const stop = result?.stopReason ?? "end_turn";
      if (stop === "cancelled" || this.turnCancelled) {
        this.emit({
          type: "MessageDone",
          sessionId: this.domainSessionId,
          role: "assistant",
          at: nowIso()
        });
        return;
      }
      this.emit({
        type: "MessageDone",
        sessionId: this.domainSessionId,
        role: "assistant",
        at: nowIso()
      });
      this.ingestSessionInfoText(this.turnAssistantText);
      this.turnAssistantText = "";
      this.signalsWatcher?.refresh();
      setTimeout(() => this.signalsWatcher?.refresh(), 400);
      setTimeout(() => this.signalsWatcher?.refresh(), 1200);
    } catch (e) {
      this.promptInFlight = false;
      if (this.turnCancelled) {
        this.emit({
          type: "MessageDone",
          sessionId: this.domainSessionId,
          role: "assistant",
          at: nowIso()
        });
        this.signalsWatcher?.refresh();
        return;
      }
      this.emit({
        type: "SessionError",
        sessionId: this.domainSessionId,
        message: e instanceof Error ? e.message : String(e),
        at: nowIso()
      });
    }
  }
  /**
   * 取消当前 turn。
   * ACP 规定 session/cancel 是 **notification（无 id）**，
   * 若带 id 当 request 发，Grok 会回 Method not found，生成不会停。
   */
  async cancel(_sessionId) {
    this.turnCancelled = true;
    for (const [requestId, pending] of this.pendingPermissions) {
      this.reply(pending.rpcId, { outcome: { outcome: "cancelled" } });
      this.emit({
        type: "PermissionResolved",
        sessionId: this.domainSessionId,
        requestId,
        allow: false,
        at: nowIso()
      });
    }
    this.pendingPermissions.clear();
    if (this.providerSessionId) {
      this.write({
        jsonrpc: "2.0",
        method: "session/cancel",
        params: { sessionId: this.providerSessionId }
      });
    }
    if (this.promptInFlight) {
      this.emit({
        type: "MessageDone",
        sessionId: this.domainSessionId,
        role: "assistant",
        at: nowIso()
      });
    }
  }
  /**
   * Discard user turn `userTurnIndex` and everything after (Claude Code Undo).
   * 1) cancel in-flight turn
   * 2) best-effort Grok `_x.ai/rewind/*` to that prompt index
   * 3) always emit SessionRewound so UI + event store can truncate
   */
  async rewindToUserTurn(userTurnIndex) {
    if (this.userTurns.length === 0) {
      throw new Error("Nothing to undo");
    }
    if (!Number.isFinite(userTurnIndex) || userTurnIndex < 0 || userTurnIndex >= this.userTurns.length) {
      throw new Error("Invalid turn to undo");
    }
    await this.cancel(this.domainSessionId);
    const restoredText = this.userTurns[userTurnIndex];
    let providerOk = false;
    let note;
    try {
      const pts = await this.send("_x.ai/rewind/points", {
        sessionId: this.providerSessionId
      });
      const points = pts?.rewind_points ?? [];
      if (points.length === 0) {
        note = "UI undid the turn; Grok had no rewind point";
      } else {
        let target = points[userTurnIndex] ?? points.find((p) => {
          const preview = (p.prompt_preview ?? "").trim();
          return preview && restoredText.trim().startsWith(preview.slice(0, 40));
        }) ?? null;
        if (!target && points.length === this.userTurns.length) {
          target = points[userTurnIndex] ?? null;
        }
        if (!target && userTurnIndex === this.userTurns.length - 1) {
          target = points[points.length - 1] ?? null;
        }
        if (!target) {
          const offset = points.length - this.userTurns.length;
          if (offset >= 0 && points[offset + userTurnIndex]) {
            target = points[offset + userTurnIndex];
          }
        }
        if (!target) {
          note = "UI undid the turn; could not map Grok rewind point \u2014 model may still recall later messages";
        } else {
          const result = await this.send("_x.ai/rewind/execute", {
            sessionId: this.providerSessionId,
            target_prompt_index: target.prompt_index,
            mode: "conversation_only"
          });
          if (result?.success) {
            providerOk = true;
            note = void 0;
          } else {
            note = "UI undid the turn; Grok rewind not confirmed \u2014 model may still recall later messages";
            try {
              await this.send("_x.ai/rewind/execute", {
                sessionId: this.providerSessionId,
                target_prompt_index: target.prompt_index,
                mode: "all"
              });
            } catch {
            }
          }
        }
      }
    } catch (e) {
      note = `UI undid the turn; Grok rewind failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    this.userTurns = this.userTurns.slice(0, userTurnIndex);
    this.emit({
      type: "SessionRewound",
      sessionId: this.domainSessionId,
      restoredText,
      userTurnIndex,
      providerOk,
      note,
      at: nowIso()
    });
    return { restoredText, userTurnIndex, providerOk, note };
  }
  /**
   * 撤回上一条用户消息 — thin wrapper around rewindToUserTurn.
   */
  async undoLastTurn() {
    if (this.userTurns.length === 0) {
      throw new Error("Nothing to undo");
    }
    const r = await this.rewindToUserTurn(this.userTurns.length - 1);
    return {
      restoredText: r.restoredText,
      providerOk: r.providerOk,
      note: r.note
    };
  }
  /** Rebuild turn list after resume / history hydrate. */
  hydrateUserTurns(texts) {
    this.userTurns = texts.filter((t) => typeof t === "string");
  }
  /**
   * Weekly credit usage / billing snapshot (Grok TUI `/usage`).
   * Not advertised in available_commands under ACP — pager-only there;
   * exposed via extension `_x.ai/billing`.
   */
  async fetchBillingUsage() {
    if (!this.isAlive() || !this.providerSessionId) {
      throw new Error("agent not alive");
    }
    const result = await this.send("_x.ai/billing", {
      sessionId: this.providerSessionId
    });
    const cfg = result?.config ?? {};
    const period = cfg.currentPeriod ?? {};
    const numVal = (v) => {
      if (typeof v === "number") return v;
      if (v && typeof v === "object" && "val" in v) {
        const n = Number(v.val);
        return Number.isFinite(n) ? n : void 0;
      }
      return void 0;
    };
    return {
      creditUsagePercent: typeof cfg.creditUsagePercent === "number" ? cfg.creditUsagePercent : void 0,
      periodType: typeof period.type === "string" ? period.type : void 0,
      periodStart: (typeof period.start === "string" ? period.start : void 0) ?? (typeof cfg.billingPeriodStart === "string" ? cfg.billingPeriodStart : void 0),
      periodEnd: (typeof period.end === "string" ? period.end : void 0) ?? (typeof cfg.billingPeriodEnd === "string" ? cfg.billingPeriodEnd : void 0),
      subscriptionTier: result?.subscription_tier,
      onDemandCap: numVal(cfg.onDemandCap),
      onDemandUsed: numVal(cfg.onDemandUsed),
      prepaidBalance: numVal(cfg.prepaidBalance),
      raw: result
    };
  }
  /** Show a local system-style reply without hitting the model. */
  emitLocalReply(userText, assistantText) {
    const at = nowIso();
    this.userTurns.push(userText);
    this.emit({
      type: "UserMessageAppended",
      sessionId: this.domainSessionId,
      text: userText,
      at
    });
    this.emit({
      type: "MessageChunk",
      sessionId: this.domainSessionId,
      role: "assistant",
      text: assistantText,
      at
    });
    this.emit({
      type: "MessageDone",
      sessionId: this.domainSessionId,
      role: "assistant",
      at: nowIso()
    });
  }
  hasPendingPermission(requestId) {
    return this.pendingPermissions.has(requestId);
  }
  async respondPermission(requestId, allow) {
    const pending = this.pendingPermissions.get(requestId);
    this.emit({
      type: "PermissionResolved",
      sessionId: this.domainSessionId,
      requestId,
      allow,
      at: nowIso()
    });
    if (!pending) return;
    this.pendingPermissions.delete(requestId);
    const optionId = allow ? pending.options.find((o) => o.kind === "allow_once")?.optionId ?? pending.options.find((o) => o.kind?.startsWith("allow"))?.optionId ?? "allow-once" : pending.options.find((o) => o.kind === "reject_once")?.optionId ?? pending.options.find((o) => o.kind?.startsWith("reject"))?.optionId ?? "reject-once";
    this.reply(pending.rpcId, {
      outcome: allow ? { outcome: "selected", optionId } : { outcome: "selected", optionId }
    });
  }
  async stop() {
    this.closed = true;
    this.stopSignalsWatcher();
    for (const term of this.terminals.values()) {
      if (!term.exited) {
        try {
          term.proc.kill("SIGTERM");
        } catch {
        }
      }
    }
    this.terminals.clear();
    this.rl?.close();
    this.proc?.kill();
    this.proc = null;
    if (this.domainSessionId) {
      this.emit({
        type: "SessionEnded",
        sessionId: this.domainSessionId,
        stopReason: "client_stop",
        at: nowIso()
      });
    }
  }
};
function summarize(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.slice(0, 12e3);
  const unwrapped = unwrapAcpText(v);
  if (unwrapped) return unwrapped.slice(0, 12e3);
  try {
    return JSON.stringify(v).slice(0, 12e3);
  } catch {
    return String(v).slice(0, 12e3);
  }
}
function unwrapAcpText(v) {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object") return "";
  if (Array.isArray(v)) {
    const parts = [];
    for (const item of v) {
      const t = unwrapAcpText(item);
      if (t) parts.push(t);
    }
    return parts.join("\n").trim();
  }
  const o = v;
  if (typeof o.text === "string" && o.text.trim()) return o.text;
  if (o.content != null) {
    const inner = unwrapAcpText(o.content);
    if (inner) return inner;
  }
  for (const key of ["message", "error", "output", "rawOutput"]) {
    const x = o[key];
    if (typeof x === "string" && x.trim()) return x;
    if (x && typeof x === "object") {
      const inner = unwrapAcpText(x);
      if (inner) return inner;
    }
  }
  return "";
}
function mapTaskStatus(s) {
  const x = (s ?? "pending").toLowerCase();
  if (x.includes("progress") || x === "active") return "in_progress";
  if (x.includes("complete") || x === "done") return "completed";
  if (x.includes("cancel")) return "cancelled";
  return "pending";
}

// ../bridge/src/workspace-snapshot.ts
var import_node_child_process4 = require("node:child_process");
var import_node_fs7 = __toESM(require("node:fs"), 1);
var import_node_path7 = __toESM(require("node:path"), 1);
var import_node_os5 = __toESM(require("node:os"), 1);
var import_node_crypto2 = require("node:crypto");
function hashFile(abs) {
  try {
    if (!import_node_fs7.default.existsSync(abs)) return "missing";
    const st = import_node_fs7.default.statSync(abs);
    if (st.isDirectory()) return `dir:${st.mtimeMs}`;
    const buf = import_node_fs7.default.readFileSync(abs);
    return (0, import_node_crypto2.createHash)("sha256").update(buf).digest("hex");
  } catch {
    return "error";
  }
}
function loadSnapshotFingerprints(snapshot) {
  if (!snapshot) return null;
  const root = snapshot.kind === "files" ? snapshot.ref : import_node_path7.default.join(
    process.env.HOME || import_node_os5.default.homedir(),
    ".agent-pane",
    "snapshots",
    snapshot.snapshotId
  );
  const fpPath = import_node_path7.default.join(root, "fingerprints.json");
  try {
    if (import_node_fs7.default.existsSync(fpPath)) {
      const obj = JSON.parse(import_node_fs7.default.readFileSync(fpPath, "utf8"));
      return new Map(Object.entries(obj));
    }
  } catch {
  }
  const filesDir = import_node_path7.default.join(root, "files");
  const map = /* @__PURE__ */ new Map();
  if (!import_node_fs7.default.existsSync(filesDir)) return map;
  const walk = (dir, prefix) => {
    for (const name of import_node_fs7.default.readdirSync(dir)) {
      const abs = import_node_path7.default.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      try {
        if (import_node_fs7.default.statSync(abs).isDirectory()) walk(abs, rel);
        else map.set(rel, hashFile(abs));
      } catch {
      }
    }
  };
  walk(filesDir, "");
  return map;
}
function isGitRepo(cwd) {
  try {
    (0, import_node_child_process4.execFileSync)("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      stdio: ["ignore", "pipe", "ignore"]
    });
    return true;
  } catch {
    return false;
  }
}
function git(cwd, args) {
  return (0, import_node_child_process4.execFileSync)("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 20 * 1024 * 1024
  }).trim();
}
var WorkspaceSnapshotService = class {
  snapshots = /* @__PURE__ */ new Map();
  root;
  constructor(root) {
    this.root = root ?? import_node_path7.default.join(import_node_os5.default.homedir(), ".agent-pane", "snapshots");
    import_node_fs7.default.mkdirSync(this.root, { recursive: true });
  }
  take(sessionId, cwd) {
    const snapshotId = (0, import_node_crypto2.randomUUID)();
    const dir = import_node_path7.default.join(this.root, snapshotId);
    import_node_fs7.default.mkdirSync(dir, { recursive: true });
    if (isGitRepo(cwd)) {
      let head = "UNBORN";
      try {
        head = git(cwd, ["rev-parse", "HEAD"]);
      } catch {
        head = "UNBORN";
      }
      const status = git(cwd, ["status", "--porcelain", "-uall"]);
      import_node_fs7.default.writeFileSync(import_node_path7.default.join(dir, "head"), head, "utf8");
      import_node_fs7.default.writeFileSync(import_node_path7.default.join(dir, "status.txt"), status, "utf8");
      const meta2 = {
        snapshotId,
        cwd,
        kind: "git",
        ref: head
      };
      import_node_fs7.default.writeFileSync(import_node_path7.default.join(dir, "meta.json"), JSON.stringify(meta2, null, 2));
      const fingerprints = {};
      for (const line of status.split("\n").filter(Boolean)) {
        const p = line.slice(3).trim().split(" -> ").pop();
        const abs = import_node_path7.default.join(cwd, p);
        if (import_node_fs7.default.existsSync(abs) && import_node_fs7.default.statSync(abs).isFile()) {
          const dest = import_node_path7.default.join(dir, "files", p);
          import_node_fs7.default.mkdirSync(import_node_path7.default.dirname(dest), { recursive: true });
          try {
            import_node_fs7.default.copyFileSync(abs, dest);
            fingerprints[p] = hashFile(abs);
          } catch {
          }
        } else {
          fingerprints[p] = "missing";
        }
      }
      import_node_fs7.default.writeFileSync(
        import_node_path7.default.join(dir, "fingerprints.json"),
        JSON.stringify(fingerprints, null, 2),
        "utf8"
      );
      this.snapshots.set(sessionId, meta2);
      return meta2;
    }
    const meta = {
      snapshotId,
      cwd,
      kind: "files",
      ref: dir
    };
    import_node_fs7.default.writeFileSync(import_node_path7.default.join(dir, "meta.json"), JSON.stringify(meta, null, 2));
    this.snapshots.set(sessionId, meta);
    return meta;
  }
  get(sessionId) {
    return this.snapshots.get(sessionId);
  }
  /** Reject: restore workspace to session baseline for given paths or all. */
  restore(sessionId, filePath) {
    const snap = this.snapshots.get(sessionId);
    if (!snap) throw new Error("No snapshot for session");
    const dir = import_node_path7.default.join(this.root, snap.snapshotId);
    const cwd = snap.cwd;
    if (snap.kind === "git") {
      if (filePath === "*") {
        try {
          git(cwd, ["checkout", "--", "."]);
          git(cwd, ["clean", "-fd"]);
        } catch {
        }
      } else {
        try {
          git(cwd, ["checkout", "HEAD", "--", filePath]);
        } catch {
          const abs = import_node_path7.default.join(cwd, filePath);
          if (import_node_fs7.default.existsSync(abs)) import_node_fs7.default.rmSync(abs, { force: true });
        }
        try {
          const status = git(cwd, ["status", "--porcelain", "--", filePath]);
          if (status.startsWith("??")) {
            import_node_fs7.default.rmSync(import_node_path7.default.join(cwd, filePath), { force: true });
          }
        } catch {
        }
      }
      const filesRoot = import_node_path7.default.join(dir, "files");
      if (import_node_fs7.default.existsSync(filesRoot)) {
        const restoreOne = (rel) => {
          const src = import_node_path7.default.join(filesRoot, rel);
          const dest = import_node_path7.default.join(cwd, rel);
          if (!import_node_fs7.default.existsSync(src)) return;
          import_node_fs7.default.mkdirSync(import_node_path7.default.dirname(dest), { recursive: true });
          import_node_fs7.default.copyFileSync(src, dest);
        };
        if (filePath === "*") {
          const walk = (d, prefix = "") => {
            for (const name of import_node_fs7.default.readdirSync(d)) {
              const p = import_node_path7.default.join(d, name);
              const rel = prefix ? `${prefix}/${name}` : name;
              if (import_node_fs7.default.statSync(p).isDirectory()) walk(p, rel);
              else restoreOne(rel);
            }
          };
          walk(filesRoot);
        } else {
          restoreOne(filePath);
        }
      }
      return;
    }
    throw new Error("Non-git snapshot restore is limited in v1; use a git workspace");
  }
  /** Accept: re-take baseline as current worktree. */
  advance(sessionId) {
    const prev = this.snapshots.get(sessionId);
    if (!prev) throw new Error("No snapshot for session");
    return this.take(sessionId, prev.cwd);
  }
};

// ../bridge/src/diff-engine.ts
var import_node_child_process5 = require("node:child_process");
var import_node_fs8 = __toESM(require("node:fs"), 1);
var import_node_path8 = __toESM(require("node:path"), 1);
var import_node_crypto3 = require("node:crypto");
function git2(cwd, args) {
  try {
    return (0, import_node_child_process5.execFileSync)("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 30 * 1024 * 1024
    });
  } catch (e) {
    const err = e;
    return err.stdout ?? "";
  }
}
function countDiffStats(patch) {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
  }
  return { additions, deletions };
}
function fileFingerprint(cwd, relPath) {
  const abs = import_node_path8.default.join(cwd, relPath);
  try {
    if (!import_node_fs8.default.existsSync(abs)) return "missing";
    const st = import_node_fs8.default.statSync(abs);
    if (st.isDirectory()) return `dir:${st.mtimeMs}`;
    const buf = import_node_fs8.default.readFileSync(abs);
    return (0, import_node_crypto3.createHash)("sha256").update(buf).digest("hex");
  } catch {
    return "error";
  }
}
var DiffEngine = class {
  compute(cwd, snapshot) {
    try {
      (0, import_node_child_process5.execFileSync)("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd,
        stdio: ["ignore", "pipe", "ignore"]
      });
    } catch {
      return [];
    }
    const status = git2(cwd, ["status", "--porcelain", "-uall"]);
    if (!status.trim()) return [];
    const baseline = loadSnapshotFingerprints(snapshot);
    const files = [];
    for (const line of status.split("\n").filter(Boolean)) {
      const xy = line.slice(0, 2);
      let filePath = line.slice(3).trim();
      if (filePath.includes(" -> ")) {
        filePath = filePath.split(" -> ").pop();
      }
      if (baseline) {
        const nowFp = fileFingerprint(cwd, filePath);
        const baseFp = baseline.get(filePath);
        if (baseFp != null && baseFp === nowFp) {
          continue;
        }
      }
      let statusKind = "modified";
      if (xy.includes("A") || xy === "??") statusKind = "added";
      else if (xy.includes("D")) statusKind = "deleted";
      else if (xy.includes("R")) statusKind = "renamed";
      let patch = "";
      if (xy === "??") {
        patch = git2(cwd, ["diff", "--no-index", "--", "/dev/null", filePath]);
      } else {
        patch = git2(cwd, ["diff", "HEAD", "--", filePath]);
        if (!patch.trim()) {
          patch = git2(cwd, ["diff", "--cached", "HEAD", "--", filePath]);
        }
      }
      const { additions, deletions } = countDiffStats(patch);
      files.push({
        path: filePath,
        status: statusKind,
        additions,
        deletions,
        patch: patch.slice(0, 2e5)
      });
    }
    return files;
  }
};

// ../bridge/src/session-manager.ts
init_history_index();
function modeUsesAlwaysApprove(mode) {
  const m = mode.toLowerCase();
  return m === "agent" || m === "debug" || m === "multitask" || m === "always" || m === "always-approve" || m === "yolo";
}
function normalizePermissionMode(mode) {
  const m = (mode ?? "agent").toLowerCase();
  if (m === "plan") return "plan";
  if (m === "auto" || m === "ask") return "auto";
  return "agent";
}
function buildHistoryDigest(sessionId, maxTurns = 12) {
  const events = loadSessionEvents(sessionId, true);
  if (!events.length) return "";
  const lines = [
    "[Conversation resume context \u2014 this is a continued chat in the same UI session.",
    "Stay in character and continue from the last turns. Do not claim you are starting fresh.]"
  ];
  let turns = 0;
  let assistantBuf = "";
  const flushAssistant = () => {
    const t = assistantBuf.trim();
    if (!t) return;
    const clipped = t.length > 1200 ? `${t.slice(0, 1200)}\u2026` : t;
    lines.push(`Assistant: ${clipped}`);
    assistantBuf = "";
  };
  for (const e of events) {
    if (e.type === "UserMessageAppended") {
      flushAssistant();
      turns++;
      if (turns > maxTurns) {
        const header = lines.slice(0, 2);
        const body = lines.slice(2);
        const keep = body.slice(-maxTurns * 2);
        lines.length = 0;
        lines.push(...header, ...keep);
      }
      lines.push(`User: ${e.text.slice(0, 800)}`);
    } else if (e.type === "MessageChunk") {
      assistantBuf += e.text;
    } else if (e.type === "MessageDone") {
      flushAssistant();
    }
  }
  flushAssistant();
  if (lines.length <= 2) return "";
  return lines.join("\n");
}
var SessionManager = class {
  store;
  snapshots;
  diffEngine;
  live = /* @__PURE__ */ new Map();
  broadcast;
  permissionMode;
  /** Serialize create/resume only — prompts must run concurrently across sessions */
  globalQueue = Promise.resolve();
  sessionQueues = /* @__PURE__ */ new Map();
  constructor(opts) {
    this.store = opts.store ?? new EventStore();
    this.snapshots = new WorkspaceSnapshotService();
    this.diffEngine = new DiffEngine();
    this.broadcast = opts.broadcast;
    this.permissionMode = opts.permissionMode ?? "auto";
  }
  /** Tell UI which sessions currently have a live agent */
  broadcastLive() {
    this.broadcast({
      type: "live",
      sessionIds: [...this.live.keys()]
    });
  }
  listLiveSessionIds() {
    return [...this.live.keys()];
  }
  /**
   * Resolve live agent handle for a Pane sessionId.
   * Used by HTTP context-usage: prefer live provider id over meta / event archaeology.
   */
  getLiveSessionInfo(sessionId) {
    const live = this.live.get(sessionId);
    if (!live) return null;
    return {
      cwd: live.cwd || "",
      providerSessionId: live.providerSessionId,
      alive: live.adapter.isAlive()
    };
  }
  enqueueGlobal(fn) {
    const run = this.globalQueue.then(fn);
    this.globalQueue = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  enqueueSession(sessionId, fn) {
    const prev = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    const run = prev.then(fn);
    this.sessionQueues.set(
      sessionId,
      run.then(
        () => void 0,
        () => void 0
      )
    );
    return run;
  }
  publish(event) {
    if (event.type === "SessionStarted" && event.resumed) {
      const live = this.live.get(event.sessionId);
      if (live && event.providerSessionId) {
        live.providerSessionId = event.providerSessionId;
      }
      if (event.providerSessionId) {
        upsertMeta({
          sessionId: event.sessionId,
          cwd: event.cwd,
          providerSessionId: event.providerSessionId
        });
      }
      const ephemeral = { ...event, seq: 0 };
      this.broadcast({ type: "event", event: ephemeral });
      return ephemeral;
    }
    if (event.type === "SessionRewound") {
      try {
        this.store.truncateBeforeUserTurn(
          event.sessionId,
          event.userTurnIndex
        );
      } catch {
      }
      invalidateSessionEventsCache(event.sessionId);
      try {
        const kept = this.store.list(event.sessionId, 0);
        const msgCount = kept.filter((e) => e.type === "UserMessageAppended").length;
        const live = this.live.get(event.sessionId);
        const prev = readMeta(event.sessionId);
        if (prev) {
          writeMeta({
            ...prev,
            cwd: live?.cwd || prev.cwd,
            messageCount: msgCount,
            updatedAt: (/* @__PURE__ */ new Date()).toISOString()
          });
          invalidateHistoryListCache();
        }
      } catch {
      }
      const ephemeral = { ...event, seq: 0 };
      this.broadcast({ type: "event", event: ephemeral });
      return ephemeral;
    }
    const stored = this.store.append(event);
    this.broadcast({ type: "event", event: stored });
    invalidateSessionEventsCache(event.sessionId);
    if (event.type === "UserMessageAppended") {
      const live = this.live.get(event.sessionId);
      upsertMeta({
        sessionId: event.sessionId,
        cwd: live?.cwd,
        title: event.text,
        bumpMessage: true,
        providerSessionId: live?.providerSessionId
      });
    } else if (event.type === "SessionStarted" && event.providerSessionId) {
      const live = this.live.get(event.sessionId);
      if (live) live.providerSessionId = event.providerSessionId;
    }
    return stored;
  }
  /** Stop a live agent (if any) so disk delete won't race with writes. */
  async stopSession(sessionId) {
    const s = this.live.get(sessionId);
    if (!s) return;
    try {
      await s.adapter.stop();
    } catch {
    }
    this.live.delete(sessionId);
    this.broadcastLive();
    this.store.purge(sessionId);
  }
  /** After disk delete: purge store even if session was not live. */
  purgeSession(sessionId) {
    this.live.delete(sessionId);
    this.store.purge(sessionId);
    this.broadcastLive();
  }
  async handleCommand(cmd) {
    if (cmd.type === "session.create" || cmd.type === "session.resume") {
      await this.enqueueGlobal(() => this.handleCommandInner(cmd));
      return;
    }
    const sid = "sessionId" in cmd && typeof cmd.sessionId === "string" ? cmd.sessionId : null;
    if (sid) {
      await this.enqueueSession(sid, () => this.handleCommandInner(cmd));
      return;
    }
    await this.handleCommandInner(cmd);
  }
  async handleCommandInner(cmd) {
    switch (cmd.type) {
      case "session.create":
        await this.createSession(
          cmd.cwd,
          cmd.model,
          cmd.permissionMode ?? this.permissionMode,
          cmd.effort,
          cmd.clientRequestId
        );
        break;
      case "session.resume":
        await this.resumeSession({
          sessionId: cmd.sessionId,
          cwd: cmd.cwd,
          model: cmd.model,
          effort: cmd.effort,
          permissionMode: cmd.permissionMode ?? this.permissionMode
        });
        break;
      case "session.prompt":
        await this.prompt(
          cmd.sessionId,
          cmd.text,
          cmd.attachments,
          cmd.permissionMode
        );
        break;
      case "session.cancel":
        await this.live.get(cmd.sessionId)?.adapter.cancel(cmd.sessionId);
        break;
      case "session.undoLast": {
        const live = this.live.get(cmd.sessionId);
        if (!live) {
          this.rewindOffline(cmd.sessionId, -1);
          break;
        }
        try {
          await live.adapter.undoLastTurn();
        } catch (e) {
          this.broadcast({
            type: "error",
            message: e instanceof Error ? e.message : String(e)
          });
        }
        break;
      }
      case "session.rewindTo": {
        const live = this.live.get(cmd.sessionId);
        if (!live) {
          this.rewindOffline(cmd.sessionId, cmd.userTurnIndex);
          break;
        }
        try {
          this.hydrateAdapterTurns(live.adapter, cmd.sessionId);
          await live.adapter.rewindToUserTurn(cmd.userTurnIndex);
        } catch (e) {
          this.broadcast({
            type: "error",
            message: e instanceof Error ? e.message : String(e)
          });
        }
        break;
      }
      case "session.replay": {
        const events = this.store.list(cmd.sessionId, cmd.fromSeq ?? 0);
        this.broadcast({
          type: "replay",
          sessionId: cmd.sessionId,
          events
        });
        break;
      }
      case "permission.respond": {
        const sid = cmd.sessionId;
        if (sid) {
          const live = this.live.get(sid);
          if (live) {
            await live.adapter.respondPermission(cmd.requestId, cmd.allow);
            break;
          }
        }
        for (const s of this.live.values()) {
          if (s.adapter.hasPendingPermission(cmd.requestId)) {
            await s.adapter.respondPermission(cmd.requestId, cmd.allow);
            break;
          }
        }
        break;
      }
      case "diff.accept":
        await this.diffAccept(cmd.sessionId, cmd.filePath);
        break;
      case "diff.reject":
        await this.diffReject(cmd.sessionId, cmd.filePath);
        break;
      case "diff.refresh":
        this.refreshDiff(cmd.sessionId);
        break;
      default:
        break;
    }
  }
  hydrateAdapterTurns(adapter, sessionId) {
    const texts = this.store.list(sessionId, 0).filter((e) => e.type === "UserMessageAppended").map((e) => e.text ?? "");
    adapter.hydrateUserTurns(texts);
  }
  /**
   * History-only / dead agent rewind: truncate events + broadcast SessionRewound.
   * `userTurnIndex` -1 means last user turn.
   */
  rewindOffline(sessionId, userTurnIndex) {
    const events = this.store.list(sessionId, 0);
    const userTexts = events.filter((e) => e.type === "UserMessageAppended").map((e) => e.text ?? "");
    if (userTexts.length === 0) {
      this.broadcast({ type: "error", message: "Nothing to undo" });
      return;
    }
    const idx = userTurnIndex < 0 ? userTexts.length - 1 : Math.floor(userTurnIndex);
    if (idx < 0 || idx >= userTexts.length) {
      this.broadcast({ type: "error", message: "Invalid turn to undo" });
      return;
    }
    this.publish({
      type: "SessionRewound",
      sessionId,
      restoredText: userTexts[idx],
      userTurnIndex: idx,
      providerOk: false,
      note: "UI undid the turn (agent not attached)",
      at: nowIso()
    });
  }
  /**
   * Stop live adapters (optional cwd filter). Kept for explicit teardown —
   * create/resume no longer call this so multiple agents can run in parallel.
   */
  async stopLiveSessions(filterCwd) {
    const entries = [...this.live.entries()];
    for (const [id, s] of entries) {
      if (filterCwd && s.cwd !== filterCwd) continue;
      try {
        await s.adapter.stop();
      } catch {
      }
      this.live.delete(id);
    }
    this.broadcastLive();
  }
  wireAdapter(adapter) {
    adapter.onEvent((e) => {
      this.publish(e);
      if (e.type === "ContextUsage" && e.providerSessionId) {
        const live = this.live.get(e.sessionId);
        if (live && live.providerSessionId !== e.providerSessionId) {
          live.providerSessionId = e.providerSessionId;
          try {
            upsertMeta({
              sessionId: e.sessionId,
              cwd: live.cwd,
              providerSessionId: e.providerSessionId
            });
          } catch {
          }
        }
      }
      if (e.type === "ToolFinished" || e.type === "MessageDone") {
        const sid = e.sessionId;
        setTimeout(() => this.refreshDiff(sid), 300);
      }
    });
    adapter.onDead((domainSessionId) => {
      const s = this.live.get(domainSessionId);
      if (s?.adapter === adapter) {
        this.live.delete(domainSessionId);
        this.broadcastLive();
      }
    });
  }
  async createSession(cwd, model, permissionMode, effort, clientRequestId) {
    const mode = normalizePermissionMode(
      permissionMode ?? this.permissionMode ?? "agent"
    );
    this.permissionMode = mode;
    this.broadcast({
      type: "status",
      message: "Starting Grok agent\u2026",
      clientRequestId
    });
    const adapter = new GrokAcpAdapter({
      autoApprove: modeUsesAlwaysApprove(mode)
    });
    this.wireAdapter(adapter);
    let started;
    try {
      started = await adapter.start({
        cwd,
        model,
        effort,
        // adapter maps ask/default → no --always-approve; else always-approve
        permissionMode: modeUsesAlwaysApprove(mode) ? "auto" : "ask"
      });
    } catch (e) {
      this.broadcast({
        type: "error",
        message: `Start failed: ${e instanceof Error ? e.message : String(e)}`,
        clientRequestId
      });
      return;
    }
    const domainSessionId = started.domainSessionId;
    const providerSessionId = started.providerSessionId;
    this.live.set(domainSessionId, {
      domainSessionId,
      cwd,
      model,
      effort,
      permissionMode: mode,
      providerSessionId,
      adapter,
      acceptedFp: /* @__PURE__ */ new Map()
    });
    this.broadcastLive();
    this.publish({
      type: "SessionStarted",
      sessionId: domainSessionId,
      cwd,
      model,
      resumed: false,
      providerSessionId,
      clientRequestId,
      at: nowIso()
    });
    try {
      adapter.publishSignalsUsageOnce?.();
    } catch {
    }
    if (readMeta(domainSessionId)) {
      upsertMeta({ sessionId: domainSessionId, cwd, providerSessionId });
    }
    try {
      pruneDraftSessions({ keepSessionId: domainSessionId, cwd });
    } catch {
    }
    try {
      const snap = this.snapshots.take(domainSessionId, cwd);
      this.publish({
        type: "SnapshotTaken",
        sessionId: domainSessionId,
        snapshotId: snap.snapshotId,
        at: nowIso()
      });
    } catch (e) {
      this.publish({
        type: "SessionError",
        sessionId: domainSessionId,
        message: `Snapshot failed: ${e instanceof Error ? e.message : e}`,
        at: nowIso()
      });
    }
    this.refreshDiff(domainSessionId);
  }
  /**
   * Re-attach a live Grok agent to an existing history session so follow-ups
   * continue the same conversation (same domain sessionId on disk).
   */
  async resumeSession(opts) {
    const { sessionId, cwd } = opts;
    const existing = this.live.get(sessionId);
    if (existing?.adapter.isAlive()) {
      this.broadcast({
        type: "event",
        event: {
          type: "SessionStarted",
          sessionId,
          cwd: existing.cwd,
          model: existing.model,
          resumed: true,
          providerSessionId: existing.providerSessionId,
          at: nowIso()
        }
      });
      return;
    }
    if (existing) {
      try {
        await existing.adapter.stop();
      } catch {
      }
      this.live.delete(sessionId);
    }
    const mode = normalizePermissionMode(
      opts.permissionMode ?? this.permissionMode ?? "agent"
    );
    this.permissionMode = mode;
    const meta = readMeta(sessionId);
    const providerSessionId = meta?.providerSessionId ?? existing?.providerSessionId;
    this.broadcast({
      type: "status",
      message: "Resuming session\u2026",
      sessionId
    });
    const adapter = new GrokAcpAdapter({
      autoApprove: modeUsesAlwaysApprove(mode)
    });
    this.wireAdapter(adapter);
    const resumeCwd = cwd || meta?.cwd || existing?.cwd || "";
    const resumeModel = opts.model ?? existing?.model;
    const resumeEffort = opts.effort ?? existing?.effort;
    let started;
    try {
      started = await adapter.start({
        cwd: resumeCwd,
        model: resumeModel,
        effort: resumeEffort,
        permissionMode: modeUsesAlwaysApprove(mode) ? "auto" : "ask",
        domainSessionId: sessionId,
        // Bookkeeping only — start() always session/new + digest (session/load hangs).
        providerSessionId,
        resumed: true
      });
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const hint = /timed out/i.test(raw) && !/登录|login|Authentication|认证/i.test(raw) ? "\uFF08\u53EF\u518D\u70B9 Send \u91CD\u8BD5\uFF09" : "";
      this.broadcast({
        type: "error",
        message: `Resume failed: ${raw}${hint}`,
        sessionId
      });
      return;
    }
    const loadedProvider = started.providerSessionId;
    const digest = buildHistoryDigest(sessionId);
    if (digest) adapter.setContextPrefix(digest);
    this.live.set(sessionId, {
      domainSessionId: sessionId,
      cwd: resumeCwd,
      model: resumeModel,
      effort: resumeEffort,
      permissionMode: mode,
      providerSessionId: loadedProvider,
      adapter,
      acceptedFp: /* @__PURE__ */ new Map()
    });
    this.broadcastLive();
    this.hydrateAdapterTurns(adapter, sessionId);
    this.publish({
      type: "SessionStarted",
      sessionId,
      cwd: resumeCwd,
      model: resumeModel,
      resumed: true,
      providerSessionId: loadedProvider,
      at: nowIso()
    });
    try {
      adapter.publishSignalsUsageOnce?.();
    } catch {
    }
    upsertMeta({
      sessionId,
      cwd: resumeCwd,
      providerSessionId: loadedProvider
    });
    try {
      const snap = this.snapshots.take(sessionId, resumeCwd);
      this.publish({
        type: "SnapshotTaken",
        sessionId,
        snapshotId: snap.snapshotId,
        at: nowIso()
      });
    } catch {
    }
    this.refreshDiff(sessionId);
  }
  async prompt(sessionId, text, attachments, permissionMode) {
    let live = this.live.get(sessionId);
    if (!live || !live.adapter.isAlive()) {
      const meta = readMeta(sessionId);
      await this.resumeSession({
        sessionId,
        cwd: live?.cwd || meta?.cwd || "",
        model: live?.model,
        effort: live?.effort,
        permissionMode: permissionMode ?? live?.permissionMode
      });
      live = this.live.get(sessionId);
      if (!live || !live.adapter.isAlive()) {
        this.broadcast({
          type: "error",
          message: "Session disconnected \u2014 resume failed, try Send again"
        });
        return;
      }
    }
    if (permissionMode) {
      live.permissionMode = normalizePermissionMode(permissionMode);
    }
    const slashName = text.trim().match(/^\/([a-zA-Z][\w-]*)/)?.[1]?.toLowerCase();
    if (slashName === "usage" || slashName === "billing") {
      try {
        this.broadcast({ type: "status", message: "Fetching usage\u2026" });
        const u = await live.adapter.fetchBillingUsage();
        const pct = u.creditUsagePercent != null ? `${Math.round(u.creditUsagePercent)}%` : "\u2014";
        const fmtDate = (iso) => {
          if (!iso) return "\u2014";
          try {
            return new Date(iso).toLocaleString(void 0, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit"
            });
          } catch {
            return iso;
          }
        };
        const periodLabel = u.periodType?.includes("WEEKLY") || u.periodType?.includes("weekly") ? "Weekly" : u.periodType?.replace(/^USAGE_PERIOD_TYPE_/, "") || "Current";
        const barFilled = Math.min(
          20,
          Math.max(0, Math.round((u.creditUsagePercent ?? 0) / 5))
        );
        const bar = "\u2588".repeat(barFilled) + "\u2591".repeat(Math.max(0, 20 - barFilled));
        const lines = [
          `**Usage \xB7 ${u.subscriptionTier || "Grok"}**`,
          "",
          `${periodLabel} credits: **${pct}** used`,
          `\`${bar}\``,
          "",
          `Period: ${fmtDate(u.periodStart)} \u2192 ${fmtDate(u.periodEnd)}`
        ];
        if (u.onDemandCap != null || u.onDemandUsed != null) {
          lines.push(
            `On-demand: ${u.onDemandUsed ?? 0} / ${u.onDemandCap ?? "\u2014"}`
          );
        }
        if (u.prepaidBalance != null && u.prepaidBalance !== 0) {
          lines.push(`Prepaid balance: ${u.prepaidBalance}`);
        }
        lines.push("", "_Source: Grok `_x.ai/billing` (same as TUI `/usage`)._");
        this.broadcast({
          type: "notice",
          kind: "usage",
          title: `Usage \xB7 ${u.subscriptionTier || "Grok"}`,
          body: lines.join("\n")
        });
        this.broadcast({ type: "status", message: " " });
      } catch (e) {
        this.broadcast({
          type: "error",
          message: `Usage lookup failed: ${e instanceof Error ? e.message : String(e)}`
        });
      }
      return;
    }
    let body = text;
    const isSlash = /^\s*\/[a-zA-Z]/.test(text);
    if (live.permissionMode === "plan" && !isSlash) {
      body = "[Plan mode active: do NOT edit, create, or delete files. Research if needed, then produce a clear step-by-step plan only. Wait for approval before any implementation.]\n\n" + text;
    }
    try {
      await live.adapter.sendPrompt({
        sessionId,
        text: body,
        displayText: text,
        attachments
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/not alive|EPIPE|exited|disconnect/i.test(msg)) {
        this.live.delete(sessionId);
        const meta = readMeta(sessionId);
        await this.resumeSession({
          sessionId,
          cwd: live.cwd || meta?.cwd || "",
          model: live.model,
          effort: live.effort,
          permissionMode: live.permissionMode
        });
        const again = this.live.get(sessionId);
        if (again?.adapter.isAlive()) {
          await again.adapter.sendPrompt({
            sessionId,
            text: body,
            displayText: text,
            attachments,
            // UserMessage already recorded on first attempt (or not — if
            // fail-before-emit, skipUserEvent false would be safer; we only
            // get here after emit for RPC failures, so skip duplicate).
            skipUserEvent: !/not alive/i.test(msg)
          });
          return;
        }
      }
      this.broadcast({
        type: "error",
        message: msg || "Prompt failed"
      });
    }
  }
  refreshDiff(sessionId) {
    const live = this.live.get(sessionId);
    if (!live) return;
    const snap = this.snapshots.get(sessionId);
    let files = this.diffEngine.compute(live.cwd, snap);
    files = files.filter((f) => {
      const accepted = live.acceptedFp.get(f.path);
      if (!accepted) return true;
      const now = fileFingerprint(live.cwd, f.path);
      return now !== accepted;
    });
    this.publish({
      type: "DiffProposed",
      sessionId,
      files,
      at: nowIso()
    });
  }
  async diffAccept(sessionId, filePath) {
    const live = this.live.get(sessionId);
    if (!live) {
      this.broadcast({ type: "error", message: "Unknown session \u2014 \u65B0\u5F00\u4F1A\u8BDD\u540E\u518D Accept" });
      return;
    }
    try {
      const snap = this.snapshots.get(sessionId);
      const current = this.diffEngine.compute(live.cwd, snap);
      const targets = filePath === "*" ? current.map((f) => f.path) : [filePath];
      for (const p of targets) {
        live.acceptedFp.set(p, fileFingerprint(live.cwd, p));
      }
      try {
        this.snapshots.advance(sessionId);
      } catch {
      }
      this.publish({
        type: "DiffResolved",
        sessionId,
        filePath,
        action: "accept",
        at: nowIso()
      });
      const after = this.snapshots.get(sessionId);
      if (after) {
        this.publish({
          type: "SnapshotTaken",
          sessionId,
          snapshotId: after.snapshotId,
          at: nowIso()
        });
      }
      this.refreshDiff(sessionId);
    } catch (e) {
      this.publish({
        type: "SessionError",
        sessionId,
        message: e instanceof Error ? e.message : String(e),
        at: nowIso()
      });
    }
  }
  async diffReject(sessionId, filePath) {
    const live = this.live.get(sessionId);
    if (!live) {
      this.broadcast({ type: "error", message: "Unknown session \u2014 \u65B0\u5F00\u4F1A\u8BDD\u540E\u518D Reject" });
      return;
    }
    try {
      if (filePath === "*") {
        live.acceptedFp.clear();
      } else {
        live.acceptedFp.delete(filePath);
      }
      this.snapshots.restore(sessionId, filePath);
      this.publish({
        type: "SnapshotRestored",
        sessionId,
        snapshotId: this.snapshots.get(sessionId)?.snapshotId ?? "",
        at: nowIso()
      });
      this.publish({
        type: "DiffResolved",
        sessionId,
        filePath,
        action: "reject",
        at: nowIso()
      });
      this.refreshDiff(sessionId);
    } catch (e) {
      this.publish({
        type: "SessionError",
        sessionId,
        message: e instanceof Error ? e.message : String(e),
        at: nowIso()
      });
    }
  }
};

// ../bridge/src/http-api.ts
var import_node_child_process6 = require("node:child_process");
var import_node_fs12 = __toESM(require("node:fs"), 1);
var import_node_os9 = __toESM(require("node:os"), 1);
var import_node_path12 = __toESM(require("node:path"), 1);
var import_node_util = require("node:util");
init_history_index();

// ../bridge/src/customize-config.ts
var import_node_fs10 = __toESM(require("node:fs"), 1);
var import_node_os7 = __toESM(require("node:os"), 1);
var import_node_path10 = __toESM(require("node:path"), 1);
var GROK_DIR = import_node_path10.default.join(import_node_os7.default.homedir(), ".grok");
var RULES_DIR = import_node_path10.default.join(GROK_DIR, "rules");
var HOOKS_DIR = import_node_path10.default.join(GROK_DIR, "hooks");
var MEMORY_INDEX = import_node_path10.default.join(GROK_DIR, "memory", "MEMORY.md");
var GROK_CONFIG = import_node_path10.default.join(GROK_DIR, "config.toml");
var CURSOR_MCP = import_node_path10.default.join(import_node_os7.default.homedir(), ".cursor", "mcp.json");
var SAFE_RULE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}\.md$/;
var SAFE_HOOK_JSON = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}\.json$/;
var SAFE_HOOK_SCRIPT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}\.(sh|py|js|mjs|cjs|ts)$/;
var SECRET_ENV_RE = /(KEY|TOKEN|SECRET|PASSWORD|AUTH)/i;
var MASK = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
function ensureParent(file) {
  import_node_fs10.default.mkdirSync(import_node_path10.default.dirname(file), { recursive: true });
}
function maskEnvValue(key, value) {
  if (!SECRET_ENV_RE.test(key)) return value;
  if (!value) return "";
  if (value.length <= 4) return MASK;
  return `${value.slice(0, 3)}${MASK}`;
}
function isMasked(value) {
  return value.includes("\u2022") || value === MASK;
}
function listCustomizeFiles() {
  const out = [];
  if (import_node_fs10.default.existsSync(MEMORY_INDEX)) {
    try {
      out.push({
        id: "memory:MEMORY.md",
        name: "MEMORY.md",
        path: MEMORY_INDEX,
        kind: "memory",
        content: import_node_fs10.default.readFileSync(MEMORY_INDEX, "utf8")
      });
    } catch {
    }
  }
  try {
    if (import_node_fs10.default.existsSync(RULES_DIR)) {
      const names = import_node_fs10.default.readdirSync(RULES_DIR).filter((n) => SAFE_RULE_NAME.test(n)).sort();
      for (const name of names) {
        const p = import_node_path10.default.join(RULES_DIR, name);
        try {
          const st = import_node_fs10.default.statSync(p);
          if (!st.isFile()) continue;
          out.push({
            id: `rule:${name}`,
            name,
            path: p,
            kind: "rule",
            content: import_node_fs10.default.readFileSync(p, "utf8")
          });
        } catch {
        }
      }
    }
  } catch {
  }
  return out;
}
function writeCustomizeFile(id, content) {
  if (typeof content !== "string") {
    throw new Error("content must be a string");
  }
  if (content.length > 512e3) {
    throw new Error("file too large (max 512KB)");
  }
  if (id === "memory:MEMORY.md") {
    ensureParent(MEMORY_INDEX);
    import_node_fs10.default.writeFileSync(MEMORY_INDEX, content, "utf8");
    return {
      id,
      name: "MEMORY.md",
      path: MEMORY_INDEX,
      kind: "memory",
      content
    };
  }
  const m = id.match(/^rule:(.+)$/);
  if (!m) throw new Error("unknown file id");
  const name = m[1];
  if (!SAFE_RULE_NAME.test(name)) throw new Error("invalid rule name");
  ensureParent(import_node_path10.default.join(RULES_DIR, name));
  const p = import_node_path10.default.join(RULES_DIR, name);
  if (import_node_path10.default.resolve(p) !== import_node_path10.default.resolve(RULES_DIR, name)) {
    throw new Error("invalid path");
  }
  import_node_fs10.default.writeFileSync(p, content, "utf8");
  return { id, name, path: p, kind: "rule", content };
}
function parseTomlStringArray(raw) {
  const m = raw.match(/^\s*args\s*=\s*\[([\s\S]*?)\]/m);
  if (!m) return void 0;
  const inner = m[1];
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g;
  let hit;
  while (hit = re.exec(inner)) {
    out.push((hit[1] ?? hit[2] ?? "").replace(/\\"/g, '"'));
  }
  return out;
}
function parseGrokMcp(raw) {
  const servers = /* @__PURE__ */ new Map();
  const sectionRe = /^\[mcp_servers\.([^\]]+)\]\s*$/gm;
  const indices = [];
  let sm;
  while (sm = sectionRe.exec(raw)) {
    indices.push({
      name: sm[1],
      start: sm.index,
      headerEnd: sm.index + sm[0].length
    });
  }
  for (let i = 0; i < indices.length; i++) {
    const cur = indices[i];
    const end = i + 1 < indices.length ? indices[i + 1].start : raw.length;
    const body = raw.slice(cur.headerEnd, end);
    const isEnv = cur.name.endsWith(".env");
    const baseName = isEnv ? cur.name.slice(0, -".env".length) : cur.name;
    let server2 = servers.get(baseName);
    if (!server2) {
      server2 = { name: baseName, enabled: true, env: {} };
      servers.set(baseName, server2);
    }
    if (isEnv) {
      const envRe = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:\\.|[^"\\])*)"/gm;
      let em;
      while (em = envRe.exec(body)) {
        const key = em[1];
        const val = em[2].replace(/\\"/g, '"');
        server2.env[key] = maskEnvValue(key, val);
      }
    } else {
      const enabled = body.match(/^\s*enabled\s*=\s*(true|false)\s*$/m);
      if (enabled) server2.enabled = enabled[1] === "true";
      const command = body.match(/^\s*command\s*=\s*"((?:\\.|[^"\\])*)"/m);
      if (command) server2.command = command[1].replace(/\\"/g, '"');
      const args = parseTomlStringArray(body);
      if (args) server2.args = args;
    }
  }
  return [...servers.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function loadCustomizeMcp() {
  let grok = [];
  if (import_node_fs10.default.existsSync(GROK_CONFIG)) {
    try {
      grok = parseGrokMcp(import_node_fs10.default.readFileSync(GROK_CONFIG, "utf8"));
    } catch {
      grok = [];
    }
  }
  let cursorJson = '{\n  "mcpServers": {}\n}\n';
  if (import_node_fs10.default.existsSync(CURSOR_MCP)) {
    try {
      const raw = import_node_fs10.default.readFileSync(CURSOR_MCP, "utf8");
      const parsed = JSON.parse(raw);
      cursorJson = `${JSON.stringify(parsed, null, 2)}
`;
    } catch {
      cursorJson = import_node_fs10.default.readFileSync(CURSOR_MCP, "utf8");
    }
  }
  return {
    grokConfigPath: GROK_CONFIG,
    cursorMcpPath: CURSOR_MCP,
    grok,
    cursorJson
  };
}
function findTomlSection(raw, sectionHeader) {
  const header = `[${sectionHeader}]`;
  const re = new RegExp(
    `^\\[${sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*$`,
    "m"
  );
  const m = re.exec(raw);
  if (!m || m.index === void 0) return null;
  const start = m.index;
  const headerEnd = start + m[0].length;
  const rest = raw.slice(headerEnd);
  const next = rest.search(/\n\s*\[[^\]]+\]/);
  const end = next >= 0 ? headerEnd + next : raw.length;
  return { start, headerEnd, end };
}
function setTomlKeyInSection(raw, sectionHeader, key, line) {
  const found = findTomlSection(raw, sectionHeader);
  if (!found) {
    const block = `
[${sectionHeader}]
${line}
`;
    return raw.endsWith("\n") ? raw + block : `${raw}
${block}`;
  }
  const { headerEnd, end } = found;
  const before = raw.slice(0, headerEnd);
  let body = raw.slice(headerEnd, end);
  const after = raw.slice(end);
  const keyRe = new RegExp(`^\\s*${key}\\s*=\\s*.*$`, "m");
  if (keyRe.test(body)) {
    body = body.replace(keyRe, line);
  } else {
    if (!body.startsWith("\n")) body = `
${body}`;
    body = body.replace(/^\n/, `
${line}
`);
  }
  if (!body.startsWith("\n")) body = `
${body}`;
  return before + body + after;
}
function setTomlEnvString(raw, serverName, key, value) {
  const section = `mcp_servers.${serverName}.env`;
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const line = `${key} = "${escaped}"`;
  return setTomlKeyInSection(raw, section, key, line);
}
function patchGrokMcp(patches) {
  if (!Array.isArray(patches) || patches.length === 0) {
    return loadCustomizeMcp();
  }
  let raw = import_node_fs10.default.existsSync(GROK_CONFIG) ? import_node_fs10.default.readFileSync(GROK_CONFIG, "utf8") : "";
  for (const patch of patches) {
    const name = String(patch.name || "").trim();
    if (!name || /[\[\]]/.test(name)) throw new Error("invalid server name");
    if (typeof patch.enabled === "boolean") {
      raw = setTomlKeyInSection(
        raw,
        `mcp_servers.${name}`,
        "enabled",
        `enabled = ${patch.enabled}`
      );
    }
    if (patch.env && typeof patch.env === "object") {
      for (const [k, v] of Object.entries(patch.env)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
        if (typeof v !== "string") continue;
        if (SECRET_ENV_RE.test(k) && isMasked(v)) continue;
        if (SECRET_ENV_RE.test(k) && !v.trim()) continue;
        raw = setTomlEnvString(raw, name, k, v);
      }
    }
  }
  ensureParent(GROK_CONFIG);
  import_node_fs10.default.writeFileSync(GROK_CONFIG, raw, "utf8");
  return loadCustomizeMcp();
}
function writeCursorMcp(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(
      `invalid JSON: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("mcp.json root must be an object");
  }
  const obj = parsed;
  if (!("mcpServers" in obj) || typeof obj.mcpServers !== "object") {
    throw new Error('mcp.json must contain an "mcpServers" object');
  }
  const pretty = `${JSON.stringify(parsed, null, 2)}
`;
  ensureParent(CURSOR_MCP);
  import_node_fs10.default.writeFileSync(CURSOR_MCP, pretty, "utf8");
  return loadCustomizeMcp();
}
function parseHookEvents(content) {
  try {
    const parsed = JSON.parse(content);
    if (!parsed?.hooks || typeof parsed.hooks !== "object") return [];
    return Object.keys(parsed.hooks).sort();
  } catch {
    return [];
  }
}
function resolveHookPath(name) {
  const p = import_node_path10.default.join(HOOKS_DIR, name);
  if (import_node_path10.default.resolve(p) !== import_node_path10.default.resolve(HOOKS_DIR, name)) {
    throw new Error("invalid path");
  }
  return p;
}
function listCustomizeHooks() {
  const files = [];
  try {
    if (!import_node_fs10.default.existsSync(HOOKS_DIR)) {
      return { hooksDir: HOOKS_DIR, files: [] };
    }
    const names = import_node_fs10.default.readdirSync(HOOKS_DIR).sort();
    for (const name of names) {
      const isJson = SAFE_HOOK_JSON.test(name);
      const isScript = SAFE_HOOK_SCRIPT.test(name);
      if (!isJson && !isScript) continue;
      const p = import_node_path10.default.join(HOOKS_DIR, name);
      try {
        const st = import_node_fs10.default.statSync(p);
        if (!st.isFile()) continue;
        const content = import_node_fs10.default.readFileSync(p, "utf8");
        files.push({
          id: name,
          name,
          path: p,
          kind: isJson ? "json" : "script",
          content,
          events: isJson ? parseHookEvents(content) : []
        });
      } catch {
      }
    }
  } catch {
  }
  return { hooksDir: HOOKS_DIR, files };
}
function validateHookJson(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new Error(
      `invalid JSON: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("hook file root must be an object");
  }
  const obj = parsed;
  if (!("hooks" in obj) || typeof obj.hooks !== "object" || obj.hooks === null) {
    throw new Error('hook file must contain a "hooks" object');
  }
  return `${JSON.stringify(parsed, null, 2)}
`;
}
function writeCustomizeHook(name, content) {
  if (typeof content !== "string") throw new Error("content must be a string");
  if (content.length > 512e3) throw new Error("file too large (max 512KB)");
  const trimmed = String(name || "").trim();
  const isJson = SAFE_HOOK_JSON.test(trimmed);
  const isScript = SAFE_HOOK_SCRIPT.test(trimmed);
  if (!isJson && !isScript) {
    throw new Error(
      "invalid name (use name.json or name.sh|py|js|mjs|cjs|ts)"
    );
  }
  let body = content;
  if (isJson) {
    body = validateHookJson(content);
  }
  import_node_fs10.default.mkdirSync(HOOKS_DIR, { recursive: true });
  const p = resolveHookPath(trimmed);
  import_node_fs10.default.writeFileSync(p, body, { encoding: "utf8", mode: isScript ? 493 : 420 });
  if (isScript) {
    try {
      import_node_fs10.default.chmodSync(p, 493);
    } catch {
    }
  }
  return {
    id: trimmed,
    name: trimmed,
    path: p,
    kind: isJson ? "json" : "script",
    content: body,
    events: isJson ? parseHookEvents(body) : []
  };
}
function deleteCustomizeHook(name) {
  const trimmed = String(name || "").trim();
  if (!SAFE_HOOK_JSON.test(trimmed) && !SAFE_HOOK_SCRIPT.test(trimmed)) {
    throw new Error("invalid name");
  }
  const p = resolveHookPath(trimmed);
  if (!import_node_fs10.default.existsSync(p)) throw new Error("file not found");
  import_node_fs10.default.unlinkSync(p);
}
function defaultHookTemplate(nameBase) {
  const safe = nameBase.replace(/[^a-zA-Z0-9._-]/g, "-") || "my-hook";
  return `${JSON.stringify(
    {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: `echo '[${safe}] session start in' "$(pwd)"`,
                timeout: 5
              }
            ]
          }
        ]
      }
    },
    null,
    2
  )}
`;
}

// ../bridge/src/http-api.ts
var execFileAsync = (0, import_node_util.promisify)(import_node_child_process6.execFile);
var recentPath = import_node_path12.default.join(import_node_os9.default.homedir(), ".agent-pane", "recent.json");
function parseSkillFrontmatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const block = m[1];
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
  let description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (description?.startsWith('"') || description?.startsWith("'")) {
    description = description.replace(/^["']|["']$/g, "");
  } else if (description?.startsWith("|") || description?.startsWith(">")) {
    description = description.replace(/^[|>]-?\s*/, "");
  }
  if (!description || description === "|" || description === ">") {
    const multi = block.match(
      /^description:\s*[|>]-?\s*\n((?:[ \t]+.+\n?)+)/m
    );
    if (multi) {
      description = multi[1].split("\n").map((l) => l.replace(/^[ \t]+/, "")).join(" ").trim();
    }
  }
  return { name, description };
}
function listSkills(cwd) {
  const roots = [
    { dir: import_node_path12.default.join(import_node_os9.default.homedir(), ".grok", "skills"), source: "user-grok" },
    { dir: import_node_path12.default.join(import_node_os9.default.homedir(), ".claude", "skills"), source: "user-claude" },
    { dir: import_node_path12.default.join(import_node_os9.default.homedir(), ".cursor", "skills"), source: "user-cursor" }
  ];
  if (cwd) {
    roots.unshift(
      { dir: import_node_path12.default.join(cwd, ".grok", "skills"), source: "project-grok" },
      { dir: import_node_path12.default.join(cwd, ".claude", "skills"), source: "project-claude" },
      { dir: import_node_path12.default.join(cwd, ".cursor", "skills"), source: "project-cursor" }
    );
  }
  const byName = /* @__PURE__ */ new Map();
  for (const { dir, source } of roots) {
    let entries = [];
    try {
      if (!import_node_fs12.default.existsSync(dir)) continue;
      entries = import_node_fs12.default.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (["shell", "canvas", "statusline", "node_modules"].includes(ent.name)) {
        continue;
      }
      const skillDir = import_node_path12.default.join(dir, ent.name);
      const md = import_node_path12.default.join(skillDir, "SKILL.md");
      if (!import_node_fs12.default.existsSync(md)) continue;
      try {
        const raw = import_node_fs12.default.readFileSync(md, "utf8").slice(0, 8e3);
        const fm = parseSkillFrontmatter(raw);
        const name = (fm.name || ent.name).trim();
        if (!name || byName.has(name)) continue;
        const description = (fm.description || "").slice(0, 160);
        byName.set(name, {
          name,
          description,
          source,
          dir: skillDir
        });
      } catch {
      }
    }
  }
  return [...byName.values()].sort(
    (a, b) => a.name.localeCompare(b.name, void 0, { sensitivity: "base" })
  );
}
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS"
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
function json(res, status, body) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function loadRecent() {
  try {
    if (!import_node_fs12.default.existsSync(recentPath)) return [];
    const data = JSON.parse(import_node_fs12.default.readFileSync(recentPath, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
function pushRecent(cwd) {
  const name = import_node_path12.default.basename(cwd) || cwd;
  const next = [
    { path: cwd, name, at: (/* @__PURE__ */ new Date()).toISOString() },
    ...loadRecent().filter((e) => e.path !== cwd)
  ].slice(0, 24);
  import_node_fs12.default.mkdirSync(import_node_path12.default.dirname(recentPath), { recursive: true });
  import_node_fs12.default.writeFileSync(recentPath, JSON.stringify(next, null, 2), "utf8");
  return next;
}
async function pickFolderMac() {
  const script = `
try
  set theFolder to choose folder with prompt "\u9009\u62E9 Agent \u5DE5\u4F5C\u533A"
  return POSIX path of theFolder
on error
  return ""
end try
`;
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script], {
      timeout: 12e4,
      maxBuffer: 1024 * 1024
    });
    const p = stdout.trim().replace(/\/$/, "");
    return p || null;
  } catch {
    return null;
  }
}
function assertUnderRoot(root, target) {
  const rootAbs = import_node_path12.default.resolve(root);
  const targetAbs = import_node_path12.default.resolve(target);
  const prefix = rootAbs.endsWith(import_node_path12.default.sep) ? rootAbs : rootAbs + import_node_path12.default.sep;
  if (targetAbs !== rootAbs && !targetAbs.startsWith(prefix)) {
    throw new Error("path escapes workspace root");
  }
  return targetAbs;
}
function listWorkspaceDir(root, relPath) {
  if (!root || !import_node_fs12.default.existsSync(root) || !import_node_fs12.default.statSync(root).isDirectory()) {
    throw new Error("workspace root missing");
  }
  const joined = import_node_path12.default.resolve(root, relPath || ".");
  const dir = assertUnderRoot(root, joined);
  if (!import_node_fs12.default.statSync(dir).isDirectory()) {
    throw new Error("not a directory");
  }
  const names = import_node_fs12.default.readdirSync(dir);
  const entries = [];
  for (const name of names) {
    if (name === ".DS_Store") continue;
    const full = import_node_path12.default.join(dir, name);
    let st;
    try {
      st = import_node_fs12.default.lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      entries.push({ name, path: full, kind: "dir" });
    } else if (st.isFile()) {
      entries.push({ name, path: full, kind: "file", size: st.size });
    }
  }
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}
async function revealInFinder(target) {
  if (process.platform !== "darwin") {
    throw new Error("Reveal in Finder is macOS-only");
  }
  await execFileAsync("open", ["-R", target], { timeout: 15e3 });
}
async function openWithDefaultApp(target) {
  if (process.platform === "darwin") {
    await execFileAsync("open", [target], { timeout: 15e3 });
    return;
  }
  if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", target], { timeout: 15e3 });
    return;
  }
  await execFileAsync("xdg-open", [target], { timeout: 15e3 });
}
async function openItermAt(cwd) {
  if (process.platform !== "darwin") {
    throw new Error("iTerm open is macOS-only");
  }
  const abs = import_node_path12.default.resolve(cwd);
  const script = `
on run argv
  set targetPath to item 1 of argv
  try
    tell application "iTerm"
      activate
      if (count of windows) = 0 then
        create window with default profile
      else
        tell current window
          create tab with default profile
        end tell
      end if
      tell current session of current window
        write text "cd " & quoted form of targetPath & "; clear"
      end tell
    end tell
  on error
    do shell script "open -a iTerm " & quoted form of targetPath
  end try
end run
`;
  try {
    await execFileAsync("osascript", ["-e", script, abs], { timeout: 2e4 });
  } catch {
    await execFileAsync("open", ["-a", "iTerm", abs], { timeout: 15e3 });
  }
}
function scanProjects() {
  const roots = [
    import_node_path12.default.join(import_node_os9.default.homedir(), "projects"),
    import_node_path12.default.join(import_node_os9.default.homedir(), "Desktop"),
    import_node_path12.default.join(import_node_os9.default.homedir(), "dev")
  ];
  const out = [];
  for (const root of roots) {
    if (!import_node_fs12.default.existsSync(root)) continue;
    let entries;
    try {
      entries = import_node_fs12.default.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith(".") || ent.name === "node_modules" || ent.name === "__pycache__")
        continue;
      const full = import_node_path12.default.join(root, ent.name);
      out.push({
        path: full,
        name: ent.name,
        at: ""
      });
    }
  }
  return out.slice(0, 40);
}
async function handleHttp(req, res, hooks = {}) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return true;
  }
  if (url.pathname === "/health" && req.method === "GET") {
    json(res, 200, { ok: true, service: "agent-pane-bridge" });
    return true;
  }
  if (url.pathname === "/api/recent" && req.method === "GET") {
    json(res, 200, { recent: loadRecent() });
    return true;
  }
  if (url.pathname === "/api/projects" && req.method === "GET") {
    json(res, 200, { projects: scanProjects() });
    return true;
  }
  if (url.pathname === "/api/skills" && req.method === "GET") {
    const cwd = url.searchParams.get("cwd") || void 0;
    json(res, 200, { skills: listSkills(cwd) });
    return true;
  }
  if (url.pathname === "/api/context-usage" && req.method === "GET") {
    let cwd = url.searchParams.get("cwd") || "";
    const queryProviderId = url.searchParams.get("providerSessionId") || "";
    let providerSessionId = "";
    const sessionId = url.searchParams.get("sessionId") || "";
    if (sessionId) {
      const live = hooks.getLiveSessionInfo?.(sessionId) ?? null;
      if (live?.alive && live.providerSessionId) {
        providerSessionId = live.providerSessionId;
        cwd = cwd || live.cwd || "";
      }
      const meta = readMeta(sessionId);
      if (meta) {
        cwd = cwd || meta.cwd || "";
        if (!providerSessionId) {
          providerSessionId = meta.providerSessionId || "";
        }
      }
    }
    if (!providerSessionId) {
      providerSessionId = queryProviderId;
    }
    if (!providerSessionId) {
      json(res, 200, { ok: false, usage: null });
      return true;
    }
    const paths = resolveGrokSignalsPaths(cwd || import_node_os9.default.homedir(), providerSessionId);
    const usage = readGrokSignalsUsage(
      paths.length ? paths : resolveGrokSignalsPaths(import_node_os9.default.homedir(), providerSessionId)
    );
    if (!usage) {
      json(res, 200, { ok: false, usage: null, providerSessionId, cwd });
      return true;
    }
    json(res, 200, {
      ok: true,
      usage: {
        used: usage.used,
        size: usage.size,
        pct: typeof usage.pct === "number" ? usage.pct : Math.min(100, Math.round(usage.used / usage.size * 100)),
        source: "signals"
      },
      providerSessionId,
      cwd
    });
    return true;
  }
  if (url.pathname === "/api/customize/files" && req.method === "GET") {
    json(res, 200, { files: listCustomizeFiles() });
    return true;
  }
  if (url.pathname === "/api/customize/files" && req.method === "PUT") {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.id || typeof body.content !== "string") {
        json(res, 400, { error: "id and content required" });
        return true;
      }
      const file = writeCustomizeFile(body.id, body.content);
      json(res, 200, { file });
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e)
      });
    }
    return true;
  }
  if (url.pathname === "/api/customize/mcp" && req.method === "GET") {
    json(res, 200, loadCustomizeMcp());
    return true;
  }
  if (url.pathname === "/api/customize/mcp" && req.method === "PUT") {
    try {
      const body = JSON.parse(await readBody(req));
      let state = loadCustomizeMcp();
      if (Array.isArray(body.grok) && body.grok.length > 0) {
        state = patchGrokMcp(body.grok);
      }
      if (typeof body.cursorJson === "string") {
        state = writeCursorMcp(body.cursorJson);
      }
      json(res, 200, state);
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e)
      });
    }
    return true;
  }
  if (url.pathname === "/api/customize/hooks" && req.method === "GET") {
    json(res, 200, listCustomizeHooks());
    return true;
  }
  if (url.pathname === "/api/customize/hooks" && req.method === "PUT") {
    try {
      const body = JSON.parse(await readBody(req));
      if (!body.name || typeof body.content !== "string") {
        json(res, 400, { error: "name and content required" });
        return true;
      }
      let content = body.content;
      if (body.create && !content.trim()) {
        const base = body.name.replace(/\.json$/i, "");
        content = defaultHookTemplate(base);
      }
      const file = writeCustomizeHook(body.name, content);
      json(res, 200, { file, ...listCustomizeHooks() });
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e)
      });
    }
    return true;
  }
  if (url.pathname === "/api/customize/hooks" && req.method === "DELETE") {
    try {
      const body = JSON.parse(await readBody(req));
      const name = body.name || url.searchParams.get("name") || "";
      if (!name) {
        json(res, 400, { error: "name required" });
        return true;
      }
      deleteCustomizeHook(name);
      json(res, 200, listCustomizeHooks());
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e)
      });
    }
    return true;
  }
  if (url.pathname === "/api/history" && req.method === "GET") {
    const force = url.searchParams.get("force") === "1";
    const groups = listHistory(force);
    cors(res);
    res.setHeader("Cache-Control", "private, max-age=10");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ groups, cached: !force }));
    return true;
  }
  if (url.pathname === "/api/history/invalidate" && req.method === "POST") {
    invalidateHistoryListCache();
    json(res, 200, { ok: true });
    return true;
  }
  if (url.pathname === "/api/history/import-grok" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const sessionId = (body.sessionId || "").trim();
      if (!sessionId) {
        json(res, 400, { error: "sessionId required" });
        return true;
      }
      const { importGrokSession: importGrokSession2 } = await Promise.resolve().then(() => (init_grok_session_import(), grok_session_import_exports));
      const result = importGrokSession2(sessionId, { force: !!body.force });
      json(res, 200, result);
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e)
      });
    }
    return true;
  }
  const histMatch = url.pathname.match(
    /^\/api\/history\/([^/]+)\/events$/
  );
  if (histMatch && req.method === "GET") {
    const sessionId = decodeURIComponent(histMatch[1]);
    const force = url.searchParams.get("force") !== "0";
    const events = loadSessionEvents(sessionId, force);
    cors(res);
    res.setHeader("Cache-Control", "no-store");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({ sessionId, events, count: events.length })
    );
    return true;
  }
  const metaMatch = url.pathname.match(/^\/api\/history\/([^/]+)$/);
  if (metaMatch && req.method === "GET") {
    const sessionId = decodeURIComponent(metaMatch[1]);
    const meta = readMeta(sessionId);
    if (!meta) {
      json(res, 404, { error: "session not found" });
      return true;
    }
    json(res, 200, { meta });
    return true;
  }
  if (metaMatch && req.method === "PATCH") {
    const sessionId = decodeURIComponent(metaMatch[1]);
    try {
      const body = JSON.parse(await readBody(req));
      const meta = patchMeta(sessionId, {
        title: typeof body.title === "string" ? body.title : void 0,
        pinned: typeof body.pinned === "boolean" ? body.pinned : void 0,
        unread: typeof body.unread === "boolean" ? body.unread : void 0,
        archived: typeof body.archived === "boolean" ? body.archived : void 0
      });
      if (!meta) {
        json(res, 404, { error: "session not found" });
        return true;
      }
      json(res, 200, { meta });
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e)
      });
    }
    return true;
  }
  const forkMatch = url.pathname.match(/^\/api\/history\/([^/]+)\/fork$/);
  if (forkMatch && req.method === "POST") {
    const sessionId = decodeURIComponent(forkMatch[1]);
    let throughUserTurn;
    try {
      const raw = await readBody(req);
      if (raw.trim()) {
        const body = JSON.parse(raw);
        if (typeof body.throughUserTurn === "number" && Number.isFinite(body.throughUserTurn) && body.throughUserTurn >= 0) {
          throughUserTurn = Math.floor(body.throughUserTurn);
        }
      }
    } catch {
    }
    const meta = forkSession(
      sessionId,
      throughUserTurn != null ? { throughUserTurn } : void 0
    );
    if (!meta) {
      json(res, 404, { error: "cannot fork" });
      return true;
    }
    json(res, 200, { meta });
    return true;
  }
  if (metaMatch && req.method === "DELETE") {
    const sessionId = decodeURIComponent(metaMatch[1]);
    try {
      await hooks.stopSession?.(sessionId);
    } catch {
    }
    try {
      setPinned(sessionId, false);
    } catch {
    }
    const ok = deleteSession(sessionId);
    try {
      hooks.purgeSession?.(sessionId);
    } catch {
    }
    if (ok) deleteSession(sessionId);
    if (ok) {
      json(res, 200, { ok: true });
    } else {
      json(res, 500, {
        ok: false,
        error: "Failed to delete session (disk error)"
      });
    }
    return true;
  }
  if (url.pathname === "/api/upload" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const name = String(body.name || "upload.bin").replace(/[^\w.\-()+ ]+/g, "_");
      const b64 = String(body.base64 || "");
      if (!b64) {
        json(res, 400, { error: "base64 required" });
        return true;
      }
      const dir = import_node_path12.default.join(import_node_os9.default.homedir(), ".agent-pane", "uploads");
      import_node_fs12.default.mkdirSync(dir, { recursive: true });
      const stamp = Date.now().toString(36);
      const safe = name.slice(0, 120) || "upload.bin";
      const dest = import_node_path12.default.join(dir, `${stamp}-${safe}`);
      const buf = Buffer.from(b64, "base64");
      if (buf.length > 40 * 1024 * 1024) {
        json(res, 413, { error: "file too large (max 40MB)" });
        return true;
      }
      import_node_fs12.default.writeFileSync(dest, buf);
      json(res, 200, {
        path: dest,
        name: safe,
        size: buf.length,
        mime: body.mime || guessMime(dest)
      });
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e)
      });
    }
    return true;
  }
  if (url.pathname === "/api/fs/persist" && req.method === "POST") {
    try {
      const body = JSON.parse(await readBody(req));
      const src = String(body.path || "");
      if (!src || !import_node_path12.default.isAbsolute(src) || !import_node_fs12.default.existsSync(src)) {
        json(res, 400, { error: "path missing or not found" });
        return true;
      }
      const dest = persistLocalFile(src);
      json(res, 200, {
        path: dest,
        name: import_node_path12.default.basename(dest),
        mime: guessMime(dest),
        image: isImagePath(dest)
      });
    } catch (e) {
      json(res, 500, {
        error: e instanceof Error ? e.message : String(e)
      });
    }
    return true;
  }
  if (url.pathname === "/api/folder-pick" && req.method === "POST") {
    if (process.platform !== "darwin") {
      json(res, 501, {
        error: "Native folder picker is only implemented on macOS for now"
      });
      return true;
    }
    const picked = await pickFolderMac();
    if (!picked) {
      json(res, 200, { cancelled: true, path: null });
      return true;
    }
    const recent = pushRecent(picked);
    json(res, 200, { cancelled: false, path: picked, recent });
    return true;
  }
  if (url.pathname === "/api/recent" && req.method === "POST") {
    const raw = await readBody(req);
    let cwd = "";
    try {
      cwd = String(JSON.parse(raw).path ?? "");
    } catch {
      json(res, 400, { error: "invalid json" });
      return true;
    }
    if (!cwd || !import_node_fs12.default.existsSync(cwd)) {
      json(res, 400, { error: "path missing or not found" });
      return true;
    }
    json(res, 200, { recent: pushRecent(cwd) });
    return true;
  }
  if (url.pathname === "/api/fs/list" && req.method === "GET") {
    const root = url.searchParams.get("root") || "";
    const rel = url.searchParams.get("path") || ".";
    try {
      const entries = listWorkspaceDir(root, rel);
      json(res, 200, { root, path: rel, entries });
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e)
      });
    }
    return true;
  }
  if (url.pathname === "/api/fs/reveal" && req.method === "POST") {
    const raw = await readBody(req);
    let target = "";
    try {
      target = String(JSON.parse(raw).path ?? "");
    } catch {
      json(res, 400, { error: "invalid json" });
      return true;
    }
    if (!target || !import_node_fs12.default.existsSync(target)) {
      json(res, 400, { error: "path missing or not found" });
      return true;
    }
    try {
      await revealInFinder(target);
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 500, {
        error: e instanceof Error ? e.message : String(e)
      });
    }
    return true;
  }
  if (url.pathname === "/api/fs/open" && req.method === "POST") {
    const raw = await readBody(req);
    let target = "";
    try {
      target = String(JSON.parse(raw).path ?? "");
    } catch {
      json(res, 400, { error: "invalid json" });
      return true;
    }
    if (!target || !import_node_fs12.default.existsSync(target)) {
      json(res, 400, { error: "path missing or not found" });
      return true;
    }
    try {
      await openWithDefaultApp(target);
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 500, {
        error: e instanceof Error ? e.message : String(e)
      });
    }
    return true;
  }
  if (url.pathname === "/api/fs/file" && req.method === "GET") {
    const target = url.searchParams.get("path") || "";
    if (!target || !import_node_path12.default.isAbsolute(target) || !import_node_fs12.default.existsSync(target)) {
      json(res, 404, { error: "file not found" });
      return true;
    }
    let st;
    try {
      st = import_node_fs12.default.statSync(target);
    } catch {
      json(res, 404, { error: "file not found" });
      return true;
    }
    if (!st.isFile()) {
      json(res, 400, { error: "not a file" });
      return true;
    }
    if (st.size > 40 * 1024 * 1024) {
      json(res, 413, { error: "file too large" });
      return true;
    }
    try {
      const buf = import_node_fs12.default.readFileSync(target);
      cors(res);
      res.statusCode = 200;
      res.setHeader("Content-Type", guessMime(target));
      res.setHeader("Content-Length", String(buf.length));
      res.setHeader("Cache-Control", "private, max-age=60");
      res.end(buf);
    } catch (e) {
      json(res, 500, {
        error: e instanceof Error ? e.message : String(e)
      });
    }
    return true;
  }
  if (url.pathname === "/api/terminal/iterm" && req.method === "POST") {
    const raw = await readBody(req);
    let cwd = "";
    try {
      cwd = String(JSON.parse(raw).cwd ?? "");
    } catch {
      json(res, 400, { error: "invalid json" });
      return true;
    }
    if (!cwd || !import_node_fs12.default.existsSync(cwd) || !import_node_fs12.default.statSync(cwd).isDirectory()) {
      json(res, 400, { error: "cwd missing or not a directory" });
      return true;
    }
    try {
      await openItermAt(cwd);
      json(res, 200, { ok: true });
    } catch (e) {
      json(res, 500, {
        error: e instanceof Error ? e.message : String(e)
      });
    }
    return true;
  }
  if (url.pathname === "/api/browser/state" && req.method === "GET") {
    const { getBrowserSession: getBrowserSession2 } = await Promise.resolve().then(() => (init_browser_session(), browser_session_exports));
    json(res, 200, getBrowserSession2().getState());
    return true;
  }
  if (url.pathname === "/api/browser/navigate" && req.method === "POST") {
    const { getBrowserSession: getBrowserSession2 } = await Promise.resolve().then(() => (init_browser_session(), browser_session_exports));
    const raw = await readBody(req);
    let target = "";
    try {
      target = String(JSON.parse(raw).url ?? "");
    } catch {
      json(res, 400, { error: "invalid json" });
      return true;
    }
    try {
      await getBrowserSession2().navigate(target);
      json(res, 200, getBrowserSession2().getState());
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e),
        ...getBrowserSession2().getState()
      });
    }
    return true;
  }
  if (url.pathname === "/api/browser/back" && req.method === "POST") {
    const { getBrowserSession: getBrowserSession2 } = await Promise.resolve().then(() => (init_browser_session(), browser_session_exports));
    try {
      await getBrowserSession2().back();
      json(res, 200, getBrowserSession2().getState());
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e),
        ...getBrowserSession2().getState()
      });
    }
    return true;
  }
  if (url.pathname === "/api/browser/screenshot" && req.method === "POST") {
    const { getBrowserSession: getBrowserSession2 } = await Promise.resolve().then(() => (init_browser_session(), browser_session_exports));
    try {
      const screenshotBase64 = await getBrowserSession2().screenshot();
      json(res, 200, { ...getBrowserSession2().getState(), screenshotBase64 });
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e),
        ...getBrowserSession2().getState()
      });
    }
    return true;
  }
  if (url.pathname === "/api/browser/snapshot" && req.method === "POST") {
    const { getBrowserSession: getBrowserSession2 } = await Promise.resolve().then(() => (init_browser_session(), browser_session_exports));
    try {
      const snapshot = await getBrowserSession2().snapshot();
      json(res, 200, { snapshot, ...getBrowserSession2().getState() });
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e)
      });
    }
    return true;
  }
  if (url.pathname === "/api/browser/click" && req.method === "POST") {
    const { getBrowserSession: getBrowserSession2 } = await Promise.resolve().then(() => (init_browser_session(), browser_session_exports));
    const raw = await readBody(req);
    let selector = "";
    try {
      selector = String(JSON.parse(raw).selector ?? "");
    } catch {
      json(res, 400, { error: "invalid json" });
      return true;
    }
    try {
      await getBrowserSession2().click(selector);
      json(res, 200, getBrowserSession2().getState());
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e),
        ...getBrowserSession2().getState()
      });
    }
    return true;
  }
  if (url.pathname === "/api/browser/type" && req.method === "POST") {
    const { getBrowserSession: getBrowserSession2 } = await Promise.resolve().then(() => (init_browser_session(), browser_session_exports));
    const raw = await readBody(req);
    let selector = "";
    let text = "";
    try {
      const body = JSON.parse(raw);
      selector = String(body.selector ?? "");
      text = String(body.text ?? "");
    } catch {
      json(res, 400, { error: "invalid json" });
      return true;
    }
    try {
      await getBrowserSession2().type(selector, text);
      json(res, 200, getBrowserSession2().getState());
    } catch (e) {
      json(res, 400, {
        error: e instanceof Error ? e.message : String(e),
        ...getBrowserSession2().getState()
      });
    }
    return true;
  }
  return false;
}

// ../bridge/src/terminal-pty.ts
var import_node_fs13 = __toESM(require("node:fs"), 1);
var import_node_path13 = __toESM(require("node:path"), 1);
var import_node_module2 = require("node:module");
var SHELL = process.env.SHELL || "/bin/zsh";
function dynamicImport(specifier) {
  return new Function("s", "return import(s)")(specifier);
}
function ensureSpawnHelperExecutable() {
  try {
    let root = null;
    try {
      const req = (0, import_node_module2.createRequire)(
        // CJS bundle: import.meta.url is empty — resolve from cwd / NODE_PATH
        import_node_path13.default.resolve(process.cwd(), "package.json")
      );
      root = import_node_path13.default.dirname(req.resolve("node-pty/package.json"));
    } catch {
      const nm = process.env.NODE_PATH?.split(import_node_path13.default.delimiter)[0];
      if (nm) {
        const cand = import_node_path13.default.join(nm, "node-pty");
        if (import_node_fs13.default.existsSync(cand)) root = cand;
      }
    }
    if (!root) return;
    const prebuilds = import_node_path13.default.join(root, "prebuilds");
    if (!import_node_fs13.default.existsSync(prebuilds)) return;
    for (const plat of import_node_fs13.default.readdirSync(prebuilds)) {
      const helper = import_node_path13.default.join(prebuilds, plat, "spawn-helper");
      if (!import_node_fs13.default.existsSync(helper)) continue;
      try {
        import_node_fs13.default.accessSync(helper, import_node_fs13.default.constants.X_OK);
      } catch {
        import_node_fs13.default.chmodSync(helper, 493);
      }
    }
  } catch {
  }
}
function buildPtyEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    if (/^(npm_|npm_config_|CURSOR_|VSCODE_|ELECTRON)/i.test(k)) continue;
    env[k] = v;
  }
  env.PATH = buildAugmentedPath(env.PATH ?? process.env.PATH);
  env.TERM = "xterm-256color";
  env.COLORTERM = env.COLORTERM || "truecolor";
  env.SHELL = SHELL;
  return env;
}
async function createPty(cwd, cols, rows) {
  ensureSpawnHelperExecutable();
  let mod;
  try {
    mod = await dynamicImport("node-pty");
  } catch (e) {
    throw new Error(
      `node-pty unavailable (${e instanceof Error ? e.message : e}). Run: npm rebuild node-pty`
    );
  }
  let pty;
  try {
    pty = mod.spawn(SHELL, [], {
      name: "xterm-256color",
      cols: Math.max(cols, 20),
      rows: Math.max(rows, 8),
      cwd,
      env: buildPtyEnv()
    });
  } catch (e) {
    throw new Error(
      `PTY spawn failed (${e instanceof Error ? e.message : e}). Try: chmod +x node_modules/node-pty/prebuilds/*/spawn-helper`
    );
  }
  return {
    write: (data) => pty.write(data),
    resize: (c, r) => pty.resize(Math.max(c, 20), Math.max(r, 8)),
    kill: () => {
      try {
        pty.kill();
      } catch {
      }
    },
    onData: (cb) => {
      pty.onData(cb);
      return () => pty.removeListener("data", cb);
    },
    onExit: (cb) => {
      const handler = (e) => cb(e.exitCode ?? 0);
      pty.onExit(handler);
      return () => pty.removeListener("exit", handler);
    }
  };
}
var TerminalHub = class {
  cwd;
  pty = null;
  starting = null;
  clients = /* @__PURE__ */ new Map();
  cols = 80;
  rows = 24;
  dataUnsub = null;
  exitUnsub = null;
  /** Input typed before PTY is ready (e.g. `grok login` + Enter). */
  pendingInput = "";
  constructor(_key, cwd) {
    this.cwd = cwd;
  }
  broadcast(msg) {
    for (const { send } of this.clients.values()) {
      send(msg);
    }
  }
  flushPendingInput() {
    if (!this.pty || !this.pendingInput) return;
    const buf = this.pendingInput;
    this.pendingInput = "";
    this.pty.write(buf);
  }
  async ensurePty() {
    if (this.pty) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      try {
        const pty = await createPty(this.cwd, this.cols, this.rows);
        this.pty = pty;
        this.dataUnsub = pty.onData((data) => {
          this.broadcast({ type: "data", data });
        });
        this.exitUnsub = pty.onExit((code) => {
          this.broadcast({ type: "exit", code });
          this.destroyPty();
        });
        this.flushPendingInput();
      } catch (e) {
        this.broadcast({
          type: "error",
          message: e instanceof Error ? e.message : String(e)
        });
        throw e;
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }
  destroyPty() {
    this.dataUnsub?.();
    this.exitUnsub?.();
    this.dataUnsub = null;
    this.exitUnsub = null;
    this.pty?.kill();
    this.pty = null;
    this.pendingInput = "";
  }
  attach(send, cols = 80, rows = 24) {
    this.cols = cols;
    this.rows = rows;
    const id = Symbol("terminal-client");
    this.clients.set(id, { send });
    void this.ensurePty().then(() => {
      this.pty?.resize(this.cols, this.rows);
      this.flushPendingInput();
      send({ type: "ready" });
    }).catch((e) => {
      send({
        type: "error",
        message: e instanceof Error ? e.message : String(e)
      });
    });
    return id;
  }
  write(data) {
    if (this.pty) {
      this.pty.write(data);
      return;
    }
    this.pendingInput += data;
    void this.ensurePty();
  }
  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.pty?.resize(cols, rows);
  }
  /** Detach one client; keep PTY alive so reopening the panel reconnects. */
  dispose(sessionId) {
    this.clients.delete(sessionId);
  }
  /** Explicit teardown (e.g. workspace cwd changed). */
  kill() {
    this.clients.clear();
    this.destroyPty();
  }
  clientCount() {
    return this.clients.size;
  }
};
var hubs = /* @__PURE__ */ new Map();
var terminalSessions = /* @__PURE__ */ new Map();
function hubKey(cwd, termId) {
  return termId ? `${cwd}::${termId}` : cwd;
}
function getHub(cwd, termId) {
  const key = hubKey(cwd, termId);
  let hub = hubs.get(key);
  if (!hub) {
    hub = new TerminalHub(key, cwd);
    hubs.set(key, hub);
  }
  return hub;
}
function sendJson(ws, msg) {
  ws.send(JSON.stringify(msg));
}
function handleTerminalWs(ws, rawMessage) {
  let msg;
  try {
    msg = JSON.parse(String(rawMessage));
  } catch {
    sendJson(ws, { type: "error", message: "Invalid JSON" });
    return;
  }
  switch (msg.type) {
    case "attach": {
      const cwd = msg.cwd;
      if (!cwd) {
        sendJson(ws, { type: "error", message: "attach requires cwd" });
        return;
      }
      const existing = terminalSessions.get(ws);
      if (existing) {
        existing.hub.dispose(existing.clientId);
        terminalSessions.delete(ws);
      }
      const key = hubKey(cwd, msg.termId);
      const hub = getHub(cwd, msg.termId);
      const clientId = hub.attach(
        (m) => sendJson(ws, m),
        msg.cols ?? 80,
        msg.rows ?? 24
      );
      terminalSessions.set(ws, { hub, clientId, cwd, hubKey: key });
      break;
    }
    case "input": {
      const session = terminalSessions.get(ws);
      if (!session) {
        sendJson(ws, { type: "error", message: "Not attached" });
        return;
      }
      session.hub.write(msg.data);
      break;
    }
    case "resize": {
      const session = terminalSessions.get(ws);
      if (!session) {
        sendJson(ws, { type: "error", message: "Not attached" });
        return;
      }
      session.hub.resize(msg.cols, msg.rows);
      break;
    }
    case "detach": {
      const session = terminalSessions.get(ws);
      if (session) {
        session.hub.dispose(session.clientId);
        terminalSessions.delete(ws);
        if (msg.kill) {
          session.hub.kill();
          hubs.delete(session.hubKey);
        }
      }
      break;
    }
    default:
      sendJson(ws, { type: "error", message: "Unknown message type" });
  }
}
function createTerminalConnection(ws) {
  ws.send(JSON.stringify({ type: "hello", channel: "terminal" }));
}

// ../bridge/src/index.ts
applyHealthyPathToProcess();
var PORT = Number(process.env.AGENT_PANE_PORT ?? 8787);
var HOST = process.env.AGENT_PANE_HOST ?? "127.0.0.1";
var clients = /* @__PURE__ */ new Set();
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of clients) {
    if (c.readyState === c.OPEN) c.send(data);
  }
}
var sessions = new SessionManager({
  broadcast,
  permissionMode: process.env.AGENT_PANE_PERMISSION ?? "auto"
});
var server = import_node_http.default.createServer(async (req, res) => {
  try {
    const handled = await handleHttp(req, res, {
      stopSession: (id) => sessions.stopSession(id),
      purgeSession: (id) => sessions.purgeSession(id),
      getLiveSessionInfo: (id) => sessions.getLiveSessionInfo(id)
    });
    if (!handled) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    }
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) })
    );
  }
});
var wss = new import_websocket_server.default({ server });
wss.on("connection", (ws, req) => {
  const pathname = (req.url ?? "/").split("?")[0] || "/";
  if (pathname === "/terminal") {
    createTerminalConnection(ws);
    ws.on("message", (raw) => {
      handleTerminalWs(ws, raw);
    });
    ws.on("close", () => {
      handleTerminalWs(ws, JSON.stringify({ type: "detach" }));
      terminalSessions.delete(ws);
    });
    return;
  }
  clients.add(ws);
  ws.send(JSON.stringify({ type: "hello", version: "0.1.0" }));
  try {
    ws.send(
      JSON.stringify({
        type: "live",
        sessionIds: sessions.listLiveSessionIds()
      })
    );
  } catch {
  }
  ws.on("message", async (raw) => {
    try {
      const cmd = JSON.parse(String(raw));
      if (cmd.type === "session.create" && cmd.cwd) {
        try {
          pushRecent(cmd.cwd);
        } catch {
        }
      }
      await sessions.handleCommand(cmd);
    } catch (e) {
      ws.send(
        JSON.stringify({
          type: "error",
          message: e instanceof Error ? e.message : String(e)
        })
      );
    }
  });
  ws.on("close", () => clients.delete(ws));
});
server.listen(PORT, HOST, () => {
  console.log(`[agent-pane] bridge ws://${HOST}:${PORT}`);
  console.log(`[agent-pane] terminal ws://${HOST}:${PORT}/terminal`);
  console.log(`[agent-pane] health http://${HOST}:${PORT}/health`);
  console.log(`[agent-pane] folder-pick POST http://${HOST}:${PORT}/api/folder-pick`);
});
