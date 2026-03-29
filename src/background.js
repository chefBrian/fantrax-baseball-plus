const browser = globalThis.browser || globalThis.chrome;

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ocf-fetch-videos") {
    fetch("https://fastball-gateway.mlb.com/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "q3GnMGKfBMWuvSMY7QBGJ47bscDcFdU47yttVmal",
      },
      body: JSON.stringify({
        query: msg.gqlQuery,
        variables: msg.variables,
      }),
      signal: AbortSignal.timeout(15000),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`MLB API ${r.status}`);
        return r.json();
      })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === "ocf-fetch-video-blob") {
    fetch(msg.url, {
      headers: {
        Referer: "https://www.mlb.com/",
        Origin: "https://www.mlb.com",
      },
      signal: AbortSignal.timeout(30000),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`Video fetch ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buffer) => {
        const bytes = new Uint8Array(buffer);
        const CHUNK = 8192;
        let binary = "";
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode.apply(
            null,
            bytes.subarray(i, i + CHUNK)
          );
        }
        sendResponse({ ok: true, data: btoa(binary) });
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  return false;
});
