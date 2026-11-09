const CACHE_NAME = "household-budget-v9";

const APP_ROOT = new URL("./", self.location.href);

const APP_FILES = [
  "./",
  "./index.html",
  "./style.css?v=2",
 "./app.js?v=7",
 "./report.js?v=1",
  "./manifest.webmanifest",
  "./icon.svg"
].map((path) => new URL(path, APP_ROOT).href);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => {
        return Promise.all(
          keys
            .filter((key) => {
              return (
                key.startsWith("household-budget-") &&
                key !== CACHE_NAME
              );
            })
            .map((key) => caches.delete(key))
        );
      })
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) return response;

          return caches.match(
            new URL("./index.html", APP_ROOT).href
          );
        })
        .catch(() => {
          return caches.match(
            new URL("./index.html", APP_ROOT).href
          );
        })
    );

    return;
  }

  if (APP_FILES.includes(url.href)) {
    event.respondWith(
      caches.match(event.request)
        .then((cached) => cached || fetch(event.request))
    );
  }
});