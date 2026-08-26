const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const dns = require("node:dns");
const dgram = require("node:dgram");
const http2 = require("node:http2");
const childProcess = require("node:child_process");

function blocked(name) {
  return function noNetworkAllowed() {
    throw new Error(`Offline transcript tests blocked ${name}.`);
  };
}

globalThis.fetch = blocked("fetch");
http.request = blocked("http.request");
http.get = blocked("http.get");
https.request = blocked("https.request");
https.get = blocked("https.get");
net.connect = blocked("net.connect");
net.createConnection = blocked("net.createConnection");
tls.connect = blocked("tls.connect");
dns.lookup = blocked("dns.lookup");
dns.resolve = blocked("dns.resolve");
dns.resolve4 = blocked("dns.resolve4");
dns.resolve6 = blocked("dns.resolve6");
dns.promises.lookup = blocked("dns.promises.lookup");
dns.promises.resolve = blocked("dns.promises.resolve");
dgram.createSocket = blocked("dgram.createSocket");
http2.connect = blocked("http2.connect");
childProcess.exec = blocked("child_process.exec");
childProcess.execFile = blocked("child_process.execFile");
childProcess.spawn = blocked("child_process.spawn");
childProcess.fork = blocked("child_process.fork");
childProcess.execSync = blocked("child_process.execSync");
childProcess.execFileSync = blocked("child_process.execFileSync");
childProcess.spawnSync = blocked("child_process.spawnSync");
if (typeof globalThis.WebSocket === "function") {
  globalThis.WebSocket = blocked("WebSocket");
}
