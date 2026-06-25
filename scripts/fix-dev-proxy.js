import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const backendHost = process.env.BACKEND_HOST ?? "127.0.0.1";
const backendPort = Number(process.env.BACKEND_PORT ?? 3001);
const timeoutMs = 2000;

function checkBackend() {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(backendPort, backendHost);
  });
}

function startBackend() {
  const command = `npx tsx ${path.join("backend", "index.ts")}`;
  const child = spawn(command, {
    shell: true,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV ?? "development",
      BACKEND_HOST: backendHost,
      BACKEND_PORT: String(backendPort),
    },
  });
  child.unref();
  return child;
}

async function main() {
  const reachable = await checkBackend();
  if (reachable) {
    console.log(`Backend already running at http://${backendHost}:${backendPort}`);
    process.exit(0);
  }

  console.log(`Backend not reachable at http://${backendHost}:${backendPort}. Starting backend in the background...`);
  startBackend();
  console.log(`Started backend process. Give it a few seconds, then retry your Vite request.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Failed to fix dev proxy:", err);
  process.exit(1);
});
