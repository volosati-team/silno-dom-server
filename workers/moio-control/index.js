// Proxy to silno-dom-server. Backend URL stored in CF KV (key: ag_linux_ssh_url).
// Fallback: hardcoded BACKEND const (update when KV not yet populated).
const BACKEND_FALLBACK = "https://hugh-niagara-stylish-effectively.trycloudflare.com";

export default {
  async fetch(request, env) {
    const backend = (env.TUNNEL_KV && await env.TUNNEL_KV.get("ag_linux_ssh_url")) || BACKEND_FALLBACK;
    const url = new URL(request.url);
    const target = backend + url.pathname + url.search;
    return fetch(new Request(target, {
      method: request.method,
      headers: request.headers,
      body: ["GET", "HEAD"].includes(request.method) ? null : request.body,
      redirect: "manual",
    }));
  }
};
