browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "ocf-fetch-videos") return false;

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "https://fastball-gateway.mlb.com/graphql");
  xhr.setRequestHeader("Content-Type", "application/json");
  xhr.setRequestHeader("x-api-key", "q3GnMGKfBMWuvSMY7QBGJ47bscDcFdU47yttVmal");
  xhr.timeout = 15000;

  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        sendResponse({ ok: true, data: JSON.parse(xhr.responseText) });
      } catch (e) {
        sendResponse({ ok: false, error: "Invalid JSON response" });
      }
    } else {
      sendResponse({ ok: false, error: `MLB API ${xhr.status}` });
    }
  };

  xhr.onerror = () => {
    sendResponse({ ok: false, error: "Network error" });
  };

  xhr.ontimeout = () => {
    sendResponse({ ok: false, error: "Request timed out" });
  };

  xhr.send(JSON.stringify({
    query: msg.gqlQuery,
    variables: msg.variables,
  }));

  return true;
});
