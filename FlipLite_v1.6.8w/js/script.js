

    (function (global) {
      'use strict';
      var uint8 = {};
      uint8.buildStream = function (data) { return { data: data, pos: 0 }; };
      uint8.readByte = function () { return function (stream) { return stream.data[stream.pos++]; }; };
      uint8.peekByte = function (offset) {
        offset = offset || 0;
        return function (stream) { return stream.data[stream.pos + offset]; };
      };
      uint8.readBytes = function (count) {
        return function (stream) { return stream.data.subarray(stream.pos, stream.pos += count); };
      };
      uint8.peekBytes = function (count) {
        return function (stream) { return stream.data.subarray(stream.pos, stream.pos + count); };
      };
      uint8.readString = function (count) {
        return function (stream) {
          return Array.from(uint8.readBytes(count)(stream)).map(function (c) { return String.fromCharCode(c); }).join('');
        };
      };
      uint8.readUnsigned = function (littleEndian) {
        return function (stream) {
          var bytes = uint8.readBytes(2)(stream);
          return littleEndian ? (bytes[1] << 8) + bytes[0] : (bytes[0] << 8) + bytes[1];
        };
      };
      uint8.readArray = function (size, lengthFn) {
        return function (stream, result, parent) {
          var length = typeof lengthFn === 'function' ? lengthFn(stream, result, parent) : lengthFn;
          var reader = uint8.readBytes(size);
          var arr = new Array(length);
          for (var i = 0; i < length; i++) arr[i] = reader(stream);
          return arr;
        };
      };
      uint8.readBits = function (spec) {
        return function (stream) {
          var byte = stream.data[stream.pos++];
          var bits = new Array(8);
          for (var i = 0; i < 8; i++) bits[7 - i] = !!(byte & (1 << i));
          return Object.keys(spec).reduce(function (result, key) {
            var s = spec[key];
            if (s.length) {
              var val = 0;
              for (var j = 0; j < s.length; j++) val += bits[s.index + j] && Math.pow(2, s.length - j - 1);
              result[key] = val;
            } else {
              result[key] = bits[s.index];
            }
            return result;
          }, {});
        };
      };
      var parser = {};
      parser.parse = function parse(stream, schema, result, parent) {
        result = result || {};
        parent = parent || result;
        if (Array.isArray(schema)) {
          schema.forEach(function (s) { parse(stream, s, result, parent); });
        } else if (typeof schema === 'function') {
          schema(stream, result, parent, parse);
        } else {
          var key = Object.keys(schema)[0];
          if (Array.isArray(schema[key])) {
            parent[key] = {};
            parse(stream, schema[key], result, parent[key]);
          } else {
            parent[key] = schema[key](stream, result, parent, parse);
          }
        }
        return result;
      };
      parser.conditional = function (schema, condition) {
        return function (stream, result, parent, parse) {
          if (condition(stream, result, parent)) parse(stream, schema, result, parent);
        };
      };
      parser.loop = function (schema, condition) {
        return function (stream, result, parent, parse) {
          var items = [];
          var lastPos = stream.pos;
          while (condition(stream, result, parent)) {
            var item = {};
            parse(stream, schema, result, item);
            if (stream.pos === lastPos) break;
            lastPos = stream.pos;
            items.push(item);
          }
          return items;
        };
      };
      var blocks = {
        blocks: function (stream) {
          var chunks = [];
          var totalLen = stream.data.length;
          var total = 0;
          var size = uint8.readByte()(stream);
          while (size !== 0 && size) {
            if (stream.pos + size >= totalLen) {
              var remaining = totalLen - stream.pos;
              chunks.push(uint8.readBytes(remaining)(stream));
              total += remaining;
              break;
            }
            chunks.push(uint8.readBytes(size)(stream));
            total += size;
            size = uint8.readByte()(stream);
          }
          var result = new Uint8Array(total);
          var offset = 0;
          for (var i = 0; i < chunks.length; i++) {
            result.set(chunks[i], offset);
            offset += chunks[i].length;
          }
          return result;
        }
      };
      var gce = parser.conditional({
        gce: [
          { codes: uint8.readBytes(2) },
          { byteSize: uint8.readByte() },
          {
            extras: uint8.readBits({
              future: { index: 0, length: 3 },
              disposal: { index: 3, length: 3 },
              userInput: { index: 6 },
              transparentColorGiven: { index: 7 }
            })
          },
          { delay: uint8.readUnsigned(true) },
          { transparentColorIndex: uint8.readByte() },
          { terminator: uint8.readByte() }
        ]
      }, function (stream) {
        var bytes = uint8.peekBytes(2)(stream);
        return bytes[0] === 0x21 && bytes[1] === 0xF9;
      });
      var image = parser.conditional({
        image: [
          { code: uint8.readByte() },
          {
            descriptor: [
              { left: uint8.readUnsigned(true) },
              { top: uint8.readUnsigned(true) },
              { width: uint8.readUnsigned(true) },
              { height: uint8.readUnsigned(true) },
              {
                lct: uint8.readBits({
                  exists: { index: 0 },
                  interlaced: { index: 1 },
                  sort: { index: 2 },
                  future: { index: 3, length: 2 },
                  size: { index: 5, length: 3 }
                })
              }
            ]
          },
          parser.conditional({
            lct: uint8.readArray(3, function (stream, result, parent) {
              return Math.pow(2, parent.descriptor.lct.size + 1);
            })
          }, function (stream, result, parent) {
            return parent.descriptor.lct.exists;
          }),
          {
            data: [
              { minCodeSize: uint8.readByte() },
              blocks
            ]
          }
        ]
      }, function (stream) {
        return uint8.peekByte()(stream) === 0x2C;
      });
      var text = parser.conditional({
        text: [
          { codes: uint8.readBytes(2) },
          { blockSize: uint8.readByte() },
          {
            preData: function (stream, result, parent) {
              return uint8.readBytes(parent.text.blockSize)(stream);
            }
          },
          blocks
        ]
      }, function (stream) {
        var bytes = uint8.peekBytes(2)(stream);
        return bytes[0] === 0x21 && bytes[1] === 0x01;
      });
      var application = parser.conditional({
        application: [
          { codes: uint8.readBytes(2) },
          { blockSize: uint8.readByte() },
          {
            id: function (stream, result, parent) {
              return uint8.readString(parent.blockSize)(stream);
            }
          },
          blocks
        ]
      }, function (stream) {
        var bytes = uint8.peekBytes(2)(stream);
        return bytes[0] === 0x21 && bytes[1] === 0xFF;
      });
      var comment = parser.conditional({
        comment: [
          { codes: uint8.readBytes(2) },
          blocks
        ]
      }, function (stream) {
        var bytes = uint8.peekBytes(2)(stream);
        return bytes[0] === 0x21 && bytes[1] === 0xFE;
      });
      var gifSchema = [
        {
          header: [
            { signature: uint8.readString(3) },
            { version: uint8.readString(3) }
          ]
        },
        {
          lsd: [
            { width: uint8.readUnsigned(true) },
            { height: uint8.readUnsigned(true) },
            {
              gct: uint8.readBits({
                exists: { index: 0 },
                resolution: { index: 1, length: 3 },
                sort: { index: 4 },
                size: { index: 5, length: 3 }
              })
            },
            { backgroundColorIndex: uint8.readByte() },
            { pixelAspectRatio: uint8.readByte() }
          ]
        },
        parser.conditional({
          gct: uint8.readArray(3, function (stream, result) {
            return Math.pow(2, result.lsd.gct.size + 1);
          })
        }, function (stream, result) {
          return result.lsd.gct.exists;
        }),
        {
          frames: parser.loop([gce, application, comment, image, text], function (stream) {
            var byte = uint8.peekByte()(stream);
            return byte === 0x21 || byte === 0x2C;
          })
        }
      ];
      function lzw(minCodeSize, data, pixelCount) {
        var MAX_STACK_SIZE = 4096;
        var nullCode = -1;
        var npix = pixelCount;
        var pixels = new Array(pixelCount);
        var prefix = new Array(MAX_STACK_SIZE);
        var suffix = new Array(MAX_STACK_SIZE);
        var pixelStack = new Array(4097);
        var clear = 1 << minCodeSize;
        var eoi = clear + 1;
        var available = clear + 2;
        var oldCode = nullCode;
        var codeSize = minCodeSize + 1;
        var codeMask = (1 << codeSize) - 1;
        for (var code = 0; code < clear; code++) {
          prefix[code] = 0;
          suffix[code] = code;
        }
        var datum = 0, bits = 0, first = 0, top = 0, pi = 0, bi = 0;
        for (var i = 0; i < npix;) {
          if (top === 0) {
            if (bits < codeSize) {
              datum += data[bi] << bits;
              bits += 8;
              bi++;
              continue;
            }
            code = datum & codeMask;
            datum >>= codeSize;
            bits -= codeSize;
            if (code > available || code === eoi) break;
            if (code === clear) {
              codeSize = minCodeSize + 1;
              codeMask = (1 << codeSize) - 1;
              available = clear + 2;
              oldCode = nullCode;
              continue;
            }
            if (oldCode === nullCode) {
              pixelStack[top++] = suffix[code];
              oldCode = code;
              first = code;
              continue;
            }
            var inCode = code;
            if (code === available) {
              pixelStack[top++] = first;
              code = oldCode;
            }
            while (code > clear) {
              pixelStack[top++] = suffix[code];
              code = prefix[code];
            }
            first = suffix[code] & 0xFF;
            pixelStack[top++] = first;
            if (available < MAX_STACK_SIZE) {
              prefix[available] = oldCode;
              suffix[available] = first;
              if (!(++available & codeMask) && available < MAX_STACK_SIZE) {
                codeSize++;
                codeMask += available;
              }
            }
            oldCode = inCode;
          }
          top--;
          pixels[pi++] = pixelStack[top];
          i++;
        }
        for (i = pi; i < npix; i++) pixels[i] = 0;
        return pixels;
      }
      function deinterlace(pixels, width) {
        var result = new Array(pixels.length);
        var rows = pixels.length / width;
        var offsets = [0, 4, 2, 1];
        var steps = [8, 8, 4, 2];
        var fromRow = 0;
        for (var pass = 0; pass < 4; pass++) {
          for (var toRow = offsets[pass]; toRow < rows; toRow += steps[pass]) {
            var rowData = pixels.slice(fromRow * width, (fromRow + 1) * width);
            result.splice.apply(result, [toRow * width, width].concat(rowData));
            fromRow++;
          }
        }
        return result;
      }
      function parseGIF(arrayBuffer) {
        var byteData = new Uint8Array(arrayBuffer);
        return parser.parse(uint8.buildStream(byteData), gifSchema);
      }
      function decompressFrame(frame, gct, buildPatch) {
        if (!frame.image) {
          console.warn('gif frame does not have associated image.');
          return;
        }
        var img = frame.image;
        var totalPixels = img.descriptor.width * img.descriptor.height;
        var pixels = lzw(img.data.minCodeSize, img.data.blocks, totalPixels);
        if (img.descriptor.lct.interlaced) {
          pixels = deinterlace(pixels, img.descriptor.width);
        }
        var result = {
          pixels: pixels,
          dims: {
            top: img.descriptor.top,
            left: img.descriptor.left,
            width: img.descriptor.width,
            height: img.descriptor.height
          }
        };
        if (img.descriptor.lct && img.descriptor.lct.exists) {
          result.colorTable = img.lct;
        } else {
          result.colorTable = gct;
        }
        if (frame.gce) {
          result.delay = (frame.gce.delay || 10) * 10;
          result.disposalType = frame.gce.extras.disposal;
          if (frame.gce.extras.transparentColorGiven) {
            result.transparentIndex = frame.gce.transparentColorIndex;
          }
        }
        if (buildPatch) {
          var pLen = result.pixels.length;
          var patch = new Uint8ClampedArray(pLen * 4);
          for (var p = 0; p < pLen; p++) {
            var idx = p * 4;
            var colorIdx = result.pixels[p];
            var color = result.colorTable[colorIdx] || [0, 0, 0];
            patch[idx] = color[0];
            patch[idx + 1] = color[1];
            patch[idx + 2] = color[2];
            patch[idx + 3] = colorIdx !== result.transparentIndex ? 255 : 0;
          }
          result.patch = patch;
        }
        return result;
      }
      function decompressFrames(gif, buildPatch) {
        return gif.frames
          .filter(function (f) { return f.image; })
          .map(function (f) { return decompressFrame(f, gif.gct, buildPatch); });
      }
      global.gifuct = {
        parseGIF: parseGIF,
        decompressFrame: decompressFrame,
        decompressFrames: decompressFrames
      };
    })(typeof window !== 'undefined' ? window : this);
  

;


    (function () {

      const logoText = "FLIPLITE";
      const logoEl = document.getElementById('lsLogo');
      if (logoEl) {
        logoEl.innerHTML = logoText.split('').map((char, i) =>
          `<span class="ls-char" style="animation-delay: -${i * 0.1}s">${char}</span>`
        ).join('');
      }

      window.addEventListener('load', function () {
        setTimeout(function () {
          const s = document.getElementById('loadingScreen');
          if (s) {
            s.classList.add('loading-done');
            setTimeout(() => s.remove(), 600);
          }
        }, 1800);
      });
    })();
  

;



    const W = 500, H = 400;
  

;


    (() => {
      const frames = document.getElementById('frames');
      if (!frames) return;

      const edgePad = 12;

      function ensureInView(el) {
        if (!el) return;
        const fr = frames.getBoundingClientRect();
        const cr = el.getBoundingClientRect();
        if (cr.right > fr.right - edgePad) {
          el.scrollIntoView({ behavior: 'smooth', inline: 'end', block: 'nearest' });
        } else if (cr.left < fr.left + edgePad) {
          el.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
        }
      }

      window.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        requestAnimationFrame(() => {
          const active = frames.querySelector('.tile.active') || frames.querySelector('.tile, .addTile');
          ensureInView(active);
        });
      });
    })();
  

;


    (function () {
      const size = document.getElementById('size'); if (size) { size.value = '2'; size.style.setProperty('--pct', ((2 - 1) / (32 - 1)) * 100 + '%'); }
      const dither = document.getElementById('dither'); if (dither) { dither.value = '0'; dither.style.setProperty('--pct', '0%'); }
      const fps = document.getElementById('fpsNum'); if (fps) { fps.value = '8'; }
      const onionToggle = document.getElementById('onionToggle'); if (onionToggle) onionToggle.checked = false;
      const onionBtn = document.getElementById('onionBtn'); if (onionBtn) onionBtn.classList.remove('active');

      document.querySelectorAll('#leftbar .tool').forEach(t => t.classList.remove('active'));
      const brushTool = document.getElementById('brushTool'); if (brushTool) brushTool.classList.add('active');

      const playBtn = document.getElementById('playBtn');
      if (playBtn && !playBtn.hasAttribute('data-playing')) playBtn.setAttribute('data-playing', 'false');
    })();
  

;


    (function () {
      const btn = document.getElementById('playBtn');
      const icon = btn && btn.querySelector('span');
      if (!btn || !icon) return;
      function sync() {
        const isPlaying = icon.textContent.trim() === '⏸';
        btn.setAttribute('data-playing', isPlaying ? 'true' : 'false');
        document.body.classList.toggle('is-playing', isPlaying);
      }
      new MutationObserver(sync).observe(icon, { characterData: true, childList: true, subtree: true });
      btn.addEventListener('click', () => setTimeout(sync, 0));
      document.addEventListener('keydown', (e) => { if (e.code === 'Space') setTimeout(sync, 0); });
      sync();
    })();
  

;


    (function () {
      if (window.__onionOGFixed) return;
      window.__onionOGFixed = true;

      (function injectOutlineOverride() {
        if (document.getElementById('onionOutlineOverride')) return;
        const st = document.createElement('style');
        st.id = 'onionOutlineOverride';
        st.textContent = '#onionBtn.active{outline:none !important;}';
        document.head.appendChild(st);
      })();

      const btn = document.getElementById('onionBtn');
      const toggle = document.getElementById('onionToggle');



      let ctx;
      const ac = () => ctx || (ctx = new (window.AudioContext || window.webkitAudioContext)());
      function playOnionOn() { }
      function playOnionOff() { }
      let armedUntil = 0;
      function armAudio() { const a = ac(); if (a.state === 'suspended') a.resume(); armedUntil = performance.now() + 800; }
      const canPlay = () => performance.now() <= armedUntil;
      if (btn) btn.addEventListener('pointerdown', armAudio, { passive: true });
      if (toggle) toggle.addEventListener('pointerdown', armAudio, { passive: true });
      let lastOnStamp = 0, lastOffStamp = 0;
      function triggerIfEnabled() {
        const isOn = (toggle && toggle.checked) || (btn && btn.classList.contains('active'));
        if (!canPlay()) return;
        const now = performance.now();
        if (isOn) { if (now - lastOnStamp < 100) return; lastOnStamp = now; ac().resume?.(); playOnionOn(); }
        else { if (now - lastOffStamp < 100) return; lastOffStamp = now; ac().resume?.(); playOnionOff(); }
      }
      if (toggle) toggle.addEventListener('change', triggerIfEnabled);
      if (btn) {
        let prevActive = btn.classList.contains('active');
        new MutationObserver(() => {
          const curr = btn.classList.contains('active');
          if (curr !== prevActive) { prevActive = curr; triggerIfEnabled(); }
        }).observe(btn, { attributes: true, attributeFilter: ['class'] });
      }
    })();
  

;


    (function (f) { if (typeof exports === "object" && typeof module !== "undefined") { module.exports = f() } else if (typeof define === "function" && define.amd) { define([], f) } else { var g; if (typeof window !== "undefined") { g = window } else if (typeof global !== "undefined") { g = global } else if (typeof self !== "undefined") { g = self } else { g = this } g.GIF = f() } })(function () { var define, module, exports; return function e(t, n, r) { function s(o, u) { if (!n[o]) { if (!t[o]) { var a = typeof require == "function" && require; if (!u && a) return a(o, !0); if (i) return i(o, !0); var f = new Error("Cannot find module '" + o + "'"); throw f.code = "MODULE_NOT_FOUND", f } var l = n[o] = { exports: {} }; t[o][0].call(l.exports, function (e) { var n = t[o][1][e]; return s(n ? n : e) }, l, l.exports, e, t, n, r) } return n[o].exports } var i = typeof require == "function" && require; for (var o = 0; o < r.length; o++)s(r[o]); return s }({ 1: [function (require, module, exports) { function EventEmitter() { this._events = this._events || {}; this._maxListeners = this._maxListeners || undefined } module.exports = EventEmitter; EventEmitter.EventEmitter = EventEmitter; EventEmitter.prototype._events = undefined; EventEmitter.prototype._maxListeners = undefined; EventEmitter.defaultMaxListeners = 10; EventEmitter.prototype.setMaxListeners = function (n) { if (!isNumber(n) || n < 0 || isNaN(n)) throw TypeError("n must be a positive number"); this._maxListeners = n; return this }; EventEmitter.prototype.emit = function (type) { var er, handler, len, args, i, listeners; if (!this._events) this._events = {}; if (type === "error") { if (!this._events.error || isObject(this._events.error) && !this._events.error.length) { er = arguments[1]; if (er instanceof Error) { throw er } else { var err = new Error('Uncaught, unspecified "error" event. (' + er + ")"); err.context = er; throw err } } } handler = this._events[type]; if (isUndefined(handler)) return false; if (isFunction(handler)) { switch (arguments.length) { case 1: handler.call(this); break; case 2: handler.call(this, arguments[1]); break; case 3: handler.call(this, arguments[1], arguments[2]); break; default: args = Array.prototype.slice.call(arguments, 1); handler.apply(this, args) } } else if (isObject(handler)) { args = Array.prototype.slice.call(arguments, 1); listeners = handler.slice(); len = listeners.length; for (i = 0; i < len; i++)listeners[i].apply(this, args) } return true }; EventEmitter.prototype.addListener = function (type, listener) { var m; if (!isFunction(listener)) throw TypeError("listener must be a function"); if (!this._events) this._events = {}; if (this._events.newListener) this.emit("newListener", type, isFunction(listener.listener) ? listener.listener : listener); if (!this._events[type]) this._events[type] = listener; else if (isObject(this._events[type])) this._events[type].push(listener); else this._events[type] = [this._events[type], listener]; if (isObject(this._events[type]) && !this._events[type].warned) { if (!isUndefined(this._maxListeners)) { m = this._maxListeners } else { m = EventEmitter.defaultMaxListeners } if (m && m > 0 && this._events[type].length > m) { this._events[type].warned = true; console.error("(node) warning: possible EventEmitter memory " + "leak detected. %d listeners added. " + "Use emitter.setMaxListeners() to increase limit.", this._events[type].length); if (typeof console.trace === "function") { console.trace() } } } return this }; EventEmitter.prototype.on = EventEmitter.prototype.addListener; EventEmitter.prototype.once = function (type, listener) { if (!isFunction(listener)) throw TypeError("listener must be a function"); var fired = false; function g() { this.removeListener(type, g); if (!fired) { fired = true; listener.apply(this, arguments) } } g.listener = listener; this.on(type, g); return this }; EventEmitter.prototype.removeListener = function (type, listener) { var list, position, length, i; if (!isFunction(listener)) throw TypeError("listener must be a function"); if (!this._events || !this._events[type]) return this; list = this._events[type]; length = list.length; position = -1; if (list === listener || isFunction(list.listener) && list.listener === listener) { delete this._events[type]; if (this._events.removeListener) this.emit("removeListener", type, listener) } else if (isObject(list)) { for (i = length; i-- > 0;) { if (list[i] === listener || list[i].listener && list[i].listener === listener) { position = i; break } } if (position < 0) return this; if (list.length === 1) { list.length = 0; delete this._events[type] } else { list.splice(position, 1) } if (this._events.removeListener) this.emit("removeListener", type, listener) } return this }; EventEmitter.prototype.removeAllListeners = function (type) { var key, listeners; if (!this._events) return this; if (!this._events.removeListener) { if (arguments.length === 0) this._events = {}; else if (this._events[type]) delete this._events[type]; return this } if (arguments.length === 0) { for (key in this._events) { if (key === "removeListener") continue; this.removeAllListeners(key) } this.removeAllListeners("removeListener"); this._events = {}; return this } listeners = this._events[type]; if (isFunction(listeners)) { this.removeListener(type, listeners) } else if (listeners) { while (listeners.length) this.removeListener(type, listeners[listeners.length - 1]) } delete this._events[type]; return this }; EventEmitter.prototype.listeners = function (type) { var ret; if (!this._events || !this._events[type]) ret = []; else if (isFunction(this._events[type])) ret = [this._events[type]]; else ret = this._events[type].slice(); return ret }; EventEmitter.prototype.listenerCount = function (type) { if (this._events) { var evlistener = this._events[type]; if (isFunction(evlistener)) return 1; else if (evlistener) return evlistener.length } return 0 }; EventEmitter.listenerCount = function (emitter, type) { return emitter.listenerCount(type) }; function isFunction(arg) { return typeof arg === "function" } function isNumber(arg) { return typeof arg === "number" } function isObject(arg) { return typeof arg === "object" && arg !== null } function isUndefined(arg) { return arg === void 0 } }, {}], 2: [function (require, module, exports) { var UA, browser, mode, platform, ua; ua = navigator.userAgent.toLowerCase(); platform = navigator.platform.toLowerCase(); UA = ua.match(/(opera|ie|firefox|chrome|version)[\s\/:]([\w\d\.]+)?.*?(safari|version[\s\/:]([\\w\\d\\.]+)|$)/) || [null, "unknown", 0]; mode = UA[1] === "ie" && document.documentMode; browser = { name: UA[1] === "version" ? UA[3] : UA[1], version: mode || parseFloat(UA[1] === "opera" && UA[4] ? UA[4] : UA[2]), platform: { name: ua.match(/ip(?:ad|od|hone)/) ? "ios" : (ua.match(/(?:webos|android)/) || platform.match(/mac|win|linux/) || ["other"])[0] } }; browser[browser.name] = true; browser[browser.name + parseInt(browser.version, 10)] = true; browser.platform[browser.platform.name] = true; module.exports = browser }, {}], 3: [function (require, module, exports) { var EventEmitter, GIF, browser, extend = function (child, parent) { for (var key in parent) { if (hasProp.call(parent, key)) child[key] = parent[key] } function ctor() { this.constructor = child } ctor.prototype = parent.prototype; child.prototype = new ctor; child.__super__ = parent.prototype; return child }, hasProp = {}.hasOwnProperty, indexOf = [].indexOf || function (item) { for (var i = 0, l = this.length; i < l; i++) { if (i in this && this[i] === item) return i } return -1 }, slice = [].slice; EventEmitter = require("events").EventEmitter; browser = require("./browser.coffee"); GIF = function (superClass) { var defaults, frameDefaults; extend(GIF, superClass); defaults = { workerScript: "gif.worker.js", workers: 2, repeat: 0, background: "#fff", quality: 10, width: null, height: null, transparent: null, debug: false, dither: false }; frameDefaults = { delay: 500, copy: false }; function GIF(options) { var base, key, value; this.running = false; this.options = {}; this.frames = []; this.freeWorkers = []; this.activeWorkers = []; this.setOptions(options); for (key in defaults) { value = defaults[key]; if ((base = this.options)[key] == null) { base[key] = value } } } GIF.prototype.setOption = function (key, value) { this.options[key] = value; if (this._canvas != null && (key === "width" || key === "height")) { return this._canvas[key] = value } }; GIF.prototype.setOptions = function (options) { var key, results, value; results = []; for (key in options) { if (!hasProp.call(options, key)) continue; value = options[key]; results.push(this.setOption(key, value)) } return results }; GIF.prototype.addFrame = function (image, options) { var frame, key; if (options == null) { options = {} } frame = {}; frame.transparent = this.options.transparent; for (key in frameDefaults) { frame[key] = options[key] || frameDefaults[key] } if (this.options.width == null) { this.setOption("width", image.width) } if (this.options.height == null) { this.setOption("height", image.height) } if (typeof ImageData !== "undefined" && ImageData !== null && image instanceof ImageData) { frame.data = image.data } else if (typeof CanvasRenderingContext2D !== "undefined" && CanvasRenderingContext2D !== null && image instanceof CanvasRenderingContext2D || typeof WebGLRenderingContext !== "undefined" && WebGLRenderingContext !== null && image instanceof WebGLRenderingContext) { if (options.copy) { frame.data = this.getContextData(image) } else { frame.context = image } } else if (image.childNodes != null) { if (options.copy) { frame.data = this.getImageData(image) } else { frame.image = image } } else { throw new Error("Invalid image") } return this.frames.push(frame) }; GIF.prototype.render = function () { var i, j, numWorkers, ref; if (this.running) { throw new Error("Already running") } if (this.options.width == null || this.options.height == null) { throw new Error("Width and height must be set prior to rendering") } this.running = true; this.nextFrame = 0; this.finishedFrames = 0; this.imageParts = function () { var j, ref, results; results = []; for (i = j = 0, ref = this.frames.length; 0 <= ref ? j < ref : j > ref; i = 0 <= ref ? ++j : --j) { results.push(null) } return results }.call(this); numWorkers = this.spawnWorkers(); if (this.options.globalPalette === true) { this.renderNextFrame() } else { for (i = j = 0, ref = numWorkers; 0 <= ref ? j < ref : j > ref; i = 0 <= ref ? ++j : --j) { this.renderNextFrame() } } this.emit("start"); return this.emit("progress", 0) }; GIF.prototype.abort = function () { var worker; while (true) { worker = this.activeWorkers.shift(); if (worker == null) { break } this.log("killing active worker"); worker.terminate() } this.running = false; return this.emit("abort") }; GIF.prototype.spawnWorkers = function () { var j, numWorkers, ref, results; numWorkers = Math.min(this.options.workers, this.frames.length); (function () { results = []; for (var j = ref = this.freeWorkers.length; ref <= numWorkers ? j < numWorkers : j > numWorkers; ref <= numWorkers ? j++ : j--) { results.push(j) } return results }).apply(this).forEach(function (_this) { return function (i) { var worker; _this.log("spawning worker " + i); worker = new Worker(_this.options.workerScript); worker.onmessage = function (event) { _this.activeWorkers.splice(_this.activeWorkers.indexOf(worker), 1); _this.freeWorkers.push(worker); return _this.frameFinished(event.data) }; return _this.freeWorkers.push(worker) } }(this)); return numWorkers }; GIF.prototype.frameFinished = function (frame) { var i, j, ref; this.log("frame " + frame.index + " finished - " + this.activeWorkers.length + " active"); this.finishedFrames++; this.emit("progress", this.finishedFrames / this.frames.length); this.imageParts[frame.index] = frame; if (this.options.globalPalette === true) { this.options.globalPalette = frame.globalPalette; this.log("global palette analyzed"); if (this.frames.length > 2) { for (i = j = 1, ref = this.freeWorkers.length; 1 <= ref ? j < ref : j > ref; i = 1 <= ref ? ++j : --j) { this.renderNextFrame() } } } if (indexOf.call(this.imageParts, null) >= 0) { return this.renderNextFrame() } else { return this.finishRendering() } }; GIF.prototype.finishRendering = function () { var data, frame, i, image, j, k, l, len, len1, len2, len3, offset, page, ref, ref1, ref2; len = 0; ref = this.imageParts; for (j = 0, len1 = ref.length; j < len1; j++) { frame = ref[j]; len += (frame.data.length - 1) * frame.pageSize + frame.cursor } len += frame.pageSize - frame.cursor; this.log("rendering finished - filesize " + Math.round(len / 1e3) + "kb"); data = new Uint8Array(len); offset = 0; ref1 = this.imageParts; for (k = 0, len2 = ref1.length; k < len2; k++) { frame = ref1[k]; ref2 = frame.data; for (i = l = 0, len3 = ref2.length; l < len3; i = ++l) { page = ref2[i]; data.set(page, offset); if (i === frame.data.length - 1) { offset += frame.cursor } else { offset += frame.pageSize } } } image = new Blob([data], { type: "image/gif" }); return this.emit("finished", image, data) }; GIF.prototype.renderNextFrame = function () { var frame, task, worker; if (this.freeWorkers.length === 0) { throw new Error("No free workers") } if (this.nextFrame >= this.frames.length) { return } frame = this.frames[this.nextFrame++]; worker = this.freeWorkers.shift(); task = this.getTask(frame); this.log("starting frame " + (task.index + 1) + " of " + this.frames.length); this.activeWorkers.push(worker); return worker.postMessage(task) }; GIF.prototype.getContextData = function (ctx) { return ctx.getImageData(0, 0, this.options.width, this.options.height).data }; GIF.prototype.getImageData = function (image) { var ctx; if (this._canvas == null) { this._canvas = document.createElement("canvas"); this._canvas.width = this.options.width; this._canvas.height = this.options.height } ctx = this._canvas.getContext("2d"); ctx.setFill = this.options.background; ctx.fillRect(0, 0, this.options.width, this.options.height); ctx.drawImage(image, 0, 0); return this.getContextData(ctx) }; GIF.prototype.getTask = function (frame) { var index, task; index = this.frames.indexOf(frame); task = { index: index, last: index === this.frames.length - 1, delay: frame.delay, transparent: frame.transparent, width: this.options.width, height: this.options.height, quality: this.options.quality, dither: this.options.dither, globalPalette: this.options.globalPalette, repeat: this.options.repeat, canTransfer: browser.name === "chrome" }; if (frame.data != null) { task.data = frame.data } else if (frame.context != null) { task.data = this.getContextData(frame.context) } else if (frame.image != null) { task.data = this.getImageData(frame.image) } else { throw new Error("Invalid frame") } return task }; GIF.prototype.log = function () { var args; args = 1 <= arguments.length ? slice.call(arguments, 0) : []; if (!this.options.debug) { return } return console.log.apply(console, args) }; return GIF }(EventEmitter); module.exports = GIF }, { "./browser.coffee": 2, events: 1 }] }, {}, [3])(3) });
  

;


    (function () {
      // Click FX disabled.
    })();
  

;


    (function () {


      const MAX_W = 500, MAX_H = 400; let W = MAX_W, H = MAX_H;

      const stage = document.getElementById('stage'), stageWrap = document.getElementById('stageWrap');
      const ctx = stage.getContext('2d', { alpha: true }); ctx.imageSmoothingEnabled = false;


      const view = { scale: 2.2, tx: 0, ty: 0, minScale: .5, maxScale: 64 }; let autoCenter = true;
      function centerView() { view.tx = (stage.width - W * view.scale) * .5; view.ty = (stage.height - H * view.scale) * .5; }


      const zoomLevelEl = document.getElementById('zoomLevel');
      function updateZoomDisplay() {
        const pct = Math.round(view.scale * 100);
        if (zoomLevelEl) zoomLevelEl.textContent = pct + '%';
      }

      let stageRectLeft = 0;
      let stageRectTop = 0;
      let stageRectW = 1;
      let stageRectH = 1;
      let stageScaleX = 1;
      let stageScaleY = 1;

      function refreshStagePointerMetrics(forceRect = false) {
        if (forceRect || stageRectW <= 0 || stageRectH <= 0) {
          const r = stage.getBoundingClientRect();
          stageRectLeft = r.left;
          stageRectTop = r.top;
          stageRectW = Math.max(1, r.width);
          stageRectH = Math.max(1, r.height);
        }
        stageScaleX = stage.width / stageRectW;
        stageScaleY = stage.height / stageRectH;
      }

      function resizeCanvasToViewport() {
        const r = stageWrap.getBoundingClientRect(), dpr = Math.max(1, window.devicePixelRatio || 1);

        const zoomFactor = 0.9;
        const w = Math.max(1, Math.floor((r.width / zoomFactor) * dpr)), h = Math.max(1, Math.floor((r.height / zoomFactor) * dpr));
        if (stage.width !== w || stage.height !== h) {
          stage.width = w; stage.height = h; stage.style.width = (r.width / zoomFactor) + 'px'; stage.style.height = (r.height / zoomFactor) + 'px';
          ctx.imageSmoothingEnabled = false; if (autoCenter) centerView(); render();
        }
        refreshStagePointerMetrics(true);
      }
      new ResizeObserver(resizeCanvasToViewport).observe(stageWrap); setTimeout(resizeCanvasToViewport, 0);
      window.addEventListener('resize', () => refreshStagePointerMetrics(true), { passive: true });
      window.addEventListener('scroll', () => refreshStagePointerMetrics(true), { passive: true });

      function makeCanvas(w = W, h = H) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
      function cloneCanvas(src) { const c = makeCanvas(src.width, src.height); c.getContext('2d').drawImage(src, 0, 0); return c; }

      let preStrokeCan, preStrokeCtx;
      let tintCan, tintCtx;
      let onionScratchCan, onionScratchCtx;
      const sampleCan = makeCanvas(1, 1);
      const sampleCtx = sampleCan.getContext('2d');
      sampleCtx.imageSmoothingEnabled = false;

      function resetRenderScratchBuffers() {
        preStrokeCan = makeCanvas(W, H);
        preStrokeCtx = preStrokeCan.getContext('2d');
        tintCan = makeCanvas(W, H);
        tintCtx = tintCan.getContext('2d');
        tintCtx.imageSmoothingEnabled = false;
        onionScratchCan = makeCanvas(W, H);
        onionScratchCtx = onionScratchCan.getContext('2d');
        onionScratchCtx.imageSmoothingEnabled = false;
      }
      resetRenderScratchBuffers();


      const colorInp = document.getElementById('color'), swatches = document.getElementById('swatches'), pickBtn = document.getElementById('pickBtn'), currentColorBtn = document.getElementById('currentColor'), pickerPair = document.getElementById('pickerPair');
      const sizeInp = document.getElementById('size'), sizeVal = document.getElementById('sizeVal');
      const ditherInp = document.getElementById('dither'), ditherVal = document.getElementById('ditherVal');
      const fpsInp = document.getElementById('fpsNum');
      const onionToggle = document.getElementById('onionToggle'), onionBtn = document.getElementById('onionBtn');
      const playBtn = document.getElementById('playBtn'), exportBtn = document.getElementById('exportBtn'), importBtn = document.getElementById('importBtn'), fileInput = document.getElementById('fileInput');
      const importAnyInput = document.getElementById('importAnyInput');
      const imageImportInput = document.getElementById('imageImportInput');
      const flipInput = document.getElementById('flipInput');
      const undoBtn = document.getElementById('undoBtn'), redoBtn = document.getElementById('redoBtn');
      const framesWrap = document.getElementById('frames'), dropMarker = document.getElementById('dropMarker');
      const canvasSizeTxt = document.getElementById('canvasSizeTxt'), resizeBtn = document.getElementById('resizeBtn');
      const brushTool = document.getElementById('brushTool'), eraserTool = document.getElementById('eraserTool'), fillTool = document.getElementById('fillTool'), selectTool = document.getElementById('selectTool'), lassoTool = document.getElementById('lassoTool'), shapeTool = document.getElementById('shapeTool'), smudgeTool = document.getElementById('smudgeTool'), fxTool = document.getElementById('fxTool');
      let smudge = { size: 10, strength: 50, mode: 'N' };
      let smudgeState = { active: false, pid: -1, lastX: 0, lastY: 0 };
      const ditherFillSettings = document.getElementById('ditherFillSettings');
      const pressureBtn = document.getElementById('pressureBtn');
      const eraserPressureBtn = document.getElementById('eraserPressureBtn');
      const ditherFillModeInp = document.getElementById('ditherFillMode');
      const ditherFillInvertInp = document.getElementById('ditherFillInvert');
      const ditherFillShapeInp = document.getElementById('ditherFillShape');
      const ditherFalloffInp = document.getElementById('ditherFalloff');
      const ditherFalloffVal = document.getElementById('ditherFalloffVal');
      const fillSettings = document.getElementById('fillSettings');
      const fillDitherInp = document.getElementById('fillDither');
      const fillDitherVal = document.getElementById('fillDitherVal');
      const fillPreviewCanvas = document.getElementById('fillPreview');
      const ditherFillPreviewCanvas = document.getElementById('ditherFillPreview');
      const fxSettings = document.getElementById('fxSettings');
      const fxPreviewCanvas = document.getElementById('fxPreview');



      const selectionSettings = null;

      let selectionCopyMode = false;

      const toast = document.getElementById('toast');


      const addFrameBtn = document.getElementById('addFrameBtn');
      const dupFrameBtn = document.getElementById('dupFrameBtn');
      const moveLeftBtn = document.getElementById('moveLeftBtn');
      const moveRightBtn = document.getElementById('moveRightBtn');
      const delFrameBtn = document.getElementById('delFrameBtn');

      const exportBackdrop = document.getElementById('exportBackdrop');
      const exportNameInp = document.getElementById('exportName');
      const exportCancel = document.getElementById('exportCancel');
      const exportGo = document.getElementById('exportGo');
      const exportTypeBtns = [...document.querySelectorAll('#exportTypeList .export-type-btn')];
      const exportPreviewCanvas = document.getElementById('exportPreviewCanvas');
      const exportPreviewCtx = exportPreviewCanvas ? exportPreviewCanvas.getContext('2d') : null;
      const exportPreviewToggleBtn = document.getElementById('exportPreviewToggle');
      const exportPreviewToggleIcon = document.getElementById('exportPreviewToggleIcon');
      const exportPreviewInfo = document.getElementById('exportPreviewInfo');
      const exportFramePanel = document.getElementById('exportFramePanel');
      const exportFrameCurrentBtn = document.getElementById('exportFrameCurrent');
      const exportFrameRangeBtn = document.getElementById('exportFrameRange');
      const exportFrameAllBtn = document.getElementById('exportFrameAll');
      const exportFrameFromInp = document.getElementById('exportFrameFrom');
      const exportFrameToInp = document.getElementById('exportFrameTo');
      const exportFrameStepInp = document.getElementById('exportFrameStep');
      const exportFrameApplyBtn = document.getElementById('exportFrameApply');
      const exportPreviewSlider = document.getElementById('exportPreviewSlider');
      const exportPreviewPrevBtn = document.getElementById('exportPreviewPrev');
      const exportPreviewNextBtn = document.getElementById('exportPreviewNext');
      const exportFrameMeta = document.getElementById('exportFrameMeta');


      const wInput = document.getElementById('wInput'), hInput = document.getElementById('hInput'), modalBackdrop = document.getElementById('modalBackdrop');
      const onionPrevInput = document.getElementById('onionPrev');
      const onionNextInput = document.getElementById('onionNext');
      const onionMaxOpacityPct = document.getElementById('onionMaxOpacityPct');
      const onionFalloffPct = document.getElementById('onionFalloffPct');
      const bgTransparentInput = document.getElementById('bgTransparent');
      const filmstripCompactToggle = document.getElementById('filmstripCompactToggle');


      const shapePanel = document.getElementById('shapePanel');
      const shapeHead = shapePanel.querySelector('.shapeHead');
      const shapeBtns = [...shapePanel.querySelectorAll('.shapeBtn')];
      const shapeFill = document.getElementById('shapeFill');


      const textTool = document.getElementById('textTool');
      const textPanel = document.getElementById('textPanel');
      const textBold = document.getElementById('textBold');
      const textItalic = document.getElementById('textItalic');
      const textSize = document.getElementById('textSize');
      const textSizeVal = document.getElementById('textSizeVal');
      const textFont = document.getElementById('textFont');
      const textFontInline = document.getElementById('textFontInline');
      let textState = { bold: false, italic: false, scale: 1, x: 0, y: 0, active: false, text: '', cursorPos: 0, font: 'Standard' };



      const BITMAP_FONT = {
        'A': [0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1],
        'B': [1, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 0],
        'C': [0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0],
        'D': [1, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 0],
        'E': [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1],
        'F': [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0],
        'G': [0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0],
        'H': [1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1],
        'I': [1, 1, 1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1, 1, 1],
        'J': [0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0],
        'K': [1, 0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1],
        'L': [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1],
        'M': [1, 0, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1],
        'N': [1, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1],
        'O': [0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0],
        'P': [1, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0],
        'Q': [0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 1, 0, 1],
        'R': [1, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1],
        'S': [0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0],
        'T': [1, 1, 1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0],
        'U': [1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0],
        'V': [1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0],
        'W': [1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 0, 0, 1],
        'X': [1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1],
        'Y': [1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0],
        'Z': [1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1],
        '0': [0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 1, 0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0],
        '1': [0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0],
        '2': [0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1, 1],
        '3': [0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0],
        '4': [0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
        '5': [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0],
        '6': [0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0],
        '7': [1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0],
        '8': [0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0],
        '9': [0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0],
        ' ': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        '.': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0],
        ',': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
        '!': [0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0],
        '@': [0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 0],
        '#': [0, 1, 0, 1, 0, 1, 1, 1, 1, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 1, 1, 1, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0],
        '$': [0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 1, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 1, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0],
        '%': [1, 1, 0, 0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0, 0, 1, 1],
        '^': [0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        '&': [0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 1],
        '*': [0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        '(': [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0],
        ')': [0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
        '_': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1],
        '+': [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
        '-': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        '=': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],

        '[': [1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0],

        ']': [0, 0, 1, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1],

        '{': [0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 0],

        '}': [0, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0],
        '|': [0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0],
        ';': [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
        ':': [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        "'": [0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        '"': [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        ',': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],

        '<': [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],

        '>': [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
        '?': [0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0],
        '/': [0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0],
        '\\': [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0],
        '`': [0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        '~': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],

        'a': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0, 1, 1, 1, 1],
        'b': [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 0],
        'c': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0],
        'd': [0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 1, 1, 1],
        'e': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 0],
        'f': [0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0],
        'g': [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 1, 1, 1, 0],
        'h': [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1],
        'i': [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0],
        'j': [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0],
        'k': [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0],
        'l': [0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0],
        'm': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1],
        'n': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1],
        'o': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0],
        'p': [0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0],
        'q': [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        'r': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0],
        's': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0],
        't': [0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0],
        'u': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 1, 1, 1],
        'v': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0],
        'w': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
        'x': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1],
        'y': [0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 1, 1, 1, 0],
        'z': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1, 1],
        '©': [0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0],
        '®': [1, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 0],
        '™': [1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0],
        '€': [0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0],
        '£': [0, 1, 1, 1, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
        '¥': [1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0],
        '°': [0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        '±': [0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
        '÷': [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
        '×': [1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      };

      const TINY_FONT = {
        'A': [1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1],
        'B': [1, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 1, 1, 0],
        'C': [0, 1, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 1],
        'D': [1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 0],
        'E': [1, 1, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1, 1, 1],
        'F': [1, 1, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 1, 0, 0],
        'G': [0, 1, 1, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1],
        'H': [1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1],
        'I': [1, 1, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 1],
        'J': [0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 1, 0, 1, 1],
        'K': [1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 0, 1, 1, 0, 1],
        'L': [1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 1],
        'M': [1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1],
        'N': [1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1],
        'O': [1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1],
        'P': [1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 1, 0, 0],
        'Q': [1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 0, 1, 0, 0, 1],
        'R': [1, 1, 0, 1, 0, 1, 1, 1, 0, 1, 1, 0, 1, 0, 1],
        'S': [1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 1],
        'T': [1, 1, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
        'U': [1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1],
        'V': [1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 0, 1, 0],
        'W': [1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1],
        'X': [1, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 1],
        'Y': [1, 0, 1, 1, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0],
        'Z': [1, 1, 1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1],
        '0': [1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1],
        '1': [0, 1, 0, 1, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 1],
        '2': [1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 0, 0, 1, 1, 1],
        '3': [1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1],
        '4': [1, 0, 1, 1, 0, 1, 1, 1, 1, 0, 0, 1, 0, 0, 1],
        '5': [1, 1, 1, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 1],
        '6': [1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1],
        '7': [1, 1, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
        '8': [1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1],
        '9': [1, 1, 1, 1, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1],
        ' ': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        '.': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0],
        '!': [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0],
        '?': [1, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0],
      };

      const FONTS = {
        'Standard': { data: BITMAP_FONT, w: 5, h: 7, gap: 1, lineH: 9 },
        'Tiny': { data: TINY_FONT, w: 3, h: 5, gap: 1, lineH: 7 }
      };
      const FONT_W = 5, FONT_H = 7, FONT_GAP = 1;


      const BTN_BASE_PX = 32, BTN_LOCK_MIN_PX = 32, BTN_LOCK_AT_ZOOM = 1, BTN_PAD_PX = 8;


      function buildTicks(el, steps = 10, majorEvery = 5) { const t = el.querySelector('.ticks'); t.innerHTML = ''; for (let i = 0; i <= steps; i++) { const s = document.createElement('span'); s.className = 'tick' + (i % majorEvery === 0 ? ' major' : ''); s.style.left = `calc(${(i / steps) * 100}% - 1px)`; t.appendChild(s); } }
      buildTicks(document.getElementById('sizeSlider'), 16, 4);
      buildTicks(document.getElementById('ditherSlider'), 10, 5);
      buildTicks(document.getElementById('pressureSensSlider'), 4, 2);
      buildTicks(document.getElementById('eraserSizeSlider'), 16, 4);
      buildTicks(document.getElementById('eraserDitherSlider'), 10, 5);
      buildTicks(document.getElementById('eraserPressureSensSlider'), 4, 2);
      buildTicks(document.getElementById('fillDitherSlider'), 10, 5);
      buildTicks(document.getElementById('ditherFalloffSlider'), 9, 3);
      buildTicks(document.getElementById('shapeSizeSlider'), 16, 4);
      buildTicks(document.getElementById('shapeDitherSlider'), 10, 5);
      buildTicks(document.getElementById('textSizeSliderInline'), 3, 1);
      buildTicks(document.getElementById('smudgeSizeSlider'), 16, 4);
      buildTicks(document.getElementById('smudgeStrengthSlider'), 10, 5);
      buildTicks(document.getElementById('fxTrailSizeSlider'), 16, 4);
      buildTicks(document.getElementById('fxTrailSpacingSlider'), 15, 5);
      buildTicks(document.getElementById('fxTrailVariationSlider'), 10, 5);
      buildTicks(document.getElementById('fxOutlineThicknessSlider'), 7, 1);
      buildTicks(document.getElementById('fxOutlineGapSlider'), 8, 2);
      buildTicks(document.getElementById('fxGlowRadiusSlider'), 9, 3);
      buildTicks(document.getElementById('fxGlowGapSlider'), 6, 2);
      buildTicks(document.getElementById('fxGlowDitherSlider'), 9, 3);
      buildTicks(document.getElementById('lassoPaintDitherSlider'), 10, 5);
      function setRangeProgress(input) { const min = +input.min || 0, max = +input.max || 100, val = +input.value || 0; input.style.setProperty('--pct', ((val - min) / (max - min)) * 100 + '%'); }


      const brush = { size: 2, color: '#000000', smoothing: .35, ditherLevel: 0, usePressure: false, pressureTarget: 'size', pressureSens: 50, stabilizer: 'normal' };
      const eraser = { size: 4, ditherLevel: 0, usePressure: false, pressureTarget: 'size', pressureSens: 50, stabilizer: 'none' };
      const fx = {
        mode: 'trail',
        trail: { size: 4, spacing: 8, variation: 30, shape: 'dot' },
        outline: { thickness: 1, gap: 0, flood: true },
        glow: { radius: 3, gap: 1, dither: 7 }
      };
      let fxStroke = {
        mode: null,
        lastStampX: null,
        lastStampY: null,
        sourceAlpha: null,
        outlineOuterOffsets: null,
        outlineGapOffsets: null
      };
      function getStabilizerMode() {
        const t = currentTool();
        if (t === 'brush') return brush.stabilizer;
        if (t === 'eraser') return eraser.stabilizer;
        if (t === 'fxTrail' || t === 'fxOutline' || t === 'fxOutlineFlood' || t === 'fxGlow' || t === 'lassoPaint') return 'none';
        return 'normal';
      }
      function setStabilizerMode(m) { const t = currentTool(); if (t === 'brush') brush.stabilizer = m; else if (t === 'eraser') eraser.stabilizer = m; }
      const stabilizer = { get mode() { return getStabilizerMode(); }, set mode(m) { setStabilizerMode(m); } };
      const ditherFill = { mode: 'linear', invert: false, falloff: 5, shapeFill: false };
      const lassoPaint = { dither: 0 };
      let fillDither = 0;
      const ditherFillDrag = { dragging: false, x0: 0, y0: 0, x1: 0, y1: 0, pid: null };
      let motionState = { active: false, drawing: false, points: [], returningToModal: false };
      let tool = 'brush', tempTool = null, picking = false;
      let cursorPos = { x: 0, y: 0, visible: false };
      let pickerSampling = false; let lastSampledHex = null;

      function updatePickerCanvasCursor() {
        const usingPickerCursor = stage.style.cursor && stage.style.cursor.indexOf('data:image/svg+xml') !== -1;
        if (usingPickerCursor) {
          stage.style.cursor = '';
        }
      }

      function setPickingEnabled(next) {
        picking = !!next;
        if (!picking) pickerSampling = false;
        const pickerActive = (picking || pickerSampling);
        pickBtn.classList.toggle('active', pickerActive);
        if (currentColorBtn) currentColorBtn.classList.toggle('picker-active', pickerActive);
        if (pickerPair) pickerPair.classList.toggle('picker-active', pickerActive);
        updatePickerCanvasCursor();
        requestRender();
      }


      const mirror = { h: false, v: false };

      function mirrorCoord(coord, limit, stampSize = 1) {
        const s = Math.max(1, stampSize | 0);
        return (s & 1) ? (limit - 1 - coord) : (limit - coord);
      }

      function mirrorXCoord(x, stampSize = 1) {
        return mirrorCoord(x, W, stampSize);
      }

      function mirrorYCoord(y, stampSize = 1) {
        return mirrorCoord(y, H, stampSize);
      }

      function updateBrushUI() {

      }


      const cpModal = document.getElementById('colorPickerBg');
      const cpWheel = document.getElementById('cpWheel');
      const cpCtx = cpWheel.getContext('2d', { willReadFrequently: true });
      const cpSlider = document.getElementById('cpSlider');
      const cpHexInput = document.getElementById('cpHexInput');
      const cpPreview = document.getElementById('cpPreview');
      let cpState = { h: 0, s: 1, v: 1 };
      let cpIsDraggingWheel = false;

      function hsvToRgb(h, s, v) {
        let r, g, b, i, f, p, q, t;
        i = Math.floor(h * 6); f = h * 6 - i; p = v * (1 - s); q = v * (1 - f * s); t = v * (1 - (1 - f) * s);
        switch (i % 6) {
          case 0: r = v; g = t; b = p; break;
          case 1: r = q; g = v; b = p; break;
          case 2: r = p; g = v; b = t; break;
          case 3: r = p; g = q; b = v; break;
          case 4: r = t; g = p; b = v; break;
          case 5: r = v; g = p; b = q; break;
        }
        return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
      }

      function rgbToHsv(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h, s, v = max;
        const d = max - min;
        s = max === 0 ? 0 : d / max;
        if (max === min) h = 0;
        else {
          switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            case b: h = (r - g) / d + 4; break;
          }
          h /= 6;
        }
        return { h, s, v };
      }

      function rgbToHex(r, g, b) {
        return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
      }

      let cpCache = null;

      function drawColorWheel() {
        const w = cpWheel.width, h = cpWheel.height, cx = w / 2, cy = h / 2, r = w / 2 - 2;
        const imgData = cpCtx.createImageData(w, h), data = imgData.data;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const dx = x - cx, dy = y - cy, dist = Math.sqrt(dx * dx + dy * dy);
            if (dist <= r) {
              const angle = Math.atan2(dy, dx) + Math.PI;
              const hue = angle / (2 * Math.PI);
              const sat = dist / r;
              const [rr, gg, bb] = hsvToRgb(hue, sat, 1);
              const idx = (y * w + x) * 4;
              data[idx] = rr; data[idx + 1] = gg; data[idx + 2] = bb; data[idx + 3] = 255;
            }
          }
        }
        cpCtx.putImageData(imgData, 0, 0);
        cpCache = imgData;
      }

      drawColorWheel();

      function updateCPUI() {
        const [r, g, b] = hsvToRgb(cpState.h, cpState.s, cpState.v);
        const hex = rgbToHex(r, g, b);
        if (document.activeElement !== cpHexInput) cpHexInput.value = hex.substring(1);
        cpPreview.style.background = hex;
        if (typeof pickerLiveCallback === 'function') pickerLiveCallback(hex);


        if (cpCache) cpCtx.putImageData(cpCache, 0, 0);

        const cx = 100, cy = 100, rad = 98;
        const angle = cpState.h * Math.PI * 2 - Math.PI;
        const dist = cpState.s * rad;
        const mx = cx + Math.cos(angle) * dist, my = cy + Math.sin(angle) * dist;
        cpCtx.beginPath(); cpCtx.arc(mx, my, 5, 0, Math.PI * 2);
        cpCtx.strokeStyle = '#fff'; cpCtx.lineWidth = 2; cpCtx.stroke(); cpCtx.strokeStyle = '#000'; cpCtx.lineWidth = 1; cpCtx.stroke();

        const [r0, g0, b0] = hsvToRgb(cpState.h, cpState.s, 0);
        const [r1, g1, b1] = hsvToRgb(cpState.h, cpState.s, 1);
        cpSlider.style.background = `linear-gradient(to right, rgb(${r0},${g0},${b0}), rgb(${r1},${g1},${b1}))`;
      }

      let pickerResolve = null;
      let pickerLiveCallback = null;
      function openColorPicker(initialHex, options = null) {
        const rgba = hexToRGBA(initialHex);
        cpState = rgbToHsv(rgba[0], rgba[1], rgba[2]);
        pickerLiveCallback = options && typeof options.onLiveColor === 'function'
          ? options.onLiveColor
          : null;
        cpSlider.value = cpState.v * 100;
        cpModal.style.display = 'flex';
        drawColorWheel();
        updateCPUI();
        return new Promise(r => pickerResolve = r);
      }

      function closeColorPicker(result) {
        cpModal.style.display = 'none';
        if (pickerResolve) pickerResolve(result || null);
        pickerResolve = null;
        pickerLiveCallback = null;
      }


      function handleWheelInput(e) {
        const rect = cpWheel.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        const cx = rect.width / 2, cy = rect.height / 2;
        const dx = x - cx, dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);

        const radius = (rect.width / 2) * 0.98;
        const sat = Math.min(1, dist / radius);
        const angle = Math.atan2(dy, dx) + Math.PI;
        cpState.h = angle / (2 * Math.PI);
        cpState.s = sat;
        updateCPUI();
      }

      cpWheel.addEventListener('pointerdown', e => { cpIsDraggingWheel = true; handleWheelInput(e); });
      window.addEventListener('pointermove', e => { if (cpIsDraggingWheel) handleWheelInput(e); });
      window.addEventListener('pointerup', () => cpIsDraggingWheel = false);

      cpSlider.addEventListener('input', () => { cpState.v = cpSlider.value / 100; updateCPUI(); });

      cpApplyBtn.onclick = () => {
        const [r, g, b] = hsvToRgb(cpState.h, cpState.s, cpState.v);
        closeColorPicker(rgbToHex(r, g, b));
      };
      cpCancelBtn.onclick = () => closeColorPicker(null);

      const performHexSync = () => {
        let hex = cpHexInput.value.replace('#', '');
        if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
        if (hex.length === 6) {
          const rgb = hexToRGBA('#' + hex);
          if (rgb) {
            cpState = rgbToHsv(rgb[0], rgb[1], rgb[2]);
            cpSlider.value = cpState.v * 100;
            updateCPUI();
          }
        }
      };

      cpHexInput.addEventListener('input', performHexSync);

      cpHexInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          performHexSync();
          const [r, g, b] = hsvToRgb(cpState.h, cpState.s, cpState.v);
          closeColorPicker(rgbToHex(r, g, b));
        }
      });





      const BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
      function ditherLimit(level) { if (level <= 0) return null; const limit = 16 - Math.round((level / 10) * 15); return Math.max(1, Math.min(15, limit)); }


      let bgTransparent = false;
      let bgColor = '#ffffff';


      const checkerTile = (() => { const c = document.createElement('canvas'); c.width = 16; c.height = 16; const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8); return c; })();


      function newFrame(copyFrom) {

        const layer1Can = makeCanvas(); const layer1Ctx = layer1Can.getContext('2d'); layer1Ctx.imageSmoothingEnabled = false;
        const layer2Can = makeCanvas(); const layer2Ctx = layer2Can.getContext('2d'); layer2Ctx.imageSmoothingEnabled = false;
        const bgCan = makeCanvas(); const bgCtx = bgCan.getContext('2d'); bgCtx.imageSmoothingEnabled = false;


        if (!bgTransparent) {
          bgCtx.fillStyle = bgColor;
          bgCtx.fillRect(0, 0, W, H);
        } else {
          bgCtx.fillStyle = '#ffffff';
          bgCtx.fillRect(0, 0, W, H);
          bgCtx.globalAlpha = 0.14;
          bgCtx.fillStyle = bgCtx.createPattern(checkerTile, 'repeat');
          bgCtx.fillRect(0, 0, W, H);
          bgCtx.globalAlpha = 1;
        }


        let layer1Visible = true, layer1Opacity = 1;
        let layer2Visible = true, layer2Opacity = 1;

        if (copyFrom && copyFrom.layers) {

          layer1Visible = copyFrom.layers[0].visible;
          layer1Opacity = copyFrom.layers[0].opacity;
          layer2Visible = copyFrom.layers[1].visible;
          layer2Opacity = copyFrom.layers[1].opacity;
        } else {

          try {
            if (frames && frames.length > 0 && frames[0] && frames[0].layers) {
              layer1Visible = frames[0].layers[0].visible;
              layer1Opacity = frames[0].layers[0].opacity;
              layer2Visible = frames[0].layers[1].visible;
              layer2Opacity = frames[0].layers[1].opacity;
            }
          } catch (e) {

          }
        }


        if (copyFrom) {
          if (copyFrom.layers) {

            layer1Ctx.drawImage(copyFrom.layers[0].can, 0, 0);
            layer2Ctx.drawImage(copyFrom.layers[1].can, 0, 0);
            bgCtx.clearRect(0, 0, W, H);
            bgCtx.drawImage(copyFrom.bg.can, 0, 0);
          } else {

            layer1Ctx.drawImage(copyFrom, 0, 0);
          }
        }

        const thumb = makeCanvas(168, 134);
        const thumbCtx = thumb.getContext('2d');
        thumbCtx.imageSmoothingEnabled = false;

        return {
          layers: [
            { can: layer1Can, ctx: layer1Ctx, visible: layer1Visible, opacity: layer1Opacity },
            { can: layer2Can, ctx: layer2Ctx, visible: layer2Visible, opacity: layer2Opacity }
          ],
          bg: { can: bgCan, ctx: bgCtx },
          thumb,
          thumbCtx,
          delay: copyFrom?.delay || null
        };
      }
      let frames = [newFrame()], current = 0, timelineHidden = false;


      let activeLayer = 0;
      let layerOrder = [1, 0];


      const history = [], redoStack = [];
      const MAX_HISTORY = 50;
      let showHistoryToasts = localStorage.getItem('fliplite_historyToasts') === 'true';
      function capHistory() { if (history.length > MAX_HISTORY) history.shift(); }
      function capRedo() { if (redoStack.length > MAX_HISTORY) redoStack.shift(); }
      let historyReplayBatchDepth = 0;
      let historyReplayNeedsFilmBuild = false;
      function beginHistoryReplayBatch() { historyReplayBatchDepth++; }
      function endHistoryReplayBatch() {
        if (historyReplayBatchDepth <= 0) return;
        historyReplayBatchDepth--;
        if (!historyReplayBatchDepth && historyReplayNeedsFilmBuild) {
          historyReplayNeedsFilmBuild = false;
          buildFilm();
        }
      }
      function requestHistoryReplayFilmBuild() {
        if (historyReplayBatchDepth > 0) {
          historyReplayNeedsFilmBuild = true;
          return;
        }
        buildFilm();
      }
      let playbackStrokeBeforeByFrame = null;
      let playbackStrokeLayer = 0;

      function isPlaybackPaintTool(t) {
        if (t === 'brush' || t === 'eraser') return true;
        if (t === 'smudge') return !(mirror.h || mirror.v);
        return false;
      }

      function beginPlaybackStrokeHistory(layerIdx = activeLayer) {
        playbackStrokeLayer = layerIdx | 0;
        playbackStrokeBeforeByFrame = new Map();
      }

      function recordPlaybackFrameBefore(fi) {
        if (!playbackStrokeBeforeByFrame) return;
        if (playbackStrokeBeforeByFrame.has(fi)) return;
        const frame = frames[fi];
        const layer = frame?.layers?.[playbackStrokeLayer];
        if (!layer) return;
        playbackStrokeBeforeByFrame.set(fi, layer.ctx.getImageData(0, 0, W, H));
      }

      function commitPlaybackStrokeHistory() {
        if (!playbackStrokeBeforeByFrame || playbackStrokeBeforeByFrame.size === 0) {
          playbackStrokeBeforeByFrame = null;
          return;
        }

        const ops = [];
        for (const [fi, before] of playbackStrokeBeforeByFrame.entries()) {
          const frame = frames[fi];
          const layer = frame?.layers?.[playbackStrokeLayer];
          if (!layer) continue;
          const after = layer.ctx.getImageData(0, 0, W, H);
          ops.push({
            type: 'paint',
            fi,
            x: 0,
            y: 0,
            w: W,
            h: H,
            before,
            after,
            layer: playbackStrokeLayer
          });
          updateThumb(fi);
        }

        playbackStrokeBeforeByFrame = null;
        if (!ops.length) return;

        if (ops.length === 1) history.push(ops[0]);
        else history.push({ type: 'batch', ops, activeLayer: playbackStrokeLayer });
        capHistory();
        redoStack.length = 0;
        refreshAllFilmTileThumbs();
      }

      function clearPlaybackStrokeHistory() {
        playbackStrokeBeforeByFrame = null;
      }

      function pushPaintPatch(fi, x, y, w, h, before, after, layer, selSnapshot) {
        history.push({ type: 'paint', fi, x, y, w, h, before, after, layer: layer !== undefined ? layer : activeLayer, selSnapshot });
        capHistory(); redoStack.length = 0;
      }
      function pushFrameInsert(index, data, selSnap, meta) {
        const state = meta || {};
        history.push({
          type: 'frameInsert',
          index,
          data,
          activeLayer,
          selSnap: selSnap || null,
          prevCurrent: Number.isInteger(state.prevCurrent) ? state.prevCurrent : current,
          nextCurrent: Number.isInteger(state.nextCurrent) ? state.nextCurrent : index,
          prevSelection: Array.isArray(state.prevSelection) ? [...state.prevSelection] : null,
          nextSelection: Array.isArray(state.nextSelection) ? [...state.nextSelection] : null
        });
        capHistory();
        redoStack.length = 0;
      }
      function pushFrameDelete(index, data, selSnap) { history.push({ type: 'frameDelete', index, data, activeLayer, selSnap: selSnap || null }); capHistory(); redoStack.length = 0; }
      function pushMultiFrameDelete(deletions, selSnap) {
        history.push({ type: 'multiFrameDelete', deletions, activeLayer, selSnap: selSnap || null });
        capHistory(); redoStack.length = 0;
      }
      function pushFrameMove(from, to) { history.push({ type: 'frameMove', from, to, activeLayer }); capHistory(); redoStack.length = 0; }
      function pushMultiFrameMove(fromIndices, toStart, prevSelection, newSelection) {
        history.push({ type: 'multiFrameMove', fromIndices, toStart, prevSelection: [...prevSelection], newSelection: [...newSelection], activeLayer });
        capHistory(); redoStack.length = 0;
      }
      function pushDelayChange(frameIndex, oldDelay, newDelay) { history.push({ type: 'delayChange', frameIndex, oldDelay, newDelay, activeLayer }); capHistory(); redoStack.length = 0; }
      function pushMultiDelayChange(changes) { history.push({ type: 'multiDelayChange', changes, activeLayer }); capHistory(); redoStack.length = 0; }
      function pushSelectionChange(prevSelection, newSelection) {
        history.push({ type: 'selectionChange', prevSelection: [...prevSelection], newSelection: [...newSelection] });
        capHistory(); redoStack.length = 0;
      }


      let playing = false, playHandle = null;


      let sel = null; let clipboard = null; let selButtons = null;
      let lasso = null;
      let lassoPaintStroke = null;


      let selTransform = {
        mode: null,
        handle: null,
        startAngle: 0,
        startX: 0, startY: 0,
        startW: 0, startH: 0,
        startSelX: 0, startSelY: 0,
        rotation: 0,
        snapAngles: [0, 10, 25, 45, 90, 135, 180, 225, 270, 315],
        snapThreshold: 5
      };


      const shapeState = {
        kind: 'rect',
        fill: false,
        size: 2,
        dither: 0,
        dragging: false,
        pid: null,
        x0: 0, y0: 0, x1: 0, y1: 0,
        bbox: null,
        erase: false
      };


      let importPreview = null;
      let vfrEnabled = false;
      const FILMSTRIP_STYLE_KEY = 'fliplite_filmstripStyle';
      const FILMSTRIP_STYLE_THUMBS = 'thumbs';
      const FILMSTRIP_STYLE_COMPACT = 'compact';
      let filmstripStyle = (localStorage.getItem(FILMSTRIP_STYLE_KEY) === FILMSTRIP_STYLE_COMPACT)
        ? FILMSTRIP_STYLE_COMPACT
        : FILMSTRIP_STYLE_THUMBS;
      let pendingFilmstripStyle = filmstripStyle;
      const shapePrev = makeCanvas(); const shapePrevCtx = shapePrev.getContext('2d'); shapePrevCtx.imageSmoothingEnabled = false;


      let onionPrev = 2, onionNext = 2;
      let onionMaxOpacity = 0.28;
      let onionFalloff = 0.68;
      let onionColorMode = 'tint';
      function alphaForLayer(i) { return onionMaxOpacity * Math.pow(onionFalloff, (i - 1)); }
      function setOnionVisual() { onionBtn.classList.toggle('active', onionToggle.checked); render(); }
      onionBtn.addEventListener('click', () => { onionToggle.checked = !onionToggle.checked; setOnionVisual(); });


      function drawTinted(src, hex, alpha) {
        tintCtx.clearRect(0, 0, W, H);
        tintCtx.globalCompositeOperation = 'source-over'; tintCtx.drawImage(src, 0, 0);
        tintCtx.globalCompositeOperation = 'source-in'; tintCtx.fillStyle = hex; tintCtx.fillRect(0, 0, W, H);
        ctx.globalAlpha = alpha; ctx.drawImage(tintCan, 0, 0); ctx.globalAlpha = 1; tintCtx.globalCompositeOperation = 'source-over';
      }

      function drawOnionTintFrame(frame, tintHex, alpha) {
        onionScratchCtx.clearRect(0, 0, W, H);
        layerOrder.forEach(idx => {
          const layer = frame.layers[idx];
          if (!layer.visible || layer.opacity <= 0) return;
          onionScratchCtx.globalAlpha = layer.opacity;
          onionScratchCtx.drawImage(layer.can, 0, 0);
        });
        onionScratchCtx.globalAlpha = 1;
        drawTinted(onionScratchCan, tintHex, alpha);
      }

      function render() {
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, stage.width, stage.height);
        ctx.setTransform(view.scale, 0, 0, view.scale, view.tx, view.ty);


        const f = frames[current];
        ctx.drawImage(f.bg.can, 0, 0);

        ctx.save();

        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1 / view.scale;
        ctx.strokeRect(0, 0, W, H);



        if (onionToggle.checked && !playing) {
          if (onionColorMode === 'tint') {
            for (let i = 1; i <= onionPrev; i++) {
              const of = frames[current - i]; if (!of) break;
              drawOnionTintFrame(of, 'rgba(255,0,0,1)', alphaForLayer(i));
            }
            for (let i = 1; i <= onionNext; i++) {
              const of = frames[current + i]; if (!of) break;
              drawOnionTintFrame(of, 'rgba(0,200,0,1)', alphaForLayer(i));
            }
          } else {
            for (let i = 1; i <= onionPrev; i++) {
              const of = frames[current - i]; if (!of) break;
              layerOrder.forEach(idx => {
                if (of.layers[idx].visible) {
                  ctx.globalAlpha = alphaForLayer(i) * of.layers[idx].opacity;
                  ctx.drawImage(of.layers[idx].can, 0, 0);
                }
              });
            }
            ctx.globalAlpha = 1;
            for (let i = 1; i <= onionNext; i++) {
              const of = frames[current + i]; if (!of) break;
              layerOrder.forEach(idx => {
                if (of.layers[idx].visible) {
                  ctx.globalAlpha = alphaForLayer(i) * of.layers[idx].opacity;
                  ctx.drawImage(of.layers[idx].can, 0, 0);
                }
              });
            }
            ctx.globalAlpha = 1;
          }
        }


        layerOrder.forEach(layerIdx => {
          const layer = f.layers[layerIdx];
          if (layer.visible) {
            ctx.globalAlpha = layer.opacity;
            ctx.drawImage(layer.can, 0, 0);

            if (shapeState.dragging && activeLayer === layerIdx) {
              ctx.drawImage(shapePrev, 0, 0);
            }

            if (sel && sel.img && (sel.cutLayer === layerIdx || (sel.cutLayer === undefined && activeLayer === layerIdx))) {
              ctx.drawImage(sel.img, sel.x, sel.y);
            }
          }
        });
        ctx.globalAlpha = 1;


        if (sel) {
          ctx.save();


          const cx = (selTransform.mode === 'rotate' && selTransform.startCX !== undefined)
            ? selTransform.startCX
            : (sel.x + sel.w / 2);
          const cy = (selTransform.mode === 'rotate' && selTransform.startCY !== undefined)
            ? selTransform.startCY
            : (sel.y + sel.h / 2);
          const rotation = (selTransform.mode === 'rotate') ? selTransform.rotation * Math.PI / 180 : 0;


          if (rotation !== 0) {
            ctx.translate(cx, cy);
            ctx.rotate(rotation);
            ctx.translate(-cx, -cy);
          }



          const isCloseZoom = view.scale > 4;
          const dashLen = isCloseZoom ? Math.max(1, 2 / view.scale) : 6 / view.scale;
          const gapLen = isCloseZoom ? Math.max(0.5, 1.5 / view.scale) : 4 / view.scale;
          const outlineWidth = isCloseZoom ? Math.max(0.2, 0.5 / view.scale) : 1 / view.scale;
          ctx.lineWidth = outlineWidth;



          if (sel.poly && sel.poly.length) {


            let scaleX = 1, scaleY = 1;
            if (selTransform.mode === 'scale' && selTransform.startW && selTransform.startH) {
              scaleX = sel.w / selTransform.startW;
              scaleY = sel.h / selTransform.startH;
            }

            const baseX = (selTransform.mode === 'rotate') ? selTransform.startSelX : sel.x;
            const baseY = (selTransform.mode === 'rotate') ? selTransform.startSelY : sel.y;


            function drawPolyPath() {
              ctx.beginPath();
              const p0 = sel.poly[0];
              ctx.moveTo(baseX + p0.x * scaleX, baseY + p0.y * scaleY);
              for (let i = 1; i < sel.poly.length; i++) {
                const p = sel.poly[i];
                ctx.lineTo(baseX + p.x * scaleX, baseY + p.y * scaleY);
              }
              ctx.closePath();
            }


            ctx.setLineDash([dashLen, gapLen]);
            ctx.strokeStyle = '#3aa3ff';
            drawPolyPath();
            ctx.stroke();
          } else if (!sel.img) {

            ctx.setLineDash([dashLen, gapLen]);
            ctx.strokeStyle = '#3aa3ff';
            ctx.strokeRect(sel.x, sel.y, sel.w, sel.h);
          }

          ctx.restore();


          drawSelButtons();
        }


        if (lasso && lasso.points.length) {
          ctx.save();
          ctx.strokeStyle = 'rgba(58,163,255,1)';
          ctx.lineWidth = 1 / view.scale;
          ctx.setLineDash([8 / view.scale, 4 / view.scale]);
          ctx.beginPath();
          const p0 = lasso.points[0]; ctx.moveTo(p0.x + .5 / view.scale, p0.y + .5 / view.scale);
          for (let i = 1; i < lasso.points.length; i++) { const p = lasso.points[i]; ctx.lineTo(p.x + .5 / view.scale, p.y + .5 / view.scale); }
          ctx.stroke();
          ctx.restore();
        }

        if (lassoPaintStroke && lassoPaintStroke.points.length) {
          const pts = lassoPaintStroke.points;
          const p0 = pts[0];
          const [pr, pg, pb] = hexToRGBA(brush.color);
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(p0.x + .5 / view.scale, p0.y + .5 / view.scale);
          for (let i = 1; i < pts.length; i++) {
            const p = pts[i];
            ctx.lineTo(p.x + .5 / view.scale, p.y + .5 / view.scale);
          }
          ctx.closePath();
          ctx.fillStyle = lassoPaintStroke.erase ? 'rgba(255,48,48,0.24)' : `rgba(${pr},${pg},${pb},0.24)`;
          ctx.fill();
          ctx.strokeStyle = lassoPaintStroke.erase ? 'rgba(255,48,48,0.6)' : 'rgba(0,0,0,0.95)';
          ctx.lineWidth = 1 / view.scale;
          ctx.setLineDash([8 / view.scale, 4 / view.scale]);
          ctx.stroke();
          ctx.restore();
        }





        if (importPreview && importPreview.img) {
          ctx.save();
          ctx.imageSmoothingEnabled = false;


          if (importPreview.cropping && importPreview.cropRect) {
            const cr = importPreview.cropRect;

            ctx.globalAlpha = 0.3;
            ctx.drawImage(importPreview.img, importPreview.x, importPreview.y, importPreview.w, importPreview.h);
            ctx.globalAlpha = 1;

            const scaleX = importPreview.w / importPreview.origW;
            const scaleY = importPreview.h / importPreview.origH;
            const cropCanvasX = importPreview.x + cr.x * scaleX;
            const cropCanvasY = importPreview.y + cr.y * scaleY;
            const cropCanvasW = cr.w * scaleX;
            const cropCanvasH = cr.h * scaleY;

            ctx.drawImage(
              importPreview.img,
              cr.x, cr.y, cr.w, cr.h,
              cropCanvasX, cropCanvasY,
              cropCanvasW, cropCanvasH
            );

            ctx.setLineDash([]);
            ctx.strokeStyle = '#ff6b4a';
            ctx.lineWidth = 2.5 / view.scale;
            ctx.strokeRect(cropCanvasX, cropCanvasY, cropCanvasW, cropCanvasH);


            if (cr.w > 1 && cr.h > 1) {
              const cropHs = Math.min(12, Math.max(8, 10 / view.scale)) / view.scale;
              ctx.fillStyle = '#ff6b4a';
              ctx.strokeStyle = '#fff';
              ctx.lineWidth = 2 / view.scale;
              const cropCorners = [
                [cropCanvasX, cropCanvasY],
                [cropCanvasX + cropCanvasW, cropCanvasY],
                [cropCanvasX, cropCanvasY + cropCanvasH],
                [cropCanvasX + cropCanvasW, cropCanvasY + cropCanvasH]
              ];
              cropCorners.forEach(([ccx, ccy]) => {
                ctx.fillRect(ccx - cropHs / 2, ccy - cropHs / 2, cropHs, cropHs);
                ctx.strokeRect(ccx - cropHs / 2, ccy - cropHs / 2, cropHs, cropHs);
              });
            }


            if (cr.w > 1 && cr.h > 1) {
              const fontSize = Math.max(10, Math.min(14, 12 / view.scale));
              ctx.font = `bold ${fontSize}px system-ui, sans-serif`;
              const dimText = `${cr.w}×${cr.h}`;
              const textWidth = ctx.measureText(dimText).width;
              const badgePad = 4 / view.scale;
              const badgeX = cropCanvasX + cropCanvasW / 2 - textWidth / 2 - badgePad;
              const badgeY = cropCanvasY - fontSize - badgePad * 3;

              ctx.fillStyle = 'rgba(255, 107, 74, 0.9)';
              ctx.fillRect(badgeX, badgeY, textWidth + badgePad * 2, fontSize + badgePad * 2);
              ctx.fillStyle = '#fff';
              ctx.textAlign = 'left';
              ctx.textBaseline = 'top';
              ctx.fillText(dimText, badgeX + badgePad, badgeY + badgePad);
            }
          } else {
            ctx.drawImage(importPreview.img, importPreview.x, importPreview.y, importPreview.w, importPreview.h);
          }


          ctx.setLineDash([4 / view.scale, 3 / view.scale]);
          ctx.strokeStyle = 'rgba(76, 178, 255, 0.9)';
          ctx.lineWidth = 2 / view.scale;
          ctx.strokeRect(importPreview.x, importPreview.y, importPreview.w, importPreview.h);


          if (!importPreview.cropping) {
            const maxHandleSize = 14;
            const minHandleSize = 10;
            const visualSize = Math.min(maxHandleSize, Math.max(minHandleSize, 12 / view.scale));
            const hs = visualSize / view.scale;

            ctx.setLineDash([]);
            ctx.fillStyle = '#4cb2ff';
            ctx.strokeStyle = '#1a1b1e';
            ctx.lineWidth = 3 / view.scale;
            const corners = [
              [importPreview.x, importPreview.y],
              [importPreview.x + importPreview.w, importPreview.y],
              [importPreview.x, importPreview.y + importPreview.h],
              [importPreview.x + importPreview.w, importPreview.y + importPreview.h]
            ];
            corners.forEach(([cx, cy]) => {
              ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
              ctx.strokeRect(cx - hs / 2, cy - hs / 2, hs, hs);
            });
          }
          ctx.restore();
        }


        drawDitherFillPreview();

        ctx.restore();


        drawTextPreview(ctx);
        if (typeof drawMotionOverlay === 'function') drawMotionOverlay();


        const curT = currentTool();
        const pickerMode = (picking || pickerSampling);

        if (cursorPos.visible && (pickerMode || curT === 'brush' || curT === 'eraser' || curT === 'smudge' || curT === 'fill' || curT === 'ditherFill' || curT === 'shape' || curT === 'text' || curT === 'lassoPaint' || curT === 'fxTrail' || curT === 'fxOutline' || curT === 'fxOutlineFlood' || curT === 'fxGlow')) {
          ctx.save();
          ctx.setTransform(view.scale, 0, 0, view.scale, view.tx, view.ty);

          let rx = cursorPos.x, ry = cursorPos.y;


          if (stabilizer.mode !== 'none' && haveSmooth && drawing) {
            rx = smoothX; ry = smoothY;


            ctx.save();
            ctx.globalAlpha = 0.4;


            ctx.beginPath();
            ctx.moveTo(cursorPos.x, cursorPos.y);
            ctx.lineTo(rx, ry);
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 2.5 / view.scale;
            ctx.setLineDash([6 / view.scale, 6 / view.scale]);
            ctx.stroke();


            ctx.beginPath();
            ctx.moveTo(cursorPos.x, cursorPos.y);
            ctx.lineTo(rx, ry);
            ctx.strokeStyle = 'black';
            ctx.lineWidth = 2.5 / view.scale;
            ctx.setLineDash([6 / view.scale, 6 / view.scale]);
            ctx.lineDashOffset = 6 / view.scale;
            ctx.stroke();
            ctx.restore();


            ctx.save();
            ctx.beginPath();
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 2 / view.scale;
            const cs = 5 / view.scale;
            ctx.moveTo(cursorPos.x - cs, cursorPos.y); ctx.lineTo(cursorPos.x + cs, cursorPos.y);
            ctx.moveTo(cursorPos.x, cursorPos.y - cs); ctx.lineTo(cursorPos.x, cursorPos.y + cs);
            ctx.stroke();


            ctx.beginPath();
            ctx.strokeStyle = 'black';
            ctx.lineWidth = 1 / view.scale;
            ctx.moveTo(cursorPos.x - cs, cursorPos.y); ctx.lineTo(cursorPos.x + cs, cursorPos.y);
            ctx.moveTo(cursorPos.x, cursorPos.y - cs); ctx.lineTo(cursorPos.x, cursorPos.y + cs);
            ctx.stroke();
            ctx.restore();
          }

          const isEraser = (curT === 'eraser');
          const isSmudge = (curT === 'smudge');
          const isFX = (curT === 'fxTrail' || curT === 'fxOutline' || curT === 'fxOutlineFlood' || curT === 'fxGlow');
          const usesFXPlusCursor = (curT === 'fxOutlineFlood' || curT === 'fxGlow');
          const usesNeutralPlusCursor = (pickerMode || curT === 'fill' || curT === 'ditherFill' || curT === 'shape' || curT === 'text' || curT === 'lassoPaint');
          const usesPlusCursor = (usesFXPlusCursor || usesNeutralPlusCursor);
          const size = isEraser ? eraser.size : (isSmudge ? smudge.size : (isFX ? getFXCursorSize(curT) : brush.size));
          const dither = isEraser ? eraser.ditherLevel : ((isSmudge || isFX) ? 0 : brush.ditherLevel);
          const lim = ditherLimit(dither);

          function drawCursorShape(x, y, opacity = 0.8) {
            const r = size / 2, r2 = r * r;
            const cx = size / 2 - 0.5, cy = size / 2 - 0.5;
            const ox = Math.round(x - Math.floor(size / 2));
            const oy = Math.round(y - Math.floor(size / 2));

            const inC = (dx, dy) => {
              if (dx < 0 || dx >= size || dy < 0 || dy >= size) return false;
              const ddx = dx - cx, ddy = dy - cy;
              return ddx * ddx + ddy * ddy <= r2 + 0.1;
            };


            ctx.save();
            ctx.globalAlpha = opacity;
            for (let dy = 0; dy < size; dy++) {
              const py = oy + dy;
              for (let dx = 0; dx < size; dx++) {
                const px = ox + dx;
                if (inC(dx, dy)) {

                  const isDitheredOut = lim !== null && BAYER4[py & 3][px & 3] >= lim;

                  ctx.fillStyle = isDitheredOut ? 'rgba(255,255,255,0.1)' : (isEraser ? 'rgba(255,50,50,0.4)' : (isSmudge ? 'rgba(180,50,255,0.4)' : (isFX ? 'rgba(100,220,120,0.35)' : 'rgba(50,100,255,0.4)')));
                  ctx.fillRect(px, py, 1, 1);
                }
              }
            }
            ctx.restore();


            ctx.beginPath();
            ctx.strokeStyle = isEraser ? 'rgba(255,100,100,1)' : (isSmudge ? 'rgba(140,20,220,0.6)' : (isFX ? 'rgba(110,235,130,0.95)' : 'rgba(100,150,255,1)'));
            ctx.lineWidth = 1 / view.scale;
            if (isEraser) ctx.setLineDash([2 / view.scale, 2 / view.scale]);
            else ctx.setLineDash([]);

            for (let dy = 0; dy < size; dy++) {
              for (let dx = 0; dx < size; dx++) {
                if (inC(dx, dy)) {
                  const px = ox + dx, py = oy + dy;
                  if (!inC(dx, dy - 1)) { ctx.moveTo(px, py); ctx.lineTo(px + 1, py); }
                  if (!inC(dx, dy + 1)) { ctx.moveTo(px, py + 1); ctx.lineTo(px + 1, py + 1); }
                  if (!inC(dx - 1, dy)) { ctx.moveTo(px, py); ctx.lineTo(px, py + 1); }
                  if (!inC(dx + 1, dy)) { ctx.moveTo(px + 1, py); ctx.lineTo(px + 1, py + 1); }
                }
              }
            }
            ctx.stroke();


            ctx.beginPath();
            ctx.strokeStyle = 'white';
            ctx.setLineDash([2 / view.scale, 2 / view.scale]);
            ctx.lineDashOffset = 2 / view.scale;
            for (let dy = 0; dy < size; dy++) {
              for (let dx = 0; dx < size; dx++) {
                if (inC(dx, dy)) {
                  const px = ox + dx, py = oy + dy;
                  if (!inC(dx, dy - 1)) { ctx.moveTo(px, py); ctx.lineTo(px + 1, py); }
                  if (!inC(dx, dy + 1)) { ctx.moveTo(px, py + 1); ctx.lineTo(px + 1, py + 1); }
                  if (!inC(dx - 1, dy)) { ctx.moveTo(px, py); ctx.lineTo(px, py + 1); }
                  if (!inC(dx + 1, dy)) { ctx.moveTo(px + 1, py); ctx.lineTo(px + 1, py + 1); }
                }
              }
            }
            ctx.stroke();
          }

          function drawPlusCursor(x, y, opacity = 0.42, neutral = false) {
            const px = Math.round(x);
            const py = Math.round(y);
            const arm = neutral ? 3 : 4;
            ctx.save();
            ctx.globalAlpha = opacity;
            if (neutral) {
              const inPlus = (dx, dy) => ((dx === 0 && Math.abs(dy) <= arm) || (dy === 0 && Math.abs(dx) <= arm));
              // Keep the center cross 1px thick for precision.
              ctx.fillStyle = 'rgba(102,107,114,0.9)';
              for (let offset = -arm; offset <= arm; offset++) {
                ctx.fillRect(px + offset, py, 1, 1);
                ctx.fillRect(px, py + offset, 1, 1);
              }
              ctx.fillStyle = 'rgba(122,128,136,0.94)';
              ctx.fillRect(px, py, 1, 1);
              // Match the dashed contour language of other hover cursors, but keep it white-ish.
              ctx.beginPath();
              ctx.strokeStyle = 'rgba(236,242,248,0.96)';
              ctx.lineWidth = 1 / view.scale;
              ctx.setLineDash([2 / view.scale, 2 / view.scale]);
              for (let dy = -arm; dy <= arm; dy++) {
                for (let dx = -arm; dx <= arm; dx++) {
                  if (!inPlus(dx, dy)) continue;
                  const gx = px + dx;
                  const gy = py + dy;
                  if (!inPlus(dx, dy - 1)) { ctx.moveTo(gx, gy); ctx.lineTo(gx + 1, gy); }
                  if (!inPlus(dx, dy + 1)) { ctx.moveTo(gx, gy + 1); ctx.lineTo(gx + 1, gy + 1); }
                  if (!inPlus(dx - 1, dy)) { ctx.moveTo(gx, gy); ctx.lineTo(gx, gy + 1); }
                  if (!inPlus(dx + 1, dy)) { ctx.moveTo(gx + 1, gy); ctx.lineTo(gx + 1, gy + 1); }
                }
              }
              ctx.stroke();
            } else {
              ctx.fillStyle = 'rgba(100,220,120,0.8)';
              for (let offset = -arm; offset <= arm; offset++) {
                ctx.fillRect(px + offset, py, 1, 1);
                ctx.fillRect(px, py + offset, 1, 1);
              }
              ctx.fillStyle = 'rgba(145,255,170,0.92)';
              ctx.fillRect(px, py, 1, 1);
            }
            ctx.restore();
          }

          if (usesPlusCursor) drawPlusCursor(rx, ry, usesNeutralPlusCursor ? 0.32 : 0.42, usesNeutralPlusCursor);
          else drawCursorShape(rx, ry);
          if (mirror.h || mirror.v) {
            const mirrorStampSize = usesPlusCursor ? 1 : Math.max(1, size | 0);
            const mrx = mirrorXCoord(rx, mirrorStampSize);
            const mry = mirrorYCoord(ry, mirrorStampSize);
            if (mirror.h) usesPlusCursor ? drawPlusCursor(mrx, ry, usesNeutralPlusCursor ? 0.22 : 0.26, usesNeutralPlusCursor) : drawCursorShape(mrx, ry, 0.4);
            if (mirror.v) usesPlusCursor ? drawPlusCursor(rx, mry, usesNeutralPlusCursor ? 0.22 : 0.26, usesNeutralPlusCursor) : drawCursorShape(rx, mry, 0.4);
            if (mirror.h && mirror.v) usesPlusCursor ? drawPlusCursor(mrx, mry, usesNeutralPlusCursor ? 0.22 : 0.26, usesNeutralPlusCursor) : drawCursorShape(mrx, mry, 0.4);
          }

          ctx.restore();
        }


        if (mirror.h || mirror.v) {
          ctx.save();
          ctx.setTransform(view.scale, 0, 0, view.scale, view.tx, view.ty);
          ctx.lineWidth = 1.5 / view.scale;
          ctx.setLineDash([6 / view.scale, 4 / view.scale]);

          if (mirror.h) {
            ctx.strokeStyle = 'rgba(60, 180, 255, 0.85)';
            ctx.beginPath();
            ctx.moveTo(W / 2, 0);
            ctx.lineTo(W / 2, H);
            ctx.stroke();
          }

          if (mirror.v) {
            ctx.strokeStyle = 'rgba(255, 120, 60, 0.85)';
            ctx.beginPath();
            ctx.moveTo(0, H / 2);
            ctx.lineTo(W, H / 2);
            ctx.stroke();
          }

          ctx.restore();
        }

        ctx.setTransform(1, 0, 0, 1, 0, 0);
      }

      let renderRAF = 0;
      function requestRender() {
        if (renderRAF) return;
        renderRAF = requestAnimationFrame(() => {
          renderRAF = 0;
          render();
        });
      }

      function updateThumb(i) {
        const f = frames[i], t = f.thumb, tctx = f.thumbCtx || (f.thumbCtx = t.getContext('2d')); tctx.imageSmoothingEnabled = false;
        const tw = t.width, th = t.height;
        tctx.clearRect(0, 0, tw, th);


        const canvasAspect = W / H;
        const thumbAspect = tw / th;
        let w, h;

        if (canvasAspect > thumbAspect) {
          w = tw;
          h = Math.round(tw / canvasAspect);
        } else {
          h = th;
          w = Math.round(th * canvasAspect);
        }

        const x = ((tw - w) / 2) | 0, y = ((th - h) / 2) | 0;


        tctx.drawImage(f.bg.can, x, y, w, h);


        layerOrder.forEach(layerIdx => {
          const layer = f.layers[layerIdx];
          if (layer.visible) {
            tctx.globalAlpha = layer.opacity;
            tctx.drawImage(layer.can, x, y, w, h);
          }
        });
        tctx.globalAlpha = 1;
      }
      function updateAllThumbs() {
        for (let i = 0; i < frames.length; i++) updateThumb(i);
        refreshAllFilmTileThumbs();
      }


      let dragFrom = null, pendingInsertIndex = null;
      let selectedFrames = new Set();
      let lastClickedFrame = 0;
      let hoverScrubIndex = -1;
      let compactHoldScrubActive = false;
      let compactHoldScrubPointerId = -1;
      let suppressCompactScrubClickUntil = 0;
      const selectionOverlayEl = document.getElementById('selectionOverlay');
      function tilesOnly() { return framesWrap.querySelectorAll('.tile'); }

      function normalizeFilmstripStyle(style) {
        return style === FILMSTRIP_STYLE_COMPACT ? FILMSTRIP_STYLE_COMPACT : FILMSTRIP_STYLE_THUMBS;
      }

      function updateFilmstripClass() {
        framesWrap.classList.toggle('compact-view', filmstripStyle === FILMSTRIP_STYLE_COMPACT);
      }

      function updateFilmstripStyleButtons(style = pendingFilmstripStyle) {
        const normalized = normalizeFilmstripStyle(style);
        if (filmstripCompactToggle) filmstripCompactToggle.checked = normalized === FILMSTRIP_STYLE_COMPACT;
      }

      function applyFilmstripStyle(nextStyle, opts = {}) {
        const normalized = normalizeFilmstripStyle(nextStyle);
        const styleChanged = normalized !== filmstripStyle;
        filmstripStyle = normalized;
        pendingFilmstripStyle = normalized;
        updateFilmstripClass();
        updateFilmstripStyleButtons(normalized);
        if (opts.persist) {
          try { localStorage.setItem(FILMSTRIP_STYLE_KEY, normalized); } catch (e) { }
        }
        if (opts.rebuild !== false && styleChanged) {
          buildFilm();
        }
      }

      function setFilmTileThumb(tile, i) {
        const frame = frames[i];
        if (!tile || !frame) return;
        const c = tile.querySelector('canvas.thumb');
        if (!c) return;
        if (c.width !== frame.thumb.width) c.width = frame.thumb.width;
        if (c.height !== frame.thumb.height) c.height = frame.thumb.height;
        const cctx = c.getContext('2d');
        cctx.clearRect(0, 0, c.width, c.height);
        cctx.drawImage(frame.thumb, 0, 0);
      }

      function setFilmTileBadge(tile, i) {
        const frame = frames[i];
        if (!tile || !frame) return;
        const badgeContainer = tile.querySelector('.badge-container');
        const badge = tile.querySelector('.badge');
        const delBtn = tile.querySelector('.deleteFrameBtn');
        if (!badgeContainer || !badge || !delBtn) return;

        badge.className = 'badge';
        badgeContainer.className = 'badge-container';
        delBtn.className = 'deleteFrameBtn';
        delBtn.textContent = '×';
        delBtn.title = 'Delete frame';

        const compactFilmstrip = filmstripStyle === FILMSTRIP_STYLE_COMPACT;
        if (vfrEnabled && !compactFilmstrip) {
          const defaultDelay = Math.round(1000 / clampFPS(+fpsInp.value || 8));
          const delay = frame.delay || defaultDelay;
          badge.classList.add('badge-vfr');
          badgeContainer.classList.add('vfr-active');
          delBtn.classList.add('vfr-delete', 'vfr-style');
          badge.innerHTML = `<span style="font-weight:800;color:#bbb">${i + 1}</span><input type="number" class="vfr-delay-input" min="10" max="5000" value="${delay}" title="Frame delay (ms)"><span style="font-size:10px;font-weight:400;color:#888;margin-left:1px">ms</span>`;
        } else {
          badge.textContent = i + 1;
        }

        if (timelineHidden) {
          badge.classList.add('badge-hidden');
          badgeContainer.classList.add('timeline-hidden');
          delBtn.classList.add('timeline-hidden');
        }
      }

      function syncFilmTile(tile, i, refreshThumb = true, refreshBadge = false) {
        if (!tile) return;
        tile.dataset.index = i;
        tile.draggable = true;
        tile.classList.toggle('active', i === current);
        tile.classList.toggle('selected', selectedFrames.has(i));
        if (refreshThumb) setFilmTileThumb(tile, i);
        if (refreshBadge) setFilmTileBadge(tile, i);
      }

      function refreshFilmTile(i, refreshBadge = false) {
        const tile = framesWrap.querySelector(`.tile[data-index="${i}"]`);
        if (!tile) return;
        syncFilmTile(tile, i, true, refreshBadge);
      }

      function refreshAllFilmTileThumbs() {
        const tiles = tilesOnly();
        if (tiles.length !== frames.length) return;
        for (let i = 0; i < tiles.length; i++) {
          syncFilmTile(tiles[i], i, true, false);
        }
        updateSelectionOverlay();
      }

      function refreshAllFilmTileBadges() {
        const tiles = tilesOnly();
        if (tiles.length !== frames.length) {
          buildFilm();
          return;
        }
        for (let i = 0; i < tiles.length; i++) {
          syncFilmTile(tiles[i], i, false, true);
        }
        updatePlaybackInfo();
        updateSelectionOverlay();
      }



      function updateFilmActive() {
        const tiles = tilesOnly();
        tiles.forEach((tile) => {
          const idx = +tile.dataset.index;
          tile.classList.toggle('active', idx === current);
        });
        updateFrameIndicator();
      }

      function updatePlaybackInfo() {
        const fpsBox = document.getElementById('fpsInfoBox');
        const vfrBox = document.getElementById('vfrInfoBox');
        if (!fpsBox || !vfrBox || !fpsInp) return;

        fpsBox.innerHTML = `<div>${fpsInp.value || '8'}</div><div style="font-size:8px;color:#777;margin-top:1px;font-weight:900">FPS</div>`;
        if (vfrEnabled) {
          vfrBox.textContent = 'VFR';
          vfrBox.className = 'infoBox vfrBox active';
          vfrBox.title = 'Variable Frame Rate (Individual durations)';
        } else {
          vfrBox.textContent = 'CFR';
          vfrBox.className = 'infoBox vfrBox inactive';
          vfrBox.title = 'Constant Frame Rate';
        }
        updateFrameIndicator();
      }

      function updateFrameIndicator(partialMs = 0) {
        const curInd = document.getElementById('currentFrameInd');
        const totInd = document.getElementById('totalFramesInd');
        const delayInd = document.getElementById('frameDelayInd');
        const curTimeInd = document.getElementById('currentTimeInd');
        const totTimeInd = document.getElementById('totalTimeInd');
        if (!curInd || !totInd || !delayInd) return;

        curInd.textContent = current + 1;
        totInd.textContent = frames.length;

        const globalFps = clampFPS(+fpsInp.value || 8);
        const globalInterval = Math.max(1, Math.round(1000 / globalFps));

        let d;
        if (vfrEnabled) {
          d = frames[current].delay || globalInterval;
        } else {
          d = globalInterval;
        }

        delayInd.value = d;
        delayInd.disabled = (playing && !partialMs) || !vfrEnabled;


        if (selectedFrames.size > 1) {
          delayInd.style.color = '#38e891';
          delayInd.style.borderColor = '#38e891';
          delayInd.title = `Apply to ${selectedFrames.size} selected frames`;
        } else {
          delayInd.style.color = '';
          delayInd.style.borderColor = '#000';
          delayInd.title = 'Current frame delay (ms)';
        }

        if (curTimeInd && totTimeInd) {
          if (frames.length < 1) {
            curTimeInd.textContent = "0.00";
            totTimeInd.textContent = "0.00";
          } else {
            let totalMs = 0;
            let currentMs = 0;
            for (let i = 0; i < frames.length; i++) {
              const fd = (vfrEnabled && frames[i].delay) ? frames[i].delay : globalInterval;
              if (i < current) {
                currentMs += fd;
              } else if (i === current) {
                if (playing) {
                  currentMs += Math.min(fd, partialMs);
                } else {
                  currentMs += fd;
                }
              }
              totalMs += fd;
            }
            curTimeInd.textContent = (currentMs / 1000).toFixed(2);
            totTimeInd.textContent = (totalMs / 1000).toFixed(2);
          }
        }
      }

      function buildFilm() {
        updatePlaybackInfo();
        updateFilmstripClass();
        hoverScrubIndex = -1;
        framesWrap.textContent = "";
        framesWrap.appendChild(dropMarker);
        if (selectionOverlayEl) framesWrap.appendChild(selectionOverlayEl);

        const frag = document.createDocumentFragment();
        frames.forEach((f, i) => {
          const tile = document.createElement("div");
          tile.className = "tile";

          const tw = document.createElement("div");
          tw.className = "thumbWrap";

          const c = document.createElement("canvas");
          c.className = "thumb";
          c.width = f.thumb.width;
          c.height = f.thumb.height;

          const badge = document.createElement("div");
          badge.className = "badge";

          const delBtn = document.createElement("div");
          delBtn.className = "deleteFrameBtn";
          delBtn.textContent = "×";
          delBtn.title = "Delete frame";

          const badgeContainer = document.createElement("div");
          badgeContainer.className = "badge-container";
          badgeContainer.append(badge, delBtn);

          tw.append(c, badgeContainer);
          tile.appendChild(tw);
          syncFilmTile(tile, i, true, true);
          frag.appendChild(tile);
        });

        framesWrap.appendChild(frag);

        const addTile = document.createElement("div");
        addTile.className = "addTile";
        addTile.title = "Add frame at end";
        addTile.setAttribute("role", "button");
        addTile.tabIndex = 0;
        const addGlyph = document.createElement("span");
        addGlyph.textContent = "➕";
        const addLabel = document.createElement("div");
        addLabel.textContent = "Add";
        addTile.append(addGlyph, addLabel);
        framesWrap.appendChild(addTile);

        updateSelectionOverlay();
        queueMicrotask(updateFilmFades);
      }


      function updateSelectionOverlay() {
        const overlay = selectionOverlayEl;
        if (!overlay) return;

        if (selectedFrames.size < 2) {
          overlay.style.display = 'none';
          return;
        }

        const tiles = tilesOnly();
        if (tiles.length === 0) {
          overlay.style.display = 'none';
          return;
        }

        const indices = [...selectedFrames].sort((a, b) => a - b);
        const minIdx = indices[0];
        const maxIdx = indices[indices.length - 1];


        let minTile = null;
        let maxTile = null;
        tiles.forEach((tile) => {
          const idx = +tile.dataset.index;
          if (idx === minIdx) minTile = tile;
          if (idx === maxIdx) maxTile = tile;
        });

        if (!minTile || !maxTile) {
          overlay.style.display = 'none';
          return;
        }


        const left = minTile.offsetLeft;
        const right = maxTile.offsetLeft + maxTile.offsetWidth;
        const top = minTile.offsetTop;
        const height = minTile.offsetHeight;

        overlay.style.left = left + 'px';
        overlay.style.top = top + 'px';
        overlay.style.width = (right - left) + 'px';
        overlay.style.height = height + 'px';
        overlay.style.display = 'block';
      }


      const frameContextMenu = document.getElementById('frameContextMenu');

      function showFrameContextMenu(x, y) {

        const setDelayBtn = frameContextMenu.querySelector('[data-action="setDelay"]');
        if (setDelayBtn) {
          setDelayBtn.style.display = vfrEnabled ? '' : 'none';
        }

        const invertBtn = frameContextMenu.querySelector('[data-action="invertOrder"]');
        if (invertBtn) {
          invertBtn.disabled = selectedFrames.size < 2;
        }

        frameContextMenu.style.left = x + 'px';
        frameContextMenu.style.top = y + 'px';
        frameContextMenu.classList.add('visible');

        requestAnimationFrame(() => {
          const rect = frameContextMenu.getBoundingClientRect();
          if (rect.right > window.innerWidth) {
            frameContextMenu.style.left = (x - rect.width) + 'px';
          }
          if (rect.bottom > window.innerHeight) {
            frameContextMenu.style.top = (y - rect.height) + 'px';
          }
        });
      }

      function hideFrameContextMenu() {
        frameContextMenu.classList.remove('visible');
      }

      function handleFrameTileClick(idx, e) {
        const prevSelection = [...selectedFrames];

        if (e.shiftKey) {
          const start = Math.min(lastClickedFrame, idx);
          const end = Math.max(lastClickedFrame, idx);
          if (!e.ctrlKey && !e.metaKey) selectedFrames.clear();
          for (let j = start; j <= end; j++) selectedFrames.add(j);
        } else if (e.ctrlKey || e.metaKey) {
          if (selectedFrames.has(idx)) selectedFrames.delete(idx);
          else selectedFrames.add(idx);
        } else {
          selectedFrames.clear();
        }

        const newSelection = [...selectedFrames];
        const selectionChanged = prevSelection.length !== newSelection.length ||
          prevSelection.some(v => !selectedFrames.has(v));
        if (selectionChanged && (e.shiftKey || e.ctrlKey || e.metaKey)) {
          pushSelectionChange(prevSelection, newSelection);
        }

        lastClickedFrame = idx;
        setCurrent(idx);
      }

      framesWrap.addEventListener('click', (e) => {
        const addTile = e.target.closest('.addTile');
        if (addTile && framesWrap.contains(addTile)) {
          addFrame();
          return;
        }

        if (Date.now() < suppressCompactScrubClickUntil && e.target.closest('.tile')) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        const delayInput = e.target.closest('.vfr-delay-input');
        if (delayInput) {
          e.stopPropagation();
          return;
        }

        const delBtn = e.target.closest('.deleteFrameBtn');
        if (delBtn) {
          e.stopPropagation();
          const tile = delBtn.closest('.tile');
          if (!tile) return;
          deleteFrame(+tile.dataset.index);
          return;
        }

        const tile = e.target.closest('.tile');
        if (!tile || !framesWrap.contains(tile)) return;
        handleFrameTileClick(+tile.dataset.index, e);
      });

      framesWrap.addEventListener('mouseleave', () => {
        if (compactHoldScrubActive) return;
        hoverScrubIndex = -1;
      });

      function isCompactNumberZone(tile, clientX, clientY) {
        const badge = tile.querySelector('.badge');
        if (!badge) return false;
        const badgeRect = badge.getBoundingClientRect();
        const tileRect = tile.getBoundingClientRect();
        const padX = 4;
        const padTop = 4;
        const padBottom = 5;
        const compactBarTop = tileRect.top + 14;

        const left = badgeRect.left - padX;
        const right = badgeRect.right + padX;
        const top = badgeRect.top - padTop;
        const bottom = Math.min(badgeRect.bottom + padBottom, compactBarTop + 2);
        if (bottom <= top) return false;
        return clientX >= left && clientX <= right && clientY >= top && clientY <= bottom;
      }

      function isCompactBarZone(tile, clientX, clientY) {
        const thumbWrap = tile.querySelector('.thumbWrap');
        if (!thumbWrap) return false;
        const wrapRect = thumbWrap.getBoundingClientRect();
        const left = wrapRect.left + 2;
        const right = wrapRect.right - 2;
        const top = wrapRect.top + 14;
        const bottom = wrapRect.bottom - 4;
        if (right <= left || bottom <= top) return false;
        return clientX >= left && clientX <= right && clientY >= top && clientY <= bottom;
      }

      function getCompactTileIndexFromPoint(clientX, clientY) {
        const atPoint = document.elementFromPoint(clientX, clientY);
        const pointedTile = atPoint && atPoint.closest ? atPoint.closest('.tile') : null;
        if (pointedTile && framesWrap.contains(pointedTile)) {
          const idx = +pointedTile.dataset.index;
          if (Number.isFinite(idx) && idx >= 0 && idx < frames.length) return idx;
        }
        const tiles = tilesOnly();
        if (!tiles.length) return -1;

        let nearestIdx = -1;
        let nearestDist = Infinity;
        for (let i = 0; i < tiles.length; i++) {
          const t = tiles[i];
          const idx = +t.dataset.index;
          if (!Number.isFinite(idx) || idx < 0 || idx >= frames.length) continue;
          const rect = t.getBoundingClientRect();
          const centerX = (rect.left + rect.right) * 0.5;
          const dist = Math.abs(clientX - centerX);
          if (dist < nearestDist) {
            nearestDist = dist;
            nearestIdx = idx;
          }
        }
        return nearestIdx;
      }

      function endCompactHoldScrub(pointerId = null) {
        if (!compactHoldScrubActive) return;
        if (pointerId !== null && pointerId !== compactHoldScrubPointerId) return;
        if (framesWrap.hasPointerCapture?.(compactHoldScrubPointerId)) {
          framesWrap.releasePointerCapture(compactHoldScrubPointerId);
        }
        compactHoldScrubActive = false;
        compactHoldScrubPointerId = -1;
        hoverScrubIndex = -1;
        suppressCompactScrubClickUntil = Date.now() + 220;
      }

      framesWrap.addEventListener('pointerdown', (e) => {
        if (filmstripStyle !== FILMSTRIP_STYLE_COMPACT) return;
        if (playing || dragFrom !== null) return;
        if (e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        const tile = e.target.closest('.tile');
        if (!tile || !framesWrap.contains(tile)) return;
        if (!isCompactNumberZone(tile, e.clientX, e.clientY)) return;

        const idx = +tile.dataset.index;
        if (!Number.isFinite(idx) || idx < 0 || idx >= frames.length) return;

        compactHoldScrubActive = true;
        compactHoldScrubPointerId = e.pointerId;
        hoverScrubIndex = idx;
        if (idx !== current) setCurrent(idx);
        framesWrap.setPointerCapture?.(e.pointerId);
        e.preventDefault();
      });

      window.addEventListener('pointermove', (e) => {
        if (!compactHoldScrubActive) return;
        if (e.pointerId !== compactHoldScrubPointerId) return;
        if ((e.buttons & 1) === 0) {
          endCompactHoldScrub(e.pointerId);
          return;
        }
        const idx = getCompactTileIndexFromPoint(e.clientX, e.clientY);
        if (!Number.isFinite(idx) || idx < 0 || idx >= frames.length) return;
        if (idx === hoverScrubIndex || idx === current) {
          hoverScrubIndex = idx;
          return;
        }
        hoverScrubIndex = idx;
        setCurrent(idx);
        e.preventDefault();
      }, { passive: false });

      window.addEventListener('pointerup', (e) => {
        endCompactHoldScrub(e.pointerId);
      });

      window.addEventListener('pointercancel', (e) => {
        endCompactHoldScrub(e.pointerId);
      });

      framesWrap.addEventListener('mousemove', (e) => {
        if (filmstripStyle !== FILMSTRIP_STYLE_COMPACT) return;
        if (playing || dragFrom !== null || compactHoldScrubActive) return;
        if (e.buttons !== 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        const tile = e.target.closest('.tile');
        if (!tile || !framesWrap.contains(tile)) {
          hoverScrubIndex = -1;
          return;
        }
        if (!isCompactNumberZone(tile, e.clientX, e.clientY)) {
          hoverScrubIndex = -1;
          return;
        }
        hoverScrubIndex = +tile.dataset.index;
      });

      framesWrap.addEventListener('contextmenu', (e) => {
        const tile = e.target.closest('.tile');
        if (!tile || !framesWrap.contains(tile)) return;
        e.preventDefault();
        const idx = +tile.dataset.index;
        if (!selectedFrames.has(idx)) {
          selectedFrames.clear();
          selectedFrames.add(idx);
          updateFilmHighlight();
        }
        showFrameContextMenu(e.clientX, e.clientY);
      });

      framesWrap.addEventListener('dragstart', (ev) => {
        const tile = ev.target.closest('.tile');
        if (!tile || !framesWrap.contains(tile)) return;
        if (filmstripStyle === FILMSTRIP_STYLE_COMPACT) {
          if (compactHoldScrubActive || !isCompactBarZone(tile, ev.clientX, ev.clientY)) {
            ev.preventDefault();
            return;
          }
        }
        tile.classList.add('dragging');
        dragFrom = +tile.dataset.index;
        if (ev.dataTransfer) {
          ev.dataTransfer.effectAllowed = 'move';
          ev.dataTransfer.setData('text/plain', String(dragFrom));
          const r = tile.getBoundingClientRect();
          const ox = Math.max(0, Math.min(r.width - 1, ev.clientX - r.left));
          const oy = Math.max(0, Math.min(r.height - 1, ev.clientY - r.top));
          try { ev.dataTransfer.setDragImage(tile, ox, oy); } catch (err) { }
        }
      });

      framesWrap.addEventListener('dragend', (ev) => {
        const tile = ev.target.closest('.tile');
        if (tile) {
          tile.classList.remove('dragging');
        }
        hideMarker();
        pendingInsertIndex = null;
        dragFrom = null;
      });

      framesWrap.addEventListener('focusin', (e) => {
        const input = e.target.closest('.vfr-delay-input');
        if (!input) return;
        const tile = input.closest('.tile');
        if (!tile) return;
        const idx = +tile.dataset.index;
        input.dataset.oldDelay = String(frames[idx].delay || Math.round(1000 / clampFPS(+fpsInp.value || 8)));
        input.select();
      });

      framesWrap.addEventListener('keydown', (e) => {
        const input = e.target.closest('.vfr-delay-input');
        if (!input) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          input.blur();
        }
      });

      framesWrap.addEventListener('change', (e) => {
        const input = e.target.closest('.vfr-delay-input');
        if (!input) return;
        e.stopPropagation();
        const tile = input.closest('.tile');
        if (!tile) return;
        const idx = +tile.dataset.index;
        const oldDelayValue = Math.max(10, Math.min(5000, parseInt(input.dataset.oldDelay || '', 10) || (frames[idx].delay || 100)));
        const val = Math.max(10, Math.min(5000, parseInt(input.value, 10) || 100));
        if (val !== oldDelayValue) {
          pushDelayChange(idx, oldDelayValue, val);
        }
        frames[idx].delay = val;
        frames[idx].delayModified = true;
        input.value = String(val);
        updateFrameIndicator();
      });


      function performDuplicate() {
        const selSnap = sel ? snapshotSelectionObject(sel) : null;
        if (selSnap) sel = null;
        let indicesToDup = [...selectedFrames].sort((a, b) => a - b);
        if (indicesToDup.length === 0) indicesToDup = [current];

        const copies = indicesToDup.map(idx => newFrame(frames[idx]));
        const lastIdx = indicesToDup[indicesToDup.length - 1];
        const insertPos = lastIdx + 1;
        const insertions = [];

        copies.forEach((dup, i) => {
          const targetIdx = insertPos + i;
          frames.splice(targetIdx, 0, dup);
          insertions.push({ idx: targetIdx, snap: snapshotFrame(dup) });
          updateThumb(targetIdx);
        });

        if (insertions.length === 1) {
          pushFrameInsert(insertions[0].idx, insertions[0].snap, selSnap);
        } else {
          history.push({ type: 'multiFrameInsert', insertions: insertions.map(ins => ({ idx: ins.idx, snap: ins.snap })), selSnap: selSnap });
          capHistory(); redoStack.length = 0;
        }


        selectedFrames.clear();
        if (insertions.length > 1) {
          insertions.forEach(ins => selectedFrames.add(ins.idx));
        }

        buildFilm();
        setCurrent(insertPos);
        showToast(insertions.length + ' frame' + (insertions.length > 1 ? 's' : '') + ' duplicated');
      }


      function performMultiDelete(indices) {
        if (!indices || indices.length === 0) return false;
        const selSnap = sel ? snapshotSelectionObject(sel) : null;
        if (selSnap) sel = null;
        const sortedAsc = [...indices].sort((a, b) => a - b);


        if (sortedAsc.length >= frames.length) {
          showToast('Cannot delete all frames');
          return false;
        }


        const deletions = sortedAsc.map(idx => ({
          idx,
          snap: snapshotFrame(frames[idx])
        }));


        [...sortedAsc].reverse().forEach(idx => {
          frames.splice(idx, 1);
        });


        if (deletions.length === 1) {
          pushFrameDelete(deletions[0].idx, deletions[0].snap, selSnap);
        } else {
          pushMultiFrameDelete(deletions, selSnap);
        }


        current = Math.max(0, Math.min(current, frames.length - 1));
        selectedFrames.clear();
        buildFilm();
        setCurrent(current);
        render();
        showToast(deletions.length + ' frame(s) deleted');
        return true;
      }

      function performInvertOrder() {
        const selectedIndices = [...selectedFrames].sort((a, b) => a - b);
        if (selectedIndices.length < 2) return;

        const selSnap = sel ? snapshotSelectionObject(sel) : null;
        if (selSnap) sel = null;

        const oldFramesOrder = selectedIndices.map(idx => frames[idx]);
        const reversedFramesOrder = [...oldFramesOrder].reverse();

        const op = {
          type: 'multiFrameOrderChange',
          indices: selectedIndices,
          oldFrames: oldFramesOrder,
          newFrames: reversedFramesOrder,
          selSnap: selSnap
        };

        selectedIndices.forEach((idx, i) => {
          frames[idx] = reversedFramesOrder[i];
        });

        history.push(op);
        redoStack.length = 0;
        capHistory();

        buildFilm();
        showToast(selectedIndices.length + ' frame(s) order inverted');
      }


      document.addEventListener('click', (e) => {
        if (!frameContextMenu.contains(e.target)) {
          hideFrameContextMenu();
        }
      });


      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideFrameContextMenu();
      });


      frameContextMenu.addEventListener('click', (e) => {
        const action = e.target.dataset.action;
        if (!action) return;
        hideFrameContextMenu();

        const selectedIndices = [...selectedFrames].sort((a, b) => a - b);
        if (selectedIndices.length === 0) return;

        if (action === 'setDelay') {
          const currentDelay = frames[selectedIndices[0]]?.delay || Math.round(1000 / clampFPS(+fpsInp.value || 8));
          const input = prompt(`Set delay for ${selectedIndices.length} frame(s) (10-5000 ms):`, currentDelay);
          if (input !== null) {
            const val = Math.max(10, Math.min(5000, parseInt(input) || 100));

            const changes = selectedIndices.map(idx => ({
              frameIndex: idx,
              oldDelay: frames[idx]?.delay || Math.round(1000 / clampFPS(+fpsInp.value || 8)),
              newDelay: val
            })).filter(c => c.oldDelay !== c.newDelay);

            if (changes.length > 0) {
              pushMultiDelayChange(changes);
            }

            selectedIndices.forEach(idx => {
              if (frames[idx]) {
                frames[idx].delay = val;
                frames[idx].delayModified = true;
              }
            });
            refreshAllFilmTileBadges();
          }
        } else if (action === 'duplicate') {
          performDuplicate();
          return;
        } else if (action === 'invertOrder') {
          performInvertOrder();
          return;
        } else if (action === 'delete') {
          const confirmDelete = selectedIndices.length > 1 ? confirm(`Delete ${selectedIndices.length} frames?`) : true;
          if (confirmDelete) {
            performMultiDelete(selectedIndices);
          }
        }
      });

      framesWrap.addEventListener('dragover', (e) => {
        if (dragFrom === null) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';

        const tiles = Array.from(tilesOnly());
        if (!tiles.length) {
          pendingInsertIndex = 0;
          dropMarker.style.left = '0px';
          dropMarker.style.display = 'block';
          return;
        }

        const addTile = framesWrap.querySelector('.addTile');
        const boundaries = new Array(tiles.length + 1);
        boundaries[0] = tiles[0].offsetLeft;
        for (let i = 1; i < tiles.length; i++) {
          const prev = tiles[i - 1];
          const next = tiles[i];
          boundaries[i] = ((prev.offsetLeft + prev.offsetWidth) + next.offsetLeft) / 2;
        }
        const last = tiles[tiles.length - 1];
        const lastRight = last.offsetLeft + last.offsetWidth;
        boundaries[tiles.length] = addTile ? ((lastRight + addTile.offsetLeft) / 2) : lastRight;

        const wrapRect = framesWrap.getBoundingClientRect();
        const visibleX = e.clientX - wrapRect.left;
        const scaleX = (wrapRect.width > 0) ? (framesWrap.clientWidth / wrapRect.width) : 1;
        const x = (visibleX * scaleX) + framesWrap.scrollLeft;

        const solveIndexFromX = (px) => {
          let i = 0;
          while (i < boundaries.length - 1) {
            const split = (boundaries[i] + boundaries[i + 1]) / 2;
            if (px < split) break;
            i++;
          }
          return i;
        };

        let idx = solveIndexFromX(x);
        const hysteresisPx = 4;
        if (pendingInsertIndex !== null && pendingInsertIndex >= 0 && pendingInsertIndex < boundaries.length) {
          const p = pendingInsertIndex;
          const leftSplit = (p > 0) ? ((boundaries[p - 1] + boundaries[p]) / 2) : -Infinity;
          const rightSplit = (p < boundaries.length - 1) ? ((boundaries[p] + boundaries[p + 1]) / 2) : Infinity;
          if (x >= (leftSplit - hysteresisPx) && x <= (rightSplit + hysteresisPx)) {
            idx = p;
          }
        }

        pendingInsertIndex = idx;
        dropMarker.style.left = Math.round(boundaries[idx]) + 'px';
        dropMarker.style.display = 'block';
      });
      framesWrap.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragFrom === null || pendingInsertIndex === null) { hideMarker(); return; }
        if (sel) commitSelectionIfAny();


        if (selectedFrames.size > 1 && selectedFrames.has(dragFrom)) {

          const indices = [...selectedFrames].sort((a, b) => a - b);
          const prevSelection = [...selectedFrames];
          let insertAt = pendingInsertIndex;


          const movedFrames = indices.map(i => frames[i]);


          [...indices].reverse().forEach(i => frames.splice(i, 1));


          const removedBefore = indices.filter(i => i < pendingInsertIndex).length;
          insertAt = Math.max(0, insertAt - removedBefore);


          frames.splice(insertAt, 0, ...movedFrames);


          selectedFrames.clear();
          const newSelection = movedFrames.map((_, i) => insertAt + i);
          newSelection.forEach(i => selectedFrames.add(i));


          pushMultiFrameMove(indices, insertAt, prevSelection, newSelection);

          current = insertAt;
          buildFilm();
        } else {

          let insert = pendingInsertIndex;
          if (insert > dragFrom) insert--;
          moveFrame(dragFrom, insert);
        }

        hideMarker(); pendingInsertIndex = null; dragFrom = null;
      });
      function hideMarker() { dropMarker.style.display = 'none'; }

      function updateFilmFades() {
        const el = framesWrap; const atStart = el.scrollLeft <= 2, atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
        const overflow = el.scrollWidth > el.clientWidth + 2; const l = overflow && !atStart ? 28 : 0, r = overflow && !atEnd ? 28 : 0;
        const g = `linear-gradient(to right, transparent 0, #000 ${l}px, #000 calc(100% - ${r}px), transparent 100%)`;
        el.style.webkitMaskImage = g; el.style.maskImage = g;
      }
      framesWrap.addEventListener('scroll', updateFilmFades);
      new ResizeObserver(updateFilmFades).observe(framesWrap);
      framesWrap.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) { framesWrap.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });

      function commitSelectionIfAny() {
        if (!sel) return;



        if (sel._moveStart) {
          const s = sel._moveStart;
          if (sel.x !== s.x || sel.y !== s.y) {
            if (!sel._id) sel._id = (++__selIdSeq);
            history.push({
              type: 'selMove',
              selId: sel._id,
              fromX: s.x,
              fromY: s.y,
              toX: sel.x,
              toY: sel.y,
              fi: current,
              layer: activeLayer
            });
            capHistory();
            redoStack.length = 0;
          }
          sel._moveStart = null;
        }

        commitSelection();
        sel = null;
      }

      function setCurrent(i) {
        if (i === current) return;
        if (sel) commitSelectionIfAny();

        if (typeof cancelTextMode === 'function' && textState && textState.active) {
          cancelTextMode();
        }
        current = Math.max(0, Math.min(frames.length - 1, i));
        lastClickedFrame = current;
        updateFilmHighlight(); render();
      }

      function updateFilmHighlight() {
        const tiles = framesWrap.querySelectorAll('.tile');
        tiles.forEach((t) => {
          const idx = +t.dataset.index;
          t.classList.toggle('active', idx === current);
          t.classList.toggle('selected', selectedFrames.has(idx));
        });
        updatePlaybackInfo();
        updateSelectionOverlay();
      }


      function snapshotFrame(f) {
        return {
          layers: f.layers.map(l => ({
            data: l.ctx.getImageData(0, 0, W, H),
            visible: l.visible,
            opacity: l.opacity
          })),
          delay: f.delay,
          delayModified: f.delayModified
        };
      }
      function restoreFrameFromSnapshot(snap) {
        const f = newFrame();
        if (snap && snap.layers) {
          snap.layers.forEach((lData, i) => {
            if (f.layers[i]) {

              f.layers[i].ctx.putImageData(lData.data || lData, 0, 0);





            }
          });
          f.delay = snap.delay;
          f.delayModified = snap.delayModified;
        } else if (snap && snap.img) {
          f.layers[0].ctx.putImageData(snap.img, 0, 0);
          f.delay = snap.delay;
        } else if (snap instanceof ImageData) {
          f.layers[0].ctx.putImageData(snap, 0, 0);
        }
        return f;
      }
      function addFrame(at) {
        if (sel) commitSelectionIfAny();
        const prevCurrent = current;
        const prevSelection = [...selectedFrames];
        const idx = (at == null) ? frames.length : at;
        const nf = newFrame();
        frames.splice(idx, 0, nf);
        pushFrameInsert(idx, snapshotFrame(nf), null, {
          prevCurrent,
          nextCurrent: idx,
          prevSelection,
          nextSelection: []
        });
        selectedFrames.clear();
        updateThumb(idx);
        buildFilm();
        setCurrent(idx);
        showToast('Frame added');
      }
      function duplicateFrame(i) {
        if (sel) commitSelectionIfAny();
        const dup = newFrame(frames[i]);
        frames.splice(i + 1, 0, dup);
        pushFrameInsert(i + 1, snapshotFrame(dup), null);
        updateThumb(i);
        updateThumb(i + 1);
        buildFilm();
        setCurrent(i + 1);
        showToast('Frame duplicated');
      }
      function deleteFrame(i) {
        if (frames.length === 1) {
          if (sel) commitSelectionIfAny();
          const beforeSnap = snapshotFrame(frames[0]);
          const clearedFrame = newFrame();
          const afterSnap = snapshotFrame(clearedFrame);
          frames[0] = clearedFrame;
          current = 0;
          selectedFrames.clear();
          history.push({ type: 'frameReplace', index: 0, before: beforeSnap, after: afterSnap, activeLayer });
          capHistory();
          redoStack.length = 0;
          updateThumb(0);
          buildFilm();
          render();
          showToast('Cleared');
          return;
        }
        if (sel) commitSelectionIfAny();
        const removed = frames.splice(i, 1)[0];
        pushFrameDelete(i, snapshotFrame(removed), null);
        current = Math.max(0, Math.min(frames.length - 1, i === frames.length ? i - 1 : i));
        buildFilm(); setCurrent(current); render(); showToast('Frame deleted');
      }
      function moveFrame(from, to) {
        if (from === to) return;
        if (sel) commitSelectionIfAny();
        const f = frames.splice(from, 1)[0];
        frames.splice(to, 0, f);
        pushFrameMove(from, to);
        buildFilm();
        setCurrent(to);
      }


      function toCanvasXYInto(evt, out) {
        if (stageRectW <= 0 || stageRectH <= 0) refreshStagePointerMetrics(true);
        const sx = (evt.clientX - stageRectLeft) * stageScaleX;
        const sy = (evt.clientY - stageRectTop) * stageScaleY;
        out.x = Math.round((sx - view.tx) / view.scale);
        out.y = Math.round((sy - view.ty) / view.scale);
        return out;
      }

      function toCanvasXY(evt) {
        return toCanvasXYInto(evt, { x: 0, y: 0 });
      }

      let drawing = false, panning = false, panSX = 0, panSY = 0, panTX = 0, panTY = 0;
      let lastX = 0, lastY = 0, strokeMinX = Infinity, strokeMinY = Infinity, strokeMaxX = -Infinity, strokeMaxY = -Infinity;
      let holdStrokePressure = 1;
      let smoothX = 0, smoothY = 0, haveSmooth = false;
      let brushLineAnchor = null;
      let eraserLineAnchor = null;
      const pointerScratch = { x: 0, y: 0 };

      function markStrokeBoundsBox(x0, y0, x1, y1) {
        if (x0 < strokeMinX) strokeMinX = x0;
        if (y0 < strokeMinY) strokeMinY = y0;
        if (x1 > strokeMaxX) strokeMaxX = x1;
        if (y1 > strokeMaxY) strokeMaxY = y1;
      }

      function clearFXStrokeSession() {
        fxStroke.mode = null;
        fxStroke.lastStampX = null;
        fxStroke.lastStampY = null;
        fxStroke.sourceAlpha = null;
        fxStroke.outlineOuterOffsets = null;
        fxStroke.outlineGapOffsets = null;
      }

      const outlineRadiusOffsetsCache = new Map();

      function getOutlineRadiusOffsets(radius) {
        const r = Math.max(0, radius | 0);
        if (r <= 0) return [];
        const cached = outlineRadiusOffsetsCache.get(r);
        if (cached) return cached;
        const offsets = [];
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (dx === 0 && dy === 0) continue;
            const dist = Math.max(Math.abs(dx), Math.abs(dy));
            if (dist > r) continue;
            offsets.push([dx, dy]);
          }
        }
        outlineRadiusOffsetsCache.set(r, offsets);
        return offsets;
      }

      function shouldPaintFXOutlinePixel(px, py) {
        return true;
      }

      function getFXCursorSize(toolId) {
        if (toolId === 'fxTrail') return Math.max(1, fx.trail.size | 0);
        if (toolId === 'fxGlow') {
          const radius = Math.max(1, (fx.glow.radius | 0) + (fx.glow.gap | 0));
          return Math.max(1, (radius * 2 + 1) | 0);
        }
        if (toolId === 'fxOutline' || toolId === 'fxOutlineFlood') {
          const radius = Math.max(1, (fx.outline.thickness | 0) + (fx.outline.gap | 0));
          return Math.max(1, (radius * 2 + 1) | 0);
        }
        return 1;
      }

      function startFXStrokeSession(toolId) {
        clearFXStrokeSession();
        fxStroke.mode = toolId;
        if (toolId !== 'fxOutline') return;

        const source = preStrokeCtx.getImageData(0, 0, W, H).data;
        const len = W * H;
        const alpha = new Uint8Array(len);
        for (let i = 0; i < len; i++) alpha[i] = source[i * 4 + 3];

        fxStroke.sourceAlpha = alpha;
        const gapRadius = Math.max(0, fx.outline.gap | 0);
        const outerRadius = Math.max(1, gapRadius + Math.max(1, fx.outline.thickness | 0));
        fxStroke.outlineOuterOffsets = getOutlineRadiusOffsets(outerRadius);
        fxStroke.outlineGapOffsets = gapRadius > 0 ? getOutlineRadiusOffsets(gapRadius) : null;
      }

      function applyFXOutlineStrokeAt(x, y) {
        if (!fxStroke.sourceAlpha) return false;
        const ix = Math.round(x), iy = Math.round(y);
        if (ix < 0 || ix >= W || iy < 0 || iy >= H) return false;

        const alpha = fxStroke.sourceAlpha;
        const brushSize = Math.max(1, getFXCursorSize('fxOutline') | 0);
        const r = brushSize / 2;
        const r2 = r * r;
        const cx = brushSize / 2 - 0.5;
        const cy = brushSize / 2 - 0.5;
        const ox = Math.round(ix - Math.floor(brushSize / 2));
        const oy = Math.round(iy - Math.floor(brushSize / 2));
        const brushMask = new Set();
        const sourcePixels = [];

        for (let dy = 0; dy < brushSize; dy++) {
          const py = oy + dy;
          if (py < 0 || py >= H) continue;
          for (let dx = 0; dx < brushSize; dx++) {
            const px = ox + dx;
            if (px < 0 || px >= W) continue;
            const ddx = dx - cx;
            const ddy = dy - cy;
            if (ddx * ddx + ddy * ddy > r2 + 0.1) continue;
            const idx = py * W + px;
            brushMask.add(idx);
            if (alpha[idx] > 0) sourcePixels.push(idx);
          }
        }
        if (!sourcePixels.length) return false;

        const gapRadius = Math.max(0, fx.outline.gap | 0);
        const outerRadius = Math.max(1, gapRadius + Math.max(1, fx.outline.thickness | 0));
        const outerOffsets = fxStroke.outlineOuterOffsets || getOutlineRadiusOffsets(outerRadius);
        const gapOffsets = (gapRadius > 0)
          ? (fxStroke.outlineGapOffsets || getOutlineRadiusOffsets(gapRadius))
          : null;
        const outerCandidates = new Set();
        const gapCandidates = gapOffsets ? new Set() : null;
        const toPaint = new Set();
        let minX = W, minY = H, maxX = -1, maxY = -1;

        for (let i = 0; i < sourcePixels.length; i++) {
          const idx = sourcePixels[i];
          const px = idx % W;
          const py = (idx / W) | 0;

          for (let j = 0; j < outerOffsets.length; j++) {
            const off = outerOffsets[j];
            const nx = px + off[0];
            const ny = py + off[1];
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const nidx = ny * W + nx;
            if (!brushMask.has(nidx)) continue;
            if (alpha[nidx] !== 0) continue;
            outerCandidates.add(nidx);
          }

          if (!gapCandidates) continue;
          for (let j = 0; j < gapOffsets.length; j++) {
            const off = gapOffsets[j];
            const nx = px + off[0];
            const ny = py + off[1];
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const nidx = ny * W + nx;
            if (!brushMask.has(nidx)) continue;
            if (alpha[nidx] !== 0) continue;
            gapCandidates.add(nidx);
          }
        }

        outerCandidates.forEach((nidx) => {
          if (gapCandidates && gapCandidates.has(nidx)) return;
          const nx = nidx % W;
          const ny = (nidx / W) | 0;
          if (!shouldPaintFXOutlinePixel(nx, ny)) return;
          if (toPaint.has(nidx)) return;
          toPaint.add(nidx);
          if (nx < minX) minX = nx;
          if (ny < minY) minY = ny;
          if (nx > maxX) maxX = nx;
          if (ny > maxY) maxY = ny;
        });

        if (!toPaint.size) return false;

        const c2d = frames[current].layers[activeLayer].ctx;
        c2d.fillStyle = brush.color;
        toPaint.forEach(idx => {
          c2d.fillRect(idx % W, (idx / W) | 0, 1, 1);
        });
        markStrokeBoundsBox(minX, minY, maxX, maxY);
        return true;
      }

      function applyFXSelectiveGlow(ix, iy) {
        const x = Math.round(ix), y = Math.round(iy);
        if (x < 0 || x >= W || y < 0 || y >= H) return;

        const fctx = frames[current].layers[activeLayer].ctx;
        const id = fctx.getImageData(0, 0, W, H);
        const data = id.data;
        const seedIdx = (y * W + x) * 4;
        if (data[seedIdx + 3] === 0) return;

        const seen = new Uint8Array(W * H);
        const componentMask = new Uint8Array(W * H);
        const stack = [y * W + x];
        const component = [];

        while (stack.length) {
          const idx = stack.pop();
          if (seen[idx]) continue;
          seen[idx] = 1;
          if (data[idx * 4 + 3] === 0) continue;
          componentMask[idx] = 1;
          component.push(idx);

          const px = idx % W;
          const py = (idx / W) | 0;
          if (px > 0) stack.push(idx - 1);
          if (px < W - 1) stack.push(idx + 1);
          if (py > 0) stack.push(idx - W);
          if (py < H - 1) stack.push(idx + W);
        }

        if (!component.length) return;

        const gapRadius = Math.max(0, fx.glow.gap | 0);
        const glowRadius = Math.max(1, fx.glow.radius | 0);
        const outerRadius = Math.max(1, gapRadius + glowRadius);
        const outerOffsets = getOutlineRadiusOffsets(outerRadius);
        const boundary = [];
        for (let i = 0; i < component.length; i++) {
          const idx = component[i];
          const px = idx % W;
          const py = (idx / W) | 0;
          if (
            px === 0 || px === W - 1 || py === 0 || py === H - 1 ||
            !componentMask[idx - 1] ||
            !componentMask[idx + 1] ||
            !componentMask[idx - W] ||
            !componentMask[idx + W]
          ) {
            boundary.push(idx);
          }
        }
        if (!boundary.length) return;

        const ringDistance = new Int16Array(W * H);
        ringDistance.fill(32767);
        const touchCount = new Uint8Array(W * H);
        const toPaint = [];
        let minX = W, minY = H, maxX = -1, maxY = -1;

        for (let i = 0; i < boundary.length; i++) {
          const idx = boundary[i];
          const px = idx % W;
          const py = (idx / W) | 0;
          for (let j = 0; j < outerOffsets.length; j++) {
            const off = outerOffsets[j];
            const nx = px + off[0];
            const ny = py + off[1];
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const nidx = ny * W + nx;
            if (componentMask[nidx]) continue;
            if (data[nidx * 4 + 3] !== 0) continue;
            const dist = Math.max(Math.abs(off[0]), Math.abs(off[1]));
            if (dist <= gapRadius || dist > outerRadius) continue;
            const ring = dist - gapRadius;
            if (ring < 1 || ring > glowRadius) continue;
            if (ring < ringDistance[nidx]) ringDistance[nidx] = ring;
            if (touchCount[nidx] < 255) touchCount[nidx]++;
          }
        }

        const [nr, ng, nb] = hexToRGBA(brush.color);
        const baseLimit = ditherLimit(Math.max(1, Math.min(10, fx.glow.dither | 0))) || 8;
        for (let nidx = 0; nidx < ringDistance.length; nidx++) {
          const ring = ringDistance[nidx];
          if (ring === 32767) continue;
          const nx = nidx % W;
          const ny = (nidx / W) | 0;
          const edgeBoost = Math.min(4, touchCount[nidx] | 0);
          const localLimit = Math.max(1, Math.min(15, baseLimit + (glowRadius - ring) + edgeBoost - 2));
          if (BAYER4[ny & 3][nx & 3] >= localLimit) continue;
          toPaint.push(nidx);
          if (nx < minX) minX = nx;
          if (ny < minY) minY = ny;
          if (nx > maxX) maxX = nx;
          if (ny > maxY) maxY = ny;
        }

        if (!toPaint.length || maxX < minX || maxY < minY) return;
        const x0 = Math.max(0, minX);
        const y0 = Math.max(0, minY);
        const w = maxX - x0 + 1;
        const h = maxY - y0 + 1;
        const before = fctx.getImageData(x0, y0, w, h);

        for (let i = 0; i < toPaint.length; i++) {
          const nidx = toPaint[i];
          const di = nidx * 4;
          data[di] = nr;
          data[di + 1] = ng;
          data[di + 2] = nb;
          data[di + 3] = 255;
        }

        fctx.putImageData(id, 0, 0);
        const after = fctx.getImageData(x0, y0, w, h);
        pushPaintPatch(current, x0, y0, w, h, before, after, activeLayer);
        updateThumb(current);
        refreshFilmTile(current);
        render();
      }

      function applyFXFloodOutline(ix, iy) {
        const x = Math.round(ix), y = Math.round(iy);
        if (x < 0 || x >= W || y < 0 || y >= H) return;

        const fctx = frames[current].layers[activeLayer].ctx;
        const id = fctx.getImageData(0, 0, W, H);
        const data = id.data;
        const seedIdx = (y * W + x) * 4;
        if (data[seedIdx + 3] === 0) return;

        const seen = new Uint8Array(W * H);
        const componentMask = new Uint8Array(W * H);
        const stack = [y * W + x];
        const component = [];

        while (stack.length) {
          const idx = stack.pop();
          if (seen[idx]) continue;
          seen[idx] = 1;
          if (data[idx * 4 + 3] === 0) continue;
          componentMask[idx] = 1;
          component.push(idx);

          const px = idx % W;
          const py = (idx / W) | 0;
          if (px > 0) stack.push(idx - 1);
          if (px < W - 1) stack.push(idx + 1);
          if (py > 0) stack.push(idx - W);
          if (py < H - 1) stack.push(idx + W);
        }

        if (!component.length) return;

        const gapRadius = Math.max(0, fx.outline.gap | 0);
        const outerRadius = Math.max(1, gapRadius + Math.max(1, fx.outline.thickness | 0));
        const outerOffsets = getOutlineRadiusOffsets(outerRadius);
        const gapOffsets = gapRadius > 0 ? getOutlineRadiusOffsets(gapRadius) : null;
        const outerCandidates = new Set();
        const gapCandidates = gapOffsets ? new Set() : null;
        const outlineMask = new Uint8Array(W * H);
        const [nr, ng, nb] = hexToRGBA(brush.color);
        let minX = W, minY = H, maxX = -1, maxY = -1;

        for (let i = 0; i < component.length; i++) {
          const idx = component[i];
          const px = idx % W;
          const py = (idx / W) | 0;

          for (let j = 0; j < outerOffsets.length; j++) {
            const off = outerOffsets[j];
            const nx = px + off[0];
            const ny = py + off[1];
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const nidx = ny * W + nx;
            if (componentMask[nidx]) continue;
            if (data[nidx * 4 + 3] !== 0) continue;
            outerCandidates.add(nidx);
          }

          if (!gapCandidates) continue;
          for (let j = 0; j < gapOffsets.length; j++) {
            const off = gapOffsets[j];
            const nx = px + off[0];
            const ny = py + off[1];
            if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
            const nidx = ny * W + nx;
            if (componentMask[nidx]) continue;
            if (data[nidx * 4 + 3] !== 0) continue;
            gapCandidates.add(nidx);
          }
        }

        outerCandidates.forEach((nidx) => {
          if (gapCandidates && gapCandidates.has(nidx)) return;
          const nx = nidx % W;
          const ny = (nidx / W) | 0;
          if (!shouldPaintFXOutlinePixel(nx, ny)) return;
          outlineMask[nidx] = 1;
        });

        for (let idx = 0; idx < outlineMask.length; idx++) {
          if (!outlineMask[idx]) continue;
          const px = idx % W;
          const py = (idx / W) | 0;
          if (px < minX) minX = px;
          if (py < minY) minY = py;
          if (px > maxX) maxX = px;
          if (py > maxY) maxY = py;
        }

        if (maxX < minX || maxY < minY) return;

        const x0 = Math.max(0, minX);
        const y0 = Math.max(0, minY);
        const w = maxX - x0 + 1;
        const h = maxY - y0 + 1;
        const before = fctx.getImageData(x0, y0, w, h);

        for (let idx = 0; idx < outlineMask.length; idx++) {
          if (!outlineMask[idx]) continue;
          const di = idx * 4;
          data[di] = nr;
          data[di + 1] = ng;
          data[di + 2] = nb;
          data[di + 3] = 255;
        }

        fctx.putImageData(id, 0, 0);
        const after = fctx.getImageData(x0, y0, w, h);
        pushPaintPatch(current, x0, y0, w, h, before, after, activeLayer);
        updateThumb(current);
        refreshFilmTile(current);
        render();
      }

      const touchState = { map: new Map(), mode: null, startMid: null, startScale: 0 };
      function isTouchEvent(e) { return e.pointerType === 'touch'; }
      function updateTouch(id, e) {
        if (stageRectW <= 0 || stageRectH <= 0) refreshStagePointerMetrics(true);
        const sx = (e.clientX - stageRectLeft) * stageScaleX;
        const sy = (e.clientY - stageRectTop) * stageScaleY;
        const prev = touchState.map.get(id);
        if (prev) {
          prev.sx = sx;
          prev.sy = sy;
        } else {
          touchState.map.set(id, { sx, sy });
        }
      }
      function currentMidAndDist() {
        const vals = [...touchState.map.values()];
        if (vals.length < 2) return null;
        const a = vals[0], b = vals[1];
        const mid = { sx: (a.sx + b.sx) / 2, sy: (a.sy + b.sy) / 2 };
        const dx = b.sx - a.sx, dy = b.sy - a.sy;
        const dist = Math.hypot(dx, dy);
        return { mid, dist };
      }
      function worldFromScreen(sx, sy) { return { wx: (sx - view.tx) / view.scale, wy: (sy - view.ty) / view.scale }; }


      function pointInPoly(poly, x, y) {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
          const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi) / (yj - yi) + xi));
          if (intersect) inside = !inside;
        }
        return inside;
      }
      function buildAliasedMaskCanvas(polyRel, w, h) {
        const m = makeCanvas(w, h);
        const mctx = m.getContext('2d', { willReadFrequently: true });
        const id = mctx.createImageData(w, h);
        const d = id.data;
        for (let y = 0; y < h; y++) {
          const yy = y + 0.5;
          for (let x = 0; x < w; x++) {
            const xx = x + 0.5;
            if (pointInPoly(polyRel, xx, yy)) {
              const i = (y * w + x) * 4;
              d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; d[i + 3] = 255;
            }
          }
        }
        mctx.putImageData(id, 0, 0);
        return m;
      }
      function appendLassoStrokePoint(stroke, p) {
        if (!stroke || !stroke.points || !stroke.points.length) return false;
        const last = stroke.points[stroke.points.length - 1];
        const totalDist = Math.hypot(p.x - last.x, p.y - last.y);
        const steps = Math.ceil(totalDist);
        if (steps <= 0) return false;

        let prev = last;
        let added = false;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const tx = last.x + (p.x - last.x) * t;
          const ty = last.y + (p.y - last.y) * t;
          const dx = Math.abs(tx - prev.x);
          const dy = Math.abs(ty - prev.y);

          const newPoint = (dx >= dy)
            ? { x: Math.round(tx), y: Math.round(prev.y) }
            : { x: Math.round(prev.x), y: Math.round(ty) };
          if (newPoint.x === Math.round(prev.x) && newPoint.y === Math.round(prev.y)) continue;

          stroke.points.push(newPoint);
          if (newPoint.x < stroke.minX) stroke.minX = newPoint.x;
          if (newPoint.y < stroke.minY) stroke.minY = newPoint.y;
          if (newPoint.x > stroke.maxX) stroke.maxX = newPoint.x;
          if (newPoint.y > stroke.maxY) stroke.maxY = newPoint.y;
          prev = newPoint;
          added = true;
        }
        return added;
      }
      function applyLassoPaintPolygon(points, erase = false) {
        if (!points || points.length < 3) return false;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < points.length; i++) {
          const p = points[i];
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
        const x0 = Math.max(0, Math.min(W - 1, Math.round(minX)));
        const y0 = Math.max(0, Math.min(H - 1, Math.round(minY)));
        const x1 = Math.max(0, Math.min(W - 1, Math.round(maxX)));
        const y1 = Math.max(0, Math.min(H - 1, Math.round(maxY)));
        if (x1 < x0 || y1 < y0) return false;

        const w = Math.max(1, x1 - x0 + 1);
        const h = Math.max(1, y1 - y0 + 1);
        const polyRel = points.map(p => ({ x: p.x - x0, y: p.y - y0 }));
        const lim = ditherLimit(Math.max(0, Math.min(10, lassoPaint.dither | 0)));
        const [r, g, b] = hexToRGBA(brush.color);

        const fctx = frames[current].layers[activeLayer].ctx;
        const before = fctx.getImageData(x0, y0, w, h);
        const after = fctx.getImageData(x0, y0, w, h);
        const data = after.data;
        let changed = false;

        for (let y = 0; y < h; y++) {
          const yy = y + 0.5;
          const py = y0 + y;
          const my = py & 3;
          for (let x = 0; x < w; x++) {
            const xx = x + 0.5;
            if (!pointInPoly(polyRel, xx, yy)) continue;

            const px = x0 + x;
            if (lim !== null && BAYER4[my][px & 3] >= lim) continue;

            const i = (y * w + x) * 4;
            if (erase) {
              if (data[i + 3] === 0) continue;
              data[i + 3] = 0;
              changed = true;
            } else {
              if (data[i] === r && data[i + 1] === g && data[i + 2] === b && data[i + 3] === 255) continue;
              data[i] = r;
              data[i + 1] = g;
              data[i + 2] = b;
              data[i + 3] = 255;
              changed = true;
            }
          }
        }
        if (!changed) return false;

        fctx.putImageData(after, x0, y0);
        pushPaintPatch(current, x0, y0, w, h, before, after, activeLayer);
        updateThumb(current);
        refreshFilmTile(current);
        render();
        return true;
      }
      function selectionContainsPoint(px, py) {
        if (!sel) return false;
        if (sel.poly && sel.poly.length) {
          return pointInPoly(sel.poly, px - sel.x + 0.5, py - sel.y + 0.5);
        }
        return (px >= sel.x && px <= sel.x + sel.w && py >= sel.y && py <= sel.y + sel.h);
      }





      const DITHER_MASK_CACHE = new Map();
      function getDitherPattern(level) {
        const lim = ditherLimit(level);
        if (lim === null) return null;
        const key = String(lim);
        if (DITHER_MASK_CACHE.has(key)) return DITHER_MASK_CACHE.get(key);

        const tile = document.createElement('canvas');
        tile.width = 4; tile.height = 4;
        const x = tile.getContext('2d');
        const id = x.createImageData(4, 4);
        const d = id.data;
        let p = 0;
        for (let y = 0; y < 4; y++) {
          for (let z = 0; z < 4; z++) {
            const on = BAYER4[y][z] < lim ? 255 : 0;
            d[p++] = 255; d[p++] = 255; d[p++] = 255; d[p++] = on;
          }
        }
        x.putImageData(id, 0, 0);
        const pat = x.createPattern(tile, 'repeat');
        DITHER_MASK_CACHE.set(key, pat);
        return pat;
      }
      function applyDitherMaskToBBox(ctx, bbox, level = brush.ditherLevel) {
        if (!bbox) return;
        const pat = getDitherPattern(level);
        if (!pat) return;
        const x = Math.max(0, Math.floor(bbox.x));
        const y = Math.max(0, Math.floor(bbox.y));
        const w = Math.max(1, Math.ceil(bbox.x2) - x);
        const h = Math.max(1, Math.ceil(bbox.y2) - y);
        ctx.save();
        ctx.globalCompositeOperation = 'destination-in';
        ctx.fillStyle = pat;
        ctx.fillRect(x, y, w, h);
        ctx.restore();
      }

      function expandBBox(b, x, y, w, h) {
        if (!b) {
          shapeState.bbox = { x, y, x2: x + w, y2: y + h };
          return;
        }
        if (x < b.x) b.x = x;
        if (y < b.y) b.y = y;
        if (x + w > b.x2) b.x2 = x + w;
        if (y + h > b.y2) b.y2 = y + h;
      }


      function dotSolid(c, x, y, size) {
        const s = Math.max(1, size | 0);
        const ox = Math.round(x - Math.floor(s / 2));
        const oy = Math.round(y - Math.floor(s / 2));
        c.fillRect(ox, oy, s, s);
        expandBBox(shapeState.bbox, ox, oy, s, s);
      }


      function lineToCtx(c, x0, y0, x1, y1, thickness = 1) {
        c.fillStyle = brush.color;
        let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
        let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
        let err = dx + dy;
        while (true) {
          dotSolid(c, x0, y0, thickness);
          if (x0 === x1 && y0 === y1) break;
          const e2 = 2 * err;
          if (e2 >= dy) { err += dy; x0 += sx; }
          if (e2 <= dx) { err += dx; y0 += sy; }
        }
      }




      function rectOutline(c, x0, y0, x1, y1, th) {
        const t = Math.max(1, th | 0);

        const minX = Math.min(x0, x1);
        const maxX = Math.max(x0, x1);
        const minY = Math.min(y0, y1);
        const maxY = Math.max(y0, y1);

        const w = maxX - minX + 1;
        const h = maxY - minY + 1;

        c.fillStyle = brush.color;


        if (t >= Math.min(w, h)) {
          c.fillRect(minX, minY, w, h);
          expandBBox(shapeState.bbox, minX, minY, w, h);
          return;
        }


        c.fillRect(minX, minY, w, t);
        expandBBox(shapeState.bbox, minX, minY, w, t);


        const by = maxY - t + 1;
        c.fillRect(minX, by, w, t);
        expandBBox(shapeState.bbox, minX, by, w, t);


        const midY = minY + t;
        const midH = h - 2 * t;


        c.fillRect(minX, midY, t, midH);
        expandBBox(shapeState.bbox, minX, midY, t, midH);


        const rx = maxX - t + 1;
        c.fillRect(rx, midY, t, midH);
        expandBBox(shapeState.bbox, rx, midY, t, midH);
      }



      function rectFill(c, x0, y0, x1, y1) {
        const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
        const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
        const w = (maxX - minX + 1), h = (maxY - minY + 1);

        c.fillStyle = brush.color;
        c.fillRect(minX, minY, w, h);
        expandBBox(shapeState.bbox, minX, minY, w, h);
      }




      function ellipseOutline(c, x0, y0, x1, y1, thickness) {
        const cx = (x0 + x1) / 2;
        const cy = (y0 + y1) / 2;
        const rx = Math.abs(x1 - x0) / 2;
        const ry = Math.abs(y1 - y0) / 2;

        const rxo = Math.round(rx + Math.max(1, Math.floor(thickness / 2)));
        const ryo = Math.round(ry + Math.max(1, Math.floor(thickness / 2)));
        const rxi = Math.max(0, Math.round(rx - Math.ceil((thickness - 1) / 2)));
        const ryi = Math.max(0, Math.round(ry - Math.ceil((thickness - 1) / 2)));

        c.fillStyle = brush.color;

        if (rxi <= 0 || ryi <= 0) {
          const yTop = Math.round(cy - ryo), yBot = Math.round(cy + ryo);
          for (let y = yTop; y <= yBot; y++) {
            const dy = (y - cy) / ryo;
            const inside = 1 - dy * dy;
            if (inside < 0) continue;
            const wx = Math.floor(rxo * Math.sqrt(inside));
            const xL = Math.round(cx - wx), xR = Math.round(cx + wx);
            c.fillRect(xL, y, xR - xL + 1, 1);
            expandBBox(shapeState.bbox, xL, y, (xR - xL + 1), 1);
          }
          return;
        }

        const yTop = Math.round(cy - ryo), yBot = Math.round(cy + ryo);
        for (let y = yTop; y <= yBot; y++) {
          const dyO = (y - cy) / ryo;
          const inO = 1 - dyO * dyO;
          if (inO <= 0) continue;
          const wxO = Math.floor(rxo * Math.sqrt(inO));
          const xLo = Math.round(cx - wxO), xRo = Math.round(cx + wxO);

          const dyI = (y - cy) / ryi;
          const inI = 1 - dyI * dyI;
          let xLi = Infinity, xRi = -Infinity;
          if (inI > 0) {
            const wxI = Math.floor(rxi * Math.sqrt(inI));
            xLi = Math.round(cx - wxI);
            xRi = Math.round(cx + wxI);
          }


          const L1 = xLo, R1 = Math.min(xRo, xLi - 1);
          if (L1 <= R1) {
            c.fillRect(L1, y, R1 - L1 + 1, 1);
            expandBBox(shapeState.bbox, L1, y, (R1 - L1 + 1), 1);
          }

          const L2 = Math.max(xLo, xRi + 1), R2 = xRo;
          if (L2 <= R2) {
            c.fillRect(L2, y, R2 - L2 + 1, 1);
            expandBBox(shapeState.bbox, L2, y, (R2 - L2 + 1), 1);
          }
        }
      }
      function ellipseFill(c, x0, y0, x1, y1) {
        const cx = (x0 + x1) / 2;
        const cy = (y0 + y1) / 2;
        const rx = Math.abs(x1 - x0) / 2;
        const ry = Math.abs(y1 - y0) / 2;

        const rxi = Math.max(0, Math.round(rx));
        const ryi = Math.max(0, Math.round(ry));

        c.fillStyle = brush.color;

        if (rxi === 0 && ryi === 0) {
          const px = Math.round(cx), py = Math.round(cy);
          c.fillRect(px, py, 1, 1);
          expandBBox(shapeState.bbox, px, py, 1, 1);
          return;
        }

        const yTop = Math.round(cy - ryi), yBot = Math.round(cy + ryi);
        for (let y = yTop; y <= yBot; y++) {
          const dy = (y - cy) / ry;
          const inside = 1 - dy * dy;
          if (inside < 0) continue;
          const wx = Math.floor(rx * Math.sqrt(inside));
          const xL = Math.round(cx - wx), xR = Math.round(cx + wx);
          c.fillRect(xL, y, xR - xL + 1, 1);
          expandBBox(shapeState.bbox, xL, y, (xR - xL + 1), 1);
        }
      }


      function triVerticesFromBox(x0, y0, x1, y1) {
        const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
        const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
        const midX = Math.round((minX + maxX) / 2);
        return [
          { x: midX, y: minY },
          { x: minX, y: maxY },
          { x: maxX, y: maxY }
        ];
      }
      function triOutline(c, v, th) {
        lineToCtx(c, v[0].x, v[0].y, v[1].x, v[1].y, th);
        lineToCtx(c, v[1].x, v[1].y, v[2].x, v[2].y, th);
        lineToCtx(c, v[2].x, v[2].y, v[0].x, v[0].y, th);
      }
      function triFill(c, v) {
        const pts = v.slice().sort((a, b) => a.y - b.y);
        const [v0, v1, v2] = pts;
        c.fillStyle = brush.color;

        const yStart = Math.max(0, Math.round(v0.y));
        const yEnd = Math.min(H - 1, Math.round(v2.y));

        const edgeInterp = (y, a, b) => {
          if (b.y === a.y) return a.x;
          return a.x + (b.x - a.x) * ((y - a.y) / (b.y - a.y));
        };

        for (let y = yStart; y <= yEnd; y++) {
          let xa, xb;
          if (y < v1.y) { xa = edgeInterp(y, v0, v1); xb = edgeInterp(y, v0, v2); }
          else { xa = edgeInterp(y, v1, v2); xb = edgeInterp(y, v0, v2); }
          const xStart = Math.round(Math.min(xa, xb));
          const xEnd = Math.round(Math.max(xa, xb));
          c.fillRect(xStart, y, xEnd - xStart + 1, 1);
          expandBBox(shapeState.bbox, xStart, y, (xEnd - xStart + 1), 1);
        }
      }


      function drawShapePreview() {
        shapePrev.width = W; shapePrev.height = H;
        shapePrevCtx.clearRect(0, 0, W, H);
        shapeState.bbox = null;

        const { x0, y0, x1, y1, kind, fill, erase } = shapeState;
        const s = Math.max(1, shapeState.size | 0);

        shapePrevCtx.save();
        if (erase) {
          const dashOffset = Math.floor(Date.now() / 50) % 16;


          const minX = Math.round(Math.min(x0, x1)), maxX = Math.round(Math.max(x0, x1));
          const minY = Math.round(Math.min(y0, y1)), maxY = Math.round(Math.max(y0, y1));
          const w = maxX - minX, h = maxY - minY;


          const dashLen = 6, gapLen = 4;
          const totalDash = dashLen + gapLen;

          function drawDashedPixel(px, py, dist) {
            const phase = (dist + dashOffset) % totalDash;
            if (phase < dashLen) {
              shapePrevCtx.fillStyle = 'rgba(58, 163, 255, 0.8)';
              shapePrevCtx.fillRect(px, py, 1, 1);
            }
          }

          if (kind === 'line') {

            let lx0 = Math.round(x0), ly0 = Math.round(y0), lx1 = Math.round(x1), ly1 = Math.round(y1);
            let dx = Math.abs(lx1 - lx0), sx = lx0 < lx1 ? 1 : -1;
            let dy = -Math.abs(ly1 - ly0), sy = ly0 < ly1 ? 1 : -1;
            let err = dx + dy, dist = 0;
            for (; ;) {
              drawDashedPixel(lx0, ly0, dist++);
              if (lx0 === lx1 && ly0 === ly1) break;
              const e2 = 2 * err;
              if (e2 >= dy) { err += dy; lx0 += sx; }
              if (e2 <= dx) { err += dx; ly0 += sy; }
            }
          } else if (kind === 'rect') {

            let dist = 0;
            for (let x = minX; x <= maxX; x++) { drawDashedPixel(x, minY, dist++); }
            for (let y = minY + 1; y <= maxY; y++) { drawDashedPixel(maxX, y, dist++); }
            for (let x = maxX - 1; x >= minX; x--) { drawDashedPixel(x, maxY, dist++); }
            for (let y = maxY - 1; y > minY; y--) { drawDashedPixel(minX, y, dist++); }
          } else if (kind === 'circle') {

            const cx = Math.round((minX + maxX) / 2), cy = Math.round((minY + maxY) / 2);
            const rx = Math.max(1, Math.round(w / 2)), ry = Math.max(1, Math.round(h / 2));
            let x = 0, y = ry;
            let rx2 = rx * rx, ry2 = ry * ry;
            let px = 0, py = 2 * rx2 * y;
            let p = ry2 - (rx2 * ry) + (0.25 * rx2);
            let dist = 0;
            while (px < py) {
              drawDashedPixel(cx + x, cy - y, dist); drawDashedPixel(cx - x, cy - y, dist);
              drawDashedPixel(cx + x, cy + y, dist); drawDashedPixel(cx - x, cy + y, dist);
              x++; px += 2 * ry2; dist++;
              if (p < 0) { p += ry2 + px; }
              else { y--; py -= 2 * rx2; p += ry2 + px - py; }
            }
            p = ry2 * (x + 0.5) * (x + 0.5) + rx2 * (y - 1) * (y - 1) - rx2 * ry2;
            while (y >= 0) {
              drawDashedPixel(cx + x, cy - y, dist); drawDashedPixel(cx - x, cy - y, dist);
              drawDashedPixel(cx + x, cy + y, dist); drawDashedPixel(cx - x, cy + y, dist);
              y--; py -= 2 * rx2; dist++;
              if (p > 0) { p += rx2 - py; }
              else { x++; px += 2 * ry2; p += rx2 - py + px; }
            }
          } else if (kind === 'tri') {
            const v = triVerticesFromBox(x0, y0, x1, y1);
            const vx = [Math.round(v[0].x), Math.round(v[1].x), Math.round(v[2].x)];
            const vy = [Math.round(v[0].y), Math.round(v[1].y), Math.round(v[2].y)];
            let dist = 0;
            for (let i = 0; i < 3; i++) {
              let lx0 = vx[i], ly0 = vy[i], lx1 = vx[(i + 1) % 3], ly1 = vy[(i + 1) % 3];
              let dx = Math.abs(lx1 - lx0), sx = lx0 < lx1 ? 1 : -1;
              let dy = -Math.abs(ly1 - ly0), sy = ly0 < ly1 ? 1 : -1;
              let err = dx + dy;
              for (; ;) {
                drawDashedPixel(lx0, ly0, dist++);
                if (lx0 === lx1 && ly0 === ly1) break;
                const e2 = 2 * err;
                if (e2 >= dy) { err += dy; lx0 += sx; }
                if (e2 <= dx) { err += dx; ly0 += sy; }
              }
            }
          }

          shapeState.bbox = { x: minX, y: minY, x2: maxX + 1, y2: maxY + 1 };

          if (mirror.h || mirror.v) {
            shapeState.bbox = { x: 0, y: 0, x2: W, y2: H };
          }
        } else {

          function drawShapeAtCoords(ctx, sx0, sy0, sx1, sy1) {
            if (kind === 'line') { lineToCtx(ctx, sx0, sy0, sx1, sy1, s); }
            else if (kind === 'rect') { fill ? rectFill(ctx, sx0, sy0, sx1, sy1) : rectOutline(ctx, sx0, sy0, sx1, sy1, s); }
            else if (kind === 'circle') { fill ? ellipseFill(ctx, sx0, sy0, sx1, sy1) : ellipseOutline(ctx, sx0, sy0, sx1, sy1, s); }
            else if (kind === 'tri') { const v = triVerticesFromBox(sx0, sy0, sx1, sy1); fill ? triFill(ctx, v) : triOutline(ctx, v, s); }
          }


          drawShapeAtCoords(shapePrevCtx, x0, y0, x1, y1);


          if (mirror.h) {
            drawShapeAtCoords(shapePrevCtx, W - 1 - x0, y0, W - 1 - x1, y1);
          }
          if (mirror.v) {
            drawShapeAtCoords(shapePrevCtx, x0, H - 1 - y0, x1, H - 1 - y1);
          }
          if (mirror.h && mirror.v) {
            drawShapeAtCoords(shapePrevCtx, W - 1 - x0, H - 1 - y0, W - 1 - x1, H - 1 - y1);
          }


          if (mirror.h || mirror.v) {
            shapeState.bbox = { x: 0, y: 0, x2: W, y2: H };
          }
        }

        shapePrevCtx.restore();

        if (shapeState.dither > 0) {
          applyDitherMaskToBBox(shapePrevCtx, shapeState.bbox, shapeState.dither);
        }
      }



      function sampleUnderPointer(e) {
        const p = toCanvasXY(e);
        const tctx = sampleCtx;
        tctx.globalAlpha = 1;
        tctx.clearRect(0, 0, 1, 1);


        if (!bgTransparent) {
          tctx.fillStyle = bgColor;
          tctx.fillRect(0, 0, 1, 1);
          tctx.drawImage(frames[current].bg.can, -p.x, -p.y);
        }


        layerOrder.forEach(idx => {
          const l = frames[current].layers[idx];
          if (l.visible) {
            tctx.globalAlpha = l.opacity;
            tctx.drawImage(l.can, -p.x, -p.y);
          }
        });

        const d = tctx.getImageData(0, 0, 1, 1).data;
        lastSampledHex = rgbaToHex(d[0], d[1], d[2], d[3]);
        setColor(lastSampledHex);
        showToast(`<div style="display:flex;align-items:center;gap:10px"><div style="width:18px;height:18px;background:${lastSampledHex};border:1px solid #fff;border-radius:4px;box-shadow:0 0 0 1px #000"></div><span style="font-family:monospace;font-weight:700;font-size:14px">${lastSampledHex}</span></div>`);
      }

      function beginStroke(e) {
        if (playing && !isPlaybackPaintTool(tool)) return;

        if (isTouchEvent(e)) {
          updateTouch(e.pointerId, e);
          if (touchState.map.size === 2) {
            const gd = currentMidAndDist(); if (!gd) return;
            touchState.mode = 'pinch';
            touchState.startMid = gd.mid; touchState.startScale = view.scale; touchState.startDist = gd.dist;
            const startWorld = worldFromScreen(gd.mid.sx, gd.mid.sy);
            touchState.anchor = { wx: startWorld.wx, wy: startWorld.wy };
            return;
          }
        }

        e.preventDefault();
        refreshStagePointerMetrics(true);


        if (picking && e.button === 0) {
          pickerSampling = true;
          pickBtn.classList.add('active');
          if (currentColorBtn) currentColorBtn.classList.add('picker-active');
          if (pickerPair) pickerPair.classList.add('picker-active');
          updatePickerCanvasCursor();
          stage.setPointerCapture(e.pointerId);
          sampleUnderPointer(e);
          return;
        }


        if (e.button === 1) {
          panning = true; autoCenter = false; stage.setPointerCapture(e.pointerId);
          panSX = (e.clientX - stageRectLeft) * stageScaleX;
          panSY = (e.clientY - stageRectTop) * stageScaleY;
          panTX = view.tx;
          panTY = view.ty;
          return;
        }


        if (importPreview && e.button === 0) {
          const p = toCanvasXY(e);


          if (importPreview.cropping) {
            if (handleImportCropStart(p.x, p.y)) {
              stage.setPointerCapture(e.pointerId);
              return;
            }
            return;
          }

          const handle = getImportResizeHandle(p.x, p.y);
          if (handle && !importPreview.cropping) {

            importPreview.resizing = true;
            importPreview.resizeHandle = handle;
            importPreview.startX = importPreview.x;
            importPreview.startY = importPreview.y;
            importPreview.startW = importPreview.w;
            importPreview.startH = importPreview.h;
            importPreview.startMouseX = p.x;
            importPreview.startMouseY = p.y;
            stage.setPointerCapture(e.pointerId);
            return;
          } else if (isInsideImportPreview(p.x, p.y) && !importPreview.cropping) {

            importPreview.dragging = true;
            importPreview.dragDX = p.x - importPreview.x;
            importPreview.dragDY = p.y - importPreview.y;
            stage.setPointerCapture(e.pointerId);
            return;
          } else if (!importPreview.cropping) {

            applyImportPreview();
            return;
          }
          return;
        }


        if (importPreview) return;

        if (tool === 'smudge') {
          if (playing) {
            beginPlaybackStrokeHistory(activeLayer);
            recordPlaybackFrameBefore(current);
          } else {
            clearPlaybackStrokeHistory();
          }
          const p = toCanvasXY(e);
          const fctx = frames[current].layers[activeLayer].ctx;
          const beforeData = playing ? null : fctx.getImageData(0, 0, W, H);
          smudgeState = {
            active: true,
            pid: e.pointerId,
            lastX: p.x,
            lastY: p.y,
            before: beforeData
          };
          stage.setPointerCapture(e.pointerId);
          if (cursorPos) cursorPos.visible = true;
          render();
          return;
        }


        if (tool === 'shape') {
          const p = toCanvasXY(e);
          shapeState.dragging = true;
          shapeState.pid = e.pointerId;
          shapeState.x0 = shapeState.x1 = p.x;
          shapeState.y0 = shapeState.y1 = p.y;
          shapeState.erase = (e.button === 2);
          preStrokeCtx.clearRect(0, 0, W, H); preStrokeCtx.drawImage(frames[current].layers[activeLayer].can, 0, 0);
          stage.setPointerCapture(e.pointerId);
          drawShapePreview(); render();
          return;
        }


        if (tool === 'text' && e.button === 0) {
          const p = toCanvasXY(e);
          if (textState.active) {

            const m = measureBitmapText(textState.text, textState.bold);
            const w = m.w * textState.scale, h = m.h * textState.scale;

            if (p.x >= textState.x - 4 && p.x <= textState.x + w + 4 &&
              p.y >= textState.y - 4 && p.y <= textState.y + h + 4) {
              textState.dragging = true;
              textState.dragOffsetX = p.x - textState.x;
              textState.dragOffsetY = p.y - textState.y;
              stage.setPointerCapture(e.pointerId);
              return;
            }

            applyBitmapText();
          }
          startTextMode(p.x, p.y);
          return;
        }


        if (tool === 'lasso') {
          const p = toCanvasXY(e);
          if (sel) {
            const hit = hitSelButton(p.x, p.y);


            if (hit === 'nw' || hit === 'ne' || hit === 'sw' || hit === 'se') {
              startScaleTransform(e, p, hit); return;
            }
            if (hit === 'rot') {
              startRotateTransform(e, p); return;
            }
            if (selectionContainsPoint(p.x, p.y)) {
              if (!sel._moveStart) sel._moveStart = { x: sel.x, y: sel.y };
              if (!sel._id) sel._id = (++__selIdSeq);
              sel.state = 'move'; sel.pid = e.pointerId; sel.dragDX = p.x - sel.x; sel.dragDY = p.y - sel.y; stage.setPointerCapture(e.pointerId); return;
            }
            commitSelectionIfAny();
          }
          lasso = { points: [p], pid: e.pointerId, minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };
          stage.setPointerCapture(e.pointerId); render(); return;
        }

        if (tool === 'fx' && fx.mode === 'lassoFill') {
          if (e.button !== 0 && e.button !== 2) return;
          const p = toCanvasXY(e);
          const erase = (e.button === 2) || e.detail >= 2;
          lassoPaintStroke = { points: [p], pid: e.pointerId, minX: p.x, minY: p.y, maxX: p.x, maxY: p.y, erase };
          stage.setPointerCapture(e.pointerId);
          render();
          return;
        }


        if (tool === 'select') {
          const p = toCanvasXY(e);
          if (sel) {
            const hit = hitSelButton(p.x, p.y);

            if (hit === 'nw' || hit === 'ne' || hit === 'sw' || hit === 'se') {
              startScaleTransform(e, p, hit); return;
            }
            if (hit === 'rot') {
              startRotateTransform(e, p); return;
            }
          }
          if (sel && selectionContainsPoint(p.x, p.y)) {
            if (!sel._moveStart) sel._moveStart = { x: sel.x, y: sel.y };
            if (!sel._id) sel._id = (++__selIdSeq);
            sel.state = 'move'; sel.pid = e.pointerId; sel.dragDX = p.x - sel.x; sel.dragDY = p.y - sel.y; stage.setPointerCapture(e.pointerId); return;
          }
          if (sel) { commitSelectionIfAny(); }
          sel = { x: p.x, y: p.y, w: 0, h: 0, img: null, mask: null, originX: 0, originY: 0, hasCut: false, state: 'marquee', pid: e.pointerId, dragDX: 0, dragDY: 0, source: 'select', poly: null, _frame: current };
          stage.setPointerCapture(e.pointerId); render(); return;
        }


        if (tool === 'fill') { const p = toCanvasXY(e); doFill(p.x, p.y, e.button === 2 ? 'erase' : 'paint'); return; }


        if (tool === 'ditherFill') {
          const p = toCanvasXY(e);
          ditherFillDrag.dragging = true;
          ditherFillDrag.pid = e.pointerId;
          ditherFillDrag.x0 = p.x;
          ditherFillDrag.y0 = p.y;
          ditherFillDrag.x1 = p.x;
          ditherFillDrag.y1 = p.y;
          ditherFillDrag.erase = (e.button === 2);
          stage.setPointerCapture(e.pointerId);
          render();
          return;
        }

        if (tool === 'fx' && fx.mode === 'outline') {
          if (e.button !== 0) return;
          const p = toCanvasXY(e);
          applyFXFloodOutline(p.x, p.y);
          return;
        }
        if (tool === 'fx' && fx.mode === 'glow') {
          if (e.button !== 0) return;
          const p = toCanvasXY(e);
          applyFXSelectiveGlow(p.x, p.y);
          return;
        }


        const isEraserPen = (e.pointerType === 'eraser' || (e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32))));
        if (e.button === 2 || isEraserPen) { tempTool = 'eraser'; }

        stage.setPointerCapture(e.pointerId);
        strokeMinX = Infinity; strokeMinY = Infinity; strokeMaxX = -Infinity; strokeMaxY = -Infinity;
        const p = toCanvasXY(e);

        if (playing) {
          beginPlaybackStrokeHistory(activeLayer);
          recordPlaybackFrameBefore(current);
        } else {
          clearPlaybackStrokeHistory();
        }


        preStrokeCtx.clearRect(0, 0, W, H);
        preStrokeCtx.drawImage(frames[current].layers[activeLayer].can, 0, 0);

        const strokeTool = currentTool();
        startFXStrokeSession(strokeTool);

        drawing = true; lastX = p.x; lastY = p.y; smoothX = p.x; smoothY = p.y; haveSmooth = true;

        let press = (e.pointerType === 'mouse') ? 1 : (e.pressure !== undefined ? e.pressure : 1);
        holdStrokePressure = press;
        if (strokeTool === 'brush' && !tempTool && e.button === 0 && e.shiftKey && brushLineAnchor &&
          brushLineAnchor.fi === current && brushLineAnchor.layer === activeLayer) {
          lineB(brushLineAnchor.x, brushLineAnchor.y, p.x, p.y, press);
          lastX = p.x;
          lastY = p.y;
          render();
          endStroke(e);
          return;
        }
        if (strokeTool === 'eraser' && !tempTool && e.button === 0 && e.shiftKey && eraserLineAnchor &&
          eraserLineAnchor.fi === current && eraserLineAnchor.layer === activeLayer) {
          lineB(eraserLineAnchor.x, eraserLineAnchor.y, p.x, p.y, press);
          lastX = p.x;
          lastY = p.y;
          render();
          endStroke(e);
          return;
        }
        dot(p.x, p.y, press); render();
      }

      function currentTool() {
        if (tempTool) return tempTool;
        if (tool === 'fx') {
          if (fx.mode === 'trail') return 'fxTrail';
          if (fx.mode === 'outline') return 'fxOutlineFlood';
          if (fx.mode === 'glow') return 'fxGlow';
          if (fx.mode === 'lassoFill') return 'lassoPaint';
        }
        return tool;
      }
      function dot(x, y, pressure = 1, _skipMirror) {
        const t = currentTool();
        const c2d = frames[current].layers[activeLayer].ctx;

        if (t === 'fxTrail') {
          const spacing = Math.max(1, fx.trail.spacing | 0);
          if (!_skipMirror) {
            if (fxStroke.lastStampX !== null && Math.hypot(x - fxStroke.lastStampX, y - fxStroke.lastStampY) < spacing) return;
            fxStroke.lastStampX = x;
            fxStroke.lastStampY = y;
          }

          const vary = Math.max(0, Math.min(100, fx.trail.variation | 0)) / 100;
          const sizeJitter = 1 + ((Math.random() * 2 - 1) * vary * 0.9);
          const s = Math.max(1, Math.round(fx.trail.size * sizeJitter));
          const shape = fx.trail.shape;
          c2d.fillStyle = brush.color;

          let minX = W, minY = H, maxX = -1, maxY = -1;
          const plot = (px, py) => {
            if (px < 0 || px >= W || py < 0 || py >= H) return;
            c2d.fillRect(px, py, 1, 1);
            if (px < minX) minX = px;
            if (py < minY) minY = py;
            if (px > maxX) maxX = px;
            if (py > maxY) maxY = py;
          };

          if (shape === 'grass') {
            const blades = 2 + Math.round(Math.random() * 2);
            const maxLen = Math.max(2, Math.round(s * (1.5 + vary)));
            for (let b = 0; b < blades; b++) {
              const baseX = Math.round(x + (Math.random() * 2 - 1) * Math.max(1, s / 3));
              const baseY = Math.round(y + (Math.random() * 2 - 1) * Math.max(1, s / 5));
              const lean = (Math.random() * 2 - 1) * (0.35 + vary * 0.85);
              for (let i = 0; i < maxLen; i++) {
                if (i > 1 && Math.random() < 0.12) continue;
                plot(Math.round(baseX + lean * i), Math.round(baseY - i));
              }
            }
          } else {
            const ox = Math.round(x - Math.floor(s / 2));
            const oy = Math.round(y - Math.floor(s / 2));
            const r = s / 2;
            const cx = s / 2 - 0.5;
            const cy = s / 2 - 0.5;
            const diamondR = Math.max(1, Math.floor(s / 2));
            for (let dy = 0; dy < s; dy++) {
              for (let dx = 0; dx < s; dx++) {
                let paint = false;
                if (shape === 'square') {
                  paint = true;
                } else if (shape === 'diamond') {
                  paint = Math.abs(dx - cx) + Math.abs(dy - cy) <= diamondR + 0.4;
                } else {
                  const ddx = dx - cx;
                  const ddy = dy - cy;
                  paint = ddx * ddx + ddy * ddy <= r * r + 0.1;
                }
                if (paint) plot(ox + dx, oy + dy);
              }
            }
          }

          if (maxX >= minX && maxY >= minY) markStrokeBoundsBox(minX, minY, maxX, maxY);

          if (!_skipMirror && (mirror.h || mirror.v)) {
            if (mirror.h) dot(W - 1 - x, y, pressure, true);
            if (mirror.v) dot(x, H - 1 - y, pressure, true);
            if (mirror.h && mirror.v) dot(W - 1 - x, H - 1 - y, pressure, true);
          }
          return;
        }

        if (t === 'fxOutline') {
          if (!fxStroke.sourceAlpha) startFXStrokeSession('fxOutline');
          applyFXOutlineStrokeAt(x, y);
          if (!_skipMirror && (mirror.h || mirror.v)) {
            if (mirror.h) dot(W - 1 - x, y, pressure, true);
            if (mirror.v) dot(x, H - 1 - y, pressure, true);
            if (mirror.h && mirror.v) dot(W - 1 - x, H - 1 - y, pressure, true);
          }
          return;
        }

        if (playing && playbackStrokeBeforeByFrame && (t === 'brush' || t === 'eraser')) {
          recordPlaybackFrameBefore(current);
        }

        const isEraser = (t === 'eraser');
        let s = isEraser ? (eraser.size | 0) : (brush.size | 0);
        const toolObj = isEraser ? eraser : brush;
        const pTarget = toolObj.pressureTarget;
        let adjPressure = pressure;
        if (toolObj.usePressure) {
          const sens = (toolObj.pressureSens !== undefined ? toolObj.pressureSens : 50) / 50;
          adjPressure = Math.min(1, Math.max(0, pressure * sens));
          if (pTarget === 'size' || pTarget === 'both') {
            s = Math.max(1, Math.round(s * adjPressure));
          }
        }

        const ox = Math.round(x - Math.floor(s / 2));
        const oy = Math.round(y - Math.floor(s / 2));
        let lim;
        if (isEraser) {
          const l = eraser.ditherLevel;
          let effectL = l;
          if (eraser.usePressure && (eraser.pressureTarget === 'dither' || eraser.pressureTarget === 'both')) {
            effectL = Math.max(1, Math.round(l * adjPressure));
          }
          lim = ditherLimit(effectL);
        } else {
          const l = brush.ditherLevel;
          let effectL = l;
          if (brush.usePressure && (brush.pressureTarget === 'dither' || brush.pressureTarget === 'both')) {
            effectL = Math.max(1, Math.round(l * adjPressure));
          }
          lim = ditherLimit(effectL);
        }

        if (isEraser) {
          const r = s / 2, r2 = r * r;
          const cx = s / 2 - 0.5, cy = s / 2 - 0.5;
          if (lim === null) {
            for (let dy = 0; dy < s; dy++) {
              const py = oy + dy; if (py < 0 || py >= H) continue;
              for (let dx = 0; dx < s; dx++) {
                const px = ox + dx; if (px < 0 || px >= W) continue;
                const ddx = dx - cx, ddy = dy - cy;
                if (ddx * ddx + ddy * ddy <= r2 + 0.1) c2d.clearRect(px, py, 1, 1);
              }
            }
          } else {
            for (let dy = 0; dy < s; dy++) {
              const py = oy + dy; if (py < 0 || py >= H) continue; const my = py & 3;
              for (let dx = 0; dx < s; dx++) {
                const px = ox + dx; if (px < 0 || px >= W) continue; const mx = px & 3;
                const ddx = dx - cx, ddy = dy - cy;
                if (ddx * ddx + ddy * ddy <= r2 + 0.1 && BAYER4[my][mx] < lim) c2d.clearRect(px, py, 1, 1);
              }
            }
          }
        } else {
          c2d.fillStyle = brush.color;
          const r = s / 2, r2 = r * r;
          const cx = s / 2 - 0.5, cy = s / 2 - 0.5;
          if (lim === null) {
            for (let dy = 0; dy < s; dy++) {
              const py = oy + dy; if (py < 0 || py >= H) continue;
              for (let dx = 0; dx < s; dx++) {
                const px = ox + dx; if (px < 0 || px >= W) continue;
                const ddx = dx - cx, ddy = dy - cy;
                if (ddx * ddx + ddy * ddy <= r2 + 0.1) c2d.fillRect(px, py, 1, 1);
              }
            }
          } else {
            for (let dy = 0; dy < s; dy++) {
              const py = oy + dy; if (py < 0 || py >= H) continue; const my = py & 3;
              for (let dx = 0; dx < s; dx++) {
                const px = ox + dx; if (px < 0 || px >= W) continue; const mx = px & 3;
                const ddx = dx - cx, ddy = dy - cy;
                if (ddx * ddx + ddy * ddy <= r2 + 0.1 && BAYER4[my][mx] < lim) c2d.fillRect(px, py, 1, 1);
              }
            }
          }
        }

        const rad = Math.ceil(s / 2);
        markStrokeBoundsBox(x - rad, y - rad, x + rad, y + rad);

        if (!_skipMirror && (mirror.h || mirror.v)) {
          const mirrorStampSize = Math.max(1, s | 0);
          if (mirror.h) {
            const mx = mirrorXCoord(x, mirrorStampSize);
            dot(mx, y, pressure, true);
            markStrokeBoundsBox(mx - rad, y - rad, mx + rad, y + rad);
          }
          if (mirror.v) {
            const my = mirrorYCoord(y, mirrorStampSize);
            dot(x, my, pressure, true);
            markStrokeBoundsBox(x - rad, my - rad, x + rad, my + rad);
          }
          if (mirror.h && mirror.v) {
            const mx = mirrorXCoord(x, mirrorStampSize);
            const my = mirrorYCoord(y, mirrorStampSize);
            dot(mx, my, pressure, true);
            markStrokeBoundsBox(mx - rad, my - rad, mx + rad, my + rad);
          }
        }
      }
      function lineB(x0, y0, x1, y1, pressure = 1) {
        let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1, dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1, err = dx + dy;
        for (; ;) {
          dot(x0, y0, pressure);
          if (x0 === x1 && y0 === y1) break;
          const e2 = 2 * err;
          if (e2 >= dy) { err += dy; x0 += sx; }
          if (e2 <= dx) { err += dx; y0 += sy; }
        }
      }

      function moveStroke(e) {
        if (playing && !isPlaybackPaintTool(tool)) {
          if (drawing || smudgeState.active || shapeState.dragging || ditherFillDrag.dragging || lassoPaintStroke) {
            endStroke(e);
          }
          return;
        }

        if (isTouchEvent(e)) {
          updateTouch(e.pointerId, e);
          if (touchState.mode === 'pinch' && touchState.map.size >= 2) {
            const gd = currentMidAndDist(); if (!gd) return;
            autoCenter = false;
            const factor = Math.max(0.25, Math.min(4, gd.dist / (touchState.startDist || gd.dist)));
            const ns = Math.max(view.minScale, Math.min(view.maxScale, touchState.startScale * factor));
            const anchor = touchState.anchor || worldFromScreen(gd.mid.sx, gd.mid.sy);
            view.scale = ns;
            view.tx = gd.mid.sx - anchor.wx * view.scale;
            view.ty = gd.mid.sy - anchor.wy * view.scale;
            updateZoomDisplay();
            requestRender();
            return;
          }
        }

        e.preventDefault();

        if (pickerSampling) { sampleUnderPointer(e); return; }

        if (panning) {
          const sx = (e.clientX - stageRectLeft) * stageScaleX;
          const sy = (e.clientY - stageRectTop) * stageScaleY;
          view.tx = panTX + (sx - panSX); view.ty = panTY + (sy - panSY); requestRender(); return;
        }


        if (tool === 'ditherFill' && ditherFillDrag.dragging && ditherFillDrag.pid === e.pointerId) {
          const p = toCanvasXY(e);
          ditherFillDrag.x1 = p.x;
          ditherFillDrag.y1 = p.y;
          requestRender();
          return;
        }


        if (importPreview) {
          const p = toCanvasXY(e);


          if (importPreview.cropDragging) {
            handleImportCropMove(p.x, p.y);
            return;
          }

          if (importPreview.dragging) {
            importPreview.x = Math.round(p.x - importPreview.dragDX);
            importPreview.y = Math.round(p.y - importPreview.dragDY);
            requestRender();
            return;
          }
          if (importPreview.resizing && importPreview.resizeHandle) {
            const dx = p.x - importPreview.startMouseX;
            const dy = p.y - importPreview.startMouseY;
            const handle = importPreview.resizeHandle;
            let newX = importPreview.startX, newY = importPreview.startY;
            let newW = importPreview.startW, newH = importPreview.startH;


            if (handle === 'se') {
              newW = Math.max(8, importPreview.startW + dx);
              newH = Math.max(8, importPreview.startH + dy);
            } else if (handle === 'sw') {
              newX = importPreview.startX + dx;
              newW = Math.max(8, importPreview.startW - dx);
              newH = Math.max(8, importPreview.startH + dy);
            } else if (handle === 'ne') {
              newY = importPreview.startY + dy;
              newW = Math.max(8, importPreview.startW + dx);
              newH = Math.max(8, importPreview.startH - dy);
            } else if (handle === 'nw') {
              newX = importPreview.startX + dx;
              newY = importPreview.startY + dy;
              newW = Math.max(8, importPreview.startW - dx);
              newH = Math.max(8, importPreview.startH - dy);
            }


            if (e.shiftKey) {
              const aspect = importPreview.origW / importPreview.origH;
              if (handle === 'se' || handle === 'nw') {
                newH = newW / aspect;
              } else {
                newW = newH * aspect;
              }
            }

            importPreview.x = Math.round(newX);
            importPreview.y = Math.round(newY);
            importPreview.w = Math.round(newW);
            importPreview.h = Math.round(newH);
            requestRender();
            return;
          }
        }


        if (tool === 'smudge' && smudgeState.active && smudgeState.pid === e.pointerId) {
          const p = toCanvasXY(e);
          doSmudgeStroke(p.x, p.y);
          requestRender();
          return;
        }

        if (tool === 'shape' && shapeState.dragging && shapeState.pid === e.pointerId) {
          const p = toCanvasXY(e);

          if (e.shiftKey && shapeState.kind !== 'line') {
            const dx = p.x - shapeState.x0, dy = p.y - shapeState.y0;
            const m = Math.max(Math.abs(dx), Math.abs(dy));
            shapeState.x1 = shapeState.x0 + Math.sign(dx || 1) * m;
            shapeState.y1 = shapeState.y0 + Math.sign(dy || 1) * m;
          } else {
            shapeState.x1 = p.x; shapeState.y1 = p.y;
          }
          drawShapePreview(); requestRender();
          return;
        }


        if (tool === 'text' && textState.active && textState.dragging) {
          const p = toCanvasXY(e);
          textState.x = p.x - textState.dragOffsetX;
          textState.y = p.y - textState.dragOffsetY;
          requestRender();
          return;
        }


        if (tool === 'lasso' && lasso) {
          const p = toCanvasXY(e);
          if (appendLassoStrokePoint(lasso, p)) requestRender();
          return;
        }

        if (tool === 'fx' && fx.mode === 'lassoFill' && lassoPaintStroke && lassoPaintStroke.pid === e.pointerId) {
          const p = toCanvasXY(e);
          if (appendLassoStrokePoint(lassoPaintStroke, p)) requestRender();
          return;
        }


        if ((tool === 'select' || tool === 'lasso') && sel) {
          const p = toCanvasXY(e);
          if (sel.state === 'marquee') { sel.w = p.x - sel.x; sel.h = p.y - sel.y; requestRender(); return; }
          if (sel.state === 'move') {
            if (!sel.hasCut && sel.img) ensureSelectionFloating();

            sel.x = p.x - sel.dragDX;
            sel.y = p.y - sel.dragDY;
            requestRender();
            return;
          }
          if (sel.state === 'transform') {
            if (selTransform.mode === 'scale') {
              updateScaleTransform(p);
            } else if (selTransform.mode === 'rotate') {
              updateRotateTransform(p);
            }
            return;
          }
        }

        if (!drawing) return;
        const rawEvents = (typeof e.getCoalescedEvents === 'function') ? e.getCoalescedEvents() : null;
        const samples = (rawEvents && rawEvents.length) ? rawEvents : [e];
        for (let i = 0; i < samples.length; i++) {
          const pe = samples[i];
          const p = toCanvasXYInto(pe, pointerScratch);

          cursorPos.x = p.x;
          cursorPos.y = p.y;
          cursorPos.visible = true;

          const press = (pe.pointerType === 'mouse') ? 1 : (pe.pressure !== undefined ? pe.pressure : 1);
          holdStrokePressure = press;

          if (stabilizer.mode === 'none') {
            lineB(lastX, lastY, p.x, p.y, press);
            lastX = p.x; lastY = p.y;
          } else if (stabilizer.mode === 'strong') {
            const k = 0.08;
            smoothX += (p.x - smoothX) * k;
            smoothY += (p.y - smoothY) * k;
            const sx = Math.round(smoothX), sy = Math.round(smoothY);
            lineB(lastX, lastY, sx, sy, press); lastX = sx; lastY = sy;
          } else {
            const k = 0.18;
            smoothX += (p.x - smoothX) * k;
            smoothY += (p.y - smoothY) * k;
            const sx = Math.round(smoothX), sy = Math.round(smoothY);
            lineB(lastX, lastY, sx, sy, press); lastX = sx; lastY = sy;
          }
        }
        requestRender();
      }

      function endStroke(e) {
        if (textState.dragging) textState.dragging = false;

        if (isTouchEvent(e)) {
          touchState.map.delete(e.pointerId);
          if (touchState.map.size < 2) { touchState.mode = null; }
        }

        if (stage.hasPointerCapture?.(e.pointerId)) stage.releasePointerCapture(e.pointerId);

        if (pickerSampling) {
          pickerSampling = false;
          setPickingEnabled(false);
          return;
        }

        if (e.button === 1 && panning) { panning = false; return; }
        if (e.button === 2 || e.pointerType === 'eraser' || e.button === 5 || (e.pointerType === 'pen' && (e.buttons & 32))) { tempTool = null; }


        if (importPreview && (importPreview.dragging || importPreview.resizing || importPreview.cropDragging)) {
          importPreview.dragging = false;
          importPreview.resizing = false;
          importPreview.resizeHandle = null;
          if (importPreview.cropDragging) {
            importPreview.cropDragging = false;
          }
          render();
          return;
        }


        if (tool === 'ditherFill' && ditherFillDrag.dragging && ditherFillDrag.pid === e.pointerId) {
          ditherFillDrag.dragging = false;
          ditherFillDrag.pid = null;
          const { x0, y0, x1, y1, erase } = ditherFillDrag;
          if (ditherFill.shapeFill) {

            const clickX = Math.floor(x0), clickY = Math.floor(y0);
            if (clickX >= 0 && clickX < W && clickY >= 0 && clickY < H) {
              applyDitherGradientInShape(x0, y0, x1, y1, clickX, clickY, ditherFill.mode, ditherFill.invert, erase);
            }
          } else {
            applyDitherGradient(x0, y0, x1, y1, ditherFill.mode, ditherFill.invert, erase);
          }
          return;
        }


        if (tool === 'smudge' && smudgeState.active && smudgeState.pid === e.pointerId) {
          smudgeState.active = false;
          smudgeState.pid = null;

          if (playing && playbackStrokeBeforeByFrame) {
            commitPlaybackStrokeHistory();
          } else if (smudgeState.before) {
            const fctx = frames[current].layers[activeLayer].ctx;
            const after = fctx.getImageData(0, 0, W, H);
            pushPaintPatch(current, 0, 0, W, H, smudgeState.before, after, activeLayer);
            updateThumb(current);
            refreshFilmTile(current);
          }
          clearPlaybackStrokeHistory();
          return;
        }

        if (tool === 'shape' && shapeState.dragging && shapeState.pid === e.pointerId) {
          shapeState.dragging = false; shapeState.pid = null;
          if (shapeState.bbox) {
            const bx = Math.max(0, Math.min(W - 1, Math.floor(shapeState.bbox.x)));
            const by = Math.max(0, Math.min(H - 1, Math.floor(shapeState.bbox.y)));
            const bw = Math.max(1, Math.min(W - bx, Math.ceil(shapeState.bbox.x2) - bx));
            const bh = Math.max(1, Math.min(H - by, Math.ceil(shapeState.bbox.y2) - by));
            const fctx = frames[current].layers[activeLayer].ctx;
            const before = fctx.getImageData(bx, by, bw, bh);

            if (shapeState.erase) {

              const { x0, y0, x1, y1, kind, fill } = shapeState;
              const s = Math.max(1, shapeState.size | 0);


              const work = makeCanvas(W, H), wctx = work.getContext('2d');
              wctx.imageSmoothingEnabled = false;

              const oldColor = brush.color;
              brush.color = '#ffffff';
              wctx.fillStyle = '#ffffff';
              wctx.strokeStyle = '#ffffff';


              if (kind === 'line') { lineToCtx(wctx, x0, y0, x1, y1, s); }
              else if (kind === 'rect') { fill ? rectFill(wctx, x0, y0, x1, y1) : rectOutline(wctx, x0, y0, x1, y1, s); }
              else if (kind === 'circle') { fill ? ellipseFill(wctx, x0, y0, x1, y1) : ellipseOutline(wctx, x0, y0, x1, y1, s); }
              else if (kind === 'tri') { const v = triVerticesFromBox(x0, y0, x1, y1); fill ? triFill(wctx, v) : triOutline(wctx, v, s); }


              if (mirror.h) {
                if (kind === 'line') { lineToCtx(wctx, W - 1 - x0, y0, W - 1 - x1, y1, s); }
                else if (kind === 'rect') { fill ? rectFill(wctx, W - 1 - x0, y0, W - 1 - x1, y1) : rectOutline(wctx, W - 1 - x0, y0, W - 1 - x1, y1, s); }
                else if (kind === 'circle') { fill ? ellipseFill(wctx, W - 1 - x0, y0, W - 1 - x1, y1) : ellipseOutline(wctx, W - 1 - x0, y0, W - 1 - x1, y1, s); }
                else if (kind === 'tri') { const v = triVerticesFromBox(W - 1 - x0, y0, W - 1 - x1, y1); fill ? triFill(wctx, v) : triOutline(wctx, v, s); }
              }
              if (mirror.v) {
                if (kind === 'line') { lineToCtx(wctx, x0, H - 1 - y0, x1, H - 1 - y1, s); }
                else if (kind === 'rect') { fill ? rectFill(wctx, x0, H - 1 - y0, x1, H - 1 - y1) : rectOutline(wctx, x0, H - 1 - y0, x1, H - 1 - y1, s); }
                else if (kind === 'circle') { fill ? ellipseFill(wctx, x0, H - 1 - y0, x1, H - 1 - y1) : ellipseOutline(wctx, x0, H - 1 - y0, x1, H - 1 - y1, s); }
                else if (kind === 'tri') { const v = triVerticesFromBox(x0, H - 1 - y0, x1, H - 1 - y1); fill ? triFill(wctx, v) : triOutline(wctx, v, s); }
              }
              if (mirror.h && mirror.v) {
                if (kind === 'line') { lineToCtx(wctx, W - 1 - x0, H - 1 - y0, W - 1 - x1, H - 1 - y1, s); }
                else if (kind === 'rect') { fill ? rectFill(wctx, W - 1 - x0, H - 1 - y0, W - 1 - x1, H - 1 - y1) : rectOutline(wctx, W - 1 - x0, H - 1 - y0, W - 1 - x1, H - 1 - y1, s); }
                else if (kind === 'circle') { fill ? ellipseFill(wctx, W - 1 - x0, H - 1 - y0, W - 1 - x1, H - 1 - y1) : ellipseOutline(wctx, W - 1 - x0, H - 1 - y0, W - 1 - x1, H - 1 - y1, s); }
                else if (kind === 'tri') { const v = triVerticesFromBox(W - 1 - x0, H - 1 - y0, W - 1 - x1, H - 1 - y1); fill ? triFill(wctx, v) : triOutline(wctx, v, s); }
              }


              brush.color = oldColor;


              if (shapeState.dither > 0) {
                applyDitherMaskToBBox(wctx, shapeState.bbox, shapeState.dither);
              }


              fctx.globalCompositeOperation = 'destination-out';
              fctx.drawImage(work, 0, 0);
              fctx.globalCompositeOperation = 'source-over';
            } else {

              const cut = shapePrevCtx.getImageData(bx, by, bw, bh);
              const work = document.createElement('canvas'); work.width = bw; work.height = bh;
              work.getContext('2d').putImageData(cut, 0, 0);
              fctx.drawImage(work, bx, by);
            }

            const after = fctx.getImageData(bx, by, bw, bh);
            pushPaintPatch(current, bx, by, bw, bh, before, after, activeLayer); updateThumb(current); refreshFilmTile(current);
          }
          shapePrevCtx.clearRect(0, 0, W, H);
          render();
          return;
        }

        if (tool === 'lasso' && sel && sel.state === 'move') {

          if (sel._moveStart) {
            const s = sel._moveStart;
            if (sel.x !== s.x || sel.y !== s.y) {
              if (!sel._id) sel._id = (++__selIdSeq);
              history.push({
                type: 'selMove',
                selId: sel._id,
                fromX: s.x,
                fromY: s.y,
                toX: sel.x,
                toY: sel.y,
                fi: current,
                layer: activeLayer
              });
              capHistory();
              redoStack.length = 0;
            }
            sel._moveStart = null;
          }
          sel.state = 'idle'; render(); return;
        }


        if ((tool === 'select' || tool === 'lasso') && sel && sel.state === 'transform') {
          endTransform();
          return;
        }


        if (tool === 'lasso' && lasso) {
          const pts = lasso.points;
          if (pts.length < 3) { lasso = null; render(); return; }

          const x0 = Math.max(0, Math.min(W - 1, Math.round(lasso.minX)));
          const y0 = Math.max(0, Math.min(H - 1, Math.round(lasso.minY)));
          const x1 = Math.max(0, Math.min(W - 1, Math.round(lasso.maxX)));
          const y1 = Math.max(0, Math.min(H - 1, Math.round(lasso.maxY)));
          const w = Math.max(1, x1 - x0 + 1), h = Math.max(1, y1 - y0 + 1);

          const polyRel = pts.map(p => ({ x: p.x - x0, y: p.y - y0 }));
          const mask = buildAliasedMaskCanvas(polyRel, w, h);

          const img = makeCanvas(w, h), ictx = img.getContext('2d'); ictx.imageSmoothingEnabled = false;
          const fctx = frames[current].layers[activeLayer].ctx;
          const before = fctx.getImageData(x0, y0, w, h);
          ictx.putImageData(before, 0, 0);
          ictx.globalCompositeOperation = 'destination-in';
          ictx.drawImage(mask, 0, 0);
          ictx.globalCompositeOperation = 'source-over';

          sel = { x: x0, y: y0, w: w, h: h, img: img, mask: mask, originX: x0, originY: y0, hasCut: false, state: 'idle', source: 'lasso', poly: polyRel, cutLayer: activeLayer, _frame: current, _moveStart: { x: x0, y: y0 }, _id: (++__selIdSeq) };

          lasso = null; render();
          return;
        }

        if (tool === 'fx' && fx.mode === 'lassoFill' && lassoPaintStroke && lassoPaintStroke.pid === e.pointerId) {
          const stroke = lassoPaintStroke;
          lassoPaintStroke = null;
          if (stroke.points.length < 3) { render(); return; }
          const changed = applyLassoPaintPolygon(stroke.points, !!stroke.erase);
          if (!changed) render();
          return;
        }


        if (tool === 'select' && sel) {
          if (sel.state === 'marquee') {
            normalizeSel(sel);
            sel.x = Math.round(sel.x); sel.y = Math.round(sel.y);
            sel.w = Math.round(sel.w); sel.h = Math.round(sel.h);

            if (sel.w < 1 || sel.h < 1 || (sel.w === 1 && sel.h === 1)) { sel = null; render(); return; }
            const data = frames[current].layers[activeLayer].ctx.getImageData(sel.x, sel.y, sel.w, sel.h);
            const img = makeCanvas(sel.w, sel.h); img.getContext('2d').putImageData(data, 0, 0);
            sel.img = img; sel.state = 'idle'; sel.poly = null; sel.cutLayer = activeLayer;
            sel.originX = sel.x; sel.originY = sel.y;
            sel._moveStart = { x: sel.x, y: sel.y };
            if (!sel._id) sel._id = (++__selIdSeq);

            render(); return;
          }
          if (sel.state === 'move') {

            if (sel._moveStart) {
              const s = sel._moveStart;
              if (sel.x !== s.x || sel.y !== s.y) {
                if (!sel._id) sel._id = (++__selIdSeq);
                history.push({
                  type: 'selMove',
                  selId: sel._id,
                  fromX: s.x,
                  fromY: s.y,
                  toX: sel.x,
                  toY: sel.y,
                  fi: current,
                  layer: activeLayer
                });
                capHistory();
                redoStack.length = 0;
              }
              sel._moveStart = null;
            }
            sel.state = 'idle'; render(); return;
          }
        }

        if (!drawing) { clearFXStrokeSession(); clearPlaybackStrokeHistory(); return; }
        drawing = false; haveSmooth = false;
        if (playing && playbackStrokeBeforeByFrame) {
          commitPlaybackStrokeHistory();
          if (!tempTool && e.button === 0) {
            if (tool === 'brush') {
              brushLineAnchor = { x: Math.round(lastX), y: Math.round(lastY), fi: current, layer: activeLayer };
            } else if (tool === 'eraser') {
              eraserLineAnchor = { x: Math.round(lastX), y: Math.round(lastY), fi: current, layer: activeLayer };
            }
          }
          clearFXStrokeSession();
          render();
          return;
        }
        if (strokeMinX === Infinity) { clearFXStrokeSession(); clearPlaybackStrokeHistory(); return; }

        let marginBase = Math.max(brush.size | 0, eraser.size | 0, 1);
        if (fxStroke.mode === 'fxTrail') marginBase = Math.max(1, fx.trail.size | 0);
        else if (fxStroke.mode === 'fxOutline') {
          const radius = Math.max(1, (fx.outline.thickness | 0) + (fx.outline.gap | 0));
          marginBase = Math.max(1, (radius * 2 + 1) | 0);
        }
        const margin = Math.ceil(marginBase / 2) + 2;

        const x0 = Math.max(0, Math.min(W - 1, Math.floor(strokeMinX - margin)));
        const y0 = Math.max(0, Math.min(H - 1, Math.floor(strokeMinY - margin)));
        const x1 = Math.max(0, Math.min(W - 1, Math.ceil(strokeMaxX + margin)));
        const y1 = Math.max(0, Math.min(H - 1, Math.ceil(strokeMaxY + margin)));
        const w = x1 - x0 + 1, h = y1 - y0 + 1;
        if (w <= 0 || h <= 0) { clearPlaybackStrokeHistory(); return; }
        const layerCtx = frames[current].layers[activeLayer].ctx;
        const before = preStrokeCtx.getImageData(x0, y0, w, h);
        const after = layerCtx.getImageData(x0, y0, w, h);
        pushPaintPatch(current, x0, y0, w, h, before, after, activeLayer); updateThumb(current); refreshFilmTile(current);
        if (!tempTool && e.button === 0) {
          if (tool === 'brush') {
            brushLineAnchor = { x: Math.round(lastX), y: Math.round(lastY), fi: current, layer: activeLayer };
          } else if (tool === 'eraser') {
            eraserLineAnchor = { x: Math.round(lastX), y: Math.round(lastY), fi: current, layer: activeLayer };
          }
        }
        clearPlaybackStrokeHistory();
        clearFXStrokeSession();
        render();
      }


      stage.addEventListener('pointerdown', beginStroke, { passive: false });
      stage.addEventListener('pointermove', moveStroke, { passive: false });
      window.addEventListener('pointerup', endStroke, { passive: false });
      stage.addEventListener('pointercancel', endStroke, { passive: false });
      stage.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); }, { passive: false });
      stage.addEventListener('contextmenu', e => e.preventDefault());


      stage.addEventListener('pointermove', e => {
        const curT = currentTool();
        if (!drawing && ((picking || pickerSampling) || curT === 'brush' || curT === 'eraser' || curT === 'smudge' || curT === 'fill' || curT === 'ditherFill' || curT === 'shape' || curT === 'text' || curT === 'lassoPaint' || curT === 'fxTrail' || curT === 'fxOutline' || curT === 'fxOutlineFlood' || curT === 'fxGlow')) {
          const p = toCanvasXYInto(e, pointerScratch);
          if (cursorPos.visible && cursorPos.x === p.x && cursorPos.y === p.y) return;
          cursorPos.x = p.x;
          cursorPos.y = p.y;
          cursorPos.visible = true;
          requestRender();
        }
      }, { passive: true });
      stage.addEventListener('pointerleave', () => {
        if (!cursorPos.visible) return;
        cursorPos.visible = false;
        requestRender();
      }, { passive: true });
      stage.addEventListener('pointerenter', e => {
        refreshStagePointerMetrics(true);
        const curT = currentTool();
        if ((picking || pickerSampling) || curT === 'brush' || curT === 'eraser' || curT === 'smudge' || curT === 'fill' || curT === 'ditherFill' || curT === 'shape' || curT === 'text' || curT === 'lassoPaint' || curT === 'fxTrail' || curT === 'fxOutline' || curT === 'fxOutlineFlood' || curT === 'fxGlow') {
          const p = toCanvasXYInto(e, pointerScratch);
          if (cursorPos.visible && cursorPos.x === p.x && cursorPos.y === p.y) return;
          cursorPos.x = p.x;
          cursorPos.y = p.y;
          cursorPos.visible = true;
          requestRender();
        }
      }, { passive: true });


      stage.addEventListener('wheel', (e) => {
        e.preventDefault(); autoCenter = false;
        const r = stageWrap.getBoundingClientRect();
        const sx = (e.clientX - r.left) * (stage.width / r.width), sy = (e.clientY - r.top) * (stage.height / r.height);
        const z = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        const ns = Math.max(view.minScale, Math.min(view.maxScale, view.scale * z));
        const wx = (sx - view.tx) / view.scale, wy = (sy - view.ty) / view.scale;
        view.scale = ns; view.tx = sx - wx * view.scale; view.ty = sy - wy * view.scale;
        updateZoomDisplay(); render();
      }, { passive: false });


      const zoomInBtn = document.getElementById('zoomInBtn');
      const zoomOutBtn = document.getElementById('zoomOutBtn');
      const resetViewBtn = document.getElementById('resetViewBtn');

      function zoomCentered(factor) {
        autoCenter = false;
        const cx = stage.width / 2, cy = stage.height / 2;
        const ns = Math.max(view.minScale, Math.min(view.maxScale, view.scale * factor));
        const wx = (cx - view.tx) / view.scale, wy = (cy - view.ty) / view.scale;
        view.scale = ns;
        view.tx = cx - wx * view.scale;
        view.ty = cy - wy * view.scale;
        updateZoomDisplay();
        render();
      }

      zoomInBtn.addEventListener('click', () => zoomCentered(1.25));
      zoomOutBtn.addEventListener('click', () => zoomCentered(1 / 1.25));

      resetViewBtn.addEventListener('click', () => {
        autoCenter = true;

        const padding = 40;
        const availW = stage.width - padding * 2;
        const availH = stage.height - padding * 2;
        const fitScale = Math.min(availW / W, availH / H);
        view.scale = Math.max(view.minScale, Math.min(view.maxScale, fitScale));
        centerView();
        updateZoomDisplay();
        render();
      });


      updateZoomDisplay();


      const mirrorHBtn = document.getElementById('mirrorHBtn');
      const mirrorVBtn = document.getElementById('mirrorVBtn');

      mirrorHBtn.addEventListener('click', () => {
        mirror.h = !mirror.h;
        mirrorHBtn.classList.toggle('active', mirror.h);
        if (mirror.h) commitSelectionIfAny();
        updateMirrorToolState();
        render();
      });

      mirrorVBtn.addEventListener('click', () => {
        mirror.v = !mirror.v;
        mirrorVBtn.classList.toggle('active', mirror.v);
        if (mirror.v) commitSelectionIfAny();
        updateMirrorToolState();
        render();
      });

      function updateMirrorToolState() {
        const mirrorActive = mirror.h || mirror.v;

        if (mirrorActive && tool !== 'brush' && tool !== 'eraser' && tool !== 'shape') {
          tool = 'brush';
          updateToolUI();
        }

        [fillTool, ditherFillTool, selectTool, lassoTool, textTool, smudgeTool, fxTool].forEach(e => {
          if (e) e.classList.toggle('mirror-disabled', mirrorActive);
        });
      }

      function updateToolUI() {
        const t = tool;
        [brushTool, eraserTool, fillTool, ditherFillTool, selectTool, lassoTool, shapeTool, textTool, smudgeTool, fxTool].forEach(e => e && e.classList.remove('active'));
        if (t === 'brush') brushTool.classList.add('active');
        if (t === 'eraser') eraserTool.classList.add('active');
        if (t === 'fill') fillTool.classList.add('active');
        if (t === 'ditherFill') ditherFillTool.classList.add('active');
        if (t === 'select') selectTool.classList.add('active');
        if (t === 'lasso') lassoTool.classList.add('active');
        if (t === 'shape') shapeTool.classList.add('active');
        if (t === 'text') textTool.classList.add('active');
        if (t === 'smudge') smudgeTool.classList.add('active');
        if (t === 'fx') fxTool.classList.add('active');

        document.body.classList.remove('tool-brush', 'tool-eraser', 'tool-fill', 'tool-ditherFill', 'tool-shape', 'tool-text', 'tool-smudge', 'tool-fx');
        if (t === 'brush') document.body.classList.add('tool-brush');
        if (t === 'eraser') document.body.classList.add('tool-eraser');
        if (t === 'fill') document.body.classList.add('tool-fill');
        if (t === 'ditherFill') document.body.classList.add('tool-ditherFill');
        if (t === 'shape') document.body.classList.add('tool-shape');
        if (t === 'text') document.body.classList.add('tool-text');
        if (t === 'smudge') document.body.classList.add('tool-smudge');
        if (t === 'fx') document.body.classList.add('tool-fx');

        if (brushSettings) brushSettings.style.display = (t === 'brush') ? '' : 'none';
        if (eraserSettings) eraserSettings.style.display = (t === 'eraser') ? '' : 'none';
        if (fillSettings) fillSettings.style.display = (t === 'fill') ? '' : 'none';
        if (ditherFillSettings) ditherFillSettings.style.display = (t === 'ditherFill') ? '' : 'none';
        if (smudgeSettings) smudgeSettings.style.display = (t === 'smudge') ? '' : 'none';

        const shapeSettings = document.getElementById('shapeSettings');
        if (shapeSettings) shapeSettings.style.display = (t === 'shape') ? '' : 'none';
        const textSettings = document.getElementById('textSettings');
        if (textSettings) textSettings.style.display = (t === 'text') ? '' : 'none';

        const selSettings = document.getElementById('selSettings');
        if (selSettings) selSettings.style.display = (t === 'select' || t === 'lasso') ? '' : 'none';

        if (shapePanel) shapePanel.style.display = (t === 'shape') ? 'flex' : 'none';
        if (textPanel) textPanel.style.display = (t === 'text') ? 'flex' : 'none';
        updateFXPanelVisibility();
      }


      function doSmudgeStroke(x, y) {
        if (!smudgeState.lastX) {
          smudgeState.lastX = x;
          smudgeState.lastY = y;
          smudgeState.distAcc = 0; // Accumulate distance for decay effects
          return;
        }

        const layer = frames[current].layers[activeLayer];
        const ctx = layer.ctx;
        const W = layer.can.width;
        const H = layer.can.height;
        if (playing && playbackStrokeBeforeByFrame) recordPlaybackFrameBefore(current);
        const dist = Math.hypot(x - smudgeState.lastX, y - smudgeState.lastY);
        const steps = Math.ceil(dist);
        const size = smudge.size;
        const half = Math.floor(size / 2);

        // Liquid/Drag Buffer Init
        if (smudge.mode === 'L' && !smudgeState.accBuffer) {
          const bx = Math.round(smudgeState.lastX) - half;
          const by = Math.round(smudgeState.lastY) - half;
          smudgeState.accBuffer = ctx.getImageData(bx, by, size, size);
        }

        // Bayer Matrix for Dither
        const BAYER4 = [
          [0, 8, 2, 10],
          [12, 4, 14, 6],
          [3, 11, 1, 9],
          [15, 7, 13, 5]
        ];

        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const cx = Math.round(smudgeState.lastX + (x - smudgeState.lastX) * t);
          const cy = Math.round(smudgeState.lastY + (y - smudgeState.lastY) * t);

          const prevCX = Math.round(smudgeState.lastX + (x - smudgeState.lastX) * ((i - 1) / steps));
          const prevCY = Math.round(smudgeState.lastY + (y - smudgeState.lastY) * ((i - 1) / steps));

          // Force update for Block mode to snap to grid potentially, but here we just need to ensure smooth stroking unless in block mode
          if (smudge.mode !== 'B' && cx === prevCX && cy === prevCY) continue;

          let srcX = prevCX - half;
          let srcY = prevCY - half;
          let dstX = cx - half;
          let dstY = cy - half;
          const stepDirX = cx === prevCX ? 0 : (cx > prevCX ? 1 : -1);
          const stepDirY = cy === prevCY ? 0 : (cy > prevCY ? 1 : -1);

          // Block Mode
          if (smudge.mode === 'B') {
            const stepSize = Math.max(2, Math.floor(size / 2));
            dstX = Math.floor(cx / stepSize) * stepSize - half + (half % stepSize);
            dstY = Math.floor(cy / stepSize) * stepSize - half + (half % stepSize);
            if (dstX === smudgeState.lastSnapX && dstY === smudgeState.lastSnapY) continue;
            smudgeState.lastSnapX = dstX;
            smudgeState.lastSnapY = dstY;
            srcX = prevCX - half;
            srcY = prevCY - half;
          }

          if (srcX < 0 || srcY < 0 || srcX + size > W || srcY + size > H) continue;


          // Fetch Source
          let sourceData;
          if (smudge.mode === 'L') {
            sourceData = smudgeState.accBuffer;
          } else {
            sourceData = ctx.getImageData(srcX, srcY, size, size);
          }

          // Fetch Dest
          const destData = ctx.getImageData(dstX, dstY, size, size);
          const s = sourceData.data;
          const d = destData.data;
          let modified = false;

          for (let py = 0; py < size; py++) {
            for (let px = 0; px < size; px++) {
              const cdx = px - size / 2 + 0.5;
              const cdy = py - size / 2 + 0.5;
              if (cdx * cdx + cdy * cdy > (size / 2) * (size / 2)) continue;

              const idx = (py * size + px) * 4;

              // Allow dragging transparency (smudging "air") in all modes now for better mixing
              // formerly: if (s[idx + 3] === 0 && smudge.mode !== 'L') continue; 

              let doCopy = false;
              let copyIdx = idx;
              let str = smudge.strength / 100;

              if (smudge.mode === 'B') {
                doCopy = true;
              } else if (smudge.mode === 'D') {
                // Dither smear uses a direction-aware Bayer mask for stable pixel dragging.
                const distNorm = Math.min(1, Math.hypot(cdx, cdy) / Math.max(1, size * 0.5));
                const centerBoost = 1 - distNorm;
                const shiftX = (stepDirX !== 0 ? i : 0) + (stepDirY < 0 ? 1 : 0);
                const shiftY = (stepDirY !== 0 ? i : 0) + (stepDirX > 0 ? 2 : 0);
                const bx = (dstX + px + shiftX) & 3;
                const by = (dstY + py + shiftY) & 3;
                const limit = Math.max(1, Math.min(15, Math.round(str * 12 + centerBoost * 2 + 1)));
                if (BAYER4[by][bx] < limit) {
                  const sampleX = Math.max(0, Math.min(size - 1, px - stepDirX));
                  const sampleY = Math.max(0, Math.min(size - 1, py - stepDirY));
                  copyIdx = (sampleY * size + sampleX) * 4;
                  doCopy = true;
                }
              } else if (smudge.mode === 'G') {
                // Glitch Lines: Horizontal streaks using row-based offsets
                const rowId = Math.floor(py + dstY);
                const shift = Math.floor(Math.sin(rowId * 1.7) * 12 * str);
                const sPx = ((px + shift) % size + size) % size;
                const sIdx = (py * size + sPx) * 4;
                if (Math.random() < str * 0.85) {
                  d[idx] = s[sIdx];
                  d[idx + 1] = s[sIdx + 1];
                  d[idx + 2] = s[sIdx + 2];
                  d[idx + 3] = s[sIdx + 3];
                  modified = true;
                }
              } else if (smudge.mode === 'N') {
                // Normal Smudge: Random pixel mixing
                if (Math.random() < str) doCopy = true;
              }

              if (doCopy) {
                d[idx] = s[copyIdx];
                d[idx + 1] = s[copyIdx + 1];
                d[idx + 2] = s[copyIdx + 2];
                d[idx + 3] = s[copyIdx + 3];
                modified = true;
              } else if (smudge.mode === 'L') {
                // Liquid Buffer update: sticky
                s[idx] = d[idx];
                s[idx + 1] = d[idx + 1];
                s[idx + 2] = d[idx + 2];
                s[idx + 3] = d[idx + 3];
              }
            }
          }

          if (modified) {
            ctx.putImageData(destData, dstX, dstY);
          }
        }

        smudgeState.lastX = x;
        smudgeState.lastY = y;
        smudgeState.distAcc = (smudgeState.distAcc || 0) + dist;
      }

      function colorsEqual(d, i, r, g, b, a) { return d[i] === r && d[i + 1] === g && d[i + 2] === b && d[i + 3] === a; }
      function hexToRGBA(hex) { const v = hex.replace('#', ''); return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16), 255]; }
      function doFill(x, y, mode) {
        if (x < 0 || x >= W || y < 0 || y >= H) return;
        const fctx = frames[current].layers[activeLayer].ctx;
        const id = fctx.getImageData(0, 0, W, H), data = id.data;
        const idx = (y * W + x) * 4, r0 = data[idx], g0 = data[idx + 1], b0 = data[idx + 2], a0 = data[idx + 3];
        if (mode === 'erase' && a0 === 0) return;
        if (mode === 'paint' && r0 === parseInt(brush.color.slice(1, 3), 16) && g0 === parseInt(brush.color.slice(3, 5), 16) && b0 === parseInt(brush.color.slice(5, 7), 16) && a0 === 255) return;
        const [nr, ng, nb, na] = mode === 'erase' ? [0, 0, 0, 0] : hexToRGBA(brush.color);
        const stack = [[x, y]], seen = new Uint8Array(W * H);
        let minX = W, minY = H, maxX = 0, maxY = 0; const lim = ditherLimit(fillDither);
        while (stack.length) {
          const [cx, cy] = stack.pop(), idx = cy * W + cx; if (seen[idx]) continue; seen[idx] = 1;
          const di = idx * 4; if (!colorsEqual(data, di, r0, g0, b0, a0)) continue;
          if (lim === null || BAYER4[cy & 3][cx & 3] < lim) { data[di] = nr; data[di + 1] = ng; data[di + 2] = nb; data[di + 3] = na; }
          if (cx < minX) minX = cx; if (cx > maxX) maxX = cx; if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
          if (cx > 0) stack.push([cx - 1, cy]); if (cx < W - 1) stack.push([cx + 1, cy]); if (cy > 0) stack.push([cx, cy - 1]); if (cy < H - 1) stack.push([cx, cy + 1]);
        }
        const x0 = Math.max(0, minX), y0 = Math.max(0, minY), w = maxX - x0 + 1, h = maxY - y0 + 1;
        const before = fctx.getImageData(x0, y0, w, h); fctx.putImageData(id, 0, 0); const after = fctx.getImageData(x0, y0, w, h);
        pushPaintPatch(current, x0, y0, w, h, before, after, activeLayer); updateThumb(current); refreshFilmTile(current); render();
      }


      function applyDitherGradient(x0, y0, x1, y1, mode, invert, erase) {
        const fctx = frames[current].layers[activeLayer].ctx;
        const before = fctx.getImageData(0, 0, W, H);


        const [nr, ng, nb] = hexToRGBA(brush.color);


        const dx = x1 - x0, dy = y1 - y0;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 2) return;


        const dirX = dx / dist, dirY = dy / dist;

        const angle0 = Math.atan2(dy, dx);


        const falloffPower = ditherFill.falloff / 5;


        const id = fctx.getImageData(0, 0, W, H);
        const data = id.data;


        const noiseSeed = (x0 * 31 + y0 * 17) % 65536;

        for (let py = 0; py < H; py++) {
          for (let px = 0; px < W; px++) {
            let t;

            if (mode === 'radial') {

              const rdx = px - x0, rdy = py - y0;
              const r = Math.sqrt(rdx * rdx + rdy * rdy);
              t = Math.min(1, r / dist);
            } else if (mode === 'angular') {

              const rdx = px - x0, rdy = py - y0;
              let angle = Math.atan2(rdy, rdx) - angle0;
              if (angle < 0) angle += Math.PI * 2;
              t = angle / (Math.PI * 2);
            } else if (mode === 'diamond') {

              const rdx = Math.abs(px - x0), rdy = Math.abs(py - y0);
              t = Math.min(1, (rdx + rdy) / dist);
            } else if (mode === 'square') {

              const rdx = Math.abs(px - x0), rdy = Math.abs(py - y0);
              t = Math.min(1, Math.max(rdx, rdy) / dist);
            } else if (mode === 'noise') {

              const pdx = px - x0, pdy = py - y0;
              const proj = (pdx * dirX + pdy * dirY);
              const baseT = Math.max(0, Math.min(1, proj / dist));

              const hash = ((px * 1597 + py * 51749 + noiseSeed) % 65536) / 65536;
              const noiseAmt = 0.3;
              t = Math.max(0, Math.min(1, baseT + (hash - 0.5) * noiseAmt));
            } else {

              const pdx = px - x0, pdy = py - y0;
              const proj = (pdx * dirX + pdy * dirY);
              t = Math.max(0, Math.min(1, proj / dist));
            }


            t = Math.pow(t, falloffPower);


            if (invert) t = 1 - t;



            const threshold = Math.floor(t * 16);


            const bayerVal = BAYER4[py & 3][px & 3];
            const shouldDraw = bayerVal >= threshold;

            if (shouldDraw) {
              const i = (py * W + px) * 4;
              if (erase) {
                data[i + 3] = 0;
              } else {
                data[i] = nr;
                data[i + 1] = ng;
                data[i + 2] = nb;
                data[i + 3] = 255;
              }
            }
          }
        }

        fctx.putImageData(id, 0, 0);
        const after = fctx.getImageData(0, 0, W, H);
        pushPaintPatch(current, 0, 0, W, H, before, after, activeLayer);
        updateThumb(current); refreshFilmTile(current); render();
      }


      function applyDitherGradientInShape(x0, y0, x1, y1, clickX, clickY, mode, invert, erase) {
        const fctx = frames[current].layers[activeLayer].ctx;
        const id = fctx.getImageData(0, 0, W, H);
        const data = id.data;


        const clickIdx = (clickY * W + clickX) * 4;
        const r0 = data[clickIdx], g0 = data[clickIdx + 1], b0 = data[clickIdx + 2], a0 = data[clickIdx + 3];


        const shapeMask = new Uint8Array(W * H);
        const stack = [[clickX, clickY]];
        const seen = new Uint8Array(W * H);

        while (stack.length) {
          const [cx, cy] = stack.pop();
          const idx = cy * W + cx;
          if (seen[idx]) continue;
          seen[idx] = 1;

          const di = idx * 4;
          if (!colorsEqual(data, di, r0, g0, b0, a0)) continue;

          shapeMask[idx] = 1;

          if (cx > 0) stack.push([cx - 1, cy]);
          if (cx < W - 1) stack.push([cx + 1, cy]);
          if (cy > 0) stack.push([cx, cy - 1]);
          if (cy < H - 1) stack.push([cx, cy + 1]);
        }

        const before = fctx.getImageData(0, 0, W, H);


        const [nr, ng, nb] = hexToRGBA(brush.color);


        const dx = x1 - x0, dy = y1 - y0;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 2) return;

        const dirX = dx / dist, dirY = dy / dist;
        const angle0 = Math.atan2(dy, dx);
        const falloffPower = ditherFill.falloff / 5;
        const noiseSeed = (x0 * 31 + y0 * 17) % 65536;


        for (let py = 0; py < H; py++) {
          for (let px = 0; px < W; px++) {
            const idx = py * W + px;
            if (!shapeMask[idx]) continue;

            let t;
            if (mode === 'radial') {
              const rdx = px - x0, rdy = py - y0;
              t = Math.min(1, Math.sqrt(rdx * rdx + rdy * rdy) / dist);
            } else if (mode === 'angular') {
              const rdx = px - x0, rdy = py - y0;
              let angle = Math.atan2(rdy, rdx) - angle0;
              if (angle < 0) angle += Math.PI * 2;
              t = angle / (Math.PI * 2);
            } else if (mode === 'diamond') {
              const rdx = Math.abs(px - x0), rdy = Math.abs(py - y0);
              t = Math.min(1, (rdx + rdy) / dist);
            } else if (mode === 'square') {
              const rdx = Math.abs(px - x0), rdy = Math.abs(py - y0);
              t = Math.min(1, Math.max(rdx, rdy) / dist);
            } else if (mode === 'noise') {
              const pdx = px - x0, pdy = py - y0;
              const baseT = Math.max(0, Math.min(1, (pdx * dirX + pdy * dirY) / dist));
              const hash = ((px * 1597 + py * 51749 + noiseSeed) % 65536) / 65536;
              t = Math.max(0, Math.min(1, baseT + (hash - 0.5) * 0.3));
            } else {
              const pdx = px - x0, pdy = py - y0;
              t = Math.max(0, Math.min(1, (pdx * dirX + pdy * dirY) / dist));
            }

            t = Math.pow(t, falloffPower);
            if (invert) t = 1 - t;

            const threshold = Math.floor(t * 16);
            const bayerVal = BAYER4[py & 3][px & 3];

            if (bayerVal >= threshold) {
              const i = idx * 4;
              if (erase) {
                data[i + 3] = 0;
              } else {
                data[i] = nr;
                data[i + 1] = ng;
                data[i + 2] = nb;
                data[i + 3] = 255;
              }
            }
          }
        }

        fctx.putImageData(id, 0, 0);
        const after = fctx.getImageData(0, 0, W, H);
        pushPaintPatch(current, 0, 0, W, H, before, after, activeLayer);
        updateThumb(current); refreshFilmTile(current); render();
      }


      function drawDitherFillPreview() {
        if (!ditherFillDrag.dragging) return;
        const { x0, y0, x1, y1 } = ditherFillDrag;


        ctx.save();
        ctx.setTransform(view.scale, 0, 0, view.scale, view.tx, view.ty);


        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 2 / view.scale;
        ctx.setLineDash([4 / view.scale, 4 / view.scale]);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.lineDashOffset = 4 / view.scale;
        ctx.stroke();


        ctx.beginPath();
        ctx.arc(x0, y0, 5 / view.scale, 0, Math.PI * 2);
        ctx.fillStyle = brush.color;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2 / view.scale;
        ctx.setLineDash([]);
        ctx.fill();
        ctx.stroke();


        ctx.beginPath();
        ctx.arc(x1, y1, 5 / view.scale, 0, Math.PI * 2);
        ctx.fillStyle = ditherFill.invert ? brush.color : 'rgba(255,255,255,0.3)';
        ctx.strokeStyle = '#000';
        ctx.fill();
        ctx.stroke();


        if (ditherFill.mode === 'radial') {
          const dist = Math.hypot(x1 - x0, y1 - y0);
          ctx.beginPath();
          ctx.arc(x0, y0, dist, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(100, 150, 255, 0.5)';
          ctx.lineWidth = 1 / view.scale;
          ctx.setLineDash([6 / view.scale, 6 / view.scale]);
          ctx.stroke();
        }

        ctx.restore();
      }



      function normalizeSel(s) {
        if (!s) return;
        if (s.w < 0) { s.x += s.w; s.w *= -1; }
        if (s.h < 0) { s.y += s.h; s.h *= -1; }
        s.w = Math.max(1, s.w); s.h = Math.max(1, s.h);


      }
      function getSolidMask(src) {
        if (!src) return src;
        const c = makeCanvas(src.width, src.height);
        const ctx = c.getContext('2d');
        ctx.drawImage(src, 0, 0);
        ctx.globalCompositeOperation = 'source-in';
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        return c;
      }



      function ensureSelectionFloating() {
        if (!sel || !sel.img) return;
        if (sel.detached === true || sel.source === 'paste') return;
        if (sel.hasCut) return;

        const layerIdx = sel.cutLayer !== undefined ? sel.cutLayer : activeLayer;
        const fctx = frames[current].layers[layerIdx].ctx;
        normalizeSel(sel);




        let cutX, cutY, cutW, cutH, cutImg, cutMask;
        if (sel.untrimmedBounds) {
          cutX = sel.untrimmedBounds.x;
          cutY = sel.untrimmedBounds.y;
          cutW = sel.untrimmedBounds.w;
          cutH = sel.untrimmedBounds.h;
          cutImg = sel.untrimmedImg;
          cutMask = sel.untrimmedMask;
        } else {

          cutX = sel.x;
          cutY = sel.y;
          cutW = sel.w;
          cutH = sel.h;
          cutImg = sel.img;
          cutMask = sel.mask;
        }

        const cutRect = { x: cutX, y: cutY, w: cutW, h: cutH };
        const cutBefore = fctx.getImageData(cutRect.x, cutRect.y, cutRect.w, cutRect.h);


        fctx.save();
        fctx.imageSmoothingEnabled = false;
        if (cutMask) {

          fctx.globalCompositeOperation = 'destination-out';
          const solidMask = getSolidMask(cutMask);
          fctx.drawImage(solidMask, cutX, cutY);
        } else if (sel.poly) {

          fctx.globalCompositeOperation = 'destination-out';
          const solidMask = getSolidMask(cutImg);
          fctx.drawImage(solidMask, cutX, cutY);
        } else {

          fctx.clearRect(cutX, cutY, cutW, cutH);
        }
        fctx.restore();


        sel.hasCut = true;
        sel.originX = sel.x;
        sel.originY = sel.y;
        sel.cutRect = cutRect;
        sel.cutBefore = cutBefore;

        sel.cutImg = cutImg;
        sel.cutMask = cutMask;
        sel.cutLayer = layerIdx;
      }



      function snapshotSelectionObject(s) {
        if (!s || !s.img) return null;

        if (!s._id) s._id = (++__selIdSeq);
        return {
          x: s.x, y: s.y, w: s.w, h: s.h,
          originX: s.originX, originY: s.originY,
          hasCut: !!s.hasCut,
          detached: !!s.detached,
          source: s.source || null,
          poly: s.poly ? s.poly.map(p => ({ x: p.x, y: p.y })) : null,
          img: cloneCanvas(s.img),
          mask: s.mask ? cloneCanvas(s.mask) : null,
          cutRect: s.cutRect ? { x: s.cutRect.x, y: s.cutRect.y, w: s.cutRect.w, h: s.cutRect.h } : null,
          cutBefore: s.cutBefore ? new ImageData(new Uint8ClampedArray(s.cutBefore.data), s.cutBefore.width, s.cutBefore.height) : null,

          untrimmedImg: s.untrimmedImg ? cloneCanvas(s.untrimmedImg) : null,
          untrimmedMask: s.untrimmedMask ? cloneCanvas(s.untrimmedMask) : null,
          untrimmedBounds: s.untrimmedBounds ? { x: s.untrimmedBounds.x, y: s.untrimmedBounds.y, w: s.untrimmedBounds.w, h: s.untrimmedBounds.h } : null,
          cutImg: s.cutImg ? cloneCanvas(s.cutImg) : null,
          cutMask: s.cutMask ? cloneCanvas(s.cutMask) : null,
          cutLayer: s.cutLayer,
          _id: s._id,
          _frame: s._frame !== undefined ? s._frame : current,

          _originalX: s._originalX,
          _originalY: s._originalY
        };
      }
      function restoreSelectionFromSnapshot(snap) {
        if (!snap) return;
        sel = {
          x: snap.x, y: snap.y, w: snap.w, h: snap.h,
          originX: snap.originX, originY: snap.originY,
          hasCut: snap.hasCut,
          detached: snap.detached,
          source: snap.source,
          poly: snap.poly ? snap.poly.map(p => ({ x: p.x, y: p.y })) : null,
          img: cloneCanvas(snap.img),
          mask: snap.mask ? cloneCanvas(snap.mask) : null,
          cutRect: snap.cutRect ? { x: snap.cutRect.x, y: snap.cutRect.y, w: snap.cutRect.w, h: snap.cutRect.h } : null,
          cutBefore: snap.cutBefore ? new ImageData(new Uint8ClampedArray(snap.cutBefore.data), snap.cutBefore.width, snap.cutBefore.height) : null,

          untrimmedImg: snap.untrimmedImg ? cloneCanvas(snap.untrimmedImg) : null,
          untrimmedMask: snap.untrimmedMask ? cloneCanvas(snap.untrimmedMask) : null,
          untrimmedBounds: snap.untrimmedBounds ? { x: snap.untrimmedBounds.x, y: snap.untrimmedBounds.y, w: snap.untrimmedBounds.w, h: snap.untrimmedBounds.h } : null,
          cutImg: snap.cutImg ? cloneCanvas(snap.cutImg) : null,
          cutMask: snap.cutMask ? cloneCanvas(snap.cutMask) : null,
          cutLayer: snap.cutLayer,
          state: 'idle',
          _id: snap._id,
          _frame: snap._frame,
          _moveStart: { x: snap.x, y: snap.y }
        };
        render();
      }


      function pushSelTransform(beforeSnap, afterSnap, kind) {
        if (!beforeSnap || !afterSnap) return;
        history.push({ type: 'selTransform', selId: beforeSnap._id, kind, before: beforeSnap, after: afterSnap });
        capHistory?.();
        redoStack.length = 0;
      }


      function rotateSelCW() {
        if (!sel || !sel.img) return;
        ensureSelectionFloating();

        if (!sel._id) sel._id = (++__selIdSeq);
        const beforeSnap = snapshotSelectionObject(sel);

        const src = sel.img;
        const ow = sel.w, oh = sel.h;
        const dst = makeCanvas(oh, ow);
        const dctx = dst.getContext('2d'); dctx.imageSmoothingEnabled = false;
        dctx.translate(oh, 0); dctx.rotate(Math.PI / 2);
        dctx.drawImage(src, 0, 0);
        sel.img = dst;

        if (sel.mask) {
          const m = makeCanvas(oh, ow), mctx = m.getContext('2d'); mctx.imageSmoothingEnabled = false;
          mctx.translate(oh, 0); mctx.rotate(Math.PI / 2); mctx.drawImage(sel.mask, 0, 0);
          sel.mask = m;
        }
        if (sel.poly && sel.poly.length) {
          sel.poly = sel.poly.map(p => ({ x: (oh - 1 - p.y), y: p.x }));
        }
        sel.w = oh; sel.h = ow;
        if (sel.x + sel.w > W) sel.x = Math.max(0, W - sel.w);
        if (sel.y + sel.h > H) sel.y = Math.max(0, H - sel.h);


        trimSelection(sel);

        const afterSnap = snapshotSelectionObject(sel);
        pushSelTransform(beforeSnap, afterSnap, 'rotateCW');

        render();
      }


      function flipSelH() {
        if (!sel || !sel.img) return;
        ensureSelectionFloating();

        if (!sel._id) sel._id = (++__selIdSeq);
        const beforeSnap = snapshotSelectionObject(sel);

        const src = sel.img;
        const dst = makeCanvas(sel.w, sel.h);
        const dctx = dst.getContext('2d'); dctx.imageSmoothingEnabled = false;
        dctx.translate(sel.w, 0); dctx.scale(-1, 1);
        dctx.drawImage(src, 0, 0);
        sel.img = dst;

        if (sel.mask) {
          const m = makeCanvas(sel.w, sel.h), mctx = m.getContext('2d'); mctx.imageSmoothingEnabled = false;
          mctx.translate(sel.w, 0); mctx.scale(-1, 1); mctx.drawImage(sel.mask, 0, 0);
          sel.mask = m;
        }
        if (sel.poly && sel.poly.length) {
          sel.poly = sel.poly.map(p => ({ x: (sel.w - 1 - p.x), y: p.y }));
        }

        const afterSnap = snapshotSelectionObject(sel);
        pushSelTransform(beforeSnap, afterSnap, 'flipH');

        render();
      }


      function flipSelV() {
        if (!sel || !sel.img) return;
        ensureSelectionFloating();

        if (!sel._id) sel._id = (++__selIdSeq);
        const beforeSnap = snapshotSelectionObject(sel);

        const src = sel.img;
        const dst = makeCanvas(sel.w, sel.h);
        const dctx = dst.getContext('2d'); dctx.imageSmoothingEnabled = false;
        dctx.translate(0, sel.h); dctx.scale(1, -1);
        dctx.drawImage(src, 0, 0);
        sel.img = dst;

        if (sel.mask) {
          const m = makeCanvas(sel.w, sel.h), mctx = m.getContext('2d'); mctx.imageSmoothingEnabled = false;
          mctx.translate(0, sel.h); mctx.scale(1, -1); mctx.drawImage(sel.mask, 0, 0);
          sel.mask = m;
        }
        if (sel.poly && sel.poly.length) {
          sel.poly = sel.poly.map(p => ({ x: p.x, y: (sel.h - 1 - p.y) }));
        }

        const afterSnap = snapshotSelectionObject(sel);
        pushSelTransform(beforeSnap, afterSnap, 'flipV');

        render();
      }



      function startScaleTransform(e, p, handle) {
        if (!sel || !sel.img) return;
        ensureSelectionFloating();

        if (!sel._id) sel._id = (++__selIdSeq);
        selTransform.beforeSnap = snapshotSelectionObject(sel);

        selTransform.mode = 'scale';
        selTransform.handle = handle;
        selTransform.startX = p.x;
        selTransform.startY = p.y;
        selTransform.startW = sel.w;
        selTransform.startH = sel.h;
        selTransform.startSelX = sel.x;
        selTransform.startSelY = sel.y;
        selTransform.originalImg = cloneCanvas(sel.img);
        if (sel.mask) selTransform.originalMask = cloneCanvas(sel.mask);

        sel.state = 'transform';
        sel.pid = e.pointerId;
        stage.setPointerCapture(e.pointerId);
        render();
      }

      function startRotateTransform(e, p) {
        if (!sel || !sel.img) return;
        ensureSelectionFloating();

        if (!sel._id) sel._id = (++__selIdSeq);
        selTransform.beforeSnap = snapshotSelectionObject(sel);

        selTransform.mode = 'rotate';
        selTransform.handle = 'rot';


        const cx = sel.x + sel.w / 2;
        const cy = sel.y + sel.h / 2;
        selTransform.startCX = cx;
        selTransform.startCY = cy;

        selTransform.startAngle = Math.atan2(p.y - cy, p.x - cx) * 180 / Math.PI + 90;
        selTransform.rotation = 0;
        selTransform.originalImg = cloneCanvas(sel.img);
        if (sel.mask) selTransform.originalMask = cloneCanvas(sel.mask);
        selTransform.startW = sel.w;
        selTransform.startH = sel.h;
        selTransform.startSelX = sel.x;
        selTransform.startSelY = sel.y;

        sel.state = 'transform';
        sel.pid = e.pointerId;
        stage.setPointerCapture(e.pointerId);
        render();
      }

      function updateScaleTransform(p) {
        if (!sel || selTransform.mode !== 'scale') return;

        const dx = p.x - selTransform.startX;
        const dy = p.y - selTransform.startY;

        let newW = selTransform.startW;
        let newH = selTransform.startH;
        let newX = selTransform.startSelX;
        let newY = selTransform.startSelY;

        const handle = selTransform.handle;


        if (handle === 'se') {
          newW = Math.round(selTransform.startW + dx);
          newH = Math.round(selTransform.startH + dy);
        } else if (handle === 'sw') {
          newW = Math.round(selTransform.startW - dx);
          newH = Math.round(selTransform.startH + dy);
          newX = selTransform.startSelX + selTransform.startW - newW;
        } else if (handle === 'ne') {
          newW = Math.round(selTransform.startW + dx);
          newH = Math.round(selTransform.startH - dy);
          newY = selTransform.startSelY + selTransform.startH - newH;
        } else if (handle === 'nw') {
          newW = Math.round(selTransform.startW - dx);
          newH = Math.round(selTransform.startH - dy);
          newX = selTransform.startSelX + selTransform.startW - newW;
          newY = selTransform.startSelY + selTransform.startH - newH;
        }


        let flipX = newW < 0;
        let flipY = newH < 0;
        const absW = Math.max(1, Math.abs(newW));
        const absH = Math.max(1, Math.abs(newH));


        if (flipX) newX = newX + newW;
        if (flipY) newY = newY + newH;


        const srcW = selTransform.startW;
        const srcH = selTransform.startH;
        const srcCtx = selTransform.originalImg.getContext('2d');
        const srcData = srcCtx.getImageData(0, 0, srcW, srcH);
        const src = srcData.data;

        const dst = makeCanvas(absW, absH);
        const dstCtx = dst.getContext('2d');
        const dstData = dstCtx.createImageData(absW, absH);
        const dstPx = dstData.data;


        for (let y = 0; y < absH; y++) {
          const srcY = Math.floor((flipY ? (absH - 1 - y) : y) * srcH / absH);
          for (let x = 0; x < absW; x++) {
            const srcX = Math.floor((flipX ? (absW - 1 - x) : x) * srcW / absW);
            const srcIdx = (srcY * srcW + srcX) * 4;
            const dstIdx = (y * absW + x) * 4;
            dstPx[dstIdx] = src[srcIdx];
            dstPx[dstIdx + 1] = src[srcIdx + 1];
            dstPx[dstIdx + 2] = src[srcIdx + 2];
            dstPx[dstIdx + 3] = src[srcIdx + 3];
          }
        }
        dstCtx.putImageData(dstData, 0, 0);
        sel.img = dst;


        if (selTransform.originalMask) {
          const mSrcCtx = selTransform.originalMask.getContext('2d');
          const mSrcData = mSrcCtx.getImageData(0, 0, srcW, srcH);
          const mSrc = mSrcData.data;

          const mDst = makeCanvas(absW, absH);
          const mDstCtx = mDst.getContext('2d');
          const mDstData = mDstCtx.createImageData(absW, absH);
          const mDstPx = mDstData.data;

          for (let y = 0; y < absH; y++) {
            const srcY = Math.floor((flipY ? (absH - 1 - y) : y) * srcH / absH);
            for (let x = 0; x < absW; x++) {
              const srcX = Math.floor((flipX ? (absW - 1 - x) : x) * srcW / absW);
              const srcIdx = (srcY * srcW + srcX) * 4;
              const dstIdx = (y * absW + x) * 4;
              mDstPx[dstIdx] = mSrc[srcIdx];
              mDstPx[dstIdx + 1] = mSrc[srcIdx + 1];
              mDstPx[dstIdx + 2] = mSrc[srcIdx + 2];
              mDstPx[dstIdx + 3] = mSrc[srcIdx + 3];
            }
          }
          mDstCtx.putImageData(mDstData, 0, 0);
          sel.mask = mDst;
        }

        sel.x = newX;
        sel.y = newY;
        sel.w = absW;
        sel.h = absH;

        render();
      }

      function updateRotateTransform(p) {
        if (!sel || selTransform.mode !== 'rotate') return;


        const cx = selTransform.startCX;
        const cy = selTransform.startCY;


        const currentAngle = Math.atan2(p.y - cy, p.x - cx) * 180 / Math.PI + 90;
        let rotation = currentAngle - selTransform.startAngle;


        while (rotation > 180) rotation -= 360;
        while (rotation < -180) rotation += 360;


        const snapAngles = [0, 45, 90, 135, 180, -45, -90, -135, -180];
        for (const snap of snapAngles) {
          if (Math.abs(rotation - snap) <= selTransform.snapThreshold) {
            rotation = snap;
            break;
          }
        }

        selTransform.rotation = rotation;



        const radians = rotation * Math.PI / 180;
        const cos = Math.cos(radians);
        const sin = Math.sin(radians);
        const absCos = Math.abs(cos);
        const absSin = Math.abs(sin);

        const srcW = selTransform.startW;
        const srcH = selTransform.startH;





        const srcCtx = selTransform.originalImg.getContext('2d');
        const srcData = srcCtx.getImageData(0, 0, srcW, srcH);
        const src = srcData.data;



        let newW = Math.ceil(srcW * absCos + srcH * absSin);
        let newH = Math.ceil(srcH * absCos + srcW * absSin);
        if (newW % 2 !== 0) newW++;
        if (newH % 2 !== 0) newH++;

        const dst = makeCanvas(newW, newH);
        const dstCtx = dst.getContext('2d');
        const dstData = dstCtx.createImageData(newW, newH);
        const dstPx = dstData.data;

        const cx0 = srcW / 2;
        const cy0 = srcH / 2;
        const cx1 = newW / 2;
        const cy1 = newH / 2;


        for (let y = 0; y < newH; y++) {
          for (let x = 0; x < newW; x++) {

            const dx = x - cx1;
            const dy = y - cy1;
            const sx = Math.round(dx * cos + dy * sin + cx0);
            const sy = Math.round(-dx * sin + dy * cos + cy0);

            if (sx >= 0 && sx < srcW && sy >= 0 && sy < srcH) {
              const srcIdx = (sy * srcW + sx) * 4;
              const dstIdx = (y * newW + x) * 4;
              dstPx[dstIdx] = src[srcIdx];
              dstPx[dstIdx + 1] = src[srcIdx + 1];
              dstPx[dstIdx + 2] = src[srcIdx + 2];
              dstPx[dstIdx + 3] = src[srcIdx + 3];
            }
          }
        }

        dstCtx.putImageData(dstData, 0, 0);
        sel.img = dst;


        if (selTransform.originalMask) {
          const mSrcCtx = selTransform.originalMask.getContext('2d');
          const mSrcData = mSrcCtx.getImageData(0, 0, srcW, srcH);
          const mSrc = mSrcData.data;

          const mDst = makeCanvas(newW, newH);
          const mDstCtx = mDst.getContext('2d');
          const mDstData = mDstCtx.createImageData(newW, newH);
          const mDstPx = mDstData.data;

          for (let y = 0; y < newH; y++) {
            for (let x = 0; x < newW; x++) {
              const dx = x - cx1;
              const dy = y - cy1;
              const sx = Math.round(dx * cos + dy * sin + cx0);
              const sy = Math.round(-dx * sin + dy * cos + cy0);

              if (sx >= 0 && sx < srcW && sy >= 0 && sy < srcH) {
                const srcIdx = (sy * srcW + sx) * 4;
                const dstIdx = (y * newW + x) * 4;
                mDstPx[dstIdx] = mSrc[srcIdx];
                mDstPx[dstIdx + 1] = mSrc[srcIdx + 1];
                mDstPx[dstIdx + 2] = mSrc[srcIdx + 2];
                mDstPx[dstIdx + 3] = mSrc[srcIdx + 3];
              }
            }
          }

          mDstCtx.putImageData(mDstData, 0, 0);
          sel.mask = mDst;
        }




        sel.img = dst;
        sel.x = selTransform.startCX - newW / 2;
        sel.y = selTransform.startCY - newH / 2;
        sel.w = newW;
        sel.h = newH;

        render();
      }

      function endTransform() {
        if (!sel || !selTransform.mode) return;


        if (selTransform.mode === 'scale' && sel.poly && sel.poly.length && selTransform.startW && selTransform.startH) {
          const scaleX = sel.w / selTransform.startW;
          const scaleY = sel.h / selTransform.startH;
          sel.poly = sel.poly.map(p => ({ x: p.x * scaleX, y: p.y * scaleY }));
        }


        if (selTransform.mode === 'rotate' && sel.poly && sel.poly.length && selTransform.startCX !== undefined) {
          const rotation = selTransform.rotation;
          const rad = rotation * Math.PI / 180;
          const cos = Math.cos(rad);
          const sin = Math.sin(rad);
          const cx = selTransform.startCX;
          const cy = selTransform.startCY;


          const ox = selTransform.startSelX;
          const oy = selTransform.startSelY;


          const nx = sel.x;
          const ny = sel.y;

          sel.poly = sel.poly.map(p => {

            const gx = ox + p.x;
            const gy = oy + p.y;


            const dx = gx - cx;
            const dy = gy - cy;
            const rx = dx * cos - dy * sin + cx;
            const ry = dx * sin + dy * cos + cy;


            return { x: rx - nx, y: ry - ny };
          });
        }


        if (selTransform.mode === 'rotate') {
          trimSelection(sel);
        }

        const afterSnap = snapshotSelectionObject(sel);



        if (selTransform.mode === 'move' && selTransform.beforeSnap && selTransform.beforeSnap.img) {
          afterSnap.img = selTransform.beforeSnap.img;
          if (afterSnap.mask && selTransform.beforeSnap.mask) {
            afterSnap.mask = selTransform.beforeSnap.mask;
          }
        }

        pushSelTransform(selTransform.beforeSnap, afterSnap, selTransform.mode);


        selTransform.mode = null;
        selTransform.handle = null;
        selTransform.originalImg = null;
        selTransform.originalMask = null;
        selTransform.beforeSnap = null;
        selTransform.rotation = 0;
        selTransform.startCX = undefined;
        selTransform.startCY = undefined;

        sel.state = 'idle';
        render();
      }

      function drawSelButtons() {
        if (!sel || !sel.img) { selButtons = null; return; }

        const z = view.scale;

        const maxHandleSize = 18;
        const minHandleSize = 18;
        const visualSize = Math.min(maxHandleSize, Math.max(minHandleSize, 14 / z));
        const HANDLE_SIZE = visualSize / z;

        const ROT_DIST = 20 / z;


        const bx = sel.x, by = sel.y, bw = sel.w, bh = sel.h;

        const cx = bx + bw / 2;
        const cy = by + bh / 2;



        const hs = HANDLE_SIZE;
        const corners = {
          nw: { x: bx - hs / 2, y: by - hs / 2, w: hs, h: hs },
          ne: { x: bx + bw - hs / 2, y: by - hs / 2, w: hs, h: hs },
          sw: { x: bx - hs / 2, y: by + bh - hs / 2, w: hs, h: hs },
          se: { x: bx + bw - hs / 2, y: by + bh - hs / 2, w: hs, h: hs }
        };


        const rotHandle = { x: cx - hs / 2, y: by - ROT_DIST - hs, w: hs, h: hs };

        ctx.save();


        if (selTransform.mode === 'rotate') {
          const guideLen = Math.max(bw, bh) * 0.6 + 20 / z;


          ctx.strokeStyle = 'rgba(58,163,255,.25)';
          ctx.lineWidth = 1 / z;
          ctx.setLineDash([]);

          [0, 45, 90, 135, 180, 225, 270, 315].forEach(angle => {
            const rad = (angle - 90) * Math.PI / 180;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + Math.cos(rad) * guideLen, cy + Math.sin(rad) * guideLen);
            ctx.stroke();
          });


          ctx.strokeStyle = 'rgba(58,163,255,.5)';
          ctx.beginPath();
          ctx.moveTo(cx - 8 / z, cy); ctx.lineTo(cx + 8 / z, cy);
          ctx.moveTo(cx, cy - 8 / z); ctx.lineTo(cx, cy + 8 / z);
          ctx.stroke();


          const currentRad = (selTransform.rotation - 90) * Math.PI / 180;
          ctx.strokeStyle = '#3aa3ff';
          ctx.lineWidth = 2 / z;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + Math.cos(currentRad) * guideLen, cy + Math.sin(currentRad) * guideLen);
          ctx.stroke();


          const angleText = `${Math.round(selTransform.rotation)}°`;
          const badgeFontSize = Math.max(20, 24 / z);
          ctx.font = `bold ${badgeFontSize}px system-ui, -apple-system, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const badgeY = by - ROT_DIST - hs - 30 / z;
          const tw = ctx.measureText(angleText).width + 24 / z;
          const th = badgeFontSize + 16 / z;


          ctx.shadowColor = 'rgba(0,0,0,0.5)';
          ctx.shadowBlur = 8 / z;
          ctx.shadowOffsetY = 4 / z;


          ctx.fillStyle = '#222';
          ctx.beginPath();
          ctx.roundRect(cx - tw / 2, badgeY - th / 2, tw, th, 8 / z);
          ctx.fill();


          ctx.shadowColor = 'transparent';
          ctx.shadowBlur = 0;
          ctx.shadowOffsetY = 0;


          ctx.lineWidth = 2 / z;
          ctx.strokeStyle = 'white';
          ctx.stroke();


          ctx.fillStyle = 'white';
          ctx.fillText(angleText, cx, badgeY);
        }



        const isCloseZoom = z > 4;
        const dashLen = isCloseZoom ? Math.max(1, 2 / z) : 6 / z;
        const gapLen = isCloseZoom ? Math.max(0.5, 1.5 / z) : 4 / z;

        const outlineWidth = isCloseZoom ? Math.max(0.2, 0.5 / z) : 1 / z;
        ctx.lineWidth = outlineWidth;


        ctx.setLineDash([dashLen, gapLen]);
        ctx.strokeStyle = '#3aa3ff';
        if (!sel.poly) {
          ctx.strokeRect(bx, by, bw, bh);
        }


        ctx.setLineDash([]);
        if (!selTransform.mode || selTransform.mode === 'rotate') {
          ctx.beginPath();
          ctx.moveTo(cx, by);
          ctx.lineTo(cx, rotHandle.y + rotHandle.h);
          ctx.stroke();
        }


        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#3aa3ff';
        ctx.lineWidth = 2.5 / z;
        Object.values(corners).forEach(c => {
          ctx.fillRect(c.x, c.y, c.w, c.h);
          ctx.strokeRect(c.x, c.y, c.w, c.h);
        });


        if (!selTransform.mode || selTransform.mode === 'rotate') {
          const rotRadius = hs * 0.65 + 2 / z;
          ctx.beginPath();
          ctx.arc(rotHandle.x + hs / 2, rotHandle.y + hs / 2, rotRadius, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }

        ctx.restore();

        selButtons = { corners, rot: rotHandle };
      }

      function roundRect(c, x, y, w, h, r) {
        c.moveTo(x + r, y);
        c.arcTo(x + w, y, x + w, y + h, r);
        c.arcTo(x + w, y + h, x, y + h, r);
        c.arcTo(x, y + h, x, y, r);
        c.arcTo(x, y, x + w, y, r);
        c.closePath();
      }

      function hitSelButton(px, py) {
        if (!selButtons) return null;
        const { corners, rot } = selButtons;


        const z = view.scale;
        const rotRadius = (rot.w / 2);
        const hitR = Math.max(rotRadius * 1.5, rotRadius + 6 / z);

        const rotCx = rot.x + rot.w / 2;
        const rotCy = rot.y + rot.h / 2;

        const rdx = px - rotCx;
        const rdy = py - rotCy;
        if (rdx * rdx + rdy * rdy <= hitR * hitR) return 'rot';


        for (const [key, c] of Object.entries(corners)) {
          if (px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h) {
            return key;
          }
        }

        return null;
      }


      function trimSelection(sel) {
        if (!sel || !sel.img) return;


        const w = sel.w;
        const h = sel.h;
        const ctx = sel.img.getContext('2d');
        const data = ctx.getImageData(0, 0, w, h).data;

        let minX = w, minY = h, maxX = 0, maxY = 0;
        let found = false;

        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const alpha = data[(y * w + x) * 4 + 3];
            if (alpha > 0) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
              found = true;
            }
          }
        }

        if (!found) return;

        const rawW = maxX - minX + 1;
        const rawH = maxY - minY + 1;





        const cropW = Math.max(2, rawW);
        const cropH = Math.max(2, rawH);

        const padX = Math.floor((cropW - rawW) / 2);
        const padY = Math.floor((cropH - rawH) / 2);


        if (cropW === w && cropH === h && minX === 0 && minY === 0 && padX === 0 && padY === 0) return;


        const newImg = makeCanvas(cropW, cropH);
        const newCtx = newImg.getContext('2d');

        newCtx.drawImage(sel.img, minX, minY, rawW, rawH, padX, padY, rawW, rawH);
        sel.img = newImg;


        if (sel.mask) {
          const newMask = makeCanvas(cropW, cropH);
          const newMaskCtx = newMask.getContext('2d');
          newMaskCtx.drawImage(sel.mask, minX, minY, rawW, rawH, padX, padY, rawW, rawH);
          sel.mask = newMask;
        }


        if (sel.poly && sel.poly.length) {
          sel.poly.forEach(p => {
            p.x -= (minX - padX);
            p.y -= (minY - padY);
          });
        }


        sel.x += (minX - padX);
        sel.y += (minY - padY);
        sel.w = cropW;
        sel.h = cropH;
      }


      function commitSelection() {
        if (!sel || !sel.img) return;

        const targetLayer = sel.cutLayer !== undefined ? sel.cutLayer : activeLayer;
        const fctx = frames[current].layers[targetLayer].ctx;
        normalizeSel(sel);
        sel.x = Math.round(sel.x); sel.y = Math.round(sel.y);
        sel.w = Math.round(sel.w); sel.h = Math.round(sel.h);

        if (sel.detached === true || sel.source === 'paste') {
          const Ux = sel.x, Uy = sel.y, Uw = sel.w, Uh = sel.h;
          const unionNow = fctx.getImageData(Ux, Uy, Uw, Uh);
          const work = makeCanvas(Uw, Uh), wctx = work.getContext('2d'); wctx.imageSmoothingEnabled = false;

          wctx.putImageData(unionNow, 0, 0);
          const before = wctx.getImageData(0, 0, Uw, Uh);

          wctx.putImageData(unionNow, 0, 0);
          wctx.drawImage(sel.img, 0, 0);
          const after = wctx.getImageData(0, 0, Uw, Uh);


          const snap = snapshotSelectionObject(sel);
          snap.wasAlreadyCut = true;


          const selMoves = [];
          if (sel._id) {
            for (let i = history.length - 1; i >= 0; i--) {
              if (history[i].type === 'selMove' && history[i].selId === sel._id) {
                selMoves.unshift(history.splice(i, 1)[0]);
              }
            }
          }

          fctx.putImageData(after, Ux, Uy);
          pushPaintPatch(current, Ux, Uy, Uw, Uh, before, after, targetLayer, snap);

          if (selMoves.length > 0) {
            history[history.length - 1].selMoves = selMoves;
          }
          sel = null; updateThumb(current); refreshFilmTile(current); render();
          return;
        }

        const dest = { x: sel.x, y: sel.y, w: sel.w, h: sel.h };



        const cutRect = sel.cutRect || sel.untrimmedBounds || { x: sel.x, y: sel.y, w: sel.w, h: sel.h };

        const Ux = Math.min(cutRect.x, dest.x);
        const Uy = Math.min(cutRect.y, dest.y);
        const Ux2 = Math.max(cutRect.x + cutRect.w, dest.x + dest.w);
        const Uy2 = Math.max(cutRect.y + cutRect.h, dest.y + dest.h);
        const Uw = Math.max(1, Ux2 - Ux);
        const Uh = Math.max(1, Uy2 - Uy);

        const unionNow = fctx.getImageData(Ux, Uy, Uw, Uh);
        const work = makeCanvas(Uw, Uh), wctx = work.getContext('2d'); wctx.imageSmoothingEnabled = false;

        wctx.putImageData(unionNow, 0, 0);
        if (sel.hasCut && sel.cutBefore) {
          wctx.putImageData(sel.cutBefore, cutRect.x - Ux, cutRect.y - Uy);
        }
        const before = wctx.getImageData(0, 0, Uw, Uh);


        const wasAlreadyCut = sel.hasCut;

        wctx.putImageData(unionNow, 0, 0);
        if (!sel.hasCut) {

          const clearMask = sel.untrimmedMask || sel.mask;
          const clearImg = sel.untrimmedImg || sel.img;
          if (clearMask) {
            wctx.save(); wctx.globalCompositeOperation = 'destination-out';
            const solidMask = getSolidMask(clearMask);
            wctx.drawImage(solidMask, cutRect.x - Ux, cutRect.y - Uy);
            wctx.restore();
          } else if (sel.poly) {
            wctx.save(); wctx.globalCompositeOperation = 'destination-out';
            const solidMask = getSolidMask(clearImg);
            wctx.drawImage(solidMask, cutRect.x - Ux, cutRect.y - Uy);
            wctx.restore();
          } else {
            wctx.clearRect(cutRect.x - Ux, cutRect.y - Uy, cutRect.w, cutRect.h);
          }
        }
        wctx.drawImage(sel.img, dest.x - Ux, dest.y - Uy);
        const after = wctx.getImageData(0, 0, Uw, Uh);



        if (!sel.cutRect) sel.cutRect = cutRect;
        if (!sel.cutImg) sel.cutImg = sel.untrimmedImg || sel.img;
        if (!sel.cutMask) sel.cutMask = sel.untrimmedMask || sel.mask;


        const snap = snapshotSelectionObject(sel);
        snap.wasAlreadyCut = wasAlreadyCut;


        const selMoves = [];
        if (sel._id) {
          for (let i = history.length - 1; i >= 0; i--) {
            if (history[i].type === 'selMove' && history[i].selId === sel._id) {
              selMoves.unshift(history.splice(i, 1)[0]);
            }
          }
        }

        if (!sel.hasCut) sel.hasCut = true;

        fctx.putImageData(after, Ux, Uy);
        pushPaintPatch(current, Ux, Uy, Uw, Uh, before, after, targetLayer, snap);

        if (selMoves.length > 0) {
          history[history.length - 1].selMoves = selMoves;
        }
        sel = null; updateThumb(current); refreshFilmTile(current); render();
      }



      function deleteSelection() {
        if (!sel) return false;
        normalizeSel(sel);
        sel.x = Math.round(sel.x); sel.y = Math.round(sel.y);
        sel.w = Math.round(sel.w); sel.h = Math.round(sel.h);

        const targetLayer = sel.cutLayer !== undefined ? sel.cutLayer : activeLayer;
        const c = frames[current].layers[targetLayer].ctx;

        if (sel.detached === true || sel.source === 'paste') {
          sel = null; render();
          return true;
        }

        if (sel.hasCut && sel.cutBefore && sel.cutRect) {
          const { x, y, w, h } = sel.cutRect;
          const after = c.getImageData(x, y, w, h);
          const before = sel.cutBefore;
          pushPaintPatch(current, x, y, w, h, before, after, targetLayer);
          sel = null; updateThumb(current); refreshFilmTile(current); render();
          return true;
        }


        const clearRect = sel.untrimmedBounds || { x: sel.x, y: sel.y, w: sel.w, h: sel.h };
        const clearMask = sel.untrimmedMask || sel.mask;
        const clearImg = sel.untrimmedImg || sel.img;

        const before = c.getImageData(clearRect.x, clearRect.y, clearRect.w, clearRect.h);
        c.save();
        if (clearMask) {
          c.globalCompositeOperation = 'destination-out';
          c.drawImage(clearMask, clearRect.x, clearRect.y);
        } else if (clearImg) {
          c.globalCompositeOperation = 'destination-out';
          c.drawImage(clearImg, clearRect.x, clearRect.y);
        } else {
          c.clearRect(clearRect.x, clearRect.y, clearRect.w, clearRect.h);
        }
        c.restore();
        const after = c.getImageData(clearRect.x, clearRect.y, clearRect.w, clearRect.h);
        pushPaintPatch(current, clearRect.x, clearRect.y, clearRect.w, clearRect.h, before, after, targetLayer);
        sel = null; updateThumb(current); refreshFilmTile(current); render();
        return true;
      }


      function dropSelectionForNewPaste() {
        if (!sel) return;
        commitSelection();
      }

      function cancelSelection() {
        if (sel && sel.hasCut && sel.cutBefore && sel.cutRect && !(sel.detached === true || sel.source === 'paste')) {
          const targetLayer = sel.cutLayer !== undefined ? sel.cutLayer : activeLayer;
          frames[current].layers[targetLayer].ctx.putImageData(sel.cutBefore, sel.cutRect.x, sel.cutRect.y);
        }
        sel = null; lasso = null; lassoPaintStroke = null; selButtons = null; render();
      }


      let __selIdSeq = 1;
      function makeFloatingSelectionFromCanvas(imgCanvas, x = 0, y = 0, maskCanvas = null, poly = null) {
        if (!imgCanvas) return;
        const w = imgCanvas.width;
        const h = imgCanvas.height;

        const ix = x;
        const iy = y;

        let img = imgCanvas;

        sel = {
          x: ix, y: iy, w, h,
          img,
          mask: maskCanvas || null,
          originX: ix, originY: iy,
          hasCut: true,
          detached: true,
          state: 'idle',
          source: 'paste',
          poly: poly ? poly.map(p => ({ x: p.x, y: p.y })) : null,
          _id: (++__selIdSeq),
          _frame: current
        };
        render();
      }
      function makeFloatingSelectionFromImageData(imageData, x = 0, y = 0) {
        const c = makeCanvas(imageData.width, imageData.height);
        c.getContext('2d').putImageData(imageData, 0, 0);
        makeFloatingSelectionFromCanvas(c, x, y, null);
      }


      function copySelectionForPaste() {
        if (!sel || !sel.img) return false;
        normalizeSel(sel);

        const cx = sel.x + sel.w / 2;
        const cy = sel.y + sel.h / 2;
        clipboard = {
          img: cloneCanvas(sel.img),
          mask: sel.mask ? cloneCanvas(sel.mask) : null,
          poly: sel.poly ? sel.poly.map(p => ({ x: p.x, y: p.y })) : null,
          w: sel.w,
          h: sel.h,
          ogX: sel.x,
          ogY: sel.y,
          ogCX: cx,
          ogCY: cy
        };
        if (typeof showToast === 'function') showToast('Copied selection');
        return true;
      }
      function pasteFromClipboard() {
        if (!clipboard || !clipboard.img) return false;
        if (sel) dropSelectionForNewPaste();


        let x, y;
        if (clipboard.ogCX !== undefined && clipboard.ogCY !== undefined) {
          x = clipboard.ogCX - clipboard.w / 2;
          y = clipboard.ogCY - clipboard.h / 2;
        } else {
          x = clipboard.ogX || 0;
          y = clipboard.ogY || 0;
        }

        const img = cloneCanvas(clipboard.img);
        const mask = clipboard.mask ? cloneCanvas(clipboard.mask) : null;
        const poly = clipboard.poly ? clipboard.poly.map(p => ({ x: p.x, y: p.y })) : null;
        makeFloatingSelectionFromCanvas(img, x, y, mask, poly);

        if (typeof showToast === 'function') showToast('Pasted');
        return true;
      }
      function copyImageDataAsSelection(imageData, x = 0, y = 0) {
        const c = makeCanvas(imageData.width, imageData.height);
        c.getContext('2d').putImageData(imageData, 0, 0);
        clipboard = {
          img: c, mask: null, w: c.width, h: c.height,
          ogX: (x | 0),
          ogY: (y | 0)
        };
        if (typeof showToast === 'function') showToast('Copied');
        return true;
      }


      let suppressSelMoveRecord = false;

      function _selContains(px, py) {
        if (!sel) return false;
        if (sel.poly && sel.poly.length && typeof pointInPoly === 'function') {
          return pointInPoly(sel.poly, px - sel.x + 0.5, py - sel.y + 0.5);
        }
        return (px >= sel.x && px <= sel.x + sel.w && py >= sel.y && py <= sel.y + sel.h);
      }

      function _armSelMoveIfHit(e) {
        if (!sel) return;
        if (tool !== 'select' && tool !== 'lasso') return;

        const p = toCanvasXY(e);
        if (hitSelButton(p.x, p.y)) return;
        if (!_selContains(p.x, p.y)) return;

        if (!sel._id) sel._id = (++__selIdSeq);
        sel._moveStart = { x: sel.x, y: sel.y };
      }
      function _commitSelMoveIfAny() {
        if (!sel || !sel._moveStart) return;
        const s = sel._moveStart;
        if (suppressSelMoveRecord) { sel._moveStart = null; return; }
        if (sel.x !== s.x || sel.y !== s.y) {

          history.push({
            type: 'selMove',
            selId: sel._id,
            fromX: s.x,
            fromY: s.y,
            toX: sel.x,
            toY: sel.y,
            fi: current,
            layer: activeLayer
          });
          capHistory();
          redoStack.length = 0;
        }
        sel._moveStart = null;
      }


      function applyCutForSelection() {
        if (!sel || !sel.img) return;
        if (sel.source === 'paste') return;
        const targetLayer = sel.cutLayer !== undefined ? sel.cutLayer : activeLayer;
        const selFrame = sel._frame !== undefined ? sel._frame : current;
        if (!frames[selFrame] || !frames[selFrame].layers[targetLayer]) return;
        const fctx = frames[selFrame].layers[targetLayer].ctx;
        normalizeSel(sel);
        sel.x = Math.round(sel.x); sel.y = Math.round(sel.y);
        sel.w = Math.round(sel.w); sel.h = Math.round(sel.h);

        const cutRect = { x: sel.x, y: sel.y, w: sel.w, h: sel.h };
        const cutBefore = fctx.getImageData(cutRect.x, cutRect.y, cutRect.w, cutRect.h);
        fctx.save();
        if (sel.mask) {
          fctx.globalCompositeOperation = 'destination-out';
          fctx.drawImage(sel.mask, sel.x, sel.y);
        } else {
          fctx.clearRect(sel.x, sel.y, sel.w, sel.h);
        }
        fctx.restore();
        sel.hasCut = true;
        sel.cutRect = cutRect;
        sel.cutBefore = cutBefore;
        updateThumb(selFrame); refreshFilmTile(selFrame); render();
      }



      function hideSelectionForUndo() {
        if (!sel) return false;

        const snap = snapshotSelectionObject(sel);
        const selFrame = sel._frame !== undefined ? sel._frame : current;
        let redoCut = false;
        if (sel.source !== 'paste' && sel.hasCut && sel.cutBefore && sel.cutRect) {
          const targetLayer = sel.cutLayer !== undefined ? sel.cutLayer : activeLayer;

          if (frames[selFrame] && frames[selFrame].layers[targetLayer]) {
            const fctx = frames[selFrame].layers[targetLayer].ctx;
            fctx.putImageData(sel.cutBefore, sel.cutRect.x, sel.cutRect.y);
            updateThumb(selFrame); refreshFilmTile(selFrame);
            redoCut = true;
          }
        }

        redoStack.push({ type: 'selReappear', snap, redoCut, fi: selFrame, layer: activeLayer });
        capRedo?.();

        sel = null;
        render();
        return true;
      }


      (function hookSelUndoRedo() {
        if (hookSelUndoRedo._done) return;
        hookSelUndoRedo._done = true;

        if (stage) stage.addEventListener('pointerdown', _armSelMoveIfHit, { passive: false });
        if (stage) stage.addEventListener('pointerup', _commitSelMoveIfAny, { passive: false });
        window.addEventListener('pointerup', _commitSelMoveIfAny, { passive: false });

        setTimeout(() => {
          if (typeof doUndo === 'function') {
            const _origUndo = doUndo;
            doUndo = function () {
              if (typeof isCanvasToolActionActive === 'function' && isCanvasToolActionActive()) {
                if (typeof notifyHistoryLocked === 'function') notifyHistoryLocked();
                return;
              }

              while (history.length && history[history.length - 1].type === 'selMove') {
                const top = history[history.length - 1];
                if (sel && sel._id === top.selId) break;

                redoStack.push(history.pop()); capRedo?.();
              }


              if (history.length && history[history.length - 1].type === 'selMove') {
                const op = history.pop();
                redoStack.push(op); capRedo?.();
                if (sel && sel._id === op.selId) {

                  if (op.fi !== undefined && op.fi !== current) {
                    setCurrent(op.fi);
                  }

                  if (op.layer !== undefined && op.layer !== activeLayer) {
                    activeLayer = op.layer;
                    updateLayerUI();
                  }
                  suppressSelMoveRecord = true;
                  sel.x = op.fromX; sel.y = op.fromY;
                  sel.state = 'idle';
                  render();
                  suppressSelMoveRecord = false;
                }
                if (showHistoryToasts) showToast(getOpDescription(op, false));
                return;
              }


              if (history.length && history[history.length - 1].type === 'selTransform') {
                const top = history[history.length - 1];
                if (sel && sel._id === top.selId) {
                  const op = history.pop();
                  redoStack.push(op); capRedo?.();


                  if (op.before._frame !== undefined && op.before._frame !== current) {
                    setCurrent(op.before._frame);
                  }
                  if (op.before.cutLayer !== undefined && op.before.cutLayer !== activeLayer) {
                    activeLayer = op.before.cutLayer;
                    updateLayerUI();
                  }

                  restoreSelectionFromSnapshot(op.before);
                  if (showHistoryToasts) showToast(getOpDescription(op, false));
                  return;
                }
              }


              if (sel && sel._arrowMoveStart) {
                clearTimeout(sel._arrowMoveTimer);
                sel.x = sel._arrowMoveStart.x;
                sel.y = sel._arrowMoveStart.y;
                sel._arrowMoveStart = null;
                sel._arrowMoveTimer = null;
                render();
                return;
              }


              if (sel) {


                const top = history.length ? history[history.length - 1] : null;
                const isFrameOpWithSelSnap = top && top.selSnap &&
                  ['frameInsert', 'frameDelete', 'multiFrameInsert', 'multiFrameDelete'].includes(top.type);

                if (!isFrameOpWithSelSnap) {
                  hideSelectionForUndo();
                  if (showHistoryToasts) showToast('Undid selection creation');
                  return;
                }

              }


              if (history.length && history[history.length - 1].type === 'selReappearApplied') {

                history.pop();

              }


              _origUndo();
            };
          }

          if (typeof doRedo === 'function') {
            const _origRedo = doRedo;
            doRedo = function () {
              if (typeof isCanvasToolActionActive === 'function' && isCanvasToolActionActive()) {
                if (typeof notifyHistoryLocked === 'function') notifyHistoryLocked();
                return;
              }

              if (redoStack.length && redoStack[redoStack.length - 1].type === 'selReappear') {
                const op = redoStack.pop();

                if (op.fi !== undefined && op.fi !== current) {
                  setCurrent(op.fi);
                }

                if (op.layer !== undefined && op.layer !== activeLayer) {
                  activeLayer = op.layer;
                  updateLayerUI();
                }
                restoreSelectionFromSnapshot(op.snap);
                if (op.redoCut && sel && sel.source !== 'paste') {
                  applyCutForSelection();
                }
                history.push({ type: 'selReappearApplied', selId: sel?._id, fi: op.fi, layer: op.layer }); capHistory?.();
                if (showHistoryToasts) showToast(getOpDescription(op, true));
                return;
              }


              while (redoStack.length && redoStack[redoStack.length - 1].type === 'selMove') {
                const top = redoStack[redoStack.length - 1];
                if (sel && sel._id === top.selId) break;


                history.push(redoStack.pop()); capHistory?.();
              }


              if (redoStack.length && redoStack[redoStack.length - 1].type === 'selMove') {
                const op = redoStack.pop();
                history.push(op); capHistory?.();
                if (sel && sel._id === op.selId) {

                  if (op.fi !== undefined && op.fi !== current) {
                    setCurrent(op.fi);
                  }

                  if (op.layer !== undefined && op.layer !== activeLayer) {
                    activeLayer = op.layer;
                    updateLayerUI();
                  }
                  suppressSelMoveRecord = true;
                  sel.x = op.toX; sel.y = op.toY;
                  sel.state = 'idle';
                  render();
                  suppressSelMoveRecord = false;
                }
                if (showHistoryToasts) showToast(getOpDescription(op, true));
                return;
              }


              if (redoStack.length && redoStack[redoStack.length - 1].type === 'selTransform') {
                const top = redoStack[redoStack.length - 1];
                if (sel && sel._id === top.selId) {
                  const op = redoStack.pop();
                  history.push(op); capHistory?.();


                  if (op.after._frame !== undefined && op.after._frame !== current) {
                    setCurrent(op.after._frame);
                  }
                  if (op.after.cutLayer !== undefined && op.after.cutLayer !== activeLayer) {
                    activeLayer = op.after.cutLayer;
                    updateLayerUI();
                  }

                  restoreSelectionFromSnapshot(op.after);
                  if (showHistoryToasts) showToast(getOpDescription(op, true));
                  return;
                }
              }


              _origRedo();


              if (redoStack.length && redoStack[redoStack.length - 1].type === 'selReappear') {
                const op = redoStack.pop();

                if (op.fi !== undefined && op.fi !== current) {
                  setCurrent(op.fi);
                }
                restoreSelectionFromSnapshot(op.snap);
                if (op.redoCut && sel && sel.source !== 'paste') {
                  applyCutForSelection();
                }
                history.push({ type: 'selReappearApplied', selId: sel?._id, fi: op.fi, layer: op.layer }); capHistory?.();
                if (showHistoryToasts) showToast(getOpDescription(op, true));
                return;
              }
            };
          }
        }, 0);
      })();


      const TRANS_KEY_HEX = '#ff00ff';
      const TRANS_KEY_INT = 0xFF00FF;


      let gifLibPromise = null;
      function ensureGifLib() {
        if (window.GIF) return Promise.resolve(window.GIF);
        if (gifLibPromise) return gifLibPromise;
        gifLibPromise = new Promise((resolve, reject) => {
          const tryLoad = (src, next) => {
            const s = document.createElement('script');
            s.src = src; s.async = true; s.onload = () => window.GIF ? resolve(window.GIF) : (next ? next() : reject(new Error('GIF.js loaded but GIF missing')));
            s.onerror = () => next ? next() : reject(new Error('Failed to load gif.js'));
            document.head.appendChild(s);
          };
          tryLoad('https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.js', () => tryLoad('https://unpkg.com/gif.js@0.2.0/dist/gif.js'));
        });
        return gifLibPromise;
      }

      let workerURLPromise = null;
      function ensureWorkerURL() {
        if (workerURLPromise) return workerURLPromise;
        workerURLPromise = fetch('https://cdn.jsdelivr.net/npm/gif.js@0.2.0/dist/gif.worker.js')
          .then(r => { if (!r.ok) throw new Error('Worker fetch failed'); return r.blob(); })
          .then(blob => URL.createObjectURL(blob))
          .catch(err => {
            console.warn('Worker fetch failed, trying fallback', err);
            return fetch('https://unpkg.com/gif.js@0.2.0/dist/gif.worker.js').then(r => r.blob()).then(b => URL.createObjectURL(b));
          });
        return workerURLPromise;
      }

      let jsZipPromise = null;
      function ensureJSZip() {
        if (window.JSZip) return Promise.resolve(window.JSZip);
        if (jsZipPromise) return jsZipPromise;
        jsZipPromise = new Promise((resolve, reject) => {
          const tryLoad = (src, next) => {
            const s = document.createElement('script');
            s.src = src;
            s.async = true;
            s.onload = () => window.JSZip ? resolve(window.JSZip) : (next ? next() : reject(new Error('JSZip loaded but window.JSZip missing')));
            s.onerror = () => next ? next() : reject(new Error('Failed to load JSZip'));
            document.head.appendChild(s);
          };
          tryLoad('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js', () => tryLoad('https://unpkg.com/jszip@3.10.1/dist/jszip.min.js'));
        });
        return jsZipPromise;
      }

      function webpReadFourCC(bytes, off) {
        return String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
      }

      function webpReadU32LE(bytes, off) {
        return (bytes[off]) | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24);
      }

      function webpWriteU24LE(target, off, value) {
        const v = Math.max(0, Math.min(0xffffff, Math.round(value || 0)));
        target[off] = v & 0xff;
        target[off + 1] = (v >> 8) & 0xff;
        target[off + 2] = (v >> 16) & 0xff;
      }

      function webpWriteU32LE(target, off, value) {
        const v = Math.max(0, Math.round(value || 0)) >>> 0;
        target[off] = v & 0xff;
        target[off + 1] = (v >> 8) & 0xff;
        target[off + 2] = (v >> 16) & 0xff;
        target[off + 3] = (v >> 24) & 0xff;
      }

      function webpFourCC(str) {
        return Uint8Array.from([str.charCodeAt(0), str.charCodeAt(1), str.charCodeAt(2), str.charCodeAt(3)]);
      }

      function webpConcat(parts) {
        const total = parts.reduce((n, p) => n + (p?.length || 0), 0);
        const out = new Uint8Array(total);
        let at = 0;
        for (const p of parts) {
          if (!p || !p.length) continue;
          out.set(p, at);
          at += p.length;
        }
        return out;
      }

      function webpMakeChunk(fourCC, payload) {
        const size = payload?.length || 0;
        const pad = size & 1;
        const out = new Uint8Array(8 + size + pad);
        out.set(webpFourCC(fourCC), 0);
        webpWriteU32LE(out, 4, size);
        if (size) out.set(payload, 8);
        return out;
      }

      function parseStaticWebPFrameChunks(bytes) {
        const src = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes || 0);
        if (src.length < 16) throw new Error('WebP frame data is too small');
        if (webpReadFourCC(src, 0) !== 'RIFF' || webpReadFourCC(src, 8) !== 'WEBP') {
          throw new Error('Frame is not WebP');
        }

        const subchunks = [];
        let off = 12;
        while (off + 8 <= src.length) {
          const type = webpReadFourCC(src, off);
          const size = webpReadU32LE(src, off + 4) >>> 0;
          const dataStart = off + 8;
          const dataEnd = dataStart + size;
          if (dataEnd > src.length) throw new Error('Invalid WebP chunk length');
          const chunkEnd = dataEnd + (size & 1);
          if (chunkEnd > src.length) throw new Error('Invalid WebP chunk padding');
          if (type === 'ALPH' || type === 'VP8 ' || type === 'VP8L') {
            subchunks.push(src.slice(off, chunkEnd));
          }
          off = chunkEnd;
        }

        const hasImageBitstream = subchunks.some((chunk) => {
          const type = webpReadFourCC(chunk, 0);
          return type === 'VP8 ' || type === 'VP8L';
        });
        if (!hasImageBitstream) throw new Error('Static WebP frame missing VP8/VP8L chunk');
        return subchunks;
      }

      function parseExportBackgroundRGBA() {
        let r = 0, g = 0, b = 0, a = bgTransparent ? 0 : 255;
        const m = /^#?([0-9a-f]{6})$/i.exec(String(bgColor || '').trim());
        if (m) {
          const hex = m[1];
          r = parseInt(hex.slice(0, 2), 16);
          g = parseInt(hex.slice(2, 4), 16);
          b = parseInt(hex.slice(4, 6), 16);
        }
        return { r, g, b, a };
      }

      function buildAnimatedWebPBytes(width, height, framesForExport, hasAlpha, bgRGBA) {
        const w = Math.max(1, width | 0);
        const h = Math.max(1, height | 0);
        if (!framesForExport?.length) throw new Error('No WebP frames to encode');

        const vp8xPayload = new Uint8Array(10);
        let vp8xFlags = 0x02; // animation
        if (hasAlpha) vp8xFlags |= 0x10; // alpha
        vp8xPayload[0] = vp8xFlags;
        webpWriteU24LE(vp8xPayload, 4, w - 1);
        webpWriteU24LE(vp8xPayload, 7, h - 1);

        const animPayload = new Uint8Array(6);
        animPayload[0] = bgRGBA.b & 0xff;
        animPayload[1] = bgRGBA.g & 0xff;
        animPayload[2] = bgRGBA.r & 0xff;
        animPayload[3] = bgRGBA.a & 0xff;
        animPayload[4] = 0;
        animPayload[5] = 0;

        const anmfChunks = framesForExport.map((frame) => {
          const header = new Uint8Array(16);
          webpWriteU24LE(header, 0, 0); // X
          webpWriteU24LE(header, 3, 0); // Y
          webpWriteU24LE(header, 6, w - 1);
          webpWriteU24LE(header, 9, h - 1);
          webpWriteU24LE(header, 12, frame.duration);
          header[15] = 0; // blend + dispose
          const payload = webpConcat([header, ...(frame.subchunks || [])]);
          return webpMakeChunk('ANMF', payload);
        });

        const body = webpConcat([
          webpMakeChunk('VP8X', vp8xPayload),
          webpMakeChunk('ANIM', animPayload),
          ...anmfChunks
        ]);

        const riff = new Uint8Array(12);
        riff.set(webpFourCC('RIFF'), 0);
        webpWriteU32LE(riff, 4, body.length + 4);
        riff.set(webpFourCC('WEBP'), 8);
        return webpConcat([riff, body]);
      }

      const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
      const PNG_CRC_TABLE = (() => {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
          let c = n;
          for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
          }
          table[n] = c >>> 0;
        }
        return table;
      })();

      function pngReadFourCC(bytes, off) {
        return String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]);
      }

      function pngReadU32BE(bytes, off) {
        return (((bytes[off] << 24) >>> 0) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
      }

      function pngWriteU16BE(target, off, value) {
        const v = Math.max(0, Math.min(0xffff, Math.round(value || 0)));
        target[off] = (v >>> 8) & 0xff;
        target[off + 1] = v & 0xff;
      }

      function pngWriteU32BE(target, off, value) {
        const v = Math.max(0, Math.round(value || 0)) >>> 0;
        target[off] = (v >>> 24) & 0xff;
        target[off + 1] = (v >>> 16) & 0xff;
        target[off + 2] = (v >>> 8) & 0xff;
        target[off + 3] = v & 0xff;
      }

      function pngCRC32(bytes, start = 0, length = (bytes?.length || 0) - start) {
        if (!bytes?.length) return 0;
        const begin = Math.max(0, start | 0);
        const end = Math.min(bytes.length, begin + Math.max(0, length | 0));
        let crc = 0xffffffff;
        for (let i = begin; i < end; i++) {
          crc = PNG_CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
        }
        return (crc ^ 0xffffffff) >>> 0;
      }

      function pngMakeChunk(type, payload) {
        const data = payload instanceof Uint8Array ? payload : new Uint8Array(payload || 0);
        const size = data.length >>> 0;
        const out = new Uint8Array(12 + size);
        pngWriteU32BE(out, 0, size);
        out[4] = type.charCodeAt(0) & 0xff;
        out[5] = type.charCodeAt(1) & 0xff;
        out[6] = type.charCodeAt(2) & 0xff;
        out[7] = type.charCodeAt(3) & 0xff;
        if (size) out.set(data, 8);
        const crc = pngCRC32(out, 4, 4 + size);
        pngWriteU32BE(out, 8 + size, crc);
        return out;
      }

      function parseStaticPNGFrameChunks(bytes) {
        const src = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes || 0);
        if (src.length < 8) throw new Error('PNG frame data is too small');
        for (let i = 0; i < PNG_SIGNATURE.length; i++) {
          if (src[i] !== PNG_SIGNATURE[i]) throw new Error('Frame is not PNG');
        }

        let off = 8;
        let ihdrData = null;
        let sawIDAT = false;
        let sawIEND = false;
        const headerChunks = [];
        const idatChunks = [];

        while (off + 12 <= src.length) {
          const len = pngReadU32BE(src, off);
          const type = pngReadFourCC(src, off + 4);
          const dataStart = off + 8;
          const dataEnd = dataStart + len;
          const chunkEnd = dataEnd + 4;
          if (chunkEnd > src.length || dataEnd < dataStart) throw new Error('Invalid PNG chunk length');

          const data = src.slice(dataStart, dataEnd);
          if (type === 'IHDR') {
            ihdrData = data;
          } else if (type === 'IDAT') {
            sawIDAT = true;
            idatChunks.push(data);
          } else if (type === 'IEND') {
            sawIEND = true;
            break;
          } else if (type !== 'acTL' && type !== 'fcTL' && type !== 'fdAT') {
            if (!sawIDAT) headerChunks.push({ type, data });
          }

          off = chunkEnd;
        }

        if (!ihdrData || ihdrData.length !== 13) throw new Error('PNG frame missing IHDR');
        if (!idatChunks.length) throw new Error('PNG frame missing IDAT');
        if (!sawIEND) throw new Error('PNG frame missing IEND');

        return { ihdrData, headerChunks, idatChunks };
      }

      function apngDelayFraction(delayMs) {
        const ms = Math.max(1, Math.round(delayMs || 0));
        if (ms <= 65535) return { num: ms, den: 1000 };
        const cs = Math.max(1, Math.min(65535, Math.round(ms / 10)));
        return { num: cs, den: 100 };
      }

      function buildAnimatedAPNGBytes(width, height, framesForExport) {
        const w = Math.max(1, width | 0);
        const h = Math.max(1, height | 0);
        if (!framesForExport?.length) throw new Error('No APNG frames to encode');

        const first = framesForExport[0];
        if (!first?.ihdrData || !first?.idatChunks?.length) {
          throw new Error('First APNG frame is invalid');
        }

        const ihdr = first.ihdrData.slice();
        pngWriteU32BE(ihdr, 0, w);
        pngWriteU32BE(ihdr, 4, h);
        const templateTail = ihdr.slice(8, 13);

        const chunks = [];
        chunks.push(pngMakeChunk('IHDR', ihdr));
        for (const headerChunk of (first.headerChunks || [])) {
          if (!headerChunk?.type || !headerChunk?.data) continue;
          if (headerChunk.type === 'IHDR' || headerChunk.type === 'IDAT' || headerChunk.type === 'IEND') continue;
          chunks.push(pngMakeChunk(headerChunk.type, headerChunk.data));
        }

        const acTL = new Uint8Array(8);
        pngWriteU32BE(acTL, 0, framesForExport.length);
        pngWriteU32BE(acTL, 4, 0);
        chunks.push(pngMakeChunk('acTL', acTL));

        let sequence = 0;
        for (let i = 0; i < framesForExport.length; i++) {
          const frame = framesForExport[i];
          if (!frame?.idatChunks?.length) throw new Error('APNG frame is missing IDAT data');
          if (frame.ihdrData?.length !== 13) throw new Error('APNG frame has invalid IHDR');
          if (pngReadU32BE(frame.ihdrData, 0) !== w || pngReadU32BE(frame.ihdrData, 4) !== h) {
            throw new Error('APNG frame dimensions do not match');
          }
          const frameTail = frame.ihdrData.slice(8, 13);
          for (let j = 0; j < templateTail.length; j++) {
            if (frameTail[j] !== templateTail[j]) {
              throw new Error('APNG frame format mismatch');
            }
          }

          const fcTL = new Uint8Array(26);
          pngWriteU32BE(fcTL, 0, sequence++);
          pngWriteU32BE(fcTL, 4, w);
          pngWriteU32BE(fcTL, 8, h);
          pngWriteU32BE(fcTL, 12, 0);
          pngWriteU32BE(fcTL, 16, 0);
          const delay = apngDelayFraction(frame.duration);
          pngWriteU16BE(fcTL, 20, delay.num);
          pngWriteU16BE(fcTL, 22, delay.den);
          fcTL[24] = 0;
          fcTL[25] = 0;
          chunks.push(pngMakeChunk('fcTL', fcTL));

          if (i === 0) {
            for (const idat of frame.idatChunks) {
              chunks.push(pngMakeChunk('IDAT', idat));
            }
          } else {
            for (const idat of frame.idatChunks) {
              const fdAT = new Uint8Array(4 + idat.length);
              pngWriteU32BE(fdAT, 0, sequence++);
              fdAT.set(idat, 4);
              chunks.push(pngMakeChunk('fdAT', fdAT));
            }
          }
        }

        chunks.push(pngMakeChunk('IEND', new Uint8Array(0)));
        return webpConcat([PNG_SIGNATURE, ...chunks]);
      }

      const exportState = {
        type: 'gif',
        selected: new Set(),
        names: {
          gif: 'fliplite',
          apng: 'fliplite',
          webp: 'fliplite',
          png: 'fliplite',
          flip: 'project'
        },
        previewTimer: null,
        previewCursor: 0,
        previewFrame: 0,
        previewPaused: false
      };

      function sanitizeExportName(raw, fallback = 'fliplite') {
        return ((raw || '').replace(/[\\/:*?"<>|]/g, '_').trim() || fallback);
      }

      function triggerBlobDownload(blob, fileName) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }

      function canvasToBlobAsync(canvas, type = 'image/png', quality) {
        return new Promise((resolve, reject) => {
          canvas.toBlob((blob) => {
            if (!blob) return reject(new Error('toBlob() failed'));
            resolve(blob);
          }, type, quality);
        });
      }

      const zipNameEncoder = new TextEncoder();

      function zipWriteU16LE(target, off, value) {
        const v = Math.max(0, Math.min(0xffff, Math.round(value || 0)));
        target[off] = v & 0xff;
        target[off + 1] = (v >>> 8) & 0xff;
      }

      function zipWriteU32LE(target, off, value) {
        const v = (Math.max(0, Math.round(value || 0)) >>> 0);
        target[off] = v & 0xff;
        target[off + 1] = (v >>> 8) & 0xff;
        target[off + 2] = (v >>> 16) & 0xff;
        target[off + 3] = (v >>> 24) & 0xff;
      }

      function buildStoredZipBlob(files) {
        const safeFiles = Array.isArray(files) ? files : [];
        const localParts = [];
        const centralParts = [];
        let localOffset = 0;

        for (const file of safeFiles) {
          const name = String(file?.name || 'file.bin');
          const nameBytes = zipNameEncoder.encode(name);
          const bytes = file?.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(file?.bytes || 0);
          const crc = pngCRC32(bytes, 0, bytes.length) >>> 0;
          const size = bytes.length >>> 0;

          const local = new Uint8Array(30 + nameBytes.length + size);
          zipWriteU32LE(local, 0, 0x04034b50);
          zipWriteU16LE(local, 4, 20);
          zipWriteU16LE(local, 6, 0);
          zipWriteU16LE(local, 8, 0);
          zipWriteU16LE(local, 10, 0);
          zipWriteU16LE(local, 12, 0);
          zipWriteU32LE(local, 14, crc);
          zipWriteU32LE(local, 18, size);
          zipWriteU32LE(local, 22, size);
          zipWriteU16LE(local, 26, nameBytes.length);
          zipWriteU16LE(local, 28, 0);
          if (nameBytes.length) local.set(nameBytes, 30);
          if (size) local.set(bytes, 30 + nameBytes.length);
          localParts.push(local);

          const central = new Uint8Array(46 + nameBytes.length);
          zipWriteU32LE(central, 0, 0x02014b50);
          zipWriteU16LE(central, 4, 20);
          zipWriteU16LE(central, 6, 20);
          zipWriteU16LE(central, 8, 0);
          zipWriteU16LE(central, 10, 0);
          zipWriteU16LE(central, 12, 0);
          zipWriteU16LE(central, 14, 0);
          zipWriteU32LE(central, 16, crc);
          zipWriteU32LE(central, 20, size);
          zipWriteU32LE(central, 24, size);
          zipWriteU16LE(central, 28, nameBytes.length);
          zipWriteU16LE(central, 30, 0);
          zipWriteU16LE(central, 32, 0);
          zipWriteU16LE(central, 34, 0);
          zipWriteU16LE(central, 36, 0);
          zipWriteU32LE(central, 38, 0);
          zipWriteU32LE(central, 42, localOffset);
          if (nameBytes.length) central.set(nameBytes, 46);
          centralParts.push(central);

          localOffset += local.length;
        }

        const centralOffset = localOffset;
        const centralSize = centralParts.reduce((n, p) => n + p.length, 0);
        const entries = Math.min(0xffff, localParts.length);

        const eocd = new Uint8Array(22);
        zipWriteU32LE(eocd, 0, 0x06054b50);
        zipWriteU16LE(eocd, 4, 0);
        zipWriteU16LE(eocd, 6, 0);
        zipWriteU16LE(eocd, 8, entries);
        zipWriteU16LE(eocd, 10, entries);
        zipWriteU32LE(eocd, 12, centralSize);
        zipWriteU32LE(eocd, 16, centralOffset);
        zipWriteU16LE(eocd, 20, 0);

        return new Blob([...localParts, ...centralParts, eocd], { type: 'application/zip' });
      }

      function gifPaletteFromIndex(index) {
        const v = index & 0xff;
        const r = ((v >> 5) & 0x07) * 255 / 7;
        const g = ((v >> 2) & 0x07) * 255 / 7;
        const b = (v & 0x03) * 255 / 3;
        return [Math.round(r), Math.round(g), Math.round(b)];
      }

      function buildGIFGlobalPalette(useTransparency) {
        const palette = new Uint8Array(256 * 3);
        const start = useTransparency ? 1 : 0;
        for (let i = start; i < 256; i++) {
          const [r, g, b] = gifPaletteFromIndex(i);
          const off = i * 3;
          palette[off] = r;
          palette[off + 1] = g;
          palette[off + 2] = b;
        }
        return palette;
      }

      function rgbaToGIFIndexBuffer(rgba, useTransparency) {
        const src = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba || 0);
        const out = new Uint8Array(src.length >> 2);
        for (let si = 0, di = 0; di < out.length; di++, si += 4) {
          const a = src[si + 3];
          if (useTransparency && a < 128) {
            out[di] = 0;
            continue;
          }
          let idx = ((src[si] >> 5) << 5) | ((src[si + 1] >> 5) << 2) | (src[si + 2] >> 6);
          if (useTransparency && idx === 0) idx = 1;
          out[di] = idx;
        }
        return out;
      }

      function gifLZWEncode(indices, minCodeSize = 8) {
        const src = indices instanceof Uint8Array ? indices : new Uint8Array(indices || 0);
        if (!src.length) return new Uint8Array([0x01, 0x01, 0x00]);

        const clearCode = 1 << minCodeSize;
        const endCode = clearCode + 1;
        let nextCode = endCode + 1;
        let codeSize = minCodeSize + 1;
        let dict = new Map();

        const out = [];
        let bitBuffer = 0;
        let bitCount = 0;

        const writeCode = (code) => {
          bitBuffer |= (code << bitCount);
          bitCount += codeSize;
          while (bitCount >= 8) {
            out.push(bitBuffer & 0xff);
            bitBuffer >>>= 8;
            bitCount -= 8;
          }
        };

        const resetDict = () => {
          dict = new Map();
          nextCode = endCode + 1;
          codeSize = minCodeSize + 1;
        };

        writeCode(clearCode);
        let prefix = src[0];

        for (let i = 1; i < src.length; i++) {
          const sym = src[i];
          const key = (prefix << 8) | sym;
          const existing = dict.get(key);
          if (existing !== undefined) {
            prefix = existing;
            continue;
          }

          writeCode(prefix);
          if (nextCode < 4096) {
            dict.set(key, nextCode++);
            if (nextCode === (1 << codeSize) && codeSize < 12) {
              codeSize++;
            }
          } else {
            writeCode(clearCode);
            resetDict();
          }
          prefix = sym;
        }

        writeCode(prefix);
        writeCode(endCode);
        if (bitCount > 0) out.push(bitBuffer & 0xff);
        return new Uint8Array(out);
      }

      function buildAnimatedGIFFallbackBytes(width, height, framesForExport, useTransparency) {
        const w = Math.max(1, width | 0);
        const h = Math.max(1, height | 0);
        if (!framesForExport?.length) throw new Error('No GIF frames to encode');

        const bytes = [];
        const pushByte = (v) => bytes.push(v & 0xff);
        const pushU16 = (v) => {
          const n = Math.max(0, Math.min(0xffff, Math.round(v || 0)));
          bytes.push(n & 0xff, (n >>> 8) & 0xff);
        };
        const pushASCII = (txt) => {
          for (let i = 0; i < txt.length; i++) bytes.push(txt.charCodeAt(i) & 0xff);
        };

        pushASCII('GIF89a');
        pushU16(w);
        pushU16(h);
        pushByte(0xF7);
        pushByte(0x00);
        pushByte(0x00);

        const palette = buildGIFGlobalPalette(!!useTransparency);
        for (let i = 0; i < palette.length; i++) pushByte(palette[i]);

        pushByte(0x21);
        pushByte(0xff);
        pushByte(0x0b);
        pushASCII('NETSCAPE2.0');
        pushByte(0x03);
        pushByte(0x01);
        pushU16(0);
        pushByte(0x00);

        for (const frame of framesForExport) {
          const rgba = frame?.rgba instanceof Uint8Array ? frame.rgba : new Uint8Array(frame?.rgba || 0);
          const delayCentiseconds = Math.max(1, Math.round((frame?.duration || 100) / 10));
          const packed = (((useTransparency ? 2 : 1) & 0x7) << 2) | (useTransparency ? 0x01 : 0x00);

          pushByte(0x21);
          pushByte(0xF9);
          pushByte(0x04);
          pushByte(packed);
          pushU16(delayCentiseconds);
          pushByte(useTransparency ? 0 : 0);
          pushByte(0x00);

          pushByte(0x2C);
          pushU16(0);
          pushU16(0);
          pushU16(w);
          pushU16(h);
          pushByte(0x00);

          pushByte(8);
          const indices = rgbaToGIFIndexBuffer(rgba, !!useTransparency);
          const compressed = gifLZWEncode(indices, 8);
          for (let off = 0; off < compressed.length; off += 255) {
            const len = Math.min(255, compressed.length - off);
            pushByte(len);
            for (let i = 0; i < len; i++) pushByte(compressed[off + i]);
          }
          pushByte(0x00);
        }

        pushByte(0x3B);
        return new Uint8Array(bytes);
      }

      function clampFrameIndex(v) {
        const max = frames.length - 1;
        if (max < 0) return -1;
        return Math.max(0, Math.min(max, v | 0));
      }

      function clampFrameNumber(v) {
        const max = Math.max(1, frames.length);
        return Math.max(1, Math.min(max, Math.round(v || 1)));
      }

      function getAllFrameIndices() {
        return Array.from({ length: frames.length }, (_, i) => i);
      }

      function renderCompositeFrame(frameIndex, outCanvas) {
        const fi = clampFrameIndex(frameIndex);
        if (fi < 0) return outCanvas || makeCanvas(W, H);
        const f = frames[fi];
        const canvas = outCanvas || makeCanvas(W, H);
        if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
        const tctx = canvas.getContext('2d');
        tctx.imageSmoothingEnabled = false;
        tctx.clearRect(0, 0, W, H);

        if (!bgTransparent) {
          tctx.fillStyle = bgColor;
          tctx.fillRect(0, 0, W, H);
          tctx.drawImage(f.bg.can, 0, 0);
        }

        layerOrder.forEach(idx => {
          const l = f.layers[idx];
          if (!l.visible) return;
          tctx.globalAlpha = l.opacity;
          tctx.drawImage(l.can, 0, 0);
        });
        tctx.globalAlpha = 1;
        return canvas;
      }

      function getDefaultFrameDelay() {
        const fps = clampFPS(+fpsInp.value || 8);
        return Math.max(1, Math.round(1000 / fps));
      }

      function getFrameDelayForExport(frameIndex, fallbackDelay = getDefaultFrameDelay()) {
        const f = frames[frameIndex];
        if (!f) return fallbackDelay;
        if (vfrEnabled && f.delay) return Math.max(1, f.delay | 0);
        return fallbackDelay;
      }

      function seedExportSelection(type) {
        const sel = new Set();
        if (type === 'flip') return sel;
        for (let i = 0; i < frames.length; i++) sel.add(i);
        return sel;
      }

      function getExportFrameIndices(type = exportState.type) {
        if (type === 'flip') return [];
        return getAllFrameIndices();
      }

      function stopExportPreview() {
        if (exportState.previewTimer) {
          clearTimeout(exportState.previewTimer);
          exportState.previewTimer = null;
        }
      }

      function getExportPreviewOrder() {
        return getAllFrameIndices();
      }

      function isExportPreviewPlaying() {
        return !exportState.previewPaused && getExportPreviewOrder().length > 1;
      }

      function updateExportPreviewToggleUI() {
        if (!exportPreviewToggleBtn) return;
        const playingPreview = isExportPreviewPlaying();
        exportPreviewToggleBtn.setAttribute('data-playing', playingPreview ? 'true' : 'false');
        exportPreviewToggleBtn.disabled = frames.length < 2;
        if (exportPreviewToggleIcon) exportPreviewToggleIcon.textContent = playingPreview ? '⏸' : '⏵';
      }

      function renderExportPreviewFrame(frameIndex) {
        if (!exportPreviewCanvas || !exportPreviewCtx) return;
        if (exportPreviewCanvas.width !== W) exportPreviewCanvas.width = W;
        if (exportPreviewCanvas.height !== H) exportPreviewCanvas.height = H;
        renderCompositeFrame(frameIndex, exportPreviewCanvas);
      }

      function setPreviewSliderBounds() {
        const count = Math.max(1, frames.length);
        if (exportPreviewSlider) {
          exportPreviewSlider.min = '1';
          exportPreviewSlider.max = String(count);
          exportPreviewSlider.step = '1';
          exportPreviewSlider.disabled = frames.length < 2;
        }
        if (exportPreviewPrevBtn) exportPreviewPrevBtn.disabled = frames.length < 2;
        if (exportPreviewNextBtn) exportPreviewNextBtn.disabled = frames.length < 2;
        exportState.previewFrame = clampFrameIndex(exportState.previewFrame);
        if (exportState.previewFrame < 0) exportState.previewFrame = 0;
        if (exportPreviewSlider) exportPreviewSlider.value = String(exportState.previewFrame + 1);
      }

      function updateExportFrameMetaText() {
        if (!exportFrameMeta) return;
        const total = Math.max(1, frames.length);
        const shown = clampFrameNumber(exportState.previewFrame + 1);
        exportFrameMeta.textContent = `${shown}F / ${total}F`;
      }

      function refreshExportPreview() {
        stopExportPreview();
        if (!frames.length) {
          updateExportPreviewToggleUI();
          return;
        }

        const previewOrder = getExportPreviewOrder();
        if (!previewOrder.length) {
          updateExportPreviewToggleUI();
          return;
        }

        let startFrame = clampFrameIndex(exportState.previewFrame);
        if (startFrame < 0 || !previewOrder.includes(startFrame)) startFrame = previewOrder[0];
        exportState.previewFrame = startFrame;

        if (exportState.previewPaused || previewOrder.length < 2) {
          renderExportPreviewFrame(startFrame);
          updateExportFrameMetaText();
          updateExportPreviewToggleUI();
          return;
        }

        exportState.previewCursor = previewOrder.indexOf(startFrame);
        if (exportState.previewCursor < 0) exportState.previewCursor = 0;
        const tick = () => {
          const idx = previewOrder[exportState.previewCursor % previewOrder.length];
          exportState.previewFrame = idx;
          renderExportPreviewFrame(idx);
          updateExportFrameMetaText();
          exportState.previewCursor = (exportState.previewCursor + 1) % Math.max(1, previewOrder.length);
          const delay = previewOrder.length > 1 ? getFrameDelayForExport(idx) : 500;
          exportState.previewTimer = window.setTimeout(tick, Math.max(90, delay));
        };
        tick();
        updateExportPreviewToggleUI();
      }

      function selectCurrentPNGFrame() {
        const idx = clampFrameIndex(current);
        exportState.selected.clear();
        if (idx >= 0) exportState.selected.add(idx);
        exportState.previewFrame = idx < 0 ? 0 : idx;
      }

      function selectShownPNGFrame() {
        const idx = clampFrameIndex(exportState.previewFrame);
        exportState.selected.clear();
        if (idx >= 0) exportState.selected.add(idx);
      }

      function selectAllPNGFrames() {
        exportState.selected.clear();
        for (let i = 0; i < frames.length; i++) exportState.selected.add(i);
        if (frames.length > 0 && !exportState.selected.has(exportState.previewFrame)) {
          exportState.previewFrame = clampFrameIndex(current);
        }
      }

      function applyPNGRangeSelection() {
        if (!frames.length) return;
        const from = clampFrameNumber(+exportFrameFromInp?.value || 1);
        const to = clampFrameNumber(+exportFrameToInp?.value || from);
        const step = Math.max(1, Math.round(+exportFrameStepInp?.value || 1));
        if (exportFrameFromInp) exportFrameFromInp.value = String(from);
        if (exportFrameToInp) exportFrameToInp.value = String(to);
        if (exportFrameStepInp) exportFrameStepInp.value = String(step);

        const start = Math.min(from, to) - 1;
        const end = Math.max(from, to) - 1;
        exportState.selected.clear();
        for (let i = start; i <= end; i += step) exportState.selected.add(i);
        exportState.previewFrame = start;
      }

      function setPreviewFrameFromNumber(frameNumber) {
        const idx = clampFrameIndex((frameNumber | 0) - 1);
        exportState.previewFrame = idx < 0 ? 0 : idx;
        if (exportPreviewSlider) exportPreviewSlider.value = String(exportState.previewFrame + 1);
      }

      function setExportPreviewInfoTokens(tokens) {
        if (!exportPreviewInfo) return;
        exportPreviewInfo.textContent = '';
        const frag = document.createDocumentFragment();
        const clean = (tokens || []).filter(Boolean);
        clean.forEach((token, i) => {
          if (i > 0) {
            const sep = document.createElement('span');
            sep.className = 'meta-sep';
            sep.setAttribute('aria-hidden', 'true');
            frag.appendChild(sep);
          }
          const t = document.createElement('span');
          t.className = 'meta-token';
          t.textContent = String(token);
          frag.appendChild(t);
        });
        exportPreviewInfo.appendChild(frag);
      }

      function updateExportModalUI() {
        const type = exportState.type;
        const count = getExportFrameIndices(type).length;
        if (exportPreviewSlider) exportPreviewSlider.disabled = frames.length < 2;
        if (exportPreviewPrevBtn) exportPreviewPrevBtn.disabled = frames.length < 2;
        if (exportPreviewNextBtn) exportPreviewNextBtn.disabled = frames.length < 2;

        if (exportPreviewInfo) {
          const frameLabel = `${frames.length}F`;
          const alphaLabel = bgTransparent ? 'ALPHA:ON' : 'ALPHA:OFF';
          const timingLabel = vfrEnabled ? 'VFR' : `CFR ${clampFPS(+fpsInp.value || 8)}FPS`;
          let modeLabel = '.GIF';
          if (type === 'apng') modeLabel = '.APNG';
          else if (type === 'webp') modeLabel = '.WEBP';
          else if (type === 'png') modeLabel = '.PNG ZIP';
          else if (type === 'flip') modeLabel = '.FLIP';
          setExportPreviewInfoTokens([`${W}x${H}`, frameLabel, alphaLabel, timingLabel, modeLabel]);
        }
        if (exportGo) exportGo.disabled = (type !== 'flip' && count === 0);
        updateExportFrameMetaText();
        refreshExportPreview();
      }

      function setExportType(type, resetSelection = false) {
        const prevType = exportState.type;
        exportState.type = type;
        exportTypeBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.exportType === type));
        if (resetSelection || prevType !== type) exportState.selected = seedExportSelection(type);
        if (exportNameInp) exportNameInp.value = exportState.names[type] || (type === 'flip' ? 'project' : 'fliplite');

        setPreviewSliderBounds();
        updateExportModalUI();
      }

      function openExportModal(type = 'gif') {
        exportState.previewPaused = false;
        exportState.previewFrame = clampFrameIndex(current);
        if (exportState.previewFrame < 0) exportState.previewFrame = 0;
        setExportType(type, true);
        exportBackdrop.style.display = 'flex';
        setTimeout(() => { if (exportNameInp) { exportNameInp.focus(); exportNameInp.select(); } }, 0);
      }

      function closeExportModal() {
        stopExportPreview();
        exportBackdrop.style.display = 'none';
      }

      function openImportPicker() {
        if (!importAnyInput) return;
        importAnyInput.value = '';
        importAnyInput.click();
      }

      async function exportGIF(customName, frameIndices) {
        if (playing) togglePlay(false);
        const fileName = sanitizeExportName(customName, 'fliplite');
        const delay = getDefaultFrameDelay();
        const tmp = makeCanvas(W, H), tctx = tmp.getContext('2d');
        tctx.imageSmoothingEnabled = false;
        const useTransparent = bgTransparent === true;

        let GIFCtor = null;
        let workerURL = null;
        try {
          GIFCtor = await ensureGifLib();
          workerURL = await ensureWorkerURL();
        } catch (err) {
          console.warn('GIF.js path unavailable, using offline encoder fallback', err);
        }

        if (GIFCtor && workerURL) {
          let transR = 255, transG = 0, transB = 255;
          let transKeyInt = 0xFF00FF;

          if (useTransparent) {
            showToast('Analyzing colors...');
            const candidates = [
              { r: 255, g: 0, b: 255, int: 0xFF00FF },
              { r: 0, g: 255, b: 0, int: 0x00FF00 },
              { r: 0, g: 0, b: 255, int: 0x0000FF },
              { r: 255, g: 0, b: 0, int: 0xFF0000 },
              { r: 0, g: 255, b: 255, int: 0x00FFFF },
              { r: 255, g: 255, b: 0, int: 0xFFFF00 }
            ];

            let foundSafe = false;
            for (const c of candidates) {
              let safe = true;
              for (const fi of frameIndices) {
                renderCompositeFrame(fi, tmp);
                const data = tctx.getImageData(0, 0, W, H).data;
                for (let j = 0; j < data.length; j += 4) {
                  if (data[j + 3] > 128 && data[j] === c.r && data[j + 1] === c.g && data[j + 2] === c.b) {
                    safe = false;
                    break;
                  }
                }
                if (!safe) break;
              }
              if (safe) {
                transR = c.r; transG = c.g; transB = c.b;
                transKeyInt = c.int;
                foundSafe = true;
                break;
              }
            }
            if (!foundSafe) {
              console.warn('Could not find a guaranteed unused key color, using magenta default');
            }
          }

          const gif = new GIFCtor({
            workers: 2,
            quality: 10,
            width: W,
            height: H,
            repeat: 0,
            workerScript: workerURL,
            ...(useTransparent ? { transparent: transKeyInt } : {})
          });

          for (const fi of frameIndices) {
            renderCompositeFrame(fi, tmp);
            if (useTransparent) {
              const imgData = tctx.getImageData(0, 0, W, H);
              const data = imgData.data;
              for (let j = 0; j < data.length; j += 4) {
                if (data[j + 3] === 0) {
                  data[j] = transR;
                  data[j + 1] = transG;
                  data[j + 2] = transB;
                  data[j + 3] = 255;
                }
              }
              tctx.putImageData(imgData, 0, 0);
            }
            const frameDelay = getFrameDelayForExport(fi, delay);
            gif.addFrame(tmp, { delay: frameDelay, copy: true, dispose: 2 });
          }

          gif.on('finished', (blob) => {
            triggerBlobDownload(blob, `${fileName}.gif`);
            showToast('GIF exported');
          });
          gif.on?.('progress', (progress) => {
            if (progress && progress < 1) showToast(`Exporting… ${Math.round(progress * 100)}%`);
          });

          showToast('Exporting…');
          try {
            gif.render();
            return;
          } catch (err) {
            console.error('GIF.js render failed, using fallback encoder', err);
          }
        }

        try {
          showToast('Exporting GIF (offline)…');
          const framesForExport = [];
          for (const fi of frameIndices) {
            renderCompositeFrame(fi, tmp);
            const rgba = tctx.getImageData(0, 0, W, H).data;
            framesForExport.push({
              rgba: new Uint8Array(rgba),
              duration: Math.max(1, getFrameDelayForExport(fi, delay) | 0)
            });
          }
          const bytes = buildAnimatedGIFFallbackBytes(W, H, framesForExport, useTransparent);
          triggerBlobDownload(new Blob([bytes], { type: 'image/gif' }), `${fileName}.gif`);
          showToast('GIF exported');
        } catch (err) {
          console.error('Fallback GIF export failed', err);
          const reason = err?.message ? `: ${String(err.message).slice(0, 70)}` : '';
          showToast(`GIF export failed${reason}`);
        }
      }

      async function exportAPNG(customName, frameIndices) {
        if (playing) togglePlay(false);
        const fileName = sanitizeExportName(customName, 'fliplite');

        const tmp = makeCanvas(W, H);
        tmp.getContext('2d').imageSmoothingEnabled = false;
        const fallbackDelay = getDefaultFrameDelay();
        const framesForExport = [];

        for (const fi of frameIndices) {
          renderCompositeFrame(fi, tmp);
          const pngBlob = await canvasToBlobAsync(tmp, 'image/png');
          const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
          const parsed = parseStaticPNGFrameChunks(pngBytes);
          framesForExport.push({
            ihdrData: parsed.ihdrData,
            headerChunks: parsed.headerChunks,
            idatChunks: parsed.idatChunks,
            duration: Math.max(10, getFrameDelayForExport(fi, fallbackDelay) | 0)
          });
        }

        try {
          const bytes = buildAnimatedAPNGBytes(W, H, framesForExport);
          const blob = new Blob([bytes], { type: 'image/apng' });
          triggerBlobDownload(blob, `${fileName}.apng`);
          showToast('APNG exported');
        } catch (err) {
          console.error('APNG export failed', err);
          const reason = err?.message ? `: ${String(err.message).slice(0, 70)}` : '';
          showToast(`APNG export failed${reason}`);
        }
      }

      async function exportPNGFrames(customName, frameIndices) {
        const fileName = sanitizeExportName(customName, 'fliplite');
        const frameEntries = [];
        for (const fi of frameIndices) {
          const can = renderCompositeFrame(fi, makeCanvas(W, H));
          const blob = await canvasToBlobAsync(can, 'image/png');
          frameEntries.push({
            name: `frame-${String(fi + 1).padStart(4, '0')}.png`,
            blob
          });
        }
        try {
          const JSZip = await ensureJSZip();
          const zip = new JSZip();
          const folder = zip.folder(fileName);
          frameEntries.forEach((entry) => {
            folder.file(entry.name, entry.blob);
          });
          const blob = await zip.generateAsync({ type: 'blob' });
          triggerBlobDownload(blob, `${fileName}.zip`);
          showToast('PNG ZIP exported');
          return;
        } catch (err) {
          console.warn('JSZip unavailable, using offline ZIP fallback', err);
        }

        const files = [];
        for (const entry of frameEntries) {
          const bytes = new Uint8Array(await entry.blob.arrayBuffer());
          files.push({
            name: `${fileName}/${entry.name}`,
            bytes
          });
        }
        const zipBlob = buildStoredZipBlob(files);
        triggerBlobDownload(zipBlob, `${fileName}.zip`);
        showToast('PNG ZIP exported');
      }

      async function exportWEBP(customName, frameIndices) {
        if (playing) togglePlay(false);
        const fileName = sanitizeExportName(customName, 'fliplite');

        const tmp = makeCanvas(W, H);
        const tctx = tmp.getContext('2d');
        tctx.imageSmoothingEnabled = false;
        const fallbackDelay = getDefaultFrameDelay();
        const framesForExport = [];
        let hasAlpha = false;

        for (const fi of frameIndices) {
          renderCompositeFrame(fi, tmp);
          const data = tctx.getImageData(0, 0, W, H).data;

          if (!hasAlpha) {
            for (let i = 3; i < data.length; i += 4) {
              if (data[i] !== 255) { hasAlpha = true; break; }
            }
          }

          let webpBlob;
          try {
            webpBlob = await canvasToBlobAsync(tmp, 'image/webp', 0.95);
          } catch (_) {
            webpBlob = await canvasToBlobAsync(tmp, 'image/webp');
          }
          const webpBytes = new Uint8Array(await webpBlob.arrayBuffer());
          const subchunks = parseStaticWebPFrameChunks(webpBytes);

          framesForExport.push({
            subchunks,
            duration: Math.max(10, getFrameDelayForExport(fi, fallbackDelay) | 0)
          });
        }

        if (!framesForExport.length) {
          showToast('No frames to export');
          return;
        }

        try {
          const bg = parseExportBackgroundRGBA();
          const bytes = buildAnimatedWebPBytes(W, H, framesForExport, hasAlpha, bg);
          const blob = new Blob([bytes], { type: 'image/webp' });
          triggerBlobDownload(blob, `${fileName}.webp`);
          showToast('Animated WebP exported');
        } catch (err) {
          console.error('Animated WebP export failed:', err);
          const reason = err?.message ? `: ${String(err.message).slice(0, 70)}` : '';
          showToast(`Animated WebP export failed${reason}`);
        }
      }

      async function runExportFromModal() {
        const type = exportState.type;
        const fallback = type === 'flip' ? 'project' : 'fliplite';
        const name = sanitizeExportName(exportNameInp?.value, fallback);
        exportState.names[type] = name;
        const frameIndices = getExportFrameIndices(type);

        if (type !== 'flip' && frameIndices.length === 0) {
          showToast('No frames to export');
          return;
        }

        closeExportModal();
        try {
          if (type === 'gif') await exportGIF(name, frameIndices);
          else if (type === 'apng') await exportAPNG(name, frameIndices);
          else if (type === 'webp') await exportWEBP(name, frameIndices);
          else if (type === 'png') await exportPNGFrames(name, frameIndices);
          else if (type === 'flip') await saveProjectFlip(name);
        } catch (err) {
          console.error(err);
          showToast('Export failed');
        }
      }


      function clampFPS(v) { v = Math.round(v); if (!Number.isFinite(v)) v = 8; return Math.max(1, Math.min(24, v)); }

      async function saveProjectFlip(customName) {
        if (sel) commitSelectionIfAny();

        const fps = clampFPS(+fpsInp.value || 8);
        const frameData = frames.map(f => {

          const layer1 = makeCanvas(W, H);
          layer1.getContext('2d').drawImage(f.layers[0].can, 0, 0);

          const layer2 = makeCanvas(W, H);
          layer2.getContext('2d').drawImage(f.layers[1].can, 0, 0);

          const bgCan = makeCanvas(W, H);
          bgCan.getContext('2d').drawImage(f.bg.can, 0, 0);

          return {
            bg: bgCan.toDataURL('image/png'),
            delay: f.delay,
            delayModified: f.delayModified,
            layers: [
              {
                data: layer1.toDataURL('image/png'),
                visible: f.layers[0].visible,
                opacity: f.layers[0].opacity
              },
              {
                data: layer2.toDataURL('image/png'),
                visible: f.layers[1].visible,
                opacity: f.layers[1].opacity
              }
            ]
          };
        });

        const proj = {
          kind: 'FlipLiteProject',
          version: 5,
          size: { W, H },
          fps,
          vfrEnabled,
          frames: frameData,
          current,
          activeLayer,
          layerOrder,
          bgSettings: { transparent: bgTransparent, color: bgColor },
          onionSettings: {
            prev: onionPrev,
            next: onionNext,
            maxOpacity: onionMaxOpacity,
            falloff: onionFalloff,
            mode: onionColorMode
          },
          mirror: { h: mirror.h, v: mirror.v },
          palette: window.getPalette ? window.getPalette() : null
        };

        const blob = new Blob([JSON.stringify(proj)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = ((customName && customName.trim()) || 'project') + '.flip';
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        showToast('Project saved (.flip)');
      }

      function loadImage(url) {
        return new Promise((res, rej) => {
          const img = new Image();
          img.onload = () => res(img);
          img.onerror = rej;
          img.src = url;
        });
      }

      async function openProjectFlipFile(file) {

        const proceed = await checkOverwrite();
        if (!proceed) {

          const fi = document.getElementById('flipInput'); if (fi) fi.value = '';
          return;
        }

        if (sel) commitSelectionIfAny();
        try {
          const txt = await file.text();
          const data = JSON.parse(txt);
          if (!data || data.kind !== 'FlipLiteProject') { showToast('Not a FlipLite project'); return; }

          const version = data.version || 2;
          const nW = Math.max(1, Math.min(MAX_W, (data.size?.W | 0) || W));
          const nH = Math.max(1, Math.min(MAX_H, (data.size?.H | 0) || H));


          W = nW; H = nH;
          resetRenderScratchBuffers();
          shapePrev.width = W; shapePrev.height = H;

          const newFrames = [];

          if (version >= 3 && data.frames[0]?.layers) {

            for (const fd of data.frames) {
              const frame = newFrame();
              if (fd.delay !== undefined) frame.delay = fd.delay;
              if (fd.delayModified !== undefined) frame.delayModified = fd.delayModified;


              if (fd.bg) {
                const bgImg = await loadImage(fd.bg);
                frame.bg.ctx.clearRect(0, 0, nW, nH);
                frame.bg.ctx.drawImage(bgImg, 0, 0);
              }


              for (let i = 0; i < 2; i++) {
                if (fd.layers[i]) {
                  const img = await loadImage(fd.layers[i].data);
                  frame.layers[i].ctx.clearRect(0, 0, nW, nH);
                  frame.layers[i].ctx.drawImage(img, 0, 0);
                  frame.layers[i].visible = fd.layers[i].visible ?? true;
                  frame.layers[i].opacity = fd.layers[i].opacity ?? 1;
                }
              }

              newFrames.push(frame);
            }


            if (data.activeLayer !== undefined) activeLayer = data.activeLayer;
            if (data.layerOrder) layerOrder = data.layerOrder;
            if (data.bgSettings) {
              bgTransparent = data.bgSettings.transparent ?? false;
              bgColor = data.bgSettings.color ?? '#ffffff';
            }
          } else {

            for (const dataURL of data.frames) {
              const frame = newFrame();
              const img = await loadImage(dataURL);
              frame.layers[0].ctx.drawImage(img, 0, 0);
              newFrames.push(frame);
            }
          }

          if (newFrames.length === 0) newFrames.push(newFrame());

          frames = newFrames;



          const fps = clampFPS(data.fps || 8);
          fpsInp.value = String(fps);

          if (data.vfrEnabled !== undefined && vfrToggle) {
            vfrEnabled = data.vfrEnabled;
            vfrToggle.checked = vfrEnabled;
          }

          if (data.mirror) {
            mirror.h = !!data.mirror.h;
            mirror.v = !!data.mirror.v;

            const hBtn = document.getElementById('mirrorHBtn');
            const vBtn = document.getElementById('mirrorVBtn');
            if (hBtn) hBtn.classList.toggle('active', mirror.h);
            if (vBtn) vBtn.classList.toggle('active', mirror.v);
          }


          if (data.palette && window.setPalette) {
            window.setPalette(data.palette);
          }

          if (data.onionSettings) {
            onionPrev = data.onionSettings.prev ?? 2;
            onionNext = data.onionSettings.next ?? 2;
            onionMaxOpacity = data.onionSettings.maxOpacity ?? 0.28;
            onionFalloff = data.onionSettings.falloff ?? 0.68;
            onionColorMode = data.onionSettings.mode ?? 'tint';


            if (document.getElementById('onionPrev')) document.getElementById('onionPrev').value = onionPrev;
            if (document.getElementById('onionNext')) document.getElementById('onionNext').value = onionNext;
            if (document.getElementById('onionMaxOpacityPct')) document.getElementById('onionMaxOpacityPct').value = Math.round(onionMaxOpacity * 100);
            if (document.getElementById('onionFalloffPct')) document.getElementById('onionFalloffPct').value = Math.round(onionFalloff * 100);

            const tintBtn = document.getElementById('onionTintBtn');
            const realBtn = document.getElementById('onionRealBtn');
            if (tintBtn && realBtn) {
              tintBtn.classList.toggle('active', onionColorMode === 'tint');
              realBtn.classList.toggle('active', onionColorMode === 'real');
            }
          }

          current = Math.max(0, Math.min(frames.length - 1, data.current | 0));

          canvasSizeTxt.textContent = W + '×' + H;
          updateAllThumbs(); buildFilm(); centerView(); render();
          history.length = 0; redoStack.length = 0;


          const layerItems = document.querySelectorAll('.layerItem');
          const visBtns = document.querySelectorAll('.visBtn');
          const opacitySliders = document.querySelectorAll('.opacitySlider');

          layerItems.forEach(item => {
            const layer = parseInt(item.dataset.layer);
            item.classList.toggle('active', layer === activeLayer);
          });

          visBtns.forEach(btn => {
            const layer = parseInt(btn.dataset.layer);
            btn.classList.toggle('active', frames[current].layers[layer].visible);
          });

          opacitySliders.forEach(slider => {
            const layer = parseInt(slider.dataset.layer);
            slider.value = frames[current].layers[layer].opacity * 100;
          });

          showToast(`Opened .flip . (${frames.length} frame${frames.length > 1 ? 's' : ''})`);
        } catch (err) {
          console.error(err);
          showToast('Failed to load .flip file');
        }
      }


      function ensureBgColorControl() {
        if (document.getElementById('bgColorInput')) return;
        const tRow = bgTransparentInput.closest('.row') || bgTransparentInput.parentElement;
        const newRow = document.createElement('div');
        newRow.className = 'row';
        newRow.innerHTML = `<label for="bgColorInput">Background color</label><input id="bgColorInput" type="color" value="#ffffff" />`;
        tRow.parentElement.insertBefore(newRow, tRow.nextSibling);
        const bgColorInput = document.getElementById('bgColorInput');
        bgColorInput.addEventListener('input', () => { });
        bgTransparentInput.addEventListener('change', () => { document.getElementById('bgColorInput').disabled = !!bgTransparentInput.checked; });
      }

      function openSettings(highlightFPS = false) {
        ensureBgColorControl();
        wInput.max = String(MAX_W); hInput.max = String(MAX_H);
        wInput.value = W; hInput.value = H;
        onionPrevInput.value = onionPrev;
        onionNextInput.value = onionNext;
        onionMaxOpacityPct.value = Math.round(onionMaxOpacity * 100);
        onionFalloffPct.value = Math.round(onionFalloff * 100);
        bgTransparentInput.checked = bgTransparent;

        const fpsNumInput = document.getElementById('fpsNum');
        if (fpsNumInput) {
          fpsNumInput.value = fpsInp.value;
          const fpsArea = document.getElementById('fpsSettingsArea');
          if (highlightFPS && fpsArea) {
            const labels = fpsArea.querySelectorAll('.settings-row-inline label');
            labels.forEach(lbl => lbl.classList.add('highlight-text'));
            setTimeout(() => {
              labels.forEach(lbl => lbl.classList.remove('highlight-text'));
            }, 3000);
            fpsNumInput.focus();
            fpsNumInput.select();
          }
        }

        const bgColorInput = document.getElementById('bgColorInput');
        const bgColorBox = document.getElementById('bgColorBox');
        if (bgColorInput) {
          bgColorInput.value = bgColor;
          bgColorInput.disabled = !!bgTransparent;
        }
        if (bgColorBox) {
          bgColorBox.style.background = bgColor;
          bgColorBox.style.opacity = bgTransparent ? 0.5 : 1;
          bgColorBox.style.pointerEvents = bgTransparent ? 'none' : 'auto';
        }

        const onionTintBtn = document.getElementById('onionTintBtn');
        const onionRealBtn = document.getElementById('onionRealBtn');
        if (onionTintBtn && onionRealBtn) {
          onionTintBtn.classList.toggle('active', onionColorMode === 'tint');
          onionRealBtn.classList.toggle('active', onionColorMode === 'real');
        }
        pendingFilmstripStyle = filmstripStyle;
        updateFilmstripStyleButtons(pendingFilmstripStyle);
        modalBackdrop.style.display = 'flex';
      }
      function closeSettings() { modalBackdrop.style.display = 'none'; }
      document.getElementById('applyResize').addEventListener('click', () => {
        const nw = Math.max(1, Math.min(MAX_W, parseInt(wInput.value, 10) || W));
        const nh = Math.max(1, Math.min(MAX_H, parseInt(hInput.value, 10) || H));
        if (nw !== W || nh !== H) resizeProjectNoScale(nw, nh);

        onionPrev = Math.max(0, Math.min(5, (onionPrevInput.value | 0)));
        onionNext = Math.max(0, Math.min(5, (onionNextInput.value | 0)));
        onionMaxOpacity = Math.max(0.10, Math.min(0.60, (+onionMaxOpacityPct.value) / 100));
        onionFalloff = Math.max(0.40, Math.min(0.90, (+onionFalloffPct.value) / 100));
        bgTransparent = !!bgTransparentInput.checked;

        const bgColorInput = document.getElementById('bgColorInput');
        if (bgColorInput && !bgTransparent) {
          bgColor = bgColorInput.value || '#ffffff';
        }

        applyFilmstripStyle(pendingFilmstripStyle, { persist: true, rebuild: pendingFilmstripStyle !== filmstripStyle });


        frames.forEach(f => {
          const bgCtx = f.bg.ctx;
          bgCtx.clearRect(0, 0, W, H);
          if (!bgTransparent) {
            bgCtx.fillStyle = bgColor;
            bgCtx.fillRect(0, 0, W, H);
          } else {
            bgCtx.fillStyle = '#ffffff';
            bgCtx.fillRect(0, 0, W, H);
            bgCtx.globalAlpha = 0.14;
            bgCtx.fillStyle = bgCtx.createPattern(checkerTile, 'repeat');
            bgCtx.fillRect(0, 0, W, H);
            bgCtx.globalAlpha = 1;
          }
        });

        closeSettings();
        showToast('Settings applied');
        updateAllThumbs();
        render();
      });
      document.getElementById('cancelResize').addEventListener('click', closeSettings);
      modalBackdrop.addEventListener('click', e => { if (e.target === modalBackdrop) closeSettings(); });

      function resizeProjectNoScale(nw, nh) {
        const ow = W, oh = H;
        frames.forEach(f => {
          const dx = Math.floor((nw - ow) / 2), dy = Math.floor((nh - oh) / 2);
          const sx = Math.max(0, -dx), sy = Math.max(0, -dy), sw = Math.min(ow - sx, nw), sh = Math.min(oh - sy, nh);
          const ddx = Math.max(0, dx), ddy = Math.max(0, dy);


          f.layers.forEach(l => {
            const dst = makeCanvas(nw, nh), dctx = dst.getContext('2d'); dctx.imageSmoothingEnabled = false;
            if (sw > 0 && sh > 0) dctx.drawImage(l.can, sx, sy, sw, sh, ddx, ddy, sw, sh);
            l.can = dst; l.ctx = dctx;
          });


          const bgDst = makeCanvas(nw, nh), bgCtx = bgDst.getContext('2d'); bgCtx.imageSmoothingEnabled = false;

          if (!bgTransparent) { bgCtx.fillStyle = bgColor; bgCtx.fillRect(0, 0, nw, nh); }
          else {
            bgCtx.fillStyle = '#ffffff'; bgCtx.fillRect(0, 0, nw, nh);
            bgCtx.globalAlpha = 0.14; bgCtx.fillStyle = bgCtx.createPattern(checkerTile, 'repeat'); bgCtx.fillRect(0, 0, nw, nh); bgCtx.globalAlpha = 1;
          }





          if (sw > 0 && sh > 0) bgCtx.drawImage(f.bg.can, sx, sy, sw, sh, ddx, ddy, sw, sh);
          f.bg.can = bgDst; f.bg.ctx = bgCtx;
        });
        W = nw; H = nh; resetRenderScratchBuffers();
        canvasSizeTxt.textContent = W + '×' + H; updateAllThumbs(); centerView(); render();

        history.length = 0; redoStack.length = 0;
      }


      function setColor(hex) {
        brush.color = hex;

        if (typeof updateBrushPreview === 'function') updateBrushPreview();
        if (typeof updateEraserPreview === 'function') updateEraserPreview();
        if (typeof updateFillPreview === 'function') updateFillPreview();
        if (typeof updateDitherFillPreview === 'function') updateDitherFillPreview();
        if (typeof updateShapePreview === 'function') updateShapePreview();
        if (typeof updateFXPreview === 'function') updateFXPreview();
        if (typeof updateFXTrailPreview === 'function') updateFXTrailPreview();
        if (typeof updateFXOutlinePreview === 'function') updateFXOutlinePreview();
        if (typeof updateFXGlowPreview === 'function') updateFXGlowPreview();
        if (typeof updateLassoPaintDitherPreview === 'function') updateLassoPaintDitherPreview();

        if (typeof updateBrushUI === 'function') updateBrushUI();

        if (currentColorBtn) {
          currentColorBtn.style.backgroundColor = hex;
          currentColorBtn.title = `Current color: ${hex.toUpperCase()}`;
        }

        if (colorInp.value.toLowerCase() !== hex.toLowerCase()) colorInp.value = hex;
      }
      colorInp.addEventListener('input', () => setColor(colorInp.value), { passive: false });


      const defaultPalette = [
        '#000000', '#ff3b30', '#1a1a1a', '#ff2d55', '#333333', '#ff9500',
        '#4d4d4d', '#ffcc00', '#666666', '#34c759', '#808080', '#00a651',
        '#999999', '#5ac8fa', '#b3b3b3', '#007aff', '#cccccc', '#5856d6',
        '#ffffff', '#8e44ad'
      ];


      let palette = [...defaultPalette];
      try {
        const saved = localStorage.getItem('fliplite_palette');
        if (saved) palette = JSON.parse(saved);
      } catch (e) { }

      function savePaletteToStorage() {
        try { localStorage.setItem('fliplite_palette', JSON.stringify(palette)); } catch (e) { }
      }


      let selectedSwatchIdx = 0;

      function buildSwatches() {
        swatches.innerHTML = '';
        palette.forEach((col, idx) => {
          const s = document.createElement('div');
          s.className = 'swatch' + (col === '#ffffff' ? ' white' : '') + (idx === selectedSwatchIdx ? ' selected' : '');
          s.style.background = col;
          s.title = col.toUpperCase() + ' (double-click or right-click to change)';
          s.onclick = () => {
            selectedSwatchIdx = idx;
            setColor(col);
            updateSwatchSelection();
          };


          const editSwatch = async () => {
            const prevBrushColor = brush.color;
            const isSelectedSwatch = selectedSwatchIdx === idx;
            const newColor = await openColorPicker(col, {
              onLiveColor: (liveHex) => {
                if (isSelectedSwatch) setColor(liveHex.toLowerCase());
              }
            });
            if (newColor) {
              palette[idx] = newColor.toLowerCase();
              savePaletteToStorage();
              buildSwatches();
              setColor(newColor);
            } else if (isSelectedSwatch) {
              setColor(prevBrushColor);
            }
          };


          s.addEventListener('dblclick', (e) => {
            e.preventDefault();
            e.stopPropagation();
            editSwatch();
          });


          s.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            editSwatch();
          });

          swatches.appendChild(s);
        });
      }


      function updateSwatchSelection() {
        const all = swatches.querySelectorAll('.swatch');
        all.forEach((s, i) => s.classList.toggle('selected', i === selectedSwatchIdx));
      }


      function exportPalette() {
        const blob = new Blob([JSON.stringify(palette, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'fliplite_palette.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        showToast('Palette exported');
      }


      function importPalette() {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.accept = '.json,application/json';
        inp.onchange = async () => {
          if (!inp.files.length) return;
          try {
            const text = await inp.files[0].text();
            const arr = JSON.parse(text);
            if (Array.isArray(arr) && arr.every(c => typeof c === 'string' && c.startsWith('#'))) {
              palette = arr;
              savePaletteToStorage();
              buildSwatches();
              showToast('Palette imported');
            } else {
              showToast('Invalid palette file');
            }
          } catch (e) {
            showToast('Failed to import palette');
          }
        };
        inp.click();
      }


      function resetPalette() {
        palette = [...defaultPalette];
        savePaletteToStorage();
        buildSwatches();


        if (typeof selectedSwatchIdx !== 'undefined' && selectedSwatchIdx >= 0 && selectedSwatchIdx < palette.length) {
          setColor(palette[selectedSwatchIdx]);
        } else {

          if (palette.length > 0) setColor(palette[0]);
        }

        showToast('Palette reset to defaults');
      }


      window.getPalette = () => [...palette];
      window.setPalette = (arr) => {
        if (Array.isArray(arr) && arr.length > 0) {
          palette = arr;
          savePaletteToStorage();
          buildSwatches();
        }
      };

      buildSwatches();

      if (currentColorBtn) {
        currentColorBtn.addEventListener('click', async (e) => {
          e.preventDefault();
          const prevColor = brush.color;
          const picked = await openColorPicker(brush.color, {
            onLiveColor: (liveHex) => setColor(liveHex.toLowerCase())
          });
          if (picked) setColor(picked.toLowerCase());
          else setColor(prevColor);
        }, { passive: false });
      }

      pickBtn.addEventListener('click', () => {
        setPickingEnabled(!picking);
      }, { passive: false });


      const paletteExportBtn = document.getElementById('paletteExportBtn');
      const paletteImportBtn = document.getElementById('paletteImportBtn');
      const paletteResetBtn = document.getElementById('paletteResetBtn');
      if (paletteExportBtn) paletteExportBtn.addEventListener('click', exportPalette);
      if (paletteImportBtn) paletteImportBtn.addEventListener('click', importPalette);
      if (paletteResetBtn) paletteResetBtn.addEventListener('click', resetPalette);


      const brushPreview = document.getElementById('brushPreview');
      const bpCtx = brushPreview ? brushPreview.getContext('2d') : null;

      function updateBrushPreview() {
        if (!bpCtx) return;
        bpCtx.clearRect(0, 0, 32, 32);
        bpCtx.fillStyle = brush.color;
        const s = brush.size;
        const l = brush.ditherLevel;
        const lim = ditherLimit(l);
        const ox = 16 - Math.floor(s / 2);
        const oy = 16 - Math.floor(s / 2);


        const r = s / 2, r2 = r * r;
        const cx = s / 2 - 0.5, cy = s / 2 - 0.5;

        for (let dy = 0; dy < s; dy++) {
          for (let dx = 0; dx < s; dx++) {
            const ddx = dx - cx, ddy = dy - cy;
            if (ddx * ddx + ddy * ddy <= r2 + 0.1) {
              if (lim === null) {
                bpCtx.fillRect(ox + dx, oy + dy, 1, 1);
              } else {

                const mx = (ox + dx) & 3, my = (oy + dy) & 3;
                if (BAYER4[my][mx] < lim) bpCtx.fillRect(ox + dx, oy + dy, 1, 1);
              }
            }
          }
        }
      }

      sizeInp.addEventListener('input', () => { brush.size = +sizeInp.value || 2; sizeVal.textContent = brush.size + ' px'; setRangeProgress(sizeInp); updateBrushPreview(); }, { passive: true }); setRangeProgress(sizeInp);

      const smudgeSettings = document.getElementById('smudgeSettings');
      const smudgeSizeInp = document.getElementById('smudgeSize');
      const smudgeSizeVal = document.getElementById('smudgeSizeVal');
      if (smudgeSizeInp) {
        setRangeProgress(smudgeSizeInp);
        smudgeSizeInp.addEventListener('input', () => {
          smudge.size = +smudgeSizeInp.value || 10;
          smudgeSizeVal.textContent = smudge.size + ' px';
          setRangeProgress(smudgeSizeInp);
        }, { passive: true });
      }
      const smudgeStrInp = document.getElementById('smudgeStrength');
      const smudgeStrVal = document.getElementById('smudgeStrengthVal');
      if (smudgeStrInp) {
        setRangeProgress(smudgeStrInp);
        smudgeStrInp.addEventListener('input', () => {
          smudge.strength = +smudgeStrInp.value || 50;
          smudgeStrVal.textContent = smudge.strength + '%';
          setRangeProgress(smudgeStrInp);
        }, { passive: true });
      }
      const smudgeBtns = ['smudgeModeNormal', 'smudgeModeDither', 'smudgeModeGlitch', 'smudgeModeBlock'];
      const smudgeModes = ['N', 'D', 'G', 'B'];
      smudgeBtns.forEach((id, idx) => {
        const btn = document.getElementById(id);
        if (btn) {
          btn.addEventListener('click', () => {
            smudge.mode = smudgeModes[idx];
            smudgeBtns.forEach(bid => {
              const b = document.getElementById(bid);
              if (b) b.classList.remove('active-mode');
            });
            btn.classList.add('active-mode');
          });
        }
      });

      const fxMiniPanel = document.getElementById('fxMiniPanel');
      const topControls = document.getElementById('topControls');
      if (fxSettings && topControls && fxSettings.parentElement !== topControls) {
        topControls.appendChild(fxSettings);
      }
      if (fxMiniPanel && topControls && fxMiniPanel.parentElement !== topControls) {
        topControls.appendChild(fxMiniPanel);
      }
      if (fxSettings && fxMiniPanel && topControls) {
        const desiredAfter = fxSettings.nextElementSibling;
        if (desiredAfter !== fxMiniPanel) {
          topControls.insertBefore(fxMiniPanel, desiredAfter);
        }
      }

      const fxPreviewCtx = fxPreviewCanvas ? fxPreviewCanvas.getContext('2d') : null;
      const fxTrailPanel = document.getElementById('fxTrailPanel');
      const fxOutlinePanel = document.getElementById('fxOutlinePanel');
      const fxGlowPanel = document.getElementById('fxGlowPanel');
      const fxLassoFillPanel = document.getElementById('fxLassoFillPanel');
      const fxTrailPreviewCanvas = document.getElementById('fxTrailPreview');
      const fxTrailPreviewCtx = fxTrailPreviewCanvas ? fxTrailPreviewCanvas.getContext('2d') : null;
      const fxOutlinePreviewCanvas = document.getElementById('fxOutlinePreview');
      const fxOutlinePreviewCtx = fxOutlinePreviewCanvas ? fxOutlinePreviewCanvas.getContext('2d') : null;
      const fxGlowPreviewCanvas = document.getElementById('fxGlowPreview');
      const fxGlowPreviewCtx = fxGlowPreviewCanvas ? fxGlowPreviewCanvas.getContext('2d') : null;
      const fxModeTrailBtn = document.getElementById('fxModeTrail');
      const fxModeOutlineBtn = document.getElementById('fxModeOutline');
      const fxModeGlowBtn = document.getElementById('fxModeGlow');
      const fxModeLassoFillBtn = document.getElementById('fxModeLassoFill');
      const fxTrailSizeInp = document.getElementById('fxTrailSize');
      const fxTrailSizeVal = document.getElementById('fxTrailSizeVal');
      const fxTrailSpacingInp = document.getElementById('fxTrailSpacing');
      const fxTrailSpacingVal = document.getElementById('fxTrailSpacingVal');
      const fxTrailVariationInp = document.getElementById('fxTrailVariation');
      const fxTrailVariationVal = document.getElementById('fxTrailVariationVal');
      const fxTrailShapeSel = document.getElementById('fxTrailShape');
      const fxOutlineThicknessInp = document.getElementById('fxOutlineThickness');
      const fxOutlineThicknessVal = document.getElementById('fxOutlineThicknessVal');
      const fxOutlineGapInp = document.getElementById('fxOutlineGap');
      const fxOutlineGapVal = document.getElementById('fxOutlineGapVal');
      const fxGlowRadiusInp = document.getElementById('fxGlowRadius');
      const fxGlowRadiusVal = document.getElementById('fxGlowRadiusVal');
      const fxGlowGapInp = document.getElementById('fxGlowGap');
      const fxGlowGapVal = document.getElementById('fxGlowGapVal');
      const fxGlowDitherInp = document.getElementById('fxGlowDither');
      const fxGlowDitherVal = document.getElementById('fxGlowDitherVal');
      const lassoPaintDitherInp = document.getElementById('lassoPaintDither');
      const lassoPaintDitherPreviewCanvas = document.getElementById('lassoPaintDitherPreview');
      const lassoPaintDitherPreviewCtx = lassoPaintDitherPreviewCanvas ? lassoPaintDitherPreviewCanvas.getContext('2d', { willReadFrequently: true }) : null;
      const lassoPaintDitherVal = document.getElementById('lassoPaintDitherVal');

      function updateFXOutlinePreview() {
        if (!fxOutlinePreviewCtx || !fxOutlinePreviewCanvas) return;
        const pw = fxOutlinePreviewCanvas.width | 0;
        const ph = fxOutlinePreviewCanvas.height | 0;
        fxOutlinePreviewCtx.clearRect(0, 0, pw, ph);
        fxOutlinePreviewCtx.fillStyle = brush.color;
        const shapeW = Math.max(30, Math.min(pw - 8, 56));
        const shapeH = Math.max(18, Math.min(ph - 8, 30));
        const innerX = Math.floor((pw - shapeW) / 2);
        const innerY = Math.floor((ph - shapeH) / 2);
        const baseMask = new Uint8Array(pw * ph);
        const component = [];
        const outlineMask = new Uint8Array(pw * ph);
        const gapRadius = Math.max(0, fx.outline.gap | 0);
        const outerRadius = Math.max(1, gapRadius + Math.max(1, fx.outline.thickness | 0));
        const outerOffsets = getOutlineRadiusOffsets(outerRadius);
        const gapOffsets = gapRadius > 0 ? getOutlineRadiusOffsets(gapRadius) : null;
        const outerCandidates = new Set();
        const gapCandidates = gapOffsets ? new Set() : null;

        for (let y = innerY; y < innerY + shapeH; y++) {
          for (let x = innerX; x < innerX + shapeW; x++) {
            if (x < 0 || y < 0 || x >= pw || y >= ph) continue;
            const idx = y * pw + x;
            baseMask[idx] = 1;
            component.push(idx);
          }
        }
        fxOutlinePreviewCtx.globalAlpha = 0.22;
        fxOutlinePreviewCtx.fillRect(innerX, innerY, shapeW, shapeH);
        fxOutlinePreviewCtx.globalAlpha = 1;

        for (let i = 0; i < component.length; i++) {
          const idx = component[i];
          const x = idx % pw;
          const y = (idx / pw) | 0;

          for (let j = 0; j < outerOffsets.length; j++) {
            const off = outerOffsets[j];
            const nx = x + off[0];
            const ny = y + off[1];
            if (nx < 0 || ny < 0 || nx >= pw || ny >= ph) continue;
            const nidx = ny * pw + nx;
            if (baseMask[nidx]) continue;
            outerCandidates.add(nidx);
          }

          if (!gapCandidates) continue;
          for (let j = 0; j < gapOffsets.length; j++) {
            const off = gapOffsets[j];
            const nx = x + off[0];
            const ny = y + off[1];
            if (nx < 0 || ny < 0 || nx >= pw || ny >= ph) continue;
            const nidx = ny * pw + nx;
            if (baseMask[nidx]) continue;
            gapCandidates.add(nidx);
          }
        }

        outerCandidates.forEach((nidx) => {
          if (gapCandidates && gapCandidates.has(nidx)) return;
          const nx = nidx % pw;
          const ny = (nidx / pw) | 0;
          if (!shouldPaintFXOutlinePixel(nx, ny)) return;
          outlineMask[nidx] = 1;
        });

        for (let idx = 0; idx < outlineMask.length; idx++) {
          if (!outlineMask[idx]) continue;
          fxOutlinePreviewCtx.fillRect(idx % pw, (idx / pw) | 0, 1, 1);
        }
      }
      function updateFXTrailPreview() {
        if (!fxTrailPreviewCtx || !fxTrailPreviewCanvas) return;
        const pw = fxTrailPreviewCanvas.width | 0;
        const ph = fxTrailPreviewCanvas.height | 0;
        fxTrailPreviewCtx.clearRect(0, 0, pw, ph);
        fxTrailPreviewCtx.fillStyle = brush.color;
        const vary = Math.max(0, Math.min(100, fx.trail.variation | 0)) / 100;
        const spacing = Math.max(1, fx.trail.spacing | 0);
        const baseSize = Math.max(1, fx.trail.size | 0);
        const amp = 7;
        const centerY = Math.round(ph * 0.52);
        const shape = fx.trail.shape;

        const drawStamp = (cx, cy, size) => {
          const s = Math.max(1, size | 0);
          if (shape === 'grass') {
            const h = Math.max(2, Math.round(s * 1.4));
            for (let i = 0; i < h; i++) {
              const px = cx + (((i % 2) === 0) ? 0 : 1);
              const py = cy - i;
              if (px >= 0 && py >= 0 && px < pw && py < ph) fxTrailPreviewCtx.fillRect(px, py, 1, 1);
            }
            return;
          }
          const ox = Math.round(cx - Math.floor(s / 2));
          const oy = Math.round(cy - Math.floor(s / 2));
          const r = s / 2;
          const ccx = s / 2 - 0.5;
          const ccy = s / 2 - 0.5;
          const diamondR = Math.max(1, Math.floor(s / 2));
          for (let dy = 0; dy < s; dy++) {
            for (let dx = 0; dx < s; dx++) {
              let paint = false;
              if (shape === 'square') paint = true;
              else if (shape === 'diamond') paint = Math.abs(dx - ccx) + Math.abs(dy - ccy) <= diamondR + 0.35;
              else {
                const ddx = dx - ccx;
                const ddy = dy - ccy;
                paint = ddx * ddx + ddy * ddy <= r * r + 0.1;
              }
              if (!paint) continue;
              const px = ox + dx;
              const py = oy + dy;
              if (px >= 0 && py >= 0 && px < pw && py < ph) fxTrailPreviewCtx.fillRect(px, py, 1, 1);
            }
          }
        };

        for (let px = 10; px <= pw - 10; px += spacing) {
          const wave = Math.sin(px * 0.24 + 0.6) * amp * 0.55 + Math.cos(px * 0.11 + 1.1) * amp * 0.18;
          const py = Math.round(centerY + wave);
          const jitterScale = 1 + Math.sin(px * 0.31 + 1.7) * vary * 0.65;
          const stampSize = Math.max(1, Math.round(baseSize * jitterScale));
          drawStamp(px, py, stampSize);
        }
      }

      function updateFXGlowPreview() {
        if (!fxGlowPreviewCtx || !fxGlowPreviewCanvas) return;
        const pw = fxGlowPreviewCanvas.width | 0;
        const ph = fxGlowPreviewCanvas.height | 0;
        fxGlowPreviewCtx.clearRect(0, 0, pw, ph);
        const radius = Math.max(1, fx.glow.radius | 0);
        const gap = Math.max(0, fx.glow.gap | 0);
        const outerRadius = Math.max(1, radius + gap);
        const dither = Math.max(1, Math.min(10, fx.glow.dither | 0));
        const baseLimit = ditherLimit(dither) || 8;
        const w = Math.min(28, pw - 20);
        const h = Math.min(20, ph - 16);
        const x0 = Math.floor((pw - w) / 2);
        const y0 = Math.floor((ph - h) / 2);
        const baseMask = new Uint8Array(pw * ph);
        const ringDistance = new Int16Array(pw * ph);
        ringDistance.fill(32767);
        const touchCount = new Uint8Array(pw * ph);
        const boundary = [];
        const outer = getOutlineRadiusOffsets(outerRadius);

        fxGlowPreviewCtx.fillStyle = brush.color;
        for (let y = y0; y < y0 + h; y++) {
          for (let x = x0; x < x0 + w; x++) {
            baseMask[y * pw + x] = 1;
            fxGlowPreviewCtx.fillRect(x, y, 1, 1);
            if (x === x0 || x === x0 + w - 1 || y === y0 || y === y0 + h - 1) {
              boundary.push(y * pw + x);
            }
          }
        }

        for (let i = 0; i < boundary.length; i++) {
          const idx = boundary[i];
          const bx = idx % pw;
          const by = (idx / pw) | 0;
          for (let j = 0; j < outer.length; j++) {
            const off = outer[j];
            const nx = bx + off[0];
            const ny = by + off[1];
            if (nx < 0 || ny < 0 || nx >= pw || ny >= ph) continue;
            const nidx = ny * pw + nx;
            if (baseMask[nidx]) continue;
            const dist = Math.max(Math.abs(off[0]), Math.abs(off[1]));
            if (dist <= gap || dist > outerRadius) continue;
            const ring = dist - gap;
            if (ring < 1 || ring > radius) continue;
            if (ring < ringDistance[nidx]) ringDistance[nidx] = ring;
            if (touchCount[nidx] < 255) touchCount[nidx]++;
          }
        }

        for (let nidx = 0; nidx < ringDistance.length; nidx++) {
          const ring = ringDistance[nidx];
          if (ring === 32767) continue;
          const nx = nidx % pw;
          const ny = (nidx / pw) | 0;
          const edgeBoost = Math.min(4, touchCount[nidx] | 0);
          const localLimit = Math.max(1, Math.min(15, baseLimit + (radius - ring) + edgeBoost - 2));
          if (BAYER4[ny & 3][nx & 3] >= localLimit) continue;
          fxGlowPreviewCtx.fillRect(nx, ny, 1, 1);
        }
      }
      function updateLassoPaintDitherPreview() {
        if (!lassoPaintDitherPreviewCtx || !lassoPaintDitherPreviewCanvas) return;
        const pw = lassoPaintDitherPreviewCanvas.width | 0;
        const ph = lassoPaintDitherPreviewCanvas.height | 0;
        lassoPaintDitherPreviewCtx.clearRect(0, 0, pw, ph);
        lassoPaintDitherPreviewCtx.imageSmoothingEnabled = false;

        lassoPaintDitherPreviewCtx.fillStyle = '#fff';
        lassoPaintDitherPreviewCtx.fillRect(0, 0, pw, ph);
        lassoPaintDitherPreviewCtx.globalAlpha = 0.14;
        lassoPaintDitherPreviewCtx.fillStyle = lassoPaintDitherPreviewCtx.createPattern(checkerTile, 'repeat');
        lassoPaintDitherPreviewCtx.fillRect(0, 0, pw, ph);
        lassoPaintDitherPreviewCtx.globalAlpha = 1;

        const [r, g, b] = hexToRGBA(brush.color);
        const lim = ditherLimit(Math.max(0, Math.min(10, lassoPaint.dither | 0)));
        lassoPaintDitherPreviewCtx.fillStyle = `rgb(${r},${g},${b})`;
        for (let y = 0; y < ph; y++) {
          const by = y & 3;
          for (let x = 0; x < pw; x++) {
            if (lim !== null && BAYER4[by][x & 3] >= lim) continue;
            lassoPaintDitherPreviewCtx.fillRect(x, y, 1, 1);
          }
        }
      }

      function updateFXPreview() {
        if (!fxPreviewCtx || !fxPreviewCanvas) return;
        const pw = fxPreviewCanvas.width | 0;
        const ph = fxPreviewCanvas.height | 0;
        fxPreviewCtx.clearRect(0, 0, pw, ph);
        fxPreviewCtx.fillStyle = brush.color;
        const cx = Math.floor(pw / 2);
        const cy = Math.floor(ph / 2);
        if (fx.mode === 'trail') {
          const s = Math.max(1, fx.trail.size | 0);
          const ox = cx - Math.floor(s / 2);
          const oy = cy - Math.floor(s / 2);
          for (let dy = 0; dy < s; dy++) {
            for (let dx = 0; dx < s; dx++) {
              fxPreviewCtx.fillRect(ox + dx, oy + dy, 1, 1);
            }
          }
        } else if (fx.mode === 'outline') {
          const t = Math.max(1, fx.outline.thickness | 0);
          const x0 = Math.max(1, cx - 10);
          const y0 = Math.max(1, cy - 10);
          const w = 20;
          fxPreviewCtx.fillRect(x0, y0, w, t);
          fxPreviewCtx.fillRect(x0, y0 + w - t, w, t);
          fxPreviewCtx.fillRect(x0, y0, t, w);
          fxPreviewCtx.fillRect(x0 + w - t, y0, t, w);
        } else if (fx.mode === 'glow') {
          const r = Math.max(1, fx.glow.radius | 0);
          const x0 = cx - 8;
          const y0 = cy - 6;
          for (let y = y0; y < y0 + 12; y++) {
            for (let x = x0; x < x0 + 16; x++) fxPreviewCtx.fillRect(x, y, 1, 1);
          }
          for (let y = y0 - r; y < y0 + 12 + r; y++) {
            for (let x = x0 - r; x < x0 + 16 + r; x++) {
              if (x >= x0 && x < x0 + 16 && y >= y0 && y < y0 + 12) continue;
              if (BAYER4[y & 3][x & 3] >= 7) continue;
              fxPreviewCtx.fillRect(x, y, 1, 1);
            }
          }
        }
      }

      function updateFXPanelVisibility() {
        const isFxTool = tool === 'fx';
        if (fxSettings) fxSettings.style.display = isFxTool ? 'flex' : 'none';
        if (fxMiniPanel) fxMiniPanel.style.display = isFxTool ? 'flex' : 'none';
        if (fxTrailPanel) fxTrailPanel.style.display = (isFxTool && fx.mode === 'trail') ? 'flex' : 'none';
        if (fxOutlinePanel) fxOutlinePanel.style.display = (isFxTool && fx.mode === 'outline') ? 'flex' : 'none';
        if (fxGlowPanel) fxGlowPanel.style.display = (isFxTool && fx.mode === 'glow') ? 'flex' : 'none';
        if (fxLassoFillPanel) fxLassoFillPanel.style.display = (isFxTool && fx.mode === 'lassoFill') ? 'flex' : 'none';
      }

      function updateFXModeUI() {
        if (!['trail', 'outline', 'glow', 'lassoFill'].includes(fx.mode)) fx.mode = 'trail';
        fx.outline.flood = true;
        fx.outline.gap = Math.max(0, fx.outline.gap | 0);
        fx.glow.radius = Math.max(1, fx.glow.radius | 0);
        fx.glow.gap = Math.max(0, fx.glow.gap | 0);
        fx.glow.dither = Math.max(1, Math.min(10, fx.glow.dither | 0));
        lassoPaint.dither = Math.max(0, Math.min(10, lassoPaint.dither | 0));
        if (fxModeTrailBtn) fxModeTrailBtn.classList.toggle('active', fx.mode === 'trail');
        if (fxModeOutlineBtn) fxModeOutlineBtn.classList.toggle('active', fx.mode === 'outline');
        if (fxModeGlowBtn) fxModeGlowBtn.classList.toggle('active', fx.mode === 'glow');
        if (fxModeLassoFillBtn) fxModeLassoFillBtn.classList.toggle('active', fx.mode === 'lassoFill');
        if (lassoPaintDitherInp) {
          if (lassoPaintDitherInp.value !== String(lassoPaint.dither)) lassoPaintDitherInp.value = String(lassoPaint.dither);
          if (lassoPaintDitherVal) lassoPaintDitherVal.textContent = lassoPaint.dither === 0 ? 'Off' : String(lassoPaint.dither);
          setRangeProgress(lassoPaintDitherInp);
        }
        updateLassoPaintDitherPreview();
        if (fxOutlineGapInp) {
          if (fxOutlineGapInp.value !== String(fx.outline.gap)) fxOutlineGapInp.value = String(fx.outline.gap);
          if (fxOutlineGapVal) fxOutlineGapVal.textContent = fx.outline.gap + ' px';
          setRangeProgress(fxOutlineGapInp);
        }
        updateFXTrailPreview();
        updateFXGlowPreview();
        updateFXPreview();
        updateFXOutlinePreview();
        updateFXPanelVisibility();
      }

      if (fxModeTrailBtn) fxModeTrailBtn.addEventListener('click', () => {
        if (tool !== 'fx') setTool('fx');
        fx.mode = 'trail';
        updateFXModeUI();
        render();
      });
      if (fxModeOutlineBtn) fxModeOutlineBtn.addEventListener('click', () => {
        if (tool !== 'fx') setTool('fx');
        fx.mode = 'outline';
        updateFXModeUI();
        render();
      });
      if (fxModeGlowBtn) fxModeGlowBtn.addEventListener('click', () => {
        if (tool !== 'fx') setTool('fx');
        fx.mode = 'glow';
        updateFXModeUI();
        render();
      });
      if (fxModeLassoFillBtn) fxModeLassoFillBtn.addEventListener('click', () => {
        if (tool !== 'fx') setTool('fx');
        fx.mode = 'lassoFill';
        updateFXModeUI();
        render();
      });

      if (lassoPaintDitherInp) {
        lassoPaintDitherInp.addEventListener('input', () => {
          lassoPaint.dither = Math.max(0, Math.min(10, +lassoPaintDitherInp.value || 0));
          if (lassoPaintDitherVal) lassoPaintDitherVal.textContent = lassoPaint.dither === 0 ? 'Off' : String(lassoPaint.dither);
          setRangeProgress(lassoPaintDitherInp);
          updateLassoPaintDitherPreview();
        }, { passive: true });
        setRangeProgress(lassoPaintDitherInp);
      }

      if (fxTrailSizeInp) {
        fxTrailSizeInp.addEventListener('input', () => {
          fx.trail.size = +fxTrailSizeInp.value || 1;
          if (fxTrailSizeVal) fxTrailSizeVal.textContent = fx.trail.size + ' px';
          setRangeProgress(fxTrailSizeInp);
          updateFXTrailPreview();
          updateFXPreview();
        }, { passive: true });
        setRangeProgress(fxTrailSizeInp);
      }
      if (fxTrailSpacingInp) {
        fxTrailSpacingInp.addEventListener('input', () => {
          fx.trail.spacing = +fxTrailSpacingInp.value || 1;
          if (fxTrailSpacingVal) fxTrailSpacingVal.textContent = fx.trail.spacing + ' px';
          setRangeProgress(fxTrailSpacingInp);
          updateFXTrailPreview();
        }, { passive: true });
        setRangeProgress(fxTrailSpacingInp);
      }
      if (fxTrailVariationInp) {
        fxTrailVariationInp.addEventListener('input', () => {
          fx.trail.variation = +fxTrailVariationInp.value || 0;
          if (fxTrailVariationVal) fxTrailVariationVal.textContent = fx.trail.variation + '%';
          setRangeProgress(fxTrailVariationInp);
          updateFXTrailPreview();
          updateFXPreview();
        }, { passive: true });
        setRangeProgress(fxTrailVariationInp);
      }
      if (fxTrailShapeSel) fxTrailShapeSel.addEventListener('change', () => {
        fx.trail.shape = fxTrailShapeSel.value;
        updateFXTrailPreview();
        updateFXPreview();
        fxTrailShapeSel.blur();
      });
      if (fxOutlineThicknessInp) {
        fxOutlineThicknessInp.addEventListener('input', () => {
          fx.outline.thickness = +fxOutlineThicknessInp.value || 1;
          if (fxOutlineThicknessVal) fxOutlineThicknessVal.textContent = fx.outline.thickness + ' px';
          setRangeProgress(fxOutlineThicknessInp);
          updateFXPreview();
          updateFXOutlinePreview();
        }, { passive: true });
        setRangeProgress(fxOutlineThicknessInp);
      }
      if (fxOutlineGapInp) {
        fxOutlineGapInp.addEventListener('input', () => {
          fx.outline.gap = +fxOutlineGapInp.value || 0;
          if (fxOutlineGapVal) fxOutlineGapVal.textContent = fx.outline.gap + ' px';
          setRangeProgress(fxOutlineGapInp);
          updateFXPreview();
          updateFXOutlinePreview();
        }, { passive: true });
        setRangeProgress(fxOutlineGapInp);
      }

      if (fxGlowRadiusInp) {
        fxGlowRadiusInp.addEventListener('input', () => {
          fx.glow.radius = +fxGlowRadiusInp.value || 1;
          if (fxGlowRadiusVal) fxGlowRadiusVal.textContent = fx.glow.radius + ' px';
          setRangeProgress(fxGlowRadiusInp);
          updateFXGlowPreview();
          updateFXPreview();
        }, { passive: true });
        setRangeProgress(fxGlowRadiusInp);
      }
      if (fxGlowGapInp) {
        fxGlowGapInp.addEventListener('input', () => {
          fx.glow.gap = +fxGlowGapInp.value || 0;
          if (fxGlowGapVal) fxGlowGapVal.textContent = fx.glow.gap + ' px';
          setRangeProgress(fxGlowGapInp);
          updateFXGlowPreview();
          updateFXPreview();
        }, { passive: true });
        setRangeProgress(fxGlowGapInp);
      }
      if (fxGlowDitherInp) {
        fxGlowDitherInp.addEventListener('input', () => {
          fx.glow.dither = +fxGlowDitherInp.value || 1;
          if (fxGlowDitherVal) fxGlowDitherVal.textContent = String(fx.glow.dither);
          setRangeProgress(fxGlowDitherInp);
          updateFXGlowPreview();
        }, { passive: true });
        setRangeProgress(fxGlowDitherInp);
      }


      updateFXModeUI();

      if (pressureBtn) pressureBtn.addEventListener('click', () => {
        brush.usePressure = !brush.usePressure;
        pressureBtn.classList.toggle('pressure-on', brush.usePressure);
        pressureBtn.title = `Pressure Sensitivity: ${brush.usePressure ? 'ON' : 'OFF'}`;
        document.getElementById('brushPressureMenu').style.display = brush.usePressure ? 'flex' : 'none';
        showToast(`Pressure: ${brush.usePressure ? 'ON' : 'OFF'}`);
      });
      if (eraserPressureBtn) eraserPressureBtn.addEventListener('click', () => {
        eraser.usePressure = !eraser.usePressure;
        eraserPressureBtn.classList.toggle('pressure-on', eraser.usePressure);
        eraserPressureBtn.title = `Pressure Sensitivity: ${eraser.usePressure ? 'ON' : 'OFF'}`;
        document.getElementById('eraserPressureMenu').style.display = eraser.usePressure ? 'flex' : 'none';
        showToast(`Pressure: ${eraser.usePressure ? 'ON' : 'OFF'}`);
      });


      const pressureSensInp = document.getElementById('pressureSens');
      if (pressureSensInp) pressureSensInp.addEventListener('input', () => {
        brush.pressureSens = +pressureSensInp.value;
        setRangeProgress(pressureSensInp);
      }, { passive: true });
      if (pressureSensInp) { setRangeProgress(pressureSensInp); }
      if (+ditherInp.value === 0) setRangeProgress(ditherInp);
      ditherInp.addEventListener('input', () => { brush.ditherLevel = +ditherInp.value || 0; ditherVal.textContent = brush.ditherLevel === 0 ? 'Off' : brush.ditherLevel; setRangeProgress(ditherInp); updateBrushPreview(); }, { passive: true }); setRangeProgress(ditherInp);


      const eraserPreview = document.getElementById('eraserPreview');
      const epCtx = eraserPreview ? eraserPreview.getContext('2d') : null;


      const shapePreviewCanvas = document.getElementById('shapePreview');
      const spCtx = shapePreviewCanvas ? shapePreviewCanvas.getContext('2d') : null;
      setColor('#000000');
      const eraserSizeInp = document.getElementById('eraserSize');
      const eraserSizeVal = document.getElementById('eraserSizeVal');
      const eraserDitherInp = document.getElementById('eraserDither');
      const eraserDitherVal = document.getElementById('eraserDitherVal');
      const brushSettings = document.getElementById('brushSettings');
      const eraserSettings = document.getElementById('eraserSettings');

      function updateEraserPreview() {
        if (!epCtx) return;
        epCtx.imageSmoothingEnabled = false;


        epCtx.clearRect(0, 0, 32, 32);

        const s = eraser.size;

        const l = eraser.ditherLevel;
        const lim = ditherLimit(l);

        const ox = 16 - Math.floor(s / 2);
        const oy = 16 - Math.floor(s / 2);
        const r = s / 2, r2 = r * r;
        const cx = s / 2 - 0.5, cy = s / 2 - 0.5;


        epCtx.globalCompositeOperation = 'source-over';
        epCtx.fillStyle = brush.color;
        epCtx.fillRect(0, 0, 32, 32);


        epCtx.globalCompositeOperation = 'destination-out';

        for (let dy = 0; dy < s; dy++) {
          for (let dx = 0; dx < s; dx++) {
            const ddx = dx - cx, ddy = dy - cy;
            if (ddx * ddx + ddy * ddy <= r2 + 0.1) {
              if (lim === null) {

                epCtx.fillRect(ox + dx, oy + dy, 1, 1);
              } else {



                const mx = (ox + dx) & 3, my = (oy + dy) & 3;
                if (BAYER4[my][mx] < lim) {
                  epCtx.fillRect(ox + dx, oy + dy, 1, 1);
                }
              }
            }
          }
        }


        epCtx.globalCompositeOperation = 'source-over';
      }




      function updateShapePreview() {
        if (!spCtx) return;
        spCtx.clearRect(0, 0, 32, 32);


        const s = Math.max(1, shapeState.size);
        const l = shapeState.dither;
        const lim = ditherLimit(l);
        const col = brush.color;

        spCtx.fillStyle = col;


        function plot(x, y) {
          if (x < 0 || x >= 32 || y < 0 || y >= 32) return;
          if (lim !== null) {
            const mx = x & 3, my = y & 3;
            if (BAYER4[my][mx] >= lim) return;
          }
          spCtx.fillRect(x, y, 1, 1);
        }

        function fillRect(x, y, w, h) {
          for (let dy = 0; dy < h; dy++)
            for (let dx = 0; dx < w; dx++) plot(x + dx, y + dy);
        }

        const fill = shapeState.fill;
        const p = 4;

        switch (shapeState.kind) {
          case 'rect':
            if (fill) {
              fillRect(p, p, 32 - p * 2, 32 - p * 2);
            } else {


              fillRect(p, p, 32 - p * 2, s);

              fillRect(p, 32 - p - s, 32 - p * 2, s);

              fillRect(p, p, s, 32 - p * 2);

              fillRect(32 - p - s, p, s, 32 - p * 2);
            }
            break;

          case 'circle': {

            const cx = 16, cy = 16;
            const r = 12;
            const rIn = r - s;
            const r2 = r * r;
            const rIn2 = rIn * rIn;

            for (let y = 0; y < 32; y++) {
              for (let x = 0; x < 32; x++) {
                const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
                if (fill) {
                  if (d2 <= r2) plot(x, y);
                } else {
                  if (d2 <= r2 && d2 >= rIn2) plot(x, y);
                }
              }
            }
            break;
          }

          case 'tri': {

            const x1 = 16, y1 = p;
            const x2 = 32 - p, y2 = 32 - p;
            const x3 = p, y3 = 32 - p;


            for (let y = 0; y < 32; y++) {
              for (let x = 0; x < 32; x++) {

                const d1 = (x - x2) * (y1 - y2) - (x1 - x2) * (y - y2);
                const d2 = (x - x3) * (y2 - y3) - (x2 - x3) * (y - y3);
                const d3 = (x - x1) * (y3 - y1) - (x3 - x1) * (y - y1);
                const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
                const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
                const inside = !(hasNeg && hasPos);

                if (inside) {
                  if (fill) {
                    plot(x, y);
                  } else {







                    if (inside) plot(x, y);
                  }
                }
              }
            }

            if (!fill) {






              spCtx.clearRect(0, 0, 32, 32);
              function line(x0, y0, x1, y1) {
                let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
                let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
                let err = dx + dy, e2;
                while (true) {

                  fillRect(x0 - Math.floor(s / 2), y0 - Math.floor(s / 2), s, s);
                  if (x0 === x1 && y0 === y1) break;
                  e2 = 2 * err;
                  if (e2 >= dy) { err += dy; x0 += sx; }
                  if (e2 <= dx) { err += dx; y0 += sy; }
                }
              }
              line(x1, y1, x2, y2);
              line(x2, y2, x3, y3);
              line(x3, y3, x1, y1);
            }
            break;
          }

          case 'line': {
            const x0 = p, y0 = 32 - p;
            const x1 = 32 - p, y1 = p;
            let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
            let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
            let err = dx + dy, e2;
            while (true) {

              fillRect(x0 - Math.floor(s / 2), y0 - Math.floor(s / 2), s, s);
              if (x0 === x1 && y0 === y1) break;
              e2 = 2 * err;
              if (e2 >= dy) { err += dy; x0 += sx; }
              if (e2 <= dx) { err += dx; y0 += sy; }
            }
            break;
          }
        }
      }


      function updateFillPreview() {
        if (!fillPreviewCanvas) return;
        const fpCtx = fillPreviewCanvas.getContext('2d');
        fpCtx.clearRect(0, 0, 32, 32);

        const [r, g, b] = hexToRGBA(brush.color);
        const lim = ditherLimit(fillDither);

        for (let y = 0; y < 32; y++) {
          for (let x = 0; x < 32; x++) {
            if (lim === null || BAYER4[y & 3][x & 3] < lim) {
              fpCtx.fillStyle = brush.color;
              fpCtx.fillRect(x, y, 1, 1);
            }
          }
        }
      }


      function updateDitherFillPreview() {
        if (!ditherFillPreviewCanvas) return;
        const dpCtx = ditherFillPreviewCanvas.getContext('2d');
        dpCtx.clearRect(0, 0, 32, 32);

        const [r, g, b] = hexToRGBA(brush.color);
        const mode = ditherFill.mode;
        const invert = ditherFill.invert;
        const falloffPower = ditherFill.falloff / 5;

        for (let y = 0; y < 32; y++) {
          for (let x = 0; x < 32; x++) {
            let t;

            if (mode === 'radial') {
              const dx = x - 16, dy = y - 16;
              t = Math.min(1, Math.sqrt(dx * dx + dy * dy) / 16);
            } else if (mode === 'angular') {
              const dx = x - 16, dy = y - 16;
              let angle = Math.atan2(dy, dx) + Math.PI;
              t = angle / (Math.PI * 2);
            } else if (mode === 'diamond') {
              t = Math.min(1, (Math.abs(x - 16) + Math.abs(y - 16)) / 20);
            } else if (mode === 'square') {
              t = Math.min(1, Math.max(Math.abs(x - 16), Math.abs(y - 16)) / 16);
            } else if (mode === 'noise') {
              const base = x / 32;
              const hash = ((x * 1597 + y * 51749) % 65536) / 65536;
              t = Math.max(0, Math.min(1, base + (hash - 0.5) * 0.3));
            } else {
              t = x / 32;
            }

            t = Math.pow(t, falloffPower);
            if (invert) t = 1 - t;

            const threshold = Math.floor(t * 16);
            if (BAYER4[y & 3][x & 3] >= threshold) {
              dpCtx.fillStyle = brush.color;
              dpCtx.fillRect(x, y, 1, 1);
            }
          }
        }
      }

      if (eraserSizeInp) {

        eraserSizeInp.addEventListener('input', () => {
          eraser.size = +eraserSizeInp.value || 4;
          eraserSizeVal.textContent = eraser.size + ' px';
          setRangeProgress(eraserSizeInp);
          updateEraserPreview();
        }, { passive: true });
        setRangeProgress(eraserSizeInp);
      }

      if (eraserDitherInp) {

        if (+eraserDitherInp.value === 0) setRangeProgress(eraserDitherInp);
        eraserDitherInp.addEventListener('input', () => {
          const v = +eraserDitherInp.value || 0;
          eraser.ditherLevel = v;
          eraserDitherVal.textContent = eraser.ditherLevel === 0 ? 'Off' : String(eraser.ditherLevel);
          setRangeProgress(eraserDitherInp);
          updateEraserPreview();
        }, { passive: true });
        setRangeProgress(eraserDitherInp);
      }




      function initCustomDropdown(id, onChange) {
        const container = document.getElementById(id);
        if (!container) return null;
        const trigger = container.querySelector('.dropdown-trigger');
        const menu = container.querySelector('.dropdown-menu');
        const items = container.querySelectorAll('.dropdown-btn');

        trigger.addEventListener('click', (e) => {
          e.stopPropagation();
          const alreadyShow = menu.classList.contains('show');
          document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
          if (!alreadyShow) menu.classList.add('show');
        });

        items.forEach(item => {
          item.addEventListener('click', (e) => {
            e.stopPropagation();
            const val = item.getAttribute('data-value');
            if (onChange) onChange(val);
            menu.classList.remove('show');
          });
        });

        return {
          setValue: (val) => {
            const upVal = val.toUpperCase();
            items.forEach(i => {
              if (i.getAttribute('data-value') === val) {
                i.classList.add('active');
                const label = trigger.querySelector('.dd-label');
                if (label) label.textContent = upVal;
              } else {
                i.classList.remove('active');
              }
            });
          }
        };
      }

      stabilizer.mode = 'none';
      const brushStabBtn = document.getElementById('brushStabBtn');
      const eraserStabBtn = document.getElementById('eraserStabBtn');
      const brushStabIcon = document.getElementById('brushStabIcon');
      const eraserStabIcon = document.getElementById('eraserStabIcon');

      function getNextStabilizerMode(current) {
        if (current === 'none') return 'normal';
        if (current === 'normal') return 'strong';
        return 'none';
      }

      function updateStabilizerUI() {

        const iconSrcs = {
          none: 'assets/img/image_49.png',
          normal: 'assets/img/image_50.png',
          strong: 'assets/img/image_51.png'
        };

        if (brushStabBtn) {
          const bMode = brush.stabilizer || 'none';
          brushStabBtn.classList.remove('stab-none', 'stab-normal', 'stab-strong');
          brushStabBtn.classList.add('stab-' + bMode);
          brushStabBtn.title = `Brush Stabilizer: ${bMode.toUpperCase()} (click to cycle)`;
          if (brushStabIcon) brushStabIcon.src = iconSrcs[bMode];
        }

        if (eraserStabBtn) {
          const eMode = eraser.stabilizer || 'none';
          eraserStabBtn.classList.remove('stab-none', 'stab-normal', 'stab-strong');
          eraserStabBtn.classList.add('stab-' + eMode);
          eraserStabBtn.title = `Eraser Stabilizer: ${eMode.toUpperCase()} (click to cycle)`;
          if (eraserStabIcon) eraserStabIcon.src = iconSrcs[eMode];
        }
      }


      if (brushStabBtn) {
        brushStabBtn.addEventListener('click', () => {
          brush.stabilizer = getNextStabilizerMode(brush.stabilizer);
          updateStabilizerUI();
          showToast(`Brush Stabilizer: ${brush.stabilizer.toUpperCase()}`);
        });
      }
      if (eraserStabBtn) {
        eraserStabBtn.addEventListener('click', () => {
          eraser.stabilizer = getNextStabilizerMode(eraser.stabilizer);
          updateStabilizerUI();
          showToast(`Eraser Stabilizer: ${eraser.stabilizer.toUpperCase()}`);
        });
      }


      document.addEventListener('click', () => {
        document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
      });

      updateEraserPreview();
      updateStabilizerUI();


      const oldUpdateBrushUI = window.updateBrushUI;
      window.updateBrushUI = function () {
        if (oldUpdateBrushUI) oldUpdateBrushUI();
        if (currentColorBtn) currentColorBtn.style.backgroundColor = brush.color;
        updateBrushPreview();
        updateEraserPreview();
        updateFillPreview();
        updateDitherFillPreview();
        updateFXPreview();
      };

      updateBrushPreview();
      updateFillPreview();
      updateDitherFillPreview();
      updateFXPreview();


      if (ditherFillModeInp) {
        ditherFillModeInp.addEventListener('change', () => {
          ditherFill.mode = ditherFillModeInp.value;
          updateDitherFillPreview();
        });
      }
      if (ditherFillInvertInp) {
        ditherFillInvertInp.addEventListener('change', () => {
          ditherFill.invert = ditherFillInvertInp.checked;
          updateDitherFillPreview();
        });
      }
      if (ditherFillShapeInp) {
        ditherFillShapeInp.addEventListener('change', () => {
          ditherFill.shapeFill = ditherFillShapeInp.checked;
        });
      }
      if (ditherFalloffInp) {
        ditherFalloffInp.addEventListener('input', () => {
          ditherFill.falloff = parseInt(ditherFalloffInp.value);
          if (ditherFalloffVal) ditherFalloffVal.textContent = ditherFill.falloff;
          updateDitherFillPreview();
        });
      }


      if (fillDitherInp) {
        setRangeProgress(fillDitherInp);
        fillDitherInp.addEventListener('input', () => {
          fillDither = parseInt(fillDitherInp.value) || 0;
          if (fillDitherVal) fillDitherVal.textContent = fillDither === 0 ? 'Off' : fillDither;
          setRangeProgress(fillDitherInp);
          updateFillPreview();
        });
      }


      const layerItems = document.querySelectorAll('.layerItem');
      const layerBtns = document.querySelectorAll('.layerBtn');
      const visBtns = document.querySelectorAll('.visBtn');
      const opacitySliders = document.querySelectorAll('.opacitySlider');

      function updateLayerUI() {
        layerItems.forEach(item => {
          const layer = parseInt(item.dataset.layer);
          item.classList.toggle('active', layer === activeLayer);
        });
      }


      layerBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          commitSelectionIfAny();
          const layerItem = btn.closest('.layerItem');
          activeLayer = parseInt(layerItem.dataset.layer);
          updateLayerUI();
        });
      });


      visBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          const layer = parseInt(btn.dataset.layer);
          const newVisibility = !frames[current].layers[layer].visible;

          frames.forEach(f => { f.layers[layer].visible = newVisibility; });
          btn.classList.toggle('active', newVisibility);
          updateAllThumbs();
          render();
        });
      });


      opacitySliders.forEach(slider => {
        slider.addEventListener('input', () => {
          const layer = parseInt(slider.dataset.layer);
          const newOpacity = slider.value / 100;

          frames.forEach(f => { f.layers[layer].opacity = newOpacity; });
          updateAllThumbs();
          render();
        });
      });


      updateLayerUI();
      opacitySliders.forEach(slider => { slider.value = 100; });

      const ppBtn = document.getElementById('ppBtn');
      if (ppBtn) {

        if (brush.pixelPerfect) ppBtn.classList.add('active');

        ppBtn.addEventListener('click', () => {
          brush.pixelPerfect = !brush.pixelPerfect;
          if (brush.pixelPerfect) {
            ppBtn.classList.add('active');
          } else {
            ppBtn.classList.remove('active');
          }
        });
      }

      function applyFPSInput() {
        const newFps = clampFPS(+fpsInp.value || 8);
        fpsInp.value = String(newFps);
        const newDelay = Math.round(1000 / newFps);


        if (vfrEnabled) {
          frames.forEach(f => {
            if (!f.delayModified) {
              f.delay = newDelay;
            }
          });
          refreshAllFilmTileBadges();
        } else {
          updatePlaybackInfo();
        }

        if (playing) { togglePlay(false); togglePlay(true); }
      }
      fpsInp.addEventListener('change', applyFPSInput);
      fpsInp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          fpsInp.blur();
        }
      });


      exportBtn.addEventListener('click', () => openExportModal('gif'));
      importBtn.addEventListener('click', openImportPicker);

      importAnyInput?.addEventListener('change', async (e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        const name = (f.name || '').toLowerCase();
        const type = (f.type || '').toLowerCase();
        if (name.endsWith('.flip') || name.endsWith('.json') || type === 'application/json') {
          await openProjectFlipFile(f);
          return;
        }
        if (name.endsWith('.gif') || type === 'image/gif') {
          await handleGifImportFile(f);
          return;
        }
        if (name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.webp') || type.startsWith('image/')) {
          await handleImageImportFile(f);
          return;
        }
        showToast('File not supported: ' + f.name);
      });

      fileInput?.addEventListener('change', handleGifImport);
      imageImportInput?.addEventListener('change', handleImageImport);
      flipInput?.addEventListener('change', (e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        openProjectFlipFile(f);
      });

      exportTypeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          const nextType = btn.dataset.exportType;
          const currentName = exportNameInp?.value;
          if (currentName) exportState.names[exportState.type] = currentName;
          setExportType(nextType, false);
        });
      });
      if (exportPreviewToggleBtn) exportPreviewToggleBtn.addEventListener('click', () => {
        if (frames.length < 2) return;
        exportState.previewPaused = !exportState.previewPaused;
        refreshExportPreview();
      });
      if (exportFrameCurrentBtn) exportFrameCurrentBtn.addEventListener('click', () => {
        if (exportState.type !== 'png') return;
        selectCurrentPNGFrame();
        setPreviewSliderBounds();
        if (exportFrameFromInp) exportFrameFromInp.value = String(exportState.previewFrame + 1);
        if (exportFrameToInp) exportFrameToInp.value = String(exportState.previewFrame + 1);
        updateExportModalUI();
      });
      if (exportFrameRangeBtn) exportFrameRangeBtn.addEventListener('click', () => {
        if (exportState.type !== 'png') return;
        selectShownPNGFrame();
        setPreviewSliderBounds();
        if (exportFrameFromInp) exportFrameFromInp.value = String(exportState.previewFrame + 1);
        if (exportFrameToInp) exportFrameToInp.value = String(exportState.previewFrame + 1);
        updateExportModalUI();
      });
      if (exportFrameAllBtn) exportFrameAllBtn.addEventListener('click', () => {
        if (exportState.type !== 'png') return;
        selectAllPNGFrames();
        if (exportFrameFromInp) exportFrameFromInp.value = '1';
        if (exportFrameToInp) exportFrameToInp.value = String(Math.max(1, frames.length));
        if (exportFrameStepInp) exportFrameStepInp.value = '1';
        setPreviewSliderBounds();
        updateExportModalUI();
      });
      if (exportFrameApplyBtn) exportFrameApplyBtn.addEventListener('click', () => {
        if (exportState.type !== 'png') return;
        applyPNGRangeSelection();
        setPreviewSliderBounds();
        updateExportModalUI();
      });
      if (exportPreviewSlider) exportPreviewSlider.addEventListener('input', () => {
        if (exportState.type !== 'png') return;
        setPreviewFrameFromNumber(+exportPreviewSlider.value || 1);
        refreshExportPreview();
      });
      if (exportPreviewPrevBtn) exportPreviewPrevBtn.addEventListener('click', () => {
        if (exportState.type !== 'png') return;
        setPreviewFrameFromNumber(clampFrameNumber(exportState.previewFrame));
        refreshExportPreview();
      });
      if (exportPreviewNextBtn) exportPreviewNextBtn.addEventListener('click', () => {
        if (exportState.type !== 'png') return;
        setPreviewFrameFromNumber(clampFrameNumber(exportState.previewFrame + 2));
        refreshExportPreview();
      });
      [exportFrameFromInp, exportFrameToInp, exportFrameStepInp].forEach(inp => {
        if (!inp) return;
        inp.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          if (exportState.type !== 'png') return;
          applyPNGRangeSelection();
          setPreviewSliderBounds();
          updateExportModalUI();
        });
      });
      if (exportNameInp) {
        exportNameInp.addEventListener('input', () => {
          exportState.names[exportState.type] = exportNameInp.value || exportState.names[exportState.type];
        });
      }
      exportCancel.addEventListener('click', closeExportModal);
      exportBackdrop.addEventListener('click', (e) => { if (e.target === exportBackdrop) closeExportModal(); });
      exportNameInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runExportFromModal(); } });
      exportGo.addEventListener('click', runExportFromModal);


      const vfrToggle = document.getElementById('vfrToggle');
      if (vfrToggle) {
        vfrToggle.checked = false;
        vfrEnabled = false;
        vfrToggle.addEventListener('change', () => { vfrEnabled = vfrToggle.checked; refreshAllFilmTileBadges(); });
      }


      const historyToastsToggle = document.getElementById('historyToastsToggle');
      if (historyToastsToggle) {
        historyToastsToggle.checked = showHistoryToasts;
        historyToastsToggle.addEventListener('change', () => {
          showHistoryToasts = historyToastsToggle.checked;
          localStorage.setItem('fliplite_historyToasts', showHistoryToasts);
        });
      }

      if (filmstripCompactToggle) {
        updateFilmstripStyleButtons(pendingFilmstripStyle);
        filmstripCompactToggle.addEventListener('change', () => {
          pendingFilmstripStyle = filmstripCompactToggle.checked ? FILMSTRIP_STYLE_COMPACT : FILMSTRIP_STYLE_THUMBS;
        });
      }

      undoBtn.addEventListener('click', () => { if (typeof doUndo === 'function') doUndo(); });
      redoBtn.addEventListener('click', () => { if (typeof doRedo === 'function') doRedo(); });
      playBtn.addEventListener('click', () => togglePlay());
      resizeBtn.addEventListener('click', () => openSettings());
      const infoGrp = document.querySelector('.infoGroup');
      const fpsInfoBox = document.getElementById('fpsInfoBox');
      const vfrInfoBox = document.getElementById('vfrInfoBox');

      [fpsInfoBox, vfrInfoBox].forEach(box => {
        box.addEventListener('mousedown', () => infoGrp.classList.add('active-press'));
        box.addEventListener('mouseup', () => infoGrp.classList.remove('active-press'));
        box.addEventListener('mouseleave', () => infoGrp.classList.remove('active-press'));
        box.addEventListener('click', () => openSettings(true));
      });

      const toggleTimelineBtn = document.getElementById('toggleTimelineBtn');
      if (toggleTimelineBtn) {
        toggleTimelineBtn.addEventListener('click', () => {
          timelineHidden = !timelineHidden;
          document.querySelectorAll('.badge').forEach(b => b.classList.toggle('badge-hidden', timelineHidden));
          document.querySelectorAll('.badge-container').forEach(bc => bc.classList.toggle('timeline-hidden', timelineHidden));
          document.querySelectorAll('.deleteFrameBtn').forEach(db => db.classList.toggle('timeline-hidden', timelineHidden));
          toggleTimelineBtn.classList.toggle('inactive', timelineHidden);
        });
      }

      const frameDelayInd = document.getElementById('frameDelayInd');
      if (frameDelayInd) {
        frameDelayInd.addEventListener('change', (e) => {
          const val = Math.max(10, Math.min(5000, parseInt(e.target.value) || 100));
          const targets = selectedFrames.size > 1 ? [...selectedFrames] : [current];

          targets.forEach(idx => {
            const old = frames[idx].delay || Math.round(1000 / clampFPS(+fpsInp.value || 8));
            if (val !== old) {
              pushDelayChange(idx, old, val);
            }
            frames[idx].delay = val;
            frames[idx].delayModified = true;
          });

          if (selectedFrames.size > 1) {
            selectedFrames.clear();
          }

          refreshAllFilmTileBadges();
          updateFrameIndicator();
        });
        frameDelayInd.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            frameDelayInd.blur();
          }
        });
      }

      addFrameBtn.addEventListener('click', () => addFrame(current + 1));
      dupFrameBtn.addEventListener('click', performDuplicate);

      const selFlipH = document.getElementById('selFlipH');
      const selFlipV = document.getElementById('selFlipV');
      if (selFlipH) selFlipH.addEventListener('click', () => flipSelH());
      if (selFlipV) selFlipV.addEventListener('click', () => flipSelV());
      moveLeftBtn.addEventListener('click', () => moveFrame(current, Math.max(0, current - 1)));
      moveRightBtn.addEventListener('click', () => moveFrame(current, Math.min(frames.length - 1, current + 1)));
      delFrameBtn.addEventListener('click', () => {
        if (selectedFrames.size > 1) {
          performMultiDelete([...selectedFrames]);
        } else {
          deleteFrame(current);
        }
      });
      function setTool(t) {
        if (playing && !isPlaybackPaintTool(t)) {
          return;
        }
        if ((mirror.h || mirror.v) && t !== 'brush' && t !== 'eraser' && t !== 'shape') {
          return;
        }
        if (t !== 'select' && t !== 'lasso' && sel) { commitSelectionIfAny(); }
        tool = t;
        updateToolUI();

        const mirrorActive = mirror.h || mirror.v;
        const bpMenu = document.getElementById('brushPressureMenu');
        const bpSep = document.getElementById('brushPressureSep');
        const epMenu = document.getElementById('eraserPressureMenu');
        const epSep = document.getElementById('eraserPressureSep');

        if (bpMenu) bpMenu.style.display = (t === 'brush' && brush.usePressure) ? 'flex' : 'none';
        if (bpSep) bpSep.style.display = (t === 'brush' && brush.usePressure) ? 'block' : 'none';
        if (epMenu) epMenu.style.display = (t === 'eraser' && eraser.usePressure) ? 'flex' : 'none';
        if (epSep) epSep.style.display = (t === 'eraser' && eraser.usePressure) ? 'block' : 'none';

        if (fillSettings) fillSettings.style.display = (t === 'fill') ? '' : 'none';
        if (ditherFillSettings) ditherFillSettings.style.display = (t === 'ditherFill') ? '' : 'none';

        const selSettings = document.getElementById('selSettings');
        if (selSettings) selSettings.style.display = (t === 'select' || t === 'lasso') ? 'flex' : 'none';

        const shapeSettings = document.getElementById('shapeSettings');
        if (shapeSettings) shapeSettings.style.display = (t === 'shape') ? 'flex' : 'none';


        shapePanel.style.display = 'none';
        textPanel.style.display = 'none';

        const textSettings = document.getElementById('textSettings');
        if (textSettings) textSettings.style.display = (t === 'text') ? 'flex' : 'none';

        if (smudgeSettings) smudgeSettings.style.display = (t === 'smudge') ? 'flex' : 'none';
        if (t === 'fx') updateFXModeUI();
        else updateFXPanelVisibility();

        render();
      }
      brushTool.addEventListener('click', () => setTool('brush'));
      if (smudgeTool) smudgeTool.addEventListener('click', () => setTool('smudge'));
      if (fxTool) fxTool.addEventListener('click', () => setTool('fx'));
      eraserTool.addEventListener('click', () => setTool('eraser'));
      fillTool.addEventListener('click', () => setTool('fill'));
      ditherFillTool.addEventListener('click', () => setTool('ditherFill'));
      selectTool.addEventListener('click', () => setTool('select'));
      lassoTool.addEventListener('click', () => setTool('lasso'));
      shapeTool.addEventListener('click', () => setTool('shape'));
      textTool.addEventListener('click', () => setTool('text'));


      shapeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          shapeBtns.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          shapeState.kind = btn.dataset.shape;

          document.querySelectorAll('.shapeToolBtn').forEach(b => b.classList.toggle('active', b.dataset.shape === shapeState.kind));
          updateShapePreview();
        });
      });

      (shapeBtns.find(b => b.dataset.shape === 'rect') || shapeBtns[0]).classList.add('active');
      shapeState.kind = (shapeBtns.find(b => b.classList.contains('active'))?.dataset.shape) || 'rect';
      shapeFill.addEventListener('change', () => {
        shapeState.fill = !!shapeFill.checked;

        const inlineCheck = document.getElementById('shapeFillInline');
        if (inlineCheck) inlineCheck.checked = shapeState.fill;
        updateShapePreview();
      });


      const shapeToolBtns = [...document.querySelectorAll('.shapeToolBtn')];
      shapeToolBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          shapeToolBtns.forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          shapeState.kind = btn.dataset.shape;

          shapeBtns.forEach(b => b.classList.toggle('active', b.dataset.shape === shapeState.kind));
          updateShapePreview();
        });
      });

      shapeToolBtns.forEach(b => b.classList.toggle('active', b.dataset.shape === shapeState.kind));


      const shapeFillInline = document.getElementById('shapeFillInline');
      if (shapeFillInline) {
        shapeFillInline.checked = shapeState.fill;
        shapeFillInline.addEventListener('change', () => {
          shapeState.fill = !!shapeFillInline.checked;

          shapeFill.checked = shapeState.fill;
          updateShapePreview();
        });
      }


      const shapeSizeInp = document.getElementById('shapeSize');
      const shapeSizeVal = document.getElementById('shapeSizeVal');
      const shapeDitherInp = document.getElementById('shapeDither');
      const shapeDitherVal = document.getElementById('shapeDitherVal');

      if (shapeSizeInp) {
        shapeSizeInp.addEventListener('input', () => {
          shapeState.size = +shapeSizeInp.value || 1;
          shapeSizeVal.textContent = shapeState.size + ' px';
          setRangeProgress(shapeSizeInp);
          updateShapePreview();
        }, { passive: true });
        setRangeProgress(shapeSizeInp);
      }

      if (shapeDitherInp) {
        shapeDitherInp.addEventListener('input', () => {
          shapeState.dither = +shapeDitherInp.value || 0;
          shapeDitherVal.textContent = shapeState.dither === 0 ? 'Off' : String(shapeState.dither);
          setRangeProgress(shapeDitherInp);
          updateShapePreview();
        }, { passive: true });
        setRangeProgress(shapeDitherInp);
      }





      updateShapePreview();


      (function () {
        let dragging = false, pid = null, offX = 0, offY = 0;
        const host = stageWrap;
        shapeHead.addEventListener('pointerdown', (e) => {
          dragging = true; pid = e.pointerId; shapeHead.setPointerCapture(pid);
          const r = shapePanel.getBoundingClientRect(), hr = host.getBoundingClientRect();
          offX = e.clientX - r.left; offY = e.clientY - r.top;
          e.preventDefault();
        });
        shapeHead.addEventListener('pointermove', (e) => {
          if (!dragging || pid !== e.pointerId) return;
          const hr = host.getBoundingClientRect();
          let x = e.clientX - hr.left - offX;
          let y = e.clientY - hr.top - offY;
          x = Math.max(0, Math.min(hr.width - shapePanel.offsetWidth, x));
          y = Math.max(0, Math.min(hr.height - shapePanel.offsetHeight, y));
          shapePanel.style.left = x + 'px';
          shapePanel.style.top = y + 'px';
        });
        const end = (e) => { if (pid && shapeHead.hasPointerCapture?.(pid)) shapeHead.releasePointerCapture(pid); dragging = false; pid = null; };
        shapeHead.addEventListener('pointerup', end); shapeHead.addEventListener('pointercancel', end);
      })();

      textBold.addEventListener('click', () => {
        textState.bold = !textState.bold;
        textBold.classList.toggle('active', textState.bold);

        const inlineBold = document.getElementById('textBoldInline');
        if (inlineBold) inlineBold.classList.toggle('active', textState.bold);
      });
      textItalic.addEventListener('click', () => {
        textState.italic = !textState.italic;
        textItalic.classList.toggle('active', textState.italic);

        const inlineItalic = document.getElementById('textItalicInline');
        if (inlineItalic) inlineItalic.classList.toggle('active', textState.italic);
      });


      const textBoldInline = document.getElementById('textBoldInline');
      const textItalicInline = document.getElementById('textItalicInline');
      const textSizeInline = document.getElementById('textSizeInline');
      const textSizeValInline = document.getElementById('textSizeValInline');

      if (textBoldInline) {
        textBoldInline.addEventListener('click', () => {
          textState.bold = !textState.bold;
          textBoldInline.classList.toggle('active', textState.bold);
          textBold.classList.toggle('active', textState.bold);
        });
      }
      if (textItalicInline) {
        textItalicInline.addEventListener('click', () => {
          textState.italic = !textState.italic;
          textItalicInline.classList.toggle('active', textState.italic);
          textItalic.classList.toggle('active', textState.italic);
        });
      }
      if (textSizeInline) {
        textSizeInline.value = textState.scale;
        textSizeValInline.textContent = textState.scale + 'x';
        textSizeInline.addEventListener('input', () => {
          textState.scale = +textSizeInline.value;
          textSizeValInline.textContent = textState.scale + 'x';

          if (textSize) textSize.value = textState.scale;
          if (textSizeVal) textSizeVal.textContent = textState.scale + 'x';
          render();
        });
      }

      if (textFont) {
        textFont.value = textState.font;
        textFont.addEventListener('change', () => {
          textState.font = textFont.value;
          if (textFontInline) textFontInline.value = textState.font;
          render();
        });
      }
      if (textFontInline) {
        textFontInline.value = textState.font;
        textFontInline.addEventListener('change', () => {
          textState.font = textFontInline.value;
          if (textFont) textFont.value = textState.font;
          render();
        });
      }


      function drawBitmapText(ctx, text, x, y, color, bold, italic) {
        const fontInfo = FONTS[textState.font] || FONTS['Standard'];
        const fontData = fontInfo.data;
        const fw = fontInfo.w;
        const fh = fontInfo.h;
        const fgap = fontInfo.gap;
        const lineH = fontInfo.lineH;

        ctx.fillStyle = color;
        let currX = x;
        let currY = y;

        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          if (ch === '\n') {
            currX = x;
            currY += lineH;
            continue;
          }

          let glyph = fontData[ch];
          if (!glyph && ch.toUpperCase() !== ch) glyph = fontData[ch.toUpperCase()];
          if (!glyph) glyph = fontData['?'];

          if (glyph) {
            for (let r = 0; r < fh; r++) {
              const slant = italic ? Math.floor((fh - 1 - r) / 2) : 0;
              const rowStart = r * fw;

              for (let c = 0; c < fw; c++) {
                if (glyph[rowStart + c]) {
                  ctx.fillRect(currX + c + slant, currY + r, 1, 1);
                  if (bold) ctx.fillRect(currX + c + slant + 1, currY + r, 1, 1);
                }
              }
            }
          }
          currX += (fw + fgap) + (bold ? 1 : 0);
        }
      }


      function measureBitmapText(text, bold) {
        const fontInfo = FONTS[textState.font] || FONTS['Standard'];
        const fw = fontInfo.w;
        const fh = fontInfo.h;
        const fgap = fontInfo.gap;
        const lineH = fontInfo.lineH;

        const lines = text.split('\n');
        let maxW = 0;

        for (const line of lines) {
          const len = line.length;
          const lineW = len * (fw + fgap + (bold ? 1 : 0)) - (len > 0 ? fgap : 0);
          if (lineW > maxW) maxW = lineW;
        }

        return {
          w: maxW,
          h: lines.length * lineH - (lines.length > 0 ? (lineH - fh) : 0)
        };
      }


      textSize.addEventListener('input', () => {
        textState.scale = +textSize.value || 1;
        textSizeVal.textContent = textState.scale + 'x';
        render();
      });


      function startTextMode(canvasX, canvasY) {
        textState.x = canvasX;
        textState.y = canvasY;
        textState.active = true;
        textState.text = '';
        textState.cursorPos = 0;
        stage.focus();
        render();
      }


      function cancelTextMode() {
        textState.active = false;
        textState.text = '';
        render();
      }


      function applyBitmapText() {
        const text = textState.text.trim();
        if (!text) { cancelTextMode(); return; }

        const ctx = frames[current].layers[activeLayer].ctx;
        const scale = textState.scale;


        const measured = measureBitmapText(text, textState.bold);
        const baseW = measured.w;
        const baseH = measured.h;
        const scaledW = baseW * scale;
        const scaledH = baseH * scale;

        const x = textState.x;
        const y = textState.y;


        const fx = Math.max(0, Math.min(W - scaledW, x));
        const fy = Math.max(0, Math.min(H - scaledH, y));


        const before = ctx.getImageData(fx, fy, Math.max(1, scaledW), Math.max(1, scaledH));


        const tempCan = document.createElement('canvas');
        tempCan.width = baseW + (textState.italic ? 3 : 0);
        tempCan.height = baseH;
        const tempCtx = tempCan.getContext('2d');
        drawBitmapText(tempCtx, text, 0, 0, brush.color, textState.bold, textState.italic);


        ctx.imageSmoothingEnabled = false;
        for (let sy = 0; sy < baseH; sy++) {
          for (let sx = 0; sx < tempCan.width; sx++) {
            const pixel = tempCtx.getImageData(sx, sy, 1, 1).data;
            if (pixel[3] > 0) {
              ctx.fillStyle = brush.color;
              ctx.fillRect(fx + sx * scale, fy + sy * scale, scale, scale);
            }
          }
        }

        const after = ctx.getImageData(fx, fy, Math.max(1, scaledW), Math.max(1, scaledH));
        pushPaintPatch(current, fx, fy, Math.max(1, scaledW), Math.max(1, scaledH), before, after, activeLayer);

        textState.active = false;
        textState.text = '';
        updateThumb(current);
        render();
        showToast('Text applied');
      }


      window.addEventListener('keydown', (e) => {
        if (!textState.active || tool !== 'text') return;


        if ((e.target.tagName === 'INPUT' && e.target.id !== 'textSize' && e.target.id !== 'textSizeInline') || e.target.tagName === 'TEXTAREA') return;

        const text = textState.text;
        const pos = textState.cursorPos;

        if (e.key === 'Enter') {
          e.preventDefault();
          if (e.shiftKey) {

            textState.text = text.slice(0, pos) + '\n' + text.slice(pos);
            textState.cursorPos++;
            render();
          } else {
            applyBitmapText();
          }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancelTextMode();
        } else if (e.key === 'Backspace') {
          e.preventDefault();
          if (pos > 0) {
            textState.text = text.slice(0, pos - 1) + text.slice(pos);
            textState.cursorPos--;
            render();
          }
        } else if (e.key === 'Delete') {
          e.preventDefault();
          if (pos < text.length) {
            textState.text = text.slice(0, pos) + text.slice(pos + 1);
            render();
          }
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          if (pos > 0) {
            textState.cursorPos--;
            render();
          }
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          if (pos < text.length) {
            textState.cursorPos++;
            render();
          }
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();

          const lines = text.slice(0, pos).split('\n');
          if (lines.length > 1) {
            const currentLinePos = lines[lines.length - 1].length;
            const prevLineStart = pos - currentLinePos - 1;
            const prevLineLength = lines[lines.length - 2].length;
            const newPos = prevLineStart - prevLineLength + Math.min(currentLinePos, prevLineLength);
            textState.cursorPos = Math.max(0, newPos);
            render();
          }
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();

          const beforeCursor = text.slice(0, pos);
          const afterCursor = text.slice(pos);
          const currentLineStart = beforeCursor.lastIndexOf('\n') + 1;
          const currentLinePos = pos - currentLineStart;
          const nextNewline = afterCursor.indexOf('\n');
          if (nextNewline !== -1) {
            const nextLineStart = pos + nextNewline + 1;
            const nextLineEnd = text.indexOf('\n', nextLineStart);
            const nextLineLength = (nextLineEnd === -1 ? text.length : nextLineEnd) - nextLineStart;
            textState.cursorPos = nextLineStart + Math.min(currentLinePos, nextLineLength);
            render();
          }
        } else if (e.key === 'Home') {
          e.preventDefault();

          const beforeCursor = text.slice(0, pos);
          const lineStart = beforeCursor.lastIndexOf('\n') + 1;
          textState.cursorPos = lineStart;
          render();
        } else if (e.key === 'End') {
          e.preventDefault();

          const lineEnd = text.indexOf('\n', pos);
          textState.cursorPos = lineEnd === -1 ? text.length : lineEnd;
          render();
        } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {

          const ch = e.key;
          if (BITMAP_FONT[ch] || BITMAP_FONT[ch.toUpperCase()]) {
            e.preventDefault();
            textState.text = text.slice(0, pos) + ch + text.slice(pos);
            textState.cursorPos++;
            render();
          }
        }
      });


      let textCursorVisible = true;
      setInterval(() => {
        if (textState.active) {
          textCursorVisible = !textCursorVisible;
          requestRender();
        }
      }, 500);


      function drawTextPreview(stageCtx) {
        if (tool !== 'text' || !textState.active) return;

        const text = textState.text;
        const scale = textState.scale;
        const measured = measureBitmapText(text, textState.bold);
        const baseW = text.length > 0 ? measured.w : 0;
        const baseH = text.length > 0 ? measured.h : FONT_H;


        stageCtx.save();
        stageCtx.setTransform(1, 0, 0, 1, 0, 0);
        stageCtx.imageSmoothingEnabled = false;

        const sx = textState.x * view.scale + view.tx;
        const sy = textState.y * view.scale + view.ty;


        if (text.length > 0) {
          const tempCan = document.createElement('canvas');
          tempCan.width = baseW + (textState.italic ? 3 : 0);
          tempCan.height = baseH;
          const tempCtx = tempCan.getContext('2d');
          drawBitmapText(tempCtx, text, 0, 0, brush.color, textState.bold, textState.italic);

          stageCtx.drawImage(tempCan, 0, 0, tempCan.width, tempCan.height,
            sx, sy, tempCan.width * scale * view.scale, baseH * scale * view.scale);
        }


        if (textCursorVisible) {
          const pos = textState.cursorPos;
          const beforeCursor = text.slice(0, pos);
          const lines = beforeCursor.split('\n');
          const currentLine = lines[lines.length - 1] || '';
          const currentLineW = measureBitmapText(currentLine, textState.bold).w;
          const lineHeight = 9;
          const cursorX = sx + (currentLineW * scale * view.scale);
          const cursorY = sy + ((lines.length - 1) * lineHeight * scale * view.scale);
          stageCtx.fillStyle = brush.color;
          stageCtx.fillRect(cursorX, cursorY, 2, FONT_H * scale * view.scale);
        }


        stageCtx.strokeStyle = 'rgba(70, 130, 255, 0.7)';
        stageCtx.lineWidth = 1;
        stageCtx.setLineDash([3, 3]);
        const boxW = Math.max(20, (baseW + 2) * scale * view.scale);
        stageCtx.strokeRect(sx - 2, sy - 2, boxW + 4, (baseH * scale * view.scale) + 4);
        stageCtx.setLineDash([]);
        stageCtx.restore();
      }


      const onionTintBtn = document.getElementById('onionTintBtn');
      const onionRealBtn = document.getElementById('onionRealBtn');
      if (onionTintBtn && onionRealBtn) {
        onionTintBtn.addEventListener('click', () => {
          onionColorMode = 'tint';
          onionTintBtn.classList.add('active');
          onionRealBtn.classList.remove('active');
          render();
        });
        onionRealBtn.addEventListener('click', () => {
          onionColorMode = 'real';
          onionRealBtn.classList.add('active');
          onionTintBtn.classList.remove('active');
          render();
        });
      }


      function applyUndoOp(op) {
        if (op.activeLayer !== undefined) { activeLayer = op.activeLayer; updateLayerUI(); }
        else if (op.layer !== undefined) { activeLayer = op.layer; updateLayerUI(); }

        if (op.type === 'batch') {
          beginHistoryReplayBatch();
          try {
            for (let i = op.ops.length - 1; i >= 0; i--) applyUndoOp(op.ops[i]);
          } finally {
            endHistoryReplayBatch();
          }
          return;
        }

        if (op.type === 'paint') {
          const layer = op.layer !== undefined ? op.layer : 0;
          frames[op.fi].layers[layer].ctx.putImageData(op.before, op.x, op.y);

          if (op.selSnapshot) {
            restoreSelectionFromSnapshot(op.selSnapshot);

            if (sel) {
              sel._frame = op.fi;

              if (op.selSnapshot.wasAlreadyCut === false && op.selSnapshot.source !== 'paste') {
                sel.hasCut = false;
              }
            }

            if (sel && op.selSnapshot.source !== 'paste' && !op.selSnapshot.detached &&
              op.selSnapshot.wasAlreadyCut && sel.cutRect) {
              const targetLayer = sel.cutLayer !== undefined ? sel.cutLayer : activeLayer;
              const fctx = frames[op.fi].layers[targetLayer].ctx;

              const recutMask = sel.cutMask || sel.mask;
              const recutImg = sel.cutImg || sel.img;
              fctx.save();
              if (recutMask) {
                fctx.globalCompositeOperation = 'destination-out';
                fctx.drawImage(recutMask, sel.cutRect.x, sel.cutRect.y);
              } else if (recutImg) {
                fctx.globalCompositeOperation = 'destination-out';
                fctx.drawImage(recutImg, sel.cutRect.x, sel.cutRect.y);
              } else {
                fctx.clearRect(sel.cutRect.x, sel.cutRect.y, sel.cutRect.w, sel.cutRect.h);
              }
              fctx.restore();
            }

            if (op.selMoves && op.selMoves.length > 0) {
              for (const move of op.selMoves) {
                history.push(move);
                capHistory();
              }
            }
          }
          updateThumb(op.fi);
          current = op.fi;
          requestHistoryReplayFilmBuild();
        }
        else if (op.type === 'frameInsert') {
          frames.splice(op.index, 1);
          if (Array.isArray(op.prevSelection)) {
            selectedFrames.clear();
            op.prevSelection.forEach((idx) => {
              if (idx >= 0 && idx < frames.length) selectedFrames.add(idx);
            });
          }
          if (Number.isInteger(op.prevCurrent)) {
            current = Math.max(0, Math.min(op.prevCurrent, frames.length - 1));
          } else {
            current = Math.max(0, Math.min(current, frames.length - 1));
          }
          if (op.selSnap) {
            if (op.selSnap._frame !== undefined && op.selSnap._frame < frames.length) {
              current = op.selSnap._frame;
            }
            restoreSelectionFromSnapshot(op.selSnap);
          }
          requestHistoryReplayFilmBuild();
        }
        else if (op.type === 'frameDelete') {
          const f = restoreFrameFromSnapshot(op.data);
          frames.splice(op.index, 0, f);
          current = op.index;
          updateThumb(op.index);
          if (op.selSnap) {
            if (op.selSnap._frame !== undefined && op.selSnap._frame < frames.length) {
              current = op.selSnap._frame;
            }
            restoreSelectionFromSnapshot(op.selSnap);
          }
          requestHistoryReplayFilmBuild();
        }
        else if (op.type === 'frameReplace') {
          const f = restoreFrameFromSnapshot(op.before);
          frames[op.index] = f;
          current = Math.max(0, Math.min(op.index, frames.length - 1));
          updateThumb(op.index);
          requestHistoryReplayFilmBuild();
        }
        else if (op.type === 'frameMove') {
          const curF = frames.splice(op.to, 1)[0];
          frames.splice(op.from, 0, curF);
          current = op.from;
          requestHistoryReplayFilmBuild();
        }
        else if (op.type === 'multiFrameMove') {
          const count = op.fromIndices.length;
          const movedFrames = frames.splice(op.toStart, count);

          const sortedOrigIndices = [...op.fromIndices].map((idx, i) => ({ idx, frame: movedFrames[i] }));
          sortedOrigIndices.sort((a, b) => a.idx - b.idx);
          sortedOrigIndices.forEach(({ idx, frame }) => {
            frames.splice(idx, 0, frame);
          });

          selectedFrames.clear();
          if (op.prevSelection) {
            op.prevSelection.forEach(i => selectedFrames.add(i));
          }

          current = op.fromIndices[0];
          requestHistoryReplayFilmBuild();
        }
        else if (op.type === 'delayChange') {
          if (frames[op.frameIndex]) frames[op.frameIndex].delay = op.oldDelay;
          requestHistoryReplayFilmBuild();
        }
        else if (op.type === 'multiDelayChange') {
          op.changes.forEach(c => {
            if (frames[c.frameIndex]) frames[c.frameIndex].delay = c.oldDelay;
          });
          requestHistoryReplayFilmBuild();
        }
        else if (op.type === 'selectionChange') {
          selectedFrames.clear();
          op.prevSelection.forEach(i => selectedFrames.add(i));
          requestHistoryReplayFilmBuild();
        }
        else if (op.type === 'multiFrameInsert') {
          const sortedInsertions = [...op.insertions].sort((a, b) => b.idx - a.idx);
          sortedInsertions.forEach(ins => {
            frames.splice(ins.idx, 1);
          });
          current = Math.max(0, Math.min(current, frames.length - 1));
          if (op.selSnap) {
            if (op.selSnap._frame !== undefined && op.selSnap._frame < frames.length) {
              current = op.selSnap._frame;
            }
            restoreSelectionFromSnapshot(op.selSnap);
          }
          requestHistoryReplayFilmBuild();
        }
        else if (op.type === 'multiFrameDelete') {
          const sortedDeletions = [...op.deletions].sort((a, b) => a.idx - b.idx);
          sortedDeletions.forEach(del => {
            const f = restoreFrameFromSnapshot(del.snap);
            frames.splice(del.idx, 0, f);
            updateThumb(del.idx);
          });
          current = sortedDeletions[0].idx;
          if (op.selSnap) {
            if (op.selSnap._frame !== undefined && op.selSnap._frame < frames.length) {
              current = op.selSnap._frame;
            }
            restoreSelectionFromSnapshot(op.selSnap);
          }
          requestHistoryReplayFilmBuild();
        }
        else if (op.type === 'selUpdate') {
          if (sel && sel.hasCut && (!op.before || !op.before.hasCut)) {
            const targetLayer = sel.cutLayer !== undefined ? sel.cutLayer : activeLayer;
            const selFrame = sel._frame !== undefined ? sel._frame : current;
            if (frames[selFrame] && frames[selFrame].layers[targetLayer]) {
              const ctx = frames[selFrame].layers[targetLayer].ctx;
              const restoreImg = sel.cutImg || sel.img;
              const rX = sel.cutRect ? sel.cutRect.x : sel.x;
              const rY = sel.cutRect ? sel.cutRect.y : sel.y;
              if (restoreImg) ctx.drawImage(restoreImg, rX, rY);
            }
          }

          if (sel) {
            sel.img = op.before;
            if (op.x !== undefined) sel.x = op.x;
            if (op.y !== undefined) sel.y = op.y;
          }
          render();
        }
        else if (op.type === 'multiFrameOrderChange') {
          op.indices.forEach((idx, i) => {
            frames[idx] = op.oldFrames[i];
          });
          if (op.selSnap) restoreSelectionFromSnapshot(op.selSnap);
          requestHistoryReplayFilmBuild();
        }
        else if (op.type === 'selMove') {
          if (sel) {
            sel.x = op.fromX;
            sel.y = op.fromY;
          }
          render();
        }
        else if (op.type === 'selTransform') {
          const snap = op.before || null;
          if (!snap) {
            sel = null;
            render();
            return;
          }

          if (snap._frame !== undefined && snap._frame >= 0 && snap._frame < frames.length) {
            current = snap._frame;
          }
          if (snap.cutLayer !== undefined && snap.cutLayer !== activeLayer) {
            activeLayer = snap.cutLayer;
            updateLayerUI();
          }
          restoreSelectionFromSnapshot(snap);
          if (sel) sel._frame = snap._frame !== undefined ? snap._frame : current;
          render();
        }
      }

      function applyRedoOp(op) {
        if (op.activeLayer !== undefined) { activeLayer = op.activeLayer; updateLayerUI(); }
        else if (op.layer !== undefined) { activeLayer = op.layer; updateLayerUI(); }

        if (op.type === 'batch') {
          beginHistoryReplayBatch();
          try {
            for (let i = 0; i < op.ops.length; i++) applyRedoOp(op.ops[i]);
          } finally {
            endHistoryReplayBatch();
          }
          return;
        }

        if (op.type === 'paint') {
          const layer = op.layer !== undefined ? op.layer : 0;
          frames[op.fi].layers[layer].ctx.putImageData(op.after, op.x, op.y);

          if (op.selSnapshot) {
            sel = null;

            if (op.selMoves && op.selMoves.length > 0) {
              const selId = op.selSnapshot._id;

              op.selMoves = [];
              for (let i = history.length - 1; i >= 0; i--) {
                if (history[i].type === 'selMove' && history[i].selId === selId) {
                  op.selMoves.unshift(history.splice(i, 1)[0]);
                }
              }
            }
          }
          updateThumb(op.fi);
          current = op.fi;
          requestHistoryReplayFilmBuild();
        }
        else if (op.type === 'frameInsert') {
          const f = restoreFrameFromSnapshot(op.data);
          frames.splice(op.index, 0, f);
          if (Array.isArray(op.nextSelection)) {
            selectedFrames.clear();
            op.nextSelection.forEach((idx) => {
              if (idx >= 0 && idx < frames.length) selectedFrames.add(idx);
            });
          }
          const nextCurrent = Number.isInteger(op.nextCurrent) ? op.nextCurrent : op.index;
          current = Math.max(0, Math.min(nextCurrent, frames.length - 1));
          if (op.selSnap) { sel = null; }
          requestHistoryReplayFilmBuild();
        }
        else if (op.type === 'frameDelete') {
          frames.splice(op.index, 1);
          current = Math.max(0, Math.min(current, frames.length - 1));
          if (op.selSnap) { sel = null; }
          requestHistoryReplayFilmBuild();
        }
        else if (op.type === 'frameReplace') {
          const f = restoreFrameFromSnapshot(op.after);
          frames[op.index] = f;
          current = Math.max(0, Math.min(op.index, frames.length - 1));
          updateThumb(op.index);
          requestHistoryReplayFilmBuild();
        }
        else if (op.type === 'frameMove') {
          const f = frames.splice(op.from, 1)[0];
          frames.splice(op.to, 0, f);
          current = op.to;
          requestHistoryReplayFilmBuild();
        }
        else if (op.type === 'multiFrameMove') {
          const movedFrames = [...op.fromIndices].reverse().map(i => frames.splice(i, 1)[0]).reverse();
          frames.splice(op.toStart, 0, ...movedFrames);

          selectedFrames.clear();
          if (op.newSelection) {
            op.newSelection.forEach(i => selectedFrames.add(i));
          }

          current = op.toStart;
          requestHistoryReplayFilmBuild();
        }
        else if (op.type === 'delayChange') {
          if (frames[op.frameIndex]) frames[op.frameIndex].delay = op.newDelay;
          requestHistoryReplayFilmBuild();
        }
        else if (op.type === 'multiDelayChange') {
          op.changes.forEach(c => {
            if (frames[c.frameIndex]) frames[c.frameIndex].delay = c.newDelay;
          });
          requestHistoryReplayFilmBuild();
        }
        else if (op.type === 'selectionChange') {
          selectedFrames.clear();
          op.newSelection.forEach(i => selectedFrames.add(i));
          requestHistoryReplayFilmBuild();
        }
        else if (op.type === 'multiFrameInsert') {
          const sortedInsertions = [...op.insertions].sort((a, b) => a.idx - b.idx);
          sortedInsertions.forEach(ins => {
            const f = restoreFrameFromSnapshot(ins.snap);
            frames.splice(ins.idx, 0, f);
            updateThumb(ins.idx);
          });
          current = sortedInsertions[0].idx;
          if (op.selSnap) { sel = null; }
          requestHistoryReplayFilmBuild();
        }
        else if (op.type === 'multiFrameDelete') {
          const sortedDeletions = [...op.deletions].sort((a, b) => b.idx - a.idx);
          sortedDeletions.forEach(del => {
            frames.splice(del.idx, 1);
          });
          current = Math.max(0, Math.min(current, frames.length - 1));
          if (op.selSnap) { sel = null; }
          requestHistoryReplayFilmBuild();
        }
        else if (op.type === 'selUpdate') {
          if (sel) {
            sel.img = op.after;
            if (op.x !== undefined) sel.x = op.x;
            if (op.y !== undefined) sel.y = op.y;
          }
          render();
        }
        else if (op.type === 'multiFrameOrderChange') {
          op.indices.forEach((idx, i) => {
            frames[idx] = op.newFrames[i];
          });
          if (op.selSnap) sel = null;
          requestHistoryReplayFilmBuild();
        }
        else if (op.type === 'selMove') {
          if (sel) {
            sel.x = op.toX;
            sel.y = op.toY;
          }
          render();
        }
        else if (op.type === 'selTransform') {
          const snap = op.after || null;
          if (!snap) {
            sel = null;
            render();
            return;
          }

          if (snap._frame !== undefined && snap._frame >= 0 && snap._frame < frames.length) {
            current = snap._frame;
          }
          if (snap.cutLayer !== undefined && snap.cutLayer !== activeLayer) {
            activeLayer = snap.cutLayer;
            updateLayerUI();
          }
          restoreSelectionFromSnapshot(snap);
          if (sel) sel._frame = snap._frame !== undefined ? snap._frame : current;
          render();
        }
      }

      function getOpDescription(op, isRedo) {
        const prefix = isRedo ? 'Redid' : 'Undid';
        const frameInfo = (op.fi !== undefined) ? ` on Frame ${op.fi + 1}` : '';
        const layerInfo = (op.layer !== undefined) ? ` (Layer ${op.layer + 1})` : '';

        switch (op.type) {
          case 'paint':
            return `${prefix} drawing${frameInfo}${layerInfo}`;
          case 'frameInsert':
            return `${prefix} frame insert at ${op.index + 1}`;
          case 'frameDelete':
            return `${prefix} frame delete at ${op.index + 1}`;
          case 'frameReplace':
            return `${prefix} canvas clear on frame ${op.index + 1}`;
          case 'frameMove':
            return `${prefix} moving frame ${op.from + 1} to ${op.to + 1}`;
          case 'multiFrameMove':
            return `${prefix} moving ${op.fromIndices.length} frames to ${op.toStart + 1}`;
          case 'delayChange':
            const dVal = isRedo ? op.newDelay : op.oldDelay;
            return `${prefix} delay change to ${dVal}ms on Frame ${op.frameIndex + 1}`;
          case 'multiDelayChange':
            return `${prefix} updating ${op.changes.length} frame delays`;
          case 'selectionChange':
            return `${prefix} selection of ${op.newSelection ? op.newSelection.length : 0} frames`;
          case 'multiFrameInsert':
            return `${prefix} inserting ${op.insertions.length} frames`;
          case 'multiFrameDelete':
            return `${prefix} deleting ${op.deletions.length} frames`;
          case 'multiFrameOrderChange':
            return `${prefix} inverting order of ${op.indices.length} frames`;
          case 'selUpdate':
            return `${prefix} selection modification`;
          case 'selMove':
            return `${prefix} moving selection${frameInfo}`;
          case 'selTransform':
            return `${prefix} selection ${op.kind || 'transformation'}${frameInfo}`;
          case 'selReappear':
            return `${prefix} selection display`;
          case 'selReappearApplied':
            return `${prefix} selection display`;
          case 'batch':
            return `${prefix} batch operation (${op.ops ? op.ops.length : 0} steps)`;
          default:
            return `${prefix} action`;
        }
      }

      let lastHistoryLockToastAt = 0;
      function isCanvasToolActionActive() {
        if (drawing || smudgeState.active || shapeState.dragging || ditherFillDrag.dragging) return true;
        if (lasso) return true;
        if (lassoPaintStroke) return true;
        if (sel && (sel.state === 'marquee' || sel.state === 'move' || sel.state === 'transform')) return true;
        if (importPreview && (importPreview.dragging || importPreview.resizing || importPreview.cropDragging)) return true;
        if (motionState && motionState.drawing) return true;
        return false;
      }
      function notifyHistoryLocked() {
        const now = Date.now();
        if (now - lastHistoryLockToastAt > 450) {
          showToast('Finish current tool action first');
          lastHistoryLockToastAt = now;
        }
      }

      function doUndo() {
        if (isCanvasToolActionActive()) {
          notifyHistoryLocked();
          return;
        }
        if (!history.length) return;
        const peek = history[history.length - 1];


        if (peek.type === 'paint' && peek.fi !== undefined && peek.fi !== current) {
          setCurrent(peek.fi);
          return;
        }


        const peekLayer = peek.layer !== undefined ? peek.layer : (peek.activeLayer !== undefined ? peek.activeLayer : null);
        if (peek.type === 'paint' && peekLayer !== null && peekLayer !== activeLayer) {
          activeLayer = peekLayer;
          updateLayerUI();
          render();
          return;
        }

        const op = history.pop(); redoStack.push(op); capRedo();
        applyUndoOp(op);
        render();
        if (showHistoryToasts) showToast(getOpDescription(op, false));
      }
      function doRedo() {
        if (isCanvasToolActionActive()) {
          notifyHistoryLocked();
          return;
        }
        if (!redoStack.length) return;
        const op = redoStack.pop(); history.push(op); capHistory();
        applyRedoOp(op);
        render();
        if (showHistoryToasts) showToast(getOpDescription(op, true));
      }


      function togglePlay(force) {
        const want = typeof force === 'boolean' ? force : !playing;
        if (playing === want) return;
        if (want && sel) { commitSelectionIfAny(); }
        if (want && !isPlaybackPaintTool(tool)) {
          setTool('brush');
        }
        playing = want;
        const icon = document.querySelector('#playBtn span');
        if (playing) {
          clearPlaybackStrokeHistory();
          if (icon) icon.textContent = '⏸';
          document.body.classList.add('is-playing');
          delFrameBtn.disabled = true;
          onionBtn.disabled = true;
          updatePlaybackInfo();

          const globalFps = clampFPS(+fpsInp.value || 8);
          const globalInterval = Math.max(1, Math.round(1000 / globalFps));

          let frameStart = Date.now();
          function liveTimer() {
            if (!playing) return;
            updateFrameIndicator(Date.now() - frameStart);
            requestAnimationFrame(liveTimer);
          }
          requestAnimationFrame(liveTimer);

          function nextFrame() {
            if (!playing) return;
            current = (current + 1) % frames.length;
            if (drawing) {
              const holdTool = currentTool();
              if (holdTool === 'brush' || holdTool === 'eraser') {
                dot(lastX, lastY, holdStrokePressure);
              }
            }
            updateFilmActive(); render();

            frameStart = Date.now();

            let delay = globalInterval;
            if (vfrEnabled && frames[current].delay) {
              delay = frames[current].delay;
            }
            playHandle = setTimeout(nextFrame, delay);
          }


          let initialDelay = globalInterval;
          if (vfrEnabled && frames[current].delay) {
            initialDelay = frames[current].delay;
          }
          frameStart = Date.now();
          playHandle = setTimeout(nextFrame, initialDelay);
        }
        else {
          if (icon) icon.textContent = '⏵';
          document.body.classList.remove('is-playing');
          delFrameBtn.disabled = false;
          onionBtn.disabled = false;
          clearPlaybackStrokeHistory();
          updatePlaybackInfo();
          clearTimeout(playHandle); playHandle = null; render();
        }
      }


      window.addEventListener('keydown', (e) => {
        const ae = document.activeElement;
        const tag = ae && ae.tagName;
        const type = (ae && ae.type) || '';
        const ctrl = e.ctrlKey || e.metaKey;
        const isUndoRedoShortcut = ctrl && ['z', 'y'].includes(e.key.toLowerCase());

        const isFormEl = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag);
        const isEditableText = (tag === 'INPUT' && (type === 'text' || type === 'number' || type === 'password' || type === 'search') && !ae.readOnly) || tag === 'TEXTAREA';


        const isGlobalAppShortcut = ctrl && ['e', 's', 'o'].includes(e.key.toLowerCase());

        const allowWhileFocused = isGlobalAppShortcut;

        if (isFormEl && !allowWhileFocused) {
          if (isEditableText) return;
          if (tag === 'SELECT' && !isUndoRedoShortcut) return;


          const interact = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'];



          const needsSpaceEnter = ['BUTTON', 'RADIO', 'CHECKBOX'].includes(type.toUpperCase()) || tag === 'BUTTON';
          if (needsSpaceEnter) {
            interact.push(' ', 'Space', 'Enter');
          }

          if (interact.includes(e.key) || interact.includes(e.code)) return;
        }


        if (tool === 'text' && textState.active) return;


        const motionToolActive = (motionModal && motionModal.style.display === 'flex') ||
          (document.getElementById('motionToolsOverlay')?.style.display === 'block');
        if (motionToolActive) {
          if (e.code === 'Space') {
            e.preventDefault();
            if (typeof playMotionPreview === 'function') playMotionPreview();
            return;
          }

          if (!ctrl) return;
        }

        if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }

        if (ctrl && e.key.toLowerCase() === 'z') {
          e.preventDefault();
          if (e.shiftKey) {
            doRedo();
          } else {
            doUndo();
          }
          return;
        }
        if (ctrl && e.key.toLowerCase() === 'y') {
          e.preventDefault();
          doRedo();
          return;
        }

        if (ctrl && e.key.toLowerCase() === 'e') { e.preventDefault(); openExportModal('gif'); return; }
        if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); openExportModal('flip'); return; }
        if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); openImportPicker(); return; }

        if (ctrl && e.key === '1') { e.preventDefault(); activeLayer = 0; updateLayerUI(); showToast('Layer L1'); return; }
        if (ctrl && e.key === '2') { e.preventDefault(); activeLayer = 1; updateLayerUI(); showToast('Layer L2'); return; }

        if (ctrl && e.key.toLowerCase() === 'c') {
          e.preventDefault();
          if (sel && sel.img) {
            normalizeSel(sel);
            clipboard = {
              img: cloneCanvas(sel.img),
              mask: sel.mask ? cloneCanvas(sel.mask) : null,
              poly: sel.poly ? sel.poly.map(p => ({ x: p.x, y: p.y })) : null,
              w: sel.w, h: sel.h,
              ogX: sel.x, ogY: sel.y,
              offsetX: sel.x, offsetY: sel.y
            };
            showToast('Copied selection');
          }
          return;
        }


        if (ctrl && e.key.toLowerCase() === 'x') {
          e.preventDefault();
          if (sel && sel.img) {
            normalizeSel(sel);
            clipboard = {
              img: cloneCanvas(sel.img),
              mask: sel.mask ? cloneCanvas(sel.mask) : null,
              poly: sel.poly ? sel.poly.map(p => ({ x: p.x, y: p.y })) : null,
              w: sel.w, h: sel.h,
              ogX: sel.x, ogY: sel.y,
              offsetX: sel.x, offsetY: sel.y
            };
            deleteSelection();
            showToast('Cut selection');
          }
          return;
        }

        if (ctrl && e.key.toLowerCase() === 'v') {
          e.preventDefault();
          if (clipboard) {
            dropSelectionForNewPaste();
            const w = clipboard.img.width, h = clipboard.img.height;

            const cx = (clipboard.ogX !== undefined) ? clipboard.ogX : (clipboard.offsetX || 0);
            const cy = (clipboard.ogY !== undefined) ? clipboard.ogY : (clipboard.offsetY || 0);

            const x = (cx | 0);
            const y = (cy | 0);

            sel = {
              x, y,
              w, h,
              img: cloneCanvas(clipboard.img),
              mask: clipboard.mask ? cloneCanvas(clipboard.mask) : null,
              originX: x, originY: y,
              hasCut: true, state: 'idle', source: 'paste',
              poly: clipboard.poly ? clipboard.poly.map(p => ({ x: p.x, y: p.y })) : null,
              cutLayer: activeLayer,
              detached: true,
              _id: (++__selIdSeq),
              _frame: current,
              _moveStart: { x: x, y: y }
            };
            render(); showToast('Pasted');
          }
          return;
        }

        if (ctrl && e.key.toLowerCase() === 'a') {
          e.preventDefault();
          const prevSelection = [...selectedFrames];
          selectedFrames.clear();
          for (let i = 0; i < frames.length; i++) selectedFrames.add(i);
          const newSelection = [...selectedFrames];
          if (prevSelection.length !== newSelection.length) {
            pushSelectionChange(prevSelection, newSelection);
          }
          updateFilmHighlight();
          showToast('Selected all ' + frames.length + ' frames');
          return;
        }

        if (e.key.toLowerCase() === 'a') { e.preventDefault(); addFrame(current + 1); return; }
        if (playing && (e.key === 'Delete' || e.key === 'Backspace')) return;
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          if (!deleteSelection()) {

            if (selectedFrames.size > 1) {
              performMultiDelete([...selectedFrames]);
            } else {
              deleteFrame(current);
            }
          }
          return;
        }

        if (importPreview && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          if (e.key === 'ArrowUp') importPreview.y -= step;
          if (e.key === 'ArrowDown') importPreview.y += step;
          if (e.key === 'ArrowLeft') importPreview.x -= step;
          if (e.key === 'ArrowRight') importPreview.x += step;
          render();
          return;
        }


        if (sel && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
          e.preventDefault();

          ensureSelectionFloating();


          if (!sel._arrowMoveStart) {
            sel._arrowMoveStart = { x: sel.x, y: sel.y };
          }

          const step = e.shiftKey ? 10 : 1;
          if (e.key === 'ArrowUp') sel.y -= step;
          if (e.key === 'ArrowDown') sel.y += step;
          if (e.key === 'ArrowLeft') sel.x -= step;
          if (e.key === 'ArrowRight') sel.x += step;


          clearTimeout(sel._arrowMoveTimer);
          sel._arrowMoveTimer = setTimeout(() => {
            if (sel && sel._arrowMoveStart) {
              const s = sel._arrowMoveStart;
              if (sel.x !== s.x || sel.y !== s.y) {
                if (!sel._id) sel._id = (++__selIdSeq);
                history.push({
                  type: 'selMove',
                  selId: sel._id,
                  fromX: s.x,
                  fromY: s.y,
                  toX: sel.x,
                  toY: sel.y,
                  fi: current,
                  layer: activeLayer
                });
                capHistory?.();
                redoStack.length = 0;
              }
              sel._arrowMoveStart = null;
            }
          }, 500);

          render();
          return;
        }

        if (e.key === 'ArrowLeft') { e.preventDefault(); setCurrent(Math.max(0, current - 1)); return; }
        if (e.key === 'ArrowRight') { e.preventDefault(); setCurrent(Math.min(frames.length - 1, current + 1)); return; }
        if (e.key.toLowerCase() === 'b') { e.preventDefault(); setTool('brush'); return; }
        if (e.key.toLowerCase() === 'e') { e.preventDefault(); setTool('eraser'); return; }
        if (e.key.toLowerCase() === 'f') { e.preventDefault(); setTool('fill'); return; }
        if (e.key.toLowerCase() === 'd') { e.preventDefault(); setTool('ditherFill'); return; }
        if (e.key.toLowerCase() === 's') { e.preventDefault(); setTool('select'); return; }
        if (e.key.toLowerCase() === 'l') { e.preventDefault(); setTool('lasso'); return; }
        if (e.key.toLowerCase() === 'g') { e.preventDefault(); setTool('shape'); return; }
        if (e.key.toLowerCase() === 't') { e.preventDefault(); setTool('text'); return; }
        if (e.key.toLowerCase() === 'j') { e.preventDefault(); setTool('smudge'); return; }
        if (e.key.toLowerCase() === 'k') { e.preventDefault(); setTool('fx'); return; }
        if (e.key.toLowerCase() === 'i') { e.preventDefault(); setPickingEnabled(!picking); return; }
        if (e.key.toLowerCase() === 'o') { e.preventDefault(); onionToggle.checked = !onionToggle.checked; setOnionVisual(); return; }

        if (importPreview) {
          if (e.key === 'Enter') { e.preventDefault(); applyImportPreview(); return; }
          if (e.key === 'Escape') { e.preventDefault(); cancelImportPreview(); return; }
        }
        if (sel) {
          if (e.key === 'Enter') { e.preventDefault(); commitSelectionIfAny(); return; }
          if (e.key === 'Escape') { e.preventDefault(); cancelSelection(); return; }
        }
        if (lassoPaintStroke && e.key === 'Escape') {
          e.preventDefault();
          lassoPaintStroke = null;
          render();
          return;
        }
      });






      const motionBtn = document.getElementById('motionBtn');
      const motionModal = document.getElementById('motionModal');
      const cancelMotionBtn = document.getElementById('cancelMotion');
      const applyMotionBtn = document.getElementById('applyMotion');
      const drawPathBtn = document.getElementById('drawPathBtn');


      const motionDurationInp = document.getElementById('motionDuration');
      const motionLoopSel = document.getElementById('motionLoop');
      const motionRepeatInp = document.getElementById('motionRepeat');
      const motionScaleInp = document.getElementById('motionScale');
      const motionScaleVal = document.getElementById('motionScaleVal');
      const motionRotationInp = document.getElementById('motionRotation');
      const motionRotVal = document.getElementById('motionRotVal');
      const motionOrientInp = document.getElementById('motionOrient');
      const motionEasingSel = document.getElementById('motionEasing');
      const motionBlurInp = document.getElementById('motionBlur');
      const motionBlurVal = document.getElementById('motionBlurVal');
      const motionDensityInp = document.getElementById('motionDensity');
      const motionDensityVal = document.getElementById('motionDensityVal');
      const motionFadeInp = document.getElementById('motionFade');
      const motionFadeVal = document.getElementById('motionFadeVal');
      const motionEffectSel = document.getElementById('motionEffect');


      const motionStationarySection = document.getElementById('motionStationarySection');
      const motionPathSection = document.getElementById('motionPathSection');


      const motionPreviewCanvas = document.getElementById('motionPreview');
      const motionPreviewPlayBtn = document.getElementById('motionPreviewPlay');
      const motionPreviewResetBtn = document.getElementById('motionPreviewReset');


      let motionPreviewImg = null;
      let motionPreviewAnim = null;
      let motionPreviewFrame = 0;


      function resetMotionSettings() {
        if (motionDurationInp) motionDurationInp.value = 20;
        if (motionRepeatInp) motionRepeatInp.value = 1;
        if (motionLoopSel) motionLoopSel.value = 'none';
        if (motionScaleInp) { motionScaleInp.value = 100; if (motionScaleVal) motionScaleVal.textContent = '1.0x'; }
        if (motionRotationInp) { motionRotationInp.value = 0; if (motionRotVal) motionRotVal.textContent = '0°'; }
        if (motionOrientInp) motionOrientInp.checked = false;
        if (motionEasingSel) motionEasingSel.value = 'linear';
        if (motionBlurInp) { motionBlurInp.value = 0; if (motionBlurVal) motionBlurVal.textContent = '0%'; }
        if (motionDensityInp) { motionDensityInp.value = 50; if (motionDensityVal) motionDensityVal.textContent = '50%'; }
        if (motionFadeInp) { motionFadeInp.value = 50; if (motionFadeVal) motionFadeVal.textContent = '50%'; }
        if (motionEffectSel) motionEffectSel.value = '';

        motionState.path = [];
        motionState.points = [];
      }

      resetMotionSettings();


      let motionPreviewThrottle = null;
      function updateMotionPreviewThrottled() {
        if (motionPreviewThrottle) return;
        motionPreviewThrottle = setTimeout(() => {
          motionPreviewThrottle = null;
          updateMotionPreview();
        }, 50);
      }


      if (motionScaleInp) {
        motionScaleInp.addEventListener('input', () => {
          motionScaleVal.textContent = (motionScaleInp.value / 100).toFixed(1) + 'x';

          if (motionEffectSel && motionEffectSel.value !== '') motionEffectSel.value = '';
          updateMotionPreviewThrottled();
        });
      }
      if (motionRotationInp) {
        motionRotationInp.addEventListener('input', () => {
          motionRotVal.textContent = motionRotationInp.value + '°';
          if (motionEffectSel && motionEffectSel.value !== '') motionEffectSel.value = '';
          updateMotionPreviewThrottled();
        });
      }

      [motionDurationInp, motionRepeatInp].forEach(el => {
        if (el) el.addEventListener('change', updateMotionPreview);
        if (el) el.addEventListener('input', updateMotionPreviewThrottled);
      });
      [motionLoopSel, motionOrientInp, motionEasingSel].forEach(el => {
        if (el) el.addEventListener('change', updateMotionPreview);
      });
      if (motionOrientInp && motionRotationInp) {
        motionOrientInp.addEventListener('change', () => {
          const isOrient = motionOrientInp.checked;
          const rotLabel = motionRotationInp.parentElement.querySelector('label');
          if (rotLabel) rotLabel.textContent = isOrient ? 'Angle Offset' : 'Rotation';
          motionRotationInp.disabled = false;
          motionRotationInp.style.opacity = '1';
          updateMotionPreview();
        });
      }

      if (motionBlurInp) {
        motionBlurInp.addEventListener('input', () => {
          motionBlurVal.textContent = motionBlurInp.value + '%';
          updateMotionPreviewThrottled();
        });
        motionBlurInp.addEventListener('change', updateMotionPreview);
      }
      if (motionDensityInp) {
        motionDensityInp.addEventListener('input', () => {
          motionDensityVal.textContent = motionDensityInp.value + '%';
          updateMotionPreviewThrottled();
        });
        motionDensityInp.addEventListener('change', updateMotionPreview);
      }
      if (motionFadeInp) {
        motionFadeInp.addEventListener('input', () => {
          motionFadeVal.textContent = motionFadeInp.value + '%';
          updateMotionPreviewThrottled();
        });
        motionFadeInp.addEventListener('change', updateMotionPreview);
      }


      if (motionEffectSel) {
        motionEffectSel.addEventListener('change', () => {
          const val = motionEffectSel.value;
          if (!val) return;


          if (val === 'pulse') {
            motionLoopSel.value = 'pingpong';
            motionScaleInp.value = 150; motionScaleVal.textContent = '1.5x';
            motionRotationInp.value = 0; motionRotVal.textContent = '0°';
          } else if (val === 'spin') {
            motionLoopSel.value = 'repeat';
            motionScaleInp.value = 100; motionScaleVal.textContent = '1.0x';
            motionRotationInp.value = 360; motionRotVal.textContent = '360°';
          } else if (val === 'throb') {
            motionLoopSel.value = 'pingpong';
            motionScaleInp.value = 120; motionScaleVal.textContent = '1.2x';
            motionRotationInp.value = 0; motionRotVal.textContent = '0°';
            motionDurationInp.value = 10;
          } else if (val === 'wobble') {
            motionLoopSel.value = 'pingpong';
            motionScaleInp.value = 100; motionScaleVal.textContent = '1.0x';
            motionRotationInp.value = 20; motionRotVal.textContent = '20°';
            motionDurationInp.value = 8;
            motionEasingSel.value = 'easeInOut';
          }
          updateMotionPreview();
        });
      }


      if (motionBtn) {
        motionBtn.addEventListener('click', () => {
          if (!sel) {
            showToast('Select an area first!');
            return;
          }
          motionState.active = !motionState.active;
          motionBtn.classList.toggle('active', motionState.active);
          stage.style.cursor = motionState.active ? 'crosshair' : '';

          if (motionState.active) {

            motionState.points = [];
            openMotionModal();
          } else {
            motionState.points = [];
            render();
          }
        });
      }


      const mtOverlay = document.getElementById('motionToolsOverlay');
      const mtFreehand = document.getElementById('mtFreehand');
      const mtPoints = document.getElementById('mtPoints');
      const mtSmoothLabel = document.getElementById('mtSmoothLabel');
      const mtSmooth = document.getElementById('mtSmooth');
      const mtDone = document.getElementById('mtDone');
      const mtClear = document.getElementById('mtClear');

      function startMotionDrawing() {
        if (!motionModal || !mtOverlay) return;
        motionModal.style.display = 'none';
        mtOverlay.style.display = 'block';
        motionState.active = true;
        motionState.drawing = false;
        motionState.returningToModal = true;
        motionState.points = [];
        setMotionMode('freehand');
        stage.style.cursor = 'crosshair';
        showToast('Draw path (Freehand or Points)');
        render();
      }

      function setMotionMode(mode) {
        motionState.mode = mode;
        if (mtFreehand) mtFreehand.classList.toggle('active', mode === 'freehand');
        if (mtPoints) mtPoints.classList.toggle('active', mode === 'points');


        if (mtSmoothLabel) mtSmoothLabel.style.display = (mode === 'points') ? 'flex' : 'none';
      }

      function finishMotionDrawing() {
        if (!motionState.active) return;


        if (motionState.mode === 'points' && mtSmooth && mtSmooth.checked && motionState.points.length > 2) {
          motionState.points = catmullRomSpline(motionState.points);
        } else if (motionState.mode === 'points' && motionState.points.length > 1) {

          motionState.points = densifyLinePath(motionState.points);
        }

        motionState.active = false;
        motionState.drawing = false;
        if (mtOverlay) mtOverlay.style.display = 'none';
        stage.style.cursor = '';

        motionModal.style.display = 'flex';

        const isPath = motionState.points.length > 1;
        if (motionPathSection) motionPathSection.style.display = isPath ? 'block' : 'none';
        if (motionStationarySection) motionStationarySection.style.display = isPath ? 'none' : 'block';


        if (motionOrientInp) {
          motionOrientInp.checked = false;
          if (motionRotationInp) {
            motionRotationInp.disabled = false;
            motionRotationInp.style.opacity = '1';
            const rotLabel = motionRotationInp.parentElement.querySelector('label');
            if (rotLabel) rotLabel.textContent = 'Rotation';
          }
        }

        updateDrawPathBtnLabel();
        updateMotionPreview();
        render();
      }


      function densifyLinePath(pts) {
        const out = [];
        for (let i = 0; i < pts.length - 1; i++) {
          const p0 = pts[i], p1 = pts[i + 1];
          const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
          const steps = Math.ceil(dist / 2);
          for (let s = 0; s < steps; s++) {
            const t = s / steps;
            out.push({ x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t });
          }
        }
        out.push(pts[pts.length - 1]);
        return out;
      }


      function catmullRomSpline(data) {
        if (data.length < 2) return data;
        const pts = [...data];

        pts.unshift(data[0]);
        pts.push(data[data.length - 1]);

        const out = [];
        const alpha = 0.5;

        for (let i = 0; i < pts.length - 3; i++) {
          const p0 = pts[i], p1 = pts[i + 1], p2 = pts[i + 2], p3 = pts[i + 3];

          const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
          const steps = Math.max(5, Math.ceil(dist));

          for (let t = 0; t < steps; t++) {
            const st = t / steps;
            const t2 = st * st;
            const t3 = t2 * st;


            const f1 = -0.5 * t3 + t2 - 0.5 * st;
            const f2 = 1.5 * t3 - 2.5 * t2 + 1.0;
            const f3 = -1.5 * t3 + 2.0 * t2 + 0.5 * st;
            const f4 = 0.5 * t3 - 0.5 * t2;

            const x = p0.x * f1 + p1.x * f2 + p2.x * f3 + p3.x * f4;
            const y = p0.y * f1 + p1.y * f2 + p2.y * f3 + p3.y * f4;
            out.push({ x, y });
          }
        }
        out.push(data[data.length - 1]);
        return out;
      }


      if (mtFreehand) mtFreehand.addEventListener('click', () => setMotionMode('freehand'));
      if (mtPoints) mtPoints.addEventListener('click', () => setMotionMode('points'));
      if (mtDone) mtDone.addEventListener('click', finishMotionDrawing);
      if (mtClear) {
        mtClear.addEventListener('click', () => {
          motionState.path = [];
          motionState.points = [];
          render();
          updateMotionPreview();
        });
      }


      if (drawPathBtn) {
        drawPathBtn.addEventListener('click', startMotionDrawing);
      }


      function getPt(e) {
        const rect = stage.getBoundingClientRect();
        const sx = (e.clientX - rect.left) * (stage.width / rect.width);
        const sy = (e.clientY - rect.top) * (stage.height / rect.height);
        return {
          x: (sx - view.tx) / view.scale,
          y: (sy - view.ty) / view.scale
        };
      }

      stage.addEventListener('pointerdown', e => {
        if (!motionState.active) return;
        e.stopImmediatePropagation();
        const pt = getPt(e);

        if (motionState.mode === 'freehand') {
          motionState.drawing = true;

          if (motionState.points.length === 0) {
            motionState.points = [pt];
          } else {
            motionState.points.push(pt);
          }
        } else {

          motionState.points.push(pt);
        }
        render();
      }, { capture: true });

      window.addEventListener('pointermove', e => {
        if (!motionState.active) return;

        if (motionState.mode === 'freehand' && motionState.drawing) {
          e.stopImmediatePropagation();

          if (e.shiftKey && motionState.points.length > 0) {


            motionState.points.push(getPt(e));
          } else {
            motionState.points.push(getPt(e));
          }
          render();
        }
      }, { capture: true });

      window.addEventListener('pointerup', e => {
        if (!motionState.active) return;
        if (motionState.mode === 'freehand' && motionState.drawing) {
          motionState.drawing = false;

        }
        render();
      }, { capture: true });

      function updateDrawPathBtnLabel() {
        if (!drawPathBtn) return;
        if (motionState.points.length > 1) {
          drawPathBtn.innerHTML = 'Redraw Path (' + motionState.points.length + ' pts)';
        } else {
          drawPathBtn.innerHTML = 'Draw Path';
        }
      }

      function openMotionModal() {
        if (!sel || !sel.img) return;


        if (motionPreviewCanvas) {
          motionPreviewCanvas.width = W;
          motionPreviewCanvas.height = H;
        }


        const isPath = motionState.points.length > 1;

        if (motionPathSection) motionPathSection.style.display = isPath ? 'block' : 'none';
        if (motionStationarySection) motionStationarySection.style.display = isPath ? 'none' : 'block';


        if (!motionState.returningToModal) {
          if (motionDurationInp) motionDurationInp.value = 20;
          if (motionLoopSel) motionLoopSel.value = 'once';
          if (motionRepeatInp) motionRepeatInp.value = 1;
          if (motionScaleInp) { motionScaleInp.value = 100; motionScaleVal.textContent = '1.0x'; }
          if (motionRotationInp) { motionRotationInp.value = 0; motionRotVal.textContent = '0°'; }
          if (motionOrientInp) {
            motionOrientInp.checked = false;
            if (motionRotationInp) {
              motionRotationInp.disabled = false;
              motionRotationInp.style.opacity = '1';
              const rotLabel = motionRotationInp.parentElement.querySelector('label');
              if (rotLabel) rotLabel.textContent = 'Rotation';
            }
          }
          if (motionEasingSel) motionEasingSel.value = 'easeInOut';
          if (motionBlurInp) motionBlurInp.value = 0;
          if (motionEffectSel) motionEffectSel.value = '';
        }


        motionPreviewImg = cloneCanvas(sel.img);
        motionPreviewFrame = 0;

        updateDrawPathBtnLabel();
        motionModal.style.display = 'flex';
        updateMotionPreview();
      }

      function drawMotionOverlay() {
        if (!motionState.active || motionState.points.length < 1) return;
        ctx.save();
        ctx.setTransform(view.scale, 0, 0, view.scale, view.tx, view.ty);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';


        let drawPts = motionState.points;
        const ptsMode = motionState.mode === 'points';
        if (ptsMode && mtSmooth && mtSmooth.checked && drawPts.length > 2) {
          drawPts = catmullRomSpline(drawPts);
        }


        if (drawPts.length > 1) {
          ctx.lineWidth = 4 / view.scale;
          ctx.strokeStyle = '#242628';
          ctx.beginPath();
          ctx.moveTo(drawPts[0].x, drawPts[0].y);
          for (let i = 1; i < drawPts.length; i++) ctx.lineTo(drawPts[i].x, drawPts[i].y);
          ctx.stroke();

          ctx.lineWidth = 2 / view.scale;
          ctx.strokeStyle = '#007aff';
          ctx.beginPath();
          ctx.moveTo(drawPts[0].x, drawPts[0].y);
          for (let i = 1; i < drawPts.length; i++) ctx.lineTo(drawPts[i].x, drawPts[i].y);
          ctx.stroke();


          const arrowSpacing = 80 / view.scale;
          const arrowSize = 6 / view.scale;
          let accumulatedLen = 0;
          let nextArrow = 40 / view.scale;

          ctx.fillStyle = '#007aff';
          ctx.strokeStyle = '#242628';
          ctx.lineWidth = 1 / view.scale;

          for (let i = 0; i < drawPts.length - 1; i++) {
            const p0 = drawPts[i];
            const p1 = drawPts[i + 1];
            const segLen = Math.hypot(p1.x - p0.x, p1.y - p0.y);

            while (accumulatedLen + segLen >= nextArrow) {
              const remaining = nextArrow - accumulatedLen;
              const ratio = remaining / segLen;
              const ax = p0.x + (p1.x - p0.x) * ratio;
              const ay = p0.y + (p1.y - p0.y) * ratio;
              const angle = Math.atan2(p1.y - p0.y, p1.x - p0.x);

              ctx.beginPath();

              const tipX = ax + arrowSize * Math.cos(angle);
              const tipY = ay + arrowSize * Math.sin(angle);

              const b1X = tipX - arrowSize * 2 * Math.cos(angle - Math.PI / 8);
              const b1Y = tipY - arrowSize * 2 * Math.sin(angle - Math.PI / 8);
              const b2X = tipX - arrowSize * 2 * Math.cos(angle + Math.PI / 8);
              const b2Y = tipY - arrowSize * 2 * Math.sin(angle + Math.PI / 8);

              ctx.moveTo(tipX, tipY);
              ctx.lineTo(b1X, b1Y);
              ctx.lineTo(b2X, b2Y);
              ctx.closePath();
              ctx.fill();
              ctx.stroke();

              nextArrow += arrowSpacing;
            }
            accumulatedLen += segLen;
          }
        }


        if (ptsMode) {
          ctx.fillStyle = '#fff';
          ctx.strokeStyle = '#007aff';
          ctx.lineWidth = 2 / view.scale;
          const r = 4 / view.scale;
          for (const p of motionState.points) {
            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
          }
        }

        ctx.restore();
      }


      function updateMotionPreview() {
        if (!motionPreviewImg || !motionPreviewCanvas) return;
        const duration = +motionDurationInp.value || 20;
        const loopMode = motionLoopSel.value;

        let cycleFrames = duration;
        if (loopMode === 'pingpong') cycleFrames = duration * 2;

        drawMotionPreviewFrame(motionPreviewFrame % cycleFrames);
      }

      function drawMotionPreviewFrame(frameIdx) {
        if (!motionPreviewImg || !motionPreviewCanvas) return;
        const pCtx = motionPreviewCanvas.getContext('2d');
        const pW = motionPreviewCanvas.width, pH = motionPreviewCanvas.height;
        pCtx.clearRect(0, 0, pW, pH);

        const duration = +motionDurationInp.value || 20;
        const loopMode = motionLoopSel.value;
        const endScale = (+motionScaleInp.value || 100) / 100;
        const endRot = +motionRotationInp.value || 0;
        const orient = motionOrientInp.checked;
        const easing = motionEasingSel.value;
        const blurStr = +motionBlurInp.value || 0;
        const density = +motionDensityInp?.value || 50;
        const fade = +motionFadeInp?.value || 50;


        let t = 0;
        if (loopMode === 'pingpong') {
          const cycleLen = duration;
          const cyclePos = frameIdx % (cycleLen * 2);
          if (cyclePos < cycleLen) t = cycleLen === 1 ? 0 : cyclePos / (cycleLen - 1);
          else t = cycleLen === 1 ? 0 : 1 - (cyclePos - cycleLen) / (cycleLen - 1);
        } else {
          t = duration === 1 ? 0 : (frameIdx % duration) / (duration - 1);
        }
        t = Math.max(0, Math.min(1, t));

        const easedT = getEasedT(t, easing);


        const sampledPath = motionState.points.length > 1 ? resamplePath(motionState.points, duration) : null;

        const angles = [];
        if (orient && sampledPath && sampledPath.length > 1) {
          for (let i = 0; i < sampledPath.length; i++) {
            const next = sampledPath[Math.min(i + 1, sampledPath.length - 1)];
            const prev = sampledPath[Math.max(0, i - 1)];
            angles.push(Math.atan2(next.y - prev.y, next.x - prev.x) * 180 / Math.PI);
          }
        }

        let curScale = 1 + (endScale - 1) * easedT;
        let curRot = 0;
        if (orient) {
          curRot = endRot;
          if (angles.length) curRot += getAngleAtT(angles, easedT);
        } else {
          curRot = endRot * easedT;
        }

        let img = motionPreviewImg;
        if (curScale !== 1) img = scaleImageNN(img, curScale, curScale);
        if (curRot !== 0) img = rotateImageNN(img, curRot);


        let pos, drawX, drawY;

        if (sampledPath && sel) {
          pos = lerpPath(sampledPath, easedT);
          drawX = Math.round(pos.x - img.width / 2);
          drawY = Math.round(pos.y - img.height / 2);
        } else if (sel) {

          pos = { x: sel.x + sel.w / 2, y: sel.y + sel.h / 2 };
          drawX = Math.round(pos.x - img.width / 2);
          drawY = Math.round(pos.y - img.height / 2);
        } else {
          pos = { x: pW / 2, y: pH / 2 };
          drawX = pW / 2 - img.width / 2;
          drawY = pH / 2 - img.height / 2;
        }

        pCtx.imageSmoothingEnabled = false;


        if (blurStr > 0 && t > 0) {

          const trailLen = (blurStr / 100) * 0.35;
          const prevT = Math.max(0, t - trailLen);

          const transformsChanging = (endScale !== 1 || endRot !== 0 || orient);



          let trailSteps;
          const prevEased = getEasedT(prevT, easing);
          const prevPos = sampledPath ? lerpPath(sampledPath, prevEased) : pos;
          const dist = Math.hypot(pos.x - prevPos.x, pos.y - prevPos.y);


          const baseSteps = Math.max(2, Math.round(2 + (density / 100) * 28));

          if (dist > 1) {

            trailSteps = Math.max(baseSteps, Math.min(30, Math.ceil(dist * (density / 50))));
          } else {

            trailSteps = baseSteps;
            if (transformsChanging) trailSteps = Math.min(trailSteps, 20);
          }

          const trailMode = document.getElementById('motionTrailMode')?.value || 'dither';
          for (let b = trailSteps; b >= 1; b--) {
            const stepRatio = b / (trailSteps + 1);
            const stepT = t - (trailLen * stepRatio);
            if (stepT < 0) continue;

            const stepEased = getEasedT(stepT, easing);

            let trImg = img;
            let trX, trY;

            if (transformsChanging) {
              let sScale = 1 + (endScale - 1) * stepEased;
              let sRot = orient ? endRot : (endRot * stepEased);
              if (orient && angles.length) sRot += getAngleAtT(angles, stepEased);

              trImg = motionPreviewImg;
              if (sScale !== 1) trImg = scaleImageNN(trImg, sScale, sScale);
              if (sRot !== 0) trImg = rotateImageNN(trImg, sRot);
            }

            let sPos;
            if (sampledPath) sPos = lerpPath(sampledPath, stepEased);
            else sPos = pos;

            trX = Math.round(sPos.x - trImg.width / 2);
            trY = Math.round(sPos.y - trImg.height / 2);

            const fadeExp = Math.pow(10, (50 - fade) / 50) * (1.5 - (blurStr / 200));
            let rawAlpha = 1.0 - Math.pow(stepRatio, fadeExp);
            const levels = 8;
            let alpha = Math.floor(rawAlpha * levels) / levels;

            if (alpha > 0) {
              if (trailMode === 'opacity') {
                pCtx.save();
                pCtx.imageSmoothingEnabled = false;
                pCtx.globalAlpha = alpha;
                pCtx.drawImage(trImg, trX, trY);
                pCtx.restore();
              } else {
                drawDithered(pCtx, trImg, trX, trY, alpha);
              }
            }
          }
        }

        pCtx.drawImage(img, drawX, drawY);
      }

      function lerpPath(sampledPath, t) {
        if (sampledPath.length < 2) return sampledPath[0];
        const idx = t * (sampledPath.length - 1);
        const i0 = Math.floor(idx);
        const i1 = Math.min(i0 + 1, sampledPath.length - 1);
        const frac = idx - i0;
        return {
          x: sampledPath[i0].x + (sampledPath[i1].x - sampledPath[i0].x) * frac,
          y: sampledPath[i0].y + (sampledPath[i1].y - sampledPath[i0].y) * frac
        };
      }

      function playMotionPreview() {
        if (motionPreviewAnim) {
          cancelAnimationFrame(motionPreviewAnim);
          motionPreviewAnim = null;
          if (motionPreviewPlayBtn) motionPreviewPlayBtn.classList.remove('playing');
          return;
        }
        if (motionPreviewPlayBtn) motionPreviewPlayBtn.classList.add('playing');

        let lastTime = 0;
        function animate(time) {
          if (time - lastTime > 60) {

            const duration = +motionDurationInp.value || 20;
            const loopMode = motionLoopSel.value;
            let cycleFrames = duration;
            if (loopMode === 'pingpong') cycleFrames = duration * 2;

            motionPreviewFrame = (motionPreviewFrame + 1) % cycleFrames;
            drawMotionPreviewFrame(motionPreviewFrame);
            lastTime = time;
          }
          motionPreviewAnim = requestAnimationFrame(animate);
        }
        motionPreviewAnim = requestAnimationFrame(animate);
      }

      if (motionPreviewPlayBtn) motionPreviewPlayBtn.addEventListener('click', playMotionPreview);
      if (motionPreviewResetBtn) motionPreviewResetBtn.addEventListener('click', () => {
        motionPreviewFrame = 0; drawMotionPreviewFrame(0);
      });


      if (cancelMotionBtn) cancelMotionBtn.onclick = () => {
        if (motionPreviewAnim) cancelAnimationFrame(motionPreviewAnim);
        motionModal.style.display = 'none';
        motionState.points = [];
        motionState.points = [];
        motionState.active = false;
        motionState.returningToModal = false;
        motionBtn.classList.remove('active');
        stage.style.cursor = '';
        render();
      };

      if (applyMotionBtn) applyMotionBtn.onclick = () => {
        if (motionPreviewAnim) cancelAnimationFrame(motionPreviewAnim);
        const duration = +motionDurationInp.value || 20;
        const loopMode = motionLoopSel.value;
        const repeat = +motionRepeatInp.value || 1;
        const endScale = (+motionScaleInp.value || 100) / 100;
        const endRot = +motionRotationInp.value || 0;
        const orient = motionOrientInp ? motionOrientInp.checked : false;
        const easing = motionEasingSel.value;
        const blurStr = +motionBlurInp.value || 0;
        const effect = motionEffectSel ? motionEffectSel.value : '';
        const density = +motionDensityInp?.value || 50;
        const fade = +motionFadeInp?.value || 50;
        const applyMode = document.getElementById('motionApplyMode') ? document.getElementById('motionApplyMode').value : 'merge';

        applyMotion(duration, loopMode, repeat, endScale, endRot, orient, easing, blurStr, effect, density, fade, applyMode);
        motionModal.style.display = 'none';
        motionState.active = false;
        motionState.returningToModal = false;
        motionState.points = [];
        motionBtn.classList.remove('active');
        stage.style.cursor = '';
        render();
      };

      function getEasedT(t, mode) {
        switch (mode) {
          case 'easeIn': return t * t;
          case 'easeOut': return 1 - (1 - t) * (1 - t);
          case 'easeInOut': return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
          case 'bounce': {
            const n = 7.5625, d = 2.75;
            if (t < 1 / d) return n * t * t;
            if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
            if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
            return n * (t -= 2.625 / d) * t + 0.984375;
          }
          case 'back': {
            const c1 = 1.70158; const c3 = c1 + 1;
            return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
          }
          default: return t;
        }
      }


      const ditherCache = {};
      function getMotionAlphaPattern(alpha) {
        const key = Math.floor(alpha * 16);
        if (ditherCache[key]) return ditherCache[key];
        const size = 4;
        const matrix = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const ctx = c.getContext('2d');
        const imgData = ctx.createImageData(size, size);
        const level = alpha * 16;
        for (let i = 0; i < 16; i++) {
          const remove = matrix[i] >= level;
          imgData.data[i * 4 + 3] = remove ? 255 : 0;
        }
        ctx.putImageData(imgData, 0, 0);
        ditherCache[key] = ctx.createPattern(c, 'repeat');
        return ditherCache[key];
      }

      function drawDithered(ctx, img, x, y, alpha) {
        if (alpha >= 1) { ctx.drawImage(img, x, y); return; }
        if (alpha <= 0) return;


        const tCan = makeCanvas(img.width, img.height);
        const tCtx = tCan.getContext('2d');
        tCtx.drawImage(img, 0, 0);

        const pattern = getMotionAlphaPattern(alpha);











        if (pattern.setTransform) {
          pattern.setTransform(new DOMMatrix().translate(-x, -y));
        }

        tCtx.globalCompositeOperation = 'destination-out';
        tCtx.fillStyle = pattern;
        tCtx.fillRect(0, 0, img.width, img.height);

        ctx.drawImage(tCan, x, y);
      }

      function resamplePath(points, count) {
        if (points.length < 2) return Array(count).fill(points[0]);
        let totalLen = 0;
        const lengths = [0];
        for (let i = 1; i < points.length; i++) {
          totalLen += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
          lengths.push(totalLen);
        }
        const newPts = [];
        for (let i = 0; i < count; i++) {
          const t = count === 1 ? 0 : i / (count - 1);
          const dist = t * totalLen;
          let idx = 0;
          while (idx < lengths.length - 1 && lengths[idx + 1] < dist) idx++;
          const p1 = points[idx], p2 = points[idx + 1] || p1;
          const segLen = lengths[idx + 1] - lengths[idx];
          const segT = (segLen === 0) ? 0 : (dist - lengths[idx]) / segLen;
          newPts.push({
            x: p1.x + (p2.x - p1.x) * segT,
            y: p1.y + (p2.y - p1.y) * segT
          });
        }
        return newPts;
      }

      function lerpAngle(a, b, t) {
        let diff = b - a;
        while (diff < -180) diff += 360;
        while (diff > 180) diff -= 360;
        return a + diff * t;
      }

      function getAngleAtT(angles, t) {
        if (!angles || angles.length === 0) return 0;
        if (angles.length === 1) return angles[0];
        const idx = t * (angles.length - 1);
        const i0 = Math.floor(idx);
        const i1 = Math.min(i0 + 1, angles.length - 1);
        const frac = idx - i0;
        return lerpAngle(angles[i0], angles[i1], frac);
      }

      function applyMotion(duration, loopMode, repeat, endScale, endRot, orient, easing, blurStr, effect, density, fade, applyMode = 'merge') {
        if (!sel || !sel.img) {
          showToast('Error: No Selection Found');
          return;
        }

        const framesPerCycle = duration;
        let cycleFrames = framesPerCycle;
        if (loopMode === 'pingpong') cycleFrames = framesPerCycle * 2;
        const totalFrames = cycleFrames * repeat;

        const isPath = motionState.points.length > 1;
        const selCenterX = sel.x + sel.w / 2;
        const selCenterY = sel.y + sel.h / 2;
        const rawPath = isPath ? motionState.points : [{ x: selCenterX, y: selCenterY }];
        const sampledPath = resamplePath(rawPath, framesPerCycle);

        const angles = [];
        if (orient && isPath) {
          for (let i = 0; i < sampledPath.length; i++) {
            const next = sampledPath[Math.min(i + 1, sampledPath.length - 1)];
            const prev = sampledPath[Math.max(0, i - 1)];
            angles.push(Math.atan2(next.y - prev.y, next.x - prev.x) * 180 / Math.PI);
          }
        }

        const startFrame = current;
        const framesCreated = [];
        const batchOps = [];


        const ctx0 = frames[startFrame].layers[activeLayer].ctx;
        const preClear = ctx0.getImageData(sel.x, sel.y, sel.w, sel.h);
        ctx0.clearRect(sel.x, sel.y, sel.w, sel.h);

        batchOps.push({
          type: 'paint', fi: startFrame, layer: activeLayer,
          x: sel.x, y: sel.y, w: sel.w, h: sel.h,
          before: preClear, after: ctx0.getImageData(sel.x, sel.y, sel.w, sel.h)
        });


        const copyContent = (src, dest) => {
          const bgCtx = dest.bg.can.getContext('2d');
          bgCtx.clearRect(0, 0, W, H);
          bgCtx.drawImage(src.bg.can, 0, 0);
          for (let l = 0; l < src.layers.length; l++) {
            if (dest.layers[l]) {
              const lCtx = dest.layers[l].ctx;
              lCtx.clearRect(0, 0, W, H);
              lCtx.drawImage(src.layers[l].can, 0, 0);
            }
          }
        };

        if (applyMode === 'insert' || applyMode === 'blank') {
          const framesNeeded = Math.max(0, totalFrames - 1);
          for (let k = 0; k < framesNeeded; k++) {
            const n = newFrame();
            if (applyMode === 'insert') {
              copyContent(frames[startFrame], n);
            }
            const insertIdx = startFrame + 1 + k;
            frames.splice(insertIdx, 0, n);
            framesCreated.push(insertIdx);
            batchOps.push({ type: 'frameInsert', index: insertIdx, data: snapshotFrame(n), activeLayer });
          }
        } else {

          while (frames.length < startFrame + totalFrames) {
            const n = newFrame();
            copyContent(frames[startFrame], n);
            frames.push(n);
            const newIdx = frames.length - 1;
            framesCreated.push(newIdx);
            batchOps.push({ type: 'frameInsert', index: newIdx, data: snapshotFrame(n), activeLayer });
          }
        }

        const origImg = cloneCanvas(sel.img);


        let currentFrameIndex = 0;
        const BLOCK_SIZE = 5;

        showToast('Applying Motion... 0%');

        function processChunk() {
          const startTime = performance.now();

          while (currentFrameIndex < totalFrames && (performance.now() - startTime) < 16) {
            const i = currentFrameIndex;
            const frameIdx = startFrame + i;
            const layerCtx = frames[frameIdx].layers[activeLayer].ctx;
            layerCtx.imageSmoothingEnabled = false;

            let rawT = 0;
            const cyclePos = i % cycleFrames;

            if (loopMode === 'pingpong') {
              if (cyclePos < framesPerCycle) {
                rawT = framesPerCycle === 1 ? 0 : cyclePos / (framesPerCycle - 1);
              } else {
                const backPos = cyclePos - framesPerCycle;
                rawT = framesPerCycle === 1 ? 0 : 1 - (backPos + 1) / framesPerCycle;
              }
            } else {
              rawT = framesPerCycle === 1 ? 0 : (cyclePos % framesPerCycle) / (framesPerCycle - 1);
            }
            rawT = Math.max(0, Math.min(1, rawT));

            const easedT = getEasedT(rawT, easing);
            const pos = lerpPath(sampledPath, easedT);

            let curScale = 1 + (endScale - 1) * easedT;
            let curRot = 0;
            if (orient) curRot = endRot;
            else curRot = endRot * easedT;

            if (orient && isPath && angles.length) {
              curRot += getAngleAtT(angles, easedT);
            }

            let img = origImg;
            if (curScale !== 1) img = scaleImageNN(img, curScale, curScale);
            if (curRot !== 0) img = rotateImageNN(img, curRot);

            let drawCenterX = pos.x;
            let drawCenterY = pos.y;

            const dx = Math.round(drawCenterX - img.width / 2);
            const dy = Math.round(drawCenterY - img.height / 2);


            let minX = dx, minY = dy, maxX = dx + img.width, maxY = dy + img.height;
            const trailData = [];

            if (blurStr > 0 && rawT > 0) {
              const trailLen = (blurStr / 100) * 0.35;
              const prevT = Math.max(0, rawT - trailLen);
              const transformsChanging = (endScale !== 1 || endRot !== 0 || orient);

              let trailSteps;
              const prevEased = getEasedT(prevT, easing);
              const prevPos = lerpPath(sampledPath, prevEased);
              const dist = Math.hypot(pos.x - prevPos.x, pos.y - prevPos.y);

              const densityVal = density || 50;
              const baseSteps = Math.max(2, Math.round(2 + (densityVal / 100) * 298));

              if (dist > 1) {
                trailSteps = Math.max(baseSteps, Math.min(300, Math.ceil(dist * (densityVal / 10))));
              } else {
                trailSteps = baseSteps;
                if (transformsChanging) trailSteps = Math.min(trailSteps, 80);
              }

              const trailMode = document.getElementById('motionTrailMode')?.value || 'dither';
              for (let b = trailSteps; b >= 1; b--) {
                const stepRatio = b / (trailSteps + 1);
                const stepT = rawT - (trailLen * stepRatio);
                if (stepT < 0) continue;

                const stepEased = getEasedT(stepT, easing);
                const stepPos = lerpPath(sampledPath, stepEased);

                let trScale = 1 + (endScale - 1) * stepEased;
                let trRot = orient ? endRot : (endRot * stepEased);

                if (orient && isPath && angles.length) {
                  trRot += getAngleAtT(angles, stepEased);
                }

                let trImg = origImg;
                if (trScale !== 1) trImg = scaleImageNN(origImg, trScale, trScale);
                if (trRot !== 0) trImg = rotateImageNN(trImg, trRot);

                const trX = Math.round(stepPos.x - trImg.width / 2);
                const trY = Math.round(stepPos.y - trImg.height / 2);

                minX = Math.min(minX, trX);
                minY = Math.min(minY, trY);
                maxX = Math.max(maxX, trX + trImg.width);
                maxY = Math.max(maxY, trY + trImg.height);

                const fadeExp = Math.pow(10, (50 - fade) / 50) * (1.5 - (blurStr / 200));
                let rawAlpha = 1.0 - Math.pow(stepRatio, fadeExp);
                const levels = 8;
                let alpha = Math.floor(rawAlpha * levels) / levels;

                if (alpha > 0) {
                  trailData.push({ img: trImg, x: trX, y: trY, alpha: alpha, mode: trailMode });
                }
              }
            }


            minX = Math.max(0, minX);
            minY = Math.max(0, minY);
            maxX = Math.min(W, maxX);
            maxY = Math.min(H, maxY);

            const rectW = maxX - minX;
            const rectH = maxY - minY;

            if (rectW > 0 && rectH > 0) {
              const before = layerCtx.getImageData(minX, minY, rectW, rectH);

              for (const step of trailData) {
                if (step.mode === 'opacity') {
                  layerCtx.save();
                  layerCtx.imageSmoothingEnabled = false;
                  layerCtx.globalAlpha = step.alpha;
                  layerCtx.drawImage(step.img || img, step.x, step.y);
                  layerCtx.restore();
                } else {
                  drawDithered(layerCtx, step.img || img, step.x, step.y, step.alpha);
                }
              }

              layerCtx.drawImage(img, dx, dy);

              const after = layerCtx.getImageData(minX, minY, rectW, rectH);

              batchOps.push({
                type: 'paint', fi: frameIdx, layer: activeLayer,
                x: minX, y: minY, w: rectW, h: rectH,
                before: before, after: after
              });

              updateThumb(frameIdx);
            }

            currentFrameIndex++;
          }

          if (currentFrameIndex < totalFrames) {
            const pct = Math.round((currentFrameIndex / totalFrames) * 100);
            showToast(`Applying Motion... ${pct}%`);
            requestAnimationFrame(processChunk);
          } else {

            history.push({ type: 'batch', ops: batchOps });
            capHistory();
            redoStack.length = 0;

            current = startFrame + totalFrames - 1;
            setCurrent(current);
            refreshAllFilmTileThumbs();

            showToast('Motion Path Applied');
            sel = null;
          }
        }

        requestAnimationFrame(processChunk);
      }


      function scaleImageNN(srcCanvas, scaleX, scaleY) {
        const srcW = srcCanvas.width, srcH = srcCanvas.height;
        const newW = Math.max(1, Math.round(srcW * scaleX));
        const newH = Math.max(1, Math.round(srcH * scaleY));

        const srcCtx = srcCanvas.getContext('2d');
        const srcData = srcCtx.getImageData(0, 0, srcW, srcH);
        const src = srcData.data;

        const dst = makeCanvas(newW, newH);
        const dstCtx = dst.getContext('2d');
        const dstData = dstCtx.createImageData(newW, newH);
        const dstPx = dstData.data;

        for (let y = 0; y < newH; y++) {
          for (let x = 0; x < newW; x++) {
            const sx = Math.floor(x / scaleX);
            const sy = Math.floor(y / scaleY);
            if (sx >= 0 && sx < srcW && sy >= 0 && sy < srcH) {
              const srcIdx = (sy * srcW + sx) * 4;
              const dstIdx = (y * newW + x) * 4;
              dstPx[dstIdx] = src[srcIdx];
              dstPx[dstIdx + 1] = src[srcIdx + 1];
              dstPx[dstIdx + 2] = src[srcIdx + 2];
              dstPx[dstIdx + 3] = src[srcIdx + 3];
            }
          }
        }
        dstCtx.putImageData(dstData, 0, 0);
        return dst;
      }

      function rotateImageNN(srcCanvas, angleDeg) {
        const srcW = srcCanvas.width, srcH = srcCanvas.height;
        const rad = angleDeg * Math.PI / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const absCos = Math.abs(cos), absSin = Math.abs(sin);

        let newW = Math.ceil(srcW * absCos + srcH * absSin);
        let newH = Math.ceil(srcH * absCos + srcW * absSin);
        if (newW % 2 !== 0) newW++;
        if (newH % 2 !== 0) newH++;

        const srcCtx = srcCanvas.getContext('2d');
        const srcData = srcCtx.getImageData(0, 0, srcW, srcH);
        const src = srcData.data;

        const dst = makeCanvas(newW, newH);
        const dstCtx = dst.getContext('2d');
        const dstData = dstCtx.createImageData(newW, newH);
        const dstPx = dstData.data;

        const cx0 = srcW / 2, cy0 = srcH / 2;
        const cx1 = newW / 2, cy1 = newH / 2;

        for (let y = 0; y < newH; y++) {
          for (let x = 0; x < newW; x++) {
            const dx = x - cx1, dy = y - cy1;
            const sx = Math.round(dx * cos + dy * sin + cx0);
            const sy = Math.round(-dx * sin + dy * cos + cy0);

            if (sx >= 0 && sx < srcW && sy >= 0 && sy < srcH) {
              const srcIdx = (sy * srcW + sx) * 4;
              const dstIdx = (y * newW + x) * 4;
              dstPx[dstIdx] = src[srcIdx];
              dstPx[dstIdx + 1] = src[srcIdx + 1];
              dstPx[dstIdx + 2] = src[srcIdx + 2];
              dstPx[dstIdx + 3] = src[srcIdx + 3];
            }
          }
        }
        dstCtx.putImageData(dstData, 0, 0);
        return dst;
      }



      function findGifParserOnWindow() {
        const candidates = [];
        if (window.Gifuct) candidates.push(window.Gifuct);
        if (window.gifuct) candidates.push(window.gifuct);
        if (window.GIFuct) candidates.push(window.GIFuct);
        if (typeof window.parseGIF === 'function' && typeof window.decompressFrames === 'function') {
          candidates.push({ parseGIF: window.parseGIF, decompressFrames: window.decompressFrames });
        }
        for (const k in window) {
          try {
            const v = window[k];
            if (v && typeof v === 'object') {
              if (typeof v.parseGIF === 'function' && typeof v.decompressFrames === 'function') return v;
              if (v.default && typeof v.default.parseGIF === 'function' && typeof v.default.decompressFrames === 'function') return v.default;
            }
          } catch (_) { }
        }
        return candidates.find(Boolean) || null;
      }
      async function ensureGifuct() {
        try {
          const mod = await import('https://cdn.jsdelivr.net/npm/gifuct-js@2.1.2/+esm');
          if (mod && mod.parseGIF && mod.decompressFrames) return mod;
          if (mod && mod.default && mod.default.parseGIF) return mod.default;
        } catch (_) { }
        try {
          const mod2 = await import('https://unpkg.com/gifuct-js@2.1.2/+esm');
          if (mod2 && mod2.parseGIF && mod2.decompressFrames) return mod2;
          if (mod2 && mod2.default && mod2.default.parseGIF) return mod2.default;
        } catch (_) { }
        for (let i = 0; i < 20; i++) {
          const g = findGifParserOnWindow(); if (g) return g;
          await new Promise(r => setTimeout(r, 100));
        }
        throw new Error('gif importer not loaded');
      }


      async function parseGifToFrames(arrayBuffer) {
        const lib = await ensureGifuct();
        const gif = lib.parseGIF(arrayBuffer);
        const framesData = lib.decompressFrames(gif, true);

        const gW = gif?.lsd?.width || Math.max(...framesData.map(f => (f.dims.left + f.dims.width))) || 0;
        const gH = gif?.lsd?.height || Math.max(...framesData.map(f => (f.dims.top + f.dims.height))) || 0;

        if (gW < 1 || gH < 1) throw new Error('Invalid GIF size');


        const workCan = document.createElement('canvas');
        workCan.width = gW; workCan.height = gH;
        const wctx = workCan.getContext('2d', { alpha: true, willReadFrequently: true });
        wctx.imageSmoothingEnabled = false;


        const patchCan = document.createElement('canvas');
        const pctx = patchCan.getContext('2d', { alpha: true });
        pctx.imageSmoothingEnabled = false;

        const built = [];

        for (let i = 0; i < framesData.length; i++) {
          const fr = framesData[i];


          let prevSnap = null;
          if (fr.disposalType === 3) {
            prevSnap = wctx.getImageData(0, 0, gW, gH);
          }


          patchCan.width = fr.dims.width;
          patchCan.height = fr.dims.height;
          const imgData = pctx.createImageData(fr.dims.width, fr.dims.height);
          imgData.data.set(fr.patch);
          pctx.putImageData(imgData, 0, 0);


          wctx.drawImage(patchCan, fr.dims.left, fr.dims.top);


          const frameCan = document.createElement('canvas');
          frameCan.width = gW; frameCan.height = gH;
          const fctx = frameCan.getContext('2d');
          fctx.imageSmoothingEnabled = false;
          fctx.drawImage(workCan, 0, 0);
          built.push({ can: frameCan, delay: (fr.delay || 10) * 10 });


          if (fr.disposalType === 2) {

            wctx.clearRect(fr.dims.left, fr.dims.top, fr.dims.width, fr.dims.height);
          } else if (fr.disposalType === 3 && prevSnap) {

            wctx.putImageData(prevSnap, 0, 0);
          }

        }

        return { frames: built, width: gW, height: gH };
      }


      function showImportPreviewUI() {
        const overlay = document.getElementById('importPreviewOverlay');
        const countInp = document.getElementById('importFrameCount');
        if (countInp) delete countInp.dataset.inited;
        if (overlay) overlay.style.display = 'flex';
      }
      function hideImportPreviewUI() {
        const overlay = document.getElementById('importPreviewOverlay');
        if (overlay) overlay.style.display = 'none';
      }
      function updateImportInfoText() {
        const infoText = document.getElementById('importInfoText');
        const countInp = document.getElementById('importFrameCount');
        const modeSel = document.getElementById('importMode');

        if (!infoText || !importPreview) return;


        if (countInp && !countInp.dataset.inited) {
          countInp.dataset.inited = 'true';
          if (importPreview.isGif && importPreview.gifFrames) {
            countInp.value = importPreview.gifFrames.length;
          } else {
            countInp.value = 1;
          }

          if (modeSel) modeSel.value = 'overlay';
        }

        if (importPreview.isGif && importPreview.gifFrames) {
          infoText.innerHTML = `<strong>${importPreview.gifFrames.length}</strong> frames<br>${importPreview.origW}×${importPreview.origH}`;
        } else {
          infoText.innerHTML = `${importPreview.origW}×${importPreview.origH}px`;
        }
      }


      function cancelImportPreview() {
        importPreview = null;
        hideImportPreviewUI();
        render();
      }


      function applyImportPreview() {
        if (!importPreview || !importPreview.img) return;

        const countInp = document.getElementById('importFrameCount');
        const modeSel = document.getElementById('importMode');
        const targetCount = countInp ? Math.max(1, parseInt(countInp.value) || 1) : 1;
        const mode = modeSel ? modeSel.value : 'overlay';

        const destX = Math.round(importPreview.x);
        const destY = Math.round(importPreview.y);
        const destW = Math.round(importPreview.w);
        const destH = Math.round(importPreview.h);


        let sourceFrames = [];
        if (importPreview.isGif && importPreview.gifFrames && importPreview.gifFrames.length > 0) {
          const origFrames = importPreview.gifFrames;

          if (targetCount === origFrames.length) {
            sourceFrames = origFrames;
          } else {
            for (let i = 0; i < targetCount; i++) {

              const srcIdx = Math.floor(i * (origFrames.length / targetCount));
              sourceFrames.push(origFrames[Math.min(origFrames.length - 1, srcIdx)]);
            }
          }
        } else {


          for (let i = 0; i < targetCount; i++) sourceFrames.push({ drawable: importPreview.img });
        }


        const safeX = Math.max(0, destX);
        const safeY = Math.max(0, destY);
        const safeW = Math.min(destW, W - safeX);
        const safeH = Math.min(destH, H - safeY);

        let addedFrames = 0;
        const batchOps = [];


        if (mode === 'insert') {
          for (let k = 0; k < targetCount; k++) {
            const newF = newFrame();
            frames.splice(current + k, 0, newF);

            batchOps.push({
              type: 'frameInsert',
              index: current + k,
              data: snapshotFrame(newF),
              activeLayer
            });
          }
          addedFrames = targetCount;
        }

        for (let i = 0; i < targetCount; i++) {
          const src = sourceFrames[i];
          let targetFrameIdx = current + i;


          if (mode === 'overlay') {
            if (targetFrameIdx >= frames.length) {
              const newF = newFrame();
              frames.push(newF);
              addedFrames++;
              batchOps.push({
                type: 'frameInsert',
                index: targetFrameIdx,
                data: snapshotFrame(newF),
                activeLayer
              });
            }
          }


          const fctx = frames[targetFrameIdx].layers[activeLayer].ctx;
          const before = fctx.getImageData(safeX, safeY, Math.max(1, safeW), Math.max(1, safeH));

          fctx.imageSmoothingEnabled = false;

          const drawable = src.can || src.drawable;
          fctx.drawImage(drawable, 0, 0, importPreview.origW, importPreview.origH, destX, destY, destW, destH);

          const after = fctx.getImageData(safeX, safeY, Math.max(1, safeW), Math.max(1, safeH));


          batchOps.push({
            type: 'paint',
            fi: targetFrameIdx,
            x: safeX,
            y: safeY,
            w: Math.max(1, safeW),
            h: Math.max(1, safeH),
            before,
            after,
            layer: activeLayer
          });



        }


        history.push({ type: 'batch', ops: batchOps, activeLayer });
        capHistory();
        redoStack.length = 0;

        updateAllThumbs(); buildFilm();

        let msg = `Applied ${targetCount} frames`;
        if (mode === 'insert') msg += ` (Inserted)`;
        else if (addedFrames > 0) msg += ` (+${addedFrames} new)`;
        showToast(msg);

        importPreview = null;
        hideImportPreviewUI();
        render();
      }


      function calcImportSize(origW, origH) {
        let w = origW, h = origH;

        if (w > W || h > H) {
          const scaleW = W / w;
          const scaleH = H / h;
          const scale = Math.min(scaleW, scaleH);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        return { w, h };
      }


      async function handleGifImportFile(file) {
        if (!file) return;
        if (!/\.gif$/i.test(file.name)) {
          showToast('Please select a .gif file');
          return;
        }

        try {

          if (sel) commitSelectionIfAny();

          const arrayBuffer = await file.arrayBuffer();
          const result = await parseGifToFrames(arrayBuffer);


          const firstFrame = result.frames[0].can;
          const { w: previewW, h: previewH } = calcImportSize(result.width, result.height);

          importPreview = {
            img: firstFrame,
            x: Math.floor((W - previewW) / 2),
            y: Math.floor((H - previewH) / 2),
            w: previewW,
            h: previewH,
            origW: result.width,
            origH: result.height,
            isGif: true,
            gifFrames: result.frames,
            dragging: false,
            resizing: false,
            resizeHandle: null,
            dragDX: 0,
            dragDY: 0
          };

          showImportPreviewUI();
          updateImportInfoText();
          render();
        } catch (err) {
          console.error(err);
          showToast('Failed to load GIF');
        }
      }

      async function handleGifImport(ev) {
        const file = ev.target.files?.[0];
        ev.target.value = '';
        if (!file) return;
        await handleGifImportFile(file);
      }


      async function handleImageImportFile(file) {
        if (!file) return;

        const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
        const validExtensions = ['.png', '.jpg', '.jpeg', '.webp'];
        const hasValidExt = validExtensions.some(ext => file.name.toLowerCase().endsWith(ext));
        const hasValidType = validTypes.includes(file.type);

        if (!hasValidExt && !hasValidType) {
          showToast('Unsupported file type. Use PNG, JPG, or WebP');
          return;
        }

        try {

          if (sel) commitSelectionIfAny();
          const img = new Image();
          await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
            img.src = URL.createObjectURL(file);
          });


          const can = document.createElement('canvas');
          can.width = img.width;
          can.height = img.height;
          const cctx = can.getContext('2d');
          cctx.drawImage(img, 0, 0);
          URL.revokeObjectURL(img.src);


          const { w: previewW, h: previewH } = calcImportSize(img.width, img.height);

          importPreview = {
            img: can,
            x: Math.floor((W - previewW) / 2),
            y: Math.floor((H - previewH) / 2),
            w: previewW,
            h: previewH,
            origW: img.width,
            origH: img.height,
            isGif: false,
            gifFrames: null,
            dragging: false,
            resizing: false,
            resizeHandle: null,
            dragDX: 0,
            dragDY: 0
          };

          showImportPreviewUI();
          updateImportInfoText();
          render();
        } catch (err) {
          console.error(err);
          showToast('Failed to load image');
        }
      }

      async function handleImageImport(ev) {
        const file = ev.target.files?.[0];
        ev.target.value = '';
        if (!file) return;
        await handleImageImportFile(file);
      }


      function getImportResizeHandle(px, py) {
        if (!importPreview) return null;
        const hs = 16 / view.scale;
        const corners = {
          'nw': [importPreview.x, importPreview.y],
          'ne': [importPreview.x + importPreview.w, importPreview.y],
          'sw': [importPreview.x, importPreview.y + importPreview.h],
          'se': [importPreview.x + importPreview.w, importPreview.y + importPreview.h]
        };
        for (const [name, [cx, cy]] of Object.entries(corners)) {
          if (Math.abs(px - cx) < hs && Math.abs(py - cy) < hs) return name;
        }
        return null;
      }


      function isInsideImportPreview(px, py) {
        if (!importPreview) return false;
        return px >= importPreview.x && px <= importPreview.x + importPreview.w &&
          py >= importPreview.y && py <= importPreview.y + importPreview.h;
      }


      function toggleImportCrop() {
        if (!importPreview) return;

        const cropBtn = document.getElementById('importCrop');
        const applyBtn = document.getElementById('importApply');

        if (importPreview.cropping) {

          if (importPreview.cropRect) {
            applyCropToImport();
          }
          importPreview.cropping = false;
          importPreview.cropRect = null;
          importPreview.cropDragging = false;
          if (cropBtn) {
            cropBtn.textContent = '✂ Crop';
            cropBtn.classList.remove('primary');
          }

          if (applyBtn) {
            applyBtn.disabled = false;
            applyBtn.style.opacity = '';
            applyBtn.style.pointerEvents = '';
          }
        } else {

          importPreview.cropping = true;
          importPreview.cropRect = { x: 0, y: 0, w: importPreview.origW, h: importPreview.origH };
          importPreview.cropDragging = false;
          if (cropBtn) {
            cropBtn.textContent = '✓ Done';
            cropBtn.classList.add('primary');
          }

          if (applyBtn) {
            applyBtn.disabled = true;
            applyBtn.style.opacity = '0.4';
            applyBtn.style.pointerEvents = 'none';
          }
          showToast('Drag on image to select crop region');
        }
        render();
      }


      function applyCropToImport() {
        if (!importPreview || !importPreview.cropRect) return;

        const cr = importPreview.cropRect;
        if (cr.w < 1 || cr.h < 1) return;


        const croppedCan = document.createElement('canvas');
        croppedCan.width = cr.w;
        croppedCan.height = cr.h;
        const cctx = croppedCan.getContext('2d');
        cctx.imageSmoothingEnabled = false;
        cctx.drawImage(importPreview.img, cr.x, cr.y, cr.w, cr.h, 0, 0, cr.w, cr.h);


        if (importPreview.isGif && importPreview.gifFrames) {
          const croppedFrames = importPreview.gifFrames.map(frame => {
            const frameCan = document.createElement('canvas');
            frameCan.width = cr.w;
            frameCan.height = cr.h;
            const fctx = frameCan.getContext('2d');
            fctx.imageSmoothingEnabled = false;
            fctx.drawImage(frame.can, cr.x, cr.y, cr.w, cr.h, 0, 0, cr.w, cr.h);
            return { can: frameCan, delay: frame.delay };
          });
          importPreview.gifFrames = croppedFrames;
        }


        const { w: previewW, h: previewH } = calcImportSize(cr.w, cr.h);
        importPreview.img = croppedCan;
        importPreview.origW = cr.w;
        importPreview.origH = cr.h;
        importPreview.w = previewW;
        importPreview.h = previewH;

        importPreview.x = Math.floor((W - previewW) / 2);
        importPreview.y = Math.floor((H - previewH) / 2);

        updateImportInfoText();
        showToast(`Cropped to ${cr.w}×${cr.h}`);
      }


      function handleImportCropStart(px, py) {
        if (!importPreview || !importPreview.cropping) return false;


        const scaleX = importPreview.origW / importPreview.w;
        const scaleY = importPreview.origH / importPreview.h;
        const imgX = (px - importPreview.x) * scaleX;
        const imgY = (py - importPreview.y) * scaleY;


        if (imgX < 0 || imgX > importPreview.origW || imgY < 0 || imgY > importPreview.origH) {
          return false;
        }

        const cr = importPreview.cropRect;
        const handleSize = 12 * scaleX;


        if (cr && cr.w > 1 && cr.h > 1) {
          const corners = [
            { name: 'nw', x: cr.x, y: cr.y },
            { name: 'ne', x: cr.x + cr.w, y: cr.y },
            { name: 'sw', x: cr.x, y: cr.y + cr.h },
            { name: 'se', x: cr.x + cr.w, y: cr.y + cr.h }
          ];

          for (const c of corners) {
            if (Math.abs(imgX - c.x) < handleSize && Math.abs(imgY - c.y) < handleSize) {
              importPreview.cropMode = 'resize';
              importPreview.cropHandle = c.name;
              importPreview.cropStartRect = { ...cr };
              importPreview.cropMouseStartX = imgX;
              importPreview.cropMouseStartY = imgY;
              importPreview.cropDragging = true;
              return true;
            }
          }


          if (imgX >= cr.x && imgX <= cr.x + cr.w && imgY >= cr.y && imgY <= cr.y + cr.h) {
            importPreview.cropMode = 'move';
            importPreview.cropDragOffsetX = imgX - cr.x;
            importPreview.cropDragOffsetY = imgY - cr.y;
            importPreview.cropDragging = true;
            return true;
          }
        }


        importPreview.cropMode = 'create';
        importPreview.cropDragging = true;
        importPreview.cropStartX = Math.max(0, Math.min(importPreview.origW, Math.round(imgX)));
        importPreview.cropStartY = Math.max(0, Math.min(importPreview.origH, Math.round(imgY)));
        importPreview.cropRect = {
          x: importPreview.cropStartX,
          y: importPreview.cropStartY,
          w: 1,
          h: 1
        };
        return true;
      }

      function handleImportCropMove(px, py) {
        if (!importPreview || !importPreview.cropping || !importPreview.cropDragging) return;

        const scaleX = importPreview.origW / importPreview.w;
        const scaleY = importPreview.origH / importPreview.h;
        const imgX = Math.max(0, Math.min(importPreview.origW, Math.round((px - importPreview.x) * scaleX)));
        const imgY = Math.max(0, Math.min(importPreview.origH, Math.round((py - importPreview.y) * scaleY)));

        const cr = importPreview.cropRect;

        if (importPreview.cropMode === 'create') {

          const x1 = Math.min(importPreview.cropStartX, imgX);
          const y1 = Math.min(importPreview.cropStartY, imgY);
          const x2 = Math.max(importPreview.cropStartX, imgX);
          const y2 = Math.max(importPreview.cropStartY, imgY);

          importPreview.cropRect = {
            x: x1,
            y: y1,
            w: Math.max(1, x2 - x1),
            h: Math.max(1, y2 - y1)
          };
        } else if (importPreview.cropMode === 'move') {

          let newX = imgX - importPreview.cropDragOffsetX;
          let newY = imgY - importPreview.cropDragOffsetY;


          newX = Math.max(0, Math.min(importPreview.origW - cr.w, newX));
          newY = Math.max(0, Math.min(importPreview.origH - cr.h, newY));

          cr.x = Math.round(newX);
          cr.y = Math.round(newY);
        } else if (importPreview.cropMode === 'resize') {

          const sr = importPreview.cropStartRect;
          const dx = imgX - importPreview.cropMouseStartX;
          const dy = imgY - importPreview.cropMouseStartY;
          const h = importPreview.cropHandle;

          let newX = sr.x, newY = sr.y, newW = sr.w, newH = sr.h;

          if (h === 'se') {
            newW = Math.max(1, sr.w + dx);
            newH = Math.max(1, sr.h + dy);
          } else if (h === 'sw') {
            newX = sr.x + dx;
            newW = Math.max(1, sr.w - dx);
            newH = Math.max(1, sr.h + dy);
          } else if (h === 'ne') {
            newY = sr.y + dy;
            newW = Math.max(1, sr.w + dx);
            newH = Math.max(1, sr.h - dy);
          } else if (h === 'nw') {
            newX = sr.x + dx;
            newY = sr.y + dy;
            newW = Math.max(1, sr.w - dx);
            newH = Math.max(1, sr.h - dy);
          }


          newX = Math.max(0, Math.min(importPreview.origW - 1, newX));
          newY = Math.max(0, Math.min(importPreview.origH - 1, newY));
          newW = Math.min(newW, importPreview.origW - newX);
          newH = Math.min(newH, importPreview.origH - newY);

          importPreview.cropRect = {
            x: Math.round(newX),
            y: Math.round(newY),
            w: Math.max(1, Math.round(newW)),
            h: Math.max(1, Math.round(newH))
          };
        }
        render();
      }

      function handleImportCropEnd() {
        if (!importPreview) return;
        importPreview.cropDragging = false;
        importPreview.cropMode = null;
        importPreview.cropHandle = null;
      }


      document.getElementById('importCancel')?.addEventListener('click', cancelImportPreview);
      document.getElementById('importApply')?.addEventListener('click', applyImportPreview);
      document.getElementById('importCrop')?.addEventListener('click', toggleImportCrop);


      function rgbaToHex(r, g, b, a) { if (a === 0) return '#ffffff'; const to2 = n => n.toString(16).padStart(2, '0'); return '#' + to2(r) + to2(g) + to2(b); }


      function showToast(msg) {
        if (!toast) return;
        toast.innerHTML = msg;
        toast.classList.add('show');
        clearTimeout(showToast._t);
        showToast._t = setTimeout(() => toast.classList.remove('show'), 1200);
      }


      function resetAllTools() {
        if (typeof durationInp !== 'undefined' && durationInp) durationInp.value = 10;
        if (typeof blurInp !== 'undefined' && blurInp) blurInp.value = 0;
        const eSel = document.getElementById('motionEasing');
        if (eSel) eSel.value = 'linear';
        const sFill = document.getElementById('shapeFill');
        if (sFill) sFill.checked = false;
        const tSize = document.getElementById('textSize');
        if (tSize) tSize.value = 1;
        const tVal = document.getElementById('textSizeVal');
        if (tVal) tVal.textContent = '1x';
        const tBold = document.getElementById('textBold');
        if (tBold) tBold.classList.remove('active');
        const tItalic = document.getElementById('textItalic');
        if (tItalic) tItalic.classList.remove('active');
        const tFont = document.getElementById('textFont');
        if (tFont) tFont.value = 'Standard';
        const tFontInline = document.getElementById('textFontInline');
        if (tFontInline) tFontInline.value = 'Standard';
        textState.font = 'Standard';
      }
      resetAllTools();


      if (document.getElementById('ditherFillInvert')) document.getElementById('ditherFillInvert').checked = false;
      if (document.getElementById('ditherFillShape')) document.getElementById('ditherFillShape').checked = false;
      if (document.getElementById('ditherFillMode')) document.getElementById('ditherFillMode').value = 'linear';
      ditherFill.mode = 'linear';
      ditherFill.invert = false;
      ditherFill.shapeFill = false;





      const bgBox = document.getElementById('bgColorBox');
      const bgInp = document.getElementById('bgColorInput');
      if (bgBox && bgInp) {
        bgBox.addEventListener('click', async () => {
          if (typeof openColorPicker === 'function') {
            const hex = await openColorPicker(bgInp.value);
            if (hex) {
              bgInp.value = hex;
              bgBox.style.background = hex;
            }
          } else {
            bgInp.click();
          }
        });

        bgInp.addEventListener('input', () => {
          bgBox.style.background = bgInp.value;
        });
      }


      function checkOverwrite() {
        return new Promise(resolve => {
          const suppress = localStorage.getItem('fliplite_suppressOverwrite') === 'true';
          const m = document.getElementById('overwriteBackdrop');

          if (suppress || !m) { resolve(true); return; }

          const btnY = document.getElementById('overwriteConfirm');
          const btnN = document.getElementById('overwriteCancel');
          const chk = document.getElementById('overwriteSuppress');

          m.style.display = 'flex';
          let handled = false;

          const cleanup = () => {
            m.style.display = 'none';
            btnY.onclick = null; btnN.onclick = null;
          };

          btnY.onclick = (e) => {
            e.preventDefault(); e.stopPropagation();
            if (handled) return; handled = true;
            if (chk && chk.checked) localStorage.setItem('fliplite_suppressOverwrite', 'true');
            cleanup(); resolve(true);
          };
          btnN.onclick = (e) => {
            e.preventDefault(); e.stopPropagation();
            if (handled) return; handled = true;
            cleanup(); resolve(false);
          };
        });
      }


      const dropOverlay = document.getElementById('dropOverlay');
      if (dropOverlay) {
        let dragCounter = 0;
        window.addEventListener('dragenter', (e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          if (typeof playing !== 'undefined' && playing) return;
          dragCounter++;
          dropOverlay.style.display = 'flex';
        });
        window.addEventListener('dragover', (e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
        });
        window.addEventListener('dragleave', (e) => {
          e.preventDefault();
          if (typeof playing !== 'undefined' && playing) return;
          dragCounter--;
          if (dragCounter <= 0) {
            dragCounter = 0;
            dropOverlay.style.display = 'none';
          }
        });
        window.addEventListener('drop', async (e) => {
          e.preventDefault();
          dragCounter = 0;
          dropOverlay.style.display = 'none';

          if (typeof playing !== 'undefined' && playing) return;

          if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
          const file = e.dataTransfer.files[0];
          const name = file.name.toLowerCase();

          if (name.endsWith('.flip') || name.endsWith('.json')) {
            openProjectFlipFile(file);
          } else if (name.endsWith('.gif')) {
            handleGifImportFile(file);
          } else if (name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.webp')) {
            handleImageImportFile(file);
          } else {
            showToast('File not supported: ' + file.name);
          }
        });
      }

      canvasSizeTxt.textContent = W + '×' + H;
      setTool('brush');
      applyFilmstripStyle(filmstripStyle, { rebuild: false });
      updateAllThumbs(); buildFilm(); centerView(); setOnionVisual(); render(); updateFilmFades();

      const isElectron = navigator.userAgent.toLowerCase().indexOf(' electron/') > -1;
      const ua = navigator.userAgent.toLowerCase();
      const isSafari = /safari/.test(ua) && !/chrome/.test(ua) && !/android/.test(ua);

      if (isSafari && !isElectron) {
        const safariBlock = document.getElementById('safariBlock');
        const app = document.getElementById('app');
        const loading = document.getElementById('loadingScreen');
        if (safariBlock) safariBlock.style.display = 'flex';
        if (app) app.style.display = 'none';
        if (loading) loading.style.display = 'none';
      } else if (!isElectron && localStorage.getItem('fliplite_ackReminder') !== 'true') {
        const reminderBackdrop = document.getElementById('reminderBackdrop');
        const reminderOk = document.getElementById('reminderOk');
        const reminderSuppress = document.getElementById('reminderSuppress');

        if (reminderBackdrop) {
          reminderBackdrop.style.display = 'flex';
          reminderOk.onclick = () => {
            if (reminderSuppress && reminderSuppress.checked) {
              localStorage.setItem('fliplite_ackReminder', 'true');
            }
            reminderBackdrop.style.display = 'none';
          };
        }
      }

    })();

  