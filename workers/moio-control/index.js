// Proxy to silno-dom-server. Backend URL stored in CF KV (key: ag_linux_ssh_url).
// No hardcoded fallback — stale URLs can route to unrelated tunnels.

export default {
  async fetch(request, env) {
    const backend = env.TUNNEL_KV && await env.TUNNEL_KV.get("ag_linux_ssh_url");
    if (!backend) {
      return new Response("Service unavailable: tunnel URL not set in KV", { status: 503 });
    }
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
