"use strict";

/* eslint-disable func-style */
// Core modules
const http = require("http");
const https = require("https");
const { inherits } = require("util");
const stream = require("stream");
const zlib = require("zlib");

// Third party modules
const caseless = require("caseless");
const FormData = require("form-data");

// Ancillary modules
const RequestJar = require("./RequestJar");
const Auth = require("./auth");
const Redirect = require("./redirect");
const Tunnel = require("./tunnel");

function isTypedArray(arr) {
  return (
    arr instanceof Int8Array ||
    arr instanceof Int16Array ||
    arr instanceof Int32Array ||
    arr instanceof Uint8Array ||
    arr instanceof Uint8ClampedArray ||
    arr instanceof Uint16Array ||
    arr instanceof Uint32Array ||
    arr instanceof Float32Array ||
    arr instanceof Float64Array
  );
}

function isStream(obj) {
  return obj instanceof stream.Stream;
}

const globalCookieJar = new RequestJar();

const globalPool = {};

function filterForNonReserved(reserved, options) {
  // Filter out properties that are not reserved.
  // Reserved values are passed in at call site.

  const object = {};
  for (const i in options) {
    const notReserved = reserved.indexOf(i) === -1;
    if (notReserved) {
      object[i] = options[i];
    }
  }
  return object;
}

function filterOutReservedFunctions(reserved, options) {
  // Filter out properties that are functions and are reserved.
  // Reserved values are passed in at call site.

  const object = {};
  for (const i in options) {
    const isReserved = !(reserved.indexOf(i) === -1);
    const isFunction = typeof options[i] === "function";
    if (!(isReserved && isFunction)) {
      object[i] = options[i];
    }
  }
  return object;
}

/* Return a simpler request object to allow serialization
function requestToJSON() {
  const self = this;
  return {
    uri: self.uri,
    method: self.method,
    headers: self.headers
  };
} */

function Request(options) {
  // if given the method property in options
  // Assign any non-reserved properties to the Request object
  // remove any reserved functions from the options object
  // set Request instance to be readable and writable
  // call init

  const self = this;

  stream.Stream.call(self);
  const reserved = Object.keys(Request.prototype);
  const nonReserved = filterForNonReserved(reserved, options);

  Object.assign(self, nonReserved);

  self.readable = true;
  self.writable = true;
  self._auth = new Auth(self);
  self._redirect = new Redirect(self);
  self._tunnel = new Tunnel(self);
  self.init(filterOutReservedFunctions(reserved, options));
}

inherits(Request, stream.Stream);

Request.prototype.init = function (options) {
  // init() contains all the code to setup the request object.
  // the actual outgoing request is not started until start() is called
  // this function is called from both the constructor and on redirect.
  const self = this;
  if (!options) {
    options = {};
  }
  self.headers = Object.assign(Object.create(null), self.headers);

  // Delete headers with value undefined since they break
  // ClientRequest.OutgoingMessage.setHeader in node 0.12
  for (const headerName in self.headers) {
    if (typeof self.headers[headerName] === "undefined") {
      delete self.headers[headerName];
    }
  }

  caseless.httpify(self, self.headers);

  self.localAddress = options.localAddress;

  if (!self.pool && self.pool !== false) {
    self.pool = globalPool;
  }
  self.dests = self.dests || [];
  self.__isRequestRequest = true;
  // self.on("complete", self.callback.bind(self, null));

  // If a string URI/URL was given, parse it into a URL object
  if (typeof self.uri === "string") {
    self.uri = new URL(self.uri);
  }

  if (self.strictSSL === false) {
    self.rejectUnauthorized = false;
  }

  if (!(self.uri.host || (self.uri.hostname && self.uri.port)) && !self.uri.isUnix) {
    // Invalid URI: it may generate lot of bad errors, like
    // 'TypeError: Cannot call method `indexOf` of undefined' in CookieJar
    // Detect and reject it as soon as possible
    const faultyUri = self.uri.href;
    const message = 'Invalid URI "' + faultyUri + '"';
    // This error was fatal
    self.abort();
    self.emit("error", new Error(message));
  } else {
    self.tunnel = self._tunnel.isEnabled();
    if (self.proxy) {
      self._tunnel.setup();
    }

    self._redirect.onRequest(options);

    self.setHost = false;
    if (!self.hasHeader("host")) {
      const hostHeaderName = self.originalHostHeaderName || "host";
      self.setHeader(hostHeaderName, self.uri.host);
      self.setHost = true;
    }

    self.jar(self._jar || options.jar);

    if (self.proxy && !self.tunnel) {
      self.port = self.proxy.port;
      self.host = self.proxy.hostname;
    } else {
      self.port = self.uri.port;
      self.host = self.uri.hostname;
    }

    self.path = self.uri.pathname + (self.uri.search || "");

    // Auth must happen last in case signing is dependent on other headers
    if (options.auth) {
      self.auth(
        options.auth.user,
        options.auth.pass,
        options.auth.sendImmediately,
        options.auth.bearer
      );
    }

    if (self.gzip && !self.hasHeader("accept-encoding")) {
      self.setHeader("accept-encoding", "gzip, deflate");
    }

    if (self.proxy && !self.tunnel) {
      self.path = self.uri.protocol + "//" + self.uri.host + self.path;
    }

    function setContentLength() {
      if (isTypedArray(self.body)) {
        self.body = Buffer.from(self.body);
      }

      if (!self.hasHeader("content-length")) {
        let length;
        if (typeof self.body === "string") {
          length = Buffer.byteLength(self.body);
        } else {
          length = self.body.length;
        }

        if (length) {
          self.setHeader("content-length", length);
        } else {
          self.emit("error", new Error("Argument error, options.body."));
        }
      }
    }
    if (self.body && !isStream(self.body)) {
      setContentLength();
    }

    const protocol = self.proxy && !self.tunnel ? self.proxy.protocol : self.uri.protocol;
    const defaultModules = { "http:": http, "https:": https };
    const httpModules = self.httpModules || {};

    self.httpModule = httpModules[protocol] || defaultModules[protocol];

    if (!self.agent) {
      self.agentClass = self.httpModule.Agent;
      if (options.forever) {
        self.agentOptions = self.agentOptions || {};
        self.agentOptions.keepAlive = true;
      }
    }
    self.agent = self.agent || self.getNewAgent();
    self.on("pipe", src => {
      self.src = src;
    });
    setImmediate(() => {
      if (self._aborted) {
        return;
      }
      const end = function () {
        if (self._form) {
          if (!self._auth.hasAuth || (self._auth.hasAuth && self._auth.sentAuth)) {
            self._form.pipe(self);
          }
        }
        if (self.body) {
          setContentLength();
          self.write(self.body);
          self.end();
        } else if (!self.src) {
          if (self._auth.hasAuth && !self._auth.sentAuth) {
            self.end();
            return;
          }
          if (self.method !== "GET" && typeof self.method !== "undefined") {
            self.setHeader("content-length", 0);
          }
          self.end();
        }
      };
      if (self._form && !self.hasHeader("content-length")) {
        // Before ending the request, we had to compute the length of the whole form, asyncly
        self.setHeader(self._form.getHeaders(), true);
        self._form.getLength((err, length) => {
          if (!err && !isNaN(length)) {
            self.setHeader("content-length", length);
          }
          end();
        });
      } else {
        end();
      }
      self.ntick = true;
    });
  }
};

Request.prototype.getNewAgent = function () {
  const self = this;
  const Agent = self.agentClass;
  const options = {};
  if (self.agentOptions) {
    for (const i in self.agentOptions) {
      options[i] = self.agentOptions[i];
    }
  }
  if (typeof self.rejectUnauthorized !== "undefined") {
    options.rejectUnauthorized = self.rejectUnauthorized;
  }

  let poolKey = "";

  const { proxy } = self;
  const isHttps = (proxy && proxy.protocol === "https:") || this.uri.protocol === "https:";

  if (isHttps) {
    if (typeof options.rejectUnauthorized !== "undefined") {
      poolKey += options.rejectUnauthorized;
    }
  }

  // we're using a stored agent.  Make sure it's protocol-specific
  poolKey = self.uri.protocol + poolKey;

  // generate a new agent for this setting if none yet exists
  if (!self.pool[poolKey]) {
    self.pool[poolKey] = new Agent(options);
  }

  return self.pool[poolKey];
};

Request.prototype.start = function () {
  // start() is called once we are ready to send the outgoing HTTP request.
  // this is usually called on the first write(), end() or on nextTick()
  const self = this;

  if (self._aborted) {
    return;
  }

  self._started = true;
  self.href = self.uri.href;

  if (self.src && self.src.stat && self.src.stat.size && !self.hasHeader("content-length")) {
    self.setHeader("content-length", self.src.stat.size);
  }
  const { agent, headers, rejectUnauthorized, method, host, path, port } = self;
  try {
    self.req = self.httpModule.request({ agent, headers, rejectUnauthorized, method, host, path, port });
  } catch (err) {
    self.emit("error", err);
    return;
  }

  self.req.on("response", self.onRequestResponse.bind(self));
  self.req.on("error", self.onRequestError.bind(self));

  self.req.on("socket", socket => {
    self.emit("socket", socket);
  });

  self.emit("request", self.req);
};

Request.prototype.onRequestError = function (error) {
  const self = this;
  if (self._aborted) {
    return;
  }
  if (self.req && self.req._reusedSocket && error.code === "ECONNRESET" &&
    self.agent.addRequestNoreuse) {
    self.agent = { addRequest: self.agent.addRequestNoreuse.bind(self.agent) };
    self.start();
    self.req.end();
    return;
  }
  self.emit("error", error);
};

Request.prototype.onRequestResponse = function (response) {
  const self = this;

  if (self._aborted) {
    response.resume();
    return;
  }

  self.response = response;
  response.request = self;

  // Save the original host before any redirect (if it changes, we need to
  // remove any authorization headers).  Also remember the case of the header
  // name because lots of broken servers expect Host instead of host and we
  // want the caller to be able to specify this.
  self.originalHost = self.getHeader("host");
  if (!self.originalHostHeaderName) {
    self.originalHostHeaderName = self.hasHeader("host");
  }
  if (self.setHost) {
    self.removeHeader("host");
  }
  /** @todo set cookie before redirect */
  const targetCookieJar = self._jar && self._jar.setCookie ? self._jar : globalCookieJar;
  const addCookie = function (cookie) {
    // set the cookie if it's domain in the href's domain.
    try {
      targetCookieJar.setCookie(cookie, self.uri.href, { ignoreError: true });
    } catch (e) {
      self.emit("error", e);
    }
  };

  response.caseless = caseless(response.headers);

  if (response.caseless.has("set-cookie") && !self._disableCookies) {
    const headerName = response.caseless.has("set-cookie");
    if (Array.isArray(response.headers[headerName])) {
      response.headers[headerName].forEach(addCookie);
    } else {
      addCookie(response.headers[headerName]);
    }
  }

  if (self._redirect.onResponse(response)) {
    return; // Ignore the rest of the response
  }
  // Be a good stream and emit end when the response is finished.
  // Hack to emit end on close because of a core bug that never fires end
  response.on("close", () => {
    if (!self._ended) {
      self.response.emit("end");
    }
  });

  response.once("end", () => {
    self._ended = true;
  });

  const noBody = function (code) {
    return (
      self.method === "HEAD" ||
        // Informational
        (code >= 100 && code < 200) ||
        // No Content
        code === 204 ||
        // Not Modified
        code === 304
    );
  };

  let responseContent;
  if (self.gzip && !noBody(response.statusCode)) {
    let contentEncoding = response.headers["content-encoding"] || "identity";
    contentEncoding = contentEncoding.trim().toLowerCase();

    // Be more lenient with decoding compressed responses, since (very rarely)
    // servers send slightly invalid gzip responses that are still accepted
    // by common browsers.
    // Always using Z_SYNC_FLUSH is what cURL does.
    const zlibOptions = {
      flush: zlib.constants.Z_SYNC_FLUSH,
      finishFlush: zlib.constants.Z_SYNC_FLUSH
    };

    if (contentEncoding === "gzip") {
      responseContent = zlib.createGunzip(zlibOptions);
      response.pipe(responseContent);
    } else if (contentEncoding === "deflate") {
      responseContent = zlib.createInflate(zlibOptions);
      response.pipe(responseContent);
    } else {
      responseContent = response;
    }
  } else {
    responseContent = response;
  }

  self.responseContent = responseContent;

  self.emit("response", response);

  responseContent.on("data", chunk => {
    self._destdata = true;
    self.emit("data", chunk);
  });
  responseContent.once("end", chunk => {
    self.emit("end", chunk);
  });
  responseContent.on("error", error => {
    self.emit("error", error);
  });
  responseContent.on("close", () => {
    self.emit("close");
  });

  self.on("end", () => {
    if (!self._aborted) {
      self.emit("complete", response);
    }
  });
};

Request.prototype.abort = function () {
  const self = this;
  self._aborted = true;

  if (self.req) {
    const version = process.version.replace("v", "").split(".");
    const major = Number.parseInt(version[0]);
    const minor = Number.parseInt(version[1]);
    if (major < 14 && minor < 14) {
      self.req.abort();
    } else {
      self.req.destroy();
    }
  } else if (self.response) {
    self.response.destroy();
  }
  self.emit("abort");
};

Request.prototype.form = function () {
  const self = this;
  // create form-data object
  self._form = new FormData();
  self._form.on("error", err => {
    err.message = "form-data: " + err.message;
    self.emit("error", err);
    self.abort();
  });
  return self._form;
};

Request.prototype.auth = function (user, pass, sendImmediately, bearer) {
  const self = this;
  self._auth.onRequest(user, pass, sendImmediately, bearer);
  return self;
};

Request.prototype.jar = function (jar) {
  const self = this;
  let cookies;

  if (self._redirect.redirectsFollowed === 0) {
    self.originalCookieHeader = self.getHeader("cookie");
  }

  if (!jar) {
    // disable cookies
    cookies = false;
    self._disableCookies = true;
  } else {
    const targetCookieJar = jar.getCookieString ? jar : globalCookieJar;
    const urihref = self.uri.href;
    // fetch cookie in the Specified host
    if (targetCookieJar) {
      cookies = targetCookieJar.getCookieString(urihref);
    }
  }

  // if need cookie and cookie is not empty
  if (cookies && cookies.length) {
    self.setHeader("cookie", cookies);
  }
  self._jar = jar;
  return self;
};

Request.prototype.write = function (...argList) {
  const self = this;
  if (self._aborted) {
    return;
  }

  if (!self._started) {
    self.start();
  }
  if (self.req) {
    self.req.write(...argList);
  }
};

Request.prototype.end = function () {
  const self = this;
  if (!self._aborted) {
    if (!self._started) {
      self.start();
    }
    if (self.req) {
      self.req.end();
    }
  }
};
/*
Request.defaultProxyHeaderWhiteList =
  Tunnel.defaultProxyHeaderWhiteList.slice();

Request.defaultProxyHeaderExclusiveList =
  Tunnel.defaultProxyHeaderExclusiveList.slice();

Request.prototype.toJSON = requestToJSON;
*/
module.exports = Request;