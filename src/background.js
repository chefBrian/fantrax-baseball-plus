const browser = globalThis.browser || globalThis.chrome;

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "ocf-fetch-videos") return false;

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
});
