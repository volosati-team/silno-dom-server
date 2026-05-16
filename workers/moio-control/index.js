// Proxy to silno-dom-server running behind CF quick tunnel.
// Update BACKEND when the quick tunnel URL changes (or switch to named tunnel).
const BACKEND = "https://hugh-niagara-stylish-effectively.trycloudflare.com";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = BACKEND + url.pathname + url.search;
    return fetch(new Request(target, {
      method: request.method,
      headers: request.headers,
      body: ["GET", "HEAD"].includes(request.method) ? null : request.body,
      redirect: "manual",
    }));
  }
};
