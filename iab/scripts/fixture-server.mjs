#!/usr/bin/env node
import http from "node:http";

const host = "127.0.0.1";
const port = Number(process.env.IAB_FIXTURE_PORT ?? 43127);

const page = String.raw`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>IAB Thread Isolation Fixture</title></head>
<body>
  <h1>IAB Thread Isolation Fixture</h1>
  <label>Thread marker <input id="marker" autocomplete="off"></label>
  <button id="save">Save to every browser store</button>
  <button id="refresh">Refresh report</button>
  <pre id="report">Loading…</pre>
  <script>
    const dbName = "iab-thread-isolation";
    const storeName = "markers";
    function openDb() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(storeName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    async function idbGet() {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const request = db.transaction(storeName).objectStore(storeName).get("value");
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error);
      });
    }
    async function idbSet(value) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(value, "value");
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    }
    async function cacheGet() {
      const match = await (await caches.open("iab-thread-isolation")).match("/marker");
      return match ? match.text() : null;
    }
    async function report() {
      const cookie = document.cookie.split("; ").find((part) => part.startsWith("iab_marker="))?.slice(11) ?? null;
      const response = await fetch("/cookie", { cache: "no-store" }).then((value) => value.json());
      document.querySelector("#report").textContent = JSON.stringify({
        cookie,
        cookieSeenByServer: response.marker,
        localStorage: localStorage.getItem("iab_marker"),
        sessionStorage: sessionStorage.getItem("iab_marker"),
        indexedDB: await idbGet(),
        cacheStorage: await cacheGet(),
        serviceWorker: Boolean(navigator.serviceWorker.controller || (await navigator.serviceWorker.getRegistration())),
      }, null, 2);
    }
    document.querySelector("#save").onclick = async () => {
      const value = document.querySelector("#marker").value;
      document.cookie = "iab_marker=" + encodeURIComponent(value) + "; Path=/; SameSite=Lax";
      localStorage.setItem("iab_marker", value);
      sessionStorage.setItem("iab_marker", value);
      await idbSet(value);
      await (await caches.open("iab-thread-isolation")).put("/marker", new Response(value));
      await navigator.serviceWorker.register("/sw.js");
      await report();
    };
    document.querySelector("#refresh").onclick = report;
    report();
  </script>
</body>
</html>`;

const server = http.createServer((request, response) => {
  if (request.url === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(page);
    return;
  }
  if (request.url === "/cookie") {
    const cookie = request.headers.cookie ?? "";
    const marker = cookie.split("; ").find((part) => part.startsWith("iab_marker="))?.slice(11) ?? null;
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ marker }));
    return;
  }
  if (request.url === "/sw.js") {
    response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store", "service-worker-allowed": "/" });
    response.end("self.addEventListener('fetch', () => {});");
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("not found");
});

server.listen(port, host, () => {
  console.log(`IAB fixture listening at http://${host}:${port}`);
});
