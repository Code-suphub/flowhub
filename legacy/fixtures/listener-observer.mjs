// Test preload only: observe the child's real sockets over its private IPC pipe.
// The server itself has no diagnostic endpoint or proxy-specific behavior.
import { Server } from "node:net";

if (typeof process.send !== "function") throw new Error("listener observer requires a test IPC channel");
const listen = Server.prototype.listen;
const observed = new WeakSet();
function notify(message) {
  if (process.connected) process.send(message, () => {});
}
Server.prototype.listen = function (...args) {
  this.once("listening", () => notify({ type: "test:listening", address: this.address() }));
  if (!observed.has(this)) {
    observed.add(this);
    this.on("request", (req) => {
      const id = req.headers["x-flowhub-test-probe"];
      if (typeof id !== "string" || !/^probe-\d+$/.test(id)) return;
      notify({ type: "test:request", id, localAddress: req.socket.localAddress, localPort: req.socket.localPort, remoteAddress: req.socket.remoteAddress });
    });
  }
  return Reflect.apply(listen, this, args);
};
